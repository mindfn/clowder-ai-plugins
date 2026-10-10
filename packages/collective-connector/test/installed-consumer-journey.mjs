import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateManifest } from '@clowder-ai/plugin-contract';
import { requirePluginModuleEntrypoint } from '@clowder-ai/plugin-sdk';
import module from '@clowder-ai/collective-connector';

const consumer = process.cwd();
const packageRoot = join(consumer, 'node_modules/@clowder-ai/collective-connector');
assert.equal((await lstat(packageRoot)).isSymbolicLink(), false, 'directory installation must materialize the package');
for (const name of ['collective-connector', 'plugin-sdk', 'plugin-contract']) {
  const resolved = await realpath(fileURLToPath(import.meta.resolve('@clowder-ai/' + name)));
  assert.ok(!relative(consumer, resolved).startsWith('..'), 'dependency must resolve inside the empty consumer: ' + name);
}
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const validated = validateManifest(manifest);
assert.equal(validated.valid, true, JSON.stringify(validated.errors));
assert.equal(manifest.runtime.transport, 'builtin');
const namespace = await import(pathToFileURL(join(packageRoot, manifest.runtime.entrypoint)).href);
const entrypoint = requirePluginModuleEntrypoint(namespace.default);
assert.equal(module, namespace.default, 'public export must identify the same installed module');
async function importTree(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) await importTree(path);
    else if (item.name.endsWith('.js')) await import(pathToFileURL(path).href);
  }
}
await importTree(join(packageRoot, 'dist'));
await assert.rejects(stat(join(packageRoot, 'dist/business/service/cli.js')), { code: 'ENOENT' });
const directory = await mkdtemp(join(tmpdir(), 'installed-collective-data-'));
const host = {
  dataDirectory: directory,
  config: { async get(key) { return key === 'servicePort' ? 0 : undefined; } },
  secrets: { async get() { return undefined; } },
  storage: {}, tasks: {}, threads: {}, media: {}, messaging: {}, log() {},
};
let active;
try {
  const plugin = entrypoint.create(manifest);
  active = await plugin.start(host);
  const status = (await active.actions['collective.service.status']({})).data;
  const base = status.url;
  assert.equal((await fetch(base + '/api/health')).status, 200);
  assert.equal((await fetch(base + '/')).status, 404, 'C2 UI is retained in Host');
  const linkPath = join(directory, 'service/owner-bootstrap.url');
  assert.equal((await stat(linkPath)).mode & 0o777, 0o600);
  const link = new URL((await readFile(linkPath, 'utf8')).trim());
  const secret = new URLSearchParams(link.hash.slice(1)).get('bootstrap');
  assert.ok(secret);
  const response = await fetch(base + '/api/bootstrap', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret, displayName: 'Isolated installed owner' }),
  });
  assert.equal(response.status, 201);
  const owner = await response.json();
  const created = await fetch(base + '/api/collectives', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + owner.sessionToken },
    body: JSON.stringify({ name: 'Installed lifecycle proof' }),
  });
  assert.equal(created.status, 201);
  const collective = await created.json();
  await active.stop();
  await assert.rejects(async () => active.actions['collective.service.status']({}), /revoked|stopped/);
  await assert.rejects(readFile(join(directory, 'service/owner-bootstrap.secret')), { code: 'ENOENT' });
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject); probe.listen(Number(new URL(base).port), '127.0.0.1', resolve);
  });
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  active = await plugin.start(host);
  const resumed = (await active.actions['collective.service.status']({})).data;
  assert.equal(resumed.serviceInstanceId, status.serviceInstanceId);
  assert.equal(resumed.bootstrapNeeded, false);
  const state = JSON.parse(await readFile(join(directory, 'service/collective-service.json'), 'utf8'));
  assert.equal(state.collectives[collective.collectiveId].name, collective.name);
  await assert.rejects(readFile(linkPath), { code: 'ENOENT' });
  console.log(JSON.stringify({ result: 'PASS', installedDirectory: true, physicalDependencyClosure: true,
    manifest: 'valid', lifecycle: 'start/bootstrap/create/disable/re-enable', statePreserved: true,
    reservedPortsUsed: false, retainedC2: true, oldCliExcluded: true }));
} finally {
  await active?.stop();
  await rm(directory, { recursive: true, force: true });
}
