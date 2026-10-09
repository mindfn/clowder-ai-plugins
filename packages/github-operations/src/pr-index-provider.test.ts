import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubPrIndexProvider } from './pr-index-provider.js';

test('actual transport uses bounded GET metadata pages and complete ordered review pagination', async () => {
  const calls: string[][] = [];
  const provider = new GitHubPrIndexProvider({ token: async () => 'isolated-pr-index', execFileAsync: async (file, args) => {
    assert.equal(file, 'gh'); calls.push(args); assert.ok(args.includes('GET')); assert.ok(!args.includes('--paginate'));
    const url = new URL(args[1]!); assert.equal(url.origin, 'https://api.github.com');
    const reviews = url.pathname.endsWith('/reviews'), page = Number(url.searchParams.get('page'));
    const count = reviews ? page === 1 ? 100 : 1 : 25;
    return { stdout: Array.from({length: count}, (_, i) => JSON.stringify({ id: (page - 1) * 100 + i })).join('\n') };
  } });
  assert.equal((await provider.page('owner/repo', 2, new AbortController().signal)).length, 25);
  const rows = await provider.reviews('owner/repo', 42, new AbortController().signal);
  assert.equal(rows.length, 101); assert.deepEqual(rows.at(-1), {id:100}); assert.equal(calls.length, 3);
  assert.match(calls[0]![1]!, /sort=created&direction=asc&per_page=25&page=2/);
  assert.ok(!calls[0]!.at(-1)!.includes('body'));
});

test('late review error, bad JSON and exhaustion never return partial history', async () => {
  for (const mode of ['late-error','bad-json','exhausted']) {
    let calls = 0;
    const provider = new GitHubPrIndexProvider({token: async () => `isolated-index-${mode}`, execFileAsync: async () => {
      calls++;
      if (mode === 'late-error' && calls === 2) throw new Error('last page unavailable');
      return {stdout: mode === 'bad-json' ? '{bad' : Array.from({length:100}, () => '{}').join('\n')};
    }});
    await assert.rejects(provider.reviews('owner/repo', 42, new AbortController().signal));
    assert.equal(calls, mode === 'late-error' ? 2 : mode === 'bad-json' ? 1 : 100);
  }
});

test('secret wait is cancellable without starting a provider process', async () => {
  let calls = 0;
  const provider = new GitHubPrIndexProvider({token: () => new Promise(() => {}), execFileAsync: async () => { calls++; return {stdout:''}; }});
  const controller = new AbortController();
  const query = assert.rejects(provider.page('owner/repo', 1, controller.signal)); controller.abort(new Error('stopped'));
  await query; assert.equal(calls,0);
});
