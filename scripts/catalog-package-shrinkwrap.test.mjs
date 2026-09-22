import assert from 'node:assert/strict';
import test from 'node:test';

import { assertDirectDependencyClosure } from './catalog-package-shrinkwrap.mjs';

test('accepts direct dependencies whose packed lock entries close over the package declaration', () => {
  assert.doesNotThrow(() => assertDirectDependencyClosure(
    {
      dependencies: {
        '@clowder-ai/plugin-sdk': '0.2.0-beta.2',
        yaml: '^2.9.0',
      },
    },
    {
      packages: {
        'node_modules/@clowder-ai/plugin-sdk': { version: '0.2.0-beta.2' },
        'node_modules/yaml': { version: '2.9.0' },
      },
    },
  ));
});

test('rejects a missing direct dependency entry', () => {
  assert.throws(
    () => assertDirectDependencyClosure(
      { dependencies: { '@clowder-ai/plugin-sdk': '0.2.0-beta.2' } },
      { packages: {} },
    ),
    /missing direct dependency node_modules\/@clowder-ai\/plugin-sdk/u,
  );
});

test('rejects a stale exact-version direct dependency entry', () => {
  assert.throws(
    () => assertDirectDependencyClosure(
      { dependencies: { '@clowder-ai/plugin-sdk': '0.2.0-beta.2' } },
      {
        packages: {
          'node_modules/@clowder-ai/plugin-sdk': { version: '0.1.0-beta.13' },
        },
      },
    ),
    /resolves @clowder-ai\/plugin-sdk to 0\.1\.0-beta\.13, expected 0\.2\.0-beta\.2/u,
  );
});
