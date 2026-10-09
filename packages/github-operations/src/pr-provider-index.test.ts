import assert from 'node:assert/strict';
import test from 'node:test';
import type { PluginStorageHost, PluginStorageEntry } from '@clowder-ai/plugin-sdk';
import { PrProviderIndex, type PrIndexProvider } from './pr-provider-index.js';

function fixture() {
  const rows = new Map<string, PluginStorageEntry>(); let revision = 0;
  const storage: PluginStorageHost = {
    get: async key => structuredClone(rows.get(key)),
    list: async () => structuredClone(Object.fromEntries(rows)),
    set: async (key, value) => { rows.set(key, { value: structuredClone(value), revision: ++revision }); return { revision }; },
    compareAndSet: async (key, expected, value) => {
      if ((rows.get(key)?.revision ?? null) !== expected) return { applied: false };
      rows.set(key, { value: structuredClone(value), revision: ++revision }); return { applied: true, revision };
    },
    delete: async (key, expected) => ({ deleted: (expected === undefined || rows.get(key)?.revision === expected) && rows.delete(key) }),
  };
  return { storage, rows, root: () => [...rows].find(([key]) => key.endsWith('.root'))! };
}
const repo = 'owner/repo';
const pr = (number = 1, overrides = {}) => ({ number, title: `PR ${number}`, user: 'author', state: 'open', merged_at: null, head_sha: 'a'.repeat(40), draft: true, ...overrides });
const review = (commit = 'a') => ({ user: 'reviewer', state: 'COMMENTED', commit_id: commit.repeat(40) });

test('late page failure keeps published bytes/revisions; restart resumes staging and publishes atomically', async () => {
  const f = fixture(); let batch = 0, fail = true; const pages: number[] = [];
  const provider: PrIndexProvider = {
    page: async (_repo, page) => { pages.push(page); if (!batch) return [pr(100)]; if (page === 1) return Array.from({length:25}, (_, i) => pr(i+1)); if (fail) throw Error('last page'); return [pr(26)]; },
    reviews: async () => [review()],
  };
  let index = new PrProviderIndex(f.storage, provider);
  await index.refresh({ repo }); const old = await index.read(repo); const oldParts = structuredClone([...f.rows].filter(([key]) => key.includes(old.publishedGeneration!)));
  batch = 1; assert.equal((await index.refresh({ repo })).status, 'incomplete');
  assert.deepEqual((await index.read(repo)).items, old.items);
  const beforeFailure = structuredClone(f.root());
  assert.equal((await index.refresh({ repo })).status, 'failed');
  assert.deepEqual(f.root(), beforeFailure); assert.equal((await index.read(repo)).refreshStatus, 'failed');
  assert.deepEqual([...f.rows].filter(([key]) => key.includes(old.publishedGeneration!)), oldParts);
  await index.stop(); index = new PrProviderIndex(f.storage, provider); fail = false;
  assert.equal((await index.refresh({ repo })).status, 'complete');
  const page = await index.read(repo, undefined, 20);
  assert.equal(page.items.length, 20); assert.notEqual(page.publishedGeneration, old.publishedGeneration);
  assert.equal((await index.read(repo, page.nextAfter, 20)).items.length, 6);
  assert.deepEqual(pages, [1,1,2,2]); assert.equal((await index.repositories())[0]!.count, 26);
  await index.refresh({ repo, restart: true });
  assert.equal((await index.read(repo, page.nextAfter)).items.length, 6);
  await index.refresh({ repo });
  await assert.rejects(index.read(repo, page.nextAfter), /stale/);
  await index.stop();
});

test('same display state updates reviewed SHA and draft; terminal states clear reviewed SHA', async () => {
  const f = fixture(); let value = pr(), reviews = [review('b')];
  const index = new PrProviderIndex(f.storage, { page: async () => [value], reviews: async () => reviews });
  await index.refresh({repo}); assert.equal((await index.read(repo)).items[0]!.replyState, 'has-new-activity');
  value = pr(1, {draft:false}); reviews = [review('c')]; await index.refresh({repo});
  let row = (await index.read(repo)).items[0]!; assert.equal(row.replyState,'has-new-activity'); assert.equal(row.lastReviewedSha,'c'.repeat(40)); assert.equal(row.draft,false);
  value = pr(1, {state:'closed'}); await index.refresh({repo}); row = (await index.read(repo)).items[0]!;
  assert.equal(row.state,'closed'); assert.equal(row.lastReviewedSha,null); assert.equal(row.draft,true);
  value = pr(1, {state:'closed',merged_at:'2026-10-09T00:00:00Z'}); await index.refresh({repo});
  assert.equal((await index.read(repo)).items[0]!.state,'merged'); assert.equal((await index.read(repo)).items[0]!.lastReviewedSha,null);
  await index.stop();
});

