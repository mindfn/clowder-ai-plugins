import { expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './communication-work-custody.fixture.js';
import type { PluginActionContext, PluginNativeContext, PluginSourceFact, PluginOwnerOperationContext } from '@clowder-ai/plugin-sdk';

export async function publicSourceFixture(options: { methods?: readonly string[]; invocationId?: string } = {}) {
  const module = await import('../../../collective-public-source.js');
  const f = await fixture(); await f.connector.sync(f.connection.connectionId);
  const calls: unknown[] = []; let expired = false, lost = false, native: PluginNativeContext;
  let beforeThread: (() => Promise<void>) | undefined, afterEnqueue: (() => void) | undefined;
  const current = async () => { if (expired) throw new Error('Caller expired'); };
  const owner: PluginOwnerOperationContext = { kind: 'owner-operation', userId: 'local-owner', pluginInstanceId: 'installed-instance',
    operationKey: 'sync', actionId: 'sync', requestId: 'request', signal: new AbortController().signal, assertCurrent: current };
  const sourceCaller = module.createCollectivePublicSourceCaller({ connector: f.connector,
    native: { contributionId: 'collective-native', methods: options.methods ?? ['collective.reply.submit', 'collective.context.current'] },
    ownerThreads: { async get(id) { calls.push(['thread', id]); await beforeThread?.(); return { id, createdBy: owner.userId, participants: ['codex-sol'] }; },
      async create() { throw new Error('Unused'); }, async addParticipants() { throw new Error('Unused'); } },
    messaging: { async subscribe() { throw new Error('Unused'); }, async unsubscribe() { throw new Error('Unused'); }, async send(threadId, draft) { calls.push(['send', threadId, draft]);
      native = { userId: owner.userId, threadId, catId: 'codex-sol', invocationId: options.invocationId ?? 'native-invocation', originTriggerMessageId: 'host-source',
        source: { id: 'host-source', userId: owner.userId, threadId, catId: null, content: (draft.payload.elements[0]!.payload as { text: string }).text, source: { connector: 'collective', meta: draft.meta },
          extra: { pluginMessage: { instanceId: owner.pluginInstanceId } } } };
      return { messageId: 'host-source', threadId }; } },
    publicInvocations: { async enqueue(input) { calls.push(['enqueue', input]);
      const persisted = f.connector.readCurrentPublicSource(input.messageRef);
      expect(persisted.authority).toEqual(input.authority);
      if (lost) throw new Error('Admission response lost');
      afterEnqueue?.();
      return { messageRef: input.messageRef, entryId: 'queue-entry', status: 'queued' }; } },
    nativeContext: { async current() { return structuredClone(native); } },
  });
  const admit = () => sourceCaller.admitAgentEvent(f.connection.connectionId, f.source.eventId, owner);
  const action: PluginActionContext = { userId: owner.userId, threadId: 'channel', catId: 'codex-sol', invocationId: options.invocationId ?? 'native-invocation', assertCurrent: current };
  return { ...f, serviceOwner: f.owner, owner, calls, sourceCaller, admit, action, get native() { return native; }, beforeThread(fn: () => Promise<void>) { beforeThread = fn; }, afterEnqueue(fn: () => void) { afterEnqueue = fn; }, updateFact(source: Partial<PluginSourceFact>) { native = { ...native, source: { ...native.source, ...source } }; }, expire() { expired = true; }, lose() { lost = true; }, recover() { lost = false; } };
}

