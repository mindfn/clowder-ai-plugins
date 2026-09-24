import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import { parse } from 'yaml';

import moduleEntrypoint, { createDingTalkPluginModule } from './plugin-entrypoint.js';
import type { DingTalkAdapter } from './DingTalkAdapter.js';
import type { DingTalkConnectorRuntime, DingTalkHostInboundMessage } from './runtime.js';

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
  let inbound!: (message: DingTalkHostInboundMessage) => Promise<void>;
  const outbound = {
    async sendFormattedReply(...args: unknown[]) { calls.push({ operation: 'provider.send', value: args }); },
    async sendMedia() {}, async sendReply() {},
  } as unknown as DingTalkAdapter;
  const entrypoint = createDingTalkPluginModule((options) => {
    inbound = options.host.deliver;
    return { outbound, async start() {}, async stop() {} } as DingTalkConnectorRuntime<DingTalkAdapter>;
  });
  const host: ModulePluginHostShape = {
    config: { get: async () => 'app-key' }, secrets: { get: async () => 'app-secret' },
    storage: {} as never, tasks: {} as never,
    media: { read: async input => ({ offset: input.offset, dataBase64: '', done: true }) },
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
  await inbound({
    externalConversationId: 'chat-1',
    providerConversationId: 'provider-chat-1',
    providerMessageId: 'provider-1',
    text: 'inbound',
    chatType: 'group',
  });
  await active.actions['dingtalk.outbound']?.(delivery());
  assert.deepEqual(calls.filter(call => call.operation === 'subscribe').map(call => call.value), [
    { threadId: 'thread-1', method: 'dingtalk.outbound' },
  ]);
  const sent = calls.find(call => call.operation === 'send')?.value as Record<string, unknown>;
  assert.equal(sent.threadId, 'thread-1');
  assert.equal(sent.idempotencyKey, 'provider-1');
  assert.equal('address' in sent, false);
  assert.equal((calls.find(call => call.operation === 'provider.send')?.value as unknown[])[0], 'chat-1');
  await assert.rejects(async () => active.actions['dingtalk.outbound']?.({ ...delivery(), externalConversationId: 'forbidden' }), /unsupported field/);
  await active.stop();
});

function richDelivery() {
  return {
    deliveryId: 'delivery-1', threadId: 'thread-1',
    envelope: {
      messageId: 'message-1', revision: 1, threadId: 'thread-1',
      actor: { kind: 'cat', id: 'cat-1' }, audience: { kind: 'public' }, occurredAt: '2026-09-22T00:00:00.000Z',
      payload: { provenance: { origin: { kind: 'host' }, epistemicStatus: 'observation' }, elements: [
        { elementId: 't1', kind: 'text', payload: { text: '正文' } },
        { elementId: 'u1', kind: 'media_unavailable', payload: { type: 'image', fileName: 'diagram.png', reason: 'source_expired' } },
        { elementId: 'm1', kind: 'media_ref', payload: { type: 'audio', reference: 'hmr_audio-1' } },
        { elementId: 'w1', kind: 'media_warning', payload: { mediaElementId: 'm1', stage: 'transcription', reason: 'processing_failed' } },
        { elementId: 'r1', kind: 'rich_block', payload: { id: 'b1', kind: 'card', v: 1, title: 'T', bodyMarkdown: 'B' } },
        { elementId: 'r2', kind: 'rich_block', payload: { id: 'b2', kind: 'checklist', v: 1, title: 'L', items: [{ id: 'i1', text: 'a', checked: true }, { id: 'i2', text: 'b' }] } },
      ] },
    },
  };
}

test('rich blocks and typed media notices route to sendRichMessage instead of sendFormattedReply', async () => {
  const calls: Array<{ operation: string; value: unknown }> = [];
  const outbound = {
    async sendRichMessage(...args: unknown[]) { calls.push({ operation: 'provider.rich', value: args }); },
    async sendFormattedReply(...args: unknown[]) { calls.push({ operation: 'provider.formatted', value: args }); },
    async sendMedia() {}, async sendReply() {},
  } as unknown as DingTalkAdapter;
  const entrypoint = createDingTalkPluginModule(() => ({ outbound, async start() {}, async stop() {} }) as DingTalkConnectorRuntime<DingTalkAdapter>);
  const host: ModulePluginHostShape = {
    config: { get: async () => 'app-key' }, secrets: { get: async () => 'app-secret' },
    storage: {} as never, tasks: {} as never,
    media: { read: async input => ({ offset: input.offset, dataBase64: '', done: true }) },
    threads: {
      listBindings: async () => [{ key: 'chat-1', threadId: 'thread-1', createdAt: 1 }],
      ensureByKey: async (key: string) => ({ id: 'thread-1', title: key, createdAt: 1, lastActiveAt: 1 }),
    } as never,
    messaging: {
      subscribe: async () => undefined,
      unsubscribe: async () => undefined,
      send: async input => ({ messageId: 'host-message-1', threadId: input.threadId }),
    },
    log() {},
  };

  const active = await entrypoint.create(manifest).start(host);
  await active.actions['dingtalk.outbound']?.(richDelivery());
  assert.deepEqual(calls, [
    { operation: 'provider.rich', value: ['chat-1', '正文\n\n⚠️ 媒体不可用：diagram.png（来源已过期）\n\n⚠️ 媒体处理警告：转写处理失败', [
      { id: 'b1', kind: 'card', v: 1, title: 'T', bodyMarkdown: 'B' },
      { id: 'b2', kind: 'checklist', v: 1, title: 'L', items: [{ id: 'i1', text: 'a', checked: true }, { id: 'i2', text: 'b' }] },
    ], 'cat-1', undefined] },
  ]);
  await active.stop();
});
