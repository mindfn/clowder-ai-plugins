import { expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { ModulePluginHostShape, PluginNativeContext, PluginOwnerOperationContext } from '@clowder-ai/plugin-sdk';
import { BROWSER_SERVICE_LIMITS } from '@clowder-ai/plugin-sdk';
import entrypoint from '../../../plugin-entrypoint.js';
import { fixture } from './communication-work-custody.fixture.js';

const manifest = parse(await readFile(new URL('../../../../plugin.yaml', import.meta.url), 'utf8'));
test('actual module sends one named wake and handles native context before the send receipt', async () => {
  const f = await fixture();
  let native: PluginNativeContext;
  const calls: string[] = [];
  const current = async () => {};
  const owner: PluginOwnerOperationContext = { kind: 'owner-operation', userId: 'local-owner', pluginInstanceId: 'installed-instance',
    operationKey: 'participation', actionId: 'sync', requestId: 'owner-sync', signal: new AbortController().signal, assertCurrent: current };
  const host: ModulePluginHostShape = {
    dataDirectory: f.root, config: { async get() { return undefined; } }, secrets: { async get() { return undefined; } },
    storage: {} as never, tasks: {} as never, threads: {} as never, media: {} as never, log() {},
    participantRoster: { async listForNativeContribution() { return [{ catId: 'codex-sol', displayName: 'Sol', defaultModel: 'fixture', supported: true }]; } },
    ownerThreads: { async get(id) { return { id, createdBy: owner.userId, participants: ['codex-sol'] }; },
      async create() { throw new Error('Unused'); }, async addParticipants() { throw new Error('Unused'); } },
    nativeContext: { async current() { return structuredClone(native); } },
    publicInvocations: { async enqueue() { throw new Error('Single send/wake must not enqueue separately'); } },
    messaging: { async subscribe() {}, async unsubscribe() {}, async send(draft) {
      const threadId = draft.threadId;
      calls.push('send');
      expect(draft.wake).toEqual({ catId: 'codex-sol' });
      native = { userId: owner.userId, threadId, catId: 'codex-sol', invocationId: 'real-native', originTriggerMessageId: 'message-origin',
        source: { id: 'message-origin', userId: owner.userId, threadId, catId: null,
          content: (draft.payload.elements[0]!.payload as { text: string }).text, source: { connector: 'collective', meta: draft.meta },
          extra: { pluginMessage: { instanceId: owner.pluginInstanceId } } } };
      const action = { userId: owner.userId, threadId, catId: 'codex-sol', invocationId: 'real-native', assertCurrent: current };
      const early = await active!.actions['collective.context.current']!({}, action);
      expect(early).toHaveProperty('contextRef');
      calls.push('native-before-receipt');
      return { messageId: 'message-origin', threadId };
    } },
    browserServices: { async getBinding(id) { return { contributionId: id, origin: 'http://127.0.0.1:5271', parentOrigin: 'http://localhost:5172',
      clientBuildId: 'collective-client-v2', assetDigest: 'a'.repeat(64), limits: BROWSER_SERVICE_LIMITS, assertCurrent: current }; },
      async dispatchLocal() { throw new Error('Not this origin'); } },
  };
  let active: Awaited<ReturnType<ReturnType<typeof entrypoint.create>['start']>> | undefined;
  try {
    expect(manifest.contributions.find((item: { type: string; id: string }) => item.type === 'mcp' && item.id === 'collective-native')).toBeDefined();
    active = await entrypoint.create(manifest).start(host);
    expect(active.publicInvocationVerifier).toBeTypeOf('function');
    const roster = await active.actions['collective.control.http']!({ request: { method: 'GET', path: 'entry-roster',
      headers: { origin: 'http://localhost:5172' }, principal: { kind: 'owner', id: owner.userId } } });
    expect(roster).toMatchObject({ status: 200, body: { cats: [{ id: 'codex-sol', eligible: true }] } });
    await expect(active.actions['collective.owner.connections']!({}, undefined, { ...owner, actionId: 'list' })).rejects.toThrow();
    await expect(active.actions['collective.owner.connections']!({ input: { userId: owner.userId } }, undefined, { ...owner, actionId: 'list' })).rejects.toThrow();
    await expect(active.actions['collective.owner.connections']!({ input: {} }, undefined, { ...owner, actionId: 'list' })).resolves.toMatchObject({ render: 'rows', data: { rows: [{ actions: [{ input: { connectionId: f.connection.connectionId } }] }] } });
    await expect(active.actions['collective.owner.sync']!({ input: { connectionId: f.connection.connectionId } })).rejects.toThrow();
    const admitted = await active.actions['collective.owner.sync']!({ input: { connectionId: f.connection.connectionId } }, undefined, owner);
    expect(admitted).toMatchObject({ render: 'rows', data: { rows: [{ key: f.source.eventId, detail: expect.stringContaining('message-origin') }] } });
    expect(calls).toEqual(['send', 'native-before-receipt']);
    const action = { userId: owner.userId, threadId: 'channel', catId: 'codex-sol', invocationId: 'real-native', assertCurrent: current };
    const result = await active.actions['collective.context.current']!({}, action) as { contextRef: string; returnRef: string; replyOperationRef: string };
    const binding = JSON.parse(await readFile(join(f.root, 'connector/collective-connector.json'), 'utf8'));
    expect(JSON.stringify(binding)).toContain('message:message-origin');
    await expect(active.actions['collective.reply.submit']!({ returnRef: result.returnRef, replyOperationRef: result.replyOperationRef, body: 'Original reply' }, action))
      .resolves.toMatchObject({ reply: { status: 'accepted', body: 'Original reply', author: { sessionRef: 'real-native' } } });
    await active.stop();
    await expect(active.actions['collective.context.current']!({}, action)).rejects.toThrow(/revoked|stopped/);
  } finally { await active?.stop(); await f.close(); }
});
