import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, readdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMeetingRecordDelivery } from './record-delivery.js';

const source = { artifactId: 'm1', kind: 'minute' as const, revision: 'v1',
  generatedAt: '2026-10-11T00:00:00Z', title: 'Design review' };
const current = { assertCurrent: async () => undefined };
async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'meeting-records-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, delivery: createMeetingRecordDelivery(dir, { pluginInstanceId: 'instance-1' }) };
}

test('source record survives delivery and restart, and repeated discovery does not notify again', async t => {
  const { dir, delivery } = await fixture(t);
  const record = await delivery.record(source, 'owner-thread', current);
  let calls = 0;
  await delivery.deliver(record.id, async input => {
    calls++;
    assert.equal((await delivery.get(record.id))?.notification.state, 'unknown');
    assert.equal(input.threadId, 'owner-thread');
    assert.match(input.payload.elements[0].payload.text, /feishu:\/\/meeting-artifacts\/minute\/m1\?revision=v1/);
    return { messageId: 'message-1', threadId: input.threadId };
  }, current);
  const reopened = createMeetingRecordDelivery(dir, { pluginInstanceId: 'instance-1' });
  const retained = await reopened.record(source, 'owner-thread', current);
  assert.equal(retained.id, record.id);
  assert.equal(retained.notification.state, 'delivered');
  await reopened.deliver(record.id, async () => { calls++; throw new Error('duplicate'); }, current);
  assert.equal(calls, 1);
  assert.equal((await reopened.list({ limit: 10 })).records.length, 1);
});

test('uncertain response retains identical target, key and body after restart', async t => {
  const { dir, delivery } = await fixture(t);
  const r = await delivery.record(source, 'owner-thread', current);
  const sent: unknown[] = [];
  await assert.rejects(delivery.deliver(r.id, async input => {
    sent.push(input); throw new Error('response lost');
  }, current), /response lost/);
  const reopened = createMeetingRecordDelivery(dir, { pluginInstanceId: 'instance-1' });
  await reopened.deliver(r.id, async input => {
    sent.push(input); return { messageId: 'same-message', threadId: input.threadId };
  }, current);
  assert.deepEqual(sent[0], sent[1]);
  await assert.rejects(reopened.record(source, 'different-thread', current), /immutable/);
});

test('abort after acceptance leaves unknown receipt and preserves resource for recovery', async t => {
  const { dir, delivery } = await fixture(t);
  const r = await delivery.record(source, 'owner-thread', current);
  let live = true;
  const scope = { assertCurrent: async () => { if (!live) throw new Error('revoked'); } };
  await assert.rejects(delivery.deliver(r.id, async input => {
    live = false; return { messageId: 'accepted', threadId: input.threadId };
  }, scope), /revoked/);
  assert.equal((await createMeetingRecordDelivery(dir, { pluginInstanceId: 'instance-1' }).get(r.id))?.notification.state, 'unknown');
});

test('concurrent rediscovery and send serialize across reopened handles without deleting records', async t => {
  const { dir, delivery } = await fixture(t);
  const second = createMeetingRecordDelivery(dir, { pluginInstanceId: 'instance-1' });
  const records = await Promise.all([delivery.record(source, 't1', current), second.record(source, 't1', current)]);
  assert.equal(records[0].id, records[1].id);
  let calls = 0;
  const send = async (input: { threadId: string }) => { calls++; return { messageId: 'm1', threadId: input.threadId }; };
  await Promise.all([delivery.deliver(records[0].id, send, current), second.deliver(records[0].id, send, current)]);
  assert.equal(calls, 1);
  assert.equal((await second.list({ limit: 10 })).records.length, 1);
});

test('source revision identifies records, payload identity cannot choose target or read a path', async t => {
  const { delivery } = await fixture(t);
  await assert.rejects(delivery.record({ ...source, threadId: 'injected' }, 'owner-thread', current));
  const r = await delivery.record(source, 't1', current);
  const changed = await delivery.record({ ...source, revision: 'v2' }, 't1', current);
  assert.notEqual(r.id, changed.id);
  await assert.rejects(delivery.record({ ...source, title: 'conflicting metadata' }, 't1', current), /immutable/);
  await assert.rejects(delivery.get('../../outside'), /identifier/);
  assert.ok((await delivery.get(r.id))?.source.handle.endsWith('revision=v1'));
});

test('revoked scope performs no record commit or notification; pages are bounded', async t => {
  const { dir, delivery } = await fixture(t);
  const denied = { assertCurrent: async () => { throw new Error('revoked'); } };
  await assert.rejects(delivery.record(source, 't1', denied), /revoked/);
  assert.deepEqual(await readdir(dir), []);
  const r = await delivery.record(source, 't1', current);
  let calls = 0;
  await assert.rejects(delivery.deliver(r.id, async () => { calls++; throw new Error('should not send'); }, denied), /revoked/);
  assert.equal(calls, 0);
  assert.equal((await delivery.get(r.id))?.notification.state, 'pending');
  await assert.rejects(delivery.list({ limit: 0 }));
  await assert.rejects(delivery.list({ limit: 65 }));
});

