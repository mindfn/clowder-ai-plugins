import { definePlugin, definePluginModule, type FeatureContext, type PluginModuleEntrypoint } from '@clowder-ai/plugin-sdk';
import { GitHubProvider } from './github-provider.js';
import { GitHubTrackingRuntime, type GitHubTarget, type GitHubTrackingProvider } from './tracking-runtime.js';
import { CommunityRuntime, type CommunityProvider } from './community-runtime.js';
import type { UpsertRepoConfigInput } from './business/domains/community/CommunityRepoConfigStore.js';

interface Provider extends GitHubTrackingProvider { selfLogin(): string | undefined }
export interface GitHubPluginOptions {
  /** Test the real carrier with an isolated provider; production uses the migrated gh transport. */
  readonly createProvider?: (context: FeatureContext) => Provider;
  readonly createCommunityProvider?: (context: FeatureContext) => CommunityProvider;
}

function target(value: unknown, register: boolean): GitHubTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('tracking input must be an object');
  const input = value as Record<string, unknown>;
  const fields = register ? ['kind', 'repoFullName', 'number', 'threadId', 'catId', 'reviewThreadIds'] : ['kind', 'repoFullName', 'number'];
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
  const community = new CommunityRuntime(context, options.createCommunityProvider?.(context) ?? transport);
  const tracking = new GitHubTrackingRuntime({
    storage: context.storage, threads: context.threads, send: context.messaging.send,
    provider, selfLogin: async () => provider.selfLogin(),
    collect: (target, snapshot) => community.collectTracking(target, snapshot),
    observe: (target, snapshot) => community.observeTracking(target, snapshot),
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
      'github.repository.list': async () => ({ data: { repositories: await community.configs.listAll() } }),
      'github.subject.inspect': (value: unknown) => community.inspectSubject(value),
    },
    dispose: async () => { await Promise.all([tracking.stop(), community.stop()]); },
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
