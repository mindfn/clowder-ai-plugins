import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryStorage } from '../test/memory-storage.js';
import { createCommunityHttpRouter, type CommunityHttpRouterOptions } from './community-http-router.js';
import { createCatId } from './business/model/index.js';
import { SdkCommunityWorkflowIssueStore, SdkCommunityIssueDraftStore } from './business/domains/community/CommunityWorkflowStores.js';
import { NativeIssueDraftRuntime } from './native-issue-drafts.js';
import { SdkCommunityEventLog } from './business/domains/community/CommunityEventLog.js';
import { SdkCommunityObjectStore } from './business/domains/community/CommunityObjectStore.js';

function options(): CommunityHttpRouterOptions {
  return {
    storage: memoryStorage(),
    issues: {
      guardianCatalog: async () => ({ roster: {}, defaultCatId: createCatId('guardian'), policy: { requireDifferentFamily: true, preferActiveInThread: true, preferLead: true, excludeUnavailable: true } }),
      taskStore: { listByKind: async () => [], getBySubject: async () => null, upsertBySubject: async () => { throw new Error('unexpected tracking'); }, delete: async () => false },
    },
    drafts: {
      frustrationIssueStore: { getById: async () => null, setCommunityIssueDraftId: async () => { throw new Error('unexpected source update'); } },
      publisher: { create: async () => { throw new Error('unexpected GitHub publish'); }, find: async () => null },
      config: { defaultRepo: 'org/repo', repoAllowlist: ['org/repo'] },
    },
  };
}
const principal = { kind: 'owner', id: 'owner' } as const;

for (const journal of [false, true]) test(`publication recovers after ${journal ? 'journal' : 'workflow'} result write loss`, async t => {
  const deps = options(); let creates = 0, finds = 0;
  const issue = { number: 7, url: 'https://github.com/org/repo/issues/7' };
  deps.drafts.publisher = { create: async draft => { creates++; assert.deepEqual(draft.labels, ['bug']); return issue; }, find: async () => { finds++; return issue; } };
  const store = new SdkCommunityIssueDraftStore(deps.storage);
  const draft = await store.create({ sourceType: 'cat_initiated', sourceId: 'source', title: 'I'.repeat(500), bodyMarkdown: 'Public body', targetRepo: 'org/repo', labels: ['bug'], threadId: 'thread', userId: 'owner' });
  const cas = deps.storage.compareAndSet; let fail = true;
  deps.storage.compareAndSet = async (key, rev, value) => {
    if (fail && key.startsWith(journal ? 'community.workflow.publication.' : 'community.workflow.draft-source.') && JSON.stringify(value).includes('"status":"published"')) throw new Error('local write lost');
    return cas(key, rev, value);
  };
  let router = await createCommunityHttpRouter(deps); t.after(() => router.stop());
  const request = { principal, method: 'POST', path: `github/community-issue-drafts/${draft.draftId}/publish`, body: {} };
  const first = await router.forwardOwner(request);
  assert.equal(first.status, 502); assert.equal(creates, 1);
  assert.equal((await store.getById(draft.draftId))?.status, 'publishing');
  const native = new NativeIssueDraftRuntime({ storage: deps.storage, config: { get: async () => 'org/repo' } }, deps.drafts.publisher);
  assert.deepEqual((await native.list()).data.rows, [], 'Community publication is not a separately cancellable native UI draft');
  await native.stop();
  assert.equal((await router.forwardOwner({ ...request, path: `github/community-issue-drafts/${draft.draftId}/cancel` })).status, 409);
  assert.equal((await router.forwardOwner({ ...request, body: { title: 'Changed' } })).status, 502);
  assert.equal(creates, 1);
  await router.stop(); fail = false;
  router = await createCommunityHttpRouter(deps);
  const retried = await router.forwardOwner(request);
  assert.equal(creates, 1, 'retry must reconcile durable publishing receipt instead of POST again');
  assert.equal(finds, journal ? 1 : 0);
  assert.equal(retried.body.draft.status, 'published');
  assert.equal((await new SdkCommunityIssueDraftStore(deps.storage).getById(draft.draftId))?.githubIssueNumber, 7);
});

test('concurrent routers freeze one publication and reconcile uncertain results without another POST', async t => {
  const deps = options(); let creates = 0; let found = false;
  let entered!: () => void, release!: () => void;
  const creating = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  deps.drafts.publisher = { create: async () => { creates++; entered(); await blocked; throw new Error('response unknown'); }, find: async () => found ? { number: 7, url: 'https://github.com/org/repo/issues/7' } : null };
  const store = new SdkCommunityIssueDraftStore(deps.storage);
  const draft = await store.create({ sourceType: 'cat_initiated', sourceId: 'source', title: 'Issue', bodyMarkdown: 'Public', targetRepo: 'org/repo', labels: [], threadId: 'thread', userId: 'owner' });
  const a = await createCommunityHttpRouter(deps), b = await createCommunityHttpRouter(deps);
  t.after(async () => { release(); await a.stop(); await b.stop(); });
  const request = { principal, method: 'POST', path: `github/community-issue-drafts/${draft.draftId}/publish`, body: {} };
  const pending = a.forwardOwner(request); await creating;
  assert.equal((await b.forwardOwner(request)).status, 202);
  await assert.rejects(store.cancel(draft.draftId), /not draft/);
  await assert.rejects(store.updateContent(draft.draftId, 'other', 'other'), /not draft/);
  release(); assert.equal((await pending).status, 202);
  found = true;
  assert.equal((await b.forwardOwner(request)).body.draft.status, 'published');
  assert.equal(creates, 1);
});

