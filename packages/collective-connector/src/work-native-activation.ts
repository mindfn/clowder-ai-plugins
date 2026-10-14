import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { FeatureContext, FeatureActivation, PluginActionHandler, PluginOwnerHttpContext, PluginOwnerOperationContext } from '@clowder-ai/plugin-sdk';
import { rowsResult, operationRowAction } from '@clowder-ai/plugin-sdk';
import type { CollectiveConnector } from './business/connector/connector.js';
import { collectiveEventSourceIdentity } from './business/contracts/index.js';
import { resolveMaterializedParticipation } from './business/connector/participation-custody.js';
import { collectiveSource, ingressIdempotencyKey, assertSettledCollectiveSource } from './collective-ingress-routing.js';
import { createCollectiveAgentWorkContextCaller } from './agent-work-context-caller.js';
import { createCollectiveWorkAdmissionCaller } from './collective-work-admission-caller.js';
import { createCollectiveOwnerWorkCaller } from './owner-work-manual-caller.js';
import { createCollectiveWorkArtifacts } from './collective-work-artifacts.js';
import { publishCollectiveProgress } from './owner-work-progress.js';
import { openCollectiveContextReferences, collectiveContextError } from './collective-context-refs.js';
import { COLLECTIVE_WORK_NATIVE_ID, collectiveWorkNativeTools } from './work-native-methods.js';

interface Backend {
  readonly connector: CollectiveConnector;
  readonly parentOrigin: string;
  assertActive(): void;
}
const requestSchema = z.object({request: z.object({method: z.literal('POST'), path: z.string().min(1).max(512),
  headers: z.record(z.union([z.string(), z.array(z.string()), z.undefined()])).default({}),
  principal: z.object({kind: z.literal('owner'), id: z.string().min(1).max(240)}).strict(),
  body: z.unknown(), query: z.record(z.unknown()).optional(), rawBody: z.unknown().optional()}).strict()}).strict();
const syncSchema = z.object({connectionId: z.string().min(1).max(240)}).strict();

/** One declared private Work feature consumes original callers. Its actions use
 * its own grants/lifetime; sharing the backend Connector does not share owner
 * or native authority. No timers, source identity guesses or Task CRUD grants. */
