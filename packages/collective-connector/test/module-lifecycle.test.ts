import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BROWSER_SERVICE_LIMITS, type ModulePluginHostShape, type PluginModuleActivationShape, type BrowserServiceDispatchContext } from '@clowder-ai/plugin-sdk';
import { parse } from 'yaml';
import entrypoint from '../src/plugin-entrypoint.js';
const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8'));
function host(directory: string | undefined): ModulePluginHostShape {
  return { dataDirectory: directory, config: { async get() {} }, secrets: { async get() { return undefined; } },
    storage: {} as never, tasks: {} as never, threads: {} as never, media: {} as never, messaging: {} as never, log() {},
    browserServices: { async getBinding(id) { return { contributionId: id, origin: 'http://127.0.0.1:5271', parentOrigin: 'http://localhost:5172',
      clientBuildId: 'collective-client-v2', assetDigest: 'a'.repeat(64), limits: BROWSER_SERVICE_LIMITS, async assertCurrent() {} }; },
      async dispatchLocal() { throw new Error('Unused fixture local port'); } } };
}
const caller = (lane: 'browser' | 'local'): BrowserServiceDispatchContext => ({ kind: 'http', lane, contributionId: 'collective-client-api',
  requestId: 'fixture-request', signal: new AbortController().signal, async assertCurrent() {} });
async function get(active: PluginModuleActivationShape, path: string, query = '') {
  return await active.actions['collective.http.dispatch']!({ request: { version: 1, method: 'GET', path, rawQuery: query, headers: [], rawBodyBase64: '' } }, undefined, caller('browser')) as { status: number; bodyBase64: string };
}
test('module uses an owned binding with zero listeners; disable revokes handlers and re-enable preserves service identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'collective-module-binding-'));
  const original = Server.prototype.listen; let attempts = 0;
  Server.prototype.listen = function () { attempts++; throw new Error('Package listeners forbidden'); };
  try {
    const plugin = entrypoint.create(manifest); const active = await plugin.start(host(directory));
    const status = (await active.actions['collective.service.status']!({}) as { data: { serviceInstanceId: string; bootstrapNeeded: boolean } }).data;
    assert.equal(status.bootstrapNeeded, true); assert.equal((await stat(join(directory, 'service', 'owner-bootstrap.secret'))).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(status).includes('bootstrap='), false);
    assert.equal((await get(active, '/api/health')).status, 200);
    await assert.rejects(() => get(active, '/'), /admitted/);
    await assert.rejects(async () => active.actions['collective.http.dispatch']!({}), /private browser-service/);
    await Promise.all([active.stop(), active.stop()]); await assert.rejects(() => get(active, '/api/health'), /revoked|stopped/);
    const again = await plugin.start(host(directory));
    try { assert.equal((await again.actions['collective.service.status']!({}) as { data: typeof status }).data.serviceInstanceId, status.serviceInstanceId); }
    finally { await again.stop(); }
    assert.equal(attempts, 0);
  } finally { Server.prototype.listen = original; await rm(directory, { recursive: true, force: true }); }
});
test('missing data/binding authority and stale binding fail before creating service identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'collective-denied-binding-'));
  try {
    await assert.rejects(() => entrypoint.create(manifest).start(host(undefined)), /data directory/);
    const missing = host(directory); delete (missing as { browserServices?: unknown }).browserServices;
    await assert.rejects(() => entrypoint.create(manifest).start(missing), /binding/);
    const stale = host(directory); const original = stale.browserServices!.getBinding;
    stale.browserServices!.getBinding = async id => ({ ...await original(id), async assertCurrent() { throw new Error('binding revoked'); } });
    await assert.rejects(() => entrypoint.create(manifest).start(stale), /revoked/);
    await assert.rejects(readFile(join(directory, 'service', 'collective-service.json')), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('bootstrap write failure acquires no package listener and does not return callable actions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'collective-bootstrap-failure-'));
  try {
    await mkdir(join(directory, 'service', 'owner-bootstrap.url'), { recursive: true });
    await assert.rejects(() => entrypoint.create(manifest).start(host(directory)), /EISDIR|ENOTEMPTY/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
