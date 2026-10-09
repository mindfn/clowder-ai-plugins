import { createHash, randomUUID } from 'node:crypto';
import type { PluginStorageHost } from '@clowder-ai/plugin-sdk';
import { mapGitHubPr, type GhPrFull, type GhPrReview } from './business/domains/community/github/GitHubPrFetcher.js';

export interface PrIndexProvider {
  /** One complete page, in stable provider number order, at most 25 rows. */
  page(repo: string, page: number, signal: AbortSignal): Promise<unknown[]>;
  /** Full bounded review history in provider order; errors must propagate. */
  reviews(repo: string, number: number, signal: AbortSignal): Promise<unknown[]>;
}
interface PrRow {
  repo: string; number: number; title: string; author: string; draft: boolean;
  state: 'open' | 'closed' | 'merged'; replyState: 'unreplied' | 'replied' | 'has-new-activity';
  headSha: string; lastReviewedSha: string | null;
}
interface Draft { generation: string; page: number; parts: string[]; numbers: number[] }
interface Published { generation: string; count: number; observedAt: number; parts: string[] }
interface Root { schema: 1; repo: string; published: Published | null; draft: Draft | null }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const prefix = (repo: string) => `github.pr-index.v1.${hash(repo)}.`;
const rootKey = (repo: string) => `${prefix(repo)}root`;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('PR index object required');
  return value as Record<string, unknown>;
}
function repoOf(value: unknown): string {
  if (typeof value !== 'string' || value.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) throw new TypeError('invalid repository');
  return value.toLowerCase();
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.length || value.length > max) throw new TypeError('invalid PR metadata string');
  return value;
}
function sha(value: unknown): string {
  const result = text(value, 64);
  if (!/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(result)) throw new TypeError('invalid PR commit');
  return result;
}
function metadata(value: unknown): GhPrFull {
  const p = object(value);
  if (!Number.isSafeInteger(p.number) || (p.number as number) < 1 || !['open', 'closed'].includes(p.state as string) ||
      typeof p.draft !== 'boolean' || (p.merged_at !== null && (typeof p.merged_at !== 'string' || !Number.isFinite(Date.parse(p.merged_at))))) {
    throw new TypeError('invalid PR metadata');
  }
  return { number: p.number as number, title: text(p.title, 1024), user: text(p.user, 100),
    state: p.state as string, merged_at: p.merged_at as string | null, head_sha: sha(p.head_sha), draft: p.draft,
    labels: [], updated_at: '' };
}
function review(value: unknown): GhPrReview {
  const r = object(value);
  return { user: text(r.user, 100), state: text(r.state, 40), commit_id: sha(r.commit_id) };
}
function rootOf(value: unknown, repo: string): Root {
  const r = object(value);
  if (r.schema !== 1 || r.repo !== repo) throw new TypeError('invalid PR index root');
  for (const kind of ['published', 'draft'] as const) {
    if (r[kind] === null) continue;
    const p = object(r[kind]);
    if (typeof p.generation !== 'string' || !/^[a-f0-9-]{36}$/.test(p.generation) || !Array.isArray(p.parts) || p.parts.length > 201 ||
        p.parts.some(key => typeof key !== 'string' || !key.startsWith(`${prefix(repo)}${p.generation}.`) || key.length > 200)) throw new TypeError('invalid PR index generation');
    if (kind === 'published' && (!Number.isSafeInteger(p.count) || (p.count as number) < 0 || (p.count as number) > 5000 ||
        !Number.isFinite(p.observedAt) || p.parts.length !== Math.floor((p.count as number) / 25) + 1)) throw new TypeError('invalid published PR index');
    if (kind === 'draft' && (!Number.isSafeInteger(p.page) || (p.page as number) < 1 || (p.page as number) > 201 ||
        !Array.isArray(p.numbers) || p.numbers.length > 5000 || p.numbers.some(n => !Number.isSafeInteger(n) || n < 1) ||
        new Set(p.numbers).size !== p.numbers.length || p.parts.length !== (p.page as number) - 1 || p.numbers.length !== p.parts.length * 25)) throw new TypeError('invalid staged PR index');
  }
  return r as unknown as Root;
}

/** Repository observations publish at one root CAS. Staging never replaces a
 * visible row, invokes Host governance, sends a notification or starts polling. */
