import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { publishImmutableArtifact } from './pack-self-contained-artifact.mjs';
import { verifySelfContainedArchive } from './verify-self-contained-artifact.mjs';

async function fixture(t, runtimeSource, transport = 'builtin') {
  const root = await mkdtemp(join(tmpdir(), 'clowder-self-contained-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = join(root, 'stage');
  const packageRoot = join(stage, 'package');
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await mkdir(join(packageRoot, 'node_modules'));
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@clowder-ai/relocation-fixture',
    version: '1.0.0',
    type: 'module',
    main: './dist/index.js',
  }));
  await writeFile(join(packageRoot, 'npm-shrinkwrap.json'), JSON.stringify({
    name: '@clowder-ai/relocation-fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: { '': { name: '@clowder-ai/relocation-fixture', version: '1.0.0' } },
  }));
  await writeFile(join(packageRoot, 'plugin.yaml'), [
    'runtime:',
    `  transport: ${transport}`,
    ...(runtimeSource === null ? [] : ['  entrypoint: dist/plugin-entrypoint.js']),
    '',
  ].join('\n'));
  await writeFile(join(packageRoot, 'dist/index.js'), 'export const mainWorks = true;\n');
  if (runtimeSource !== null) await writeFile(join(packageRoot, 'dist/plugin-entrypoint.js'), runtimeSource);
  const archive = join(root, 'fixture.tgz');
  const tar = spawnSync('tar', ['-czf', archive, '-C', stage, 'package'], { encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  return archive;
}

test('relocated builtin runtime entrypoint loads independently of package main', async (t) => {
  const archive = await fixture(t, 'export default { create() {} };\n');
  const result = await verifySelfContainedArchive(archive);
  assert.equal(result.relocation.runtimeEntrypointLoaded, true);
});

test('existing runtime entrypoint with a missing import is rejected', async (t) => {
  const archive = await fixture(t, "import 'not-installed-runtime-dependency'; export default { create() {} };\n");
  await assert.rejects(verifySelfContainedArchive(archive), /not-installed-runtime-dependency/u);
});

test('builtin runtime entrypoint without PluginModuleEntrypoint shape is rejected', async (t) => {
  const archive = await fixture(t, 'export default {};\n');
  await assert.rejects(verifySelfContainedArchive(archive), /PluginModuleEntrypoint/u);
});

test('stdio entrypoint cannot receive a misleading builtin relocation verdict', async (t) => {
  const archive = await fixture(t, 'export default { create() {} };\n', 'stdio');
  await assert.rejects(verifySelfContainedArchive(archive), /transport-specific relocation probe/u);
});

test('static package without runtime entrypoint still loads its main', async (t) => {
  const archive = await fixture(t, null);
  const result = await verifySelfContainedArchive(archive);
  assert.equal(result.relocation.runtimeEntrypointLoaded, false);
});

test('content-addressed publication never replaces an existing output', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'clowder-self-contained-publish-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = join(root, 'candidate.tgz');
  const destination = join(root, 'existing.tgz');
  await writeFile(candidate, 'new bytes');
  await writeFile(destination, 'old bytes');
  await assert.rejects(publishImmutableArtifact(candidate, destination), { code: 'EEXIST' });
  assert.equal(await readFile(destination, 'utf8'), 'old bytes');
  assert.deepEqual((await readdir(root)).sort(), ['candidate.tgz', 'existing.tgz']);
});
