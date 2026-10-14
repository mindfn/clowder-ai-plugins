import { isDeepStrictEqual } from "node:util";
import type { FeatureContext, PluginActionContext, PluginNativeTaskContext } from "@clowder-ai/plugin-sdk";
import type { CollectiveConnector } from "./business/connector/connector.js";
import {
  collectiveEventSourceIdentity,
  collectiveSourceIdentitySchema,
  collectiveWorkAssignmentMatches,
  collectiveWorkExecutionMatches,
} from "./business/contracts/index.js";
import { resolveMaterializedParticipation } from "./business/connector/participation-custody.js";
import { collectiveContextError } from "./collective-context-refs.js";
import { opaqueHostAdmission } from "./collective-work-admission-caller.js";

interface Options {
  readonly connector: CollectiveConnector;
  readonly context: Pick<FeatureContext, "nativeContext"> & { readonly tasks: Pick<FeatureContext["tasks"], "get"> };
}
const changed = () =>
  collectiveContextError(
    "WORK_EXECUTION_NOT_CURRENT",
    "The current private Agent Task/source/Service execution changed",
  );

/** Package-internal Agent Work reader, never an admission or a published action.
 * The Host authenticates the existing Task coordinates. The original Service
 * acceptance and source notice supply immutable business execution/result facts.
 * Human first-admission basis and artifact/version adaptation remain separately
 * paired Host boundaries; this helper does not infer either from createdBy. */
