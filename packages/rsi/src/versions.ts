import { execFile } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { Data, Experiment, RsiHost } from './types.js';

const exec = promisify(execFile);
export async function projectCommit(project: string) {
  return exec('git', ['rev-parse', '--verify', 'HEAD'], { cwd: project }).then((r) => r.stdout.trim(), () => null);
}

export async function versionDirectory(host: RsiHost, key: string, d: Experiment, version: Data) {
  if (!version.commit) return { cwd: d.objective.projectPath, commit: await projectCommit(d.objective.projectPath) };
  const commit = (await exec('git', ['rev-parse', '--verify', `${version.commit}^{commit}`], { cwd: d.objective.projectPath })).stdout.trim();
  const cwd = join(host.dataPath, 'worktrees', Buffer.from(key).toString('base64url'), d.objective.id, `${version.id}-${commit}`);
  if (!await access(cwd).then(() => true, () => false)) {
    await mkdir(dirname(cwd), { recursive: true });
    await exec('git', ['worktree', 'add', '--detach', cwd, commit], { cwd: d.objective.projectPath });
  }
  return { cwd, commit };
}

export async function removeVersionWorktrees(d: Experiment) {
  for (const version of d.versions.filter((v: Data) => v.worktree))
    await exec('git', ['worktree', 'remove', '--force', version.worktree], { cwd: d.objective.projectPath });
}
