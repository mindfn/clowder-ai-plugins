import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import { parse } from 'yaml';

import moduleEntrypoint, { createWeixinPluginModule } from './plugin-entrypoint.js';
import type { WeixinConnectorRuntime } from './runtime.js';
import type { WeixinAdapter } from './WeixinAdapter.js';

const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')) as unknown;

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

test('module binds Host-owned state and exposes only its declared outbound action', async () => {
  const writes: unknown[] = [];
  const replies: unknown[] = [];
  let stops = 0;
  const outbound = {
    async sendReply(...args: unknown[]) { replies.push(args); },
    async sendMedia() {},
  } as unknown as WeixinAdapter;
  const entrypoint = createWeixinPluginModule((options) => ({
    outbound,
    async start() {
      await options.state.save({ getUpdatesBuf: 'cursor' });
    },
    async stop() { stops += 1; },
  } as WeixinConnectorRuntime<WeixinAdapter>));
  const values: Record<string, unknown> = {
    voiceItemMode: 'minimal',
    enableUnsafeVoiceModes: false,
    captureInboundVoiceMedia: false,
  };
  const host: ModulePluginHostShape = {
    config: { get: async (key: string) => values[key] },
    secrets: { get: async () => 'token' },
    storage: {
      get: async () => undefined, list: async () => ({}),
      set: async (key: string, value: unknown) => { writes.push([key, value]); return { revision: 1 }; },
      compareAndSet: async () => ({ applied: false }), delete: async () => ({ deleted: false }),
    },
    tasks: {} as never,
    threads: { listBindings: async () => [{ key: 'chat-1', threadId: 'thread-1', createdAt: 1 }] } as never,
    messaging: { subscribe: async () => undefined, unsubscribe: async () => undefined, send: async input => ({ messageId: 'message-1', threadId: input.threadId }) },
    log() {},
  };

  const active = await entrypoint.create(manifest).start(host);
  await active.actions['weixin.outbound']?.(delivery());
  await active.stop();
  assert.deepEqual(writes, [['provider-session', { getUpdatesBuf: 'cursor' }]]);
  assert.deepEqual(replies, [['chat-1', '砚砚\n\nhello']]);
  assert.equal(stops, 1);
});
