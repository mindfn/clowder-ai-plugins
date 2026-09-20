import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Gate (review round 6, B4 class): every publishable package's `npm pack`
// must succeed WITH lifecycle scripts. The catalog pipeline packs with
// `--ignore-scripts`, so a broken prepack (e.g. a packlist entry outside the
// declared distribution allowlist) is invisible to catalog:check and only
// explodes in the post-merge publish job. Running pack with scripts on the PR
// makes that class red before merge.

const root = new URL('..', import.meta.url).pathname;
const failures = [];
const packed = [];

for (const name of readdirSync(join(root, 'packages')).sort()) {
  const manifestPath = join(root, 'packages', name, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    continue; // not a package directory
  }
  if (manifest.private === true) continue;
  const hasPrepack = manifest.scripts?.prepack !== undefined;
  try {
    // No --ignore-scripts: prepack must run and pass. --dry-run avoids
    // leaving tarballs behind; scripts still execute.
    execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: join(root, 'packages', name),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    packed.push(`${manifest.name}${hasPrepack ? ' (prepack)' : ''}`);
  } catch (error) {
    failures.push(`${manifest.name}: npm pack failed (exit ${error.status ?? 'unknown'})`);
  }
}

for (const line of packed) process.stdout.write(`ok   ${line}\n`);
if (failures.length > 0) {
  for (const line of failures) process.stderr.write(`FAIL ${line}\n`);
  process.exit(1);
}
process.stdout.write(`pack gate: ${packed.length} publishable packages pack clean\n`);
