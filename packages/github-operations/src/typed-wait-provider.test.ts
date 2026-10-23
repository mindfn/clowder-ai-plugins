import assert from 'node:assert/strict';
import test from 'node:test';
import type { GitHubSnapshot } from './tracking-runtime.js';
import type { GitHubPrWaitBaseline, GitHubPrWaitPredicate, TaskItem, PrAutomationState } from './business/model/index.js';
import { prBaseline, waitObservation, waitEventSnapshot } from './typed-wait-provider.js';
import { matchGitHubWaitPredicates } from './business/domains/github-signals/GitHubWaitPredicateCatalog.js';
import { renewPrWaitBaseline } from './business/domains/github-signals/GitHubWaitRenewalBaseline.js';

const head = 'a'.repeat(40), oldHead = 'b'.repeat(40);
const blank: GitHubSnapshot = { state: 'open', headSha: head, ci: 'pending', comments: [], reviews: [], commentsComplete: true };
async function task(snapshot: GitHubSnapshot, when: readonly GitHubPrWaitPredicate[]): Promise<TaskItem> {
  const first = await prBaseline(snapshot, 'owner/repo', 1, when, () => 1000);
  return { id: 'task', kind: 'pr_tracking', subjectKey: 'pr:owner/repo#1', threadId: 'thread', ownerCatId: 'cat',
    status: 'doing', title: 'PR', why: '', createdBy: 'system', createdAt: 1000, updatedAt: 1000,
    automationState: { ...first.collectorState, await: { v: 1, generation: 1,
      subjectRef: 'pr:owner/repo#1', ownerFence: { kind: 'containing_task', generation: 1 },
      baseline: first.baseline, continuation: { when, then: 'Continue' }, createdAt: 1000, provenance: 'explicit_registration' } } };
}

test('complete registration baselines suppress historical journal events even with a CI-only wait', async () => {
  const first = { ...blank, comments: [{ id: 4, author: 'reviewer', body: 'history', commentType: 'inline' as const, commitId: head }],
    reviews: [{ id: 3, author: 'reviewer', state: 'APPROVED', commitId: head }] };
  const registered = await task(first, [{ kind: 'pr_ci_terminal' }]);
  const events = waitEventSnapshot(registered, { ...first, comments: [...first.comments,
    { id: 5, author: 'reviewer', body: 'late old commit', commentType: 'inline', commitId: oldHead },
    { id: 6, author: 'reviewer', body: 'new', commentType: 'inline', commitId: head }],
    reviews: [{ ...first.reviews[0]!, state: 'DISMISSED' }] });
  assert.deepEqual(events.comments.map(row => row.id), [6]);
  assert.deepEqual(events.reviews.map(row => row.state), ['DISMISSED']);
  await assert.rejects(prBaseline({ ...first, commentsComplete: false }, 'owner/repo', 1, [], () => 1000), /Complete/);
});

test('late review of an old HEAD is not a current review result or decision', async () => {
  const when: GitHubPrWaitPredicate[] = [{ kind: 'pr_review_result_available' }, { kind: 'pr_review_decision_changed' }];
  const registered = await task(blank, when);
  const observe = (commitId: string) => waitObservation(registered, { ...blank,
    reviews: [{ id: 7, author: 'reviewer', state: 'APPROVED', commitId }] }, 2000, []);
  assert.deepEqual(matchGitHubWaitPredicates(when, registered.automationState!.await!.baseline, observe(oldHead).observation.facts), []);
  assert.equal(matchGitHubWaitPredicates(when, registered.automationState!.await!.baseline, observe(head).observation.facts).length, 2);
});

test('COMMENTED reviews advance collection without replacing or emitting a formal decision', async () => {
  const when: GitHubPrWaitPredicate[] = [{ kind: 'pr_review_decision_changed' }];
  const changes = { id: 3, author: 'maintainer', state: 'CHANGES_REQUESTED', commitId: head };
  const replied = { id: 4, author: 'author', state: 'COMMENTED', commitId: head };
  const registered = await task({ ...blank, reviews: [changes, replied] }, when);
  const baseline = registered.automationState!.await!.baseline;
  assert.ok('headSha' in baseline);
  assert.equal(baseline.review?.decisionCursor, 4);
  assert.equal(baseline.review?.decision, 'CHANGES_REQUESTED');

  const beforeReply = await task({ ...blank, reviews: [changes] }, when);
  const observed = waitObservation(beforeReply, { ...blank, reviews: [changes, replied] }, 2000, []);
  assert.deepEqual(observed.observation.facts.review?.decisions?.map(row => row.id), [3]);
  assert.deepEqual(matchGitHubWaitPredicates(when, beforeReply.automationState!.await!.baseline,
    observed.observation.facts), []);
  assert.equal((observed.observation.collectorPatch as PrAutomationState).review?.lastDecisionCursor, 4);

  const renewed = renewPrWaitBaseline(beforeReply.automationState!.await!.baseline as GitHubPrWaitBaseline,
    observed.observation.collectorPatch as PrAutomationState, observed.observation.facts, 3000);
  assert.equal(renewed.review?.decisionCursor, 4);
  assert.equal(renewed.review?.decision, 'CHANGES_REQUESTED');
});

