import type { CatId } from './ids.js';


// ── Signal Types ───────────────────────────────────────────────

/** Phase A: cli_error + cancel_burst. Phase B: text_frustration. Phase C: a2a_timeout + retry_burst. UX-3: user_report. */
export type FrustrationSignalType =
  | 'cli_error'
  | 'cancel_burst'
  | 'text_frustration'
  | 'a2a_timeout'
  | 'retry_burst'
  | 'user_report';

// ── Issue Status ───────────────────────────────────────────────

/**
 * Status lifecycle:
 *   draft → confirmed       (user approved the auto-issue)
 *   draft → skipped         (user dismissed)
 *   draft → false_positive  (user flagged as false alarm — UX-1)
 */
export type FrustrationIssueStatus = 'draft' | 'confirmed' | 'skipped' | 'false_positive';

// ── Context (auto-collected) ───────────────────────────────────

export interface FrustrationContextMessage {
  role: 'user' | 'cat' | 'system';
  content: string;
  timestamp: number;
}

export interface FrustrationContextToolCall {
  tool: string;
  approved: boolean;
  timestamp: number;
}

export interface FrustrationIssueContext {
  recentMessages: FrustrationContextMessage[];
  errorLogs?: string;
  toolCallHistory?: FrustrationContextToolCall[];
}

// ── Issue ──────────────────────────────────────────────────────

export interface FrustrationIssue {
  issueId: string;
  status: FrustrationIssueStatus;

  // Location
  threadId: string;
  userId: string;
  catId: CatId;
  invocationId?: string;

  // Signal
  signalType: FrustrationSignalType;
  /** Signal-specific detail. cli_error: { reasonCode, publicSummary, publicHint }. cancel_burst: { cancelCount, windowMs }. */
  signalDetail: Record<string, unknown>;

  // Auto-collected context
  context: FrustrationIssueContext;

  // User-provided (set on confirm, optional)
  userDescription?: string;

  // Visibility marker (message ID of the card shown to user)
  cardMessageId?: string;

  // F235: Community publisher draft (set when user triggers "Publish to Community")
  communityIssueDraftId?: string;

  // Lifecycle
  createdAt: number;
  confirmedAt?: number;
  skippedAt?: number;
  falsePositiveAt?: number;
}
