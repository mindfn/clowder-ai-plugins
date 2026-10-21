import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const FEISHU = 'connector-feishu';
const SCOPED = {
  'plugin-contract': '@clowder-ai/plugin-contract',
  'plugin-sdk': '@clowder-ai/plugin-sdk',
  [FEISHU]: '@clowder-ai/connector-feishu',
};
const INSTALL_TIMEOUT_MS = 300_000;

async function packOfficialArtifacts(root) {
  const packs = new Map();
  for (const name of Object.keys(SCOPED)) {
    const destination = join(root, 'packs', name);
    await mkdir(destination, { recursive: true });
    const { stdout } = await execFileAsync(process.execPath, [
      join('scripts', 'pack-publish-artifact.mjs'),
      `packages/${name}`,
      destination,
    ], { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 });
    const [artifact] = JSON.parse(stdout);
    const archive = await readFile(join(destination, artifact.filename));
    packs.set(SCOPED[name], {
      archive,
      filename: artifact.filename,
      integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`,
      version: artifact.version,
    });
  }
  return packs;
}

function registryFixture(t, packs) {
  for (const [name, release] of packs) release.urlName = name;
  const server = createServer((request, response) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const packument = [...packs].find(([name]) => request.url === `/${name.replace('/', '%2f')}`);
    if (packument) {
      const [name, release] = packument;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        name,
        'dist-tags': { latest: release.version },
        versions: {
          [release.version]: {
            name,
            version: release.version,
            dist: {
              integrity: release.integrity,
              tarball: `${origin}/${name}/-/${release.filename}`,
            },
          },
        },
      }));
      return;
    }
    const tarball = [...packs].find(([, release]) =>
      request.url === `/${release.urlName}/-/${release.filename}`);
    if (tarball) {
      response.setHeader('content-type', 'application/octet-stream');
      response.end(tarball[1].archive);
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      t.after(async () => {
        await new Promise((done) => server.close(done));
      });
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

async function feishuConsumer(root, registry, packs) {
  const consumer = join(root, 'consumer');
  const source = join(repoRoot, 'packages', FEISHU);
  await mkdir(join(consumer, 'dist'), { recursive: true });
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  delete manifest.devDependencies;
  await writeFile(join(consumer, 'package.json'), JSON.stringify(manifest, null, 2));
  for (const member of ['npm-shrinkwrap.json', 'plugin.yaml', 'assets']) {
    await cp(join(source, member), join(consumer, member), { recursive: true });
  }
  await cp(join(source, 'dist'), join(consumer, 'dist'), { recursive: true });
  const shrinkwrap = JSON.parse(await readFile(join(consumer, 'npm-shrinkwrap.json'), 'utf8'));
  for (const [key, entry] of Object.entries(shrinkwrap.packages)) {
    const pack = packs.get(entry.name ?? key.replace(/^node_modules\//u, ''));
    if (key.startsWith('node_modules/@clowder-ai/') && pack) {
      entry.resolved = `${registry}/${pack.urlName}/-/${pack.filename}`;
    }
  }
  await writeFile(join(consumer, 'npm-shrinkwrap.json'), JSON.stringify(shrinkwrap, null, 2));
  return consumer;
}

async function npmCi(consumer, cacheDir) {
  return execFileAsync('npm', [
    'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error',
    '--cache', cacheDir,
  ], { cwd: consumer, timeout: INSTALL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
}

async function installedVersion(consumer, name) {
  return JSON.parse(await readFile(join(consumer, 'node_modules', name, 'package.json'), 'utf8')).version;
}

test('official feishu artifact installs its full dependency chain through a registry with integrity enforced', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'clowder-feishu-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packs = await packOfficialArtifacts(root);
  const registry = await registryFixture(t, packs);
  const consumer = await feishuConsumer(root, registry, packs);
  // A shared npm cache would serve the original tarball bytes again after the
  // tamper step below, defeating the integrity assertion; isolate per install.
  const caches = [await mkdtemp(join(root, 'npm-cache-a-')), await mkdtemp(join(root, 'npm-cache-b-'))];

  await npmCi(consumer, caches[0]);

  assert.equal(await installedVersion(consumer, '@clowder-ai/plugin-contract'), '0.2.0');
  assert.equal(await installedVersion(consumer, '@clowder-ai/plugin-sdk'), '0.2.0-beta.22');
  const contract = packs.get('@clowder-ai/plugin-contract');
  const shrinkwrap = JSON.parse(await readFile(join(consumer, 'npm-shrinkwrap.json'), 'utf8'));
  assert.equal(
    shrinkwrap.packages['node_modules/@clowder-ai/plugin-contract'].integrity,
    contract.integrity,
    'the registry-served bytes are the official publish artifact pinned by the shrinkwrap',
  );

  const probe = async (script) => execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: consumer, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  });
  await probe(
    "const m = await import('@clowder-ai/plugin-contract/variant');"
    + "if (typeof m.coerceStoredValues !== 'function') throw new Error('variant export missing');",
  );
  const entrypoint = join(consumer, 'dist', 'plugin-entrypoint.js');
  await probe(`const m = await import(${JSON.stringify(entrypoint)});`
    + "if (m.default === undefined) throw new Error('entrypoint default export missing');");

  // Tamper with the served contract bytes while the packument keeps the
  // official integrity: a fresh install must be refused.
  const tampered = Buffer.from(contract.archive);
  tampered[Math.floor(tampered.length / 2)] ^= 0xff;
  packs.get('@clowder-ai/plugin-contract').archive = tampered;
  await rm(join(consumer, 'node_modules'), { recursive: true, force: true });
  await assert.rejects(npmCi(consumer, caches[1]), (error) => {
    const output = `${error.stderr}\n${error.stdout}`;
    assert.match(output, /EINTEGRITY|checksum|integrity failed|code 1/u, output);
    return true;
  });
});
