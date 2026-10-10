import assert from 'node:assert/strict';
import test from 'node:test';
import type { PluginMessagingHost } from '@clowder-ai/plugin-sdk';
import { memoryStorage } from '../test/memory-storage.js';
import { NarratorDriver } from './business/domains/community/narrator/NarratorDriver.js';
import { SdkNarratorDelivery } from './business/domains/community/narrator/SdkNarratorDelivery.js';

const draft = { sourceEventId: 'event', threadId: 'thread', catId: 'narrator', briefing: 'triage this case' };
function messages() {
  const rows = new Map<string, { messageId: string; threadId: string }>(); let calls = 0;
  const messaging: Pick<PluginMessagingHost, 'send'> = { async send(input) {
    calls++; const key = input.idempotencyKey!;
    if (!rows.has(key)) rows.set(key, { messageId: 'message-'+rows.size, threadId: input.threadId });
    return rows.get(key)!;
  } };
  return { messaging, rows, calls: () => calls };
}

test('concurrent narrator delivery and process recreation keep one Host message', async () => {
  const storage = memoryStorage(); const host = messages();
  const a = new SdkNarratorDelivery(storage, host.messaging), b = new SdkNarratorDelivery(storage, host.messaging);
  await Promise.all([a.send(draft), b.send(draft)]);
  assert.equal(host.rows.size, 1);
  const calls = host.calls();
  await new SdkNarratorDelivery(storage, host.messaging).recover();
  assert.equal(host.calls(), calls);
  await assert.rejects(b.send({ ...draft, threadId: 'other' }), /different delivery/);
});

test('unknown send result leaves a recoverable outbox with the original idempotency key', async () => {
  const storage = memoryStorage(); const host = messages(); let fail = true;
  const messaging = { async send(input: Parameters<PluginMessagingHost['send']>[0]) {
    const result = await host.messaging.send(input);
    if (fail) { fail = false; throw new Error('response lost'); }
    return result;
  } };
  await assert.rejects(new SdkNarratorDelivery(storage, messaging).send(draft), /response lost/);
  await new SdkNarratorDelivery(storage, messaging).recover();
  assert.equal(host.rows.size, 1); assert.equal(host.calls(), 2);
  const saved = Object.values(await storage.list())[0]!.value as { messageId: string };
  assert.equal(saved.messageId, 'message-0');
});

test('outbox persistence failure sends nothing; stop after send keeps pending recovery', async () => {
  const backing = memoryStorage(); const host = messages();
  await assert.rejects(new SdkNarratorDelivery({ ...backing, compareAndSet: async () => { throw new Error('storage offline'); } }, host.messaging).send(draft), /offline/);
  assert.equal(host.calls(), 0);
  let delivery: SdkNarratorDelivery;
  delivery = new SdkNarratorDelivery(backing, { async send(input) { const result = await host.messaging.send(input); delivery.stop(); return result; } });
  await assert.rejects(delivery.send(draft), /stopped/);
  await new SdkNarratorDelivery(backing, host.messaging).recover();
  assert.equal(host.rows.size, 1);
});

test('driver retries durable delivery after failure and never claims an unresolved role', async () => {
  const storage = memoryStorage(); const host = messages(); let available = false, fail = true;
  const delivery = new SdkNarratorDelivery(storage, { async send(input) { if (fail) { fail = false; throw new Error('offline'); } return host.messaging.send(input); } });
  const driver = new NarratorDriver({ delivery, narratorThreadId: 'thread',
    roleResolver: { resolve: () => available ? { catId: 'narrator', model: 'model', promptTemplateId: 'template', capabilities: ['triage'] } : null },
    log: { info() {}, warn() {}, error() {} },
  });
  const input = { caseId: 'case', subjectKey: 'issue:org/repo#1', sourceEventId: 'event', briefingContext: 'context' };
  await driver.spawnNarrator(input); assert.deepEqual(await storage.list(), {});
  available = true;
  await driver.spawnNarrator(input); assert.equal(host.rows.size, 0);
  await driver.spawnNarrator(input); assert.equal(host.rows.size, 1);
});
