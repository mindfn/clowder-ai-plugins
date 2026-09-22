import assert from 'node:assert/strict';

const exactVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export function assertDirectDependencyClosure(packageJson, shrinkwrap) {
  const directDependencies = {
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.optionalDependencies ?? {}),
  };

  for (const [dependencyName, requestedVersion] of Object.entries(directDependencies)) {
    const packagePath = `node_modules/${dependencyName}`;
    const entry = shrinkwrap.packages?.[packagePath];
    assert.ok(entry, `npm-shrinkwrap.json is missing direct dependency ${packagePath}`);
    if (exactVersionPattern.test(requestedVersion)) {
      assert.equal(
        entry.version,
        requestedVersion,
        `npm-shrinkwrap.json resolves ${dependencyName} to ${entry.version}, expected ${requestedVersion}`,
      );
    }
  }
}
