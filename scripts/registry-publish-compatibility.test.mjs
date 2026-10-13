import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

import { normalizeBundledPublishGzip } from './canonical-publish-gzip.mjs';
import {
  OFFICIAL_NPM_REGISTRY,
  addImmutableClaim,
  assertRegistryCompatibility,
  collectPublishPackageDirectories,
  collectRetainedPublishArtifacts,
  readRegistryIntegrity,
} from './registry-publish-compatibility.mjs';
import { prepareRetainedPublication } from './prepare-retained-publish-artifact.mjs';
import { readRetainedSdkClosures } from './retained-sdk-fixture.mjs';

const workflowSource = `
jobs:
  validate:
    steps:
      - run: echo validate
  publish:
    steps:
      - uses: ./.github/actions/publish-prerelease
        with:
          package-directory: packages/example
`;

test('publish inventory comes from the workflow publish action inputs', () => {
  assert.deepEqual(collectPublishPackageDirectories(workflowSource), ['packages/example']);
});

test('protected workflow publishes all authenticated retained pairs before current and consuming packages', async () => {
  const source = await readFile(new URL('../.github/workflows/contract-ci.yml', import.meta.url), 'utf8');
  const steps = parse(source).jobs.publish.steps;
  const inputs = collectRetainedPublishArtifacts(source);
  const expected = (await readRetainedSdkClosures()).flatMap(pair => ['contract', 'sdk'].map(kind =>
    `scripts/fixtures/retained-sdk/clowder-ai-plugin-${kind}-${pair[kind].version}.tgz`));
  assert.deepEqual(inputs.map(input => input.artifactPath).sort(), expected.sort());
  const currentIndex = steps.findIndex(step => step.uses === './.github/actions/publish-prerelease' &&
    !step.with['retained-artifact']);
  for (const pair of await readRetainedSdkClosures()) {
    const index = kind => steps.findIndex(step => step.with?.['retained-artifact']?.endsWith(
      `clowder-ai-plugin-${kind}-${pair[kind].version}.tgz`));
    assert.ok(index('contract') < index('sdk'));
    assert.ok(index('sdk') < currentIndex, 'current release keeps final next tag ownership');
  }
  assert.ok(collectPublishPackageDirectories(source).includes('packages/github-operations'));
  assert.equal(collectPublishPackageDirectories(source).includes('packages/collective-connector'), false);
  const githubBuild = steps.findIndex(step => step.run === 'pnpm --filter @clowder-ai/github-operations build');
  const githubPublish = steps.findIndex(step => step.with?.['package-directory'] === 'packages/github-operations');
  assert.ok(githubBuild >= 0 && githubBuild < githubPublish);
});

test('retained preparation copies six pinned archives unchanged and rejects path, identity and integrity substitutions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'clowder-retained-publication-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await readFile(new URL('../.github/workflows/contract-ci.yml', import.meta.url), 'utf8');
  const inputs = collectRetainedPublishArtifacts(source);
  assert.equal(inputs.length, 6);
  for (const input of inputs) {
    const original = await readFile(new URL(`../${input.artifactPath}`, import.meta.url));
    const artifact = await prepareRetainedPublication({ ...input, destination: root });
    assert.deepEqual(await readFile(join(root, artifact.filename)), original);
    assert.equal(artifact.integrity, `sha512-${createHash('sha512').update(original).digest('base64')}`);
    assert.equal(artifact.retained, true);
  }
  const first = inputs[0];
  await assert.rejects(prepareRetainedPublication({ ...first, directory: 'packages/github-operations', destination: root }),
    /authenticated SDK\/contract archive identity/);
  await assert.rejects(prepareRetainedPublication({ ...first, artifactPath: '../outside.tgz', destination: root }),
    /authenticated SDK\/contract archive identity/);
  const alteredRoot = join(root, 'altered');
  const changed = join(alteredRoot, first.artifactPath);
  await mkdir(dirname(changed), { recursive: true });
  await writeFile(changed, 'same filename is not the authenticated archive');
  await assert.rejects(prepareRetainedPublication({ ...first, destination: join(root, 'refused'), root: alteredRoot }),
    /archive integrity mismatch/);
  await assert.rejects(readFile(join(root, 'refused', first.artifactPath.split('/').at(-1))), { code: 'ENOENT' });
});

