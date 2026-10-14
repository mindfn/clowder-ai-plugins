import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { FeatureContext, PluginSourceFact, PluginTaskReadItem } from "@clowder-ai/plugin-sdk";
import type { CollectiveConnector, AssignedWorkAuthorityScope } from "./business/connector/connector.js";
import {
  collectiveSourceIdentitySchema,
  collectiveEventSourceIdentity,
  collectiveWorkAssignmentMatches,
  participationSourceIsCurrent,
  type CollectiveSourceIdentity,
} from "./business/contracts/index.js";
import { createCollectiveWorkAdmissionCaller, opaqueHostAdmission } from "./collective-work-admission-caller.js";
import { collectiveWorkContinuation } from "./owner-work-continuation.js";
import { classifyEntrustedWorkSourceTime } from "./work-source-signals.js";

// Original ca5 owner admission/resume DTOs. Identity remains the Host webhook principal.
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
  readonly connector: CollectiveConnector;
  readonly context: Pick<FeatureContext, "sourceFacts" | "ownerThreads"> & {
    readonly tasks: Pick<FeatureContext["tasks"], "get" | "listByKind" | "prepareEntrusted" | "dispatchEntrusted">;
  };
  readonly current: () => Promise<void>;
}
const unavailable = (code = "OWNER_ADMISSION_UNAVAILABLE") =>
  Object.assign(new Error("Only the exact current committed Collective Work can enter private owner execution"), {
    code,
  });
