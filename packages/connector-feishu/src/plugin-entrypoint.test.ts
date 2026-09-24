import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import { parse } from 'yaml';

import moduleEntrypoint, { createFeishuPluginModule } from './plugin-entrypoint.js';
import type { FeishuConnectorRuntime } from './runtime.js';
import type { FeishuAdapter } from './FeishuAdapter.js';

const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')) as unknown;

function host(
  config: Record<string, unknown>,
  secrets: Record<string, string>,
  sent: Array<{ idempotencyKey: string; sourceEventId?: string }> = [],
  drafts: unknown[] = [],
): ModulePluginHostShape {
  const state = new Map<string, { revision: number; value: unknown }>();
  return {
    config: { get: async key => config[key] },
    secrets: { get: async key => secrets[key] },
    storage: {
      get: async key => state.get(key), list: async () => Object.fromEntries(state),
      set: async (key, value) => { const revision = (state.get(key)?.revision ?? 0) + 1; state.set(key, { revision, value }); return { revision }; },
      compareAndSet: async () => ({ applied: false }), delete: async key => ({ deleted: state.delete(key) }),
    },
    tasks: {} as never,
    media: { read: async input => ({ offset: input.offset, dataBase64: '', done: true }) },
    threads: { listBindings: async () => [], ensureByKey: async () => ({ id: 'thread-1' }) } as never,
    messaging: {
      subscribe: async () => undefined, unsubscribe: async () => undefined,
      send: async input => {
        sent.push({ idempotencyKey: input.idempotencyKey, sourceEventId: input.sourceEventId });
        drafts.push(input);
        return { messageId: 'message-1', threadId: input.threadId, revision: 1, messageHandle: 'handle-1', pendingPublication: true as const };
      },
    },
    log() {},
  };
}

test('default export is the deterministic package module entrypoint', () => {
  assert.equal(typeof moduleEntrypoint.create, 'function');
  assert.equal(typeof moduleEntrypoint.create(manifest).start, 'function');
});

test('module exposes both manifest-declared connector and webhook actions', async () => {
  const outbound = {
    async sendFormattedReply() {}, async sendMedia() {}, async sendReply() {},
  } as unknown as FeishuAdapter;
  const entrypoint = createFeishuPluginModule(() => ({
    outbound,
    async start() {}, async stop() {},
    async handleWebhook(input) {
      if ((input.body as { invalid?: boolean } | undefined)?.invalid) return { kind: 'invalid' } as never;
      return { kind: 'skipped', reason: 'test' };
    },
  } as FeishuConnectorRuntime<FeishuAdapter>));
  const config: Record<string, unknown> = { appId: 'app', connectionMode: 'webhook' };
  const secrets: Record<string, string> = { appSecret: 'secret', verificationToken: '' };
  const active = await entrypoint.create(manifest).start(host(config, secrets));
  assert.deepEqual(Object.keys(active.actions).sort(), [
    'feishu.disconnect', 'feishu.media-source.read', 'feishu.media-source.settle', 'feishu.outbound', 'feishu.qr-generate', 'feishu.qr-status', 'feishu.test', 'feishu.webhook',
  ]);
  const request = {
    method: 'POST', path: 'feishu/events', query: {},
    body: { type: 'event_callback' }, rawBody: Buffer.from('{}'), headers: { 'content-type': 'application/json' },
  };
  assert.deepEqual(await active.actions['feishu.webhook']?.({ request }), {
    status: 200, headers: {}, body: { ok: true, skipped: 'test' },
  });
  await assert.rejects(async () => active.actions['feishu.webhook']?.({ body: request.body }), /request/u);
  await assert.rejects(async () => active.actions['feishu.webhook']?.({
    request: { ...request, body: { invalid: true } },
  }), /invalid result/u);
  await active.stop();
});

