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
async function setup() {
  const f = await fixture();
  const threads = new Map<string, { id: string; createdBy: string; participants: string[] }>([
    ['channel', { id: 'channel', createdBy: 'local-owner', participants: ['codex-sol'] }],
  ]);
  let creates = 0;
  const host: ModulePluginHostShape = { dataDirectory: f.root,
    config: { async get() { return undefined; } }, secrets: { async get() { return undefined; } },
    storage: {} as never, tasks: {} as never, threads: {} as never, media: {} as never, messaging: {} as never, log() {},
    participantRoster: { async listForNativeContribution() { return [{ catId: 'codex-sol', displayName: 'Sol', defaultModel: 'fixture', supported: true }]; } },
    nativeContext: { async current() { throw new Error('Owner policy must not borrow a native invocation'); } },
    ownerThreads: { async get(id) { return threads.get(id) ?? null; }, async create() {
      const row = { id: 'owner-thread-' + ++creates, createdBy: 'local-owner', participants: [] as string[] }; threads.set(row.id, row); return row;
    }, async addParticipants({ threadId, catIds }) { const row = threads.get(threadId)!; row.participants = [...new Set([...row.participants, ...catIds])]; return row; } },
    browserServices: { async getBinding(id) { return { contributionId: id, origin: 'http://127.0.0.1:5271', parentOrigin: 'http://localhost:5172',
      clientBuildId: 'collective-client-v2', assetDigest: 'a'.repeat(64), limits: BROWSER_SERVICE_LIMITS, async assertCurrent() {} }; },
      async dispatchLocal() { throw new Error('The fixture connection uses its original remote Service'); } },
  };
  const active = await entrypoint.create(manifest).start(host);
  const route = async () => JSON.parse(await readFile(join(f.root, 'connector/collective-connector.json'), 'utf8')).hostRoutes[f.connection.connectionId];
  return { ...f, active, threads, route, get creates() { return creates; }, async close() { await active.stop(); await f.close(); } };
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
