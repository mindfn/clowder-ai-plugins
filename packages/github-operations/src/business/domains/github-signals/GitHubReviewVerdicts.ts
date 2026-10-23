import type {
  GitHubReviewVerdictState, GitHubReviewVerdicts, GitHubSubmittedReviewState, GitHubSubmittedReviewStates,
} from '../../model/index.js';

/**
 * #1392: a review decision can change without a new review. GitHub dismisses a verdict in place: the
 * review keeps its id, author and submitted_at, and its state becomes DISMISSED. An id cursor never
 * sees that, so a wait records which reviews hold a verdict and compares their states.
 */

const VERDICT_STATES: ReadonlySet<string> = new Set<GitHubReviewVerdictState>([
  'APPROVED',
  'CHANGES_REQUESTED',
  'DISMISSED',
]);

function isVerdictState(state: unknown): state is GitHubReviewVerdictState {
  return typeof state === 'string' && VERDICT_STATES.has(state);
}

/** States that establish a review decision. COMMENTED carries review content; DISMISSED revokes a
 * previously held verdict and is matched through the verdict-state path below. */
export function isGitHubReviewDecisionState(state: unknown): state is 'APPROVED' | 'CHANGES_REQUESTED' {
  return state === 'APPROVED' || state === 'CHANGES_REQUESTED';
}

type MutableVerdicts = Record<string, GitHubReviewVerdicts[string]>;
type MutableSubmittedStates = Record<string, GitHubSubmittedReviewStates[string]>;

const SUBMITTED_STATES: ReadonlySet<string> = new Set<GitHubSubmittedReviewState>([
  'APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED',
]);

function isSubmittedState(state: unknown): state is GitHubSubmittedReviewState {
  return typeof state === 'string' && SUBMITTED_STATES.has(state);
}

/** Every review that holds or held a verdict. Comment-only and pending reviews carry none. */
export function reviewVerdictsOf(
  reviews: readonly { readonly id?: unknown; readonly state?: unknown; readonly author?: string }[],
): GitHubReviewVerdicts {
  const verdicts: MutableVerdicts = {};
  for (const review of reviews) {
    if (typeof review.id !== 'number' || !isVerdictState(review.state)) continue;
    verdicts[String(review.id)] = { state: review.state, ...(review.author ? { author: review.author } : {}) };
  }
  return verdicts;
}

/** Every review whose submitted state has been consumed. PENDING is only a transport preview. */
export function submittedReviewStatesOf(
  reviews: readonly { readonly id?: unknown; readonly state?: unknown; readonly author?: string }[],
): GitHubSubmittedReviewStates {
  const states: MutableSubmittedStates = {};
  for (const review of reviews) {
    if (typeof review.id !== 'number' || !isSubmittedState(review.state)) continue;
    states[String(review.id)] = { state: review.state, ...(review.author ? { author: review.author } : {}) };
  }
  return states;
}

/**
 * What a wait has seen, advanced by one observation. DISMISSED is final, so a late observation that
 * still shows a verdict live cannot bring it back and have its dismissal reported a second time.
 */
export function mergeReviewVerdicts(
  seen: GitHubReviewVerdicts | undefined,
  observed: GitHubReviewVerdicts | undefined,
): GitHubReviewVerdicts | undefined {
  if (!observed) return seen;
  const merged: MutableVerdicts = { ...seen };
  for (const [reviewId, verdict] of Object.entries(observed)) {
    if (merged[reviewId]?.state !== 'DISMISSED') merged[reviewId] = verdict;
  }
  return merged;
}

/** Submitted states never regress to PENDING/absence. DISMISSED is terminal; another submitted
 * state may replace an earlier non-terminal representation of the same GitHub review id. */
export function mergeSubmittedReviewStates(
  seen: GitHubSubmittedReviewStates | undefined,
  observed: GitHubSubmittedReviewStates | undefined,
): GitHubSubmittedReviewStates | undefined {
  if (!observed) return seen;
  const merged: MutableSubmittedStates = { ...seen };
  for (const [reviewId, state] of Object.entries(observed)) {
    if (merged[reviewId]?.state !== 'DISMISSED') merged[reviewId] = state;
  }
  return merged;
}

export interface DismissedVerdict {
  readonly reviewId: string;
  readonly previous: Exclude<GitHubReviewVerdictState, 'DISMISSED'>;
  readonly author?: string;
}

/** Verdicts the wait saw live that this observation shows dismissed. */
export function dismissedVerdicts(
  seen: GitHubReviewVerdicts | undefined,
  observed: GitHubReviewVerdicts | undefined,
): DismissedVerdict[] {
  if (!seen || !observed) return [];
  const dismissed: DismissedVerdict[] = [];
  for (const [reviewId, verdict] of Object.entries(seen)) {
    if (verdict.state === 'DISMISSED' || observed[reviewId]?.state !== 'DISMISSED') continue;
    dismissed.push({ reviewId, previous: verdict.state, ...(verdict.author ? { author: verdict.author } : {}) });
  }
  return dismissed;
}
