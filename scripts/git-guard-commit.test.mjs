import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const hook = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.githooks', 'pre-commit');

/**
 * The hook reads the current branch and the origin URL from the repo it runs
 * in, so each case needs a throwaway repo rather than argv fixtures.
 */
function runPreCommit({ branch, originUrl }) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'git-guard-commit-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    git('init', '--quiet', '--initial-branch', branch);
    if (originUrl) git('remote', 'add', 'origin', originUrl);
    try {
      execFileSync('bash', [hook], { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
      return { status: 0, stderr: '' };
    } catch (error) {
      return { status: error.status ?? -1, stderr: error.stderr ?? '' };
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

test('commit on mirror main is rejected', () => {
  const result = runPreCommit({
    branch: 'main',
    originUrl: 'https://github.com/zts212653/clowder-ai-plugins.git',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /feature branch/i);
});

test('commit on mirror main is rejected for the ssh origin form', () => {
  const result = runPreCommit({
    branch: 'main',
    originUrl: 'git@github.com:zts212653/clowder-ai-plugins.git',
  });
  assert.notEqual(result.status, 0);
});

test('commit on a feature branch is allowed', () => {
  const result = runPreCommit({
    branch: 'feat/whatever',
    originUrl: 'https://github.com/zts212653/clowder-ai-plugins.git',
  });
  assert.equal(result.status, 0);
});

test('commit on main is allowed when origin is not the upstream mirror', () => {
  const result = runPreCommit({
    branch: 'main',
    originUrl: 'https://github.com/mindfn/clowder-ai-plugins.git',
  });
  assert.equal(result.status, 0);
});

test('commit on main is allowed when there is no origin remote', () => {
  const result = runPreCommit({ branch: 'main', originUrl: null });
  assert.equal(result.status, 0);
});
