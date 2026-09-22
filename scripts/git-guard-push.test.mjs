import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const hook = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.githooks', 'pre-push');

function runPrePush(...args) {
  try {
    execFileSync('bash', [hook, ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    return { status: 0, stderr: '' };
  } catch (error) {
    return { status: error.status ?? -1, stderr: error.stderr ?? '' };
  }
}

test('fork https URL is allowed', () => {
  assert.equal(runPrePush('fork', 'https://github.com/mindfn/clowder-ai-plugins.git').status, 0);
});

test('fork ssh URL is allowed', () => {
  assert.equal(runPrePush('fork', 'git@github.com:mindfn/clowder-ai-plugins.git').status, 0);
});

test('upstream https URL is rejected', () => {
  const result = runPrePush('origin', 'https://github.com/zts212653/clowder-ai-plugins.git');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mindfn\/clowder-ai-plugins/);
});

test('upstream ssh URL is rejected', () => {
  const result = runPrePush('origin', 'git@github.com:zts212653/clowder-ai-plugins.git');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mindfn\/clowder-ai-plugins/);
});

test('missing remote url fails closed', () => {
  for (const args of [[], ['fork']]) {
    const result = runPrePush(...args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /mindfn\/clowder-ai-plugins/);
  }
});