export async function activateCollectiveWork(context: FeatureContext, backend: Backend): Promise<FeatureActivation> {
  let live = true;
  const assertActive = () => {if (!live) throw new Error('Collective Work is stopped');void context.dataDirectory;backend.assertActive();};
  assertActive();
  if (!context.nativeContext) throw new Error('Collective Work requires authenticated Task native context');
  const {connector} = backend;
  const refs = await openCollectiveContextReferences(context.dataDirectory, assertActive);
  const reader = createCollectiveAgentWorkContextCaller({connector, context,
    firstReceipts: {storage: context.storage, messaging: context.messaging}});
  const artifacts = createCollectiveWorkArtifacts(context);
  type WorkBinding = Parameters<Parameters<typeof reader.withCurrentTask>[1]>[0];
  const identityOf = (binding: WorkBinding) => ({pluginInstanceId: binding.auth.source.extra.pluginMessage.instanceId,
    invocationId: binding.auth.invocationId});
  const current = async (binding: WorkBinding) => {assertActive();await binding.revalidate();assertActive();};
  const nativeHandler = <T>(method: string, schema: z.ZodType<T>, consume: (binding: WorkBinding, input: T) => Promise<unknown>): PluginActionHandler =>
    async (unsafe, action, caller) => {
      assertActive();
      if (!action || caller || action.toolExecutionPolicy?.mode !== 'plugin_native' ||
        action.toolExecutionPolicy.contributionId !== COLLECTIVE_WORK_NATIVE_ID ||
        !Array.isArray(action.toolExecutionPolicy.actionMethods) || !action.toolExecutionPolicy.actionMethods.includes(method))
        throw collectiveContextError('NOT_COLLECTIVE_ORIGIN', 'This action requires the authenticated private Work invocation');
      const input = schema.parse(unsafe ?? {});
      return reader.withCurrentTask(action, async binding => {
        await current(binding);const result = await consume(binding, input);await current(binding);return result;
      });
    };
  const prepareReply = (binding: WorkBinding) => connector.prepareReply(binding.source, binding.sourceRef, binding.resultKey,
    binding.work.revision, binding.work.resultRevision,
    {revision: binding.work.executionRevision, assignmentEventId: binding.work.assignmentEventId});
  const currentReply = async (binding: WorkBinding) => {
    await current(binding);let operation = await prepareReply(binding);await current(binding);
    if (operation.status === 'queued' || operation.status === 'sending') {
      await connector.sync(binding.source.connectionId);await current(binding);
      operation = await prepareReply(binding);await current(binding);
    }
      const source = await connector.readParticipationContext(binding.source, 0, 1);await current(binding);
      const identity = identityOf(binding);
      return {replyOperationRef: refs.opaqueRef(identity, `reply:${operation.outboxId}`, binding.refScope),
        reply: {status: operation.status, ...(operation.status !== 'prepared' ? {body: operation.body, author: operation.agent} : {}),
          ...(operation.acceptedEventId ? {eventId: operation.acceptedEventId} : {}),
          ...(operation.failureCode ? {code: operation.failureCode} : {})}, kind: 'collective', authority: 'owner_admitted_work', actor: binding.source.actor,
        location: binding.source.location, participant: binding.displayName, request: source.source,
        workRef: {subjectRef: binding.auth.task.taskRef, revision: binding.work.revision},
        contextRef: refs.opaqueRef(identity, 'context', binding.refScope),
        returnRef: refs.opaqueRef(identity, 'return', binding.refScope),
        progressOperationRef: refs.opaqueRef(identity, 'progress', binding.refScope)};
  };
  const handlers: Record<string, PluginActionHandler> = {
    'collective.work.context.current': nativeHandler('collective.work.context.current', collectiveWorkNativeTools[0].schema, currentReply),
    'collective.work.context.read': nativeHandler('collective.work.context.read', collectiveWorkNativeTools[1].schema, async (binding, input) => {
      refs.verifyRef(identityOf(binding), input.contextRef, 'context', binding.refScope);await current(binding);
      return connector.readParticipationContext(binding.source, input.afterSequence ?? 0, input.limit ?? 30);
    }),
    'collective.work.progress': nativeHandler('collective.work.progress', collectiveWorkNativeTools[2].schema, async (binding, input) => {
      const identity = identityOf(binding);
      refs.verifyRef(identity, input.returnRef, 'return', binding.refScope);
      refs.verifyRef(identity, input.progressOperationRef, 'progress', binding.refScope);await current(binding);
      return publishCollectiveProgress(connector, binding.auth, binding, input.body);
    }),
    'collective.work.artifact.publish-text': nativeHandler('collective.work.artifact.publish-text', collectiveWorkNativeTools[3].schema, async (binding, input) => {
      refs.verifyRef(identityOf(binding), input.contextRef, 'context', binding.refScope);await current(binding);
      const operation = await prepareReply(binding);await current(binding);
      if (operation.workPurpose?.artifactSnapshot) {
        const selected = await artifacts.readCurrent(binding);await current(binding);
        if (!selected || !isDeepStrictEqual(selected.snapshot, operation.workPurpose.artifactSnapshot))
          throw collectiveContextError('WORK_ARTIFACT_UNAVAILABLE', 'Selected private artifact is unavailable');
      } else if (operation.status !== 'prepared')
        throw collectiveContextError('WORK_ARTIFACT_UNAVAILABLE', 'This result already selected no artifact');
      const snapshot = await artifacts.publishText(binding, {text: input.text, mediaType: input.mediaType});await current(binding);
      await connector.stageReplyArtifact(binding.source, binding.sourceRef, binding.resultKey, operation.outboxId,
        {catId: binding.auth.catId, agentId: binding.auth.catId, displayName: binding.displayName, sessionRef: binding.auth.invocationId},
        snapshot, binding.work.revision, binding.work.resultRevision,
        {revision: binding.work.executionRevision, assignmentEventId: binding.work.assignmentEventId});
      await current(binding);return snapshot;
    }),
    'collective.work.artifact.read': nativeHandler('collective.work.artifact.read', collectiveWorkNativeTools[4].schema, async (binding, input) => {
      refs.verifyRef(identityOf(binding), input.contextRef, 'context', binding.refScope);await current(binding);
      const artifact = await artifacts.readCurrent(binding);await current(binding);
      return artifact ? {state: 'available', ...artifact, trust: 'untrusted_external', sourceTrust: 'unknown', instructionPolicy: 'data_only'}
        : {state: 'unavailable', code: 'UNSEALED_ARTIFACT'};
    }),
    'collective.work.reply.submit': nativeHandler('collective.work.reply.submit', collectiveWorkNativeTools[5].schema, async (binding, input) => {
      const operation = await prepareReply(binding);await current(binding);
      const identity = identityOf(binding);
      refs.verifyRef(identity, input.returnRef, 'return', binding.refScope);
      refs.verifyRef(identity, input.replyOperationRef, `reply:${operation.outboxId}`, binding.refScope);await current(binding);
      const artifact = await artifacts.selectForReturn(binding, operation.workPurpose?.artifactSnapshot);await current(binding);
      await connector.submitReply(binding.source, binding.sourceRef, binding.resultKey, operation.outboxId, input.body,
        {catId: binding.auth.catId, agentId: binding.auth.catId, displayName: binding.displayName, sessionRef: binding.auth.invocationId},
        artifact?.snapshot, binding.work.resultRevision,
        {revision: binding.work.executionRevision, assignmentEventId: binding.work.assignmentEventId});
      await current(binding);await connector.sync(binding.source.connectionId);await current(binding);
      return currentReply(binding);
    }),
  };
  handlers['collective.work.control.http'] = async (unsafe, native, caller) => {
    assertActive();
    if (native || caller?.kind !== 'owner-http-request') throw new Error('Authenticated owner Work webhook required');
    const owner: PluginOwnerHttpContext = caller;
    const {request} = requestSchema.parse(unsafe);
    if (owner.operation !== 'write' || owner.userId !== request.principal.id ||
      owner.requestIdentity?.method !== request.method || owner.requestIdentity.path !== request.path ||
      (request.headers.origin !== undefined && request.headers.origin !== backend.parentOrigin))
      throw new Error('Authenticated owner Work webhook required');
    const current = async () => {assertActive();owner.signal.throwIfAborted();await owner.assertCurrent();assertActive();};
    await current();
    const match = /^connections\/([A-Za-z0-9_-]{1,240})\/work\/(admit|resume)$/.exec(request.path);
    if (!match) return {status: 404, headers: {'content-type': 'application/json'}, body: {code: 'OWNER_CONTROL_NOT_FOUND'}};
    const ownerCaller = createCollectiveOwnerWorkCaller({current, ports: {pluginInstanceId: owner.pluginInstanceId,
      connector, storage: context.storage, messaging: context.messaging, tasks: context.tasks, threads: context.threads}});
    try {
      const result = match[2] === 'admit'
        ? await ownerCaller.admit(owner.userId, match[1]!, request.body, owner)
        : await ownerCaller.resume(owner.userId, match[1]!, request.body);
      await current();return {status: 200, headers: {'content-type': 'application/json'}, body: result};
    } catch (error) {
      await current();
      if (error instanceof z.ZodError) return {status: 400, headers: {'content-type': 'application/json'}, body: {code: 'INVALID_OWNER_WORK_REQUEST'}};
      const code = error && typeof error === 'object' && 'code' in error ? error.code : 'OWNER_ADMISSION_UNAVAILABLE';
      return {status: 409, headers: {'content-type': 'application/json'}, body: {code, error: error instanceof Error ? error.message.slice(0, 500) : 'Work admission unavailable'}};
    }
  };
  const ownerOperation = (caller: unknown): PluginOwnerOperationContext => {
    if (!caller || typeof caller !== 'object' || !('kind' in caller) || caller.kind !== 'owner-operation')
      throw new Error('Authenticated owner Work operation required');
    return caller as PluginOwnerOperationContext;
  };
  handlers['collective.work.owner.connections'] = async (unsafe, native, caller) => {
    assertActive();if (native) throw new Error('Owner Work operation required');const owner = ownerOperation(caller);
    z.object({input: z.object({}).strict()}).strict().parse(unsafe);
    owner.signal.throwIfAborted();await owner.assertCurrent();assertActive();
    const rows = [];
    for (const connection of await connector.listConnections()) {
      if ((await connector.getHostRoute(connection.connectionId))?.localOwnerUserId === owner.userId)
        rows.push({key: connection.connectionId, label: connection.endpointLabel, detail: connection.authorityStatus,
          actions: [operationRowAction('sync', {connectionId: connection.connectionId})]});
    }
    owner.signal.throwIfAborted();await owner.assertCurrent();assertActive();return rowsResult(rows, {empty: 'No owner-paired Collective connections'});
  };
  handlers['collective.work.owner.sync'] = async (unsafe, native, caller) => {
    assertActive();if (native) throw new Error('Owner Work operation required');const owner = ownerOperation(caller);
    const {input} = z.object({input: syncSchema}).strict().parse(unsafe);
    const current = async () => {assertActive();owner.signal.throwIfAborted();await owner.assertCurrent();assertActive();};
    await current();const route = await connector.getHostRoute(input.connectionId);await current();
    if (!route || route.localOwnerUserId !== owner.userId) throw new Error('Connection belongs to another owner');
    await connector.sync(input.connectionId);await current();
    const rows = [];
    for (const item of await connector.listInbox(input.connectionId)) {
      const identity = collectiveEventSourceIdentity(item.event);
      if (!identity || item.event.workRequest !== 'entrust') continue;
      await current();
      try {
        const receipt = await connector.withInboxRoutingAuthority(input.connectionId, item.event.eventId, async (currentRoute, currentItem) => {
          await current();
          if (currentRoute.localOwnerUserId !== owner.userId) throw new Error('Connection belongs to another owner');
          const connection = await connector.getProjection(input.connectionId);
          const destination = resolveMaterializedParticipation(currentRoute, connection.authorizedHumanId ?? '', identity.catId, identity.location.channelId);
          if (!destination) throw new Error('Work source route is unavailable');
          if (currentItem.routeReceipt?.kind === 'thread_message') return currentItem.routeReceipt;
          await connector.readParticipationContext(identity, 0, 1);await current();
          await connector.beginInboxRouting(input.connectionId, item.event.eventId, currentRoute.revision);await current();
          const projected = collectiveSource(currentItem.event, identity);
          const sent = await context.messaging.send(destination.threadId, {idempotencyKey: ingressIdempotencyKey(currentItem.event),
            identity: 'collective', sender: projected.sender, meta: projected.meta,
            payload: {provenance: {origin: {kind: 'plugin', instanceId: owner.pluginInstanceId}, epistemicStatus: 'observation'},
              elements: [{elementId: 'collective-source', kind: 'text', payload: {text: currentItem.event.body}}]}});
          if (sent.threadId !== destination.threadId) {
            if (currentItem.disposition !== 'routing' || !context.messaging.get) throw new Error('Work source destination changed');
            assertSettledCollectiveSource(await context.messaging.get(sent.messageId), sent, currentItem.event, identity, owner.userId);
          }
          const recorded = {kind: 'thread_message' as const, messageId: sent.messageId, threadId: sent.threadId, catId: identity.catId};
          // Record the returned durable effect before testing a late owner result.
          await connector.completeInboxRouting(input.connectionId, item.event.eventId, currentRoute.revision, recorded);
          await current();return recorded;
        });
        const work = await connector.readAssignedWorkByAssignment(input.connectionId, item.event.eventId);await current();
        const result = await createCollectiveWorkAdmissionCaller({connector, tasks: context.tasks, threads: context.threads,
          firstReceipts: {storage: context.storage, messaging: context.messaging}, assertCurrent: current})
          .admit({ownerUserId: owner.userId, identity, sourceMessageId: receipt.messageId, workId: work.workId,
            destination: {kind: 'derived_from_source'}});
        await current();rows.push({key: item.event.eventId, label: result.result === 'needs_clarification' ? 'Owner clarification required' : 'Work admitted',
          detail: result.result === 'needs_clarification' ? 'Clarify the missing admission information before retrying.' : 'The original private task was admitted. This does not mark the Work complete.'});
      } catch (error) {
        await current();rows.push({key: item.event.eventId, label: 'Private execution unavailable', detail: error instanceof Error ? error.message.slice(0, 500) : 'Current Work is unavailable'});
      }
    }
    return rowsResult(rows, {empty: 'No initial committed Work sources'});
  };
  return {actions: handlers, dispose() {live = false;}};
}
