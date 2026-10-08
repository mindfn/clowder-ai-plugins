import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { parse } from 'yaml';
import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import { createGitHubPluginModule } from './plugin-entrypoint.js';
import type { GitHubSnapshot } from './tracking-runtime.js';
import type { RepoSubject } from './community-runtime.js';
import { SdkCommunityEventLog } from './business/domains/community/CommunityEventLog.js';
import { SdkCommunityObjectStore } from './business/domains/community/CommunityObjectStore.js';

const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8'));
const target = { kind: 'pr', repoFullName: 'example/project', number: 12, threadId: 'thread-1', catId: 'cat-1' };

test('real builtin projects provider HEAD and CI without accepting or writing a governance verdict', async () => {
  const f = host();
  let snapshot: GitHubSnapshot = { state: 'open', headSha: 'a'.repeat(40), ci: 'pending', comments: [], reviews: [] };
  const active = await createGitHubPluginModule({ createProvider: () => ({
    read: async () => structuredClone(snapshot), selfLogin: () => 'owner',
  }) }).create(manifest).start(f.runtimeHost);
  await active.actions['github.repository.register']!({ repo: target.repoFullName, guardThreadId: target.threadId,
    guardCatId: target.catId, reviewMode: 'maintainer_review', cloudReviewPolicy: 'optional' });
  await active.actions['github.tracking.register']!(target);
  await active.actions['github.cicd-check']!({});
  const objects = new SdkCommunityObjectStore(f.runtimeHost.storage);
  assert.equal((await objects.get('pr:example/project#12'))?.externalReview?.ci?.status, 'pending');
  snapshot = { ...snapshot, ci: 'pass' };
  await active.actions['github.cicd-check']!({});
  await active.actions['github.cicd-check']!({});
  const aggregate = (await objects.get('pr:example/project#12'))!.externalReview!;
  assert.equal(aggregate.currentHeadSha, snapshot.headSha);
  assert.equal(aggregate.ci?.status, 'pass');
  assert.equal(aggregate.pendingVerdict, null);
  const events = await new SdkCommunityEventLog(f.runtimeHost.storage).read('pr:example/project#12');
  assert.equal(events.filter(event => event.kind === 'case.ci_observed').length, 2);
  assert.equal(events.some(event => event.kind === 'case.review_verdict_recorded' || event.kind === 'case.review_verdict_submitted'), false);
  assert.equal(Object.keys(active.actions).some(method => /verdict|lease|admission/.test(method)), false);
  assert.equal(f.deliveries.length, 1, 'ordinary CI notification uses existing SDK messaging exactly once');
  snapshot = { ...snapshot, ci: 'pending' };
  await active.actions['github.cicd-check']!({});
  assert.equal((await objects.get('pr:example/project#12'))?.externalReview?.ci?.status, 'pending', 'same-HEAD rerun must invalidate old pass');
  snapshot = { ...snapshot, ci: 'pass' };
  await active.actions['github.cicd-check']!({});
  assert.equal((await objects.get('pr:example/project#12'))?.externalReview?.ci?.status, 'pass');
  assert.equal((await new SdkCommunityEventLog(f.runtimeHost.storage).read('pr:example/project#12')).filter(event => event.kind === 'case.ci_observed').length, 4);
  assert.equal(f.deliveries.length, 3);
  assert.equal(new Set(f.deliveries.map(value => (value as { idempotencyKey: string }).idempotencyKey)).size, 3,
    'a later real pass transition must not reuse the previous pass notification id');
  const inspection = manifest.contributions.find((value: { id: string }) => value.id === 'inspect-subject');
  assert.ok(inspection, 'observations must be readable through a real generic tool contribution');
  const inspect = active.actions[inspection.action.method]!;
  const page = await inspect({ subjectKey: 'pr:example/project#12', limit: 2 }) as {
    data: { projection: { externalReview: { currentHeadSha: string } }; events: unknown[]; nextSequence: number | null };
  };
  assert.equal(page.data.projection.externalReview.currentHeadSha, snapshot.headSha);
  assert.equal(page.data.events.length, 2);
  assert.equal(page.data.nextSequence, 2);
  await assert.rejects(async () => inspect({ subjectKey: 'pr:example/project#12', principal: { catId: 'spoof' } }), /unsupported/);
  await active.stop();
});

