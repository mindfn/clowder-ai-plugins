import { expect, test } from "vitest";
import type { PluginSourceFact, PluginTaskReadItem } from "@clowder-ai/plugin-sdk";
import { collectiveEventSourceIdentity } from "../../contracts/index.js";
import { fixture } from "./communication-work-custody.fixture.js";
import { createCollectiveOwnerWorkCaller as sourceOwnerCaller } from "../../../owner-work-manual-caller.js";
import { createCollectiveWorkAdmissionCaller } from "../../../collective-work-admission-caller.js";

const createCollectiveOwnerWorkCaller: typeof sourceOwnerCaller =
  process.env.OWNER_WORK_CALLER_COMPILED === "1"
    ? (await import(new URL("../../../../dist/owner-work-manual-caller.js", import.meta.url).href))
        .createCollectiveOwnerWorkCaller
    : sourceOwnerCaller;

const requestId = "54f70c6f-faf8-4a0b-8f9d-2e409bfcbb19";
/** Real committed Service Work; Task/thread ports below are explicit synthetic Host facts. */
async function human(outcome = "Implement A and return the result here.") {
  const f = await fixture();
  const event = await f.store.postHumanMessage(f.owner.sessionToken, {
    serviceInstanceId: f.connection.serviceInstanceId,
    collectiveId: f.connection.collectiveId,
    clientEventId: "manual-source",
    location: { channelId: "general" },
    recipient: { kind: "channel" },
    body: outcome,
  });
  const proposed = await f.store.proposeCollectiveWork(f.owner.sessionToken, {
    serviceInstanceId: f.connection.serviceInstanceId,
    collectiveId: f.connection.collectiveId,
    sourceEventId: event.eventId,
    requestId: "manual-proposal",
  });
  const work = await f.store.commitCollectiveWork(f.owner.sessionToken, {
    serviceInstanceId: f.connection.serviceInstanceId,
    collectiveId: f.connection.collectiveId,
    workId: proposed.workId,
    expectedRevision: proposed.revision,
    requestId: "manual-commit",
    assignment: { connectionId: f.connection.connectionId, catId: "codex-sol", participationRevision: 1 },
  });
  await f.connector.sync(f.connection.connectionId);
  const item = (await f.connector.listInbox(f.connection.connectionId)).find(
    (row) => row.event.eventId === work.assignmentEventId,
  );
  if (!item) throw new Error("Expected actual Service assignment");
  const identity = collectiveEventSourceIdentity(item.event);
  if (!identity) throw new Error("Expected exact source identity");
  await f.connector.beginInboxRouting(f.connection.connectionId, item.event.eventId, 1);
  await f.connector.completeInboxRouting(f.connection.connectionId, item.event.eventId, 1, {
    kind: "thread_message",
    threadId: "channel",
    messageId: "source",
    catId: identity.catId,
  });
  let fact: PluginSourceFact = {
    id: "source",
    userId: "local-owner",
    threadId: "channel",
    catId: null,
    content: item.event.body,
    source: {
      connector: "collective",
      meta: {
        participation: identity,
        workRequest: item.event.workRequest,
        workAcceptanceNotice: item.event.workAcceptanceNotice,
      },
    },
    extra: { pluginMessage: { instanceId: "fixture-installation" } },
  };
  let task: PluginTaskReadItem | null = null,
    active = true;
  const calls: string[] = [];
  const threads = new Map([
    ["existing", { id: "existing", createdBy: "local-owner", participants: [] as string[] }],
    ["foreign", { id: "foreign", createdBy: "foreign", participants: [] as string[] }],
  ]);
  const context: Parameters<typeof createCollectiveOwnerWorkCaller>[0]["context"] = {
    sourceFacts: {
      async read({ messageRef }) {
        calls.push("source");
        if (messageRef !== "message:source") throw new Error("Source unavailable");
        return fact;
      },
    },
    ownerThreads: {
      async get(id) {
        calls.push("thread-get");
        return threads.get(id) ?? null;
      },
      async create() {
        calls.push("thread-create");
        const thread = { id: "private", createdBy: "local-owner", participants: [] as string[] };
        threads.set(thread.id, thread);
        return thread;
      },
      async addParticipants(input) {
        calls.push("participants");
        const thread = threads.get(input.threadId);
        if (!thread) throw new Error("Thread unavailable");
        thread.participants.push(...input.catIds);
        return thread;
      },
    },
    tasks: {
      async get(id) {
        calls.push("task-get");
        return task?.id === id ? task : null;
      },
      async listByKind() {
        calls.push("task-list");
        return task ? [task] : [];
      },
      async prepareEntrusted(input) {
        calls.push("prepare");
        expect(input.sourceMessageId).toBe(fact.id);
        expect(input.targetCatId).toBe(identity.catId);
        if (input.destination.kind !== "existing_thread") throw new Error("Expected owner-selected thread");
        if (input.subject.kind === "continue") {
          expect(input.subject.taskRef).toBe("task:work:task");
          expect(input.subject.expectedRevision).toBe(1);
          if (!task) throw new Error("Task unavailable");
        } else {
          expect(input.subject.intendedOutcome).toBe(work.intendedOutcome);
          if (!task)
            task = {
              id: "task",
              userId: "local-owner",
              threadId: input.destination.threadId,
              kind: "work",
              subjectKey: null,
              title: input.subject.title,
              why: work.intendedOutcome,
              ownerCatId: identity.catId,
              status: "todo",
              createdBy: "user",
              createdAt: 1,
              updatedAt: 1,
              entrustedWork: { revision: 1, closure: { state: "open" }, admission: { sourceRefs: ["message:source"] } },
            };
        }
        return {
          result: input.subject.kind === "continue" ? "resumed" : "admitted",
          taskRef: "task:work:task",
          taskRevision: 1,
          threadId: task.threadId,
          admissionRef: "message:first-receipt",
          executionRef: `message:${input.subject.kind}-execution`,
        };
      },
      async dispatchEntrusted() {
        calls.push("dispatch");
        return { messageRef: "message:trigger", entryId: "entry", status: "queued" };
      },
    },
  };
  const caller = createCollectiveOwnerWorkCaller({
    connector: f.connector,
    context,
    current: async () => {
      if (!active) throw new Error("Owner binding expired");
    },
  });
  return {
    ...f,
    work,
    identity,
    calls,
    threads,
    context,
    caller,
    expire: () => {
      active = false;
    },
    task: () => task,
    setTask: (value: PluginTaskReadItem) => {
      task = value;
    },
    source: () => fact,
    setSource: (value: PluginSourceFact) => {
      fact = value;
    },
  };
}

