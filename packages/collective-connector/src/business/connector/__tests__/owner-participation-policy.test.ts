import { expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import { BROWSER_SERVICE_LIMITS } from '@clowder-ai/plugin-sdk';
import entrypoint from '../../../plugin-entrypoint.js';
import { fixture } from './communication-work-custody.fixture.js';

const manifest = parse(await readFile(new URL('../../../../plugin.yaml', import.meta.url), 'utf8'));
const request = (connectionId: string, body: unknown, owner = 'local-owner', method = 'PUT') => ({ request: {
  method, path: `connections/${connectionId}/participation/policy`, body, headers: { origin: 'http://localhost:5172' },
  principal: { kind: 'owner', id: owner },
} });
async function setup(clearAgentRoutes = false) {
  const f = await fixture();
  if (clearAgentRoutes) {
    const prior = (await f.connector.getHostRoute(f.connection.connectionId))!;
    await f.connector.setHostRoute(f.connection.connectionId, { localOwnerUserId: prior.localOwnerUserId, defaultIngressThreadId: prior.defaultIngressThreadId, humanNotificationThreadId: prior.humanNotificationThreadId, agentRoutes: {} }, prior.revision);
  }
  const threads = new Map<string, { id: string; createdBy: string; participants: string[] }>([
    ['channel', { id: 'channel', createdBy: 'local-owner', participants: ['codex-sol'] }],
  ]);
  let creates = 0, stale = false;
  const roster = [{ catId: 'codex-sol', displayName: 'Sol', defaultModel: 'fixture', supported: true }];
  const host: ModulePluginHostShape = { dataDirectory: f.root,
    config: { async get() { return undefined; } }, secrets: { async get() { return undefined; } },
    storage: {} as never, tasks: {} as never, threads: {} as never, media: {} as never, messaging: {} as never, log() {},
    participantRoster: { async listForNativeContribution() { return roster; } },
    nativeContext: { async current() { throw new Error('Owner policy must not borrow a native invocation'); } },
    ownerThreads: { async get(id) { return threads.get(id) ?? null; }, async create() {
      const row = { id: 'owner-thread-' + ++creates, createdBy: 'local-owner', participants: [] as string[] }; threads.set(row.id, row); return row;
    }, async addParticipants({ threadId, catIds }) { const row = threads.get(threadId)!; row.participants = [...new Set([...row.participants, ...catIds])]; return row; } },
    browserServices: { async getBinding(id) { return { contributionId: id, origin: 'http://127.0.0.1:5271', parentOrigin: 'http://localhost:5172',
      clientBuildId: 'collective-client-v2', assetDigest: 'a'.repeat(64), limits: BROWSER_SERVICE_LIMITS, async assertCurrent() { if (stale) throw new Error('Owner request expired'); } }; },
      async dispatchLocal() { throw new Error('The fixture connection uses its original remote Service'); } },
  };
  const active = await entrypoint.create(manifest).start(host);
  const route = async () => JSON.parse(await readFile(join(f.root, 'connector/collective-connector.json'), 'utf8')).hostRoutes[f.connection.connectionId];
  return { ...f, active, threads, route, roster, expire() { stale = true; }, get creates() { return creates; }, async close() { await active.stop(); await f.close(); } };
}
const policy = (excluded: string[] = []) => ({ defaultMode: 'include', excludedCatIds: excluded,
  channelOverrides: { general: { excludedCatIds: [] } } });

test('retained PUT participation/policy is declared in the owning feature', () => {
  const contribution = manifest.contributions.find((c: { path?: string }) => c.path === 'connections/:connectionId/participation/policy');
  expect(contribution).toMatchObject({ type: 'webhook', methods: ['PUT'], action: { method: 'collective.control.http' } });
  expect(manifest.features[0].contributions).toContainEqual({ type: 'webhook', id: contribution.id });
});
test('actual module retains owner exclusions and exact route revision across policy changes without new native or Task authority', async () => {
  const f = await setup();
  try {
    const invoke = f.active.actions['collective.control.http']!;
    const before = await f.route();
    const excluded = await invoke(request(f.connection.connectionId, { expectedRevision: before.revision, channelIds: ['general'], policy: policy(['codex-sol']) }));
    expect(excluded).toMatchObject({ status: 200, body: { published: true } });
    const after = await f.route();
    expect(after.desiredParticipation.excludedCatIds).toEqual(['codex-sol']);
    expect(after.channelRoutes.general.participants).toEqual({});
    const threadId = after.channelRoutes.general.threadId;
    const included = await invoke(request(f.connection.connectionId, { expectedRevision: after.revision, channelIds: ['general'], policy: policy() }));
    expect(included).toMatchObject({ status: 200 });
    const restored = await f.route();
    expect(restored.channelRoutes.general.threadId).toBe(threadId);
    expect(restored.channelRoutes.general.participants).toHaveProperty('codex-sol');
    expect(restored.agentRoutes).toEqual(before.agentRoutes);
    expect(f.creates).toBe(1);
  } finally { await f.close(); }
});
test('actual module refuses stale revision, foreign owner and body identity before changing policy or threads', async () => {
  const f = await setup();
  try {
    const invoke = f.active.actions['collective.control.http']!, before = await f.route();
    const input = { expectedRevision: before.revision, channelIds: ['general'], policy: policy() };
    expect(await invoke(request(f.connection.connectionId, input, 'foreign-owner'))).toMatchObject({ status: 403, body: { code: 'CONNECTOR_OWNER_MISMATCH' } });
    expect(await invoke(request(f.connection.connectionId, { ...input, expectedRevision: before.revision + 1 }))).toMatchObject({ status: 409, body: { code: 'PARTICIPATION_REVISION_CONFLICT' } });
    expect(await invoke(request(f.connection.connectionId, { ...input, userId: 'local-owner' }))).toMatchObject({ status: 400, body: { code: 'INVALID_PARTICIPATION_REQUEST' } });
    expect(await f.route()).toEqual(before); expect(f.creates).toBe(0);
  } finally { await f.close(); }
});
test('actual module keeps PUT policy and POST reconcile distinct and rejects native/Settings contexts', async () => {
  const f = await setup();
  try {
    const invoke = f.active.actions['collective.control.http']!, before = await f.route();
    const input = { expectedRevision: before.revision, channelIds: ['general'], policy: policy() };
    expect(await invoke(request(f.connection.connectionId, input, 'local-owner', 'POST'))).toMatchObject({ status: 405 });
    await expect(invoke(request(f.connection.connectionId, input), { userId: 'local-owner' } as never)).rejects.toThrow(/webhook/);
    await expect(invoke(request(f.connection.connectionId, input), undefined, { kind: 'owner-operation' } as never)).rejects.toThrow();
    expect(await f.route()).toEqual(before); expect(f.creates).toBe(0);
  } finally { await f.close(); }
});

const individualRequest = (id: string, body: unknown, owner = 'local-owner') => ({ request: {
  method: 'PUT', path: `connections/${id}/participation`, body, headers: { origin: 'http://localhost:5172' },
  principal: { kind: 'owner', id: owner },
} });
const individualInput = (revision: number, enabled = true) => ({ catId: 'codex-sol', enabled,
  expectedRevision: revision, channelIds: ['general'], standingWork: { requestingHumanIds: ['requesting-human'], expiresAt: null } });

test('original individual participation PUT is declared alongside retained owner GET', () => {
  const c = manifest.contributions.find((c: { path?: string }) => c.path === 'connections/:connectionId/participation');
  expect(c).toMatchObject({ methods: ['GET', 'PUT'], action: { method: 'collective.control.http' } });
});
test('actual module preserves individual participation, standing-work scope and owner thread across disable/restore', async () => {
  const f = await setup(); try {
    const invoke = f.active.actions['collective.control.http']!;
    const before = await f.route(), key = `${f.owner.human.humanId}:codex-sol`;
    expect(await invoke(individualRequest(f.connection.connectionId, individualInput(before.revision)))).toMatchObject({ status: 200, body: { published: true } });
    const enabled = await f.route();
    expect(enabled.agentRoutes[key]).toMatchObject({ catId: 'codex-sol', threadId: 'channel', participation: { channelIds: ['general'] },
      standingWork: { channelIds: ['general'], requestingHumanIds: ['requesting-human'], expiresAt: null } });
    expect(enabled.agentRoutes[key].standingWorkRevision).toBeGreaterThan(0);
    expect(await invoke(individualRequest(f.connection.connectionId, individualInput(enabled.revision, false)))).toMatchObject({ status: 200 });
    const disabled = await f.route(); expect(disabled.agentRoutes[key]).toEqual({ catId: 'codex-sol', threadId: 'channel' });
    expect(await invoke(individualRequest(f.connection.connectionId, individualInput(disabled.revision)))).toMatchObject({ status: 200 });
    const restored = await f.route(); expect(restored.agentRoutes[key].threadId).toBe('channel');
    expect(restored.agentRoutes[key].standingWorkRevision).toBeGreaterThan(enabled.agentRoutes[key].standingWorkRevision);
    expect(f.creates).toBe(0);
  } finally { await f.close(); }
});
test('individual mutation rejects stale/foreign/body identity and unsupported Cat before owner effects', async () => {
  const f = await setup(); try {
    const invoke = f.active.actions['collective.control.http']!, before = await f.route(), body = individualInput(before.revision);
    expect(await invoke(individualRequest(f.connection.connectionId, body, 'foreign-owner'))).toMatchObject({ status: 403, body: { code: 'CONNECTOR_OWNER_MISMATCH' } });
    expect(await invoke(individualRequest(f.connection.connectionId, { ...body, expectedRevision: before.revision + 1 }))).toMatchObject({ status: 409, body: { code: 'PARTICIPATION_REVISION_CONFLICT' } });
    expect(await invoke(individualRequest(f.connection.connectionId, { ...body, userId: 'local-owner' }))).toMatchObject({ status: 400, body: { code: 'INVALID_PARTICIPATION_REQUEST' } });
    f.roster[0]!.supported = false;
    expect(await invoke(individualRequest(f.connection.connectionId, body))).toMatchObject({ status: 422, body: { code: 'PARTICIPATION_UNSUPPORTED' } });
    expect(await f.route()).toEqual(before); expect(f.creates).toBe(0);
  } finally { await f.close(); }
});
test('individual mutation preserves owned-thread refusal, per-connection serialization and currentness', async () => {
  const f = await setup(); try {
    const invoke = f.active.actions['collective.control.http']!, before = await f.route(), body = individualInput(before.revision);
    f.threads.get('channel')!.createdBy = 'foreign-owner';
    expect(await invoke(individualRequest(f.connection.connectionId, body))).toMatchObject({ status: 409, body: { code: 'ROUTE_THREAD_UNAVAILABLE' } });
    expect(await f.route()).toEqual(before);
    f.threads.get('channel')!.createdBy = 'local-owner';
    const results = await Promise.all([invoke(individualRequest(f.connection.connectionId, body)), invoke(individualRequest(f.connection.connectionId, body))]);
    expect(results.map(r => (r as { status: number }).status).sort()).toEqual([200, 409]);
    const after = await f.route(); expect(after.revision).toBe(before.revision + 1); expect(f.creates).toBe(0);
    f.expire(); await expect(invoke(individualRequest(f.connection.connectionId, individualInput(after.revision)))).rejects.toThrow(/expired/);
    expect(await f.route()).toEqual(after);
  } finally { await f.close(); }
});

test('individual mutation creates one owned thread for a new Cat binding and reuses it on repeated edits', async () => {
  const f = await setup(true); try {
    const invoke = f.active.actions['collective.control.http']!, before = await f.route();
    expect(await invoke(individualRequest(f.connection.connectionId, individualInput(before.revision)))).toMatchObject({ status: 200 });
    const after = await f.route(), key = `${f.owner.human.humanId}:codex-sol`;
    expect(after.agentRoutes[key].threadId).toBe('owner-thread-1');
    expect(f.threads.get('owner-thread-1')).toEqual({ id: 'owner-thread-1', createdBy: 'local-owner', participants: ['codex-sol'] });
    expect(await invoke(individualRequest(f.connection.connectionId, individualInput(after.revision)))).toMatchObject({ status: 200 });
    expect((await f.route()).agentRoutes[key].threadId).toBe('owner-thread-1'); expect(f.creates).toBe(1);
  } finally { await f.close(); }
});
test('revoked connection cannot change individual participation or standing-work authority', async () => {
  const f = await setup(); try {
    const invoke = f.active.actions['collective.control.http']!;
    expect(await invoke({ request: { method: 'POST', path: `connections/${f.connection.connectionId}/revoke`,
      headers: { origin: 'http://localhost:5172' }, principal: { kind: 'owner', id: 'local-owner' } } })).toMatchObject({ status: 200 });
    const before = await f.route();
    expect(await invoke(individualRequest(f.connection.connectionId, individualInput(before.revision)))).toMatchObject({ status: 409, body: { code: 'PARTICIPATION_REVOKED' } });
    expect(await f.route()).toEqual(before); expect(f.creates).toBe(0);
  } finally { await f.close(); }
});
