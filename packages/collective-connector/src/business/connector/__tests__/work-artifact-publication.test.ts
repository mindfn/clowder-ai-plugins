import { expect, test } from 'vitest';
import type { FeatureContext, PluginMessage, PluginStorageEntry } from '@clowder-ai/plugin-sdk';

async function fixture() {
  // Existing neutral storage/message/thread ports; authority is supplied by the
  // current production Work binding, not inferred from these store fixtures.
  const path = new URL(process.env.WORK_ARTIFACT_PUBLICATION_COMPILED === '1'
    ? '../../../../dist/collective-work-artifacts.js' : '../../../collective-work-artifacts.js', import.meta.url).href;
  let module: typeof import('../../../collective-work-artifacts.js') | undefined;
  try { module = await import(path); } catch {}
  expect(module?.createCollectiveWorkArtifacts, 'private Work publication must be a real package consumer').toBeTypeOf('function');
  const records = new Map<string, PluginStorageEntry>();
  const messages = new Map<string, PluginMessage>();
  let revision = 0, sends = 0, current = true, loseSend = false, loseCasAt = 0;
  const binding = {auth: {userId: 'owner', catId: 'cat', threadId: 'private', invocationId: 'native-turn',
    originTriggerMessageId: 'trigger', source: {extra: {pluginMessage: {instanceId: 'instance'}}},
    task: {taskRef: 'task:work:task', taskRevision: 1, admissionRef: 'message:admission', executionRef: 'message:execution'}},
    source: {serviceInstanceId: 'svc_aaaaaaaa', collectiveId: 'col_aaaaaaaa', connectionId: 'con_aaaaaaaa', eventId: 'evt_aaaaaaaa',
      catId: 'cat', participationRevision: 1, location: {channelId: 'general'}, actor: {kind: 'human', humanId: 'human_aaaaaaaa', displayName: 'Owner'}},
    sourceRef: 'message:source', refScope: 'exact-business-scope',
    work: {workId: 'work_aaaaaaaa', revision: 1, resultRevision: 1, executionRevision: 1, assignmentEventId: 'evt_assignment'},
    async revalidate() {if (!current) throw new Error('Execution revoked');}} as unknown as import('../../../collective-work-artifacts.js').CollectiveWorkArtifactBinding;
  const context = {storage: {async get(key: string) {return structuredClone(records.get(key));},
    async compareAndSet(key: string, expected: number | null, value: unknown) {
      const old = records.get(key); if ((old?.revision ?? null) !== expected) return {applied: false};
      const row = {revision: ++revision, value: structuredClone(value)};records.set(key, row);if (revision === loseCasAt) throw new Error('CAS response lost after apply');return {applied: true, revision};}},
    threads: {async get() {return {id: 'private', deepLinkUrl: '/owned-thread/private'};}},
    messaging: {async get(id: string) {return structuredClone(messages.get(id) ?? null);},
      async send(threadId: string, draft: Parameters<FeatureContext['messaging']['send']>[1]) {
        sends++;if (!messages.has('published')) messages.set('published', {id: 'published', threadId, userId: 'owner', catId: null,
          content: (draft.payload.elements[0]!.payload as {text: string}).text, mentions: [], timestamp: 1,
          sourceRevision: 'immutable-host-message-revision', contentBlocks: draft.contentBlocks,
          source: {connector: 'collective', label: 'Collective', icon: 'c', meta: draft.meta}});
        if (loseSend) {loseSend = false;throw new Error('Settled response lost');}
        return {messageId: 'published', threadId};}}} as never;
  return {artifacts: module!.createCollectiveWorkArtifacts(context), binding, records, messages,
    get sends() {return sends;}, expire() {current = false;}, loseSend() {loseSend = true;}, loseCas(at: number) {loseCasAt = at;}};
}

test('captures native publisher and exact execution in private bytes, seals an actual message and keeps Host navigation', async () => {
  const f = await fixture();const text = '# Original result\n包内私有正文';
  const first = await f.artifacts.publishText(f.binding, {text, mediaType: 'text/markdown'});
  expect(first.taskRef).toBe('task:work:task');expect(first.taskRevision).toBe(1);
  expect(first.textPublication).toMatchObject({publisherCatId: 'cat', invocationId: 'native-turn', triggerMessageId: 'trigger',
    executionRef: 'message:execution', resultRevision: 1, executionRevision: 1, byteLength: Buffer.byteLength(text)});
  expect(first.previewRef).toBe('/owned-thread/private');expect(first.openInWorkspaceRef).toBe('/owned-thread/private');
  expect(f.messages.get('published')?.catId).toBeNull();
  expect(f.messages.get('published')?.content).not.toContain(text);
  expect(await f.artifacts.readCurrent(f.binding)).toMatchObject({snapshot: first, text});
  const before = JSON.stringify([...f.records]);expect(await f.artifacts.publishText(f.binding, {text, mediaType: 'text/markdown'})).toEqual(first);
  expect(JSON.stringify([...f.records])).toBe(before);expect(f.sends).toBe(1);
});