export class PrProviderIndex {
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(private readonly storage: PluginStorageHost, private readonly provider: PrIndexProvider,
    private readonly timeoutMs = 30_000) {}

  async refresh(value: unknown) {
    const input = object(value), repo = repoOf(input.repo);
    if (Object.keys(input).some(k => !['repo', 'restart'].includes(k)) || (input.restart !== undefined && typeof input.restart !== 'boolean')) throw new TypeError('unsupported PR refresh field');
    this.lifetime.signal.throwIfAborted();
    const previous = this.queues.get(repo) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(() => this.step(repo, input.restart === true));
    this.queues.set(repo, work); this.pending.add(work);
    try { return await work; } finally {
      this.pending.delete(work); if (this.queues.get(repo) === work) this.queues.delete(repo);
    }
  }

  private async step(repo: string, restart: boolean) {
    this.lifetime.signal.throwIfAborted();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error('PR refresh timed out')), this.timeoutMs);
    const signal = AbortSignal.any([this.lifetime.signal, deadline.signal]);
    try {
      const entry = await this.storage.get(rootKey(repo));
      const root = entry ? rootOf(entry.value, repo) : { schema: 1 as const, repo, published: null, draft: null };
      const draft: Draft = !restart && root.draft ? root.draft : { generation: randomUUID(), page: 1, parts: [], numbers: [] };
      let failedSubject: number | null = null;
      try {
        const values = await this.provider.page(repo, draft.page, signal); signal.throwIfAborted();
        if (!Array.isArray(values) || values.length > 25) throw new TypeError('oversized PR page');
        const prs = values.map(metadata), numbers = new Set(draft.numbers);
        for (const pr of prs) {
          if (numbers.has(pr.number)) throw new TypeError('duplicate PR in refresh');
          numbers.add(pr.number);
        }
        if (numbers.size > 5000) {
          await this.storage.set(`${prefix(repo)}attempt`, { rootRevision: entry?.revision ?? null, status: 'limit_exceeded', attemptedAt: Date.now(), failedSubjects: [] });
          return { status: 'limit_exceeded', complete: false, hasMore: false, restartRequired: true,
          publishedGeneration: root.published?.generation ?? null, failedSubjects: [] };
        }
        const rows: PrRow[] = [];
        for (const pr of prs) {
          signal.throwIfAborted(); failedSubject = pr.number;
          const raw = pr.state === 'open' ? await this.provider.reviews(repo, pr.number, signal) : [];
          signal.throwIfAborted();
          if (!Array.isArray(raw) || raw.length > 10000) throw new TypeError('oversized PR review history');
          const mapped = mapGitHubPr(pr, raw.map(review));
          rows.push({ repo, number: pr.number, title: pr.title, author: pr.user, draft: pr.draft,
            headSha: pr.head_sha, ...mapped });
        }
        signal.throwIfAborted(); failedSubject = null;
        const key = `${prefix(repo)}${draft.generation}.${randomUUID()}`;
        if (Buffer.byteLength(JSON.stringify(rows)) > 128 * 1024) throw new TypeError('PR page exceeds storage bound');
        const stored = await this.storage.compareAndSet(key, null, rows);
        if (!stored.applied) throw new Error('PR generation key collision');
        const parts = [...draft.parts, key], complete = prs.length < 25;
        const next: Root = { schema: 1, repo,
          published: complete ? { generation: draft.generation, count: numbers.size, observedAt: Date.now(), parts } : root.published,
          draft: complete ? null : { generation: draft.generation, page: draft.page + 1, parts, numbers: [...numbers] } };
        signal.throwIfAborted();
        const result = await this.storage.compareAndSet(rootKey(repo), entry?.revision ?? null, next);
        if (!result.applied) throw new Error('PR refresh changed concurrently');
        return { status: complete ? 'complete' : 'incomplete', complete, hasMore: !complete,
          stagedCount: numbers.size, publishedGeneration: next.published?.generation ?? null,
          observedAt: next.published?.observedAt ?? null, failedSubjects: [] };
      } catch (error) {
        // The attempt is separate from the immutable published rows/root. A later
        // successful root revision makes this failure metadata inapplicable.
        if (!this.lifetime.signal.aborted) await this.storage.set(`${prefix(repo)}attempt`, {
          rootRevision: entry?.revision ?? null, status: 'failed', attemptedAt: Date.now(),
          failedSubjects: failedSubject === null ? [] : [failedSubject],
        });
        if (this.lifetime.signal.aborted) throw error;
        return { status: 'failed', complete: false, hasMore: true,
          publishedGeneration: root.published?.generation ?? null,
          failedSubjects: failedSubject === null ? [] : [failedSubject] };
      }
    } finally { clearTimeout(timer); }
  }

  async read(repoValue: unknown, after?: unknown, limitValue: unknown = 50) {
    this.lifetime.signal.throwIfAborted();
    const repo = repoOf(repoValue), limit = limitValue;
    if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw new TypeError('invalid PR page limit');
    const entry = await this.storage.get(rootKey(repo));
    const root = entry ? rootOf(entry.value, repo) : null, published = root?.published;
    let offset = 0;
    if (after !== undefined) {
      if (typeof after !== 'string' || after.length > 160) throw new TypeError('invalid PR cursor');
      const match = /^([a-f0-9-]{36}):([0-9]+)$/.exec(after);
      if (!match || match[1] !== published?.generation || !Number.isSafeInteger(Number(match[2]))) throw new TypeError('stale or invalid PR cursor');
      offset = Number(match[2]); if (offset > published.count) throw new TypeError('invalid PR cursor offset');
    }
    const attempt = await this.storage.get(`${prefix(repo)}attempt`);
    const failure = attempt && object(attempt.value).rootRevision === (entry?.revision ?? null) ? object(attempt.value) : null;
    const items: PrRow[] = [];
    const end = Math.min(published?.count ?? 0, offset + (limit as number));
    if (published) for (let index = Math.floor(offset / 25); index < Math.ceil(end / 25); index++) {
      const part = await this.storage.get(published.parts[index]!);
      if (!part || !Array.isArray(part.value) || part.value.length > 25) throw new TypeError('missing or malformed PR generation page');
      for (const value of part.value.slice(Math.max(0, offset - index * 25), Math.min(25, end - index * 25))) {
        const row = object(value);
        if (row.repo !== repo || !Number.isSafeInteger(row.number) || (row.number as number) < 1 || typeof row.draft !== 'boolean' || !['open', 'closed', 'merged'].includes(row.state as string) || !['unreplied', 'replied', 'has-new-activity'].includes(row.replyState as string)) throw new TypeError('invalid stored PR row');
        // Deliberate projection: injected authority fields are never returned.
        items.push({ repo, number: row.number as number, title: text(row.title, 1024), author: text(row.author, 100),
          state: row.state as PrRow['state'], replyState: row.replyState as PrRow['replyState'], headSha: sha(row.headSha),
          lastReviewedSha: row.lastReviewedSha === null ? null : sha(row.lastReviewedSha), draft: row.draft as boolean });
      }
    }
    if (items.length !== end - offset) throw new TypeError('incomplete published PR generation');
    return { items, publishedGeneration: published?.generation ?? null, observedAt: published?.observedAt ?? null,
      refreshStatus: failure ? failure.status : root?.draft ? 'incomplete' : published ? 'complete' : 'never',
      failedSubjects: failure?.failedSubjects ?? [],
      nextAfter: published && end < published.count ? `${published.generation}:${end}` : null };
  }

  async repositories() {
    this.lifetime.signal.throwIfAborted();
    const entries = await this.storage.list();
    const result: { repo: string; publishedGeneration: string; observedAt: number; count: number }[] = [];
    for (const [key, entry] of Object.entries(entries)) {
      if (!/^github\.pr-index\.v1\.[a-f0-9]{64}\.root$/.test(key)) continue;
      const repo = repoOf(object(entry.value).repo);
      if (key !== rootKey(repo)) throw new TypeError('invalid PR repository key');
      const root = rootOf(entry.value, repo);
      if (root.published) result.push({ repo, publishedGeneration: root.published.generation, observedAt: root.published.observedAt, count: root.published.count });
    }
    return result.sort((a, b) => a.repo.localeCompare(b.repo));
  }

  async stop() { this.lifetime.abort(new Error('PR index stopped')); await Promise.allSettled([...this.pending]); }
}
