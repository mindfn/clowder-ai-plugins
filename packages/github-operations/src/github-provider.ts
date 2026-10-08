import { fetchPaginated } from './business/infrastructure/github/fetch-paginated.js';
import { executeGitHubRequest, type GitHubRequestOptions } from './business/infrastructure/github/request-budget.js';
import { fetchPrCiStatus, type FetchPrCiStatusOptions } from './business/infrastructure/email/ci-status-fetcher.js';
import { fetchPrCiStatuses, ciStatusTargetKey } from './business/infrastructure/email/ci-status-batch-fetcher.js';
import type { CiPollResult } from './business/infrastructure/email/ci-cd-contract.js';
import { classifyCiWaitBucket } from './business/infrastructure/email/CiCdRouter.js';
import { fetchGitHubReviewThreads } from './business/infrastructure/github/fetch-review-threads.js';
import type { GitHubComment, GitHubReview, GitHubSnapshot, GitHubTarget, GitHubTrackingProvider } from './tracking-runtime.js';
import type { CommunityProvider, RepoSubject } from './community-runtime.js';
import type { RepoIssueComment } from './business/infrastructure/connectors/github-repo-event/RepoCommentPollTaskSpec.js';

interface ApiComment {
  id: number; user: { login: string; type?: string }; body?: string;
  commit_id?: string; created_at?: string; author_association?: string;
}
interface ApiReview {
  id: number; user: { login: string; type?: string }; state: string;
  commit_id?: string; submitted_at?: string; author_association?: string;
}
function commentOf(value: ApiComment, commentType: GitHubComment['commentType']): GitHubComment {
  return { id: value.id, author: value.user.login, body: value.body ?? '', commentType,
    ...(value.commit_id ? { commitId: value.commit_id } : {}),
    ...(value.created_at ? { createdAt: value.created_at } : {}),
    ...(value.user.type ? { actorType: value.user.type } : {}),
    ...(value.author_association ? { authorAssociation: value.author_association } : {}),
  };
}

function ciOptions(options: GitHubRequestOptions): FetchPrCiStatusOptions {
  return { ghToken: options.ghToken, signal: options.signal,
    ...(options.execFileAsync ? { execFileAsync: (file, args, opts) => options.execFileAsync!(file, [...args], opts as Parameters<NonNullable<GitHubRequestOptions['execFileAsync']>>[2]) } : {}),
  };
}

/** Real gh JSON transport, retaining the migrated quota, pagination and child-close handling. */
export class GitHubProvider implements GitHubTrackingProvider, CommunityProvider {
  private login: string | undefined;
  constructor(private readonly options: {
    token(): Promise<string | undefined>;
    log: { warn(message: string, fields?: Readonly<Record<string, unknown>>): void };
    execFileAsync?: GitHubRequestOptions['execFileAsync'];
  }) {}

  selfLogin(): string | undefined { return this.login; }

  async forCiBatch(targets: readonly GitHubTarget[], signal: AbortSignal): Promise<GitHubTrackingProvider> {
    const options = await this.requestOptions(signal);
    const results = await fetchPrCiStatuses(targets.filter(target => target.kind === 'pr').map(target => ({
      repoFullName: target.repoFullName, prNumber: target.number,
    })), { warn: () => this.options.log.warn('GitHub batch CI read incomplete; preserving unavailable baselines') }, ciOptions(options));
    // Scope the snapshot to this tick, never share mutable cached HEADs between
    // concurrent schedule channels or registrations.
    return { read: (target, signal, cursor) => this.read(target, signal, cursor,
      results.get(ciStatusTargetKey(target.repoFullName, target.number)) ?? null) };
  }

  private async requestOptions(signal: AbortSignal): Promise<GitHubRequestOptions> {
    signal.throwIfAborted();
    return { ghToken: await this.options.token(), signal, log: this.options.log,
      ...(this.options.execFileAsync ? { execFileAsync: this.options.execFileAsync } : {}) };
  }

  async listOpen(repo: string, signal: AbortSignal): Promise<RepoSubject[]> {
    const options = await this.requestOptions(signal);
    const subjects: RepoSubject[] = [];
    for (const kind of ['pr', 'issue'] as const) {
      const values = await fetchPaginated(`/repos/${repo}/${kind === 'pr' ? 'pulls' : 'issues'}?state=open`, options);
      for (const value of values) {
        if (kind === 'issue' && value.pull_request) continue;
        subjects.push({ kind, number: value.number, title: value.title, url: value.html_url,
          author: value.user.login, authorAssociation: value.author_association, draft: value.draft === true });
      }
    }
    return subjects;
  }

