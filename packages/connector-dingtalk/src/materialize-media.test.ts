import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

import { materializeMedia } from './materialize-media.js';

async function* chunks(): AsyncGenerator<Uint8Array> {
  yield Buffer.from('first-');
  yield Buffer.from('second');
}

test('materializeMedia streams into a private file and removes its directory', async () => {
  const materialized = await materializeMedia(chunks(), '../voice.opus');
  assert.equal(await readFile(materialized.path, 'utf8'), 'first-second');
  assert.equal(materialized.path.endsWith('/voice.opus'), true);
  await materialized.cleanup();
  await assert.rejects(access(materialized.path));

  const parentAlias = await materializeMedia(chunks(), '..');
  assert.equal(parentAlias.path.endsWith('/media.bin'), true);
  assert.equal(await readFile(parentAlias.path, 'utf8'), 'first-second');
  await parentAlias.cleanup();
});