test("manual owner admission and resume retain one real Service commitment, Task, first source and private thread", async () => {
  const f = await human();
  try {
    const first = await f.caller.admit("local-owner", f.connection.connectionId, {
      sourceMessageId: "source",
      requestId,
    });
    expect(first).toMatchObject({
      result: "admitted",
      taskRef: "task:work:task",
      threadId: "private",
      queue: { status: "queued" },
    });
    expect(
      await f.caller.admit("local-owner", f.connection.connectionId, { sourceMessageId: "source", requestId }),
    ).toEqual(first);
    expect(f.calls.filter((call) => call === "thread-create")).toHaveLength(1);
    expect(f.threads.get("private")?.participants).toEqual(["codex-sol"]);
    expect(
      await f.caller.resume("local-owner", f.connection.connectionId, {
        taskId: "task",
        observedRevision: 1,
        requestId,
      }),
    ).toMatchObject({ result: "resumed", taskRef: "task:work:task", admissionRef: "message:first-receipt" });
    expect(f.task()?.entrustedWork?.admission.sourceRefs).toEqual(["message:source"]);
    expect((await f.connector.readAssignedWork(f.connection.connectionId, f.work.workId)).lifecycle).not.toBe(
      "completed",
    );
  } finally {
    await f.close();
  }
});

test("explicit owner thread selection rejects foreign ownership and adds only the assigned Cat", async () => {
  const f = await human();
  try {
    await expect(
      f.caller.admit("local-owner", f.connection.connectionId, {
        sourceMessageId: "source",
        requestId,
        threadId: "foreign",
      }),
    ).rejects.toMatchObject({ code: "THREAD_OWNER_MISMATCH" });
    expect(f.calls).not.toContain("prepare");
    expect(
      await f.caller.admit("local-owner", f.connection.connectionId, {
        sourceMessageId: "source",
        requestId,
        threadId: "existing",
      }),
    ).toMatchObject({ threadId: "existing" });
    expect(f.threads.get("existing")?.participants).toEqual(["codex-sol"]);
    expect(f.calls).not.toContain("thread-create");
  } finally {
    await f.close();
  }
});

test("closed matching Task and stale revision are refusals rather than permission for a second Task or thread", async () => {
  const f = await human();
  try {
    await f.caller.admit("local-owner", f.connection.connectionId, { sourceMessageId: "source", requestId });
    f.calls.length = 0;
    await expect(
      f.caller.resume("local-owner", f.connection.connectionId, { taskId: "task", observedRevision: 2, requestId }),
    ).rejects.toMatchObject({ code: "TASK_UNAVAILABLE" });
    const task = f.task();
    if (!task) throw new Error("Expected prepared Task");
    f.setTask({ ...task, status: "done" });
    await expect(
      f.caller.admit("local-owner", f.connection.connectionId, { sourceMessageId: "source", requestId }),
    ).rejects.toMatchObject({ code: "WORK_TASK_UNAVAILABLE" });
    expect(f.calls).not.toContain("thread-create");
    expect(f.calls).not.toContain("prepare");
    expect(f.calls).not.toContain("dispatch");
  } finally {
    await f.close();
  }
});

