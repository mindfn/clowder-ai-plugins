import assert from 'node:assert/strict';
import test from 'node:test';
import { preparePrWait, prepareIssueWait, installPreparedWait } from './typed-wait-registration.js';
import { GitHubWaitStorage } from './typed-wait-storage.js';
import type { PluginStorageHost } from '@clowder-ai/plugin-sdk';
import type { TaskItem } from './business/model/index.js';

function dependencies() {
  let baselines = 0;
  const calls: number[] = [];
  return {
    calls, count: () => baselines,
    now: () => 1000,
    identity: async () => ({ selfLogin: 'author', subjectAuthorLogin: 'Author' }),
    baseline: async () => {
      baselines++;
      return { baseline: { capturedAt: 1000, headSha: 'aaa' }, collectorState: { ci: { headSha: 'aaa' } } };
    },
    coverage: async (_repo: string, _number: number, comment: number) => { calls.push(comment); return { covered: true }; },
  };
}

test('normal PR registration expands the existing author audience and returns honest coverage', async () => {
  const deps = dependencies();
  const result = await preparePrWait({ repoFullName: 'Owner/Repo', prNumber: 7 }, deps);
  assert.equal(result.subjectKey, 'pr:owner/repo#7');
  assert.equal(result.notification.perspective.role, 'subject_author');
  assert.equal(result.state.await?.continuation.when.some(p => p.kind === 'pr_head_changed'), false);
  assert.deepEqual(result.state.await?.continuation.when.filter(p => p.kind.endsWith('comment_added')), [
    { kind: 'pr_conversation_comment_added', audience: { mode: 'everyone_but_self', selfLogin: 'author' } },
    { kind: 'pr_inline_comment_added', audience: { mode: 'everyone_but_self', selfLogin: 'author' } },
  ]);
  assert.equal(result.state.await?.expiresAt, undefined);
  assert.equal(deps.count(), 1);
});

test('precise trigger coverage stays plugin-internal and rejects uncovered or unavailable evidence', async () => {
  const deps = dependencies();
  const input = { repoFullName: 'owner/repo', prNumber: 7,
    when: [{ kind: 'pr_review_result_available', triggerCommentId: 42 }] };
  await preparePrWait(input, deps); assert.deepEqual(deps.calls, [42]);
  await assert.rejects(preparePrWait(input, { ...deps, coverage: async () => ({ covered: false, reason: 'no EYES' }) }),
    { status: 422 });
  await assert.rejects(preparePrWait(input, { ...deps, coverage: async () => { throw new Error('page failed'); } }), /page failed/);
});

test('invalid registration is refused before baseline lookup; context cannot be supplied by tool input', async () => {
  const deps = dependencies();
  for (const extra of [
    { when: [{ kind: 'pr_head_changed' }], goal: { kind: 'await_reply_from', authorLogins: ['alice'] } },
    { expiresAt: 1000 }, { threadId: 'forged' },
    { when: [{ kind: 'pr_head_changed' }, { kind: 'pr_head_changed' }] },
  ]) await assert.rejects(preparePrWait({ repoFullName: 'owner/repo', prNumber: 7, ...extra }, deps));
  assert.equal(deps.count(), 0);
});

test('normal issue registration arms everyone but self without requiring PR reviewer grounds', async () => {
  const result = await prepareIssueWait({ repoFullName: 'Owner/Repo', issueNumber: 8 }, {
    now: () => 1000, identity: async () => ({ selfLogin: 'self' }),
    baseline: async () => ({ baseline: { capturedAt: 1000, issue: { lastCommentCursor: 4, state: 'open' } }, collectorState: {} }),
  });
  assert.equal(result.notification.perspective.role, 'issue_participant');
  assert.deepEqual(result.state.await?.continuation.when, [
    { kind: 'issue_comment_added', audience: { mode: 'everyone_but_self', selfLogin: 'self' } },
  ]);
});

test('identity lookup failure preserves the original explicit unresolved audience', async () => {
  const result = await preparePrWait({ repoFullName: 'owner/repo', prNumber: 7 }, {
    ...dependencies(), identity: async () => { throw new Error('identity unavailable'); },
  });
  assert.equal(result.notification.perspective.role, 'unresolved');
  assert.ok(result.notification.commentFilters.every(text => text.includes('normal coverage is NOT established')));
});

test('registration preserves a pending delivery across a new generation and refuses owner changes', async () => {
  let revision = 0;
  const rows = new Map<string, { revision: number; value: unknown }>();
  const storage = {
    async get(k: string) { return structuredClone(rows.get(k)); },
    async compareAndSet(k: string, expected: number | null, value: unknown) {
      if ((rows.get(k)?.revision ?? null) !== expected) return { applied: false };
      rows.set(k, { revision: ++revision, value: structuredClone(value) }); return { applied: true, revision };
    },
  } as PluginStorageHost;
  const store = new GitHubWaitStorage(storage, () => 1000);
  const plan = await preparePrWait({ repoFullName: 'owner/repo', prNumber: 7 }, dependencies());
  const task: TaskItem = { id: 'task', kind: 'pr_tracking', subjectKey: plan.subjectKey, ownerCatId: 'astra',
    userId: 'owner', threadId: 'thread', createdAt: 1, updatedAt: 1, title: 'PR', why: '', status: 'doing', createdBy: 'astra' };
  const first = await installPreparedWait(store, task, plan);
  await store.replaceAutomationStateIfGeneration(task.id, {
    expectedGeneration: 1, expectedUpdatedAt: first.updatedAt, status: 'doing',
    automationState: { ...first.automationState, waitOutcome: { v: 1,
      outcomeId: 'wait:pr:owner/repo#7:g1:matched', generation: 1, subjectRef: 'pr:owner/repo#7',
      ownerFence: { kind: 'containing_task', generation: 1 }, reason: 'matched', at: 999, delivery: 'pending' } },
  });
  const second = await installPreparedWait(store, task, plan);
  assert.equal(second.automationState?.await?.generation, 2);
  assert.equal(second.automationState?.waitOutcome?.delivery, 'pending');
  const before = await store.get(task.id);
  await assert.rejects(installPreparedWait(store, { ...task, ownerCatId: 'other' }, plan), { status: 409 });
  assert.deepEqual(await store.get(task.id), before);
});
