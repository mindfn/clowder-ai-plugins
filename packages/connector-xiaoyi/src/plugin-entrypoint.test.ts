import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import { parse } from 'yaml';

import moduleEntrypoint, { createXiaoyiPluginModule } from './plugin-entrypoint.js';
import type { XiaoyiConnectorRuntime } from './runtime.js';
import type { XiaoyiAdapter } from './XiaoyiAdapter.js';

const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')) as unknown;

function host(values: Record<string, unknown>): ModulePluginHostShape {
  return {
    config: { get: async key => values[key] }, secrets: { get: async () => 'sk' },
    storage: {} as never, tasks: {} as never,
    media: { read: async input => ({ offset: input.offset, dataBase64: '', done: true }) },
    threads: { listBindings: async () => [{ key: 'agent:session', threadId: 'thread-1', createdAt: 1 }] } as never,
    messaging: { subscribe: async () => undefined, unsubscribe: async () => undefined, send: async input => ({ messageId: 'message-1', threadId: input.threadId }) },
    log() {},
  };
}

function delivery() {
  return {
    deliveryId: 'delivery-1', threadId: 'thread-1',
    envelope: {
      messageId: 'message-1', revision: 1, threadId: 'thread-1',
      actor: { kind: 'cat', id: '砚砚' }, audience: { kind: 'public' }, occurredAt: '2026-09-22T00:00:00.000Z',
      payload: { provenance: { origin: { kind: 'host' }, epistemicStatus: 'observation' }, elements: [{ elementId: 'text-1', kind: 'text', payload: { text: 'hello' } }] },
    },
  };
}

test('default export is the deterministic package module entrypoint', () => {
  assert.equal(typeof moduleEntrypoint.create, 'function');
  assert.equal(typeof moduleEntrypoint.create(manifest).start, 'function');
});

test('module settles the provider task after the declared outbound action completes', async () => {
  const events: unknown[] = [];
  const outbound = {
    async sendReply(...args: unknown[]) { events.push(['reply', ...args]); },
    async onDeliveryBatchDone(...args: unknown[]) { events.push(['done', ...args]); },
  } as unknown as XiaoyiAdapter;
  const entrypoint = createXiaoyiPluginModule((options) => {
    assert.deepEqual(options.config, { accessKey: 'ak', secretKey: 'sk', agentId: 'agent' });
    return { outbound, async start() {}, async stop() {} } as XiaoyiConnectorRuntime<XiaoyiAdapter>;
  });
  const values: Record<string, unknown> = { accessKey: 'ak', agentId: 'agent' };
  const active = await entrypoint.create(manifest).start(host(values));
  await active.actions['xiaoyi.outbound']?.(delivery());
  assert.deepEqual(events, [
    ['reply', 'agent:session', '砚砚\n\nhello'],
    ['done', 'agent:session', true],
  ]);
  events.length = 0;
  const typedOnly = richDelivery();
  typedOnly.deliveryId = 'delivery-typed-only';
  typedOnly.envelope.payload.elements = typedOnly.envelope.payload.elements.filter(element => (
    element.kind === 'text' || element.kind === 'media_unavailable'
  ));
  await active.actions['xiaoyi.outbound']?.(typedOnly);
  assert.deepEqual(events, [
    ['reply', 'agent:session', 'cat-1\n\n正文\n\n⚠️ 媒体不可用：diagram.png（来源已过期）'],
    ['done', 'agent:session', true],
  ]);
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

test('rich blocks and typed media notices append rendered plaintext blocks before batch done', async () => {
  const events: unknown[] = [];
  const outbound = {
    async sendReply(...args: unknown[]) { events.push(['reply', ...args]); },
    async onDeliveryBatchDone(...args: unknown[]) { events.push(['done', ...args]); },
  } as unknown as XiaoyiAdapter;
  const entrypoint = createXiaoyiPluginModule(() => ({ outbound, async start() {}, async stop() {} }) as XiaoyiConnectorRuntime<XiaoyiAdapter>);
  const values: Record<string, unknown> = { accessKey: 'ak', agentId: 'agent' };
  const active = await entrypoint.create(manifest).start(host(values));
  await active.actions['xiaoyi.outbound']?.(richDelivery());
  assert.deepEqual(events, [
    ['reply', 'agent:session', 'cat-1\n\n正文\n\n⚠️ 媒体不可用：diagram.png（来源已过期）\n\n⚠️ 媒体处理警告：音频（转写处理失败）\n\n📋 T\nB\n\n☑️ L\n✅ a\n☐ b'],
    ['reply', 'agent:session', '⚠️ 这条语音无法在小艺里发送'],
    ['done', 'agent:session', true],
  ]);
});
