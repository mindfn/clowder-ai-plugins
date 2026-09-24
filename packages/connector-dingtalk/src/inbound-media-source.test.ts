import assert from 'node:assert/strict';
import test from 'node:test';

import type { FeatureContext } from '@clowder-ai/plugin-sdk';

import { createInboundMediaSourceActions, releaseInboundMedia, retainInboundMedia } from './inbound-media-source.js';

test('private media source retains locator, chunks bytes, settles, and rejects stale references', async () => {
  const state = new Map<string, { revision: number; value: unknown }>();
  const context = {
    state: {
      get: async (key: string) => state.get(key),
      list: async () => Object.fromEntries(state),
      set: async (key: string, value: unknown) => {
        const revision = (state.get(key)?.revision ?? 0) + 1;
        state.set(key, { revision, value });
        return { revision };
      },
      compareAndSet: async () => ({ applied: false }),
      delete: async (key: string) => ({ deleted: state.delete(key) }),
    },
  } as unknown as FeatureContext;
  const elements = await retainInboundMedia(context, 'test', 'test-media', 'provider-event-1', [{
    type: 'image', platformKey: 'provider-secret-locator', fileName: 'photo.png',
  }]);
  assert.equal(elements.length, 1);
  const element = elements[0]!;
  assert.equal(element.kind, 'media_ref');
  if (element.kind !== 'media_ref') assert.fail('expected media_ref');
  assert.match(element.payload.reference, /^pmr_test_/u);
  assert.equal(element.payload.sourceId, 'test-media');
  assert.equal(JSON.stringify(elements).includes('provider-secret-locator'), false);

  const actions = createInboundMediaSourceActions(context, async (locator) => {
    assert.equal(locator.platformKey, 'provider-secret-locator');
    return Buffer.from('private-bytes');
  });
  const reference = element.payload.reference;
  assert.deepEqual(await actions.read({ requestId: 'request-1', reference, offset: 0, limit: 7 }), {
    kind: 'chunk', requestId: 'request-1', offset: 0,
    dataBase64: Buffer.from('private').toString('base64'), nextOffset: 7, done: false,
  });
  assert.deepEqual(await actions.read({ requestId: 'request-1', reference, offset: 7, limit: 524288 }), {
    kind: 'chunk', requestId: 'request-1', offset: 7,
    dataBase64: Buffer.from('-bytes').toString('base64'), done: true,
  });
  assert.deepEqual(await actions.read({ requestId: 'unknown', reference: 'pmr_test_missing', offset: 0, limit: 1 }), {
    kind: 'rejected', requestId: 'unknown', code: 'MEDIA_SOURCE_UNAVAILABLE',
  });
  await actions.settle({ requestId: 'request-1', reference, outcome: 'imported' });
  assert.equal(state.size, 0);
  assert.deepEqual(await actions.read({ requestId: 'request-2', reference, offset: 0, limit: 1 }), {
    kind: 'rejected', requestId: 'request-2', code: 'MEDIA_SOURCE_UNAVAILABLE',
  });

  const abandoned = await retainInboundMedia(context, 'test', 'test-media', 'provider-event-2', [{
    type: 'file', platformKey: 'private-abandoned-locator',
  }]);
  await releaseInboundMedia(context, abandoned);
  assert.equal(state.size, 0);
});

test('state failure preserves text delivery with typed unavailable media and no locator', async () => {
  const warnings: unknown[] = [];
  const context = {
    state: {
      set: async () => { throw new Error('state unavailable'); },
      delete: async () => ({ deleted: false }),
    },
    log: (...args: unknown[]) => { warnings.push(args); },
  } as unknown as FeatureContext;
  const elements = await retainInboundMedia(context, 'test', 'test-media', 'provider-event-1', [{
    type: 'image', platformKey: 'provider-secret-locator', fileName: 'photo.png',
  }]);
  assert.deepEqual(elements, [{
    elementId: 'media-1', kind: 'media_unavailable',
    payload: { type: 'image', reason: 'unavailable', fileName: 'photo.png' },
  }]);
  assert.equal(JSON.stringify({ elements, warnings }).includes('provider-secret-locator'), false);
});