export function createCollectiveAgentWorkContextCaller(options: Options) {
  const { connector, context } = options;
  const readNative = async (action: PluginActionContext) => {
    await action.assertCurrent();
    if (!context.nativeContext) throw changed();
    const auth = await context.nativeContext.current({ includeTask: true });
    await action.assertCurrent();
    if (
      action.ownerAuthProvenance !== "unknown" ||
      action.toolExecutionPolicy?.mode !== "plugin_native" ||
      auth.userId !== action.userId ||
      auth.catId !== action.catId ||
      auth.threadId !== action.threadId ||
      auth.invocationId !== action.invocationId ||
      auth.originTriggerMessageId !== action.originTriggerMessageId ||
      auth.source.userId !== auth.userId ||
      auth.source.catId !== null ||
      auth.source.source.connector !== "collective" ||
      action.toolExecutionPolicy.pluginInstanceId !== auth.source.extra.pluginMessage.instanceId
    )
      throw changed();
    const parsed = collectiveSourceIdentitySchema.safeParse(auth.source.source.meta?.participation);
    if (!parsed.success || parsed.data.catId !== auth.catId || parsed.data.actor.kind !== "agent") throw changed();
    return { auth, source: parsed.data };
  };
  return Object.freeze({
    async withCurrentTask<T>(
      action: PluginActionContext,
      consume: (binding: {
        readonly auth: PluginNativeTaskContext;
        readonly source: Awaited<ReturnType<typeof readNative>>["source"];
        readonly sourceRef: `message:${string}`;
        readonly resultKey: string;
        readonly displayName: string;
        readonly refScope: string;
        readonly work: {
          readonly revision: number;
          readonly resultRevision: number;
          readonly executionRevision: number;
          readonly assignmentEventId: string;
        };
        revalidate(): Promise<void>;
      }) => Promise<T>,
    ): Promise<T> {
      const first = await readNative(action);
      const rows = (await connector.listInbox(first.source.connectionId)).filter(
        (row) => row.event.eventId === first.source.eventId,
      );
      const item = rows.length === 1 ? rows[0] : undefined;
      const notice =
        item?.event.workRequest === "continue" ? item.event.workExecutionNotice : item?.event.workAcceptanceNotice;
      if (!notice) throw changed();
      const read = () =>
        connector.withAssignedWorkAuthority(first.source.connectionId, notice.workId, async (scope) => {
          const current = await readNative(action);
          if (!isDeepStrictEqual(current, first)) throw changed();
          const { auth, source } = current;
          const task = await context.tasks.get(auth.task.taskRef.slice("task:work:".length));
          await action.assertCurrent();
          const work = await scope.readCurrentWork();
          await action.assertCurrent();
          const route = await connector.getHostRoute(source.connectionId);
          const connection = await connector.getProjection(source.connectionId);
          const inbox = await connector.listInbox(source.connectionId);
          const sources = inbox.filter((row) => row.event.eventId === source.eventId);
          const actual = sources.length === 1 ? sources[0] : undefined;
          const assignment = inbox.filter((row) => row.event.eventId === work.assignmentEventId);
          const firstReceipt = assignment.length === 1 ? assignment[0]?.routeReceipt : undefined;
          const participation =
            route &&
            connection.authorizedHumanId &&
            resolveMaterializedParticipation(
              route,
              connection.authorizedHumanId,
              auth.catId,
              source.location.channelId,
            );
          if (
            !task ||
            `task:work:${task.id}` !== auth.task.taskRef ||
            task.kind !== "work" ||
            task.userId !== auth.userId ||
            task.ownerCatId !== auth.catId ||
            task.threadId !== auth.threadId ||
            task.status === "done" ||
            task.entrustedWork?.closure.state !== "open" ||
            firstReceipt?.kind !== "thread_message" ||
            task.entrustedWork.admission.sourceRefs.length !== 1 ||
            task.entrustedWork.admission.sourceRefs[0] !== `message:${firstReceipt.messageId}` ||
            !actual ||
            !isDeepStrictEqual(collectiveEventSourceIdentity(actual.event), source) ||
            actual.event.body !== auth.source.content ||
            auth.source.source.meta?.workRequest !== actual.event.workRequest ||
            !isDeepStrictEqual(auth.source.source.meta?.workAcceptanceNotice, actual.event.workAcceptanceNotice) ||
            !isDeepStrictEqual(auth.source.source.meta?.workExecutionNotice, actual.event.workExecutionNotice) ||
            !isDeepStrictEqual(auth.source.source.meta?.workRevisionNotice, actual.event.workRevisionNotice) ||
            actual.routeReceipt?.kind !== "thread_message" ||
            actual.routeReceipt.messageId !== auth.source.id ||
            actual.routeReceipt.threadId !== auth.source.threadId ||
            actual.routeReceipt.catId !== auth.catId ||
            route?.localOwnerUserId !== auth.userId ||
            connection.authorityStatus !== "connected" ||
            connection.authorizedHumanId !== work.accountableHumanId ||
            !participation ||
            participation.threadId !== auth.source.threadId ||
            !work.assignmentEventId ||
            !["committed", "in_progress", "result_ready"].includes(work.lifecycle)
          )
            throw changed();
          // These are the source's issued round, not the latest Work numbers silently
          // substituted into an older invocation after a result/reconsideration change.
          const continued = actual.event.workRequest === "continue";
          const executionRevision = continued ? actual.event.workExecutionNotice?.revision : 1;
          const resultRevision = continued ? actual.event.workExecutionNotice?.resultRevision : 1;
          const expectedResult =
            work.executionAuthority?.resultRevision ??
            (work.lifecycle === "result_ready"
              ? (work.resultRevision ?? 1)
              : (work.resultEventId ? (work.resultRevision ?? 1) : 0) + 1);
          if (
            !executionRevision ||
            !resultRevision ||
            resultRevision !== expectedResult ||
            (continued
              ? !collectiveWorkExecutionMatches(source, work, auth.source.source.meta?.workExecutionNotice)
              : actual.event.workRequest !== "entrust" ||
                (work.executionAuthority?.revision ?? 1) !== 1 ||
                !collectiveWorkAssignmentMatches(source, work, auth.source.source.meta?.workAcceptanceNotice))
          )
            throw changed();
          const grant = await connector.resolveAcceptedWorkGrant(source);
          await action.assertCurrent();
          const authority = grant.work.executionAuthority ?? grant.work.acceptance;
          if (
            grant.work.workId !== work.workId ||
            grant.work.assignmentEventId !== work.assignmentEventId ||
            !isDeepStrictEqual(grant.work.executionAuthority, work.executionAuthority) ||
            !isDeepStrictEqual(grant.work.acceptance, work.acceptance) ||
            authority?.hostAdmission?.state !== "admitted" ||
            authority.hostAdmission.receiptRef !== opaqueHostAdmission(auth.source, work.workId, task.id)
          )
            throw changed();
          await action.assertCurrent();
          const latest = await readNative(action);
          if (!isDeepStrictEqual(latest, current)) throw changed();
          return {
            auth,
            source,
            sourceRef: `message:${auth.source.id}` as const,
            resultKey: `work:${task.id}`,
            displayName: participation.displayName,
            work: {
              // Host assertCurrent/readTaskBinding fence execution authority. Its
              // captured Task revision stays fixed while evidence-only metadata
              // advances the aggregate CAS revision; the two are different facts.
              revision: auth.task.taskRevision,
              resultRevision,
              executionRevision,
              assignmentEventId: work.assignmentEventId,
            },
            refScope: `message:${auth.source.id}:work:${task.id}:${auth.task.taskRevision}:result:${resultRevision}:execution:${executionRevision}:${auth.task.executionRef}`,
          };
        });
      const initial = await read();
      let live = true;
      const revalidate = async () => {
        if (!live) throw new Error("Private Task consumer scope has ended");
        const current = await read();
        if (!live) throw new Error("Private Task consumer scope has ended");
        if (!isDeepStrictEqual(current, initial)) throw changed();
      };
      // Original callback effects own their own Connector transaction (notably
      // progress sync). Read/revalidate under the fence; do not retain it across
      // that operation or manufacture a second synchronization entry point.
      try {
        const result = await consume(Object.freeze({ ...initial, revalidate }));
        await revalidate();
        return result;
      } finally {
        live = false;
      }
    },
  });
}
