import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubProvider } from './github-provider.js';
import type { GitHubRequestOptions } from './business/infrastructure/github/request-budget.js';
import { publicationBody, type NativeIssueDraft } from './native-issue-drafts.js';

const target = { kind: 'pr' as const, repoFullName: 'example/project', number: 12, threadId: 'thread-1', catId: 'cat-1' };

test('native publisher uses a single gh POST and reconciles exact own issue content, never a forged marker alone', async () => {
  const draft: NativeIssueDraft = { id: 'a'.repeat(64), repo: 'example/project', title: 'Issue', bodyMarkdown: 'Public text',
    marker: '353d5833-14ea-4aab-8040-333d80ec7de3', status: 'publishing', createdAt: 1 };
  const calls: string[][] = [];
  let duplicate = false;
  const provider = new GitHubProvider({ token: async () => 'fake-publish-token', log: { warn() {} }, execFileAsync: async (file, args) => {
    assert.equal(file, 'gh'); calls.push(args);
    if (args.includes('POST')) {
      assert.ok(args.includes('--hostname') && args.includes('github.com'), 'public issue transport must not inherit GH_HOST');
      assert.ok(args.includes(`body=${publicationBody(draft)}`));
      return { stdout: JSON.stringify({ number: 7, html_url: 'https://github.com/example/project/issues/7' }) };
    }
    if (args[1] === 'user') return { stdout: 'owner' };
    assert.ok(args[1]?.startsWith('https://api.github.com/repos/'), 'reconciliation must use the same fixed provider');
    const exact = { number: 7, html_url: 'https://github.com/example/project/issues/7', title: draft.title, body: publicationBody(draft), user: { login: 'owner' } };
    return { stdout: [exact, { ...exact, number: 8, user: { login: 'stranger' } }, { ...exact, number: 9, title: 'tampered' },
      { ...exact, number: 10, pull_request: {} }, ...(duplicate ? [{ ...exact, number: 11 }] : [])].map(value => JSON.stringify(value)).join('\n') };
  } });
  const signal = new AbortController().signal;
  const issue = await provider.create(draft, signal);
  assert.deepEqual(await provider.find(draft, signal), issue);
  duplicate = true;
  await assert.rejects(provider.find(draft, signal), /multiple/);
  assert.equal(calls.filter(args => args.includes('POST')).length, 1);
  assert.ok(calls.some(args => args[1]?.includes('state=all&creator=owner')));
});

test('cloud observation fetches complete paginated comment history and retains review correlation after notification cursors advance', async () => {
  const calls: string[] = [];
  const head = 'a'.repeat(40);
  const provider = new GitHubProvider({ token: async () => undefined, log: { warn() {} }, execFileAsync: async (_file, args) => {
    const path = args[1]!; calls.push(path);
    if (args[0] === 'pr' && path === 'view') return { stdout: JSON.stringify({ headRefOid: head, state: 'OPEN', statusCheckRollup: [] }) };
    if (path === 'user') return { stdout: 'owner' };
    if (path === '/repos/example/project/pulls/12') return { stdout: JSON.stringify({ state: 'open', head: { sha: head } }) };
    if (path.includes('/pulls/12/comments?')) {
      const row = (id: number) => JSON.stringify({ id, user: { login: 'bot' }, body: 'P2', pull_request_review_id: 77, commit_id: head });
      return { stdout: path.includes('page=2') ? row(101) : Array.from({ length: 100 }, (_, i) => row(i + 1)).join('\n') };
    }
    if (path.includes('/issues/12/comments?') || path.includes('/reviews?')) return { stdout: '' };
    throw new Error(`Unexpected request: ${args.join(' ')}`);
  } });
  const snapshot = await provider.read({ ...target, cloudReviewRequest: { headSha: head, triggerCommentId: 10, requestedAt: 1 } },
    new AbortController().signal, { inline: 1000, conversation: 1000 });
  assert.equal(snapshot.commentsComplete, true);
  assert.equal(snapshot.comments.length, 101);
  assert.ok(snapshot.comments.every(value => value.reviewId === 77));
  assert.equal(calls.some(path => path.includes('since=')), false);
});

test('one scoped CI batch serves multiple real provider snapshots without a cross-tick cache', async () => {
  let batches = 0;
  const head = 'a'.repeat(40);
  const provider = new GitHubProvider({ token: async () => undefined, log: { warn() {} }, execFileAsync: async (_file, args) => {
    if (args[0] === 'pr') throw new Error('Unexpected per-PR CI request');
    const path = args[1]!;
    if (path === 'graphql') {
      batches++;
      const pr = { headRefOid: head, state: 'OPEN', commits: { nodes: [{ commit: { statusCheckRollup: { contexts: {
        nodes: [{ __typename: 'CheckRun', name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }], pageInfo: { hasNextPage: false },
      } } } }] } };
      return { stdout: JSON.stringify({ data: { r0: { p0: pr, p1: pr } } }) };
    }
    if (path === 'user') return { stdout: 'owner' };
    if (/\/pulls\/(12|13)$/.test(path)) return { stdout: JSON.stringify({ state: 'open', head: { sha: head } }) };
    if (path.includes('/comments?') || path.includes('/reviews?')) return { stdout: '' };
    throw new Error(`Unexpected request ${args.join(' ')}`);
  } });
  const next = { ...target, number: 13 };
  const signal = new AbortController().signal;
  const reader = await provider.forCiBatch([target, next], signal);
  assert.equal((await reader.read(target, signal)).ci, 'pass');
  assert.equal((await reader.read(next, signal)).ci, 'pass');
  assert.equal(batches, 1);
  await provider.forCiBatch([target, next], signal);
  assert.equal(batches, 2, 'a later tick performs a fresh provider observation');
});