test('Host-shaped Feishu URL verification returns a strict HTTP challenge', async () => {
  const outbound = { async sendFormattedReply() {}, async sendMedia() {}, async sendReply() {} } as unknown as FeishuAdapter;
  const entrypoint = createFeishuPluginModule(() => ({
    outbound, async start() {}, async stop() {},
    async handleWebhook(input) {
      assert.deepEqual(input, { body: { type: 'url_verification', challenge: 'proof' } });
      return { kind: 'challenge', response: { challenge: 'proof' } };
    },
  } as FeishuConnectorRuntime<FeishuAdapter>));
  const active = await entrypoint.create(manifest).start(host({ appId: 'app' }, { appSecret: 'secret', verificationToken: '' }));
  assert.deepEqual(await active.actions['feishu.webhook']?.({ request: {
    method: 'POST', path: 'feishu/events', query: {},
    body: { type: 'url_verification', challenge: 'proof' }, rawBody: Buffer.from('{}'), headers: {},
  } }), { status: 200, headers: {}, body: { challenge: 'proof' } });
  await active.stop();
});

test('replayed Feishu webhook derives the same Host idempotency and source event keys', async () => {
  const sent: Array<{ idempotencyKey: string; sourceEventId?: string }> = [];
  const drafts: unknown[] = [];
  const outbound = { async sendFormattedReply() {}, async sendMedia() {}, async sendReply() {} } as unknown as FeishuAdapter;
  const entrypoint = createFeishuPluginModule(options => ({
    outbound, async start() {}, async stop() {},
    async handleWebhook(input) {
      assert.deepEqual(input, { body: { event: 'same-provider-message' } });
      await options.host.deliver({
        externalConversationId: 'chat-1', providerMessageId: 'provider-message-1', text: 'hello',
        attachments: [{ type: 'image', platformKey: 'private-image-key' }],
        conversation: { type: 'direct' },
      });
      return { kind: 'processed', messageId: 'provider-message-1' };
    },
  } as FeishuConnectorRuntime<FeishuAdapter>));
  const active = await entrypoint.create(manifest).start(host({ appId: 'app' }, { appSecret: 'secret', verificationToken: '' }, sent, drafts));
  const payload = { request: {
    method: 'POST', path: 'feishu/events', query: {},
    body: { event: 'same-provider-message' }, rawBody: Buffer.from('{}'), headers: {},
  } };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.deepEqual(await active.actions['feishu.webhook']?.(payload), {
      status: 200, headers: {}, body: { ok: true, messageId: 'provider-message-1' },
    });
  }
  assert.deepEqual(sent, [
    { idempotencyKey: 'provider-message-1', sourceEventId: 'provider-message-1' },
    { idempotencyKey: 'provider-message-1', sourceEventId: 'provider-message-1' },
  ]);
  const serialized = JSON.stringify(drafts);
  assert.equal(serialized.includes('private-image-key'), false);
  assert.equal(drafts.every((item) => /"reference":"pmr_feishu_/u.test(JSON.stringify(item))), true);
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
  } as unknown as FeishuAdapter;
  const entrypoint = createFeishuPluginModule(() => ({ outbound, async start() {}, async stop() {} }) as FeishuConnectorRuntime<FeishuAdapter>);
  const host: ModulePluginHostShape = {
    config: { get: async key => (key === 'appId' ? 'app' : undefined) }, secrets: { get: async () => 'secret' },
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
  await active.actions['feishu.outbound']?.(richDelivery());
  assert.deepEqual(calls, [
    { operation: 'provider.rich', value: ['chat-1', '正文\n\n⚠️ 媒体不可用：diagram.png（来源已过期）\n\n⚠️ 媒体处理警告：转写处理失败', [
      { id: 'b1', kind: 'card', v: 1, title: 'T', bodyMarkdown: 'B' },
      { id: 'b2', kind: 'checklist', v: 1, title: 'L', items: [{ id: 'i1', text: 'a', checked: true }, { id: 'i2', text: 'b' }] },
    ], 'cat-1', undefined] },
    { operation: 'provider.media', value: ['chat-1', 'audio', 'voice-bytes', 'voice.opus'] },
    { operation: 'provider.notice', value: ['chat-1', '⚠️ 媒体不可用（读取或上传失败）'] },
    { operation: 'provider.notice', value: ['chat-1', '⚠️ 媒体不可用（旧引用无法读取）'] },
    { operation: 'provider.notice', value: ['chat-1', '⚠️ 视频附件暂不支持发送'] },
    { operation: 'provider.notice', value: ['chat-1', '⚠️ 媒体过大，超过飞书发送上限'] },
  ]);
  await active.stop();
});
