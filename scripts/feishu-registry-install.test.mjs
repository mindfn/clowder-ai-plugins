import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';

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
    const path = join(destination, artifact.filename);
    const archive = await readFile(path);
    packs.set(SCOPED[name], {
      archive,
      filename: artifact.filename,
      integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`,
      path,
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
  // The consumer is the UNPACKED publish artifact — not a copy of the worktree —
  // so the install chain under test is exactly what a Host would receive.
  const release = packs.get(SCOPED[FEISHU]);
  const consumer = join(root, 'consumer');
  await mkdir(consumer, { recursive: true });
  await execFileAsync('tar', ['-xzf', release.path, '-C', consumer], { timeout: 60_000 });
  const packageRoot = join(consumer, 'package');
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  // The published devDependencies are not part of the shrinkwrap; dropping them
  // is the consumer install context only — the artifact bytes stay untouched.
  delete manifest.devDependencies;
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify(manifest, null, 2));
  const shrinkwrap = JSON.parse(await readFile(join(packageRoot, 'npm-shrinkwrap.json'), 'utf8'));
  for (const [key, entry] of Object.entries(shrinkwrap.packages)) {
    const pack = packs.get(entry.name ?? key.replace(/^node_modules\//u, ''));
    if (key.startsWith('node_modules/@clowder-ai/') && pack) {
      entry.resolved = `${registry}/${pack.urlName}/-/${pack.filename}`;
    }
  }
  await writeFile(join(packageRoot, 'npm-shrinkwrap.json'), JSON.stringify(shrinkwrap, null, 2));
  return packageRoot;
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

  const probe = async (script, ...args) => execFileAsync(process.execPath, ['--input-type=module', '-e', script, ...args], {
    cwd: consumer, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  });
  // The manifest under test is the one shipped inside the artifact; the probe
  // itself runs only against installed dependencies.
  const manifestJson = join(root, 'manifest.json');
  await writeFile(manifestJson, JSON.stringify(parseYaml(await readFile(join(consumer, 'plugin.yaml'), 'utf8'))));
  await probe(
    "const m = await import('@clowder-ai/plugin-contract/variant');"
    + "if (typeof m.coerceStoredValues !== 'function') throw new Error('variant export missing');",
  );
  const entrypoint = join(consumer, 'dist', 'plugin-entrypoint.js');
  await probe(
    "const [manifestPath, entrypointPath] = process.argv.slice(1);"
    + "const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(manifestPath, 'utf8'));"
    + "const contract = await import('@clowder-ai/plugin-contract');"
    + "const validation = contract.validateManifest(manifest);"
    + "if (!validation.valid) throw new Error('manifest rejected: ' + JSON.stringify(validation.errors));"
    + "const m = await import(entrypointPath);"
    + "const plugin = m.default.create(validation.manifest);"
    + "if (typeof plugin.start !== 'function') throw new Error('start missing');"
    + "if (typeof plugin.settings !== 'function') throw new Error('settings missing');",
    manifestJson,
    entrypoint,
  );

  // Tamper with the served contract bytes while the packument keeps the
  // official integrity: a fresh install must be refused.
  const tampered = Buffer.from(contract.archive);
  tampered[Math.floor(tampered.length / 2)] ^= 0xff;
  packs.get('@clowder-ai/plugin-contract').archive = tampered;
  await rm(join(consumer, 'node_modules'), { recursive: true, force: true });
  await assert.rejects(npmCi(consumer, caches[1]), (error) => {
    const output = `${error.stderr}\n${error.stdout}`;
    assert.match(output, /EINTEGRITY/u, output);
    return true;
  });
});
