import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import { parse } from 'yaml';

import { createFeishuPluginModule } from './plugin-entrypoint.js';
import { createFeishuConnectorRuntime, type FeishuConnectorRuntime } from './runtime.js';
import type { FeishuAdapter } from './FeishuAdapter.js';
import type { FeishuQrBindClient, FeishuQrPollResult } from './FeishuQrBindClient.js';
import type { ConnectorLogger } from './types.js';

const logger: ConnectorLogger = { info() {}, warn() {}, error() {}, debug() {} };
const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')) as unknown;

/** Mirrors the Host key allowlist in plugin-operation-routes.ts (operationResult). */
const ALLOWED_RESULT_KEYS = new Set(['render', 'data', 'label', 'targetValues', 'advance', 'activate']);
function assertOperationResultShape(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  assert.ok(
    Object.keys(value).every((key) => ALLOWED_RESULT_KEYS.has(key)),
    `operation result contains a key outside the Host allowlist: ${Object.keys(value).join(',')}`,
  );
  assert.equal(typeof (value as { render?: unknown }).render, 'string');
  assert.ok(Object.hasOwn(value, 'data'));
}

function hostShape(config: Record<string, unknown>, secrets: Record<string, string>): ModulePluginHostShape {
  return {
    config: { get: async (key: string) => config[key] },
    secrets: { get: async (key: string) => secrets[key] },
    storage: {} as never,
    tasks: {} as never,
    threads: { listBindings: async () => [], ensureByKey: async (key: string) => ({ id: 'thread-1', title: key }) } as never,
    messaging: {
      subscribe: async () => undefined, unsubscribe: async () => undefined,
      send: async (input: { threadId: string }) => ({ messageId: 'm-1', threadId: input.threadId }),
    },
    log() {},
  };
}

function runtimeFake() {
  const calls: { connect?: unknown[]; disconnect?: unknown[] } = {};
  let connected = false;
  const runtime = {
    get outbound() {
      if (!connected) throw new Error('Feishu connector is not configured');
      return {};
    },
    async start() {},
    async stop() { connected = false; },
    async connect(config: unknown) { calls.connect = [config]; connected = true; },
    async disconnect() { calls.disconnect = []; connected = false; },
    isConnected() { return connected; },
  } as unknown as FeishuConnectorRuntime<FeishuAdapter>;
  return { runtime, calls };
}

function qrClientFake(pollResults: FeishuQrPollResult[]): { client: FeishuQrBindClient; polls: string[] } {
  const polls: string[] = [];
  let index = 0;
  return {
    polls,
    client: {
      async create() {
        return { qrUrl: 'data:image/png;base64,aGVsbG8=', qrPayload: 'device-1' };
      },
      async poll(qrPayload: string) {
        polls.push(qrPayload);
        const result = pollResults[Math.min(index, pollResults.length - 1)];
        index += 1;
        return result;
      },
    },
  };
}

async function activate(
  config: Record<string, unknown>,
  secrets: Record<string, string>,
  pollResults: FeishuQrPollResult[],
) {
  const fake = runtimeFake();
  const qr = qrClientFake(pollResults);
  const entrypoint = createFeishuPluginModule(() => fake.runtime, () => qr.client);
  const active = await entrypoint.create(manifest).start(hostShape(config, secrets));
  return { active, fake, qr };
}

const CONFIRMED: FeishuQrPollResult = { status: 'confirmed', appId: 'app-1', appSecret: 'secret-1' };

test('qr-generate returns the client PNG data URL and keeps the device code in runtime memory', async () => {
  const { active, qr } = await activate({ connectionMode: 'websocket' }, {}, [{ status: 'waiting' }]);
  const result = await active.actions['feishu.qr-generate']?.({});
  assertOperationResultShape(result);
  assert.deepEqual(result, { render: 'img', data: { url: 'data:image/png;base64,aGVsbG8=' } });
  await active.actions['feishu.qr-status']?.({});
  assert.deepEqual(qr.polls, ['device-1'], 'qr-status must poll with the device code from qr-generate');
  await active.stop();
});

test('qr-status without an in-flight payload is a terminal polling error', async () => {
  const { active } = await activate({ connectionMode: 'websocket' }, {}, []);
  const result = await active.actions['feishu.qr-status']?.({});
  assertOperationResultShape(result);
  assert.deepEqual(result, { render: 'polling', data: { status: 'error', message: 'No QR payload — generate first' }, advance: false });
  await active.stop();
});

test('qr-status waiting continues polling without advancing', async () => {
  const { active } = await activate({ connectionMode: 'websocket' }, {}, [{ status: 'waiting' }]);
  await active.actions['feishu.qr-generate']?.({});
  const result = await active.actions['feishu.qr-status']?.({});
  assertOperationResultShape(result);
  assert.deepEqual(result, { render: 'polling', data: { status: 'waiting' }, advance: false });
  await active.stop();
});

