import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isCollectiveLocalEcho } from '../public-source-custody.js';
import { publicSourceFixture as setup } from './public-source-caller.fixture.js';

it('persists source without wake, commits the inbox binding, then enqueues one declared target; verifier rechecks real Service', async () => {
  const f = await setup(); try {
    const receipt = await f.admit();
    expect(receipt).toEqual({ messageRef: 'message:host-source', entryId: 'queue-entry', status: 'queued' });
    if ('kind' in receipt) throw new Error('Expected Queue receipt for non-echo source');
    expect(f.calls.map((call: any) => call[0])).toEqual(['thread', 'send', 'enqueue']);
    const draft = (f.calls[1] as any)[2]; expect(draft.wake).toBeUndefined();
    expect(draft.meta.participation).toEqual(f.source);
    expect(draft.payload.provenance).toEqual({ origin: { kind: 'plugin', instanceId: 'installed-instance' }, epistemicStatus: 'observation' });
    const binding = f.connector.readCurrentPublicSource(receipt.messageRef);
    expect(await f.sourceCaller.publicInvocationVerifier({ authority: binding.authority, source: { messageRef: receipt.messageRef },
      targetCatId: binding.targetCatId, native: binding.native }, { signal: new AbortController().signal, async assertCurrent() {} })).toEqual({ current: true });
    const resolved = await f.sourceCaller.resolveNative(f.action, 'collective.context.current');
    expect(resolved.source).toEqual(f.source); expect(resolved.auth.invocationId).toEqual(f.action.invocationId);
  } finally { await f.close(); }
});

it('lost admission response preserves real persisted source and retries the same binding without another send', async () => {
  const f = await setup(); try {
    f.lose(); await expect(f.admit()).rejects.toThrow('Admission response lost');
    const before = f.connector.readCurrentPublicSource('message:host-source');
    f.recover(); await f.admit();
    expect(f.connector.readCurrentPublicSource('message:host-source')).toEqual(before);
    expect(f.calls.filter((call: any) => call[0] === 'send')).toHaveLength(1);
    expect(f.calls.filter((call: any) => call[0] === 'enqueue')).toHaveLength(2);
  } finally { await f.close(); }
});

it('verifier rejects forged authority/method/target, endpoint revocation, and abort; no ALS reads or receipt fallback', async () => {
  const f = await setup(); try {
    await f.admit(); const binding = f.connector.readCurrentPublicSource('message:host-source');
    const input = { authority: binding.authority, source: { messageRef: binding.messageRef as `message:${string}` }, targetCatId: binding.targetCatId, native: binding.native };
    const context = { signal: new AbortController().signal, async assertCurrent() {} };
    for (const change of [{ authority: { ...input.authority, revision: 'forged' } }, { targetCatId: 'foreign' },
      { native: { ...input.native, methods: ['collective.reply.submit'] } }]) {
      await expect(f.sourceCaller.publicInvocationVerifier({ ...input, ...change }, context)).rejects.toMatchObject({ code: 'PUBLIC_SOURCE_CHANGED' });
    }
    await expect(f.sourceCaller.publicInvocationVerifier(input, { ...context, signal: AbortSignal.abort(new Error('Aborted')) })).rejects.toThrow('Aborted');
    await f.connector.revoke(f.connection.connectionId);
    await expect(f.sourceCaller.publicInvocationVerifier(input, context)).rejects.toMatchObject({ code: 'PARTICIPATION_REVOKED' });
  } finally { await f.close(); }
});

it('native body identity cannot replace authenticated context, exact origin/instance/content or Service currentness', async () => {
  const f = await setup(); try {
    await f.admit();
    for (const change of [{ catId: 'foreign' }, { invocationId: 'foreign' }, { threadId: 'foreign' }, { userId: 'foreign' }])
      await expect(f.sourceCaller.resolveNative({ ...f.action, ...change }, 'collective.context.current')).rejects.toMatchObject({ code: 'PUBLIC_SOURCE_CHANGED' });
    f.updateFact({ extra: { pluginMessage: { instanceId: 'foreign' } } });
    await expect(f.sourceCaller.resolveNative(f.action, 'collective.context.current')).rejects.toMatchObject({ code: 'PUBLIC_SOURCE_CHANGED' });
    f.updateFact({ extra: { pluginMessage: { instanceId: 'installed-instance' } }, content: 'forged' });
    await expect(f.sourceCaller.resolveNative(f.action, 'collective.context.current')).rejects.toMatchObject({ code: 'PUBLIC_SOURCE_CHANGED' });
    f.updateFact({ content: (await f.connector.listInbox(f.connection.connectionId)).find(item => item.event.eventId === f.source.eventId)!.event.body });
    f.expire(); await expect(f.sourceCaller.resolveNative(f.action, 'collective.context.current')).rejects.toThrow('Caller expired');
  } finally { await f.close(); }
});