function taskMatches(task: PluginTaskReadItem, owner: string, cat: string, firstRef: string) {
  return (
    task.kind === "work" &&
    task.userId === owner &&
    task.ownerCatId === cat &&
    task.entrustedWork?.admission.sourceRefs.length === 1 &&
    task.entrustedWork.admission.sourceRefs[0] === firstRef
  );
}
export function createCollectiveOwnerWorkCaller(options: Options) {
  const { context, connector, current } = options;
  const admission = createCollectiveWorkAdmissionCaller({ connector, tasks: context.tasks, assertCurrent: current });
  const readSource = async (owner: string, id: string, connectionId: string) => {
    if (!context.sourceFacts) throw unavailable();
    await current();
    const fact = await context.sourceFacts.read({ messageRef: `message:${id}` });
    await current();
    const parsed = collectiveSourceIdentitySchema.safeParse(fact.source.meta?.participation);
    if (
      fact.id !== id ||
      fact.userId !== owner ||
      fact.catId !== null ||
      fact.source.connector !== "collective" ||
      !parsed.success ||
      parsed.data.connectionId !== connectionId
    )
      throw unavailable("RETURN_UNAVAILABLE");
    const remote = await connector.readParticipationContext(parsed.data, 0, 1);
    await current();
    if (
      remote.source.body !== fact.content ||
      !isDeepStrictEqual(collectiveEventSourceIdentity(remote.source), parsed.data)
    )
      throw unavailable("RETURN_UNAVAILABLE");
    return { fact, identity: parsed.data };
  };
  const ownedThread = async (owner: string, cat: string, id?: string) => {
    if (!context.ownerThreads) throw unavailable();
    await current();
    const thread = id
      ? await context.ownerThreads.get(id)
      : await context.ownerThreads.create({ title: "Collective 私人工作" });
    await current();
    if (!thread || thread.createdBy !== owner) throw unavailable("THREAD_OWNER_MISMATCH");
    if (!thread.participants.includes(cat)) {
      await current();
      await context.ownerThreads.addParticipants({ threadId: thread.id, catIds: [cat] });
      await current();
    }
    return thread.id;
  };
  const exactAssignment = (
    scope: AssignedWorkAuthorityScope,
    fact: PluginSourceFact,
    identity: CollectiveSourceIdentity,
    owner: string,
  ) => {
    const rows = scope.inbox.filter((row) => row.event.eventId === identity.eventId);
    const receipt = rows.length === 1 ? rows[0]?.routeReceipt : undefined;
    if (
      scope.hostRoute?.localOwnerUserId !== owner ||
      scope.connection.authorityStatus !== "connected" ||
      scope.connection.authorizedHumanId !== scope.work.accountableHumanId ||
      !scope.hostRoute ||
      !participationSourceIsCurrent(
        scope.hostRoute,
        identity.catId,
        identity.location.channelId,
        identity.participationRevision,
      ) ||
      fact.source.meta?.workRequest !== "entrust" ||
      !collectiveWorkAssignmentMatches(identity, scope.work, fact.source.meta?.workAcceptanceNotice) ||
      (scope.work.executionAuthority?.revision ?? 1) !== 1 ||
      !["committed", "in_progress"].includes(scope.work.lifecycle) ||
      !["ready", "in_progress"].includes(scope.work.status) ||
      receipt?.kind !== "thread_message" ||
      receipt.messageId !== fact.id ||
      receipt.threadId !== fact.threadId ||
      receipt.catId !== identity.catId
    )
      throw unavailable();
  };
  return Object.freeze({
    async admit(ownerUserId: string, connectionId: string, unsafe: unknown) {
      const input = ownerWorkInput.parse(unsafe);
      const { fact, identity } = await readSource(ownerUserId, input.sourceMessageId, connectionId);
      return connector.withSynchronizedAssignedWorkAuthority(connectionId, identity.eventId, async (scope) => {
        exactAssignment(scope, fact, identity, ownerUserId);
        await current();
        const matches = (await context.tasks.listByKind("work")).filter((task) =>
          taskMatches(task, ownerUserId, identity.catId, `message:${fact.id}`),
        );
        await current();
        if (matches.length > 1) throw unavailable("WORK_SOURCE_AMBIGUOUS");
        const task = matches[0];
        if (task && (task.status === "done" || task.entrustedWork?.closure.state !== "open"))
          throw unavailable("WORK_TASK_UNAVAILABLE");
        if (identity.actor.kind === "agent") {
          const authority = scope.work.executionAuthority ?? scope.work.acceptance;
          if (
            !task ||
            authority?.hostAdmission?.state !== "admitted" ||
            authority.hostAdmission.receiptRef !== opaqueHostAdmission(fact, scope.work.workId, task.id)
          )
            throw unavailable();
        } else {
          const relation = classifyEntrustedWorkSourceTime(scope.work.intendedOutcome);
          if (relation === "ambiguous")
            return { result: "needs_clarification" as const, reason: "ambiguous_source_time" };
          if (relation === "deadline" && !input.businessDeadline) return { result: "needs_clarification" as const };
        }
        if (task && input.threadId && task.threadId !== input.threadId) throw unavailable("OWNER_ADMISSION_CONFLICT");
        const before = await scope.readCurrentWork();
        await current();
        exactAssignment({ ...scope, work: before }, fact, identity, ownerUserId);
        const threadId = await ownedThread(ownerUserId, identity.catId, task?.threadId ?? input.threadId);
        return admission.admitInScope(
          scope,
          {
            ownerUserId,
            identity,
            sourceMessageId: fact.id,
            workId: scope.work.workId,
            destination: { kind: "existing_thread", threadId },
            subject: {
              kind: "new",
              title: task?.title ?? scope.work.title.slice(0, 160),
              intendedOutcome: scope.work.intendedOutcome,
              closure: {
                condition: "A reviewable result answers the entrusted request at its original Collective location",
                expectedSignal: "collective:accepted-result",
              },
              ...(input.businessDeadline
                ? { time: { businessDeadline: { value: input.businessDeadline, sourceRef: `message:${fact.id}` } } }
                : {}),
            },
          },
          "owner_request",
        );
      });
    },
    async resume(ownerUserId: string, connectionId: string, unsafe: unknown) {
      const input = ownerWorkResumeInput.parse(unsafe);
      await current();
      const task = await context.tasks.get(input.taskId);
      await current();
      if (
        !task ||
        task.userId !== ownerUserId ||
        !task.ownerCatId ||
        task.status === "done" ||
        task.entrustedWork?.closure.state !== "open" ||
        task.entrustedWork.revision !== input.observedRevision ||
        task.entrustedWork.admission.sourceRefs.length !== 1
      )
        throw unavailable("TASK_UNAVAILABLE");
      const firstRef = task.entrustedWork.admission.sourceRefs[0];
      if (!firstRef?.startsWith("message:")) throw unavailable("RETURN_UNAVAILABLE");
      const first = await readSource(ownerUserId, firstRef.slice(8), connectionId);
      return connector.withSynchronizedAssignedWorkAuthority(connectionId, first.identity.eventId, async (scope) => {
        const rows = scope.inbox.filter(
          (row) => row.event.eventId === (scope.work.executionAuthority?.eventId ?? scope.work.assignmentEventId),
        );
        const receipt = rows.length === 1 ? rows[0]?.routeReceipt : undefined;
        if (receipt?.kind !== "thread_message") throw unavailable("WORK_TASK_UNAVAILABLE");
        const source = await readSource(ownerUserId, receipt.messageId, connectionId);
        collectiveWorkContinuation(scope, source.identity, source.fact.id);
        return admission.admitInScope(
          scope,
          {
            ownerUserId,
            identity: source.identity,
            sourceMessageId: source.fact.id,
            workId: scope.work.workId,
            destination: { kind: "existing_thread", threadId: task.threadId },
            subject: { kind: "continue", taskRef: `task:work:${task.id}`, expectedRevision: input.observedRevision },
          },
          "owner_request",
        );
      });
    },
  });
}
