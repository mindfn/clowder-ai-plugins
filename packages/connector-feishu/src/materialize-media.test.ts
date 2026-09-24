import assert from 'node:assert/strict';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import test from 'node:test';

import { materializeMedia } from './materialize-media.js';

async function* chunks(): AsyncGenerator<Uint8Array> {
  yield Buffer.from('first-');
  yield Buffer.from('second');
}

test('materializeMedia streams into a private file and removes its directory', async () => {
  const materialized = await materializeMedia(chunks(), '../voice.opus', 12);
  assert.equal(await readFile(materialized.path, 'utf8'), 'first-second');
  assert.equal(materialized.path.endsWith('/voice.opus'), true);
  assert.equal((await stat(dirname(materialized.path))).mode & 0o777, 0o700);
  assert.equal((await stat(materialized.path)).mode & 0o777, 0o600);
  await materialized.cleanup();
  await assert.rejects(access(materialized.path));

  const parentAlias = await materializeMedia(chunks(), '..', 12);
  assert.equal(parentAlias.path.endsWith('/media.bin'), true);
  assert.equal(await readFile(parentAlias.path, 'utf8'), 'first-second');
  await parentAlias.cleanup();
});

test('materializeMedia stops at the platform limit and removes the partial file', async () => {
  const before = new Set((await readdir(tmpdir())).filter(name => name.startsWith('clowder-feishu-outbound-')));
  await assert.rejects(materializeMedia(chunks(), 'too-large.bin', 11), /platform limit/);
  const after = (await readdir(tmpdir())).filter(name => name.startsWith('clowder-feishu-outbound-'));
  assert.deepEqual(after.filter(name => !before.has(name)), []);
});
