import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import { parse } from 'yaml';

import moduleEntrypoint, { createWeComAgentPluginModule } from './plugin-entrypoint.js';
import type { WeComAgentConnectorRuntime } from './runtime.js';
import type { WeComAgentAdapter } from './WeComAgentAdapter.js';

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
  } as unknown as WeComAgentAdapter;
  const entrypoint = createWeComAgentPluginModule(() => ({
    outbound,
    async start() {}, async stop() {},
    async handleWebhook(input) {
      if (input.body === 'invalid') return { kind: 'invalid' } as never;
      return { kind: 'skipped', reason: 'test' };
    },
  } as WeComAgentConnectorRuntime<WeComAgentAdapter>));
  const config: Record<string, unknown> = { corpId: 'corp', agentId: 'agent' };
  const secrets: Record<string, string> = { agentSecret: 'secret', callbackToken: 'token', encodingAesKey: 'aes' };
  const active = await entrypoint.create(manifest).start(host(config, secrets));
  assert.deepEqual(Object.keys(active.actions).sort(), ['wecom-agent.outbound', 'wecom-agent.webhook']);
  const request = {
    method: 'POST', path: 'connectors/wecom-agent', query: {},
    body: '<xml/>', rawBody: Buffer.from('<xml/>'), headers: { 'content-type': 'text/xml' },
  };
  assert.deepEqual(await active.actions['wecom-agent.webhook']?.({ request }), {
    status: 200, headers: {}, body: { ok: true, skipped: 'test' },
  });
  await assert.rejects(async () => active.actions['wecom-agent.webhook']?.({ body: request.body }), /request/u);
  await assert.rejects(async () => active.actions['wecom-agent.webhook']?.({
    request: { ...request, body: 'invalid' },
  }), /invalid result/u);
  await active.stop();
});

test('Host-shaped WeCom GET echostr returns a strict text/plain HTTP challenge', async () => {
  const outbound = { async sendFormattedReply() {}, async sendMedia() {}, async sendReply() {} } as unknown as WeComAgentAdapter;
  const entrypoint = createWeComAgentPluginModule(() => ({
    outbound, async start() {}, async stop() {},
    async handleWebhook(input) {
      assert.deepEqual(input, { body: undefined, query: { echostr: 'encrypted-echo' } });
      return { kind: 'challenge', response: 'decrypted-echo' };
    },
  } as WeComAgentConnectorRuntime<WeComAgentAdapter>));
  const active = await entrypoint.create(manifest).start(host(
    { corpId: 'corp', agentId: 'agent' },
    { agentSecret: 'secret', callbackToken: 'token', encodingAesKey: 'aes' },
  ));
  assert.deepEqual(await active.actions['wecom-agent.webhook']?.({ request: {
    method: 'GET', path: 'connectors/wecom-agent', query: { echostr: 'encrypted-echo' },
    body: undefined, rawBody: Buffer.alloc(0), headers: {},
  } }), { status: 200, headers: { 'content-type': 'text/plain' }, body: 'decrypted-echo' });
  await active.stop();
});

test('replayed WeCom webhook derives the same Host idempotency and source event keys', async () => {
  const sent: Array<{ idempotencyKey: string; sourceEventId?: string }> = [];
  const outbound = { async sendFormattedReply() {}, async sendMedia() {}, async sendReply() {} } as unknown as WeComAgentAdapter;
  const entrypoint = createWeComAgentPluginModule(options => ({
    outbound, async start() {}, async stop() {},
    async handleWebhook(input) {
      assert.deepEqual(input, { body: '<encrypted/>', query: {} });
      await options.host.deliver({
        externalConversationId: 'chat-1', externalSenderId: 'sender-1',
        providerMessageId: 'provider-message-1', text: 'hello',
      });
      return { kind: 'processed', messageId: 'provider-message-1' };
    },
  } as WeComAgentConnectorRuntime<WeComAgentAdapter>));
  const active = await entrypoint.create(manifest).start(host(
    { corpId: 'corp', agentId: 'agent' },
    { agentSecret: 'secret', callbackToken: 'token', encodingAesKey: 'aes' }, sent,
  ));
  const payload = { request: {
    method: 'POST', path: 'connectors/wecom-agent', query: {},
    body: '<encrypted/>', rawBody: Buffer.from('<encrypted/>'), headers: {},
  } };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.deepEqual(await active.actions['wecom-agent.webhook']?.(payload), {
      status: 200, headers: {}, body: { ok: true, messageId: 'provider-message-1' },
    });
  }
  assert.deepEqual(sent, [
    { idempotencyKey: 'provider-message-1', sourceEventId: 'provider-message-1' },
    { idempotencyKey: 'provider-message-1', sourceEventId: 'provider-message-1' },
  ]);
  await active.stop();
});