test('qr-status expired/denied/error are terminal with the provider error preserved', async () => {
  const cases: Array<[FeishuQrPollResult, Record<string, unknown>]> = [
    [{ status: 'expired' }, { render: 'polling', data: { status: 'expired' }, advance: false }],
    [{ status: 'denied' }, { render: 'polling', data: { status: 'denied' }, advance: false }],
    [{ status: 'error', error: 'provider boom' }, { render: 'polling', data: { status: 'error', message: 'provider boom' }, advance: false }],
  ];
  for (const [pollResult, expected] of cases) {
    const { active } = await activate({ connectionMode: 'websocket' }, {}, [pollResult]);
    await active.actions['feishu.qr-generate']?.({});
    const result = await active.actions['feishu.qr-status']?.({});
    assertOperationResultShape(result);
    assert.deepEqual(result, expected);
    await active.stop();
  }
});

test('qr-status confirmed connects in-process and writes all three operation target values', async () => {
  const { active, fake } = await activate({ connectionMode: 'websocket' }, {}, [CONFIRMED]);
  await active.actions['feishu.qr-generate']?.({});
  const result = await active.actions['feishu.qr-status']?.({});
  assertOperationResultShape(result);
  assert.deepEqual(result, {
    render: 'status',
    data: { status: 'confirmed' },
    label: '已授权',
    targetValues: { appId: 'app-1', appSecret: 'secret-1', connectionMode: 'websocket' },
  });
  assert.deepEqual(fake.calls.connect, [{ appId: 'app-1', appSecret: 'secret-1', connectionMode: 'websocket' }],
    'confirmed must establish the connection in-process');
  await active.stop();
});

test('qr-status confirmed without credentials is a terminal polling error', async () => {
  const { active } = await activate({ connectionMode: 'websocket' }, {}, [{ status: 'confirmed' }]);
  await active.actions['feishu.qr-generate']?.({});
  const result = await active.actions['feishu.qr-status']?.({});
  assertOperationResultShape(result);
  assert.deepEqual(result, { render: 'polling', data: { status: 'error', message: 'confirmed but no credentials' }, advance: false });
  await active.stop();
});

test('disconnect tears down in-process and clears only the credential target values', async () => {
  const { active, fake } = await activate({ connectionMode: 'websocket' }, {}, []);
  const result = await active.actions['feishu.disconnect']?.({});
  assertOperationResultShape(result);
  assert.deepEqual(result, {
    render: 'status',
    data: { status: 'disconnected' },
    label: '已断开',
    targetValues: { appId: '', appSecret: '' },
  });
  assert.ok(fake.calls.disconnect, 'disconnect must tear down the connection in-process');
  await active.stop();
});

test('test action: websocket mode reports the live connection state', async () => {
  const { active, fake } = await activate({ connectionMode: 'websocket' }, {}, []);
  assert.deepEqual(await active.actions['feishu.test']?.({}), { ok: false, message: '飞书未配置或凭据无效' });
  await fake.runtime.connect({ appId: 'app-1', appSecret: 'secret-1', connectionMode: 'websocket' });
  assert.deepEqual(await active.actions['feishu.test']?.({}), { ok: true });
  await active.stop();
});

test('test action: webhook mode checks fresh credentials including the verification token', async () => {
  const { active } = await activate(
    { appId: 'app-1', connectionMode: 'webhook' },
    { appSecret: 'secret-1', verificationToken: 'token-1' },
    [],
  );
  assert.deepEqual(await active.actions['feishu.test']?.({}), { ok: true });
  const missing = await activate({ appId: 'app-1', connectionMode: 'webhook' }, { appSecret: 'secret-1', verificationToken: '' }, []);
  assert.deepEqual(await missing.active.actions['feishu.test']?.({}), { ok: false, message: '飞书未配置或凭据无效' });
  await active.stop();
  await missing.active.stop();
});

test('runtime starts idle without credentials, connects in-process via connect(), outbound getter guards sends', async () => {
  const adapterCalls: string[] = [];
  const fakeAdapter = { connectorId: 'feishu' } as unknown as FeishuAdapter;
  const wsStarts: string[] = [];
  const runtime = createFeishuConnectorRuntime({
    config: { appId: '', appSecret: '', connectionMode: 'websocket' },
    logger,
    host: { deliver: async () => {} },
    createAdapter: (appId, appSecret) => { adapterCalls.push(`${appId}:${appSecret}`); return fakeAdapter; },
    createWsClient: ({ appId, appSecret }) => ({
      start: async () => { wsStarts.push(`${appId}:${appSecret}`); },
      close: () => {},
    }),
  });
  await runtime.start();
  assert.deepEqual(adapterCalls, [], 'idle start must not build a provider adapter');
  assert.throws(() => runtime.outbound, /not configured|QR/i);
  assert.equal(runtime.isConnected(), false);
  await runtime.connect({ appId: 'app-1', appSecret: 'secret-1', connectionMode: 'websocket' });
  assert.deepEqual(adapterCalls, ['app-1:secret-1'], 'connect must rebuild the provider adapter in-process');
  assert.deepEqual(wsStarts, ['app-1:secret-1'], 'connect must start ingress with the new credentials');
  assert.equal(runtime.outbound, fakeAdapter);
  await runtime.disconnect();
  assert.equal(runtime.isConnected(), false);
  assert.equal(runtime.outbound, fakeAdapter, 'disconnect keeps the configured adapter (only ingress stops)');
  await runtime.stop();
});
