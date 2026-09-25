import assert from 'node:assert/strict';
import test from 'node:test';
import type { FeatureContext } from '@clowder-ai/plugin-sdk';

import { createConnectorLifecycleAction, type ConnectorLifecycleCallbacks } from './lifecycle-action.js';

// Crash simulation: storage snapshots every accepted write, so a test can
// rewind the map to the pre-write of a transition (marker present, platform
// effect never ran — the process died in between) and redeliver the same
// deliveryId through a fresh action instance, exactly what the Host does.
function harness(options?: { withPlaceholder?: boolean }) {
  const state = new Map<string, { revision: number; value: unknown }>();
  const writes: Array<{ key: string; value: unknown }> = [];
  const calls: unknown[][] = [];
  const context = {
    storage: {
      get: async (key: string) => state.get(key),
      set: async (key: string, value: unknown) => {
        writes.push({ key, value: structuredClone(value) });
        const revision = (state.get(key)?.revision ?? 0) + 1;
        state.set(key, { revision, value });
        return { revision };
      },
    },
    threads: {
      listBindings: async () => [{ key: 'chat-1', threadId: 'thread-1', createdAt: 1 }],
    },
    log() { /* tests assert on calls/state, not warnings */ },
  } as unknown as FeatureContext;
  const callbacks: ConnectorLifecycleCallbacks = {
    async sendPlaceholder(...args) {
      calls.push(['sendPlaceholder', ...args]);
      return options?.withPlaceholder === false ? '' : 'placeholder-1';
    },
    async editPlaceholder(...args) { calls.push(['editPlaceholder', ...args]); return true; },
    async sendRecovery(...args) { calls.push(['sendRecovery', ...args]); },
    async settle(input) { calls.push(['settle', input]); },
  };
  return {
    state,
    writes,
    calls,
    context,
    callbacks,
    action: createConnectorLifecycleAction(context, callbacks),
    // Rewind storage to a captured write and restart the action, simulating
    // a process crash after that write with a fresh in-memory runtime.
    rewindTo(write: { key: string; value: unknown }) {
      const revision = (state.get(write.key)?.revision ?? 0) + 1;
      state.set(write.key, { revision, value: structuredClone(write.value) });
      calls.length = 0;
      return createConnectorLifecycleAction(context, callbacks);
    },
  };
}

const RECOVERY_TEXT = '⚠️ 未能完成最新消息重读（needs_user）。请打开 Clowder AI 重试。';

function started() {
  return {
    lifecycleId: 'life-1', deliveryId: 'delivery-1', threadId: 'thread-1', state: 'started',
    presentation: { actor: { displayName: '砚砚', emoji: '🐱' }, thread: { shortId: 'thread-1' } },
  };
}

function blocked() {
  return { lifecycleId: 'life-1', deliveryId: 'delivery-2', threadId: 'thread-1', state: 'blocked', reason: 'needs_user' };
}

function settled() {
  return { lifecycleId: 'life-1', deliveryId: 'delivery-3', threadId: 'thread-1', state: 'settled', chainDone: false, outcome: 'failed' };
}

function recordOf(h: ReturnType<typeof harness>): Record<string, unknown> {
  return h.state.get('lifecycle/life-1')?.value as Record<string, unknown>;
}

test('blocked pre-write carries the pending-effect marker and the post-write clears it', async () => {
  const h = harness();
  await h.action(started());
  await h.action(blocked());
  const blockedPre = h.writes.find(write => (
    (write.value as Record<string, unknown>).pendingEffect !== undefined
    && ((write.value as Record<string, unknown>).pendingEffect as Record<string, unknown>).state === 'blocked'
  ));
  assert.ok(blockedPre, 'blocked pre-write must carry the pending-effect marker');
  assert.deepEqual(blockedPre.value, {
    ...(blockedPre.value as Record<string, unknown>),
    // pinned marker shape: small, versioned, names the pending effect
    pendingEffect: { v: 1, state: 'blocked', recoveryText: RECOVERY_TEXT },
  });
  assert.equal(recordOf(h).pendingEffect, undefined, 'post-write clears the marker');
});

