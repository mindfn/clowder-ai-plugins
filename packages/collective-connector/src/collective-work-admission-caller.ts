import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  PluginTaskHost,
  PluginTaskAdmissionInput,
  PluginTaskAdmissionResult,
  PluginTaskReadItem,
} from "@clowder-ai/plugin-sdk";
import type { AssignedWorkAuthorityScope, CollectiveConnector } from "./business/connector/connector.js";
import {
  collectiveEventSourceIdentity,
  collectiveWorkAssignmentMatches,
  collectiveWorkExecutionMatches,
  participationSourceIsCurrent,
  type CollectiveSourceIdentity,
  type CollectiveWorkProjection,
} from "./business/contracts/index.js";

export interface CollectiveWorkAdmissionSelection {
  readonly ownerUserId: string;
  readonly identity: CollectiveSourceIdentity;
  readonly sourceMessageId: string;
  readonly workId: string;
  readonly destination: PluginTaskAdmissionInput["destination"];
  readonly subject?: PluginTaskAdmissionInput["subject"];
}
interface Options {
  readonly connector: CollectiveConnector;
  readonly tasks: Pick<PluginTaskHost, "get" | "listByKind" | "prepareEntrusted" | "dispatchEntrusted">;
  readonly assertCurrent: () => Promise<void>;
}
const unavailable = (code = "WORK_EXECUTION_NOT_CURRENT") =>
  Object.assign(new Error("Current Collective Work does not authorize this Host execution"), { code });

/** Original Service receipt identity. It reports a factual Host Task; it issues no grant or bearer. */
export function opaqueHostAdmission(
  source: { readonly userId: string; readonly id: string },
  workId: string,
  fact: string,
) {
  return `host-admission:${createHash("sha256")
    .update(JSON.stringify([source.userId, source.id, workId, fact]))
    .digest("hex")}`;
}
function sameExecution(left: CollectiveWorkProjection, right: CollectiveWorkProjection) {
  const facts = (work: CollectiveWorkProjection) => ({
    workId: work.workId,
    assignment: work.assignment,
    assignmentEventId: work.assignmentEventId,
    accountableHumanId: work.accountableHumanId,
    authority: work.executionAuthority
      ? { ...work.executionAuthority, hostAdmission: undefined, hostAdmissionHistory: undefined }
      : work.acceptance
        ? { ...work.acceptance, hostAdmission: undefined, hostAdmissionHistory: undefined }
        : undefined,
  });
  return isDeepStrictEqual(facts(left), facts(right));
}
function validateScope(
  scope: AssignedWorkAuthorityScope,
  selection: CollectiveWorkAdmissionSelection,
  work = scope.work,
) {
  const source = selection.identity,
    assignment = work.assignment;
  const matches = scope.inbox.filter((item) => item.event.eventId === source.eventId);
  const item = matches.length === 1 ? matches[0] : undefined;
  if (
    !item ||
    !isDeepStrictEqual(collectiveEventSourceIdentity(item.event), source) ||
    scope.hostRoute?.localOwnerUserId !== selection.ownerUserId ||
    scope.connection.authorityStatus !== "connected" ||
    !scope.connection.authorizedHumanId ||
    work.workId !== selection.workId ||
    assignment?.connectionId !== source.connectionId ||
    work.accountableHumanId !== scope.connection.authorizedHumanId ||
    !participationSourceIsCurrent(
      scope.hostRoute,
      source.catId,
      source.location.channelId,
      source.participationRevision,
    ) ||
    item.routeReceipt?.kind !== "thread_message" ||
    item.routeReceipt.messageId !== selection.sourceMessageId ||
    item.routeReceipt.catId !== source.catId ||
    !["committed", "in_progress", "result_ready"].includes(work.lifecycle) ||
    (item.event.workRequest === "continue"
      ? !collectiveWorkExecutionMatches(source, work, item.event.workExecutionNotice)
      : item.event.workRequest !== "entrust" ||
        !collectiveWorkAssignmentMatches(source, work, item.event.workAcceptanceNotice) ||
        (work.executionAuthority?.revision ?? 1) !== 1)
  )
    throw unavailable();
  return item;
}
function validateTask(
  task: PluginTaskReadItem | null,
  result: Exclude<PluginTaskAdmissionResult, { result: "needs_clarification" }>,
  selection: CollectiveWorkAdmissionSelection,
  firstSourceRef: string,
) {
  if (
    !task ||
    `task:work:${task.id}` !== result.taskRef ||
    task.kind !== "work" ||
    task.userId !== selection.ownerUserId ||
    task.ownerCatId !== selection.identity.catId ||
    task.threadId !== result.threadId ||
    (selection.destination.kind === "existing_thread" && result.threadId !== selection.destination.threadId) ||
    task.status === "done" ||
    task.entrustedWork?.closure.state !== "open" ||
    task.entrustedWork.revision !== result.taskRevision ||
    task.entrustedWork.admission.sourceRefs.length !== 1 ||
    task.entrustedWork.admission.sourceRefs[0] !== firstSourceRef
  )
    throw unavailable("OWNER_ADMISSION_UNAVAILABLE");
  return task;
}

/** One original connection fence owns prepare → factual Service ack → business reread → dispatch.
 * Caller selections come from authenticated owner/native or original persisted ingress; the Host
 * independently rereads them. Generic CRUD/read and these business facts never admit execution. */