test('settled response loss reuses private capture and the same Host message, while a conflicting body cannot overwrite it', async () => {
  const f = await fixture();f.loseSend();
  await expect(f.artifacts.publishText(f.binding, {text: 'result', mediaType: 'text/plain'})).rejects.toThrow('lost');
  const result = await f.artifacts.publishText(f.binding, {text: 'result', mediaType: 'text/plain'});
  expect(result.textPublication?.sourceMessageId).toBe('published');expect(f.messages.size).toBe(1);
  await expect(f.artifacts.publishText(f.binding, {text: 'other', mediaType: 'text/plain'})).rejects.toMatchObject({code: 'WORK_ARTIFACT_UNAVAILABLE'});
});

test('revocation, stored block/source changes and private byte corruption fail closed', async () => {
  const f = await fixture();await f.artifacts.publishText(f.binding, {text: 'result', mediaType: 'text/plain'});
  const message = f.messages.get('published')!;f.messages.set('published', {...message, sourceRevision: 'changed'});
  await expect(f.artifacts.readCurrent(f.binding)).rejects.toMatchObject({code: 'WORK_ARTIFACT_UNAVAILABLE'});
  f.messages.set('published', {...message, contentBlocks: [{type: 'file', url: 'other', fileName: 'a.txt', mimeType: 'text/plain', fileSize: 6}]});
  await expect(f.artifacts.readCurrent(f.binding)).rejects.toMatchObject({code: 'WORK_ARTIFACT_UNAVAILABLE'});
  f.messages.set('published', message);
  const [key, row] = [...f.records][0]!;
  const stored = row.value as {snapshot: {openInWorkspaceRef: string}};
  f.records.set(key, {revision: row.revision, value: {...stored, snapshot: {...stored.snapshot, openInWorkspaceRef: 'javascript:untrusted'}}});
  await expect(f.artifacts.readCurrent(f.binding)).rejects.toMatchObject({code: 'WORK_ARTIFACT_UNAVAILABLE'});
  f.records.set(key, {revision: row.revision, value: {...row.value as object, text: 'tampered'}});
  await expect(f.artifacts.readCurrent(f.binding)).rejects.toMatchObject({code: 'WORK_ARTIFACT_UNAVAILABLE'});
  f.expire();await expect(f.artifacts.readCurrent(f.binding)).rejects.toThrow('revoked');
});

test('UTF8 byte budget, NUL, lone surrogates and caller-supplied identity are rejected before publication', async () => {
  const f = await fixture();
  for (const text of ['你'.repeat(21846), 'a\0b', '\ud800'])
    await expect(f.artifacts.publishText(f.binding, {text, mediaType: 'text/plain'})).rejects.toMatchObject({code: 'WORK_ARTIFACT_UNAVAILABLE'});
  await expect(f.artifacts.publishText(f.binding, {text: 'a', mediaType: 'text/plain', publisherCatId: 'forged'} as never)).rejects.toThrow();
  expect(f.sends).toBe(0);expect(f.records.size).toBe(0);
});

for (const at of [1, 2]) test(`applied private CAS response loss at stage ${at} retains the same publication`, async () => {
  const f = await fixture();f.loseCas(at);
  await expect(f.artifacts.publishText(f.binding, {text: 'result', mediaType: 'text/plain'})).rejects.toThrow('CAS response lost');
  const restored = await f.artifacts.publishText(f.binding, {text: 'result', mediaType: 'text/plain'});
  expect(restored.textPublication?.sourceMessageId).toBe('published');expect(f.messages.size).toBe(1);expect(f.sends).toBe(1);
});

test('a later current invocation preserves the first authenticated publisher instead of rewriting it', async () => {
  const f = await fixture();const first = await f.artifacts.publishText(f.binding, {text: 'result', mediaType: 'text/plain'});
  const replay = {...f.binding, auth: {...f.binding.auth, invocationId: 'later-current-turn'}};
  expect(await f.artifacts.publishText(replay, {text: 'result', mediaType: 'text/plain'})).toEqual(first);
  expect(first.textPublication?.invocationId).toBe('native-turn');expect(f.sends).toBe(1);
});

test('return selection atomically fixes no-artifact and rejects a later publication before Host send', async () => {
  const f = await fixture();expect(await f.artifacts.selectForReturn(f.binding)).toBeUndefined();
  expect(await f.artifacts.readCurrent(f.binding)).toBeUndefined();
  await expect(f.artifacts.publishText(f.binding, {text: 'late artifact', mediaType: 'text/plain'})).rejects.toMatchObject({code: 'WORK_ARTIFACT_UNAVAILABLE'});
  expect(f.sends).toBe(0);
});

test('a selected canonical snapshot forbids downgrading missing private material to body-only', async () => {
  const f = await fixture();const snapshot = await f.artifacts.publishText(f.binding, {text: 'result', mediaType: 'text/plain'});
  f.records.clear();
  await expect(f.artifacts.selectForReturn(f.binding, snapshot)).rejects.toMatchObject({code: 'WORK_ARTIFACT_UNAVAILABLE'});
  expect(f.records.size).toBe(0);
});