function fixture() {
  const calls: string[][] = [];
  let head = 'a'.repeat(40);
  let rollup: unknown[] = [];
  const exec: NonNullable<GitHubRequestOptions['execFileAsync']> = async (file, args) => {
    assert.equal(file, 'gh'); calls.push(args);
    if (args[0] === 'pr' && args[1] === 'view') return { stdout: JSON.stringify({ headRefOid: head, state: 'OPEN', statusCheckRollup: rollup }) };
    if (args[0] === 'pr' && args[1] === 'checks') return { stdout: '[]' };
    const path = args[1]!;
    if (path === 'user') return { stdout: 'owner\n' };
    if (path === '/repos/example/project/pulls/12') return { stdout: JSON.stringify({ state: 'open', head: { sha: 'a'.repeat(40) }, mergeable_state: 'clean' }) };
    if (path === '/repos/example/project/issues/comments/99') return { stdout: JSON.stringify({ id: 99, created_at: '2026-10-01T10:00:00Z' }) };
    if (path.includes('/issues/12/comments?')) return { stdout: JSON.stringify({ id: 100, user: { login: 'maintainer' }, body: 'new comment' }) };
    if (path.includes('/pulls/12/comments?') || path.includes('/pulls/12/reviews?')) return { stdout: '' };
    throw new Error(`Unexpected provider call ${args.join(' ')}`);
  };
  const provider = new GitHubProvider({ token: async () => 'isolated-test-token', log: { warn() {} }, execFileAsync: exec });
  return { provider, calls, head: (value: string) => { head = value; }, rollup: (value: unknown[]) => { rollup = value; } };
}

test('real migrated gh transport pages comments using durable cursors and keeps empty checks pending', async () => {
  const f = fixture();
  const result = await f.provider.read(target, new AbortController().signal, { inline: 0, conversation: 99 });
  assert.equal(result.ci, 'pending');
  assert.equal(result.comments[0]?.id, 100);
  assert.equal(f.provider.selfLogin(), 'owner');
  assert.ok(f.calls.some(args => args[1]?.includes('since=2026-10-01T09%3A59%3A59.000Z')));
  assert.ok(f.calls.filter(args => args[0] === 'api').every(args => args.includes('--include')));
});

test('a moving HEAD rejects the inconsistent snapshot instead of advancing a cursor', async () => {
  const f = fixture(); f.head('b'.repeat(40));
  await assert.rejects(f.provider.read(target, new AbortController().signal), /HEAD changed/);
});

test('an aborted poll creates no gh child', async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort(new Error('plugin stopped'));
  await assert.rejects(f.provider.read(target, controller.signal), /plugin stopped/);
  assert.equal(f.calls.length, 0);
});

test('real provider preserves billing-only infrastructure classification and refuses a mixed code failure', async () => {
  let mixed = false;
  const provider = new GitHubProvider({ token: async () => undefined, log: { warn() {} },
    execFileAsync: async (_file, args) => {
      const json = (value: unknown) => ({ stdout: JSON.stringify(value) });
      const head = 'a'.repeat(40);
      if (args[0] === 'pr' && args[1] === 'view') return json({ headRefOid: head, state: 'OPEN', statusCheckRollup: [
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
      ] });
      if (args[0] === 'pr' && args[1] === 'checks') return json([
        { name: 'build', bucket: 'fail' }, ...(mixed ? [{ name: 'tests', bucket: 'fail' }] : []),
      ]);
      const path = args[1]!;
      if (path === 'user') return { stdout: 'owner' };
      if (path === '/repos/example/project/pulls/12') return json({ state: 'open', head: { sha: head } });
      if (path.includes('/comments?') || path.includes('/reviews?')) return { stdout: '' };
      if (path.includes('/check-runs?')) return json({ check_runs: [{ id: 7, name: 'build', conclusion: 'failure' }] });
      if (path.includes('/actions/runs?')) return json({ workflow_runs: [{ id: 8, conclusion: 'failure' }] });
      if (path.includes('/runs/8/jobs?')) return json({ jobs: [{ name: 'build', conclusion: 'failure', runner_id: 0, steps: [], check_run_url: 'https://api.github.com/repos/example/project/check-runs/7' }] });
      if (path.includes('/check-runs/7/annotations?')) return json([{ message: 'Account billing spending limit reached' }]);
      throw new Error(`Unexpected provider call ${args.join(' ')}`);
    },
  });
  assert.equal((await provider.read(target, new AbortController().signal)).ci, 'external_infrastructure');
  mixed = true;
  assert.equal((await provider.read(target, new AbortController().signal)).ci, 'fail');
});
