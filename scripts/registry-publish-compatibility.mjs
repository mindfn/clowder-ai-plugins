import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleepDefault } from 'node:timers/promises';

import { parse } from 'yaml';

export const OFFICIAL_NPM_REGISTRY = 'https://registry.npmjs.org';
export const PUBLISH_ACTION = './.github/actions/publish-prerelease';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    const error = new Error(
      [command, ...args, result.stdout, result.stderr].filter(Boolean).join('\n'),
    );
    error.status = result.status;
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }
  return result.stdout;
}

export function collectCatalogNpmClaims(catalog) {
  const claims = [];
  for (const plugin of catalog.plugins ?? []) {
    for (const version of plugin.versions ?? []) {
      const artifact = version.artifact;
      if (artifact?.kind !== 'npm') continue;
      for (const field of ['packageName', 'version', 'integrity']) {
        if (typeof artifact[field] !== 'string' || artifact[field].length === 0) {
          throw new Error(`${plugin.pluginId} catalog npm artifact is missing ${field}`);
        }
      }
      claims.push({
        name: artifact.packageName,
        version: artifact.version,
        integrity: artifact.integrity,
        source: `catalog ${plugin.pluginId}@${version.version}`,
      });
    }
  }
  return claims;
}

export function collectPublishPackageDirectories(workflowSource) {
  const workflow = parse(workflowSource);
  const directories = [];
  for (const job of Object.values(workflow?.jobs ?? {})) {
    for (const step of job?.steps ?? []) {
      if (step?.uses !== PUBLISH_ACTION) continue;
      const directory = step.with?.['package-directory'];
      if (typeof directory !== 'string' || !/^packages\/[a-z0-9-]+$/u.test(directory)) {
        throw new Error(`publish-prerelease step has invalid package-directory: ${directory}`);
      }
      directories.push(directory);
    }
  }
  const unique = [...new Set(directories)].sort();
  if (unique.length === 0) {
    throw new Error('Contract CI has no publish-prerelease package directories');
  }
  if (unique.length !== directories.length) {
    throw new Error('Contract CI publishes the same package directory more than once');
  }
  return unique;
}

export function addImmutableClaim(claims, claim) {
  const identity = `${claim.name}@${claim.version}`;
  const existing = claims.get(identity);
  if (existing !== undefined && existing.integrity !== claim.integrity) {
    throw new Error(
      `${identity} has conflicting local bytes: ${existing.integrity} (${existing.sources.join(', ')}) != ${claim.integrity} (${claim.source})`,
    );
  }
  if (existing === undefined) {
    claims.set(identity, { ...claim, sources: [claim.source] });
  } else {
    existing.sources.push(claim.source);
  }
}

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
]);

function transientNetworkError(error) {
  const seen = new Set();
  while (error !== null && typeof error === 'object' && !seen.has(error)) {
    if (TRANSIENT_NETWORK_CODES.has(error.code) || error.name === 'TimeoutError') return true;
    seen.add(error);
    error = error.cause;
  }
  return false;
}

export async function readRegistryIntegrity(name, version, {
  fetchFn = globalThis.fetch, sleep = sleepDefault, timeoutMs = 15_000,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('registry timeout must be positive');
  const url = new URL(
    `${OFFICIAL_NPM_REGISTRY}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
  );
  // Only transport failures can be transient. A server response, malformed
  // metadata, or exhausted retry budget must never masquerade as npm 404.
  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('registry request timed out', 'TimeoutError')), timeoutMs);
    try {
      const response = await fetchFn(url, { headers: { accept: 'application/json' }, signal: controller.signal });
      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw new Error(`npm registry lookup failed for ${name}@${version}: HTTP ${response.status}`);
      }
      const metadata = await response.json();
      const integrity = metadata?.dist?.integrity;
      if (typeof integrity !== 'string' || integrity.length === 0) {
        throw new Error(`registry returned no dist.integrity for ${name}@${version}`);
      }
      return integrity;
    } catch (error) {
      if (attempt === 2 || !transientNetworkError(error)) {
        throw new Error(`npm registry lookup failed for ${name}@${version}: ${error.message}`, { cause: error });
      }
    } finally {
      clearTimeout(timer);
    }
    // The timer is released before backoff; total budget is 3 * 15s + 750ms.
    await sleep(250 * 2 ** attempt);
  }
}

export async function readRegistryTarball(name, version, {
  fetchFn = globalThis.fetch, sleep = sleepDefault, timeoutMs = 15_000,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('registry timeout must be positive');
  const metadataUrl = new URL(
    `${OFFICIAL_NPM_REGISTRY}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
  );
  const metadata = await fetchRegistryPayload(metadataUrl, 'json', { accept: 'application/json', fetchFn, sleep, timeoutMs });
  const tarballUrl = metadata?.dist?.tarball;
  const integrity = metadata?.dist?.integrity;
  if (typeof tarballUrl !== 'string' || tarballUrl.length === 0) {
    throw new Error(`npm registry returned no dist.tarball for ${name}@${version}`);
  }
  if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) {
    throw new Error(`npm registry returned no sha512 dist.integrity for ${name}@${version}`);
  }
  const bytes = await fetchRegistryPayload(new URL(tarballUrl), 'bytes', { accept: 'application/octet-stream', fetchFn, sleep, timeoutMs });
  const actual = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (actual !== integrity) {
    throw new Error(`npm registry tarball does not match dist.integrity for ${name}@${version}`);
  }
  return bytes;
}

