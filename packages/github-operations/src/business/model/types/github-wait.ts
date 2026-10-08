import type { UnifiedAwaitStateV1, WaitOutcomeBaseV1 } from './wait-contract.js';


export const GITHUB_PR_WAIT_PREDICATE_KINDS = [
  'pr_head_changed',
  'pr_review_result_available',
  'pr_review_decision_changed',
  'pr_review_thread_changed',
  'pr_ci_terminal',
  'pr_became_conflicting',
  'pr_conversation_comment_added',
  'pr_inline_comment_added',
] as const;

export const GITHUB_ISSUE_WAIT_PREDICATE_KINDS = ['issue_comment_added', 'issue_author_commented'] as const;

export const GITHUB_WAIT_PREDICATE_KINDS = [
  ...GITHUB_PR_WAIT_PREDICATE_KINDS,
  ...GITHUB_ISSUE_WAIT_PREDICATE_KINDS,
] as const;

/**
 * #1392 D1: one registration must be able to name every distinct condition its subject can raise.
 *
 * The cap is derived from the catalog rather than written down, because a hand-chosen number silently
 * becomes wrong the moment a kind is added. A fixed cap of four rejected a combination of five valid,
 * non-duplicate conditions — `pr_review_decision_changed`, `pr_conversation_comment_added`,
 * `pr_inline_comment_added`, `pr_ci_terminal`, `pr_became_conflicting` — forcing a caller to drop a
 * signal they needed or register a second tracker. Deduplication, unknown-kind rejection and required
 * parameters are unchanged: capacity is the only thing this raises.
 */
export const GITHUB_PR_WAIT_PREDICATE_LIMIT = GITHUB_PR_WAIT_PREDICATE_KINDS.length;

export const GITHUB_ISSUE_WAIT_PREDICATE_LIMIT = GITHUB_ISSUE_WAIT_PREDICATE_KINDS.length;

/**
 * #1392 AC-7: normal registration names a subject; the server decides who may wake you.
 *
 * The gap is concrete. An author reported a published dependency in a conversation comment while HEAD
 * never moved; a registration watching only `pr_head_changed` was healthy, unexpired, and never woke,
 * because what was awaited was a reply and not a push. Raising the condition cap gave callers room to
 * ask for the comment condition. It did nothing to stop them leaving it out, and an agent that cannot
 * poll does not discover the omission — it simply never hears anything again.
 *
 * An earlier build closed half of that: the bare default armed the four conditions a PR raises about
 * itself and no comment condition at all, because a comment audience had to be named and no default
 * audience was approved. A registration that succeeds while listening to no comments is the original
 * silent failure wearing a new hat, and the product owner has since settled the table it was waiting
 * on (#1392 §4, 2026-09-20). Both perspectives land together here; neither waits for the other.
 *
 * Role is resolved once, at registration, from authoritative GitHub metadata, and frozen into the
 * armed predicate so the caller can read back exactly what was armed and what will be filtered.
 */
export type GitHubTrackingIdentityGap = 'self' | 'subject_author' | 'reviewer_ground';

/**
 * The server-derived audience of a comment surface, frozen at registration.
 *
 * This sits beside `authorLogins` rather than replacing it because the two have different
 * provenance, and collapsing them would hide which one you got. `authorLogins` is a list the caller
 * wrote; `audience` is a rule the server derived from GitHub metadata.
 *
 * #1392 R2: on the normal entry both are present and both apply — the derived rule first, then the
 * caller's list as a further narrowing. Only the advanced explicit `when[]` path carries
 * `authorLogins` alone, where the list is the whole rule by design.
 */
export type GitHubCommentAudienceV1 =
  /** PR author perspective, and every issue: every comment that is not our own, bots included. */
  | { readonly mode: 'everyone_but_self'; readonly selfLogin: string }
  /** Maintainer/reviewer perspective: the subject author's own words, bots and pure summons filtered. */
  | { readonly mode: 'subject_author_only'; readonly subjectAuthorLogin: string }
  /**
   * Identity or role could not be determined. Nothing is dropped quietly: every comment matches and
   * is delivered, flagged, so the owner learns that coverage was never established. Over-delivering
   * costs a sentence; under-delivering costs an agent that cannot tell silence from nothing happening.
   */
  | { readonly mode: 'unresolved_identity'; readonly missing: readonly GitHubTrackingIdentityGap[] };

/** GitHub logins are case-insensitive, and a padded login could never equal a real one. */
function normalizeLogin(value: string | undefined): string | undefined {
  const login = value?.trim();
  return login ? login : undefined;
}

export function sameGitHubLogin(left: string | undefined, right: string | undefined): boolean {
  const a = normalizeLogin(left);
  const b = normalizeLogin(right);
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
}

export type GitHubWaitPredicateKind = (typeof GITHUB_WAIT_PREDICATE_KINDS)[number];

