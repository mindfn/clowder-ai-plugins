import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const movedHead = '4952f27c9306d34cae35cd44b672803f11ed4f48';
// Semantic edges must remain named for independent review. This guard does not approve them.
const edges = new Map([
  ['contracts/types/collective-work.ts', 'retain only domain standing-work schema; remove generic Host Task/custody validators'],
  ['service/cli.ts', 'retire ambient HOME/env/process-signal lifecycle; SDK module owns activation'],
  ['service/github-app-manifest-setup.ts', 'package-local API result type replaces retained Client import'],
  ['service/http-router.ts', 'retain backend APIs and explicitly reject absent C2 asset routes'],
  ['service/identity-store.ts', 'bind OAuth callback to actual SDK-owned listener address'],
  ['service/store.ts', 'inject C2 protocol label, callback plumbing, and initial private bootstrap escrow'],
  ['connector/__tests__/collaboration-proposal.test.ts', 'narrow required source location before typed request'],
  ['connector/__tests__/communication-work-custody.fixture.ts', 'narrow fresh bootstrap credential'],
  ['connector/__tests__/participation-card.test.ts', 'use canonical domain schema defaults in fixture'],
  ['connector/__tests__/reply-operation.test.ts', 'use canonical domain schema defaults in fixture'],
  ['service/__tests__/collaboration-binding-vote.test.ts', 'fix recursive fixture type without changing assertions'],
  ['service/__tests__/github-app-setup-http.test.ts', 'exercise API result instead of retained Client form helper'],
  ['service/__tests__/service-http.test.ts', 'expect explicit C2-unavailable backend response; retain domain API checks'],
]);
function mechanicalImportMove(original, target) {
  const imports = [
    ['@cat-cafe/shared', 'packages/collective-connector/src/business/contracts/index.js'],
    ['@cat-cafe/collective-service', 'packages/collective-connector/src/business/service/index.js'],
    ['../../../collective-service/src/index.js', 'packages/collective-connector/src/business/service/index.js'],
  ];
  for (const [from, destination] of imports) {
    let specifier = relative(dirname(target), destination);
    if (!specifier.startsWith('.')) specifier = './' + specifier;
    for (const quote of ["'", '"']) original = original.replaceAll(quote + from + quote, quote + specifier + quote);
  }
  return original;
}

test('all moved business blobs remain exact or have a named adaptation disposition', async () => {
  const census = JSON.parse(await readFile(join(root, 'migration/collective-source-move.json'), 'utf8'));
  assert.equal(census.sourceCommit, 'ca5b831b48c165ea10c7389fe3eb4ba03d3e01e7');
  assert.equal(census.entries.length, 127);
  const counts = { exact: 0, importOnly: 0, namedEdge: 0 };
  const seen = new Set();
  for (const entry of census.entries) {
    const original = execFileSync('git', ['show', movedHead + ':' + entry.target], { cwd: root });
    assert.equal(createHash('sha256').update(original).digest('hex'), entry.sha256, entry.source);
    const blob = createHash('sha1').update('blob ' + original.length + '\0').update(original).digest('hex');
    assert.equal(blob, entry.sourceBlob, entry.source);
    const edge = entry.target.replace('packages/collective-connector/src/business/', '');
    let current;
    try { current = await readFile(join(root, entry.target), 'utf8'); }
    catch (error) { if (edge !== 'service/cli.ts' || error.code !== 'ENOENT') throw error; }
    if (edges.has(edge)) { counts.namedEdge++; seen.add(edge); continue; }
    if (current === original.toString('utf8')) counts.exact++;
    else {
      assert.equal(current, mechanicalImportMove(original.toString('utf8'), entry.target), 'unclassified semantic delta: ' + edge);
      counts.importOnly++;
    }
  }
  assert.deepEqual([...seen].sort(), [...edges.keys()].sort());
  console.log(JSON.stringify({ sourceCommit: census.sourceCommit, moveCommit: movedHead, entries: census.entries.length, ...counts,
    limitation: 'named semantic edges require independent code review' }));
});