test('a COMMENTED reply and approval in one observation emit only the formal decision', async () => {
  const when: GitHubPrWaitPredicate[] = [{ kind: 'pr_review_decision_changed' }];
  const changes = { id: 3, author: 'maintainer', state: 'CHANGES_REQUESTED', commitId: head };
  const replied = { id: 4, author: 'author', state: 'COMMENTED', commitId: head };
  const approval = { id: 5, author: 'maintainer', state: 'APPROVED', commitId: head };
  const registered = await task({ ...blank, reviews: [changes] }, when);
  const baseline = registered.automationState!.await!.baseline as GitHubPrWaitBaseline;
  const observed = waitObservation(registered, { ...blank, reviews: [changes, replied, approval] }, 4000, []);

  assert.deepEqual(matchGitHubWaitPredicates(when, baseline, observed.observation.facts)
    .map(match => match.sourceRef), ['review:5']);
  const renewed = renewPrWaitBaseline(baseline, observed.observation.collectorPatch as PrAutomationState,
    observed.observation.facts, 5000);
  assert.equal(renewed.review?.decisionCursor, 5);
  assert.equal(renewed.review?.decision, 'APPROVED');
  assert.deepEqual(matchGitHubWaitPredicates(when, renewed, observed.observation.facts), [],
    'the consumed approval is not replayed after renewal');
});

test('a persisted legacy COMMENTED decision baseline converges on the next formal approval', async () => {
  const when: GitHubPrWaitPredicate[] = [{ kind: 'pr_review_decision_changed' }];
  const changes = { id: 3, author: 'maintainer', state: 'CHANGES_REQUESTED', commitId: head };
  const replied = { id: 4, author: 'author', state: 'COMMENTED', commitId: head };
  const approval = { id: 5, author: 'maintainer', state: 'APPROVED', commitId: head };
  const registered = await task({ ...blank, reviews: [changes] }, when);
  const automation = registered.automationState as PrAutomationState;
  const cleanBaseline = automation.await!.baseline as GitHubPrWaitBaseline;
  const legacyBaseline: GitHubPrWaitBaseline = { ...cleanBaseline, review: {
    ...cleanBaseline.review!, decisionCursor: 4, decision: 'COMMENTED',
  } };
  const legacy = { ...registered, automationState: { ...automation,
    review: { ...automation.review, lastDecisionCursor: 4,
      observedReviews: { ...automation.review?.observedReviews, '4': 'COMMENTED' } },
    await: { ...automation.await!, baseline: legacyBaseline },
  } } as TaskItem;
  const observed = waitObservation(legacy, { ...blank, reviews: [changes, replied, approval] }, 6000, []);

  assert.deepEqual(matchGitHubWaitPredicates(when, legacyBaseline, observed.observation.facts)
    .map(match => match.sourceRef), ['review:5']);
  const renewed = renewPrWaitBaseline(legacyBaseline, observed.observation.collectorPatch as PrAutomationState,
    observed.observation.facts, 7000);
  assert.equal(renewed.review?.decisionCursor, 5);
  assert.equal(renewed.review?.decision, 'APPROVED');
  assert.deepEqual(matchGitHubWaitPredicates(when, renewed, observed.observation.facts), [],
    'the legacy polluted baseline converges without replaying the approval');
});

test('a same-id pending submission participates in the fourth-review loop brake', async () => {
  const prior = Array.from({ length: 3 }, (_, index) => ({
    id: index + 1,
    author: 'maintainer',
    state: 'CHANGES_REQUESTED',
    commitId: head,
  }));
  const pending = { id: 4, author: 'maintainer', state: 'PENDING', commitId: head };
  const registered = await task({ ...blank, authorLogin: 'owner', reviews: [...prior, pending] }, [
    { kind: 'pr_review_decision_changed' },
  ]);
  const observed = waitObservation(registered, {
    ...blank,
    authorLogin: 'owner',
    reviews: [...prior, { ...pending, state: 'CHANGES_REQUESTED' }],
  }, 7500, []);

  assert.equal(observed.observation.reviewLoopBrake?.kind, 'pause_once');
});

