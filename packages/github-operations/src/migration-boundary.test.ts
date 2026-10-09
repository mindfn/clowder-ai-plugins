import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

// These consumers require Host-authenticated routing/assignment truth. Keeping
// an unused compiled copy would make it available to package importers anyway.
for (const name of ['community-bootstrap', 'community-auto-tracking']) {
  test(`package excludes Host governance consumer ${name} from source and built artifact`, async () => {
    for (const directory of ['src', 'dist']) {
      const extension = directory === 'src' ? 'ts' : 'js';
      await assert.rejects(access(new URL(`../${directory}/business/domains/community/${name}.${extension}`, import.meta.url)),
        { code: 'ENOENT' });
    }
    const map = JSON.parse(await readFile(new URL('../migration/source-map.json', import.meta.url), 'utf8'));
    const entry = map.entries.find((entry: { source: string }) => entry.source.endsWith(`/${name}.ts`));
    assert.equal(entry.disposition, 'host-retained-governance-consumer');
    assert.equal(entry.hostLegacyRemoved, false);
  });
}

test('default package does not ship the legacy automatic rebase/push executor', async () => {
  for (const directory of ['src', 'dist']) {
    await assert.rejects(access(new URL(`../${directory}/business/infrastructure/email/ConflictAutoExecutor.${directory === 'src' ? 'ts' : 'js'}`, import.meta.url)), { code: 'ENOENT' });
  }
});

for (const name of ['RoleResolver', 'narrator/NarratorDriver', 'narrator/RedisNarratorDedupStore']) {
  test(`package does not ship legacy role/wake consumer ${name}`, async () => {
    for (const directory of ['src', 'dist']) {
      await assert.rejects(access(new URL(`../${directory}/business/domains/community/${name}.${directory === 'src' ? 'ts' : 'js'}`, import.meta.url)), { code: 'ENOENT' });
    }
  });
}

for (const path of [
  'domains/community/GuardianMatcher',
  'infrastructure/github/pr-review-event-wait-coverage',
]) {
  test(`package excludes legacy Host admission helper ${path}`, async () => {
    for (const directory of ['src', 'dist']) {
      await assert.rejects(access(new URL(`../${directory}/business/${path}.${directory === 'src' ? 'ts' : 'js'}`, import.meta.url)), { code: 'ENOENT' });
    }
    const map = JSON.parse(await readFile(new URL('../migration/source-map.json', import.meta.url), 'utf8'));
    const entry = map.entries.find((entry: { source: string }) => entry.source === `packages/api/src/${path}.ts`);
    assert.equal(entry.disposition, 'legacy-host-admission-copy-removed');
    assert.equal(entry.hostLegacyRemoved, false);
    assert.equal(entry.realPackageReplacementVerified, false);
  });
}
