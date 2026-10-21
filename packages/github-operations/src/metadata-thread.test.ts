import assert from 'node:assert/strict';
import test from 'node:test';
import { findThreadMetadata } from './metadata-thread.js';

const rows = Array.from({ length: 51 }, (_, i) => ({ id: 'thread-' + i, title: 'Thread',
  createdAt: 1, lastActiveAt: 100 - i, preferredCats: [], featureRefs: [], deepLinkUrl: '/thread/' + i }));

test('Community summary lookup uses owner-visible metadata pagination without content access', async () => {
  const calls: unknown[] = [];
  const threads = { list: async (input: any) => {
    calls.push(input);
    const start = input.before ? rows.findIndex(row => row.id === input.before.id) + 1 : 0;
    return rows.slice(start, start + input.limit);
  }, get: async () => { throw new Error('Content access forbidden'); } };
  assert.equal((await findThreadMetadata(threads, 'thread-50'))?.id, 'thread-50');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { limit: 50, before: { id: 'thread-49', lastActiveAt: 51 } });
});

test('an absent or inaccessible metadata summary does not fall back to a content read', async () => {
  const threads = { list: async () => [], get: async () => { throw new Error('Content access forbidden'); } };
  assert.equal(await findThreadMetadata(threads, 'not-owner-visible'), null);
});