test('the actual carrier preserves both a review and its later dismissal in the private journal', async () => {
  const f = host();
  let snapshot: GitHubSnapshot = { state: 'open', headSha: 'a'.repeat(40), ci: 'pending', comments: [], reviews: [] };
  const module = createGitHubPluginModule({ createProvider: () => ({ read: async () => structuredClone(snapshot), selfLogin: () => 'owner' }) });
  const active = await module.create(manifest).start(f.runtimeHost);
  await active.actions['github.tracking.register']!(target);
  const review = { id: 8, author: 'reviewer', state: 'APPROVED', commitId: 'a'.repeat(40) };
  snapshot = { ...snapshot, reviews: [review] };
  await active.actions['github.review-feedback']!({});
  snapshot = { ...snapshot, headSha: 'b'.repeat(40), reviews: [{ ...review, state: 'DISMISSED' }] };
  await active.actions['github.review-feedback']!({});
  await active.actions['github.review-feedback']!({});
  const events = await new SdkCommunityEventLog(f.runtimeHost.storage).read('pr:example/project#12');
  assert.deepEqual(events.map(event => event.payload.reviewState), ['APPROVED', 'DISMISSED']);
  assert.equal(f.deliveries.length, 2);
  await active.stop();
});

function host() {
  const entries = new Map<string, { revision: number; value: unknown }>();
  let revision = 0;
  const deliveries: unknown[] = [];
  const storage: ModulePluginHostShape['storage'] = {
    get: async key => structuredClone(entries.get(key)),
    list: async () => structuredClone(Object.fromEntries(entries)),
    set: async (key, value) => {
      entries.set(key, { revision: ++revision, value: structuredClone(value) }); return { revision };
    },
    compareAndSet: async (key, expected, value) => {
      if ((entries.get(key)?.revision ?? null) !== expected) return { applied: false };
      entries.set(key, { revision: ++revision, value: structuredClone(value) }); return { applied: true, revision };
    },
    delete: async key => ({ deleted: entries.delete(key) }),
  };
  const runtimeHost: ModulePluginHostShape = {
    storage, config: { get: async () => undefined }, secrets: { get: async () => undefined },
    tasks: {} as ModulePluginHostShape['tasks'],
    media: { read: async () => { throw new Error('Unexpected media read'); } },
    threads: {
      get: async id => ({ id, title: null, createdAt: 1, lastActiveAt: 1 }),
      bind: async (key, threadId) => ({ key, threadId, createdAt: 1 }),
    } as ModulePluginHostShape['threads'],
    messaging: {
      send: async input => { deliveries.push(input); return { messageId: `message-${deliveries.length}`, threadId: input.threadId }; },
    } as ModulePluginHostShape['messaging'],
    log: () => undefined,
  };
  return { runtimeHost, deliveries };
}

test('real manifest → SDK builtin activation → tracking → schedule → message → terminal → stop', async () => {
  const f = host();
  let snapshot: GitHubSnapshot = { state: 'open', headSha: 'a'.repeat(40), ci: 'pending', comments: [], reviews: [] };
  let reads = 0;
  const module = createGitHubPluginModule({ createProvider: () => ({
    read: async () => { reads++; return structuredClone(snapshot); }, selfLogin: () => 'owner',
  }) });
  const active = await module.create(manifest).start(f.runtimeHost);
  await active.actions['github.review-feedback']!({});
  assert.equal(reads, 0);
  const tool = manifest.contributions.find((c: { id: string }) => c.id === 'register-tracking');
  const registered = await active.actions[tool.action.method]!(target);
  assert.equal((registered as { data: { active: boolean } }).data.active, true);
  snapshot = { ...snapshot, comments: [{ id: 1, author: 'maintainer', body: 'fix parser', commentType: 'conversation' }] };
  await active.actions['github.review-feedback']!({});
  assert.equal(f.deliveries.length, 1);
  snapshot = { ...snapshot, state: 'merged' };
  await active.actions['github.cicd-check']!({});
  assert.equal(f.deliveries.length, 2);
  const before = reads;
  await active.actions['github.review-feedback']!({});
  assert.equal(reads, before);
  await active.stop();
  await assert.rejects(async () => active.actions['github.tracking.register']!(target), /stopped|disposed|revoked/i);
});

