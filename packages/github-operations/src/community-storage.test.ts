import assert from 'node:assert/strict';
import test from 'node:test';
import { SdkCommunityEventLog } from './business/domains/community/CommunityEventLog.js';
import { SdkCommunityObjectStore } from './business/domains/community/CommunityObjectStore.js';
import { SdkCommunityRepoConfigStore } from './business/domains/community/CommunityRepoConfigStore.js';
import { CommunityProjector } from './business/domains/community/community-projector.js';
import { CommunityReconciliationFindingStore } from './business/domains/community/reconciliation/CommunityReconciliationFindingStore.js';
import type { CommunityEvent } from './business/model/index.js';
import { memoryStorage } from '../test/memory-storage.js';
import { SdkCommunityIssueStore } from './business/domains/community/CommunityIssueStore.js';
import { SdkCommunityIssueDraftStore } from './business/domains/community/CommunityIssueDraftStore.js';
import { TriageOrchestrator } from './business/domains/community/TriageOrchestrator.js';

const event = (id: string, subjectKey = 'issue:example/project#1'): CommunityEvent => ({
  sourceEventId: id, subjectKey, kind: 'issue.opened', classification: 'state-changing', payload: {}, at: 1,
});

test('SDK event log preserves global dedup, concurrent insertion order and subject-relative cursors', async () => {
  const storage = memoryStorage(); const log = new SdkCommunityEventLog(storage);
  const results = await Promise.all([log.append(event('one')), log.append(event('one', 'pr:example/project#2'))]);
  assert.equal(results.filter(r => r.appended).length, 1);
  await log.append(event('two')); await log.append(event('three'));
  assert.deepEqual((await log.read('issue:example/project#1')).map(e => e.sourceEventId), ['one', 'two', 'three']);
  assert.deepEqual((await new SdkCommunityEventLog(storage).read('issue:example/project#1', 1)).map(e => e.sourceEventId), ['two', 'three']);
  assert.deepEqual(await log.listSubjects(), ['issue:example/project#1']);
});

test('a crash between journal reservation and materialization is recovered without losing or duplicating a fact', async () => {
  const storage = memoryStorage(); const original = storage.compareAndSet;
  let crash = true;
  const log = new SdkCommunityEventLog({ ...storage, async compareAndSet(key, revision, value) {
    if (crash && key.startsWith('community.event.')) { crash = false; throw new Error('simulated storage outage'); }
    return original(key, revision, value);
  } });
  await assert.rejects(log.append(event('one')), /storage outage/);
  const recovered = new SdkCommunityEventLog(storage);
  assert.deepEqual((await recovered.read('issue:example/project#1')).map(e => e.sourceEventId), ['one']);
  assert.equal((await recovered.append(event('one'))).appended, false);
  assert.equal((await recovered.append(event('two'))).sequence, 1);
});

test('existing projector and configuration work with SDK storage and survive runtime recreation', async () => {
  const storage = memoryStorage(); const events = new SdkCommunityEventLog(storage);
  const objects = new SdkCommunityObjectStore(storage);
  const projector = new CommunityProjector(events, objects);
  await events.append(event('one')); await projector.rebuild('issue:example/project#1');
  assert.equal((await objects.get('issue:EXAMPLE/PROJECT#1'))?.state, 'new');
  const config = new SdkCommunityRepoConfigStore(storage);
  await config.upsert({ repo: 'Example/Project', guardThreadId: 'thread-1', guardCatId: 'cat-1', reviewMode: 'maintainer_review' });
  await config.upsert({ repo: 'example/project', guardThreadId: 'thread-2', guardCatId: 'cat-2' });
  assert.equal((await new SdkCommunityRepoConfigStore(storage).getByRepo('EXAMPLE/project'))?.reviewMode, 'maintainer_review');
  await projector.rebuild('issue:example/project#1');
  assert.equal((await events.read('issue:example/project#1')).length, 1);
});

