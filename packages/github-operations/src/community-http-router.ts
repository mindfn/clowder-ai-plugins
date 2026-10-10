import Fastify, { type InjectOptions, type LightMyRequestResponse } from 'fastify';
import type { PluginActionContext, PluginStorageHost } from '@clowder-ai/plugin-sdk';
import { z } from 'zod';
import { CommunityRequestContext } from './business/routes/community-request-context.js';
import { communityIssueRoutes, type CommunityIssuesRoutesOptions } from './business/routes/community-issues.js';
import { communityRepoConfigRoutes } from './business/routes/community-repo-config.js';
import { communityIssueDraftRoutes, type CommunityIssueDraftRoutesOptions } from './business/routes/community-issue-draft-routes.js';
import { SdkCommunityWorkflowIssueStore, SdkCommunityPrStore, SdkCommunityIssueDraftStore } from './business/domains/community/CommunityWorkflowStores.js';
import { SdkCommunityRepoConfigStore } from './business/domains/community/CommunityRepoConfigStore.js';
import { SdkCommunityEventLog } from './business/domains/community/CommunityEventLog.js';
import { SdkCommunityObjectStore } from './business/domains/community/CommunityObjectStore.js';
import { CommunityProjector } from './business/domains/community/community-projector.js';
import { CommunityReconciliationFindingStore } from './business/domains/community/reconciliation/CommunityReconciliationFindingStore.js';

type OwnedStores = 'requestContext' | 'communityIssueStore' | 'communityPrStore' | 'repoConfigStore' | 'eventLog' | 'objectStore' | 'projector' | 'findingStore';
export interface CommunityHttpRouterOptions {
  readonly storage: PluginStorageHost;
  readonly issues: Omit<CommunityIssuesRoutesOptions, OwnedStores>;
  readonly drafts: Omit<CommunityIssueDraftRoutesOptions, 'requestContext' | 'communityIssueDraftStore'>;
}

const forwarded = z.object({
  method: z.enum(['GET', 'POST', 'PATCH', 'DELETE']), path: z.string().min(1),
  query: z.record(z.union([z.string(), z.array(z.string())])).default({}),
  body: z.unknown().optional(),
  principal: z.object({ kind: z.literal('owner'), id: z.string().min(1) }).strict(),
});
const nativeTargets = {
  'github.community.triage-complete': 'triage-complete',
  'github.community.request-guardian': 'request-guardian',
  'github.community.guardian-signoff': 'guardian-signoff',
  'github.community.validate-route': 'validate-route',
  'github.community.report': 'report',
  'github.community.await-external': 'await-external',
} as const;
export type CommunityNativeMethod = keyof typeof nativeTargets;
const nativeInput = z.object({ id: z.string().min(1).max(512), payload: z.record(z.unknown()) }).strict();

function response(value: LightMyRequestResponse) {
  const json = String(value.headers['content-type'] ?? '').includes('application/json');
  return { status: value.statusCode, headers: { 'content-type': json ? 'application/json' : 'text/plain; charset=utf-8' }, body: json && value.body ? value.json() : value.body };
}

/** Embedded package router, never a listening server. Owner dispatch is solely
 * for the Host's non-anonymous webhook forwarding contribution. It MUST NOT be
 * published as a tool/native action: its principal is the Host wrapper, whereas
 * native callers enter through the separately allowlisted method and context.
 * Dynamic Host forwarding and production module registration are independent
 * wiring requirements; constructing this router does not prove either. */
export async function createCommunityHttpRouter(options: CommunityHttpRouterOptions) {
  const app = Fastify();
  const scope = new CommunityRequestContext(app);
  const storage = scope.mutationStorage(options.storage);
  const configs = new SdkCommunityRepoConfigStore(storage);
  const events = new SdkCommunityEventLog(storage);
  const objects = new SdkCommunityObjectStore(storage);
  const issues = new SdkCommunityWorkflowIssueStore(storage);
  const prs = new SdkCommunityPrStore(storage);
  const drafts = new SdkCommunityIssueDraftStore(storage);
  const findings = new CommunityReconciliationFindingStore(storage);
  app.addHook('preHandler', async (_request, reply) => {
    if (!scope.userId()) return reply.code(401).send({ error: 'Host-authenticated Community request required' });
    await scope.assertCurrent();
  });
  await app.register(communityIssueRoutes, {
    ...options.issues, requestContext: scope, communityIssueStore: issues, communityPrStore: prs,
    repoConfigStore: configs, eventLog: events, objectStore: objects,
    projector: new CommunityProjector(events, objects), findingStore: findings,
  });
  await app.register(communityRepoConfigRoutes, { requestContext: scope, repoConfigStore: configs });
  await app.register(communityIssueDraftRoutes, {
    ...options.drafts, requestContext: scope, communityIssueDraftStore: drafts,
    publisher: { publish: async input => { await scope.assertCurrent(); return options.drafts.publisher.publish(input); } },
  });
  await app.ready();
  return {
    async forwardOwner(value: unknown) {
      const request = forwarded.parse(value);
      // Query and path are separate in the Host forwarding contract. Keep raw
      // encoded path segments intact, including an encoded repository slash.
      if (!/^github\/community-[A-Za-z0-9%_.~/-]+$/.test(request.path) || request.path.split('/').some(part => part === '.' || part === '..')) throw new TypeError('Invalid Community path');
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(request.query)) for (const item of typeof value === 'string' ? [value] : value) query.append(key, item);
      const url = '/api/' + request.path.slice('github/'.length) + (query.size ? '?' + query.toString() : '');
      return response(await scope.injectOwner(request.principal, { method: request.method, url, ...(request.body === undefined ? {} : { payload: request.body as InjectOptions['payload'] }) }));
    },
    async invokeNative(method: CommunityNativeMethod, input: unknown, caller: PluginActionContext) {
      if (!Object.hasOwn(nativeTargets, method)) throw new TypeError('Undeclared Community native action');
      const value = nativeInput.parse(input);
      const url = `/api/community-issues/${encodeURIComponent(value.id)}/${nativeTargets[method]}`;
      return response(await scope.injectNative(caller, { method: 'POST', url, payload: value.payload }));
    },
    async stop() { scope.stop(); await app.close(); },
  };
}
