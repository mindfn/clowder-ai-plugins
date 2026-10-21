import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const contractPackageDir = fileURLToPath(new URL('.', import.meta.url));
const pluginContractDir = `${contractPackageDir}../../plugin-contract`;

test('connector-feishu shrinkwrap pins the exact packed contract artifact', () => {
  const shrinkwrap = JSON.parse(
    readFileSync(`${pluginContractDir}/../connector-feishu/npm-shrinkwrap.json`, 'utf8'),
  ) as {
    packages: Record<string, { version?: string; integrity?: string }>;
  };
  const entry = shrinkwrap.packages['node_modules/@clowder-ai/plugin-contract'];
  assert.equal(entry?.version, '0.2.0');
  assert.ok(entry?.integrity?.startsWith('sha512-'), 'shrinkwrap entry must pin a sha512 integrity');
  const packed = readFileSync(`${pluginContractDir}/clowder-ai-plugin-contract-0.2.0.tgz`);
  const actual = `sha512-${createHash('sha512').update(packed).digest('base64')}`;
  assert.equal(entry.integrity, actual);
});
