


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
