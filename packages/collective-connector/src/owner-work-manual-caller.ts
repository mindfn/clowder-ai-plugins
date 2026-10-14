import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import type { PluginMessagingHost, PluginOwnerHttpContext, PluginStorageHost, PluginTaskHost, PluginThreadHost } from "@clowder-ai/plugin-sdk";
import type { AssignedWorkAuthorityScope, CollectiveConnector } from "./business/connector/connector.js";
import { collectiveEventSourceIdentity, collectiveSourceIdentitySchema, collectiveWorkAssignmentMatches,
  participationSourceIsCurrent } from "./business/contracts/index.js";
import { retainManualWorkFirstReceipt, workReceiptDigest } from "./owner-work-first-receipt.js";
import { resolveCollectiveWorkThread, selectCollectiveWorkThread } from "./collective-work-thread.js";
import { classifyEntrustedWorkSourceTime } from "./work-source-signals.js";

// Original ca5 strict DTOs are retained; parsing is not owner authorization.
export const ownerWorkInput = z
  .object({
    sourceMessageId: z.string().min(1).max(240),
    requestId: z.string().uuid(),
    businessDeadline: z.number().int().positive().optional(),
    threadId: z.string().min(1).max(240).optional(),
  })
  .strict();
export const ownerWorkResumeInput = z
  .object({
    taskId: z.string().min(1).max(240),
    observedRevision: z.number().int().positive(),
    requestId: z.string().uuid(),
  })
  .strict();
interface Options {
  readonly current: () => Promise<void>;
  readonly ports?: {
    readonly pluginInstanceId: string;
    readonly connector: CollectiveConnector;
    readonly storage: Pick<PluginStorageHost, "get" | "compareAndSet">;
    readonly messaging: Pick<PluginMessagingHost, "get">;
    readonly tasks: Pick<PluginTaskHost, "get" | "listByKind" | "prepareEntrusted" | "dispatchEntrusted">;
    readonly threads: Pick<PluginThreadHost, "get" | "ensureByKey">;
  };
}
const unavailable = () =>
  Object.assign(
    new Error("Owner Work execution requires the approved durable first-basis and request-identity bridge"),
    { code: "OWNER_ADMISSION_UNAVAILABLE" },
  );

/** Internal original human owner admission. Absent composition still refuses.
 * Actual HTTP facts + same Work scope capture the original manual first choice;
 * private CAS retains it before prepare and binds exact Host facts before dispatch.
 * Agent owner clicks and resume require their original standing/execution receipts
 * and remain unavailable here. No createdBy/mode/body requestId infers permission. */
