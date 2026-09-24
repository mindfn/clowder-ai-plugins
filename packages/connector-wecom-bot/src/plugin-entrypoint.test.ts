import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import { parse } from 'yaml';

import moduleEntrypoint, { createWeComBotPluginModule } from './plugin-entrypoint.js';
import type { WeComBotConnectorRuntime } from './runtime.js';
import type { WeComBotHostInboundMessage } from './runtime.js';
import type { WeComBotAdapter } from './WeComBotAdapter.js';

const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')) as unknown;
const delivery = {
  deliveryId: 'delivery-1',
  threadId: 'thread-1',
  envelope: {
    messageId: 'message-1', revision: 1, threadId: 'thread-1',
    actor: { kind: 'cat', id: 'cat-1' }, audience: { kind: 'public' }, occurredAt: '2026-09-22T00:00:00.000Z',
    payload: { provenance: { origin: { kind: 'host' }, epistemicStatus: 'observation' }, elements: [{ elementId: 'text-1', kind: 'text', payload: { text: 'hello' } }] },
  },
};

function host(sent: unknown[] = []): ModulePluginHostShape {
  const state = new Map<string, { revision: number; value: unknown }>();
  return {
    config: { get: async () => 'bot' },
    secrets: { get: async () => 'secret' },
    storage: {
      get: async key => state.get(key), list: async () => Object.fromEntries(state),
      set: async (key, value) => { const revision = (state.get(key)?.revision ?? 0) + 1; state.set(key, { revision, value }); return { revision }; },
      compareAndSet: async (key, expectedRevision, value) => {
        if (expectedRevision !== null || state.has(key)) return { applied: false };
        state.set(key, { revision: 1, value });
        return { applied: true, revision: 1 };
      }, delete: async key => ({ deleted: state.delete(key) }),
    },
    tasks: {} as never,
    media: { read: async input => ({ offset: input.offset, dataBase64: '', done: true }) },
    threads: {
      listBindings: async () => [{ key: 'chat-1', threadId: 'thread-1', createdAt: 1 }],
      ensureByKey: async () => ({ id: 'thread-1', title: 'chat-1', createdAt: 1, lastActiveAt: 1 }),
    } as never,
    messaging: { subscribe: async () => undefined, unsubscribe: async () => undefined, send: async input => { sent.push(input); return { messageId: 'message-1', threadId: input.threadId, revision: 1, messageHandle: 'handle-1', pendingPublication: true as const }; } },
    log() {},
  };
}

test('default export is the deterministic package module entrypoint', () => {
  assert.equal(typeof moduleEntrypoint.create, 'function');
  assert.equal(typeof moduleEntrypoint.create(manifest).start, 'function');
});