test('crash before the blocked effect (no placeholder): redelivery re-executes the recovery send exactly once', async () => {
  const h = harness({ withPlaceholder: false });
  await h.action(started());
  await h.action(blocked());
  const blockedPre = h.writes.find(write => (
    ((write.value as Record<string, unknown>).pendingEffect as Record<string, unknown> | undefined)?.state === 'blocked'
  ));
  assert.ok(blockedPre);
  // Rewind to the blocked pre-write: state accepted, recovery send never ran.
  const redelivered = h.rewindTo(blockedPre);

  const first = await redelivered(blocked());
  assert.deepEqual(first, { deliveryId: 'delivery-2' });
  const recoverySends = h.calls.filter(call => call[0] === 'sendRecovery');
  assert.equal(recoverySends.length, 1, 'the re-executed recovery hint is delivered exactly once');
  assert.deepEqual(recoverySends[0], ['sendRecovery', 'chat-1', RECOVERY_TEXT]);
  assert.equal(recordOf(h).pendingEffect, undefined, 're-execution clears the marker');

  const second = await redelivered(blocked());
  assert.deepEqual(second, { deliveryId: 'delivery-2' });
  assert.equal(h.calls.filter(call => call[0] === 'sendRecovery').length, 1, 'a further redelivery does not duplicate the hint');
});

test('crash before the blocked effect (placeholder present): redelivery re-executes the blocked edit once, no recovery send', async () => {
  const h = harness();
  await h.action(started());
  await h.action(blocked());
  const blockedPre = h.writes.find(write => (
    ((write.value as Record<string, unknown>).pendingEffect as Record<string, unknown> | undefined)?.state === 'blocked'
  ));
  assert.ok(blockedPre);
  const redelivered = h.rewindTo(blockedPre);

  await redelivered(blocked());
  assert.equal(h.calls.filter(call => call[0] === 'editPlaceholder').length, 1);
  assert.equal(h.calls.filter(call => call[0] === 'sendRecovery').length, 0, 'an editable placeholder keeps the edit fallback');
  await redelivered(blocked());
  assert.equal(h.calls.filter(call => call[0] === 'editPlaceholder').length, 1);
});

test('crash before the settle effect: tombstone redelivery re-runs settle with the recovery text exactly once', async () => {
  const h = harness();
  await h.action(started());
  await h.action(blocked());
  await h.action(settled());
  const settledPre = h.writes.find(write => (
    ((write.value as Record<string, unknown>).pendingEffect as Record<string, unknown> | undefined)?.state === 'settled'
  ));
  assert.ok(settledPre, 'settle-with-recovery-text pre-write carries the marker');
  const redelivered = h.rewindTo(settledPre);

  await redelivered(settled());
  const settlements = h.calls.filter(call => call[0] === 'settle');
  assert.equal(settlements.length, 1, 'the re-executed settlement runs exactly once');
  assert.equal((settlements[0][1] as Record<string, unknown>).recoveryText, RECOVERY_TEXT);
  assert.equal((settlements[0][1] as Record<string, unknown>).platformMessageId, 'placeholder-1');
  assert.equal(recordOf(h).pendingEffect, undefined);

  await redelivered(settled());
  assert.equal(h.calls.filter(call => call[0] === 'settle').length, 1, 'a further redelivery does not re-run settle');

  // A redelivery of the earlier blocked delivery on the same tombstone is a
  // plain replay: the settled marker must not trigger effects for it.
  await redelivered(blocked());
  assert.equal(h.calls.filter(call => call[0] === 'settle').length, 1);
  assert.equal(h.calls.filter(call => call[0] === 'sendRecovery').length, 0);
});

test('settle arriving while a blocked marker is pending flushes the recovery effect before settling', async () => {
  const h = harness();
  await h.action(started());
  await h.action(blocked());
  const blockedPre = h.writes.find(write => (
    ((write.value as Record<string, unknown>).pendingEffect as Record<string, unknown> | undefined)?.state === 'blocked'
  ));
  assert.ok(blockedPre);
  // The Host never redelivers blocked; it moves on to settle. The marker must
  // not be silently overwritten — the recovery effect flushes first.
  const resumed = h.rewindTo(blockedPre);

  await resumed(settled());
  assert.equal(h.calls.filter(call => call[0] === 'editPlaceholder').length, 1, 'pending blocked edit is flushed exactly once');
  const settlements = h.calls.filter(call => call[0] === 'settle');
  assert.equal(settlements.length, 1);
  assert.equal((settlements[0][1] as Record<string, unknown>).recoveryText, RECOVERY_TEXT);
  const record = recordOf(h);
  assert.equal(record.tombstone, true);
  assert.equal(record.pendingEffect, undefined);
});

