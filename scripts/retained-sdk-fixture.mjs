import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Frozen canonical inputs; provenance lives in fixtures/retained-sdk/README.md.
// Derive dependency identity from authenticated archives, never from the lock under test.
export async function readRetainedSdkClosure() {
  const identities = [];
  for (const [name, version, size, sha256] of [
    ['plugin-sdk', '0.2.0-beta.12', 55750, 'af0cd615aa2b2f8f9de994499f541f83163d9637d56fb89406bc1f7aa023ad7b'],
    ['plugin-contract', '0.1.0-beta.29', 228047, '25225f3c1b3f9935c692dbca7f8f001eca70ab7c198165b4e9ef69ca91d9b458'],
  ]) {
    const archive = new URL(`./fixtures/retained-sdk/clowder-ai-${name}-${version}.tgz`, import.meta.url);
    const bytes = await readFile(archive);
    assert.equal(bytes.length, size, `retained ${name} size`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256, `retained ${name} SHA-256`);
    const result = spawnSync('tar', ['-xOf', fileURLToPath(archive), 'package/package.json'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(result.stdout);
    assert.equal(manifest.name, `@clowder-ai/${name}`);
    assert.equal(manifest.version, version);
    identities.push({ version, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, manifest });
  }
  const [sdk, contract] = identities;
  assert.equal(sdk.manifest.dependencies['@clowder-ai/plugin-contract'], contract.version);
  return {
    sdk: { version: sdk.version, integrity: sdk.integrity },
    contract: { version: contract.version, integrity: contract.integrity },
  };
}