export type GitHubWaitPredicate =
  | { readonly kind: 'pr_head_changed' }
  | { readonly kind: 'pr_review_result_available'; readonly triggerCommentId?: number }
  | { readonly kind: 'pr_review_decision_changed' }
  | { readonly kind: 'pr_review_thread_changed'; readonly reviewThreadIds: readonly string[] }
  | { readonly kind: 'pr_ci_terminal' }
  | { readonly kind: 'pr_became_conflicting' }
  /**
   * #1392 AC-3 / AC-6 / AC-7: a new PR review comment on one surface. The two surfaces keep separate
   * frontiers — inline and conversation comment ids are not comparable.
   *
   * At least one of `authorLogins` and `audience` is present, and never neither: an omitted-means-anyone
   * form is the silent widening this issue exists to remove. `authorLogins` is the caller's own exact
   * allowlist; `audience` is the role the server resolved on the normal path.
   *
   * #1392 R2: the normal entry carries BOTH, and both have to admit a comment — the caller's list narrows
   * the derived rule instead of replacing it, so a list the rule already excludes matches nobody. Only the
   * advanced explicit `when[]` path carries `authorLogins` alone, used verbatim. Both are frozen at
   * registration and compared case-insensitively.
   */
  | {
      readonly kind: 'pr_conversation_comment_added';
      readonly authorLogins?: readonly string[];
      readonly audience?: GitHubCommentAudienceV1;
    }
  | {
      readonly kind: 'pr_inline_comment_added';
      readonly authorLogins?: readonly string[];
      readonly audience?: GitHubCommentAudienceV1;
    }
  /**
   * #1392 AC-3 / AC-7: `authorLogins` is the caller's optional exact allowlist; `audience` is the
   * server-resolved default. Both omitted keeps main's any-comment issue wait, which the issue
   * surface has always had and which is not a widening of anything.
   */
  | {
      readonly kind: 'issue_comment_added';
      readonly authorLogins?: readonly string[];
      readonly audience?: GitHubCommentAudienceV1;
    }
  | { readonly kind: 'issue_author_commented' };

export type GitHubPrWaitPredicate = Extract<GitHubWaitPredicate, { readonly kind: `pr_${string}` }>;
export type GitHubIssueWaitPredicate = Extract<GitHubWaitPredicate, { readonly kind: `issue_${string}` }>;

export type GitHubCiBaselineBucket = 'pending' | 'pass' | 'fail' | 'external_infrastructure';

export interface GitHubReviewThreadBaseline {
  readonly reviewThreadId: string;
  readonly lastCommentId: string | null;
  readonly resolved: boolean;
}

/**
 * #1392: the state of a formal review that holds, or held, a verdict. GitHub dismisses a verdict in
 * place: the review keeps its id and author and its state becomes DISMISSED. A dismissed review is
 * never revived; a new verdict is a new review.
 */
export type GitHubReviewVerdictState = 'APPROVED' | 'CHANGES_REQUESTED' | 'DISMISSED';

/** Keyed by review id. */
export type GitHubReviewVerdicts = Readonly<
  Record<string, { readonly state: GitHubReviewVerdictState; readonly author?: string }>
>;

export interface GitHubPrWaitBaseline {
  readonly capturedAt: number;
  readonly headSha: string;
  readonly review?: {
    readonly inlineCommentCursor: number;
    readonly conversationCommentCursor: number;
    readonly decisionCursor: number;
    readonly decision?: string;
    readonly resultTriggerCommentId?: number;
    readonly resultTriggerHeadSha?: string;
    readonly threads?: readonly GitHubReviewThreadBaseline[];
    /**
     * #1392: the verdicts this wait has seen. A dismissal keeps the review id, so it never moves
     * `decisionCursor`; it is found by comparing states. Absent on waits registered before this field
     * existed: those adopt the verdicts of their first review observation.
     */
    readonly verdicts?: GitHubReviewVerdicts;
  };
  readonly ci?: {
    readonly bucket: GitHubCiBaselineBucket;
    readonly fingerprint: string;
  };
  readonly conflict?: {
    readonly mergeState: string;
  };
}

export interface GitHubIssueWaitBaseline {
  readonly capturedAt: number;
  readonly issue: {
    readonly lastCommentCursor: number;
    readonly state: 'open' | 'closed';
    readonly authorLogin?: string;
  };
}

export type GitHubWaitBaseline = GitHubPrWaitBaseline | GitHubIssueWaitBaseline;
export type GitHubWaitSubjectRef = `pr:${string}#${number}` | `issue:${string}#${number}`;

type GitHubWaitProvenance = {
  readonly provenance?: 'explicit_registration' | 'legacy_migration_default';
};

export type GitHubPrAwaitStateV1 = UnifiedAwaitStateV1<
  `pr:${string}#${number}`,
  GitHubPrWaitBaseline,
  GitHubPrWaitPredicate
> &
  GitHubWaitProvenance;

export type GitHubIssueAwaitStateV1 = UnifiedAwaitStateV1<
  `issue:${string}#${number}`,
  GitHubIssueWaitBaseline,
  GitHubIssueWaitPredicate
> &
  GitHubWaitProvenance;

export type AwaitStateV1 = GitHubPrAwaitStateV1 | GitHubIssueAwaitStateV1;

export interface GitHubWaitMatchedDelta {
  readonly kind: GitHubWaitPredicateKind;
  readonly delta: string;
  readonly sourceRef?: string;
  /**
   * #1392 AC-7: this delta was matched while the subject's identity or our role on it was unknown,
   * so it was delivered rather than filtered. It says the event and its source are real and that
   * normal coverage was never established — not that the rule was applied and passed.
   */
  readonly identityUnknown?: true;
}

/** GitHub-specific result fields stay quarantined from other F280 wait domains. */
export interface GitHubWaitOutcomeV1 extends WaitOutcomeBaseV1<GitHubWaitSubjectRef> {
  readonly domain?: 'github';
  readonly matched?: readonly GitHubWaitMatchedDelta[];
  readonly terminalSubjectState?: 'merged' | 'closed';
  readonly deploymentMatch?: never;
  /**
   * #1392 AC-1: whether tracking continues after this outcome. `rearmed` means the next
   * generation was installed in the same transition; `rearm_failed` means the event is still
   * delivered but nothing is armed, and the owner must be told so. Absent means the wait ended.
   */
  readonly renewal?: 'rearmed' | 'rearm_failed';
}