test('finding waivers remain sticky, changed evidence reopens, absent findings resolve without erasing history', async () => {
  const storage = memoryStorage(); const findings = new CommunityReconciliationFindingStore(storage);
  const input = { findingId: 'finding-1', subjectKey: 'issue:example/project#1', findingKind: 'drift', severity: 'warning', message: 'drift', evidenceFingerprint: 'a' };
  await findings.upsert(input);
  await assert.rejects(findings.waive(input.findingId, { reason: '', actor: 'owner', evidence: 'evidence' }), /reason/);
  await findings.waive(input.findingId, { reason: 'accepted', actor: 'owner', evidence: 'evidence' });
  await findings.upsert(input); await findings.resolveAbsent(input.subjectKey, []);
  assert.equal((await findings.get(input.findingId))?.status, 'waived');
  await findings.upsert({ ...input, evidenceFingerprint: 'b' });
  assert.equal((await findings.get(input.findingId))?.status, 'open');
  await findings.resolveAbsent(input.subjectKey, []);
  const restored = new CommunityReconciliationFindingStore(storage);
  assert.equal((await restored.get(input.findingId))?.status, 'resolved');
  assert.equal((await restored.listAll()).length, 1);
  await restored.upsert({ ...input, evidenceFingerprint: 'b' });
  assert.equal((await restored.get(input.findingId))?.status, 'open');
});

test('SDK issue store atomically deduplicates subjects and drives the unchanged triage decision', async () => {
  const storage = memoryStorage(), first = new SdkCommunityIssueStore(storage), second = new SdkCommunityIssueStore(storage);
  const input = { repo: 'example/project', issueNumber: 3, issueType: 'bug' as const, title: 'broken parser' };
  const created = await Promise.all([first.create(input), second.create(input)]);
  assert.equal(created.filter(Boolean).length, 1);
  const issue = created.find(Boolean)!;
  const triage = new TriageOrchestrator({ communityIssueStore: first });
  const result = await triage.recordTriageEntry(issue.id, {
    catId: 'reviewer', verdict: 'WELCOME', timestamp: 1,
    questions: (['Q1', 'Q2', 'Q3', 'Q4', 'Q5'] as const).map(id => ({ id, result: 'PASS' })),
  });
  assert.equal(result.action, 'resolved');
  assert.equal((await second.get(issue.id))?.state, 'accepted');
  assert.equal((await second.listByRepo('example/project')).length, 1);
});

test('SDK drafts deduplicate concurrent creates, retain cancelled history and reject terminal edits across restart', async () => {
  const storage = memoryStorage(), first = new SdkCommunityIssueDraftStore(storage), second = new SdkCommunityIssueDraftStore(storage);
  const input = { sourceType: 'cat_initiated' as const, sourceId: 'source-1', title: 'Title', bodyMarkdown: 'Body',
    targetRepo: 'example/project', labels: ['bug'], threadId: 'thread-1', userId: 'owner' };
  const created = await Promise.allSettled([first.create(input), second.create(input)]);
  assert.equal(created.filter(r => r.status === 'fulfilled').length, 1);
  const draft = (await first.getBySourceId(input.sourceId))!;
  await second.cancel(draft.draftId);
  assert.equal((await first.getById(draft.draftId))?.status, 'cancelled');
  assert.equal(await first.getBySourceId(input.sourceId), null);
  const replacement = await first.create(input);
  await second.publish({ draftId: replacement.draftId, githubIssueNumber: 5, githubIssueUrl: 'https://github.com/example/project/issues/5' });
  await assert.rejects(first.cancel(replacement.draftId), /not draft/);
  await assert.rejects(first.updateContent(draft.draftId, 'changed', 'changed'), /not draft/);
  assert.equal((await new SdkCommunityIssueDraftStore(storage).getById(replacement.draftId))?.status, 'published');
  assert.equal((await first.getById(draft.draftId))?.title, 'Title');
});
