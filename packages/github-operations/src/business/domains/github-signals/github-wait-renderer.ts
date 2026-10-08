export const REVIEW_LOOP_BRAKE_NEXT_STEP = '[review-loop-brake]';
export const REVIEW_LOOP_HISTORY_WARN_NEXT_STEP = '[review-loop-history-unavailable] ';
const REVIEW_LOOP_BRAKE_THRESHOLD = 4;

export type GitHubReviewLoopBrake =
  | { readonly kind: 'pause_once'; readonly formalChangesRequested: number }
  | { readonly kind: 'continue'; readonly formalChangesRequested: number }
  | { readonly kind: 'warn_open'; readonly reason: string };

export function classifyGitHubReviewLoopBrake(
  history: readonly { readonly id: number; readonly state: string; readonly author: string }[],
  newDecisionIds: readonly number[],
  prAuthorLogin?: string,
): GitHubReviewLoopBrake {
  const author = prAuthorLogin?.toLowerCase();
  const formalChangesRequested = history.filter(
    (review) => review.state === 'CHANGES_REQUESTED' && (!author || review.author.toLowerCase() !== author),
  );
  const newIds = new Set(newDecisionIds);
  const previousCount = formalChangesRequested.filter((review) => !newIds.has(review.id)).length;
  return previousCount < REVIEW_LOOP_BRAKE_THRESHOLD && formalChangesRequested.length >= REVIEW_LOOP_BRAKE_THRESHOLD
    ? { kind: 'pause_once', formalChangesRequested: formalChangesRequested.length }
    : { kind: 'continue', formalChangesRequested: formalChangesRequested.length };
}
