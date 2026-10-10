import { createHash } from 'node:crypto';
import type { PluginStorageHost } from '@clowder-ai/plugin-sdk';
import type { TaskItem } from './business/model/index.js';
import type { CommunityTracking } from './business/domains/community/ports/CommunityTracking.js';
import type { GitHubSnapshot, GitHubTarget, GitHubTrackingProvider } from './tracking-runtime.js';

const prefix = 'community.collection.v1.';
const idFor = (subject: string) => 'community-collection:' + createHash('sha256').update(subject).digest('hex');
const keyFor = (id: string) => {
  if (!/^community-collection:[a-f0-9]{64}$/.test(id)) throw new TypeError('Invalid collection id');
  return prefix + id.slice('community-collection:'.length);
};
function parse(subject: string) {
  const match = /^(pr|issue):([a-z0-9_.-]+\/[a-z0-9_.-]+)#([1-9]\d*)$/.exec(subject);
  if (!match || match[0] !== subject || match[2]!.split('/').some(x => x === '.' || x === '..') || !Number.isSafeInteger(Number(match[3]))) throw new TypeError('Invalid collection subject');
  return { kind: match[1] as 'pr' | 'issue', repoFullName: match[2]!, number: Number(match[3]) };
}
interface RecordV1 { readonly schemaVersion: 1; readonly task: TaskItem }
function decode(value: unknown): RecordV1 {
  const record = value as RecordV1;
  if (!record || record.schemaVersion !== 1 || !record.task?.subjectKey || idFor(record.task.subjectKey) !== record.task.id ||
      `${parse(record.task.subjectKey).kind}_tracking` !== record.task.kind || record.task.pluginWait || record.task.automationState?.await || record.task.automationState?.waitOutcome) throw new Error('Invalid private collection record');
  return record;
}

/** Task-shaped compatibility view for the migrated board, NOT a Host Task.
 * This namespace owns only provider collection and never calls tasks.setWait.
 * Cancelling retains the row and its cursors (TTL=0); rerouting reactivates it. */
