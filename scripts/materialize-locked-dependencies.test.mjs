import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import test from 'node:test';
import { stringify } from 'yaml';

import { materializeLockedDependencies } from './materialize-locked-dependencies.mjs';

const copyPublishPackage = (source, destination) => cp(source, destination, {
  recursive: true, filter: path => !relative(source, path).split(sep).includes('node_modules'),
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'clowder-locked-bundle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'packages/app');
  const stage = join(root, 'stage');
  await mkdir(source, { recursive: true });
  await mkdir(stage);
  const manifest = { name: 'app', version: '1.0.0', dependencies: { a: '1.0.0', b: '1.0.0' } };
  await writeFile(join(source, 'package.json'), JSON.stringify(manifest));
  await writeFile(join(stage, 'package.json'), JSON.stringify(manifest));
  const lock = { importers: { 'packages/app': { dependencies: {
    a: { specifier: '1.0.0', version: '1.0.0' }, b: { specifier: '1.0.0', version: '1.0.0' },
  } } }, snapshots: {
    'a@1.0.0': { dependencies: { c: '1.0.0', peer: '1.0.0' } },
    'b@1.0.0': { dependencies: { c: '2.0.0' } },
    'c@1.0.0': { dependencies: { a: '1.0.0' } },
    'c@2.0.0': {}, 'peer@1.0.0': {},
  } };
  const packages = {};
  for (const key of Object.keys(lock.snapshots)) {
    const [name, version] = key.split('@');
    const directory = join(root, 'node_modules/.pnpm', key, 'node_modules', name);
    packages[key] = directory;
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'package.json'), JSON.stringify({
      name, version, dependencies: name === 'a' ? { c: '^1.0.0' } :
        Object.fromEntries(Object.entries(lock.snapshots[key].dependencies ?? {}).map(([n, v]) => [n, `^${v}`])),
      ...(name === 'a' ? { peerDependencies: { peer: '^1.0.0' } } : {}),
    }));
    await writeFile(join(directory, 'index.js'), `module.exports = ${JSON.stringify(version)};`);
  }
  async function link(parent, name, target) {
    const directory = join(parent, 'node_modules');
    await mkdir(directory, { recursive: true });
    await symlink(target, join(directory, name));
  }
  for (const name of ['a', 'b']) await link(source, name, packages[`${name}@1.0.0`]);
  for (const [key, snapshot] of Object.entries(lock.snapshots)) {
    for (const [name, version] of Object.entries(snapshot.dependencies ?? {}))
      await link(packages[key], name, packages[`${name}@${version}`]);
  }
  await writeFile(join(root, 'pnpm-lock.yaml'), stringify(lock));
  return { root, source, stage, packages, lock };
}

test('materializes locked cycles, peer edges and conflicting versions without registry metadata', async t => {
  const f = await fixture(t);
  await materializeLockedDependencies({ repoRoot: f.root, packageRoot: f.source, destination: f.stage, copyPublishPackage });
  const read = async path => JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
  assert.equal((await read(join(f.stage, 'node_modules/c'))).version, '1.0.0');
  assert.equal((await read(join(f.stage, 'node_modules/b/node_modules/c'))).version, '2.0.0');
  assert.equal((await read(join(f.stage, 'node_modules/peer'))).version, '1.0.0');
  // The optional package manager/cache is entirely absent in this fixture.
  const { createRequire } = await import('node:module');
  const requireA = createRequire(join(f.stage, 'node_modules/a/index.js'));
  const requireB = createRequire(join(f.stage, 'node_modules/b/index.js'));
  assert.equal(requireA('c'), '1.0.0');
  assert.equal(requireB('c'), '2.0.0');
  assert.equal(requireA('peer'), '1.0.0');
});

test('rejects an installed dependency that disagrees with the frozen lock', async t => {
  const f = await fixture(t);
  await writeFile(join(f.packages['c@2.0.0'], 'package.json'), JSON.stringify({ name: 'c', version: '2.1.0' }));
  await assert.rejects(materializeLockedDependencies({ repoRoot: f.root, packageRoot: f.source,
    destination: f.stage, copyPublishPackage }), /locked identity mismatch/u);
});

test('refuses missing required indirect dependencies before copying', async t => {
  const f = await fixture(t);
  await rm(join(f.packages['a@1.0.0'], 'node_modules/peer'));
  await assert.rejects(materializeLockedDependencies({ repoRoot: f.root, packageRoot: f.source,
    destination: f.stage, copyPublishPackage }), /missing locked dependency peer/u);
});

test('omits development and absent optional packages while retaining all required edges', async t => {
  const f = await fixture(t);
  f.lock.importers['packages/app'].devDependencies = { development: { specifier: '1.0.0', version: '1.0.0' } };
  f.lock.snapshots['a@1.0.0'].optionalDependencies = { optional: '1.0.0' };
  await writeFile(join(f.root, 'pnpm-lock.yaml'), stringify(f.lock));
  await materializeLockedDependencies({ repoRoot: f.root, packageRoot: f.source, destination: f.stage, copyPublishPackage });
  await assert.rejects(readFile(join(f.stage, 'node_modules/development/package.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(f.stage, 'node_modules/optional/package.json')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(join(f.stage, 'node_modules/peer/package.json'))).version, '1.0.0');
});

test('rejects a lock snapshot that omits a declared production edge', async t => {
  const f = await fixture(t);
  delete f.lock.snapshots['a@1.0.0'].dependencies.c;
  await writeFile(join(f.root, 'pnpm-lock.yaml'), stringify(f.lock));
  await assert.rejects(materializeLockedDependencies({ repoRoot: f.root, packageRoot: f.source,
    destination: f.stage, copyPublishPackage }), /missing locked production edge c/u);
});
