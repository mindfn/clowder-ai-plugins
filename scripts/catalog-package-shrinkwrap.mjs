import assert from 'node:assert/strict';

const exactVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

function dependencyPackagePaths(packagePath, dependencyName) {
  const paths = [`${packagePath}/node_modules/${dependencyName}`];
  let currentPath = packagePath;

  while (true) {
    const nestedBoundary = currentPath.lastIndexOf('/node_modules/');
    if (nestedBoundary < 0) {
      paths.push(`node_modules/${dependencyName}`);
      return paths;
    }

    currentPath = currentPath.slice(0, nestedBoundary);
    paths.push(`${currentPath}/node_modules/${dependencyName}`);
  }
}

function resolveDependencyEntry(packages, packagePath, dependencyName) {
  for (const candidatePath of dependencyPackagePaths(packagePath, dependencyName)) {
    const entry = packages[candidatePath];
    if (entry) return { entry, packagePath: candidatePath };
  }
  return undefined;
}

function assertRequestedVersion(dependencyName, requestedVersion, entry) {
  if (exactVersionPattern.test(requestedVersion)) {
    assert.equal(
      entry.version,
      requestedVersion,
      `npm-shrinkwrap.json resolves ${dependencyName} to ${entry.version}, expected ${requestedVersion}`,
    );
  }
}

function assertRegistryResolution(packagePath, entry) {
  assert.match(
    entry.resolved ?? '',
    /^https:\/\/registry\.npmjs\.org\//u,
    `${packagePath} must resolve from https://registry.npmjs.org/`,
  );
}

export function assertProductionDependencyClosure(packageJson, shrinkwrap) {
  const packages = shrinkwrap.packages ?? {};
  const rootEntry = packages[''];
  assert.ok(rootEntry, 'npm-shrinkwrap.json is missing its root package entry');
  assert.deepEqual(
    rootEntry.dependencies ?? {},
    packageJson.dependencies ?? {},
    'npm-shrinkwrap.json root dependencies do not match package.json',
  );
  assert.deepEqual(
    rootEntry.optionalDependencies ?? {},
    packageJson.optionalDependencies ?? {},
    'npm-shrinkwrap.json root optionalDependencies do not match package.json',
  );
  const directDependencies = {
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.optionalDependencies ?? {}),
  };
  const pending = [];

  for (const [dependencyName, requestedVersion] of Object.entries(directDependencies)) {
    const packagePath = `node_modules/${dependencyName}`;
    const entry = packages[packagePath];
    assert.ok(entry, `npm-shrinkwrap.json is missing direct dependency ${packagePath}`);
    assertRequestedVersion(dependencyName, requestedVersion, entry);
    pending.push(packagePath);
  }

  const visited = new Set();
  while (pending.length > 0) {
    const packagePath = pending.pop();
    if (visited.has(packagePath)) continue;
    visited.add(packagePath);

    const entry = packages[packagePath];
    assertRegistryResolution(packagePath, entry);

    for (const [kind, dependencies] of [
      ['production', entry.dependencies ?? {}],
      ['optional production', entry.optionalDependencies ?? {}],
    ]) {
      for (const [dependencyName, requestedVersion] of Object.entries(dependencies)) {
        const resolved = resolveDependencyEntry(packages, packagePath, dependencyName);
        assert.ok(
          resolved,
          `${packagePath.replace(/^node_modules\//u, '')} requires missing ${kind} dependency ${dependencyName}`,
        );
        assertRequestedVersion(dependencyName, requestedVersion, resolved.entry);
        pending.push(resolved.packagePath);
      }
    }
  }
}

// The last published SDK/contract pair that unmigrated consumers may keep
// pinning until their own migration. New consumers must close over the
// workspace pair exactly. Single definition shared by catalog-check and tests.
export const lastPublishedSdkContractPair = Object.freeze({
  sdkVersion: '0.2.0-beta.21',
  contractVersion: '0.1.0-beta.37',
});

// One dependency-compatibility rule for every consumer: a shrinkwrap at the
// workspace SDK version must close over the workspace contract; any other
// SDK version must be exactly the last published pair.
export function assertSdkContractPair(shrinkwrap, { sdkVersion, contractVersion }) {
  const sdkEntry = shrinkwrap.packages?.['node_modules/@clowder-ai/plugin-sdk'];
  if (!sdkEntry) return;

  if (sdkEntry.version === sdkVersion) {
    assertWorkspaceSdkContractClosure(shrinkwrap, { sdkVersion, contractVersion });
    return;
  }
  assert.equal(
    sdkEntry.version,
    lastPublishedSdkContractPair.sdkVersion,
    `npm-shrinkwrap.json has an unrecognized SDK identity: ${sdkEntry.version}`,
  );
  assert.equal(
    sdkEntry.dependencies?.['@clowder-ai/plugin-contract'],
    lastPublishedSdkContractPair.contractVersion,
    `npm-shrinkwrap.json pins ${sdkEntry.version} through a stale @clowder-ai/plugin-contract dependency`,
  );
}

export function assertWorkspaceSdkContractClosure(
  shrinkwrap,
  { sdkVersion, contractVersion },
) {
  const packages = shrinkwrap.packages ?? {};
  const sdkPath = 'node_modules/@clowder-ai/plugin-sdk';
  const sdkEntry = packages[sdkPath];
  if (!sdkEntry) return;

  assert.equal(sdkEntry.version, sdkVersion,
    `npm-shrinkwrap.json has an unrecognized SDK identity: ${sdkEntry.version}`);
  const expectedContract = contractVersion;

  assert.equal(
    sdkEntry.dependencies?.['@clowder-ai/plugin-contract'],
    expectedContract,
    `npm-shrinkwrap.json resolves @clowder-ai/plugin-sdk@${sdkEntry.version} through a stale @clowder-ai/plugin-contract dependency`,
  );
  const resolved = resolveDependencyEntry(packages, sdkPath, '@clowder-ai/plugin-contract');
  assert.ok(resolved, 'npm-shrinkwrap.json is missing the workspace SDK contract dependency');
  assert.equal(
    resolved.entry.version,
    expectedContract,
    `npm-shrinkwrap.json resolves the SDK contract to ${resolved.entry.version}, expected ${expectedContract}`,
  );
}

export function collectWorkspacePackageIntegrityMismatches(
  shrinkwrap,
  workspacePackages,
) {
  const packages = shrinkwrap.packages ?? {};
  const mismatches = [];

  for (const [packageName, expected] of Object.entries(workspacePackages)) {
    const packagePath = `node_modules/${packageName}`;
    const entry = packages[packagePath];
    if (!entry || entry.version !== expected.version) continue;
    if (entry.integrity === expected.integrity) continue;

    mismatches.push({
      packageName,
      packagePath,
      version: entry.version,
      actualIntegrity: entry.integrity,
      expectedIntegrity: expected.integrity,
    });
  }

  return mismatches;
}
