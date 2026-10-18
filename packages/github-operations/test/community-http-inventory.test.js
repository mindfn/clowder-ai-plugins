import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { validateManifest } from '@clowder-ai/plugin-contract';

test('current Community HTTP declarations preserve ordinary routes and exclude the retired Host feedback source', () => {
  const inventory = JSON.parse(readFileSync(new URL('../../../migration/f202-w3-community-http-routes.json', import.meta.url), 'utf8'));
  const manifest = parse(readFileSync(new URL('../plugin.yaml', import.meta.url), 'utf8'));
  assert.equal(inventory.routes.length, 33);
  const declarations = manifest.contributions.filter(c => c.type === 'webhook' && c.action.method === inventory.handler);
  const retiredPath = 'github/community-issue-drafts/from-frustration-issue/:issueId';
  assert.deepEqual(inventory.routes.filter(route => route.pluginPath === retiredPath).map(route => route.method), ['POST']);
  const currentRoutes = inventory.routes.filter(route => route.pluginPath !== retiredPath);
  assert.equal(currentRoutes.length, 32);
  assert.equal(declarations.length, 28);
  assert.equal(declarations.some(route => route.path === retiredPath), false);
  assert.deepEqual(declarations.flatMap(c => c.methods.map(method => `${method} ${c.path}`)).sort(),
    currentRoutes.map(r => `${r.method} ${r.pluginPath}`).sort());
  assert.ok(declarations.every(c => c.verificationSecretRef === undefined &&
    manifest.features[0].contributions.some(r => r.type === 'webhook' && r.id === c.id)));
  assert.equal(manifest.contributions.some(c => c.type === 'tool' && c.action.method === inventory.handler), false);
  const result = validateManifest(manifest);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});
