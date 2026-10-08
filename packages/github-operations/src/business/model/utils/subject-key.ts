
/**
 * Subject key utilities (#320 KD-15).
 *
 * Standard format: `kind:value`
 *   pr:owner/repo#123
 *   thread:thread_abc123
 *   repo:owner/repo
 *   external:xyz
 */

export function prSubjectKey(repoFullName: string, prNumber: number): string {
  return `pr:${repoFullName.toLowerCase()}#${prNumber}`;
}

/** F202 Phase 2D: issue tracking subject key */
export function issueSubjectKey(repoFullName: string, issueNumber: number): string {
  return `issue:${repoFullName.toLowerCase()}#${issueNumber}`;
}

/** GitHub repository names are case-insensitive; durable subject keys are not. */
export function canonicalizeCommunitySubjectKey(subjectKey: string): string {
  const match = /^(pr|issue):([^/\s]+)\/([^#\s]+)#([1-9]\d*)$/i.exec(subjectKey.trim());
  if (!match) return subjectKey;
  const [, kind, owner, repo, number] = match;
  if (!kind || !owner || !repo || !number) return subjectKey;
  return `${kind.toLowerCase()}:${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
}
