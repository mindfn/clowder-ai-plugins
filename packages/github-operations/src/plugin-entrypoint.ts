import { definePlugin, definePluginModule, type FeatureContext, type PluginModuleEntrypoint } from '@clowder-ai/plugin-sdk';
import { GitHubProvider } from './github-provider.js';
import { GitHubTrackingRuntime, type GitHubTarget, type GitHubTrackingProvider } from './tracking-runtime.js';
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
  /** Test the real carrier with an isolated provider; production uses the migrated gh transport. */
  readonly createProvider?: (context: FeatureContext) => Provider;
  readonly createCommunityProvider?: (context: FeatureContext) => CommunityProvider;
  readonly createIssuePublisher?: (context: FeatureContext) => NativeIssuePublisher;
  readonly createPrIndexProvider?: (context: FeatureContext) => PrIndexProvider;
  readonly createReviewTriggerReader?: (context: FeatureContext) => ReviewTriggerReader;
}

function target(value: unknown, register: boolean): GitHubTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('tracking input must be an object');
  const input = value as Record<string, unknown>;
  const fields = register ? ['kind', 'repoFullName', 'number', 'threadId', 'catId', 'reviewThreadIds', 'cloudReviewRequest'] : ['kind', 'repoFullName', 'number'];
  if (Object.keys(input).some(key => !fields.includes(key))) throw new TypeError('unsupported tracking field');
  // Destinations are routing requests, not caller identity or governance credentials.
  // Host thread access and message grants remain authoritative.
  return input as unknown as GitHubTarget;
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
  const tracking = new GitHubTrackingRuntime({
    storage: context.storage, threads: context.threads, send: context.messaging.send,
    provider, selfLogin: async () => provider.selfLogin(),
    collect: (target, snapshot) => community.collectTracking(target, snapshot),
    observe: (target, snapshot) => community.observeTracking(target, snapshot),
    cloudReviewerLogins: async () => {
      const value = await context.config.get('cloudReviewerLogins');
      if (value === undefined) return ['chatgpt-codex-connector[bot]'];
      if (typeof value !== 'string') throw new TypeError('cloudReviewerLogins must be a string');
      return value.split(/[\s,]+/).filter(Boolean);
    },
    noiseLogins: async () => {
      const value = await context.config.get('setupNoiseBotLogins');
      if (value === undefined || value === '') return [];
      if (typeof value !== 'string') throw new TypeError('setupNoiseBotLogins must be a string');
      return value.split(/[\s,]+/).filter(Boolean);
    },
  });
  const poll = async (channel: 'cicd-check' | 'conflict-check' | 'review-feedback' | 'issue-tracking') => {
    await tracking.poll(channel);
    return { data: { completed: true } };
  };
  return {
    actions: {
      // Declared read-only query. Host governance must select its trusted instance
      // independently; tool discovery does not establish proof authority.
      'github.review-trigger.observe': (value: unknown) => reviewTriggers.observe(value),
      'github.webhook': (value: unknown) => community.webhook(value),
      'github.tracking.register': async (value: unknown) => ({ data: await tracking.register(target(value, true)) }),
      'github.tracking.unregister': async (value: unknown) => ({ data: await tracking.unregister(target(value, false)) }),
      'github.tracking.list': async () => ({ data: { tracking: await tracking.list() } }),
      'github.cicd-check': () => poll('cicd-check'),
      'github.conflict-check': () => poll('conflict-check'),
      'github.review-feedback': () => poll('review-feedback'),
      'github.issue-tracking': () => poll('issue-tracking'),
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