test('normal flow delivers the recovery hint exactly once total and leaves no marker', async () => {
  const h = harness();
  await h.action(started());
  await h.action(blocked());
  await h.action(settled());
  assert.equal(h.calls.filter(call => call[0] === 'editPlaceholder').length, 1);
  assert.equal(h.calls.filter(call => call[0] === 'sendRecovery').length, 0);
  assert.equal(h.calls.filter(call => call[0] === 'settle').length, 1);
  const record = recordOf(h);
  assert.equal(record.tombstone, true);
  assert.equal(record.pendingEffect, undefined);
});

test('v2 records without the marker (written before this change) still load and answer replay', async () => {
  const h = harness();
  await h.action(started());
  await h.action(blocked());
  const blockedPost = h.writes[h.writes.length - 1];
  // Strip the field as old records lack it.
  const legacy = { ...(blockedPost.value as Record<string, unknown>) } as Record<string, unknown>;
  delete legacy.pendingEffect;
  const redelivered = h.rewindTo({ key: blockedPost.key, value: legacy });
  const replay = await redelivered(blocked());
  assert.deepEqual(replay, { deliveryId: 'delivery-2' });
  assert.equal(h.calls.filter(call => call[0] === 'sendRecovery').length, 0, 'no marker, no re-execution');
});

test('flush on a new transition clears the marker before the new pre-write', async () => {
  const h = harness();
  await h.action(started());
  await h.action(blocked());
  const blockedPre = h.writes.find(write => (
    ((write.value as Record<string, unknown>).pendingEffect as Record<string, unknown> | undefined)?.state === 'blocked'
  ));
  assert.ok(blockedPre);
  const resumed = h.rewindTo(blockedPre);
  await resumed(settled());
  // Between the flushed effect and the settled pre-write there must be a
  // write that clears the marker; otherwise a failed settled pre-write would
  // leave it in place and every Host retry would re-run the flush.
  const flushClear = h.writes.find(write => {
    const value = write.value as Record<string, unknown>;
    return value.pendingEffect === undefined
      && Array.isArray(value.history)
      && (value.history as unknown[]).length === 2;
  });
  assert.ok(flushClear, 'the flush must clear the pending-effect marker');
  assert.equal(recordOf(h).pendingEffect, undefined);
});

test('a throwing listBindings surfaces as a coded PLUGIN_INTERNAL error, on the normal and the re-execute path', async () => {
  const h = harness();
  await h.action(started());
  await h.action(blocked());
  const blockedPre = h.writes.find(write => (
    ((write.value as Record<string, unknown>).pendingEffect as Record<string, unknown> | undefined)?.state === 'blocked'
  ));
  assert.ok(blockedPre);
  h.context.threads.listBindings = async () => { throw new Error('redis down'); };
  // New-transition path.
  await assert.rejects(h.action(settled()), (error: unknown) => (
    (error as { code?: string }).code === 'PLUGIN_INTERNAL'
    && (error as Error).message.includes('binding listing failed')
  ));
  // Crash-redelivery re-execute path.
  const redelivered = h.rewindTo(blockedPre);
  await assert.rejects(redelivered(blocked()), (error: unknown) => (
    (error as { code?: string }).code === 'PLUGIN_INTERNAL'
    && (error as Error).message.includes('binding listing failed')
  ));
});

test('sender name resolves once per started even with several bindings', async () => {
  const state = new Map<string, { revision: number; value: unknown }>();
  let resolveCalls = 0;
  const context = {
    storage: {
      get: async (key: string) => state.get(key),
      set: async (key: string, value: unknown) => {
        const revision = (state.get(key)?.revision ?? 0) + 1;
        state.set(key, { revision, value });
        return { revision };
      },
    },
    threads: {
      listBindings: async () => [
        { key: 'chat-1', threadId: 'thread-1', createdAt: 1 },
        { key: 'chat-2', threadId: 'thread-1', createdAt: 2 },
      ],
    },
    log() {},
  } as unknown as FeatureContext;
  const sent: unknown[][] = [];
  const action = createConnectorLifecycleAction(context, {
    async sendPlaceholder(...args) { sent.push(args); return `placeholder-${sent.length}`; },
    async editPlaceholder() { return true; },
    async sendRecovery() {},
    async settle() {},
    async resolveReplySenderName() { resolveCalls += 1; return '布偶猫'; },
  });
  await action({ ...started(), replyTo: 'host-message-1' });
  assert.equal(resolveCalls, 1, 'one lookup per started, not one per binding');
  assert.equal(sent.length, 2);
  assert.ok(sent.every(args => (args[1] as string).includes('→布偶猫')));
});
