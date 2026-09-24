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

test('inbound media is retained as a private locator and exposed through bounded media-source actions', async () => {
  const state = new Map<string, { revision: number; value: unknown }>();
  const sent: unknown[] = [];
  let sendFails = false;
  let inbound!: (message: DingTalkHostInboundMessage) => Promise<void>;
  const outbound = {
    async downloadInboundMedia(locator: { platformKey: string }) {
      assert.equal(locator.platformKey, 'private-download-code');
      return Buffer.from('private-bytes');
    },
  } as unknown as DingTalkAdapter;
  const entrypoint = createDingTalkPluginModule((options) => {
    inbound = options.host.deliver;
    return { outbound, async start() {}, async stop() {} } as DingTalkConnectorRuntime<DingTalkAdapter>;
  });
  const host: ModulePluginHostShape = {
    config: { get: async () => 'app-key' }, secrets: { get: async () => 'app-secret' },
    storage: {
      get: async key => state.get(key),
      list: async () => Object.fromEntries(state),
      set: async (key, value) => { const revision = (state.get(key)?.revision ?? 0) + 1; state.set(key, { revision, value }); return { revision }; },
      compareAndSet: async (key, expectedRevision, value) => {
        if (expectedRevision !== null || state.has(key)) return { applied: false };
        state.set(key, { revision: 1, value });
        return { applied: true, revision: 1 };
      },
      delete: async key => ({ deleted: state.delete(key) }),
    },
    tasks: {} as never,
    media: { read: async input => ({ offset: input.offset, dataBase64: '', done: true }) },
    threads: {
      listBindings: async () => [],
      ensureByKey: async (key: string) => ({ id: 'thread-1', title: key, createdAt: 1, lastActiveAt: 1 }),
    } as never,
    messaging: {
      subscribe: async () => undefined,
      unsubscribe: async () => undefined,
      send: async input => {
        if (sendFails) throw new Error('Host rejected draft');
        sent.push(input);
        return { messageId: 'host-message-1', threadId: input.threadId, revision: 1, messageHandle: 'handle-1', pendingPublication: true as const };
      },
    },
    log() {},
  };

  const active = await entrypoint.create(manifest).start(host);
  await inbound({
    externalConversationId: 'chat-1', providerConversationId: 'provider-chat-1', providerMessageId: 'provider-1', text: 'inbound', chatType: 'group',
    attachments: [{ type: 'image', platformKey: 'private-download-code', fileName: 'photo.png' }],
  });
  const draft = sent[0] as { sourceEventId: string; payload: { elements: Array<{ kind: string; payload: Record<string, unknown> }> } };
  const element = draft.payload.elements.find(item => item.kind === 'media_ref');
  assert.equal(draft.sourceEventId, 'provider-1');
  assert.match(String(element?.payload.reference), /^pmr_/);
  assert.equal(element?.payload.sourceId, 'dingtalk-media');
  assert.equal(JSON.stringify(draft).includes('private-download-code'), false);

  const reference = String(element?.payload.reference);
  const read = await active.actions['dingtalk.media-source.read']?.({ requestId: 'request-1', reference, offset: 0, limit: 7 });
  assert.deepEqual(read, { kind: 'chunk', requestId: 'request-1', offset: 0, dataBase64: Buffer.from('private').toString('base64'), nextOffset: 7, done: false });
  const tail = await active.actions['dingtalk.media-source.read']?.({ requestId: 'request-1', reference, offset: 7, limit: 524288 });
  assert.deepEqual(tail, { kind: 'chunk', requestId: 'request-1', offset: 7, dataBase64: Buffer.from('-bytes').toString('base64'), done: true });
  await active.actions['dingtalk.media-source.settle']?.({ requestId: 'request-1', reference, outcome: 'imported' });
  assert.equal(state.size, 0);
  assert.deepEqual(await active.actions['dingtalk.media-source.read']?.({ requestId: 'request-2', reference, offset: 0, limit: 10 }), {
    kind: 'rejected', requestId: 'request-2', code: 'MEDIA_SOURCE_UNAVAILABLE',
  });
  sendFails = true;
  await assert.rejects(inbound({
    externalConversationId: 'chat-1', providerConversationId: 'provider-chat-1', providerMessageId: 'provider-2', text: 'failed', chatType: 'group',
    attachments: [{ type: 'image', platformKey: 'private-download-code' }],
  }), /Host rejected draft/u);
  assert.equal(state.size, 0);
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
        { elementId: 'm1', kind: 'media_ref', payload: { type: 'audio', reference: 'hmr_audio-1', fileName: 'voice.opus' } },
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
  } as unknown as DingTalkAdapter;
  const entrypoint = createDingTalkPluginModule(() => ({ outbound, async start() {}, async stop() {} }) as DingTalkConnectorRuntime<DingTalkAdapter>);
  const host: ModulePluginHostShape = {
    config: { get: async () => 'app-key' }, secrets: { get: async () => 'app-secret' },
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
  await active.actions['dingtalk.outbound']?.(richDelivery());
  assert.deepEqual(calls, [
    { operation: 'provider.rich', value: ['chat-1', '正文\n\n⚠️ 媒体不可用：diagram.png（来源已过期）\n\n⚠️ 媒体处理警告：转写处理失败', [
      { id: 'b1', kind: 'card', v: 1, title: 'T', bodyMarkdown: 'B' },
      { id: 'b2', kind: 'checklist', v: 1, title: 'L', items: [{ id: 'i1', text: 'a', checked: true }, { id: 'i2', text: 'b' }] },
    ], 'cat-1', undefined] },
    { operation: 'provider.media', value: ['chat-1', 'audio', 'voice-bytes', 'voice.opus'] },
    { operation: 'provider.notice', value: ['chat-1', '⚠️ 媒体不可用（读取或上传失败）'] },
    { operation: 'provider.notice', value: ['chat-1', '⚠️ 媒体不可用（旧引用无法读取）'] },
    { operation: 'provider.notice', value: ['chat-1', '⚠️ 视频附件暂不支持发送'] },
    { operation: 'provider.notice', value: ['chat-1', '⚠️ 媒体过大，超过钉钉发送上限'] },
  ]);
  await active.stop();
});
