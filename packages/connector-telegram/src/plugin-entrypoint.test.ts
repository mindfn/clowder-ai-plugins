import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import { parse } from 'yaml';

import moduleEntrypoint, { createTelegramPluginModule } from './plugin-entrypoint.js';
import type { TelegramAdapter } from './TelegramAdapter.js';
import type { TelegramConnectorRuntime, TelegramHostInboundMessage } from './runtime.js';

const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')) as unknown;

function delivery() {
  return {
    deliveryId: 'delivery-1', threadId: 'thread-1',
    envelope: {
      messageId: 'message-1', revision: 1, threadId: 'thread-1',
      actor: { kind: 'cat', id: 'cat-1' }, audience: { kind: 'public' }, occurredAt: '2026-09-22T00:00:00.000Z',
      payload: { provenance: { origin: { kind: 'host' }, epistemicStatus: 'observation' }, elements: [{ elementId: 'text-1', kind: 'text', payload: { text: 'hello' } }] },
    },
  };
}

test('default export is the deterministic package module entrypoint', () => {
  assert.equal(typeof moduleEntrypoint.create(manifest).start, 'function');
});

test('module bridges provider ingress and Host subscription egress without connector authority', async () => {
  const calls: Array<{ operation: string; value: unknown }> = [];
  let inbound!: (message: TelegramHostInboundMessage) => Promise<void>;
  const outbound = {
    async sendReply(...args: unknown[]) { calls.push({ operation: 'provider.send', value: args }); },
    async sendRichMessage() {}, async sendMedia() {},
  } as unknown as TelegramAdapter;
  const entrypoint = createTelegramPluginModule((options) => {
    inbound = options.host.deliver;
    return { outbound, async start() {}, async stop() {} } as TelegramConnectorRuntime<TelegramAdapter>;
  });
  const host: ModulePluginHostShape = {
    config: { get: async () => undefined }, secrets: { get: async () => 'bot-token' },
    storage: {} as never, tasks: {} as never,
    threads: {
      listBindings: async () => [{ key: 'chat-1', threadId: 'thread-1', createdAt: 1 }],
      ensureByKey: async (key: string) => ({ id: 'thread-1', title: key, createdAt: 1, lastActiveAt: 1 }),
    } as never,
    messaging: {
      subscribe: async input => { calls.push({ operation: 'subscribe', value: input }); },
      unsubscribe: async () => undefined,
      send: async input => { calls.push({ operation: 'send', value: input }); return { messageId: 'host-message-1', threadId: input.threadId }; },
    },
    log() {},
  };

  const active = await entrypoint.create(manifest).start(host);
  await inbound({ externalConversationId: 'chat-1', externalSenderId: 'user-1', providerMessageId: 'provider-1', text: 'inbound' });
  await active.actions['telegram.outbound']?.(delivery());
  assert.deepEqual(calls.filter(call => call.operation === 'subscribe').map(call => call.value), [
    { threadId: 'thread-1', method: 'telegram.outbound' },
  ]);
  const sent = calls.find(call => call.operation === 'send')?.value as Record<string, unknown>;
  assert.equal(sent.threadId, 'thread-1');
  assert.equal(sent.idempotencyKey, 'provider-1');
  assert.equal('address' in sent, false);
  assert.equal((calls.find(call => call.operation === 'provider.send')?.value as unknown[])[0], 'chat-1');
  await assert.rejects(() => active.actions['telegram.outbound']?.({ ...delivery(), externalConversationId: 'forbidden' }), /unsupported field/);
  await active.stop();
});
