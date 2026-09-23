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
): ModulePluginHostShape {
  return {
    config: { get: async key => config[key] },
    secrets: { get: async key => secrets[key] },
    storage: {} as never,
    tasks: {} as never,
    threads: { listBindings: async () => [], ensureByKey: async () => ({ id: 'thread-1' }) } as never,
    messaging: {
      subscribe: async () => undefined, unsubscribe: async () => undefined,
      send: async input => {
        sent.push({ idempotencyKey: input.idempotencyKey, sourceEventId: input.sourceEventId });
        return { messageId: 'message-1', threadId: input.threadId };
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
  assert.deepEqual(Object.keys(active.actions).sort(), ['feishu.outbound', 'feishu.webhook']);
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
  const outbound = { async sendFormattedReply() {}, async sendMedia() {}, async sendReply() {} } as unknown as FeishuAdapter;
  const entrypoint = createFeishuPluginModule(options => ({
    outbound, async start() {}, async stop() {},
    async handleWebhook(input) {
      assert.deepEqual(input, { body: { event: 'same-provider-message' } });
      await options.host.deliver({
        externalConversationId: 'chat-1', providerMessageId: 'provider-message-1', text: 'hello',
        conversation: { type: 'direct' },
      });
      return { kind: 'processed', messageId: 'provider-message-1' };
    },
  } as FeishuConnectorRuntime<FeishuAdapter>));
  const active = await entrypoint.create(manifest).start(host({ appId: 'app' }, { appSecret: 'secret', verificationToken: '' }, sent));
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
  await active.stop();
});