test('registry gate refuses a conflicting published retained identity before packing current releases', async () => {
  const source = await readFile(new URL('../.github/workflows/contract-ci.yml', import.meta.url), 'utf8');
  await assert.rejects(assertRegistryCompatibility({ catalog: { plugins: [] }, workflowSource: source,
    registryIntegrity: async () => 'sha512-conflicting-published-version',
    packCurrentPackage: async () => { assert.fail('retained conflict must stop before current packing'); },
  }), /already published with immutable integrity/u);
});

test('same package version cannot claim two local byte identities', () => {
  const claims = new Map();
  addImmutableClaim(claims, {
    name: '@clowder-ai/example',
    version: '0.1.0-alpha.1',
    integrity: 'sha512-one',
    source: 'catalog',
  });
  assert.throws(
    () => addImmutableClaim(claims, {
      name: '@clowder-ai/example',
      version: '0.1.0-alpha.1',
      integrity: 'sha512-two',
      source: 'publish job',
    }),
    /conflicting local bytes/u,
  );
});

test('registry lookup directly addresses the official npm registry', async () => {
  let requestedUrl;
  const integrity = await readRegistryIntegrity('@clowder-ai/example', '0.1.0-alpha.1', {
    async fetchFn(url) {
      requestedUrl = url;
      return {
        ok: true,
        status: 200,
        async json() {
          return { dist: { integrity: 'sha512-published' } };
        },
      };
    },
  });
  assert.equal(integrity, 'sha512-published');
  assert.equal(requestedUrl.origin, OFFICIAL_NPM_REGISTRY);
  assert.equal(requestedUrl.hostname, 'registry.npmjs.org');
  assert.equal(requestedUrl.pathname, '/%40clowder-ai%2Fexample/0.1.0-alpha.1');
});

test('registry lookup treats only HTTP 404 as an unpublished version', async () => {
  const integrity = await readRegistryIntegrity('@clowder-ai/example', '0.1.0-alpha.2', {
    fetchFn: async () => ({ ok: false, status: 404 }),
  });
  assert.equal(integrity, undefined);
});

test('registry lookup fails closed on HTTP and network errors', async () => {
  await assert.rejects(
    readRegistryIntegrity('@clowder-ai/example', '0.1.0-alpha.1', {
      fetchFn: async () => ({ ok: false, status: 503 }),
    }),
    /HTTP 503/u,
  );
  await assert.rejects(
    readRegistryIntegrity('@clowder-ai/example', '0.1.0-alpha.1', {
      fetchFn: async () => {
        throw new Error('network unavailable');
      },
    }),
    /npm registry lookup failed/u,
  );
});

for (const code of ['ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']) {
  test(`registry retries ${code} with bounded backoff then reads authoritative metadata`, async () => {
    let calls = 0;
    const delays = [];
    const result = await readRegistryIntegrity('@clowder-ai/example', '1.0.0', {
      sleep: async ms => { delays.push(ms); },
      fetchFn: async () => {
        calls += 1;
        if (calls < 3) throw new TypeError('fetch failed', { cause: Object.assign(new Error('transient'), { code }) });
        return { ok: true, status: 200, json: async () => ({ dist: { integrity: 'sha512-real' } }) };
      },
    });
    assert.equal(result, 'sha512-real');
    assert.equal(calls, 3);
    assert.deepEqual(delays, [250, 500]);
  });
}

test('registry exhausts transient retries without treating failure as unpublished', async () => {
  let calls = 0;
  const delays = [];
  await assert.rejects(readRegistryIntegrity('example', '1.0.0', {
    sleep: async ms => { delays.push(ms); },
    fetchFn: async () => { calls += 1; throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); },
  }), /npm registry lookup failed/);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [250, 500]);
});

