import { expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { BROWSER_SERVICE_LIMITS, type PluginTaskReadItem, type ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import entrypoint from '../../../plugin-entrypoint.js';
import { fixture } from './communication-work-custody.fixture.js';
import { ownerRequestExecution } from '../../../collective-owner-request-progress.js';

const manifest = parse(await readFile(new URL('../../../../plugin.yaml', import.meta.url), 'utf8'));
async function setup(taskHost?: ModulePluginHostShape['tasks']) {
  const f = await fixture(); let stale = false, reads = 0;
  await f.connector.sync(f.connection.connectionId);
  const route = (await f.connector.getHostRoute(f.connection.connectionId))!;
  await f.connector.beginInboxRouting(f.connection.connectionId, f.source.eventId, route.revision);
  await f.connector.completeInboxRouting(f.connection.connectionId, f.source.eventId, route.revision,
    { kind: 'thread_message', messageId: 'view-source', threadId: 'channel', catId: 'codex-sol' });
  const rows = [{ id: 'channel', title: 'Owner channel', createdBy: 'local-owner', participants: ['codex-sol'] },
    { id: 'foreign', title: 'Foreign private', createdBy: 'foreign-owner', participants: ['codex-sol'] }];
  const current = async () => { if (stale) throw new Error('Owner view expired'); };
  const unused = async (): Promise<never> => { throw new Error('Read must not invoke an unrelated Host port'); };
  const base: PluginTaskReadItem = { id: 'owned-task', title: 'Original entrusted work', threadId: 'channel',
    kind: 'work', subjectKey: null, status: 'doing', ownerCatId: null, why: '', createdBy: 'local-owner',
    createdAt: 1, updatedAt: 1, userId: 'local-owner',
    entrustedWork: { revision: 3, closure: { state: 'open' }, admission: { sourceRefs: ['message:view-source'] } } };
  const tasks: PluginTaskReadItem[] = [base, { ...base, id: 'foreign-task', userId: 'foreign-owner' },
    { ...base, id: 'unrelated-task', entrustedWork: { ...base.entrustedWork!, admission: { sourceRefs: ['message:other'] } } },
    { ...base, id: 'legacy-unowned-task', userId: null }];
  const host: ModulePluginHostShape = { dataDirectory: f.root, config: { async get() {} }, secrets: { async get() { return undefined; } }, storage: { get: unused, list: unused, set: unused, compareAndSet: unused, delete: unused },
    media: { read: unused }, messaging: { send: unused, subscribe: unused, unsubscribe: unused }, log() {},
    tasks: taskHost ?? { get: unused, listByThread: unused, getBySubject: unused, create: unused, upsertBySubject: unused,
      update: unused, updateIfThreadId: unused, setWait: unused,
      async listByKind(kind) { await current(); expect(kind).toBe('work'); reads++; return tasks; } },
    threads: { get: unused, readMessages: unused, getCats: unused, create: unused, update: unused, findByKey: unused,
      ensureByKey: unused, bind: unused, unbind: unused, listBindings: unused, ensureSystemThread: unused,
      async list(options: { limit?: number; before?: { lastActiveAt: number; id: string } } = {}) {
      await current(); return rows.map((r, i) => ({ ...r, deepLinkUrl: '/thread/' + r.id, createdAt: 1,
        lastActiveAt: rows.length - i, preferredCats: [], featureRefs: [] }))
        .filter(r => !options.before || r.lastActiveAt < options.before.lastActiveAt ||
          (r.lastActiveAt === options.before.lastActiveAt && r.id > options.before.id)).slice(0, options.limit ?? 50);
    } },
    ownerThreads: { async get(id: string) { await current(); const r = rows.find(r => r.id === id);
      return r ? { id: r.id, createdBy: r.createdBy, participants: r.participants } : null;
    }, async create() { throw new Error('Read must not create'); }, async addParticipants() { throw new Error('Read must not mutate'); } },
    sourceFacts: { async read() { await current(); return { id: 'view-source', threadId: 'channel', userId: 'local-owner', catId: null,
      content: 'Fixture request', source: { connector: 'collective', meta: { participation: f.source } }, extra: { pluginMessage: { instanceId: 'fixture' } } }; } },
    participantRoster: { async listForNativeContribution() { await current(); return [{ catId: 'codex-sol', displayName: 'Sol', defaultModel: 'fixture', supported: true }]; } },
    nativeContext: { async current() { throw new Error('Owner GET must not borrow native identity'); } },
    browserServices: { async getBinding(id: string) { return { contributionId: id, origin: 'http://127.0.0.1:5271', parentOrigin: 'http://localhost:5172',
      clientBuildId: 'collective-client-v2', assetDigest: 'a'.repeat(64), limits: BROWSER_SERVICE_LIMITS, assertCurrent: current }; },
      async dispatchLocal() { throw new Error('Unused'); } } };
  const active = await entrypoint.create(manifest).start(host);
  return { ...f, active, tasks, rows, get reads() { return reads; }, expire() { stale = true; },
    invoke(owner = 'local-owner', native?: unknown) { return active.actions['collective.control.http']!({ request: { method: 'GET',
      path: `connections/${f.connection.connectionId}/participation`, headers: { origin: 'http://localhost:5172' },
      principal: { kind: 'owner', id: owner } } }, native as never); }, async close() { await active.stop(); await f.close(); } };
}
test('retained GET participation and original read-only Task dependency are declared', () => {
  const c = manifest.contributions.find((c: { path?: string }) => c.path === 'connections/:connectionId/participation');
  expect(c).toMatchObject({ type: 'webhook', methods: ['GET'], action: { method: 'collective.control.http' } });
  expect(manifest.features[0].contributions).toContainEqual({ type: 'webhook', id: c.id });
  expect(manifest.features[0].capabilities).toContain('task.read');
  expect(manifest.features[0].capabilities).not.toContain('task.write');
});
test('actual GET retains owner threads, requests, admitted-source Task filtering and policy without mutation', async () => {
  const f = await setup(); try {
    const before = await f.connector.getHostRoute(f.connection.connectionId);
    const result = await f.invoke() as { status: number; body: any };
    expect(result.status, JSON.stringify(result)).toBe(200);
    expect(result.body).toMatchObject({ connection: { connectionId: f.connection.connectionId }, revision: before!.revision,
      cats: [{ id: 'codex-sol', configured: true, eligible: true }], threads: [{ id: 'channel', title: 'Owner channel', participants: ['codex-sol'] }],
      requests: [{ messageId: 'view-source', privateThread: { id: 'channel', title: 'Owner channel' } }],
      tasks: [{ id: 'owned-task', revision: 3, closure: 'open', sourceRefs: ['message:view-source'] }] });
    expect(result.body.tasks).toHaveLength(1); expect(result.body.threads).toHaveLength(1);
    expect(result.body.requests[0]).not.toHaveProperty('execution'); // Current Host omits queue facts: no fabricated progress.
    expect(await f.connector.getHostRoute(f.connection.connectionId)).toEqual(before); expect(f.reads).toBe(1);
  } finally { await f.close(); }
});
test('foreign owner and native caller are refused before owner view reads', async () => {
  const f = await setup(); try {
    expect(await f.invoke('foreign-owner')).toMatchObject({ status: 403, body: { code: 'CONNECTOR_OWNER_MISMATCH' } });
    await expect(f.invoke('local-owner', { userId: 'local-owner' })).rejects.toThrow(/webhook/);
    expect(f.reads).toBe(0);
  } finally { await f.close(); }
});
test('expired view and disposed feature cannot return cached owner data', async () => {
  const f = await setup(); try {
    f.expire(); await expect(f.invoke()).rejects.toThrow(/expired/);
    expect(f.reads).toBe(0);
  } finally { await f.close(); }
});
test('the existing fifty-row Host cursor preserves the complete owned-thread selection', async () => {
  const f = await setup(); try {
    for (let i = 0; i < 55; i++) f.rows.push({ id: `owned-${i}`, title: `Owner ${i}`, createdBy: 'local-owner', participants: [] });
    const result = await f.invoke() as { status: number; body: { threads: { id: string }[] } };
    expect(result.status).toBe(200); expect(result.body.threads).toHaveLength(56);
    expect(result.body.threads.at(-1)?.id).toBe('owned-54');
    expect(result.body.threads.some(t => t.id === 'foreign')).toBe(false);
  } finally { await f.close(); }
});
test('original progress stages require the exact owner/source/cat/connection and original queue scope', async () => {
  const f = await fixture(); try {
    await f.connector.sync(f.connection.connectionId);
    const item = (await f.connector.listInbox(f.connection.connectionId)).find(item => item.event.eventId === f.source.eventId)!;
    const request = { ...item, routeReceipt: { kind: 'thread_message' as const, threadId: 'channel', messageId: 'source', catId: 'codex-sol' } };
    const thread = { id: 'channel', title: 'Owner', createdBy: 'local-owner', participants: ['codex-sol'] };
    const message = { id: 'source', userId: 'local-owner', threadId: 'channel', source: { meta: { participation: f.source } },
      queueCustody: { executionScope: 'collective-participation', allTargetCats: ['codex-sol'], handledByCatIds: [] as string[],
        failedByCatIds: [] as string[], seenByCatIds: [] as string[] } };
    const read = () => ownerRequestExecution(request, thread, { async getById() { return message; } }, 'local-owner', f.connection.connectionId);
    expect(await read()).toEqual({ stage: 'queued' });
    message.queueCustody.seenByCatIds = ['codex-sol']; expect(await read()).toEqual({ stage: 'started' });
    message.queueCustody.failedByCatIds = ['codex-sol']; expect(await read()).toEqual({ stage: 'failed' });
    message.queueCustody.handledByCatIds = ['codex-sol']; expect(await read()).toEqual({ stage: 'ended' });
    message.userId = 'foreign-owner'; expect(await read()).toBeUndefined(); message.userId = 'local-owner';
    message.queueCustody.executionScope = 'ordinary'; expect(await read()).toBeUndefined();
    message.queueCustody.executionScope = 'collective-participation';
    expect(await ownerRequestExecution(request, thread, { async getById() { return message; } }, 'local-owner', 'another-connection')).toBeUndefined();
  } finally { await f.close(); }
});


test('an absent stable Task owner projection fails visibly instead of returning an empty owner view', async () => {
  const f = await setup(); try {
    const legacy = { ...f.tasks[0]! };
    Reflect.deleteProperty(legacy, 'userId');
    f.tasks[0] = legacy;
    const response = await f.invoke() as { status: number; body: { error?: string } };
    expect(response.status).toBe(409);
    expect(JSON.stringify(response.body)).toMatch(/Task read.*userId/);
  } finally { await f.close(); }
});

// Cross-repository acceptance explicitly supplies the reviewed compiled Host module.
// Ordinary package tests exercise the same declared projection using the typed fixture above.
if (process.env.C1_TASK_READ_HOST_MODULE) test('compiled Host four read ports cross the SDK and preserve the original owner Task summary', async () => {
  const { createPluginTaskHost } = await import(process.env.C1_TASK_READ_HOST_MODULE!);
  const base: PluginTaskReadItem = { id: 'actual-host-task', title: 'Original entrusted work', threadId: 'channel', kind: 'work',
    subjectKey: 'work:fixture', status: 'doing', ownerCatId: null, why: '', createdBy: 'local-owner', createdAt: 1,
    updatedAt: 1, userId: 'local-owner', entrustedWork: { revision: 3, closure: { state: 'open' },
      admission: { sourceRefs: ['message:view-source'] } } };
  const raw = { ...base, privateHostField: 'not-visible', entrustedWork: { ...base.entrustedWork!,
    admission: { ...base.entrustedWork!.admission, ownerReceipt: 'not-authority' }, execution: { grant: 'not-visible' } } };
  const legacy = { ...base, id: 'legacy-unowned' };
  Reflect.deleteProperty(legacy, 'userId'); Reflect.deleteProperty(legacy, 'entrustedWork');
  const taskHost: ModulePluginHostShape['tasks'] = createPluginTaskHost({ pluginId: 'official.collective-connector',
    effectiveGrants: ['task.read'], taskStore: { async get() { return raw; }, async getBySubject() { return raw; },
      async listByThread() { return [raw, legacy]; }, async listByKind() { return [raw, legacy]; } } });
  const results = [await taskHost.get(raw.id), await taskHost.getBySubject('work:fixture'),
    ...(await taskHost.listByThread('channel')), ...(await taskHost.listByKind('work'))];
  for (const result of results.filter(row => row?.id === raw.id)) expect(result).toEqual(base);
  for (const result of results.filter(row => row?.id === legacy.id)) expect(result!.userId).toBeNull();
  await expect(taskHost.update(raw.id, { status: 'done' })).rejects.toThrow(/task.write/);
  const f = await setup(taskHost); try {
    const response = await f.invoke() as { status: number; body: { tasks: unknown[] } };
    expect(response.status, JSON.stringify(response)).toBe(200);
    expect(response.body.tasks).toEqual([{ id: raw.id, title: raw.title, threadId: 'channel', status: 'doing',
      revision: 3, closure: 'open', sourceRefs: ['message:view-source'] }]);
  } finally { await f.close(); }
});
