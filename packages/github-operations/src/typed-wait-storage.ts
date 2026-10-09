import { createHash } from 'node:crypto';
import type { PluginStorageHost } from '@clowder-ai/plugin-sdk';
import type { AutomationState, TaskItem } from './business/model/index.js';
import { automationGeneration, type ITaskStore } from './business/domains/github-signals/wait-ports.js';
import { mergeTaskAutomationState } from './business/domains/github-signals/TaskAutomationState.js';

const PREFIX = 'github.typed-wait.v1.';
const key = (id: string) => PREFIX + createHash('sha256').update(id).digest('hex');
type RecordV1 = { readonly schemaVersion: 1; readonly task: TaskItem };

function decode(value: unknown): TaskItem {
  const record = value as Partial<RecordV1> | null;
  if (!record || record.schemaVersion !== 1 || !record.task
    || typeof record.task.id !== 'string' || typeof record.task.updatedAt !== 'number'
    || !['pr_tracking', 'issue_tracking'].includes(record.task.kind)) {
    throw new Error('Invalid GitHub typed wait record');
  }
  return record.task;
}

/** Wait algorithms persist provider state here, never in Host TaskItem. */
export class GitHubWaitStorage implements ITaskStore {
  constructor(private readonly storage: PluginStorageHost, private readonly now = Date.now) {}

  async get(id: string): Promise<TaskItem | null> {
    const entry = await this.storage.get(key(id));
    if (!entry) return null;
    const task = decode(entry.value);
    if (task.id !== id) throw new Error('GitHub typed wait key mismatch');
    return task;
  }

  async listByKind(kind: TaskItem['kind']): Promise<readonly TaskItem[]> {
    return Object.entries(await this.storage.list()).filter(([name]) => name.startsWith(PREFIX))
      .map(([, entry]) => decode(entry.value)).filter(task => task.kind === kind);
  }

  /** Caller supplies the SDK-created task projection; one immutable id per tracking history. */
  async create(task: TaskItem): Promise<TaskItem | null> {
    decode({ schemaVersion: 1, task });
    const stored = structuredClone(task);
    const result = await this.storage.compareAndSet(key(task.id), null, { schemaVersion: 1, task: stored });
    return result.applied ? stored : null;
  }

  async replaceAutomationStateIfGeneration(id: string, input: {
    readonly expectedGeneration: number | null;
    readonly expectedUpdatedAt: number;
    readonly automationState: AutomationState;
    readonly status: TaskItem['status'];
  }): Promise<TaskItem | null> {
    const entry = await this.storage.get(key(id));
    if (!entry) return null;
    const task = decode(entry.value);
    if (task.id !== id || automationGeneration(task.automationState) !== input.expectedGeneration
      || task.updatedAt !== input.expectedUpdatedAt) return null;
    const next: TaskItem = {
      ...task, automationState: input.automationState, status: input.status,
      updatedAt: Math.max(this.now(), task.updatedAt + 1),
    };
    const result = await this.storage.compareAndSet(key(id), entry.revision, { schemaVersion: 1, task: next });
    return result.applied ? structuredClone(next) : null;
  }

  async patchAutomationState(id: string, patch: Partial<AutomationState>): Promise<TaskItem | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const task = await this.get(id);
      if (!task) return null;
      const state = task.automationState ?? {};
      const changed = await this.replaceAutomationStateIfGeneration(id, {
        expectedGeneration: automationGeneration(state), expectedUpdatedAt: task.updatedAt,
        automationState: mergeTaskAutomationState(state, patch) ?? {}, status: task.status,
      });
      if (changed) return changed;
    }
    throw new Error('GitHub collector state changed concurrently; observation must be retried');
  }
}
