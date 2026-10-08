import { createHash } from 'node:crypto';
import type { PluginStorageHost } from '@clowder-ai/plugin-sdk';
import { createCommunityIssueDraft, type CommunityIssueDraft, type CreateCommunityIssueDraftInput } from '../../model/index.js';

export interface PublishDraftInput { readonly draftId: string; readonly githubIssueNumber: number; readonly githubIssueUrl: string }
export interface ICommunityIssueDraftStore {
  create(input: CreateCommunityIssueDraftInput): Promise<CommunityIssueDraft>;
  getById(id: string): Promise<CommunityIssueDraft | null>;
  getBySourceId(sourceId: string): Promise<CommunityIssueDraft | null>;
  publish(input: PublishDraftInput): Promise<CommunityIssueDraft>;
  cancel(id: string): Promise<CommunityIssueDraft>;
  updateContent(id: string, title: string, body: string): Promise<CommunityIssueDraft>;
}
const prefix = 'community.drafts.';
const sourceKey = (source: string) => prefix + createHash('sha256').update(source).digest('hex');
interface SourceDrafts { active: string | null; drafts: Record<string, CommunityIssueDraft> }

/** The source's active pointer and its historical drafts commit in one CAS.
 * Cancellation clears only the pointer, never the user's previous draft. */
export class SdkCommunityIssueDraftStore implements ICommunityIssueDraftStore {
  constructor(private readonly storage: PluginStorageHost) {}
  async create(input: CreateCommunityIssueDraftInput): Promise<CommunityIssueDraft> {
    const draft = createCommunityIssueDraft(input), key = sourceKey(input.sourceId);
    for (let attempt = 0; attempt < 64; attempt++) {
      const entry = await this.storage.get(key);
      const source: SourceDrafts = entry ? entry.value as SourceDrafts : { active: null, drafts: {} };
      if (source.active) throw new Error(`Source ${input.sourceId} already has an active draft: ${source.active}`);
      const next = { active: draft.draftId, drafts: { ...source.drafts, [draft.draftId]: draft } };
      if ((await this.storage.compareAndSet(key, entry?.revision ?? null, next)).applied) return draft;
    }
    throw new Error('community draft create contention');
  }
  async getBySourceId(sourceId: string): Promise<CommunityIssueDraft | null> {
    const source = (await this.storage.get(sourceKey(sourceId)))?.value as SourceDrafts | undefined;
    return source?.active ? source.drafts[source.active] ?? null : null;
  }
  async getById(id: string): Promise<CommunityIssueDraft | null> {
    for (const [key, entry] of Object.entries(await this.storage.list())) {
      if (key.startsWith(prefix)) {
        const draft = (entry.value as SourceDrafts).drafts[id];
        if (draft) return draft;
      }
    }
    return null;
  }
  private async change(id: string, update: (draft: CommunityIssueDraft) => CommunityIssueDraft): Promise<CommunityIssueDraft> {
    const draft = await this.getById(id);
    if (!draft) throw new Error(`Draft ${id} not found`);
    const key = sourceKey(draft.sourceId);
    for (let attempt = 0; attempt < 64; attempt++) {
      const entry = await this.storage.get(key);
      if (!entry) throw new Error('Draft source record missing');
      const source = entry.value as SourceDrafts, existing = source.drafts[id];
      if (!existing || existing.status !== 'draft') throw new Error(`Draft ${id} is not draft`);
      const next = update(existing);
      const record = { active: next.status === 'cancelled' ? null : source.active, drafts: { ...source.drafts, [id]: next } };
      if ((await this.storage.compareAndSet(key, entry.revision, record)).applied) return next;
    }
    throw new Error('community draft update contention');
  }
  publish(input: PublishDraftInput): Promise<CommunityIssueDraft> {
    return this.change(input.draftId, draft => ({ ...draft, status: 'published', githubIssueNumber: input.githubIssueNumber, githubIssueUrl: input.githubIssueUrl, publishedAt: Date.now() }));
  }
  cancel(id: string): Promise<CommunityIssueDraft> { return this.change(id, draft => ({ ...draft, status: 'cancelled', cancelledAt: Date.now() })); }
  updateContent(id: string, title: string, bodyMarkdown: string): Promise<CommunityIssueDraft> {
    return this.change(id, draft => ({ ...draft, title, bodyMarkdown }));
  }
}