export function createCollectiveWorkAdmissionCaller(options: Options) {
  const admitInScope = async (
    scope: AssignedWorkAuthorityScope,
    raw: CollectiveWorkAdmissionSelection,
    entry: "standing" | "owner_request" = "standing",
  ) => {
    const selection = structuredClone(raw);
    // This is a package-internal entry distinction, never Host authority or an input grant.
    // Only the authenticated owner caller uses owner_request; Host independently enforces
    // that its selected existing_thread is unavailable to native/background requests.
    if (entry === "owner_request" && selection.destination.kind !== "existing_thread") throw unavailable();
    await options.assertCurrent();
    const item = validateScope(scope, selection);
    const authority = scope.work.executionAuthority ?? scope.work.acceptance;
    if (authority?.hostAdmission?.state === "rejected") throw unavailable("OWNER_ADMISSION_UNAVAILABLE");
    const current = async () => {
      await options.assertCurrent();
      const work = await scope.readCurrentWork();
      await options.assertCurrent();
      const route = await options.connector.getHostRoute(selection.identity.connectionId);
      const connection = await options.connector.getProjection(selection.identity.connectionId);
      const inbox = await options.connector.listInbox(selection.identity.connectionId);
      await options.assertCurrent();
      validateScope({ ...scope, connection, hostRoute: route, inbox }, selection, work);
      if (!sameExecution(scope.work, work)) throw unavailable();
      if ((work.executionAuthority ?? work.acceptance)?.hostAdmission?.state === "rejected")
        throw unavailable("OWNER_ADMISSION_UNAVAILABLE");
      if (selection.identity.actor.kind === "agent") {
        const grant = await options.connector.resolveAcceptedWorkGrant(selection.identity);
        await options.assertCurrent();
        if (!sameExecution(work, grant.work)) throw unavailable();
      } else {
        await options.connector.readParticipationContext(selection.identity, 0, 1);
        await options.assertCurrent();
        if (entry !== "owner_request") {
          const agentRoute = route?.agentRoutes[`${connection.authorizedHumanId}:${selection.identity.catId}`];
          const standing = agentRoute?.standingWork;
          const revision = agentRoute?.standingWorkRevision ?? route?.revision;
          if (
            !standing ||
            !revision ||
            !standing.requestingHumanIds.includes(selection.identity.actor.humanId) ||
            !standing.channelIds.includes(selection.identity.location.channelId) ||
            (standing.expiresAt !== null && Date.parse(standing.expiresAt) <= Date.now())
          )
            throw unavailable("OWNER_ADMISSION_UNAVAILABLE");
        }
      }
      return work;
    };
    await current();
    if (!options.tasks.prepareEntrusted || !options.tasks.dispatchEntrusted)
      throw unavailable("OWNER_ADMISSION_UNAVAILABLE");
    const subject = selection.subject ?? {
      kind: "new" as const,
      title: scope.work.title.slice(0, 160),
      intendedOutcome: scope.work.intendedOutcome,
      closure: {
        condition: "A reviewable result answers the entrusted request at its original Collective location",
        expectedSignal: "collective:accepted-result",
      },
    };
    if (item.event.workRequest === "continue" && subject.kind !== "continue")
      throw unavailable("WORK_TASK_UNAVAILABLE");
    await current();
    const result = await options.tasks.prepareEntrusted({
      sourceMessageId: selection.sourceMessageId,
      targetCatId: selection.identity.catId,
      destination: selection.destination,
      subject,
    });
    await current();
    if (result.result === "needs_clarification") return result;
    const first = scope.inbox.filter((row) => row.event.eventId === scope.work.assignmentEventId);
    const firstReceipt = first.length === 1 ? first[0]?.routeReceipt : undefined;
    if (firstReceipt?.kind !== "thread_message") throw unavailable("WORK_TASK_UNAVAILABLE");
    const task = validateTask(
      await options.tasks.get(result.taskRef.slice(10)),
      result,
      selection,
      `message:${firstReceipt.messageId}`,
    );
    await current();
    if (authority) {
      if (!scope.work.assignmentEventId) throw unavailable();
      const receiptRef = opaqueHostAdmission(
        { userId: selection.ownerUserId, id: selection.sourceMessageId },
        scope.work.workId,
        task.id,
      );
      await scope.recordHostAdmission({
        workId: scope.work.workId,
        assignmentEventId: scope.work.assignmentEventId,
        operationRef: authority.operationRef,
        grantRef: authority.grantRef,
        grantRevision: authority.grantRevision,
        executionRevision: scope.work.executionAuthority?.revision ?? 1,
        disposition: { state: "admitted", receiptRef },
      });
      const fresh = await current();
      const acknowledgement = (fresh.executionAuthority ?? fresh.acceptance)?.hostAdmission;
      if (acknowledgement?.state !== "admitted" || acknowledgement.receiptRef !== receiptRef)
        throw unavailable("OWNER_ADMISSION_UNAVAILABLE");
    }
    // Re-read the actual canonical Task and the current remote business grant after the Service effect.
    validateTask(await options.tasks.get(task.id), result, selection, `message:${firstReceipt.messageId}`);
    await current();
    const queue = await options.tasks.dispatchEntrusted({
      taskRef: result.taskRef,
      taskRevision: result.taskRevision,
      executionRef: result.executionRef,
    });
    await current();
    return { ...result, queue };
  };
  return Object.freeze({
    admitInScope,
    async admit(raw: CollectiveWorkAdmissionSelection) {
      const selection = structuredClone(raw);
      await options.assertCurrent();
      return options.connector.withAssignedWorkAuthority(selection.identity.connectionId, selection.workId, (scope) =>
        admitInScope(scope, selection),
      );
    },
  });
}
