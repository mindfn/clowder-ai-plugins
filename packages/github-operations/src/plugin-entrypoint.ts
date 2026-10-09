import { definePlugin, definePluginModule, type FeatureContext, type PluginModuleEntrypoint, type PluginActionContext } from '@clowder-ai/plugin-sdk';
import { GitHubProvider } from './github-provider.js';
import type { GitHubTrackingProvider } from './tracking-runtime.js';
import { TypedWaitRuntime } from './typed-wait-runtime.js';
import { CommunityRuntime, type CommunityProvider } from './community-runtime.js';
import type { UpsertRepoConfigInput } from './business/domains/community/CommunityRepoConfigStore.js';
import { recommendTriage } from './triage-recommendation.js';
import { previewPublicIssue } from './community-read-model.js';
import { NativeIssueDraftRuntime, type NativeIssuePublisher } from './native-issue-drafts.js';
import { PrProviderIndex, type PrIndexProvider } from './pr-provider-index.js';
import { GitHubPrIndexProvider } from './pr-index-provider.js';
import { ReviewTriggerReader } from './review-trigger-observation.js';

interface Provider extends GitHubTrackingProvider { selfLogin(): string | undefined }
export interface GitHubPluginOptions {
  readonly now?: () => number;
  /** Test the real carrier with an isolated provider; production uses the migrated gh transport. */
  readonly createProvider?: (context: FeatureContext) => Provider;
  readonly createCommunityProvider?: (context: FeatureContext) => CommunityProvider;
  readonly createIssuePublisher?: (context: FeatureContext) => NativeIssuePublisher;
  readonly createPrIndexProvider?: (context: FeatureContext) => PrIndexProvider;
  readonly createReviewTriggerReader?: (context: FeatureContext) => ReviewTriggerReader;
}

async function activate(context: FeatureContext, options: GitHubPluginOptions) {
  const transport = new GitHubProvider({
    token: () => context.secrets.get('token'),
    log: { warn: (message, fields) => context.log('warn', message, fields) },
  });
  const provider = options.createProvider?.(context) ?? transport;
  const reviewTriggers = options.createReviewTriggerReader?.(context) ?? new ReviewTriggerReader({
    token: () => context.secrets.get('token'),
  });
  const prIndex = new PrProviderIndex(context.storage, options.createPrIndexProvider?.(context) ?? new GitHubPrIndexProvider({ token: () => context.secrets.get('token') }));
  const drafts = new NativeIssueDraftRuntime(context, options.createIssuePublisher?.(context) ?? transport);
  const community = new CommunityRuntime(context, options.createCommunityProvider?.(context) ?? transport);
  const tracking = new TypedWaitRuntime({
    context, provider,
    ...(options.now ? { now: options.now } : {}),
    coverage: (repoFullName, prNumber, triggerCommentId) => reviewTriggers.observe({ repoFullName, prNumber, triggerCommentId }),
    collect: (target, snapshot) => community.collectTracking(target, snapshot),
    observe: (target, snapshot) => community.observeTracking(target, snapshot),
  });
  await tracking.recover();
  const poll = async (kind: 'pr' | 'issue') => {
    await tracking.poll(kind);
    return { data: { completed: true } };
  };
  return {
    actions: {
      // Pure provider observation; registration consumes it inside this module.
      'github.review-trigger.observe': (value: unknown) => reviewTriggers.observe(value),
      'github.webhook': (value: unknown) => community.webhook(value),
      'github.typed-wait.register-pr': (value: unknown, caller?: PluginActionContext) => tracking.registerPr(value, caller),
      'github.typed-wait.register-issue': (value: unknown, caller?: PluginActionContext) => tracking.registerIssue(value, caller),
      'github.typed-wait.unregister': (value: unknown, caller?: PluginActionContext) => tracking.unregister(value, caller),
      'github.tracking.list': async () => ({ data: { tracking: [
        ...await tracking.store.listByKind('pr_tracking'), ...await tracking.store.listByKind('issue_tracking'),
      ] } }),
      'github.pr-tracking': () => poll('pr'),
      'github.issue-tracking': () => poll('issue'),
      'github.repo-scan': async () => { await community.run('repo-scan'); return { data: { completed: true } }; },
      'github.repo-comment-poll': async () => { await community.run('repo-comment-poll'); return { data: { completed: true } }; },
      'github.community-reconciler': async () => { await community.run('community-reconciler'); return { data: { completed: true } }; },
      'github.repository.register': async (value: unknown) => ({ data: await community.register(repoInput(value, true) as unknown as UpsertRepoConfigInput) }),
      'github.repository.unregister': async (value: unknown) => ({ data: { removed: await community.unregister(repoInput(value, false).repo as string) } }),
      'github.repository.list': async () => ({ data: { repositories: await community.configs.listAll(), pullRequestRepositories: await prIndex.repositories() } }),
      'github.subject.inspect': (value: unknown) => community.inspectSubject(value),
      'github.pull-requests.refresh': async (value: unknown) => ({ data: await prIndex.refresh(value) }),
      'github.repository.observations': async (value: unknown) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('repository input required');
        const { prAfter, ...input } = value as Record<string, unknown>;
        const result = await community.inspectRepository(input);
        return { data: { ...result.data, pullRequests: await prIndex.read(input.repo, prAfter, input.limit) } };
      },
      'github.issue.preview': previewPublicIssue,
      'github.issue.metadata': (value: unknown) => community.inspectIssueMetadata(value),
      'github.legacy-issues.import': (value: unknown) => community.importLegacyIssues(value),
      'github.legacy-history.import': (value: unknown) => community.importLegacyHistory(value),
      'github.legacy-history.inspect': (value: unknown) => community.inspectLegacyHistory(value),
      'github.legacy-repositories.import': (value: unknown) => community.importLegacyRepositoryProgress(value),
      'github.legacy-issue-progress.import': (value: unknown) => tracking.importLegacyIssueProgress(value),
      'github.draft.create': (value: unknown) => drafts.create(value),
      'github.draft.get': (value: unknown) => drafts.get(value),
      'github.draft.list': () => drafts.list(),
      'github.draft.publish': (value: unknown) => drafts.publish(value),
      'github.draft.cancel': (value: unknown) => drafts.cancel(value),
      'github.triage.recommend': recommendTriage,
    },
    dispose: async () => { await Promise.all([tracking.stop(), community.stop(), drafts.stop(), reviewTriggers.stop(), prIndex.stop()]); },
  };
}

function repoInput(value: unknown, register: boolean): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('repository input must be an object');
  const input = value as Record<string, unknown>;
  const allowed = register ? ['repo', 'guardThreadId', 'guardCatId', 'reviewMode', 'cloudReviewPolicy'] : ['repo'];
  if (Object.keys(input).some(key => !allowed.includes(key)) || typeof input.repo !== 'string') throw new TypeError('unsupported repository field');
  if (register && (typeof input.guardThreadId !== 'string' || typeof input.guardCatId !== 'string')) throw new TypeError('repository notification destination is required');
  if (input.reviewMode !== undefined && !['observe_only', 'maintainer_review'].includes(input.reviewMode as string)) throw new TypeError('invalid reviewMode');
  if (input.cloudReviewPolicy !== undefined && !['optional', 'required'].includes(input.cloudReviewPolicy as string)) throw new TypeError('invalid cloudReviewPolicy');
  return input;
}

export function createGitHubPluginModule(options: GitHubPluginOptions = {}): PluginModuleEntrypoint {
  return definePluginModule(manifest => definePlugin({
    manifest, activate: { 'github-collaboration': context => activate(context, options) },
  }));
}

export default createGitHubPluginModule();