test('provider media locator stays in private state while ingress emits only pmr', async () => {
  const sent: unknown[] = [];
  let inbound!: (message: WeComBotHostInboundMessage) => Promise<void>;
  const outbound = { async downloadMedia() { return { buffer: Buffer.from('bytes') }; } } as unknown as WeComBotAdapter;
  const entrypoint = createWeComBotPluginModule((options) => {
    inbound = options.host.deliver;
    return { outbound, async start() {}, async stop() {} } as WeComBotConnectorRuntime<WeComBotAdapter>;
  });
  const active = await entrypoint.create(manifest).start(host(sent));
  await inbound({
    externalConversationId: 'chat-1', providerMessageId: 'provider-1', text: 'voice',
    sender: { id: 'user-1' }, conversation: { type: 'direct' },
    attachments: [{ type: 'audio', platformKey: 'https://private.example/voice|aeskey=secret' }],
  });
  const serialized = JSON.stringify(sent[0]);
  assert.match(serialized, /"reference":"pmr_wecom-bot_/u);
  assert.equal(serialized.includes('private.example'), false);
  assert.equal(serialized.includes('aeskey'), false);
  await active.stop();
});

test('module exposes the declared outbound action and disposes the runtime once', async () => {
  const sent: unknown[] = [];
  let starts = 0;
  let stops = 0;
  const outbound = {
    async sendFormattedReply(...args: unknown[]) { sent.push(args); },
    async sendMedia() {},
    async sendReply() {},
  } as unknown as WeComBotAdapter;
  const entrypoint = createWeComBotPluginModule((options) => {
    assert.deepEqual(options.config, { botId: 'bot', botSecret: 'secret' });
    return {
      outbound,
      async start() { starts += 1; },
      async stop() { stops += 1; },
    } as WeComBotConnectorRuntime<WeComBotAdapter>;
  });
  const active = await entrypoint.create(manifest).start(host());
  await active.actions['wecom-bot.outbound']?.(delivery);
  await Promise.all([active.stop(), active.stop()]);
  assert.equal(starts, 1);
  assert.equal(stops, 1);
  assert.equal(sent.length, 1);
  assert.equal((sent[0] as unknown[])[0], 'chat-1');
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
        { elementId: 'm1', kind: 'media_ref', payload: { type: 'audio', reference: 'hmr_audio-1', fileName: 'voice.amr' } },
        { elementId: 'm2', kind: 'media_ref', payload: { type: 'image', reference: 'hmr_denied' } },
        { elementId: 'm3', kind: 'media_ref', payload: { type: 'file', reference: 'legacy-provider-key' } },
        { elementId: 'm4', kind: 'media_ref', payload: { type: 'video', reference: 'hmr_video-1' } },
        { elementId: 'm5', kind: 'media_ref', payload: { type: 'file', reference: 'hmr_large', fileName: 'large.bin' } },
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
    async sendMedia(chatId: string, payload: Record<string, unknown>) {
      if (payload.fileName === 'large.bin') throw new RangeError('provider limit');
      assert.equal('url' in payload, false);
      assert.equal('absPath' in payload, false);
      assert.ok(payload.content !== undefined);
      const chunks: Buffer[] = [];
      for await (const chunk of payload.content as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
      calls.push({ operation: 'provider.media', value: [chatId, payload.type, Buffer.concat(chunks).toString(), payload.fileName] });
    },
    async sendReply(...args: unknown[]) { calls.push({ operation: 'provider.notice', value: args }); },
  } as unknown as WeComBotAdapter;
  const entrypoint = createWeComBotPluginModule(() => ({ outbound, async start() {}, async stop() {} }) as WeComBotConnectorRuntime<WeComBotAdapter>);
  const host: ModulePluginHostShape = {
    config: { get: async () => 'bot' }, secrets: { get: async () => 'secret' },
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
  await active.actions['wecom-bot.outbound']?.(richDelivery());
  assert.deepEqual(calls, [
    { operation: 'provider.rich', value: ['chat-1', '正文\n\n⚠️ 媒体不可用：diagram.png（来源已过期）\n\n⚠️ 媒体处理警告：转写处理失败', [
      { id: 'b1', kind: 'card', v: 1, title: 'T', bodyMarkdown: 'B' },
      { id: 'b2', kind: 'checklist', v: 1, title: 'L', items: [{ id: 'i1', text: 'a', checked: true }, { id: 'i2', text: 'b' }] },
    ], 'cat-1', undefined] },
    { operation: 'provider.media', value: ['chat-1', 'audio', 'voice-bytes', 'voice.amr'] },
    { operation: 'provider.notice', value: ['chat-1', '⚠️ 媒体不可用（读取或上传失败）'] },
    { operation: 'provider.notice', value: ['chat-1', '⚠️ 媒体不可用（旧引用无法读取）'] },
    { operation: 'provider.notice', value: ['chat-1', '⚠️ 视频附件暂不支持发送'] },
    { operation: 'provider.notice', value: ['chat-1', '⚠️ 媒体过大，超过企业微信发送上限'] },
  ]);
  await active.stop();
});
