import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import { parse } from 'yaml';

import moduleEntrypoint, { createWeComAgentPluginModule } from './plugin-entrypoint.js';
import type { WeComAgentConnectorRuntime } from './runtime.js';
import type { WeComAgentAdapter } from './WeComAgentAdapter.js';

const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')) as unknown;

function host(config: Record<string, unknown>, secrets: Record<string, string>): ModulePluginHostShape {
  return {
    config: { get: async key => config[key] },
    secrets: { get: async key => secrets[key] },
    storage: {} as never,
    tasks: {} as never,
    threads: { listBindings: async () => [] } as never,
    messaging: { subscribe: async () => undefined, unsubscribe: async () => undefined, send: async input => ({ messageId: 'message-1', threadId: input.threadId }) },
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
    async handleWebhook() { return { kind: 'skipped', reason: 'test' }; },
  } as WeComAgentConnectorRuntime<WeComAgentAdapter>));
  const config: Record<string, unknown> = { corpId: 'corp', agentId: 'agent' };
  const secrets: Record<string, string> = { agentSecret: 'secret', callbackToken: 'token', encodingAesKey: 'aes' };
  const active = await entrypoint.create(manifest).start(host(config, secrets));
  assert.deepEqual(Object.keys(active.actions).sort(), ['wecom-agent.outbound', 'wecom-agent.webhook']);
  assert.deepEqual(await active.actions['wecom-agent.webhook']?.({}), { kind: 'skipped', reason: 'test' });
  await active.stop();
});
