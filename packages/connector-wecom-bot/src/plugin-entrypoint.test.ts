import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import { parse } from 'yaml';

import moduleEntrypoint, { createWeComBotPluginModule } from './plugin-entrypoint.js';
import type { WeComBotConnectorRuntime } from './runtime.js';
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

function host(): ModulePluginHostShape {
  return {
    config: { get: async () => 'bot' },
    secrets: { get: async () => 'secret' },
    storage: {} as never,
    tasks: {} as never,
    media: { read: async input => ({ offset: input.offset, dataBase64: '', done: true }) },
    threads: { listBindings: async () => [{ key: 'chat-1', threadId: 'thread-1', createdAt: 1 }] } as never,
    messaging: { subscribe: async () => undefined, unsubscribe: async () => undefined, send: async input => ({ messageId: 'message-1', threadId: input.threadId }) },
    log() {},
  };
}

test('default export is the deterministic package module entrypoint', () => {
  assert.equal(typeof moduleEntrypoint.create, 'function');
  assert.equal(typeof moduleEntrypoint.create(manifest).start, 'function');
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
  } as unknown as WeComBotAdapter;
  const entrypoint = createWeComBotPluginModule(() => ({ outbound, async start() {}, async stop() {} }) as WeComBotConnectorRuntime<WeComBotAdapter>);
  const host: ModulePluginHostShape = {
    config: { get: async () => 'bot' }, secrets: { get: async () => 'secret' },
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
  await active.actions['wecom-bot.outbound']?.(richDelivery());
  assert.deepEqual(calls, [
    { operation: 'provider.rich', value: ['chat-1', '正文\n\n⚠️ 媒体不可用：diagram.png（来源已过期）\n\n⚠️ 媒体处理警告：转写处理失败', [
      { id: 'b1', kind: 'card', v: 1, title: 'T', bodyMarkdown: 'B' },
      { id: 'b2', kind: 'checklist', v: 1, title: 'L', items: [{ id: 'i1', text: 'a', checked: true }, { id: 'i2', text: 'b' }] },
    ], 'cat-1', undefined] },
  ]);
  await active.stop();
});
