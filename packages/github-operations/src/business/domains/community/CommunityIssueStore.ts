import { createHash } from 'node:crypto';
import type { PluginStorageHost } from '@clowder-ai/plugin-sdk';
import type { CommunityIssueItem, CreateCommunityIssueInput, UpdateCommunityIssueInput } from '../../model/index.js';

export interface ICommunityIssueStore {
  create(input: CreateCommunityIssueInput): Promise<CommunityIssueItem | null>;
  get(id: string): Promise<CommunityIssueItem | null>;
  getByRepoAndNumber(repo: string, issueNumber: number): Promise<CommunityIssueItem | null>;
  listByRepo(repo: string): Promise<CommunityIssueItem[]>;
  listAll(): Promise<CommunityIssueItem[]>;
  update(id: string, input: UpdateCommunityIssueInput): Promise<CommunityIssueItem | null>;
  delete(id: string): Promise<boolean>;
}
const prefix = 'community.issue.';
const idOf = (repo: string, number: number) => createHash('sha256').update(`${repo.toLowerCase()}#${number}`).digest('hex');

/** The original issue defaults and update semantics, backed by private SDK CAS.
 * A subject-derived ID makes create/dedup a single durable operation. */
export class SdkCommunityIssueStore implements ICommunityIssueStore {
  constructor(private readonly storage: PluginStorageHost) {}
  async create(input: CreateCommunityIssueInput): Promise<CommunityIssueItem | null> {
    const now = Date.now(), id = idOf(input.repo, input.issueNumber);
    const item: CommunityIssueItem = {
      id, repo: input.repo.toLowerCase(), issueNumber: input.issueNumber, issueType: input.issueType, title: input.title,
      state: 'unreplied', replyState: 'unreplied', assignedThreadId: null, assignedCatId: null,
      linkedPrNumbers: [], directionCard: null, ownerDecision: null, relatedFeature: null, guardianAssignment: null,
      lastActivity: { at: now, event: 'created' }, createdAt: now, updatedAt: now,
    };
    return (await this.storage.compareAndSet(prefix + id, null, item)).applied ? item : null;
  }
  async get(id: string): Promise<CommunityIssueItem | null> {
    return (await this.storage.get(prefix + id))?.value as CommunityIssueItem | undefined ?? null;
  }
  getByRepoAndNumber(repo: string, number: number): Promise<CommunityIssueItem | null> { return this.get(idOf(repo, number)); }
  async listByRepo(repo: string): Promise<CommunityIssueItem[]> { return (await this.listAll()).filter(item => item.repo === repo.toLowerCase()); }
  async listAll(): Promise<CommunityIssueItem[]> {
    return Object.entries(await this.storage.list()).filter(([key]) => key.startsWith(prefix))
      .map(([, entry]) => entry.value as CommunityIssueItem).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async update(id: string, input: UpdateCommunityIssueInput): Promise<CommunityIssueItem | null> {
    for (let attempt = 0; attempt < 64; attempt++) {
      const entry = await this.storage.get(prefix + id);
      if (!entry) return null;
      const existing = entry.value as CommunityIssueItem;
      const updated = { ...existing, ...input, linkedPrNumbers: input.linkedPrNumbers ? [...input.linkedPrNumbers] : existing.linkedPrNumbers, updatedAt: Date.now() };
      if ((await this.storage.compareAndSet(prefix + id, entry.revision, updated)).applied) return updated;
    }
    throw new Error('community issue update contention');
  }
  async delete(id: string): Promise<boolean> { return (await this.storage.delete(prefix + id)).deleted; }
}
