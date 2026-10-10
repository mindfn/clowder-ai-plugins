import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import { parse } from 'yaml';
import entrypoint, { createCollectivePluginModule } from '../src/plugin-entrypoint.js';
import { startCollectiveServer, type RunningCollectiveServer } from '../src/business/service/http-server.js';

const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8'));
function host(directory: string | undefined, config: Record<string, unknown> = {}): ModulePluginHostShape {
  return {
    dataDirectory: directory,
    config: { async get(key) { return config[key]; } },
    secrets: { async get() { return undefined; } },
    storage: {} as never, tasks: {} as never, threads: {} as never,
    media: {} as never, messaging: {} as never, log() {},
  };
}
async function listen(server: Server, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}
async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test('real module owns listener; disable closes it, revokes status, and re-enable preserves state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'collective-module-'));
  try {
    const plugin = entrypoint.create(manifest);
    const active = await plugin.start(host(directory, { servicePort: 0 }));
    const receipt = await active.actions['collective.service.status']!({});
    const status = (receipt as { data: unknown }).data;
    const value = status as { url: string; serviceInstanceId: string; bootstrapNeeded: boolean };
    assert.equal(value.bootstrapNeeded, true);
    assert.equal((await stat(join(directory, 'service', 'owner-bootstrap.secret'))).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(status).includes('bootstrap='), false, 'status never exposes bootstrap credential');
    const health = await fetch(value.url + '/api/health');
    assert.equal(health.status, 200);
    assert.equal((await health.json() as { serviceInstanceId: string }).serviceInstanceId, value.serviceInstanceId);
    const unavailable = await fetch(value.url + '/');
    assert.equal(unavailable.status, 404, 'backend does not impersonate retained C2 assets');
    await Promise.all([active.stop(), active.stop()]);
    await assert.rejects(async () => active.actions['collective.service.status']!({}), /revoked|stopped/);
    const port = Number(new URL(value.url).port);
    const probe = createServer();
    await listen(probe, port); await close(probe);
    const again = await plugin.start(host(directory, { servicePort: 0 }));
    try {
      assert.equal((await again.actions['collective.service.status']!({}) as { data: typeof value }).data.serviceInstanceId, value.serviceInstanceId);
    } finally { await again.stop(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('missing data authority and invalid/reserved ports fail before opening service state', async () => {
  await assert.rejects(() => entrypoint.create(manifest).start(host(undefined, { servicePort: 0 })), /data directory/i);
  const directory = await mkdtemp(join(tmpdir(), 'collective-denial-'));
  try {
    for (const servicePort of [3001, 3002, -1, 65536, '0', 1.5]) {
      await assert.rejects(() => entrypoint.create(manifest).start(host(directory, { servicePort })), /port/i);
    }
    for (const publicUrl of ['ftp://localhost', 'http://remote.example', 'https://user:pass@example.com', 'not a URL']) {
      await assert.rejects(() => entrypoint.create(manifest).start(host(directory, { servicePort: 0, publicUrl })));
    }
    await assert.rejects(() => entrypoint.create(manifest).start(host(directory, { servicePort: 0, allowedHostOrigins: 42 })), /allowedHostOrigins/);
    await assert.rejects(readFile(join(directory, 'service', 'collective-service.json')), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('post-listen bootstrap failure closes the acquired listener before start rejects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'collective-start-failure-'));
  const probe = createServer(); const port = await listen(probe); await close(probe);
  await mkdir(join(directory, 'service', 'owner-bootstrap.url'), { recursive: true });
  let acquired: RunningCollectiveServer | undefined;
  const module = createCollectivePluginModule({ async startServer(options) { acquired = await startCollectiveServer(options); return acquired; } });
  try {
    await assert.rejects(() => module.create(manifest).start(host(directory, { servicePort: port })), /EEXIST|EISDIR|ENOTEMPTY/);
    assert.equal(acquired?.server.listening, false, 'failed activation must release its real listener');
    const failedState = JSON.parse(await readFile(join(directory, 'service', 'collective-service.json'), 'utf8')) as { serviceInstanceId: string };
    const recovered = createServer();
    await listen(recovered, port); await close(recovered);
    await rm(join(directory, 'service', 'owner-bootstrap.url'), { recursive: true });
    const retry = await entrypoint.create(manifest).start(host(directory, { servicePort: 0 }));
    try {
      const value = (await retry.actions['collective.service.status']!({}) as { data: { url: string; serviceInstanceId: string } }).data;
      assert.equal(value.serviceInstanceId, failedState.serviceInstanceId, 'retry must preserve the failed start state');
      const link = new URL((await readFile(join(directory, 'service', 'owner-bootstrap.url'), 'utf8')).trim());
      const secret = new URLSearchParams(link.hash.slice(1)).get('bootstrap');
      assert.ok(secret, 'retry must recover the unclaimed owner credential');
      const response = await fetch(value.url + '/api/bootstrap', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret, displayName: 'Recovery owner' }),
      });
      assert.equal(response.status, 201);
    } finally { await retry.stop(); }
  } finally { await acquired?.close(); await rm(directory, { recursive: true, force: true }); }
});
