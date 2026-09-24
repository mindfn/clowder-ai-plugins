import assert from 'node:assert/strict';
import test from 'node:test';
import type { FeatureContext } from '@clowder-ai/plugin-sdk';

import { createReplySenderMap } from './reply-sender-map.js';

function harness() {
  const values = new Map<string, unknown>();
  const context = {
    storage: {
      get: async (key: string) => {
        const value = values.get(key);
        return value === undefined ? undefined : { value };
      },
      set: async (key: string, value: unknown) => { values.set(key, value); },
    },
    log: () => undefined,
  } as unknown as FeatureContext;
  return { map: createReplySenderMap(context), values };
}

test('recorded inbound sender resolves by Host messageId', async () => {
  const { map } = harness();
  await map.record('host-message-1', { id: 'sender-1', name: 'Sender' });
  assert.deepEqual(await map.resolve('host-message-1'), { id: 'sender-1', name: 'Sender' });
});

test('unknown Host messageId resolves to undefined (miss fallback)', async () => {
  const { map } = harness();
  await map.record('host-message-1', { id: 'sender-1' });
  assert.equal(await map.resolve('host-message-2'), undefined);
  assert.equal(await map.resolve(undefined), undefined);
});

test('entries expire after the TTL', async () => {
  const { map } = harness();
  const realNow = Date.now;
  try {
    Date.now = () => 1_000_000;
    await map.record('host-message-1', { id: 'sender-1' });
    Date.now = () => 1_000_000 + 24 * 60 * 60 * 1000 - 1;
    assert.deepEqual(await map.resolve('host-message-1'), { id: 'sender-1' });
    Date.now = () => 1_000_000 + 24 * 60 * 60 * 1000;
    assert.equal(await map.resolve('host-message-1'), undefined);
  } finally {
    Date.now = realNow;
  }
});

test('the map is capped and evicts the oldest entries first', async () => {
  const { map } = harness();
  const realNow = Date.now;
  try {
    for (let index = 0; index < 100; index += 1) {
      Date.now = () => index * 1000;
      await map.record(`host-message-${index}`, { id: `sender-${index}` });
    }
    Date.now = () => 100_000;
    await map.record('host-message-100', { id: 'sender-100' });
    assert.equal(await map.resolve('host-message-0'), undefined);
    assert.deepEqual(await map.resolve('host-message-1'), { id: 'sender-1' });
    assert.deepEqual(await map.resolve('host-message-100'), { id: 'sender-100' });
  } finally {
    Date.now = realNow;
  }
});

test('corrupt stored state falls back to an empty map', async () => {
  const { map, values } = harness();
  values.set('reply-senders', { version: 2, entries: 'garbage' });
  assert.equal(await map.resolve('host-message-1'), undefined);
  await map.record('host-message-1', { id: 'sender-1' });
  assert.deepEqual(await map.resolve('host-message-1'), { id: 'sender-1' });
});