test('failed review preserves published revision and reports its subject', async () => {
  const f=fixture(); let fail=false;
  const index=new PrProviderIndex(f.storage,{page:async()=>[pr()],reviews:async()=>{if(fail)throw Error('unavailable');return [review()];}});
  await index.refresh({repo}); const before=structuredClone(f.root()); fail=true;
  const result=await index.refresh({repo}); assert.deepEqual(result.failedSubjects,[1]); assert.equal(result.status,'failed');
  assert.deepEqual(f.root(),before); assert.equal((await index.read(repo)).items[0]!.replyState,'replied'); await index.stop();
});

test('malformed, duplicate and authority-bearing inputs cannot publish', async () => {
  const f=fixture(); let calls=0, values: unknown[]=[pr()];
  const index=new PrProviderIndex(f.storage,{page:async()=>{calls++;return values;},reviews:async()=>[]});
  await assert.rejects(index.refresh({repo,verdict:'approved'})); assert.equal(calls,0);
  await index.refresh({repo}); const before=structuredClone(f.root());
  for(const bad of [[pr(1,{head_sha:'bad'})],[pr(),pr()],[pr(1,{draft:'yes'})]]){
    values=bad; assert.equal((await index.refresh({repo})).status,'failed'); assert.deepEqual(f.root(),before);
  }
  values=Array.from({length:25},(_,i)=>pr(i+1)); await index.refresh({repo}); const staged=structuredClone(f.root());
  values=[pr(25)]; assert.equal((await index.refresh({repo})).status,'failed'); assert.deepEqual(f.root(),staged); await index.stop();
});

test('two instances race publication: one complete generation wins', async () => {
  const f=fixture(); let release!:()=>void, entered!:()=>void; const ready=new Promise<void>(r=>entered=r), wait=new Promise<void>(r=>release=r);
  const a=new PrProviderIndex(f.storage,{page:async()=>{entered();await wait;return[pr(1)];},reviews:async()=>[]});
  const b=new PrProviderIndex(f.storage,{page:async()=>[pr(2)],reviews:async()=>[]});
  const first=a.refresh({repo}); await ready; assert.equal((await b.refresh({repo})).status,'complete'); release();
  assert.equal((await first).status,'failed'); assert.deepEqual((await b.read(repo)).items.map(x=>x.number),[2]);
  assert.equal((await b.read(repo)).refreshStatus,'complete'); await Promise.all([a.stop(),b.stop()]);
});

test('stop aborts provider and joins cleanup; late completion cannot publish', async () => {
  const f=fixture(); let release!:()=>void, entered!:()=>void, signal!:AbortSignal;
  const ready=new Promise<void>(r=>entered=r), wait=new Promise<void>(r=>release=r);
  const index=new PrProviderIndex(f.storage,{page:async(_r,_p,s)=>{signal=s;entered();await wait;return[pr()];},reviews:async()=>[]});
  const running=assert.rejects(index.refresh({repo})); await ready; let stopped=false; const stop=index.stop().then(()=>stopped=true);
  await new Promise(r=>setImmediate(r)); assert.equal(signal.aborted,true); assert.equal(stopped,false); release(); await Promise.all([running,stop]);
  assert.equal(f.rows.size,0); await assert.rejects(index.refresh({repo}),/stopped/);
});

test('deadline failure preserves the visible generation', async () => {
  const f=fixture(); let slow=false;
  const index=new PrProviderIndex(f.storage,{page:async()=>{if(slow)await new Promise(r=>setTimeout(r,25));return[pr()];},reviews:async()=>[]},10);
  await index.refresh({repo}); const before=structuredClone(f.root()); slow=true;
  assert.equal((await index.refresh({repo})).status,'failed'); assert.deepEqual(f.root(),before); await index.stop();
});

test('subject cap remains incomplete until an explicit empty final page; overflow never publishes', async () => {
  const f = fixture(); let overflow = true;
  const index = new PrProviderIndex(f.storage, {
    page: async (_repo, page) => page <= 200 ? Array.from({length:25}, (_, i) => pr((page - 1) * 25 + i + 1, {state:'closed'})) : overflow ? [pr(5001)] : [],
    reviews: async () => { throw Error('terminal PR must not fetch reviews'); },
  });
  for (let page = 1; page <= 200; page++) assert.equal((await index.refresh({repo})).status,'incomplete');
  assert.equal((await index.read(repo)).publishedGeneration,null);
  const before = structuredClone(f.root());
  const result = await index.refresh({repo}); assert.equal(result.status,'limit_exceeded'); assert.equal(result.complete,false);
  assert.deepEqual(f.root(),before); assert.equal((await index.read(repo)).refreshStatus,'limit_exceeded');
  overflow=false; assert.equal((await index.refresh({repo})).status,'complete');
  assert.equal((await index.repositories())[0]!.count,5000); await index.stop();
});