test('builtin stop awaits in-flight provider cleanup and prevents a late notification', async () => {
  const f = host();
  let reads = 0;
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  let release!: () => void;
  const closed = new Promise<void>(resolve => { release = resolve; });
  let aborted = false;
  const module = createGitHubPluginModule({ createProvider: () => ({
    async read(_target, signal) {
      if (++reads > 1) {
        signal.addEventListener('abort', () => { aborted = true; }, { once: true });
        began(); await closed; signal.throwIfAborted();
      }
      return { state: 'open', ci: 'pending', comments: [], reviews: [] };
    }, selfLogin: () => 'owner',
  }) });
  const active = await module.create(manifest).start(f.runtimeHost);
  await active.actions['github.tracking.register']!(target);
  const poll = active.actions['github.review-feedback']!({});
  const rejected = assert.rejects(async () => poll, /stopped/);
  await started;
  let stopped = false;
  const stop = Promise.resolve(active.stop()).then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(aborted, true);
  assert.equal(stopped, false);
  release(); await stop; await rejected;
  assert.equal(f.deliveries.length, 0);
});

test('all seven declared schedules stay idle without registrations; repository inbox baselines then collects and stops', async () => {
  const f = host(); let requests = 0;
  let items: RepoSubject[] = [{ kind: 'issue', number: 1, title: 'Historical', url: 'https://github.com/example/project/issues/1', author: 'contributor', authorAssociation: 'CONTRIBUTOR', draft: false }];
  const module = createGitHubPluginModule({ createCommunityProvider: () => ({
    listOpen: async () => { requests++; return structuredClone(items); },
    repoComments: async () => { requests++; return []; },
    state: async () => { requests++; return { state: 'open', closedAt: null, mergedAt: null }; },
    selfLogin: () => 'owner',
  }) });
  const active = await module.create(manifest).start(f.runtimeHost);
  const schedules = manifest.contributions.filter((c: { type: string }) => c.type === 'schedule');
  assert.equal(schedules.length, 7);
  for (const schedule of schedules) await active.actions[schedule.action.method]!({});
  assert.equal(requests, 0);
  await active.actions['github.repository.register']!({ repo: 'example/project', guardThreadId: 'thread-1', guardCatId: 'cat-1' });
  await active.actions['github.repo-scan']!({});
  assert.equal(f.deliveries.length, 0);
  items = [...items, { ...items[0]!, number: 2, title: 'New', url: 'https://github.com/example/project/issues/2' }];
  await active.actions['github.repo-scan']!({});
  assert.equal(f.deliveries.length, 1);
  await active.actions['github.repo-scan']!({});
  assert.equal(f.deliveries.length, 1);
  await active.actions['github.repo-comment-poll']!({});
  await active.actions['github.community-reconciler']!({});
  await active.actions['github.repository.unregister']!({ repo: 'example/project' });
  const before = requests;
  for (const schedule of schedules) await active.actions[schedule.action.method]!({});
  assert.equal(requests, before);
  assert.ok(Object.keys(await f.runtimeHost.storage.list()).some(key => key.startsWith('community.event.')));
  await active.stop();
});

test('repository scan keeps the five-item budget and continues past a failing repository', async () => {
  const f = host(); let fail = false; let current: RepoSubject[] = [];
  const visited: string[] = [];
  const module = createGitHubPluginModule({ createCommunityProvider: () => ({
    listOpen: async repo => {
      visited.push(repo);
      if (fail && repo === 'example/broken') throw new Error('provider unavailable');
      return structuredClone(current);
    },
    repoComments: async () => [], state: async () => null, selfLogin: () => 'owner',
  }) });
  const active = await module.create(manifest).start(f.runtimeHost);
  for (const repo of ['example/broken', 'example/healthy']) {
    await active.actions['github.repository.register']!({ repo, guardThreadId: 'thread-1', guardCatId: 'cat-1' });
  }
  await active.actions['github.repo-scan']!({});
  current = Array.from({ length: 12 }, (_, index) => ({
    kind: 'issue', number: index + 1, title: 'New', url: `https://github.com/example/healthy/issues/${index + 1}`,
    author: 'contributor', authorAssociation: 'CONTRIBUTOR', draft: false,
  }));
  fail = true;
  await active.actions['github.repo-scan']!({});
  assert.equal(f.deliveries.length, 5);
  await active.actions['github.repo-scan']!({});
  assert.equal(f.deliveries.length, 10);
  await active.actions['github.repo-scan']!({});
  assert.equal(f.deliveries.length, 12);
  assert.equal(visited.filter(repo => repo === 'example/healthy').length, 4);
  await active.stop();
});

