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
  await assert.rejects(async () => active.actions['telegram.outbound']?.({ ...delivery(), externalConversationId: 'forbidden' }), /unsupported field/);
  await active.stop();
});

test('telegram.test reports ok while polling with a configured token', async () => {
  const entrypoint = createTelegramPluginModule(() => ({
    outbound: {} as TelegramAdapter,
    async start() {},
    async stop() {},
    isPolling: () => true,
  }) as TelegramConnectorRuntime<TelegramAdapter>);
  const host: ModulePluginHostShape = {
    config: { get: async () => undefined }, secrets: { get: async () => '123456:ABCdefGHIJKL' },
    storage: {} as never, tasks: {} as never,
    media: { read: async input => ({ offset: input.offset, dataBase64: '', done: true }) },
    threads: { listBindings: async () => [], ensureByKey: async () => { throw new Error('unused'); } } as never,
    messaging: { subscribe: async () => undefined, unsubscribe: async () => undefined, send: async () => { throw new Error('unused'); } },
    log() {},
  };
  const active = await entrypoint.create(manifest).start(host);
  assert.deepEqual(await active.actions['telegram.test']?.(undefined), { ok: true });
  await active.stop();
});

test('telegram.test reports not configured when the token is missing', async () => {
  const entrypoint = createTelegramPluginModule(() => {
    throw new Error('runtime must not be created without a token');
  });
  const host: ModulePluginHostShape = {
    config: { get: async () => undefined }, secrets: { get: async () => undefined },
    storage: {} as never, tasks: {} as never,
    media: { read: async input => ({ offset: input.offset, dataBase64: '', done: true }) },
    threads: { listBindings: async () => [], ensureByKey: async () => { throw new Error('unused'); } } as never,
    messaging: { subscribe: async () => undefined, unsubscribe: async () => undefined, send: async () => { throw new Error('unused'); } },
    log() {},
  };
  const active = await entrypoint.create(manifest).start(host);
  assert.deepEqual(await active.actions['telegram.test']?.(undefined), { ok: false, message: 'Telegram Bot Token 未配置' });
  await active.stop();
});

test('telegram.test reports not-polling separately from a missing token', async () => {
  const entrypoint = createTelegramPluginModule(() => ({
    outbound: {} as TelegramAdapter,
    async start() {},
    async stop() {},
    isPolling: () => false,
  }) as TelegramConnectorRuntime<TelegramAdapter>);
  const host: ModulePluginHostShape = {
    config: { get: async () => undefined }, secrets: { get: async () => '123456:ABCdefGHIJKL' },
    storage: {} as never, tasks: {} as never,
    media: { read: async input => ({ offset: input.offset, dataBase64: '', done: true }) },
    threads: { listBindings: async () => [], ensureByKey: async () => { throw new Error('unused'); } } as never,
    messaging: { subscribe: async () => undefined, unsubscribe: async () => undefined, send: async () => { throw new Error('unused'); } },
    log() {},
  };
  const active = await entrypoint.create(manifest).start(host);
  assert.deepEqual(await active.actions['telegram.test']?.(undefined), { ok: false, message: 'Telegram 未在轮询（Token 已配置）' });
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
        { elementId: 'm1', kind: 'media_ref', payload: { type: 'audio', reference: 'hmr_audio-1', fileName: 'voice.ogg' } },
        { elementId: 'm2', kind: 'media_ref', payload: { type: 'image', reference: 'hmr_denied' } },
        { elementId: 'm3', kind: 'media_ref', payload: { type: 'file', reference: 'legacy-provider-key' } },
        { elementId: 'm4', kind: 'media_ref', payload: { type: 'video', reference: 'hmr_video-1' } },
        { elementId: 'w1', kind: 'media_warning', payload: { mediaElementId: 'm1', stage: 'transcription', reason: 'processing_failed' } },
        { elementId: 'r1', kind: 'rich_block', payload: { id: 'b1', kind: 'card', v: 1, title: 'T', bodyMarkdown: 'B' } },
        { elementId: 'r2', kind: 'rich_block', payload: { id: 'b2', kind: 'checklist', v: 1, title: 'L', items: [{ id: 'i1', text: 'a', checked: true }, { id: 'i2', text: 'b' }] } },
      ] },
    },
  };
}

test('rich blocks and typed media notices route to sendRichMessage instead of sendReply', async () => {
  const calls: Array<{ operation: string; value: unknown }> = [];
  const outbound = {
    async sendRichMessage(...args: unknown[]) { calls.push({ operation: 'provider.rich', value: args }); },
    async sendReply(...args: unknown[]) { calls.push({ operation: 'provider.send', value: args }); },
    async sendMedia(chatId: string, payload: Record<string, unknown>) {
      assert.equal('url' in payload, false);
      assert.equal('absPath' in payload, false);
      assert.ok(payload.content !== undefined);
      const chunks: Buffer[] = [];
      for await (const chunk of payload.content as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
      calls.push({ operation: 'provider.media', value: [chatId, payload.type, Buffer.concat(chunks).toString(), payload.fileName] });
    },
  } as unknown as TelegramAdapter;
  const entrypoint = createTelegramPluginModule(() => ({ outbound, async start() {}, async stop() {} }) as TelegramConnectorRuntime<TelegramAdapter>);
  const host: ModulePluginHostShape = {
    config: { get: async () => undefined }, secrets: { get: async () => 'bot-token' },
    storage: {} as never, tasks: {} as never,
    media: { read: async input => input.reference === 'hmr_denied'
      ? Promise.reject(Object.assign(new Error('denied'), { name: 'MEDIA_ACCESS_DENIED' }))
      : input.offset === 0
      ? { offset: 0, dataBase64: Buffer.from('voice-').toString('base64'), done: false, nextOffset: 6 }
      : { offset: 6, dataBase64: Buffer.from('bytes').toString('base64'), done: true } },
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
  await active.actions['telegram.outbound']?.(richDelivery());
  assert.deepEqual(calls, [
    { operation: 'provider.rich', value: ['chat-1', '正文\n\n⚠️ 媒体不可用：diagram.png（来源已过期）\n\n⚠️ 媒体处理警告：转写处理失败', [
      { id: 'b1', kind: 'card', v: 1, title: 'T', bodyMarkdown: 'B' },
      { id: 'b2', kind: 'checklist', v: 1, title: 'L', items: [{ id: 'i1', text: 'a', checked: true }, { id: 'i2', text: 'b' }] },
    ], 'cat-1'] },
    { operation: 'provider.media', value: ['chat-1', 'audio', 'voice-bytes', 'voice.ogg'] },
    { operation: 'provider.send', value: ['chat-1', '⚠️ 媒体不可用（读取或上传失败）'] },
    { operation: 'provider.send', value: ['chat-1', '⚠️ 媒体不可用（旧引用无法读取）'] },
    { operation: 'provider.send', value: ['chat-1', '⚠️ 视频附件暂不支持发送'] },
  ]);
  await active.stop();
});