async function fetchRegistryPayload(url, kind, { accept, fetchFn, sleep, timeoutMs }) {
  // Same transport policy as readRegistryIntegrity, but 404 fails closed: this
  // fetch runs only for identities already observed published.
  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('registry request timed out', 'TimeoutError')), timeoutMs);
    try {
      const response = await fetchFn(url, { headers: { accept }, signal: controller.signal });
      if (response.status === 404) throw new Error(`npm registry lookup failed for ${url}: HTTP 404`);
      if (!response.ok) throw new Error(`npm registry lookup failed for ${url}: HTTP ${response.status}`);
      if (kind === 'json') return await response.json();
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (attempt === 2 || !transientNetworkError(error)) {
        throw new Error(`npm registry lookup failed for ${url}: ${error.message}`, { cause: error });
      }
    } finally {
      clearTimeout(timer);
    }
    await sleep(250 * 2 ** attempt);
  }
}

function assertSafePackageTarEntries(listing, identity) {
  const members = listing.split('\n').filter(Boolean);
  if (members.length === 0) throw new Error(`${identity} registry tarball is empty`);
  for (const member of members) {
    const normalized = posix.normalize(member.replace(/\/$/u, ''));
    if (
      member.includes('\\') ||
      isAbsolute(member) ||
      normalized === '.' ||
      normalized === '..' ||
      normalized.startsWith('../') ||
      (normalized !== 'package' && !normalized.startsWith('package/'))
    ) {
      throw new Error(`${identity} registry tarball has an unsafe member: ${member}`);
    }
  }
}

async function collectPackageTree(root) {
  const entries = new Map();
  async function walk(directory, relative) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const child of children) {
      const path = join(directory, child.name);
      const rel = relative === '' ? child.name : `${relative}/${child.name}`;
      if (child.isDirectory()) { await walk(path, rel); continue; }
      if (!child.isFile()) throw new Error(`package tree has a non-regular member: ${rel}`);
      const info = await stat(path);
      entries.set(rel, {
        executable: (info.mode & 0o111) !== 0,
        digest: createHash('sha256').update(await readFile(path)).digest('hex'),
      });
    }
  }
  await walk(root, '');
  return entries;
}

export async function assertSamePackageTrees(localRoot, registryRoot, identity) {
  const [local, registry] = await Promise.all([
    collectPackageTree(localRoot),
    collectPackageTree(registryRoot),
  ]);
  for (const key of registry.keys()) {
    if (!local.has(key)) throw new Error(`${identity} published content is missing locally: ${key}`);
  }
  for (const key of local.keys()) {
    if (!registry.has(key)) throw new Error(`${identity} local content is not in the published package: ${key}`);
  }
  for (const [key, localEntry] of local) {
    const registryEntry = registry.get(key);
    if (localEntry.executable !== registryEntry.executable) {
      throw new Error(`${identity} entry mode differs for ${key}`);
    }
    if (localEntry.digest !== registryEntry.digest) {
      throw new Error(`${identity} published content differs: ${key}`);
    }
  }
}

