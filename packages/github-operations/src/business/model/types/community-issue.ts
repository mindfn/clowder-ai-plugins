import type { CommunityRole } from './community-role.js';


export type IssueState = 'unreplied' | 'discussing' | 'pending-decision' | 'accepted' | 'declined' | 'closed';
export type IssueType = 'bug' | 'feature' | 'enhancement' | 'question';
export type ReplyState = 'unreplied' | 'replied';
export type ConsensusState = 'discussing' | 'consensus-reached' | 'stalled';
export type PrBoardGroup = 'in-review' | 're-review-needed' | 'has-conflict' | 'completed';

export interface CommunityIssueItem {
  readonly id: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly issueType: IssueType;
  readonly title: string;
  readonly state: IssueState;
  readonly replyState: ReplyState;
  readonly consensusState?: ConsensusState;
  readonly assignedThreadId: string | null;
  readonly assignedCatId: string | null;
  readonly linkedPrNumbers: readonly number[];
  readonly directionCard: Record<string, unknown> | null;
  readonly ownerDecision: 'accepted' | 'declined' | null;
  readonly relatedFeature: string | null;
  readonly guardianAssignment: GuardianAssignment | null;
  readonly lastActivity: { readonly at: number; readonly event: string };
  readonly createdAt: number;
  readonly updatedAt: number;
  // Phase F: route validation + source tracking (SO-2)
  readonly routeAcceptance?: RouteAcceptance | null;
  readonly routeSource?: RouteSource | null;
}

export interface CreateCommunityIssueInput {
  readonly repo: string;
  readonly issueNumber: number;
  readonly issueType: IssueType;
  readonly title: string;
}

// Phase A: Triage types for Direction Card orchestration
export type Verdict = 'WELCOME' | 'NEEDS-DISCUSSION' | 'POLITELY-DECLINE';
export type QuestionId = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
export type QuestionGrade = 'PASS' | 'WARN' | 'FAIL' | 'UNKNOWN';

export interface QuestionResult {
  readonly id: QuestionId;
  readonly result: QuestionGrade;
}

/** Narrator routeRecommendation — discriminated union (Phase C §0 terminal schema). */
export type RouteRecommendation =
  | { readonly kind: 'existing-thread'; readonly threadId: string }
  | { readonly kind: 'new-thread' }
  | { readonly kind: 'decline' };

// ---------------------------------------------------------------------------
// D0.5: Shared routeRecommendation parser (canonical validator for API + web)
// ---------------------------------------------------------------------------

export type ParseRouteRecommendationResult = { ok: true; value: RouteRecommendation } | { ok: false; reason: string };

const VALID_RR_KINDS = new Set(['existing-thread', 'new-thread', 'decline']);

/**
 * Parse and validate an unknown value as a RouteRecommendation.
 *
 * Strips unknown properties — only the canonical shape passes through.
 * Returns `{ ok: false }` for any malformed input (never throws).
 */
export function parseRouteRecommendation(input: unknown): ParseRouteRecommendationResult {
  if (input === null || input === undefined || typeof input !== 'object') {
    return { ok: false, reason: 'input must be a non-null object' };
  }

  const obj = input as Record<string, unknown>;
  const kind = obj.kind;

  if (typeof kind !== 'string' || !VALID_RR_KINDS.has(kind)) {
    return { ok: false, reason: `invalid kind: ${JSON.stringify(kind)}` };
  }

  switch (kind) {
    case 'existing-thread': {
      const threadId = obj.threadId;
      if (typeof threadId !== 'string' || threadId.length === 0) {
        return { ok: false, reason: 'existing-thread requires a non-empty threadId' };
      }
      return { ok: true, value: { kind: 'existing-thread', threadId } };
    }
    case 'new-thread':
      return { ok: true, value: { kind: 'new-thread' } };
    case 'decline':
      return { ok: true, value: { kind: 'decline' } };
    default:
      return { ok: false, reason: `unrecognized kind: ${kind}` };
  }
}

export interface TriageEntry {
  readonly catId: string;
  readonly verdict: Verdict;
  readonly questions: readonly QuestionResult[];
  readonly reasonCode?: string;
  readonly relatedFeature?: string;
  readonly timestamp: number;
  // F168 Phase C — narrator extension fields (all optional; INV-12: old entries remain valid)
  /** Marks a machine-generated entry from the narrator role vs. a human triage entry. */
  readonly authoredByRole?: CommunityRole;
  /** One-sentence "what is this issue about" in plain language produced by the narrator. */
  readonly narrative?: string;
  /** Evidence references gathered by narrator (linked feat/PR/issue anchors). */
  readonly evidenceRefs?: readonly string[];
  /** Narrator's route recommendation — one of the three outcome kinds. */
  readonly routeRecommendation?: RouteRecommendation;
  /** Which community role the narrator recommends should own this case (default: case-owner). */
  readonly recommendedOwnerRole?: CommunityRole;
}

export interface ConsensusResult {
  readonly verdict: Verdict;
  readonly needsOwner: boolean;
  readonly reasonCode?: string;
  readonly resolvedAt: number;
}

// Phase D: Intake Guardian types
export interface IntakeChecklistItem {
  readonly id: string;
  readonly label: string;
  readonly required: boolean;
  readonly evidence?: string;
  readonly verifiedAt?: number;
  readonly verifiedBy?: string;
}

export interface GuardianAssignment {
  readonly guardianCatId: string;
  readonly signoffTokenHash: string;
  readonly requestedAt: number;
  readonly requestedBy: string;
  readonly signedOff: boolean;
  readonly signedOffAt?: number;
  readonly approved?: boolean;
  readonly reason?: string;
  readonly checklist: readonly IntakeChecklistItem[];
}

// ---------------------------------------------------------------------------
// Phase F: Route acceptance state + source tracking (SO-2, SO-3)
// ---------------------------------------------------------------------------

/** Target cat's validation state for a routed issue (SO-2 state machine). */
export type RouteAcceptance = 'pending' | 'accepted' | 'rejected';

/** How the route was established. */
export type RouteSource = 'auto' | 'manual' | 'backfill';

// ---------------------------------------------------------------------------
// Phase F: Per-repo routing config (SO-0)
// ---------------------------------------------------------------------------

/** operator-defined per-repo guard assignment. Static config, not a state machine. */
export interface CommunityRepoConfig {
  readonly repo: string;
  readonly guardThreadId: string;
  readonly guardCatId: string;
  /** Missing legacy values hydrate fail-closed as observe_only. */
  readonly reviewMode: 'observe_only' | 'maintainer_review';
  /** Optional allows readiness only when no cloud review was requested. */
  readonly cloudReviewPolicy: 'optional' | 'required';
  readonly createdAt: number;
  readonly updatedAt: number;
}