  async repoComments(repo: string, since: string | undefined, signal: AbortSignal): Promise<RepoIssueComment[]> {
    const options = await this.requestOptions(signal);
    this.login = (await executeGitHubRequest(['api', 'user', '--jq', '.login'], options)).stdout.trim() || undefined;
    const values = await fetchPaginated(`/repos/${repo}/issues/comments${since ? `?since=${encodeURIComponent(since)}` : ''}`, options);
    const kinds = new Map<number, boolean>();
    const comments: RepoIssueComment[] = [];
    for (const value of values) {
      const number = Number(String(value.issue_url).split('/').at(-1));
      if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid GitHub comment issue URL');
      if (!kinds.has(number)) {
        const metadata = JSON.parse((await executeGitHubRequest(['api', `/repos/${repo}/issues/${number}`], options)).stdout);
        kinds.set(number, !!metadata.pull_request);
      }
      comments.push({ issueNumber: number, commentId: value.id, author: value.user.login,
        authorAssociation: value.author_association, body: value.body ?? '', updatedAt: value.updated_at,
        isPullRequest: kinds.get(number)! });
    }
    return comments;
  }

  async state(repo: string, kind: 'pr' | 'issue', number: number, signal: AbortSignal) {
    const options = await this.requestOptions(signal);
    const data = JSON.parse((await executeGitHubRequest(['api', `/repos/${repo}/${kind === 'pr' ? 'pulls' : 'issues'}/${number}`], options)).stdout);
    return { state: data.state === 'closed' ? 'closed' as const : 'open' as const,
      closedAt: data.closed_at ?? null, mergedAt: data.merged_at ?? null };
  }

  async read(target: GitHubTarget, signal: AbortSignal, cursor?: { inline: number; conversation: number }, batchCi?: CiPollResult | null): Promise<GitHubSnapshot> {
    signal.throwIfAborted();
    const options: GitHubRequestOptions = {
      ghToken: await this.options.token(), signal, log: this.options.log,
      ...(this.options.execFileAsync ? { execFileAsync: this.options.execFileAsync } : {}),
    };
    const account = await executeGitHubRequest(['api', 'user', '--jq', '.login'], options);
    this.login = account.stdout.trim() || undefined;
    const path = `/repos/${target.repoFullName}`;
    const metadata = JSON.parse((await executeGitHubRequest(
      ['api', `${path}/${target.kind === 'pr' ? 'pulls' : 'issues'}/${target.number}`], options,
    )).stdout) as { state: string; user?: { login: string }; merged_at?: string | null; merged_by?: { login: string } | null; mergeable_state?: string; head?: { sha: string } };
    const conversation = await fetchPaginated(`${path}/issues/${target.number}/comments`, { ...options, sinceId: cursor?.conversation }) as ApiComment[];
    const comments: GitHubComment[] = conversation.map(c => commentOf(c, 'conversation'));
    const reviews: GitHubReview[] = [];
    let ci: GitHubSnapshot['ci'];
    let reviewThreads: GitHubSnapshot['reviewThreads'];
    if (target.kind === 'pr') {
      const inline = await fetchPaginated(`${path}/pulls/${target.number}/comments`, { ...options, sinceId: cursor?.inline }) as ApiComment[];
      comments.push(...inline.map(c => commentOf(c, 'inline')));
      const decisions = await fetchPaginated(`${path}/pulls/${target.number}/reviews`, options) as ApiReview[];
      reviews.push(...decisions.map(r => ({ id: r.id, author: r.user.login, state: r.state,
        ...(r.commit_id ? { commitId: r.commit_id } : {}),
        ...(r.submitted_at ? { submittedAt: r.submitted_at } : {}),
        ...(r.user.type ? { actorType: r.user.type } : {}),
        ...(r.author_association ? { authorAssociation: r.author_association } : {}),
      })));
      if (target.reviewThreadIds?.length) reviewThreads = await fetchGitHubReviewThreads(target.repoFullName, target.number, target.reviewThreadIds, options);
      const status = batchCi !== undefined ? batchCi : await fetchPrCiStatus(target.repoFullName, target.number, {
        warn: () => this.options.log.warn('GitHub CI read failed; preserving tracking baseline'),
      }, ciOptions(options));
      if (!status) throw new Error('GitHub CI snapshot unavailable');
      if (status.headSha !== metadata.head?.sha) throw new Error('GitHub HEAD changed during snapshot; retry without advancing cursors');
      // Preserve CiCdRouter's empty-rollup rule: absence of checks is not a pass.
      ci = status.checkRollup === 'empty' ? 'pending' : classifyCiWaitBucket(status);
    }
    signal.throwIfAborted();
    return {
      state: metadata.merged_at ? 'merged' : metadata.state === 'closed' ? 'closed' : 'open',
      ...(metadata.user?.login ? { authorLogin: metadata.user.login } : {}),
      ...(metadata.merged_by?.login ? { mergedByLogin: metadata.merged_by.login } : {}),
      ...(metadata.head ? { headSha: metadata.head.sha } : {}),
      ...(ci ? { ci } : {}),
      ...(target.kind === 'pr' ? { mergeState: (metadata.mergeable_state ?? 'unknown').toUpperCase() } : {}),
      comments, reviews, ...(reviewThreads ? { reviewThreads } : {}),
    };
  }
}
