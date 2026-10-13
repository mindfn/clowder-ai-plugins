import { isDeepStrictEqual } from 'node:util';
import type { FeatureContext, PluginActionContext, PluginNativeContextHost, PluginOwnerOperationContext,
  PluginOwnerThreadHost, PluginPublicInvocationHost, PluginPublicInvocationVerifier } from '@clowder-ai/plugin-sdk';
import type { CollectiveConnector } from './business/connector/connector.js';
import { collectiveEventSourceIdentity } from './business/contracts/index.js';
import { resolveMaterializedParticipation, participationError } from './business/connector/participation-custody.js';
import { isCollectiveLocalEcho } from './business/connector/public-source-custody.js';
import { collectiveSource, ingressIdempotencyKey } from './collective-ingress-routing.js';

interface PublicSourceCallerOptions {
  readonly connector: Pick<CollectiveConnector, 'listInbox' | 'getHostRoute' | 'beginInboxRouting' |
    'recordPublicSource' | 'readCurrentPublicSource' | 'readParticipationContext'>;
  readonly native: { readonly contributionId: string; readonly methods: readonly string[] };
  readonly messaging: FeatureContext['messaging'];
  readonly publicInvocations: PluginPublicInvocationHost;
  readonly nativeContext: PluginNativeContextHost;
  readonly ownerThreads: PluginOwnerThreadHost;
}
const changed = () => participationError('PUBLIC_SOURCE_CHANGED', 'Exact public source or native invocation changed');

/** Ordinary exact-agent source bridge. Work/reconsideration and channel-selection retain their original separate consumers.
 * Not registered by the production entrypoint until the corresponding native handlers/declaration are complete. */