export async function assertRegistryCompatibility({
  catalog,
  workflowSource,
  root = repoRoot,
  registryIntegrity = readRegistryIntegrity,
  registryTarball = readRegistryTarball,
  packCurrentPackage,
} = {}) {
  const claims = new Map();
  for (const claim of collectCatalogNpmClaims(catalog)) addImmutableClaim(claims, claim);

  const checked = new Set();
  const published = [];
  const unpublished = [];
  const registryState = new Map();
  async function check(claim) {
    const identity = `${claim.name}@${claim.version}`;
    if (checked.has(identity)) return;
    const actual = await registryIntegrity(claim.name, claim.version);
    if (actual === undefined) {
      unpublished.push(identity);
      registryState.set(identity, 'unpublished');
    } else if (actual !== claim.integrity) {
      throw new Error(
        `${identity} is already published with immutable integrity ${actual}, but ${claim.sources.join(', ')} claims ${claim.integrity}`,
      );
    } else {
      published.push(identity);
      registryState.set(identity, 'published');
    }
    checked.add(identity);
  }

  // Check catalog history first. A stale pin should fail without spending time
  // packing every current package.
  for (const claim of claims.values()) await check(claim);

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'clowder-registry-compat-'));
  try {
    for (const directory of collectPublishPackageDirectories(workflowSource)) {
      let artifact;
      if (packCurrentPackage !== undefined) {
        artifact = await packCurrentPackage(directory, temporaryRoot);
      } else {
        const output = run(
          process.execPath,
          ['scripts/pack-publish-artifact.mjs', directory, temporaryRoot],
          { cwd: root },
        );
        [artifact] = JSON.parse(output);
      }
      for (const field of ['name', 'version', 'integrity']) {
        if (typeof artifact?.[field] !== 'string' || artifact[field].length === 0) {
          throw new Error(`${directory} pack result is missing ${field}`);
        }
      }
      const identity = `${artifact.name}@${artifact.version}`;
      const existing = claims.get(identity);
      if (existing !== undefined && existing.integrity === artifact.integrity) {
        existing.sources.push(`publish job ${directory}`);
      } else if (existing !== undefined && registryState.get(identity) === 'published') {
        // The deterministic repack intentionally changes packaging bytes
        // (member order, mtimes, gzip header), so byte equality with the
        // published tarball is no longer attainable. The immutable invariant
        // is the unpacked content: the current source must not drift from
        // what npm already serves for this version.
        if (typeof artifact.filename !== 'string' || artifact.filename.length === 0) {
          throw new Error(`${identity} publish job pack result is missing filename for published content verification`);
        }
        const artifactPath = join(temporaryRoot, artifact.filename);
        const extractionRoot = await mkdtemp(join(tmpdir(), 'clowder-registry-content-'));
        try {
          const localRoot = join(extractionRoot, 'local');
          const registryRoot = join(extractionRoot, 'registry');
          await mkdir(localRoot);
          await mkdir(registryRoot);
          assertSafePackageTarEntries(run('tar', ['-tzf', artifactPath], root), identity);
          run('tar', ['-xzf', artifactPath, '-C', localRoot], root);
          const registryArchive = join(extractionRoot, 'registry.tgz');
          await writeFile(registryArchive, await registryTarball(artifact.name, artifact.version));
          assertSafePackageTarEntries(run('tar', ['-tzf', registryArchive], root), identity);
          run('tar', ['-xzf', registryArchive, '-C', registryRoot], root);
          await assertSamePackageTrees(join(localRoot, 'package'), join(registryRoot, 'package'), identity);
        } finally {
          await rm(extractionRoot, { recursive: true, force: true });
        }
        existing.sources.push(`publish job ${directory}`);
      } else {
        addImmutableClaim(claims, {
          name: artifact.name,
          version: artifact.version,
          integrity: artifact.integrity,
          source: `publish job ${directory}`,
        });
      }
      await check(claims.get(identity));
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  return {
    claims: claims.size,
    published: published.sort(),
    unpublished: unpublished.sort(),
  };
}

async function main() {
  const catalog = JSON.parse(await readFile(join(repoRoot, 'catalog/candidate.json'), 'utf8'));
  const workflowSource = await readFile(
    join(repoRoot, '.github/workflows/contract-ci.yml'),
    'utf8',
  );
  const result = await assertRegistryCompatibility({ catalog, workflowSource });
  process.stdout.write(
    `registry compatibility: ${result.claims} immutable identities; ${result.published.length} published match npmjs.org; ${result.unpublished.length} remain eligible\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