test("strict DTO and foreign source refuse before thread and Task effects", async () => {
  const f = await human();
  try {
    await expect(
      f.caller.admit("local-owner", f.connection.connectionId, {
        sourceMessageId: "source",
        requestId,
        ownerUserId: "foreign",
      }),
    ).rejects.toThrow();
    f.setSource({ ...f.source(), userId: "foreign" });
    await expect(
      f.caller.admit("local-owner", f.connection.connectionId, { sourceMessageId: "source", requestId }),
    ).rejects.toMatchObject({ code: "RETURN_UNAVAILABLE" });
    expect(f.calls).not.toContain("thread-create");
    expect(f.calls).not.toContain("prepare");
  } finally {
    await f.close();
  }
});

test("currentness lost during thread creation refuses later work and leaves the real late effect visible", async () => {
  const f = await human();
  try {
    const create = f.context.ownerThreads!.create;
    f.context.ownerThreads!.create = async (input) => {
      const thread = await create(input);
      f.expire();
      return thread;
    };
    await expect(
      f.caller.admit("local-owner", f.connection.connectionId, { sourceMessageId: "source", requestId }),
    ).rejects.toThrow("Owner binding expired");
    expect(f.threads.has("private")).toBe(true);
    expect(f.calls).not.toContain("prepare");
    expect(f.calls).not.toContain("dispatch");
  } finally {
    await f.close();
  }
});

test("source time clarification precedes effects; explicit deadline retains the original source ref", async () => {
  const f = await human("Implement this report by tomorrow.");
  try {
    expect(
      await f.caller.admit("local-owner", f.connection.connectionId, { sourceMessageId: "source", requestId }),
    ).toMatchObject({ result: "needs_clarification" });
    expect(f.calls).not.toContain("thread-create");
    expect(f.calls).not.toContain("prepare");
    const prepare = f.context.tasks.prepareEntrusted!;
    f.context.tasks.prepareEntrusted = async (input) => {
      if (input.subject.kind !== "new") throw new Error("Expected new admission");
      expect(input.subject.time?.businessDeadline).toEqual({ value: 1792100000000, sourceRef: "message:source" });
      return prepare(input);
    };
    expect(
      await f.caller.admit("local-owner", f.connection.connectionId, {
        sourceMessageId: "source",
        requestId,
        businessDeadline: 1792100000000,
      }),
    ).toMatchObject({ result: "admitted" });
  } finally {
    await f.close();
  }
});

test("background human Work cannot borrow the authenticated manual entry or an absent/expired standing scope", async () => {
  const f = await human();
  try {
    const caller = createCollectiveWorkAdmissionCaller({
      connector: f.connector,
      tasks: f.context.tasks,
      assertCurrent: async () => {},
    });
    f.context.tasks.prepareEntrusted = async (input) => {
      f.calls.push("prepare");
      expect(input.destination).toEqual({ kind: "derived_from_source" });
      return { result: "needs_clarification", clarificationReason: "Actual Host missing contract" };
    };
    const selection = {
      ownerUserId: "local-owner",
      identity: f.identity,
      sourceMessageId: "source",
      workId: f.work.workId,
      destination: { kind: "derived_from_source" as const },
    };
    await expect(caller.admit(selection)).rejects.toMatchObject({ code: "OWNER_ADMISSION_UNAVAILABLE" });
    expect(f.calls).not.toContain("prepare");
    const route = await f.connector.getHostRoute(f.connection.connectionId);
    if (!route) throw new Error("Expected actual route");
    const key = `${f.connection.authorizedHumanId}:codex-sol`;
    await f.connector.setHostRoute(
      f.connection.connectionId,
      {
        localOwnerUserId: route.localOwnerUserId,
        defaultIngressThreadId: route.defaultIngressThreadId,
        humanNotificationThreadId: route.humanNotificationThreadId,
        agentRoutes: {
          ...route.agentRoutes,
          [key]: {
            ...route.agentRoutes[key]!,
            standingWork: { channelIds: ["general"], requestingHumanIds: [f.owner.human.humanId], expiresAt: null },
          },
        },
      },
      route.revision,
    );
    expect(await caller.admit(selection)).toMatchObject({ result: "needs_clarification" });
    const live = await f.connector.getHostRoute(f.connection.connectionId);
    if (!live) throw new Error("Expected current route");
    await f.connector.setHostRoute(
      f.connection.connectionId,
      {
        localOwnerUserId: live.localOwnerUserId,
        defaultIngressThreadId: live.defaultIngressThreadId,
        humanNotificationThreadId: live.humanNotificationThreadId,
        agentRoutes: {
          ...live.agentRoutes,
          [key]: {
            ...live.agentRoutes[key]!,
            standingWork: {
              channelIds: ["general"],
              requestingHumanIds: [f.owner.human.humanId],
              expiresAt: "2020-01-01T00:00:00.000Z",
            },
          },
        },
      },
      live.revision,
    );
    f.calls.length = 0;
    await expect(caller.admit(selection)).rejects.toMatchObject({ code: "OWNER_ADMISSION_UNAVAILABLE" });
    expect(f.calls).not.toContain("prepare");
    expect(f.calls).not.toContain("dispatch");
  } finally {
    await f.close();
  }
});