test('corrupt, foreign and symlinked records fail closed without external reads or overwrite', async t => {
  const { dir, delivery } = await fixture(t);
  const r = await delivery.record(source, 't1', current);
  const path = join(dir, r.id + '.json');
  const value = JSON.parse(await readFile(path, 'utf8'));
  value.pluginInstanceId = 'foreign-instance';
  await writeFile(path, JSON.stringify(value));
  await assert.rejects(delivery.get(r.id), /invalid/);
  await rm(path);
  await symlink('/does-not-exist', path);
  await assert.rejects(delivery.get(r.id), /regular/);
});

test('long source identities use a bounded notification key and keyset pages preserve every record', async t => {
  const { delivery } = await fixture(t);
  const long = await delivery.record({ ...source, artifactId: 'a'.repeat(128), revision: 'v'.repeat(64) }, 't1', current);
  assert.ok(long.notification.input.idempotencyKey.length <= 200);
  await delivery.record({ ...source, revision: 'v2' }, 't1', current);
  await delivery.record({ ...source, revision: 'v3' }, 't1', current);
  const ids: string[] = [];
  let after: string | undefined;
  do {
    const page = await delivery.list({ limit: 1, ...(after ? { after } : {}) });
    ids.push(...page.records.map(record => record.id));
    after = page.next;
  } while (after);
  assert.equal(new Set(ids).size, 3);
});

test('malformed or mismatched receipt stays unknown and a corrupted draft is refused', async t => {
  const { dir, delivery } = await fixture(t);
  const r = await delivery.record(source, 't1', current);
  await assert.rejects(delivery.deliver(r.id, async () => ({ messageId: 'm1', threadId: 'other' }), current), /invalid/);
  assert.equal((await delivery.get(r.id))?.notification.state, 'unknown');
  const file = join(dir, r.id + '.json');
  const value = JSON.parse(await readFile(file, 'utf8'));
  value.notification.input.idempotencyKey = 'unrelated-key';
  await writeFile(file, JSON.stringify(value));
  let calls = 0;
  await assert.rejects(delivery.deliver(r.id, async () => { calls++; throw new Error(); }, current), /invalid/);
  assert.equal(calls, 0);
});

test('Host identifiers remain opaque and within their actual carrier bounds', async t => {
  const { dir } = await fixture(t);
  const delivery = createMeetingRecordDelivery(dir, { pluginInstanceId: 'official.feishu/砚砚:' + '🐾'.repeat(490) });
  const threadId = 'thread.owner/资料:' + 't'.repeat(470);
  const r = await delivery.record(source, threadId, current);
  const sent = await delivery.deliver(r.id, async input => ({ messageId: 'msg:2026/accepted', threadId: input.threadId }), current);
  assert.equal(sent.notification.receipt?.threadId, threadId);
  assert.throws(() => createMeetingRecordDelivery(dir, { pluginInstanceId: '🐾'.repeat(513) }), /identifier/);
  await assert.rejects(delivery.record(source, 't'.repeat(501), current), /target/);
  await assert.rejects(delivery.record(source, ' thread ', current), /target/);
});

test('authority lost before atomic commit leaves no record or temp and never enters send', async t => {
  const { dir, delivery } = await fixture(t);
  let checks = 0;
  const cancelled = { assertCurrent: async () => { if (++checks === 3) throw new Error('cancelled before rename'); } };
  await assert.rejects(delivery.record(source, 't1', cancelled), /cancelled/);
  assert.deepEqual(await readdir(dir), []);
  const r = await delivery.record(source, 't1', current);
  checks = 0;
  let calls = 0;
  await assert.rejects(delivery.deliver(r.id, async () => { calls++; throw new Error('must not send'); }, cancelled), /cancelled/);
  assert.equal(calls, 0);
  assert.equal((await delivery.get(r.id))?.notification.state, 'pending');
  assert.deepEqual(await readdir(dir), [r.id + '.json']);
});

test('distinct opaque instance strings cannot collide through UTF-8 replacement', async t => {
  const { dir } = await fixture(t);
  const first = await createMeetingRecordDelivery(join(dir, 'first'), { pluginInstanceId: '\ud800' }).record(source, 't1', current);
  const second = await createMeetingRecordDelivery(join(dir, 'second'), { pluginInstanceId: '\ufffd' }).record(source, 't1', current);
  assert.notEqual(first.notification.input.idempotencyKey, second.notification.input.idempotencyKey);
});

test('full SDK receipt is accepted without persisting Host capability handles', async t => {
  const { delivery } = await fixture(t);
  const r = await delivery.record(source, 't1', current);
  const sent = await delivery.deliver(r.id, async input => ({
    messageId: 'm1', threadId: input.threadId, revision: 1, publishSequence: 4,
    messageHandle: { kind: 'message', token: 'host-capability-not-record-content' },
  }), current);
  assert.deepEqual(sent.notification.receipt, { messageId: 'm1', threadId: 't1' });
  assert.doesNotMatch(JSON.stringify(await delivery.get(r.id)), /host-capability/);
});

test('Unix FIFO is refused before waiting for a writer', { skip: process.platform === 'win32' }, async t => {
  const { dir, delivery } = await fixture(t);
  const id = 'a'.repeat(64);
  execFileSync('mkfifo', [join(dir, id + '.json')]);
  await assert.rejects(delivery.get(id), /regular/);
});
