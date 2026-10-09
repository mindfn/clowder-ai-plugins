import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { memoryStorage } from '../test/memory-storage.js';
import { copyLegacyProviderHistory, inspectLegacyProviderHistory, legacyHistoryBytes } from './legacy-provider-history.js';

const subject = 'issue:example/project#7';
const raw = (kind = 'issue.opened', extra = {}) => JSON.stringify({
  sourceEventId: 'old-event', subjectKey: subject, kind, classification: 'state-changing',
  payload: { body: 'private legacy body', assignedThreadId: 'private-route' }, at: 12, ...extra,
});
const envelope = (events: Record<string, string[]> = { [subject]: [raw()] }) => ({
  protocolVersion: 1, snapshot: { events },
  sourceDigest: createHash('sha256').update(legacyHistoryBytes(events)).digest('hex'),
});
const signal = () => new AbortController().signal;

test('raw mixed history becomes inert provider metadata, never replayable authority or body', async () => {
  const storage = memoryStorage();
  const result = await copyLegacyProviderHistory(envelope({ [subject]: [raw(), raw('case.routed', { sourceEventId: 'route' })] }), storage, signal());
  assert.equal(result.data.imported, 1); assert.equal(result.data.hostEventsRetained, 1);
  const state = await storage.list();
  assert.equal(Object.keys(state).length, 1);
  assert.doesNotMatch(JSON.stringify(state), /private|case.routed|classification|payload|old-event/);
  const page = await inspectLegacyProviderHistory({ subjectKey: subject }, storage);
  assert.equal(page.data.items.length, 1);
  assert.equal(page.data.items[0]?.kind, 'issue.opened');
  assert.equal(page.data.items[0]?.sourceSequence, 0);
  assert.equal(page.data.url, 'https://github.com/example/project/issues/7');
  assert.equal(page.data.currentStateAffected, false);
});

test('validates the complete bounded raw batch before writing', async () => {
  for (const input of [
    { ...envelope(), sourceDigest: '0'.repeat(64) },
    envelope({ [subject]: [raw(), '{bad'] }),
    envelope({ [subject]: [raw('unknown.future')] }),
    envelope({ [subject]: [raw('issue.opened', { subjectKey: 'issue:foreign/repo#7' })] }),
    envelope({ [subject]: [raw('issue.opened', { at: -1 })] }),
    envelope({ [subject]: [raw('issue.opened', { newSchemaField: true })] }),
    envelope({ [subject]: [raw(), raw()] }),
    envelope({ [subject]: Array.from({ length: 501 }, (_, i) => raw('issue.opened', { sourceEventId: String(i) })) }),
    envelope({ [subject]: [raw('issue.opened', { payload: { body: 'x'.repeat(256 * 1024) } })] }),
  ]) {
    const storage = memoryStorage();
    await assert.rejects(copyLegacyProviderHistory(input, storage, signal()));
    assert.deepEqual(await storage.list(), {});
  }
});

test('per-subject CAS preserves previous copies and current records across replay and concurrent imports', async () => {
  const storage = memoryStorage();
  await storage.set('community.journal.v1', { next: 9, pending: null });
  const results = await Promise.all([copyLegacyProviderHistory(envelope(), storage, signal()), copyLegacyProviderHistory(envelope(), storage, signal())]);
  assert.equal(results.reduce((n, r) => n + r.data.imported, 0), 1);
  assert.equal(results.reduce((n, r) => n + r.data.identical, 0), 1);
  const changed = await copyLegacyProviderHistory(envelope({ [subject]: [raw('issue.closed')] }), storage, signal());
  assert.equal(changed.data.preserved, 1);
  assert.deepEqual((await storage.get('community.journal.v1'))?.value, { next: 9, pending: null });
  assert.equal((await inspectLegacyProviderHistory({ subjectKey: subject }, storage)).data.items[0]?.kind, 'issue.opened');
});

test('partial failure retries missing subjects and pagination retains original list positions', async () => {
  const storage = memoryStorage(); const cas = storage.compareAndSet; let writes = 0;
  const other = 'issue:example/project#8';
  const input = envelope({ [subject]: [raw(), raw('case.routed', { sourceEventId: 'route' }), raw('issue.closed', { sourceEventId: 'closed' })],
    [other]: [raw('issue.opened', { sourceEventId: 'other', subjectKey: other })] });
  storage.compareAndSet = async (...args) => { if (++writes === 2) throw new Error('storage outage'); return cas(...args); };
  await assert.rejects(copyLegacyProviderHistory(input, storage, signal()), /storage outage/);
  storage.compareAndSet = cas;
  const retry = await copyLegacyProviderHistory(input, storage, signal());
  assert.equal(retry.data.identical, 1); assert.equal(retry.data.imported, 1);
  const first = await inspectLegacyProviderHistory({ subjectKey: subject, limit: 1 }, storage);
  assert.equal(first.data.nextOffset, 1);
  const second = await inspectLegacyProviderHistory({ subjectKey: subject, offset: 1, limit: 1 }, storage);
  assert.equal(second.data.items[0]?.sourceSequence, 2); assert.equal(second.data.nextOffset, null);
  await assert.rejects(inspectLegacyProviderHistory({ subjectKey: subject, limit: 101 }, storage));
});

test('aborted import writes nothing and corrupt stored rows never leak extra fields', async () => {
  const storage = memoryStorage(); const abort = new AbortController(); abort.abort();
  await assert.rejects(copyLegacyProviderHistory(envelope(), storage, abort.signal));
  assert.deepEqual(await storage.list(), {});
  await copyLegacyProviderHistory(envelope(), storage, signal());
  const [key, entry] = Object.entries(await storage.list())[0]!;
  await storage.set(key, { ...(entry.value as object), principal: 'private-owner' });
  await assert.rejects(inspectLegacyProviderHistory({ subjectKey: subject }, storage), /unsupported/);
});
