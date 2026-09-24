import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import { parse } from 'yaml';

import { createTelegramPluginModule } from './plugin-entrypoint.js';
import { TelegramAdapter } from './TelegramAdapter.js';
import type { InlineFinalPersistence } from './TelegramAdapter.js';
import type { TelegramConnectorRuntime } from './runtime.js';

const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')) as unknown;

function hostWithState(state: Map<string, { revision: number; value: unknown }>, externalChatId = 'chat-1'): ModulePluginHostShape {
  return {
    config: { get: async () => undefined }, secrets: { get: async () => 'bot-token' },
    storage: {
      get: async key => state.get(key), list: async () => Object.fromEntries(state),
      set: async (key, value) => { const revision = (state.get(key)?.revision ?? 0) + 1; state.set(key, { revision, value }); return { revision }; },
      compareAndSet: async () => ({ applied: false }), delete: async key => ({ deleted: state.delete(key) }),
    },
    tasks: {} as never,
    media: { read: async input => ({ offset: input.offset, dataBase64: '', done: true }) },
    threads: {
      listBindings: async () => [{ key: externalChatId, threadId: 'thread-1', createdAt: 1 }],
      ensureByKey: async () => ({ id: 'thread-1' }),
    } as never,
    messaging: { subscribe: async () => undefined, unsubscribe: async () => undefined, send: async input => ({ messageId: 'message-1', threadId: input.threadId }) },
    log() {},
  };
}

function delivery() {
  return {
    deliveryId: 'delivery-1', threadId: 'thread-1',
    presentation: { actor: { displayName: 'Cat', emoji: '🐱' }, thread: { shortId: 'thread-1' } },
    envelope: {
      messageId: 'message-1', revision: 1, threadId: 'thread-1',
      actor: { kind: 'cat', id: 'cat-1' }, audience: { kind: 'public' }, occurredAt: '2026-09-22T00:00:00.000Z',
      payload: { provenance: { origin: { kind: 'host' }, epistemicStatus: 'observation' }, elements: [{ elementId: 'text-1', kind: 'text', payload: { text: 'final body' } }] },
    },
  };
}

function adapterWithEdits(edits: unknown[][], persistence?: InlineFinalPersistence) {
  const outbound = new TelegramAdapter('123456:abcdefghij_ABC-123', { info() {}, warn() {}, error() {} }, persistence);
  outbound._injectBotApiSendMessage(async () => ({ message_id: 42 }));
  outbound._injectBotApiEditMessage(async (...args: unknown[]) => { edits.push(args); });
  outbound._injectBotApiDeleteMessage(async () => {});
  outbound._injectSendMessage(async () => {});
  return outbound;
}

function presentation() {
  return { actor: { displayName: '砚砚', emoji: '🐱' }, thread: { shortId: 'thread-1' } };
}

test('catching_up and blocked edits never reach editMessageText after the inline final consumed the placeholder', async () => {
  const edits: unknown[][] = [];
  const sends: unknown[][] = [];
  const outbound = adapterWithEdits(edits);
  outbound._injectSendMessage(async (...args: unknown[]) => { sends.push(args); });
  const entrypoint = createTelegramPluginModule(() => ({
    outbound, async start() {}, async stop() {}, isPolling: () => true,
  }) as TelegramConnectorRuntime<TelegramAdapter>);
  const active = await entrypoint.create(manifest).start(hostWithState(new Map(), '42'));
  const action = active.actions['host.messaging.lifecycle']!;
  await action({ lifecycleId: 'life-1', deliveryId: 'delivery-1', threadId: 'thread-1', state: 'started', presentation: presentation() });
  await active.actions['telegram.outbound']?.({ ...delivery(), lifecycleId: 'life-1' });
  assert.deepEqual(edits, [[42, 42, '【Cat🐱】\nfinal body', undefined]]);
  await action({ lifecycleId: 'life-1', deliveryId: 'delivery-2', threadId: 'thread-1', state: 'catching_up' });
  await action({ lifecycleId: 'life-1', deliveryId: 'delivery-3', threadId: 'thread-1', state: 'blocked', reason: 'needs_user' });
  assert.equal(edits.length, 1, 'catching_up/blocked edits must not touch the consumed placeholder');
  assert.ok(sends.some(args => typeof args[1] === 'string' && args[1].includes('未能完成')));
  await active.stop();
});

test('a fresh started clears the consumed marker for its lifecycleId', async () => {
  const edits: unknown[][] = [];
  const outbound = adapterWithEdits(edits);
  outbound.registerInlinePlaceholder('42', '42', 'life-1');
  await outbound.sendReply('42', 'final body', undefined, 'life-1');
  assert.equal(outbound.isInlineFinalConsumed('life-1'), true);
  outbound.registerInlinePlaceholder('42', '43', 'life-1');
  assert.equal(outbound.isInlineFinalConsumed('life-1'), false);
});

test('register persists and consume removes the lifecycle-keyed inline-final entry', async () => {
  const edits: unknown[][] = [];
  const saved: unknown[] = [];
  const removed: string[] = [];
  const persistence: InlineFinalPersistence = {
    async save(entry) { saved.push(entry); },
    async remove(lifecycleId) { removed.push(lifecycleId); },
  };
  const outbound = adapterWithEdits(edits, persistence);
  outbound.registerInlinePlaceholder('42', '42', 'life-1');
  assert.equal(saved.length, 1);
  const entry = saved[0] as Record<string, unknown>;
  assert.equal(entry.lifecycleId, 'life-1');
  assert.equal(entry.externalChatId, '42');
  assert.equal(entry.platformMessageId, '42');
  assert.equal(typeof entry.registeredAt, 'number');
  await outbound.sendReply('42', 'final body', undefined, 'life-1');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(removed, ['life-1']);
});

test('restart hydrates the persisted inline-final so the final still edits the original placeholder', async () => {
  const state = new Map<string, { revision: number; value: unknown }>();
  const registeredAt = Date.now();
  state.set('tg-inline-final:life-9', {
    revision: 1,
    value: { version: 1, lifecycleId: 'life-9', externalChatId: '42', platformMessageId: '77', registeredAt },
  });
  state.set('tg-inline-final:life-expired', {
    revision: 1,
    value: { version: 1, lifecycleId: 'life-expired', externalChatId: '42', platformMessageId: '88', registeredAt: registeredAt - 25 * 60 * 60 * 1000 },
  });
  const edits: unknown[][] = [];
  const outbound = adapterWithEdits(edits);
  const entrypoint = createTelegramPluginModule(() => ({
    outbound, async start() {}, async stop() {}, isPolling: () => true,
  }) as TelegramConnectorRuntime<TelegramAdapter>);
  const active = await entrypoint.create(manifest).start(hostWithState(state, '42'));
  await active.actions['telegram.outbound']?.({ ...delivery(), lifecycleId: 'life-9' });
  assert.deepEqual(edits, [[42, 77, '【Cat🐱】\nfinal body', undefined]]);
  assert.equal(state.has('tg-inline-final:life-expired'), false, 'expired entry must be swept during hydration');
  await active.stop();
});