export function createCollectivePublicSourceCaller(options: PublicSourceCallerOptions) {
  // Module configuration is not a native tool selector. Snapshot before any asynchronous caller can mutate it.
  const native = { contributionId: options.native.contributionId, methods: [...options.native.methods].sort() };
  const currentSource = async (messageRef: string, current: () => Promise<void>) => {
    await current();
    const binding = options.connector.readCurrentPublicSource(messageRef);
    const context = await options.connector.readParticipationContext(binding.source, 0, 1);
    await current();
    const after = options.connector.readCurrentPublicSource(messageRef);
    if (!isDeepStrictEqual(binding, after)) throw changed();
    return { binding, context };
  };
  const publicInvocationVerifier: PluginPublicInvocationVerifier = async (input, context) => {
    const current = async () => { context.signal.throwIfAborted(); await context.assertCurrent(); context.signal.throwIfAborted(); };
    // Host ABI context is isolated. This only reads the package's existing private inbox and Service.
    // No sourceFacts/nativeContext/ALS read, no Queue receipt substituted for permission.
    const { binding } = await currentSource(input.source.messageRef, current);
    if (!isDeepStrictEqual(input.authority, binding.authority) || input.targetCatId !== binding.targetCatId ||
      !isDeepStrictEqual(input.native, binding.native) || !isDeepStrictEqual(binding.native, native)) throw changed();
    await current();
    return Object.freeze({ current: true as const });
  };
  return Object.freeze({
    publicInvocationVerifier,
    async admitAgentEvent(connectionId: string, eventId: string, owner: PluginOwnerOperationContext) {
      if (owner.kind !== 'owner-operation') throw changed();
      const current = async () => { owner.signal.throwIfAborted(); await owner.assertCurrent(); owner.signal.throwIfAborted(); };
      await current();
      const route = await options.connector.getHostRoute(connectionId);
      if (!route || route.localOwnerUserId !== owner.userId) throw changed();
      const item = (await options.connector.listInbox(connectionId)).find(item => item.event.eventId === eventId);
      if (!item) throw changed();
      if (isCollectiveLocalEcho(item.event, connectionId)) {
        await current();
        return Object.freeze({ kind: 'local_echo' as const });
      }
      const source = collectiveEventSourceIdentity(item.event);
      if (!source || source.connectionId !== connectionId || item.event.target.kind !== 'agent' ||
        item.event.workRequest || item.event.workAcceptanceNotice || item.event.workExecutionNotice || item.event.workRevisionNotice)
        throw participationError('PUBLIC_SOURCE_UNAVAILABLE', 'This source requires its original authority consumer');
      const destination = resolveMaterializedParticipation(route, item.event.target.humanId, source.catId, source.location.channelId);
      if (!destination) throw changed();
      const currentDestination = async () => {
        await options.connector.readParticipationContext(source, 0, 1); await current();
        const after = await options.connector.getHostRoute(connectionId); await current();
        const next = after && resolveMaterializedParticipation(after, item.event.target.kind === 'agent' ? item.event.target.humanId : '',
          source.catId, source.location.channelId);
        if (after?.localOwnerUserId !== owner.userId || !isDeepStrictEqual(next, destination)) throw changed();
      };
      await options.connector.readParticipationContext(source, 0, 1); await current();
      const thread = await options.ownerThreads.get(destination.threadId); await current();
      if (!thread || thread.createdBy !== owner.userId || !thread.participants.includes(source.catId)) throw changed();
      let messageRef: `message:${string}`;
      if (item.publicSource) {
        const existing = options.connector.readCurrentPublicSource(item.publicSource.messageRef);
        if (existing.pluginInstanceId !== owner.pluginInstanceId || !isDeepStrictEqual(existing.native, native)) throw changed();
        messageRef = existing.messageRef as `message:${string}`;
      } else {
        await options.connector.beginInboxRouting(connectionId, eventId, route.revision); await current();
        const projected = collectiveSource(item.event, source);
        await currentDestination();
        // Host persists visible source and owns event emission; this does not request a wake.
        const sent = await options.messaging.send(destination.threadId, {
          idempotencyKey: ingressIdempotencyKey(item.event), identity: 'collective', sender: projected.sender, meta: projected.meta,
          payload: { provenance: { origin: { kind: 'plugin', instanceId: owner.pluginInstanceId }, epistemicStatus: 'observation' },
            elements: [{ elementId: 'collective-source', kind: 'text', payload: { text: item.event.body } }] },
        });
        await current();
        if (sent.threadId !== destination.threadId) throw changed();
        await currentDestination();
        messageRef = `message:${sent.messageId}`;
      }
      // Atomic existing-inbox transaction precedes enqueue. A lost/late response does not erase real Host effects.
      const binding = await options.connector.recordPublicSource({ connectionId, eventId, ownerUserId: owner.userId,
        pluginInstanceId: owner.pluginInstanceId, threadId: destination.threadId, messageRef, native });
      await currentSource(messageRef, current);
      const receipt = await options.publicInvocations.enqueue({ messageRef, targetCatId: binding.targetCatId,
        native: binding.native, authority: binding.authority });
      await current();
      return receipt;
    },
    async resolveNative(action: PluginActionContext, method: string) {
      const resolve = async () => {
        await action.assertCurrent();
        const auth = await options.nativeContext.current();
        await action.assertCurrent();
        if (auth.userId !== action.userId || auth.threadId !== action.threadId || auth.catId !== action.catId ||
          auth.invocationId !== action.invocationId || auth.source.id !== auth.originTriggerMessageId) throw changed();
        const messageRef = `message:${auth.originTriggerMessageId}`;
        const { binding, context } = await currentSource(messageRef, () => action.assertCurrent());
        const fact = auth.source;
        const event = (await options.connector.listInbox(binding.source.connectionId)).find(item => item.event.eventId === binding.source.eventId)?.event;
        if (binding.ownerUserId !== auth.userId || binding.threadId !== auth.threadId || binding.targetCatId !== auth.catId ||
          !isDeepStrictEqual(binding.native, native) || !binding.native.methods.includes(method) ||
          fact.userId !== auth.userId || fact.threadId !== auth.threadId || fact.catId !== null ||
          fact.extra.pluginMessage.instanceId !== binding.pluginInstanceId || fact.source.connector !== 'collective' ||
          !isDeepStrictEqual(fact.source.meta?.participation, binding.source) || !event || fact.content !== event.body) throw changed();
        await action.assertCurrent();
        const final = await options.nativeContext.current(); await action.assertCurrent();
        if (!isDeepStrictEqual(final, auth)) throw changed();
        options.connector.readCurrentPublicSource(messageRef);
        return { auth, source: binding.source, sourceRef: messageRef, context, binding };
      };
      const resolved = await resolve();
      // Every future native mutation/reply must call this before and after its original business effect.
      return { ...resolved, revalidate: async () => {
        const after = await resolve(); if (!isDeepStrictEqual(after.binding, resolved.binding)) throw changed(); return after;
      } };
    },
  });
}
