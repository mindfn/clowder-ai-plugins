import assert from 'node:assert/strict';
import test from 'node:test';
import type { PluginStorageHost, PluginMessagingDraft } from '@clowder-ai/plugin-sdk';
import { GitHubWaitStorage } from './typed-wait-storage.js';
import { GitHubWaitLifecycleService } from './business/domains/github-signals/GitHubWaitLifecycleService.js';
import { WaitLifecycleRecoverySweep } from './business/domains/ball-custody/WaitLifecycleRecoverySweep.js';
import type { TaskItem } from './business/model/index.js';

function fixture() {
  const rows = new Map<string, { revision: number; value: unknown }>();
  let revision = 0;
  const storage: PluginStorageHost = {
    async get(k) { return structuredClone(rows.get(k)); },
    async list() { return structuredClone(Object.fromEntries(rows)); },
    async set(k, value) { rows.set(k, { revision: ++revision, value: structuredClone(value) }); return { revision }; },
    async compareAndSet(k, expected, value) {
      if ((rows.get(k)?.revision ?? null) !== expected) return { applied: false };
      rows.set(k, { revision: ++revision, value: structuredClone(value) }); return { applied: true, revision };
    },
    async delete(k, expected) {
      if (!rows.has(k) || (expected !== undefined && expected !== rows.get(k)?.revision)) return { deleted: false };
      rows.delete(k); return { deleted: true, revision: ++revision };
    },
  };
  const store = new GitHubWaitStorage(storage, () => 500);
  const task: TaskItem = {
    id: 'task1', kind: 'pr_tracking', threadId: 'thread1', subjectKey: 'pr:owner/repo#7',
    title: 'PR', why: '', status: 'doing', ownerCatId: 'astra', createdBy: 'astra', userId: 'owner',
    createdAt: 100, updatedAt: 100, automationState: {
      review: { lastInlineCommentCursor: 20, lastConversationCommentCursor: 30 },
      await: { v: 1, generation: 3, subjectRef: 'pr:owner/repo#7',
        ownerFence: { kind: 'containing_task', generation: 3 }, createdAt: 100,
        baseline: { capturedAt: 100, headSha: 'old' },
        continuation: { when: [{ kind: 'pr_head_changed' }], then: 'Continue review.' },
      },
    },
  };
  const messages: (PluginMessagingDraft & { threadId: string })[] = [];
  let fail = false;
  const messaging = { async send(input: PluginMessagingDraft & { threadId: string }) {
    if (fail) throw new Error('transport interrupted');
    if (!messages.some(m => m.idempotencyKey === input.idempotencyKey)) messages.push(input);
    return { messageId: 'message1', threadId: input.threadId };
  } };
  const lifecycle = (s = store) => new GitHubWaitLifecycleService({
    taskStore: s, deliveryDeps: { messaging }, now: () => 500,
    log: { info() {}, warn() {}, error() {} },
  });
  return { storage, store, task, messages, lifecycle, setFail(value: boolean) { fail = value; } };
}

test('private CAS preserves generation and rejects competing renewal without a second write', async () => {
  const f = fixture();
  await f.store.create(f.task);
  const input = { expectedGeneration: 3, expectedUpdatedAt: 100,
    automationState: f.task.automationState!, status: 'doing' as const };
  const results = await Promise.all([f.store.replaceAutomationStateIfGeneration('task1', input),
    new GitHubWaitStorage(f.storage).replaceAutomationStateIfGeneration('task1', input)]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await f.store.create(f.task), null);
});

test('a quiet collector patch preserves independent review cursors', async () => {
  const f = fixture(); await f.store.create(f.task);
  await f.store.patchAutomationState('task1', { review: { lastInlineCommentCursor: 21 } });
  assert.equal((await f.store.get('task1'))?.automationState?.review?.lastConversationCommentCursor, 30);
});

test('failed SDK delivery survives recreation and recovery uses the same outcome idempotency key', async () => {
  const f = fixture(); await f.store.create(f.task); f.setFail(true);
  await assert.rejects(f.lifecycle().observe({ taskId: 'task1', facts: { headSha: 'new' } }), /transport interrupted/);
  const pending = await f.store.get('task1');
  assert.equal(pending?.automationState?.waitOutcome?.delivery, 'pending');
  assert.equal(pending?.automationState?.await?.generation, 4);
  f.setFail(false);
  const recreated = new GitHubWaitStorage(f.storage);
  const recovery = new WaitLifecycleRecoverySweep(recreated, f.lifecycle(recreated));
  await recovery.run(); await recovery.run();
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0]?.idempotencyKey, 'github-wait:task1:wait:pr:owner/repo#7:g3:matched');
  assert.deepEqual(f.messages[0]?.wake, { catId: 'astra' });
  assert.equal((await recreated.get('task1'))?.automationState?.waitOutcome?.delivery, 'delivered');
  assert.equal((await recreated.get('task1'))?.automationState?.await?.generation, 4);
});
