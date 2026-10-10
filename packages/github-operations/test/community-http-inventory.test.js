import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { validateManifest } from '@clowder-ai/plugin-contract';

test('all 33 migrated Community HTTP declarations can coexist in the real plugin manifest', () => {
  const inventory = JSON.parse(readFileSync(new URL('../../../migration/f202-w3-community-http-routes.json', import.meta.url), 'utf8'));
  const manifest = parse(readFileSync(new URL('../plugin.yaml', import.meta.url), 'utf8'));
  assert.equal(inventory.routes.length, 33);
  const declarations = inventory.routes.map((route, i) => ({ type: 'webhook', id: `community-http-${i}`, path: route.pluginPath, methods: [route.method], action: { method: inventory.handler } }));
  manifest.contributions.push(...declarations);
  manifest.features.find(feature => feature.id === 'github-collaboration').contributions.push(...declarations.map(({type, id}) => ({ type, id })));
  const result = validateManifest(manifest);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});