for (const status of [401, 403, 429, 500, 503]) {
  test(`registry HTTP ${status} fails immediately, even after a transient network failure`, async () => {
    let calls = 0;
    await assert.rejects(readRegistryIntegrity('example', '1.0.0', {
      sleep: async () => {},
      fetchFn: async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
        return { ok: false, status };
      },
    }), new RegExp(`HTTP ${status}`));
    assert.equal(calls, 2);
  });
}

test('registry body transport failures retry, malformed metadata does not', async () => {
  let calls = 0;
  await assert.rejects(readRegistryIntegrity('example', '1.0.0', {
    sleep: async () => {},
    fetchFn: async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => {
        if (calls === 1) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
        return {};
      } };
    },
  }), /no dist.integrity/);
  assert.equal(calls, 2);
});

test('registry deadlines abort stuck transport attempts and exhaust a finite budget', async () => {
  let calls = 0;
  await assert.rejects(readRegistryIntegrity('example', '1.0.0', {
    timeoutMs: 5,
    sleep: async () => {},
    fetchFn: async (_url, { signal }) => {
      calls += 1;
      return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  }), /npm registry lookup failed/);
  assert.equal(calls, 3);
});

test('bundled publish gzip identity is stable across macOS and Ubuntu', () => {
  const macos = Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 19, 1, 2, 3]);
  const ubuntu = Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 3, 1, 2, 3]);
  assert.deepEqual(normalizeBundledPublishGzip(macos), ubuntu);
  assert.deepEqual(normalizeBundledPublishGzip(ubuntu), ubuntu);
});

test('bundled publish gzip refuses to invalidate an FHCRC header', () => {
  const withHeaderCrc = Buffer.from([0x1f, 0x8b, 0x08, 0x02, 0, 0, 0, 0, 0, 19, 1, 2, 3]);
  assert.throws(
    () => normalizeBundledPublishGzip(withHeaderCrc),
    /gzip has FHCRC; refusing to rewrite header/u,
  );
});

test('published catalog and publish-job bytes must match the immutable registry bytes', async () => {
  const catalog = {
    plugins: [{
      pluginId: 'example',
      versions: [{
        version: '0.1.0-alpha.1',
        artifact: {
          kind: 'npm',
          packageName: '@clowder-ai/example',
          version: '0.1.0-alpha.1',
          integrity: 'sha512-local',
        },
      }],
    }],
  };
  await assert.rejects(
    assertRegistryCompatibility({
      catalog,
      workflowSource,
      registryIntegrity: async () => 'sha512-published',
      packCurrentPackage: async () => ({
        name: '@clowder-ai/example',
        version: '0.1.0-alpha.1',
        integrity: 'sha512-local',
      }),
    }),
    /already published with immutable integrity sha512-published/u,
  );
});

test('unpublished current versions and matching published history pass together', async () => {
  const catalog = {
    plugins: [{
      pluginId: 'example',
      versions: [{
        version: '0.1.0-alpha.1',
        artifact: {
          kind: 'npm',
          packageName: '@clowder-ai/example',
          version: '0.1.0-alpha.1',
          integrity: 'sha512-published',
        },
      }],
    }],
  };
  const result = await assertRegistryCompatibility({
    catalog,
    workflowSource,
    registryIntegrity: async (_name, version) => (
      version === '0.1.0-alpha.1' ? 'sha512-published' : undefined
    ),
    packCurrentPackage: async () => ({
      name: '@clowder-ai/example',
      version: '0.1.0-alpha.2',
      integrity: 'sha512-next',
    }),
  });
  assert.deepEqual(result.published, ['@clowder-ai/example@0.1.0-alpha.1']);
  assert.deepEqual(result.unpublished, ['@clowder-ai/example@0.1.0-alpha.2']);
});
