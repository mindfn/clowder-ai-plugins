import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryStorage } from '../test/memory-storage.js';
import { createCommunityHttpRouter, type CommunityHttpRouterOptions } from './community-http-router.js';
import { createCatId } from './business/model/index.js';

function options(): CommunityHttpRouterOptions {
  return {
    storage: memoryStorage(),
    issues: {
      guardianCatalog: async () => ({ roster: {}, defaultCatId: createCatId('guardian'), policy: { requireDifferentFamily: true, preferActiveInThread: true, preferLead: true, excludeUnavailable: true } }),
      taskStore: { listByKind: async () => [], getBySubject: async () => null, upsertBySubject: async () => { throw new Error('unexpected tracking'); }, delete: async () => false },
    },
    drafts: {
      frustrationIssueStore: { getById: async () => null, setCommunityIssueDraftId: async () => { throw new Error('unexpected source update'); } },
      publisher: { publish: async () => { throw new Error('unexpected GitHub publish'); } },
      config: { defaultRepo: 'org/repo', repoAllowlist: ['org/repo'] },
    },
  };
}
const principal = { kind: 'owner', id: 'owner' } as const;

test('embedded whole Community routes persist owner changes and accept separately authenticated native triage', async t => {
  const deps = options(); let router = await createCommunityHttpRouter(deps);
  t.after(() => router.stop());
  const created = await router.forwardOwner({ principal, method: 'POST', path: 'github/community-issues', body: { repo: 'org/repo', issueNumber: 1, title: 'Proposal', issueType: 'feature' } });
  assert.equal(created.status, 201);
  const id = created.body.id;
  const path = `github/community-issues/${id}`;
  assert.equal((await router.forwardOwner({ principal, method: 'PATCH', path, body: { state: 'discussing' } })).status, 200);
  const payload = { catId: 'reviewer', verdict: 'WELCOME', questions: ['Q1','Q2','Q3','Q4','Q5'].map(id => ({ id, result: 'PASS' })) };
  assert.equal((await router.forwardOwner({ principal, method: 'POST', path: path + '/triage-complete', body: payload })).status, 401);
  const caller = { catId: 'reviewer', userId: 'owner', threadId: 'thread', invocationId: 'inv', assertCurrent: async () => {} };
  const result = await router.invokeNative('github.community.triage-complete', { id, payload }, caller);
  assert.equal(result.status, 200);
  assert.equal(result.body.action, 'await-second-cat');
  await assert.rejects(router.invokeNative('github.community.resolve' as never, { id, payload: { decision: 'accepted' } }, caller), /Undeclared/);
  await assert.rejects(router.invokeNative('github.community.triage-complete', { id, payload, principal }, caller), /Unrecognized/);
  await router.stop();
  router = await createCommunityHttpRouter(deps);
  const restored = await router.forwardOwner({ principal, method: 'GET', path });
  assert.equal(restored.body.directionCard.entries[0].catId, 'reviewer');
  const queue = await router.forwardOwner({ principal, method: 'GET', path: 'github/community-decision-queue', query: { repo: 'org/repo' } });
  assert.equal(queue.status, 200);
});

test('owner forwarding requires Host wrapper identity and preserves encoded repository segments', async t => {
  const router = await createCommunityHttpRouter(options()); t.after(() => router.stop());
  await assert.rejects(router.forwardOwner({ method: 'GET', path: 'github/community-issues', headers: { 'x-cat-cafe-user': 'owner' } }), /principal/);
  await assert.rejects(router.forwardOwner({ principal, method: 'GET', path: 'github/community-issues/../secrets' }), /Invalid/);
  assert.equal((await router.forwardOwner({ principal, method: 'POST', path: 'github/community-repo-configs', body: { repo: 'org/repo', guardCatId: 'guardian', guardThreadId: 'thread' } })).status, 200);
  assert.equal((await router.forwardOwner({ principal, method: 'DELETE', path: 'github/community-repo-configs/org%2Frepo' })).status, 200);
  const configs = await router.forwardOwner({ principal, method: 'GET', path: 'github/community-repo-configs' });
  assert.deepEqual(configs.body, []);
});