test('a newly observed review dismissed between polls remains reportable', async () => {
  const when: GitHubPrWaitPredicate[] = [{ kind: 'pr_review_decision_changed' }];
  const registered = await task(blank, when);
  const dismissed = { id: 3, author: 'maintainer', state: 'DISMISSED', commitId: head };
  const observed = waitObservation(registered, { ...blank, reviews: [dismissed] }, 8000, []);

  assert.deepEqual(matchGitHubWaitPredicates(when, registered.automationState!.await!.baseline,
    observed.observation.facts).map(match => match.sourceRef), ['review:3']);
  assert.equal((observed.observation.collectorPatch as PrAutomationState).review?.lastDecisionCursor, 3);
  const renewed = renewPrWaitBaseline(registered.automationState!.await!.baseline as GitHubPrWaitBaseline,
    observed.observation.collectorPatch as PrAutomationState, observed.observation.facts, 8500);
  assert.equal(renewed.review?.decision, undefined);
  assert.deepEqual(matchGitHubWaitPredicates(when, renewed, observed.observation.facts), [],
    'the newly dismissed review is delivered once and not replayed after renewal');
});

test('renewal clears a formal decision after its review is dismissed', async () => {
  const when: GitHubPrWaitPredicate[] = [{ kind: 'pr_review_decision_changed' }];
  const approval = { id: 3, author: 'maintainer', state: 'APPROVED', commitId: head };
  const registered = await task({ ...blank, reviews: [approval] }, when);
  const baseline = registered.automationState!.await!.baseline as GitHubPrWaitBaseline;
  const observed = waitObservation(registered, { ...blank,
    reviews: [{ ...approval, state: 'DISMISSED' }] }, 9000, []);

  assert.equal(matchGitHubWaitPredicates(when, baseline, observed.observation.facts)[0]?.delta,
    'review APPROVED → DISMISSED (maintainer)');
  const renewed = renewPrWaitBaseline(baseline, observed.observation.collectorPatch as PrAutomationState,
    observed.observation.facts, 10000);
  assert.equal(renewed.review?.decision, undefined);

  const automation = registered.automationState as PrAutomationState;
  const renewedTask = { ...registered, automationState: { ...automation,
    ...observed.observation.collectorPatch as PrAutomationState,
    await: { ...automation.await!, baseline: renewed } } } as TaskItem;
  const next = waitObservation(renewedTask,
  { ...blank, reviews: [{ ...approval, state: 'DISMISSED' },
    { id: 4, author: 'maintainer', state: 'APPROVED', commitId: head }] }, 11000, []);
  assert.equal(matchGitHubWaitPredicates(when, renewed, next.observation.facts)[0]?.delta,
    'review pending → APPROVED (maintainer)');
});

test('explicit result uses the real trigger timestamp and complete provider evidence, never a supplied verdict', async () => {
  const trigger = { id: 5, author: 'owner', body: '@codex review', commentType: 'conversation' as const,
    createdAt: '2026-10-09T00:00:00Z' };
  const first = { ...blank, comments: [trigger] };
  const registered = await task(first, [{ kind: 'pr_review_result_available', triggerCommentId: 5 }]);
  const snapshot = { ...first, reviews: [{ id: 9, author: 'cloud[bot]', state: 'COMMENTED', commitId: head,
    submittedAt: '2026-10-09T00:00:01Z' }], cloudObservation: { headSha: head, status: 'clean' as const } };
  const read = (snapshot: GitHubSnapshot) => waitObservation(registered, snapshot, Date.parse('2026-10-09T00:00:02Z'), ['cloud[bot]']);
  const observed = read(snapshot);
  assert.equal(observed.observation.facts.review?.resultSourceRef, 'review:9');
  assert.equal(observed.snapshot.cloudObservation?.status, 'clean');
  assert.equal(read({ ...snapshot, comments: [] }).snapshot.cloudObservation, undefined);
  assert.throws(() => read({ ...snapshot, commentsComplete: false }), /Complete/);
  assert.equal(read({ ...snapshot, reviews: [{ ...snapshot.reviews[0]!, submittedAt: '2026-10-08T23:59:59Z' }] })
    .observation.facts.review?.resultSourceRef, undefined);
  // Once observed, even a comment-only review must remain accounted for.
  const advanced = { ...registered, automationState: { ...registered.automationState,
    ...observed.observation.collectorPatch } } as TaskItem;
  const regressed = waitObservation(advanced, { ...snapshot, reviews: [] }, Date.now(), ['cloud[bot]']);
  assert.equal(regressed.snapshot.cloudObservation, undefined);
});

test('dismissal stays final across regressed provider snapshots and does not produce another journal entry', async () => {
  const first = { ...blank, reviews: [{ id: 3, author: 'reviewer', state: 'DISMISSED', commitId: head }] };
  const registered = await task(first, [{ kind: 'pr_review_decision_changed' }]);
  const observed = waitObservation(registered, { ...first, reviews: [{ ...first.reviews[0]!, state: 'APPROVED' }] }, 2000, []);
  assert.equal(observed.snapshot.reviews[0]?.state, 'DISMISSED');
  assert.deepEqual(waitEventSnapshot(registered, observed.snapshot).reviews, []);
  assert.equal((observed.observation.collectorPatch as PrAutomationState).review?.observedReviews?.['3'], 'DISMISSED');
});
