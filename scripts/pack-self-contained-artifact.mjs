import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertProductionDependencyClosure } from './catalog-package-shrinkwrap.mjs';
import {
  assertPackageArchiveLayout,
  verifySelfContainedArchive,
} from './verify-self-contained-artifact.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, NODE_ENV: 'development' },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error([command, ...args, result.stdout, result.stderr].filter(Boolean).join('\n'));
  }
  return result.stdout;
}

function artifactBase(name, version) {
  assert.match(name, /^@[a-z0-9-]+\/[a-z0-9-]+$/u);
  assert.match(version, /^[0-9A-Za-z.-]+$/u);
  return `${name.slice(1).replace('/', '-')}-${version}`;
}

function packCheckoutPackage(directory, destination) {
  const output = run('npm', [
    'pack', '--json', '--ignore-scripts', '--pack-destination', destination,
    join(repoRoot, 'packages', directory),
  ], destination);
  const [artifact] = JSON.parse(output);
  assert.equal(typeof artifact?.filename, 'string');
  return join(destination, artifact.filename);
}

async function main() {
  const [packageDirectory, artifactRootArg] = process.argv.slice(2);
  if (!/^packages\/[a-z0-9-]+$/u.test(packageDirectory ?? '') || !artifactRootArg) {
    throw new Error('usage: node scripts/pack-self-contained-artifact.mjs packages/<name> <f202-w1-tarballs-directory>');
  }
  const artifactRoot = await realpath(resolve(artifactRootArg));
  if (basename(artifactRoot) !== 'f202-w1-tarballs') {
    throw new Error('output root must be the f202-w1-tarballs directory');
  }
  const outputDirectory = join(artifactRoot, 'self-contained');
  const outputStat = await lstat(outputDirectory);
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) {
    throw new Error('self-contained output must be a physical directory');
  }

  const sourcePackage = JSON.parse(await readFile(join(repoRoot, packageDirectory, 'package.json'), 'utf8'));
  const base = artifactBase(sourcePackage.name, sourcePackage.version);
  const canonicalArchive = join(artifactRoot, `${base}.tgz`);
  if (!(await lstat(canonicalArchive)).isFile()) throw new Error('canonical input must be a regular tarball');
  assertPackageArchiveLayout(canonicalArchive);

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'clowder-self-contained-build-'));
  let pendingOutput;
  try {
    const stageRoot = join(temporaryRoot, 'stage');
    const packRoot = join(temporaryRoot, 'local-packs');
    await mkdir(stageRoot);
    await mkdir(packRoot);
    run('tar', ['-xzf', canonicalArchive, '-C', stageRoot], temporaryRoot);
    const stagedPackage = join(stageRoot, 'package');
    const stagedManifest = JSON.parse(await readFile(join(stagedPackage, 'package.json'), 'utf8'));
    assert.equal(stagedManifest.name, sourcePackage.name, 'canonical package name differs from checkout');
    assert.equal(stagedManifest.version, sourcePackage.version, 'canonical package version differs from checkout');
    const shrinkwrap = JSON.parse(await readFile(join(stagedPackage, 'npm-shrinkwrap.json'), 'utf8'));
    assertProductionDependencyClosure(stagedManifest, shrinkwrap);

    // Dev-wave SDK and contract bytes always come from this checkout, even if
    // packages with the same versions later become available in the registry.
    const localPacks = [];
    if (shrinkwrap.packages['node_modules/@clowder-ai/plugin-contract']) {
      run('pnpm', ['--filter', '@clowder-ai/plugin-contract', 'build'], repoRoot);
      localPacks.push(packCheckoutPackage('plugin-contract', packRoot));
    }
    if (shrinkwrap.packages['node_modules/@clowder-ai/plugin-sdk']) {
      run('pnpm', ['--filter', '@clowder-ai/plugin-sdk', 'build'], repoRoot);
      localPacks.push(packCheckoutPackage('plugin-sdk', packRoot));
    }

    await mkdir(join(stagedPackage, 'node_modules'), { recursive: true });
    run('npm', [
      'install', '--omit=dev', '--ignore-scripts', '--no-save', '--package-lock=false',
      '--no-bin-links', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org',
      ...localPacks,
    ], stagedPackage);

    const candidate = join(temporaryRoot, 'candidate.tgz');
    run('tar', [
      '--exclude=package/node_modules/.package-lock.json',
      '-czf', candidate, '-C', stageRoot, 'package',
    ], temporaryRoot);
    const verification = await verifySelfContainedArchive(candidate);
    const filename = `${base}-${process.platform}-${process.arch}.tgz`;
    const destination = join(outputDirectory, filename);
    pendingOutput = join(outputDirectory, `.${filename}.${randomUUID()}.tmp`);
    await copyFile(candidate, pendingOutput);
    await rename(pendingOutput, destination);
    pendingOutput = undefined;
    const bytes = await readFile(destination);
    process.stdout.write(`${JSON.stringify({
      destination,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      package: verification.package,
      members: verification.members,
      symlinks: verification.symlinks,
      installedPackages: verification.installedPackages,
      relocatedEntrypointLoaded: true,
      checkedDirectDependencies: verification.relocation.checkedDirectDependencies,
    }, null, 2)}\n`);
  } finally {
    if (pendingOutput) await rm(pendingOutput, { force: true });
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await main();