export function createCollectiveOwnerWorkCaller(options: Options) {
  return Object.freeze({
    async admit(ownerUserId: string, connectionId: string, unsafe: unknown, owner?: PluginOwnerHttpContext) {
      const input = ownerWorkInput.parse(unsafe);
      await options.current();
      const ports = options.ports;
      if (!ports || !owner || owner.kind !== "owner-http-request" || owner.operation !== "write" ||
        owner.userId !== ownerUserId || owner.pluginInstanceId !== ports.pluginInstanceId || !owner.requestIdentity ||
        owner.requestIdentity.kind !== "owner_http" || owner.requestIdentity.userId !== ownerUserId ||
        owner.requestIdentity.pluginInstanceId !== ports.pluginInstanceId || !owner.requestIdentity.requestId ||
        !ports.messaging.get || !ports.tasks.prepareEntrusted || !ports.tasks.dispatchEntrusted) throw unavailable();
      const request = owner.requestIdentity;
      const currentRequest = async () => {
        owner.signal.throwIfAborted(); await owner.assertCurrent(); await options.current();
        owner.signal.throwIfAborted(); await owner.assertCurrent();
      };
      await currentRequest();
      const source = await ports.messaging.get(input.sourceMessageId);
      await currentRequest();
      const identity = collectiveSourceIdentitySchema.safeParse(source?.source?.meta?.participation);
      if (!source || source.id !== input.sourceMessageId || source.userId !== ownerUserId || source.catId !== null ||
        source.source?.connector !== "collective" || !identity.success || identity.data.connectionId !== connectionId ||
        identity.data.actor.kind !== "human") throw unavailable();
      return ports.connector.withSynchronizedAssignedWorkAuthority(connectionId, identity.data.eventId, async scope => {
        const validate = (actual: AssignedWorkAuthorityScope) => {
          const rows = actual.inbox.filter(row => row.event.eventId === identity.data.eventId);
          const item = rows.length === 1 ? rows[0] : undefined;
          if (actual.connection.authorityStatus !== "connected" ||
            actual.connection.authorizedHumanId !== actual.work.accountableHumanId ||
            actual.hostRoute?.localOwnerUserId !== ownerUserId ||
            !participationSourceIsCurrent(actual.hostRoute, identity.data.catId, identity.data.location.channelId,
              identity.data.participationRevision) || !item ||
            !isDeepStrictEqual(collectiveEventSourceIdentity(item.event), identity.data) || item.event.body !== source.content ||
            source.source?.meta?.workRequest !== "entrust" ||
            !collectiveWorkAssignmentMatches(identity.data, actual.work, source.source.meta.workAcceptanceNotice) ||
            (actual.work.executionAuthority?.revision ?? 1) !== 1 ||
            !["committed", "in_progress"].includes(actual.work.lifecycle) || !["ready", "in_progress"].includes(actual.work.status) ||
            item.routeReceipt?.kind !== "thread_message" || item.routeReceipt.messageId !== source.id ||
            item.routeReceipt.threadId !== source.threadId || item.routeReceipt.catId !== identity.data.catId) throw unavailable();
        };
        validate(scope);
        const current = async () => {
          await currentRequest();
          const message = await ports.messaging.get!(source.id);
          const work = await scope.readCurrentWork();
          const connection = await ports.connector.getProjection(connectionId);
          const hostRoute = await ports.connector.getHostRoute(connectionId);
          const inbox = await ports.connector.listInbox(connectionId);
          await currentRequest();
          validate({...scope, work, connection, hostRoute, inbox});
          if (!isDeepStrictEqual(message, source) || work.workId !== scope.work.workId ||
            work.assignmentEventId !== scope.work.assignmentEventId || work.intendedOutcome !== scope.work.intendedOutcome)
            throw unavailable();
        };
        await current();
        const tasks = await ports.tasks.listByKind("work");
        await current();
        const selectedThread = selectCollectiveWorkThread(tasks, source, identity.data.catId);
        if (selectedThread.kind === "existing" && input.threadId && selectedThread.threadId !== input.threadId)
          throw Object.assign(unavailable(), {code: "OWNER_ADMISSION_CONFLICT"});
        if (!scope.work.assignmentEventId) throw unavailable();
        const receipt = await retainManualWorkFirstReceipt(ports.storage, {
          v: 1, basis: {kind: "manual_owner_write"}, ownerUserId, pluginInstanceId: ports.pluginInstanceId,
          source: {id: source.id, revision: source.sourceRevision, threadId: source.threadId,
            bodyDigest: workReceiptDigest(source.content), identity: identity.data},
          work: {workId: scope.work.workId, assignmentEventId: scope.work.assignmentEventId, resultRevision: 1,
            executionRevision: 1, intendedOutcomeDigest: workReceiptDigest(scope.work.intendedOutcome)},
          firstRequest: {requestId: request.requestId, contributionId: request.contributionId, method: request.method,
            path: request.path, bodyDigest: request.bodyDigest, queryDigest: request.queryDigest},
        }, current, selectedThread.kind === "existing");
        const relation = classifyEntrustedWorkSourceTime(scope.work.intendedOutcome);
        if (relation === "ambiguous") return {result: "needs_clarification" as const, reason: "ambiguous_source_time"};
        if (relation === "deadline" && !input.businessDeadline) return {result: "needs_clarification" as const};
        const threadId = input.threadId ?? await resolveCollectiveWorkThread(ports.threads, ports.tasks, source, identity.data.catId);
        if (!await ports.threads.get(threadId)) throw unavailable();
        await current();
        const result = await ports.tasks.prepareEntrusted!({sourceMessageId: source.id, targetCatId: identity.data.catId,
          destination: {kind: "existing_thread", threadId}, subject: {kind: "new", title: scope.work.title.slice(0, 160),
            intendedOutcome: scope.work.intendedOutcome, closure: {
              condition: "A reviewable result answers the entrusted request at its original Collective location",
              expectedSignal: "collective:accepted-result"},
            ...(input.businessDeadline ? {time: {businessDeadline: {value: input.businessDeadline, sourceRef: `message:${source.id}`}}} : {})}});
        await current();
        if (result.result === "needs_clarification") return result;
        const currentTask = async () => {
          const task = await ports.tasks.get(result.taskRef.slice("task:work:".length));
          await current();
          if (!task || `task:work:${task.id}` !== result.taskRef || task.kind !== "work" || task.userId !== ownerUserId || task.ownerCatId !== identity.data.catId ||
            task.threadId !== threadId || task.status === "done" || task.entrustedWork?.closure.state !== "open" ||
            task.entrustedWork.revision !== result.taskRevision || task.entrustedWork.admission.sourceRefs.length !== 1 ||
            task.entrustedWork.admission.sourceRefs[0] !== `message:${source.id}`) throw unavailable();
        };
        await currentTask();
        const binding = {taskRef: result.taskRef, taskRevision: result.taskRevision, threadId: result.threadId,
          admissionRef: result.admissionRef, executionRef: result.executionRef,
          refScope: `message:${source.id}:work:${result.taskRef.slice("task:work:".length)}:${result.taskRevision}:result:1:execution:1:${result.executionRef}`};
        if (result.threadId !== threadId) throw unavailable();
        await receipt.bind(binding);
        await currentTask();
        await receipt.assertBound(binding);
        const queue = await ports.tasks.dispatchEntrusted!({taskRef: result.taskRef, taskRevision: result.taskRevision,
          executionRef: result.executionRef});
        await current(); await receipt.assertBound(binding);
        return {...result, queue};
      });
    },
    async resume(_ownerUserId: string, _connectionId: string, unsafe: unknown): Promise<never> {
      ownerWorkResumeInput.parse(unsafe);
      await options.current();
      throw unavailable();
    },
  });
}