test('stop during a successful external POST leaves recoverable publishing state', async t => {
  const deps = options(); let creates = 0, finds = 0;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const issue = { number: 7, url: 'https://github.com/org/repo/issues/7' };
  deps.drafts.publisher = { create: async () => { creates++; entered(); await blocked; return issue; }, find: async () => { finds++; return issue; } };
  const store = new SdkCommunityIssueDraftStore(deps.storage);
  const draft = await store.create({ sourceType: 'cat_initiated', sourceId: 'source', title: 'Issue', bodyMarkdown: 'Public', targetRepo: 'org/repo', labels: [], threadId: 'thread', userId: 'owner' });
  let router = await createCommunityHttpRouter(deps); t.after(() => router.stop());
  const request = { principal, method: 'POST', path: `github/community-issue-drafts/${draft.draftId}/publish`, body: {} };
  const pending = router.forwardOwner(request); await started;
  const stopping = router.stop(); release();
  assert.equal((await pending).status, 502); await stopping;
  assert.equal((await store.getById(draft.draftId))?.status, 'publishing');
  router = await createCommunityHttpRouter(deps);
  assert.equal((await router.forwardOwner(request)).body.draft.status, 'published');
  assert.equal(creates, 1); assert.equal(finds, 1);
});

test('native report rejects other case owners, other threads and forged actors', async t => {
  const deps = options();
  let verified = false; let invalidate: (() => Promise<void>) | undefined;
  deps.issues.verifyPublicIssueComment = async () => { await invalidate?.(); return verified; };
  const issues = new SdkCommunityWorkflowIssueStore(deps.storage);
  const issue = (await issues.create({ repo: 'org/repo', issueNumber: 1, issueType: 'bug', title: 'Bug' }))!;
  await issues.update(issue.id, { assignedCatId: 'assigned', assignedThreadId: 'assigned-thread', state: 'accepted' });
  await new SdkCommunityObjectStore(deps.storage).save({ repo: 'org/repo', type: 'issue', number: 1, subjectKey: 'issue:org/repo#1', state: 'fixed', ownerThreadId: 'assigned-thread', ownerRole: 'assigned', nextOwner: 'role', lastExternalActivityAt: null, lastPublicCommentAt: null, linkedIssues: [], linkedPrs: [], closureWaiver: null, issueFixEvidence: null, externalReview: null, appliedEventCount: 0, lastRejectedEvent: null, deliveryCursor: null, createdAt: 1, updatedAt: 1 });
  const router = await createCommunityHttpRouter(deps); t.after(() => router.stop());
  const caller = { catId: 'intruder', threadId: 'assigned-thread', userId: 'owner', invocationId: 'inv', assertCurrent: async () => {} };
  const payload = { actor: 'assigned', publicCommentUrl: 'https://github.com/org/repo/issues/1#issuecomment-123' };
  assert.equal((await router.invokeNative('github.community.report', { id: issue.id, payload }, caller)).status, 403);
  assert.equal((await router.invokeNative('github.community.report', { id: issue.id, payload }, { ...caller, catId: 'assigned', threadId: 'other' })).status, 403);
  assert.equal((await router.invokeNative('github.community.report', { id: issue.id, payload: { ...payload, actor: 'fake' } }, { ...caller, catId: 'assigned' })).status, 403);
  assert.equal((await router.invokeNative('github.community.report', { id: issue.id, payload: { ...payload, publicCommentUrl: 'not-a-url' } }, { ...caller, catId: 'assigned' })).status, 400);
  assert.equal((await new SdkCommunityObjectStore(deps.storage).get('issue:org/repo#1'))?.lastPublicCommentAt, null);
  const assigned = { ...caller, catId: 'assigned' };
  assert.equal((await router.invokeNative('github.community.report', { id: issue.id, payload }, assigned)).status, 422);
  verified = true;
  invalidate = async () => { await issues.update(issue.id, { assignedCatId: 'new-owner' }); };
  assert.equal((await router.invokeNative('github.community.report', { id: issue.id, payload }, assigned)).status, 403);
  invalidate = undefined;
  await issues.update(issue.id, { assignedCatId: 'assigned' });
  const good = await router.invokeNative('github.community.report', { id: issue.id, payload: { publicCommentUrl: payload.publicCommentUrl } }, assigned);
  assert.equal(good.status, 200, JSON.stringify(good));
  const events = await new SdkCommunityEventLog(deps.storage).read('issue:org/repo#1');
  assert.equal(events.filter(event => event.kind === 'case.reported').length, 1);
  assert.equal(events.at(-1)?.payload.actor, 'assigned');
  assert.equal((await router.forwardOwner({ principal, method: 'POST', path: `github/community-issues/${issue.id}/waive-closure`, body: { reason: 'reason', actor: 'fake', evidence: 'evidence' } })).status, 403);

});

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