export class SdkCommunityCollectionStore implements CommunityTracking {
  constructor(private readonly storage: PluginStorageHost, private readonly now = Date.now) {}
  async listByKind(kind: TaskItem['kind']): Promise<readonly TaskItem[]> {
    return Object.entries(await this.storage.list()).filter(([key]) => key.startsWith(prefix)).map(([, entry]) => decode(entry.value).task).filter(task => task.kind === kind);
  }
  async getBySubject(subject: string): Promise<TaskItem | null> {
    parse(subject); const entry = await this.read(idFor(subject)); return entry?.task.status === 'doing' ? entry.task : null;
  }
  async read(id: string) {
    const entry = await this.storage.get(keyFor(id));
    if (!entry) return null;
    const record = decode(entry.value);
    if (record.task.id !== id) throw new Error('Collection key mismatch');
    return { revision: entry.revision, task: record.task };
  }
  async upsertBySubject(input: Parameters<CommunityTracking['upsertBySubject']>[0]): Promise<TaskItem> {
    const subjectKey = input.subjectKey.toLowerCase(), target = parse(subjectKey), id = idFor(subjectKey);
    if (input.kind !== `${target.kind}_tracking` || !input.threadId || !input.ownerCatId || input.automationState?.await || input.automationState?.waitOutcome) throw new TypeError('Collection is not native wait registration');
    for (let attempt = 0; attempt < 64; attempt++) {
      const previous = await this.read(id), now = this.now();
      if (previous?.task.status === 'doing' && previous.task.threadId === input.threadId && previous.task.ownerCatId === input.ownerCatId) return previous.task;
      const task: TaskItem = { id, kind: input.kind, subjectKey, threadId: input.threadId, ownerCatId: input.ownerCatId,
        title: input.title, why: input.why, createdBy: input.createdBy, createdAt: previous?.task.createdAt ?? now, updatedAt: now, status: 'doing',
        ...(input.userId ? { userId: input.userId } : {}), automationState: previous?.task.automationState ?? input.automationState ?? {} };
      if ((await this.storage.compareAndSet(keyFor(id), previous?.revision ?? null, { schemaVersion: 1, task })).applied) return task;
    }
    throw new Error('Collection registration changed concurrently');
  }
  async delete(id: string): Promise<boolean> {
    for (let attempt = 0; attempt < 64; attempt++) {
      const before = await this.read(id); if (!before || before.task.status === 'done') return false;
      if ((await this.storage.compareAndSet(keyFor(id), before.revision, { schemaVersion: 1, task: { ...before.task, status: 'done', updatedAt: this.now() } })).applied) return true;
    }
    throw new Error('Collection cancellation changed concurrently');
  }
  async checkpoint(before: NonNullable<Awaited<ReturnType<SdkCommunityCollectionStore['read']>>>, snapshot: GitHubSnapshot): Promise<void> {
    const task = before.task;
    const max = (kind: 'inline' | 'conversation', previous = 0) => Math.max(previous, ...snapshot.comments.filter(c => c.commentType === kind).map(c => c.id));
    const automationState = task.kind === 'issue_tracking'
      ? { issue: { ...task.automationState?.issue, lastCommentCursor: max('conversation', task.automationState?.issue?.lastCommentCursor), issueState: snapshot.state === 'open' ? 'open' : 'closed' } }
      : { ci: { ...task.automationState?.ci, headSha: snapshot.headSha, ...(snapshot.state === 'open' ? {} : { prState: snapshot.state }) },
        review: { ...task.automationState?.review, lastInlineCommentCursor: max('inline', task.automationState?.review?.lastInlineCommentCursor), lastConversationCommentCursor: max('conversation', task.automationState?.review?.lastConversationCommentCursor) } };
    await this.storage.compareAndSet(keyFor(task.id), before.revision, { schemaVersion: 1, task: { ...task, automationState,
      status: snapshot.state === 'open' ? 'doing' : 'done', updatedAt: this.now() } });
  }
}
interface CollectionOptions {
  readonly store: SdkCommunityCollectionStore;
  readonly provider: Pick<GitHubTrackingProvider, 'read'>;
  readonly allowed: (repo: string) => Promise<boolean>;
  readonly collect: (target: GitHubTarget, snapshot: GitHubSnapshot) => Promise<void>;
  readonly observe: (target: GitHubTarget, snapshot: GitHubSnapshot) => Promise<void>;
}
export class CommunityCollectionRuntime {
  private readonly lifetime = new AbortController();
  private readonly running = new Map<string, Promise<void>>();
  constructor(private readonly options: CollectionOptions) {}
  poll(kind: 'pr' | 'issue'): Promise<void> {
    this.lifetime.signal.throwIfAborted();
    const existing = this.running.get(kind); if (existing) return existing;
    const run = this.collect(kind).finally(() => { this.running.delete(kind); }); this.running.set(kind, run); return run;
  }
  private async collect(kind: 'pr' | 'issue'): Promise<void> {
    for (const task of await this.options.store.listByKind(`${kind}_tracking`)) {
      this.lifetime.signal.throwIfAborted();
      const before = await this.options.store.read(task.id); if (!before || before.task.status !== 'doing') continue;
      const target = { ...parse(before.task.subjectKey!), threadId: before.task.threadId, catId: before.task.ownerCatId! };
      if (!await this.options.allowed(target.repoFullName)) continue;
      this.lifetime.signal.throwIfAborted();
      const state = before.task.automationState;
      const snapshot = await this.options.provider.read(target, this.lifetime.signal, { inline: state?.review?.lastInlineCommentCursor ?? 0,
        conversation: kind === 'issue' ? state?.issue?.lastCommentCursor ?? 0 : state?.review?.lastConversationCommentCursor ?? 0 });
      this.lifetime.signal.throwIfAborted();
      if (!await this.options.allowed(target.repoFullName) || (await this.options.store.read(task.id))?.revision !== before.revision) continue;
      this.lifetime.signal.throwIfAborted();
      if (snapshot.commentsComplete !== true) throw new Error('Collection snapshot incomplete');
      await this.options.collect(target, snapshot);
      this.lifetime.signal.throwIfAborted();
      await this.options.observe(target, snapshot);
      this.lifetime.signal.throwIfAborted();
      await this.options.store.checkpoint(before, snapshot);
    }
  }
  async stop(): Promise<void> { this.lifetime.abort(); await Promise.allSettled(this.running.values()); }
}
