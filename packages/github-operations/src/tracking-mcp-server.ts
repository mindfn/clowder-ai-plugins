import { GITHUB_PR_WAIT_PREDICATE_LIMIT } from './business/model/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerPrTrackingInputSchema, registerIssueTrackingInputSchema, unregisterTrackingInputSchema } from './tracking-mcp-schemas.js';

/** The installed plugin owns these handlers. No callback URL or Host GitHub route. */
export interface TrackingMcpHandlers {
  registerPr(input: unknown): Promise<unknown>;
  registerIssue(input: unknown): Promise<unknown>;
  unregister(input: unknown): Promise<unknown>;
}

export function createTrackingMcpServer(handlers: TrackingMcpHandlers): McpServer {
  const server = new McpServer({ name: 'clowder-github-tracking', version: '0.1.0' });
  const respond = (handler: (input: unknown) => Promise<unknown>) => async (input: unknown) => {
    try {
      return { content: [{ type: 'text' as const, text: JSON.stringify(await handler(input)) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const,
        text: error instanceof Error ? error.message : 'GitHub tracking failed' }] };
    }
  };
  server.tool('cat_cafe_register_pr_tracking',
    'Register continuous tracking of one PR for the current task owner. ' +
      'Use when: you want to hear about what happens on a PR — its review decision, CI, conflicts, a new HEAD unless you are the PR author, and the replies people leave on it. Naming the subject is the whole call. ' +
      'NOT for: another cat’s responsibility, or a different PR subject. ' +
      'Output: validates subject/owner, freezes a live GitHub baseline, atomically installs the next generation, and answers with what was armed and which audience was applied (`notification`). Registration history is baseline, never a wake. ' +
      'GOTCHA: For exact-HEAD external PR review, run the Review Entry Mode Classifier before registration: formal instructions containing a no-comment / do-not-comment-on-GitHub directive fail closed; only explicit advisory_read_only may stay private, and advisory must never claim review-complete. ' +
      `GOTCHA: \`repoFullName\` + \`prNumber\` is the whole normal call — omit \`when\`, \`goal\` and \`nextStep\`. The server then arms every condition the PR raises about itself, plus a new HEAD unless you are the PR author (as the author, that push is your own), AND both comment surfaces, with the audience your role gives you: as the PR author, every reply that is not your own, bots included; as a reviewer with checkable grounds, the PR author's replies with bots and pure summon commands filtered. If it cannot establish identity it delivers every comment flagged rather than filtering on a rule it could not verify — read \`notification.perspective\`. \`goal\` optionally narrows the comment audience to people you name. \`when\` is the advanced path: up to ${GITHUB_PR_WAIT_PREDICATE_LIMIT} flat any-of typed predicates, one per distinct condition in the catalog, where \`pr_conversation_comment_added\` and \`pr_inline_comment_added\` still require a non-empty \`authorLogins\`; there is no omitted-means-anyone form on that path. \`nextStep\` is display-only and never parsed. \`expiresAt\` is optional: omit it for no time-based termination; supply it for a visible deadline. It never deletes task history.`,
    registerPrTrackingInputSchema, respond(input => handlers.registerPr(input)));
  server.tool('cat_cafe_register_issue_tracking',
    'Register continuous tracking of one GitHub issue for the current task owner. ' +
      'Use when: you want to hear about new comments on an issue. Naming the subject is the whole call. ' +
      'NOT for: actor-type guessing, source prose, another cat’s responsibility, or a different issue subject. ' +
      'Output: validates subject/owner, freezes a live issue baseline, atomically installs the next generation, and answers with what was armed and which audience was applied (`notification`). Registration history is baseline, never a wake. ' +
      'GOTCHA: `repoFullName` + `issueNumber` is the whole normal call — omit `when` and `nextStep`. The server then wakes you on every comment that is not your own. `when` is the advanced path: a bounded typed predicate set for a narrower wait. `nextStep` is display-only and never parsed. `expiresAt` is optional: omit it for no time-based termination; supply it for a visible deadline. It never deletes task history.',
    registerIssueTrackingInputSchema, respond(input => handlers.registerIssue(input)));
  server.tool('cat_cafe_unregister_tracking',
    'Unregister a PR or issue tracking task by subjectKey. Stops all automated notifications ' +
      '(review feedback, CI/CD, conflict detection, issue comments) for this subject. ' +
      'Format: "pr:{owner/repo}#{num}" or "issue:{owner/repo}#{num}".',
    unregisterTrackingInputSchema, respond(input => handlers.unregister(input)));
  return server;
}