it('does not send or enqueue after the Service revokes permission while the owner thread check is in flight', async () => {
  const f = await setup(); try {
    f.beforeThread(async () => { await f.store.revokeConnection({ sessionToken: f.serviceOwner.sessionToken,
      collectiveId: f.connection.collectiveId, connectionId: f.connection.connectionId }); });
    await expect(f.admit()).rejects.toBeInstanceOf(Error);
    expect(f.calls.filter((call: any) => call[0] === 'send' || call[0] === 'enqueue')).toHaveLength(0);
  } finally { await f.close(); }
});

it('a resolved native caller rechecks real Service permission before a later reply; currentness is not cached', async () => {
  const f = await setup(); try {
    await f.admit(); const resolved = await f.sourceCaller.resolveNative(f.action, 'collective.reply.submit');
    await f.store.revokeConnection({ sessionToken: f.serviceOwner.sessionToken, collectiveId: f.connection.collectiveId,
      connectionId: f.connection.connectionId });
    await expect(resolved.revalidate()).rejects.toBeInstanceOf(Error);
    // Local mapping still exists. The refusal is the Service truth, not merely local map deletion.
    expect(f.connector.readCurrentPublicSource('message:host-source')).toEqual(resolved.binding);
  } finally { await f.close(); }
});


it('a late admission result after owner stop is refused without pretending to undo persisted Host effects', async () => {
  const f = await setup(); try {
    f.afterEnqueue(() => f.expire());
    await expect(f.admit()).rejects.toThrow('Caller expired');
    expect(f.connector.readCurrentPublicSource('message:host-source').source).toEqual(f.source);
    expect(f.calls.filter((call: any) => call[0] === 'enqueue')).toHaveLength(1);
  } finally { await f.close(); }
});

it('returns local_echo for a real same-connection Agent publication before routing, Host send or Queue admission', async () => {
  const f = await setup(); try {
    const state = JSON.parse(await readFile(join(f.root, 'connector', 'collective-connector.json'), 'utf8'));
    const event = await f.store.postAgentMessage(state.connections[f.connection.connectionId].endpointCredential, {
      serviceInstanceId: f.connection.serviceInstanceId, collectiveId: f.connection.collectiveId,
      connectionId: f.connection.connectionId, clientEventId: 'same-connection-echo', agent: f.agent,
      location: f.source.location, recipient: { kind: 'agent', humanId: f.serviceOwner.human.humanId,
        connectionId: f.connection.connectionId, agentId: f.source.catId, participationRevision: 1 },
      replyToEventId: f.source.eventId, body: 'My own public Agent message',
    });
    expect(event.actor.kind).toBe('agent');
    if (event.actor.kind !== 'agent') throw new Error('Expected Agent publication');
    expect(event.actor.provenance.connectionId).toBe(f.connection.connectionId);
    await f.connector.sync(f.connection.connectionId);
    const before = (await f.connector.listInbox(f.connection.connectionId)).find(item => item.event.eventId === event.eventId);
    expect(await f.sourceCaller.admitAgentEvent(f.connection.connectionId, event.eventId, f.owner)).toEqual({ kind: 'local_echo' });
    expect(f.calls).toEqual([]);
    expect((await f.connector.listInbox(f.connection.connectionId)).find(item => item.event.eventId === event.eventId)).toEqual(before);
    // Even a caller that bypasses the bridge cannot turn this retained echo into a verifier source.
    await f.connector.beginInboxRouting(f.connection.connectionId, event.eventId, 1);
    await expect(f.connector.recordPublicSource({ connectionId: f.connection.connectionId, eventId: event.eventId,
      pluginInstanceId: 'installed-instance', ownerUserId: 'local-owner', threadId: 'channel', messageRef: 'message:echo',
      native: { contributionId: 'collective-native', methods: ['collective.context.current'] } })).rejects.toMatchObject({ code: 'PUBLIC_SOURCE_LOCAL_ECHO' });
    expect((await f.connector.listInbox(f.connection.connectionId)).find(item => item.event.eventId === event.eventId)?.publicSource).toBeUndefined();
  } finally { await f.close(); }
});

it('does not classify a real same-connection Work acceptance notice as local echo or admit it through the ordinary consumer', async () => {
  const f = await setup(); try {
    await f.connector.adoptWorkPolicy(f.connection.connectionId, 'local-owner', f.policy.revision);
    await f.connector.acceptWork(f.source, f.agent, f.input);
    await f.connector.sync(f.connection.connectionId);
    const item = (await f.connector.listInbox(f.connection.connectionId)).find(item => item.event.workAcceptanceNotice);
    expect(item).toBeDefined();
    if (!item) throw new Error('Expected real Work acceptance notice');
    expect(item.event.actor.kind).toBe('agent');
    expect(isCollectiveLocalEcho(item.event, f.connection.connectionId)).toBe(false);
    await expect(f.sourceCaller.admitAgentEvent(f.connection.connectionId, item.event.eventId, f.owner))
      .rejects.toMatchObject({ code: 'PUBLIC_SOURCE_UNAVAILABLE' });
    expect(f.calls).toEqual([]);
    expect((await f.connector.listInbox(f.connection.connectionId)).find(candidate => candidate.event.eventId === item.event.eventId)?.publicSource).toBeUndefined();
  } finally { await f.close(); }
});