test('declared webhook authenticates exact bytes, delivers via SDK, deduplicates, and follows registration lifecycle', async () => {
  const f = host();
  f.runtimeHost.secrets.get = async key => key === 'webhookSecret' ? 'isolated-test-secret' : undefined;
  const active = await createGitHubPluginModule().create(manifest).start(f.runtimeHost);
  const declaration = manifest.contributions.find((c: { type: string }) => c.type === 'webhook');
  assert.ok(declaration, 'real package declares its webhook');
  assert.equal(declaration.verificationSecretRef, 'webhookSecret');
  const body = { action: 'opened', repository: { full_name: 'example/project' },
    issue: { number: 5, title: 'new issue', html_url: 'https://github.com/example/project/issues/5', user: { login: 'contributor' }, author_association: 'CONTRIBUTOR' }, sender: { id: 42 },
  };
  const rawBody = Buffer.from(JSON.stringify(body));
  const headers = { 'x-github-event': 'issues', 'x-github-delivery': 'isolated-delivery-1',
    'x-hub-signature-256': `sha256=${createHmac('sha256', 'isolated-test-secret').update(rawBody).digest('hex')}` };
  const handle = async (input: unknown) => await active.actions[declaration.action.method]!(input) as { status: number };
  await active.actions['github.repository.register']!({ repo: 'example/project', guardThreadId: 'thread-1', guardCatId: 'cat-1' });
  assert.equal((await handle({ method: 'POST', rawBody, body, headers: { ...headers, 'x-hub-signature-256': 'sha256=bad' } })).status, 403);
  assert.equal(f.deliveries.length, 0);
  assert.equal((await handle({ method: 'POST', rawBody, body, headers })).status, 200);
  assert.equal(f.deliveries.length, 1);
  assert.equal((await handle({ method: 'POST', rawBody, body, headers })).status, 200);
  assert.equal(f.deliveries.length, 1);
  assert.ok(Object.keys(await f.runtimeHost.storage.list()).some(key => key.startsWith('community.event.')));
  await active.actions['github.repository.unregister']!({ repo: 'example/project' });
  assert.equal((await handle({ method: 'POST', rawBody, body, headers: { ...headers, 'x-github-delivery': 'isolated-delivery-2' } })).status, 200);
  assert.equal(f.deliveries.length, 1);
  await active.stop();
  await assert.rejects(async () => handle({ method: 'POST', rawBody, body, headers }), /stopped|disposed|revoked/);
});

test('tracking logs facts before delivery, rejects stale inline feedback, and retries a terminal collection failure', async () => {
  const f = host();
  let snapshot: GitHubSnapshot = { state: 'open', headSha: 'b'.repeat(40), comments: [], reviews: [] };
  const active = await createGitHubPluginModule({ createProvider: () => ({
    read: async () => structuredClone(snapshot), selfLogin: () => 'owner',
  }) }).create(manifest).start(f.runtimeHost);
  await active.actions['github.tracking.register']!(target);
  snapshot = { ...snapshot, comments: [{ id: 1, author: 'maintainer', body: 'old commit',
    commentType: 'inline', commitId: 'a'.repeat(40) }] };
  await active.actions['github.review-feedback']!({});
  assert.equal(f.deliveries.length, 0, 'old-HEAD inline feedback is not an owner notification');
  const original = f.runtimeHost.storage.compareAndSet;
  let crash = true;
  f.runtimeHost.storage.compareAndSet = async (key, revision, value) => {
    if (crash && key.startsWith('community.event.')) { crash = false; throw new Error('event disk unavailable'); }
    return original(key, revision, value);
  };
  snapshot = { ...snapshot, state: 'merged', comments: [{ id: 2, author: 'maintainer', body: 'final',
    commentType: 'conversation' }] };
  await assert.rejects(async () => active.actions['github.cicd-check']!({}), /event disk/);
  assert.equal(f.deliveries.length, 0);
  const pending = await active.actions['github.tracking.list']!({}) as { data: { tracking: { active: boolean }[] } };
  assert.equal(pending.data.tracking[0]!.active, true);
  await active.actions['github.cicd-check']!({});
  assert.equal(f.deliveries.length, 1);
  const eventValues = Object.entries(await f.runtimeHost.storage.list()).filter(([key]) => key.startsWith('community.event.'));
  assert.equal(eventValues.length, 2, 'fresh comment and terminal lifecycle are durable, stale inline is absent');
  await active.stop();
});
