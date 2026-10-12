import assert from 'node:assert/strict';
import test from 'node:test';
import { definePlugin, type FeatureContext, FeatureContextRevokedError } from './feature-context.js';
import { definePluginModule } from './module-plugin.js';
import type { ModulePluginHostShape } from './module-host.js';
function source() { return { id: 'origin', userId: 'owner', threadId: 'thread', catId: null, content: 'body',
  source: { connector: 'neutral', meta: { participation: { revision: 3 } } }, extra: { pluginMessage: { instanceId: 'instance' } } }; }
function native() { return { userId: 'owner', threadId: 'thread', catId: 'cat', invocationId: 'inv', originTriggerMessageId: 'origin', source: source() }; }
async function fixture(ports: Record<string, unknown> = {}, capabilities = ['thread.readContent']) {
  let context!: FeatureContext;
  const manifest = { pluginId: 'dev.source-facts-fixture', version: '0.1.0', contractVersion: '0.1.0-beta.36', name: 'Source fixture', runtime: { transport: 'builtin', entrypoint: 'dist/index.js' },
    features: [{ id: 'facts', name: 'Facts', resources: [], capabilities }] };
  const module = definePluginModule(input => definePlugin({ manifest: input, activate: { facts: value => { context = value; return { actions: {} }; } } }));
  const host = { config: { get: async () => undefined }, secrets: { get: async () => undefined }, storage: {}, tasks: {}, threads: {}, messaging: {}, media: {}, log() {}, ...ports } as unknown as ModulePluginHostShape;
  const activation = await module.create(manifest as never).start(host);
  return { context, activation };
}
// Untyped hostile inputs below exercise the protocol boundary rather than the TypeScript caller.
function portsOf(context: FeatureContext) { return context as unknown as {
  sourceFacts?: { read(input: unknown): Promise<ReturnType<typeof source>> };
  nativeContext?: { current(): Promise<ReturnType<typeof native>> };
}; }
test('module forwards source facts and exact native origin, detached and deeply frozen', async () => {
  const calls: unknown[] = []; const fact = source(), current = native();
  const { context, activation } = await fixture({ sourceFacts: { async read(input: unknown) { calls.push(input); return fact; } },
    nativeContext: { async current(...args: unknown[]) { calls.push(args); return current; } } });
  const ports = portsOf(context); assert.ok(ports.sourceFacts, 'Missing module sourceFacts port'); assert.ok(ports.nativeContext, 'Missing module nativeContext port');
  const got = await ports.sourceFacts.read({ messageRef: 'message:origin' }); const ctx = await ports.nativeContext.current();
  assert.deepEqual(calls, [{ messageRef: 'message:origin' }, []]); assert.deepEqual(got, fact); assert.deepEqual(ctx, current);
  assert.ok(Object.isFrozen(got.source.meta.participation)); assert.ok(Object.isFrozen(ctx.source.extra.pluginMessage));
  fact.source.meta.participation.revision = 9; current.source.content = 'changed';
  assert.equal(got.source.meta.participation.revision, 3); assert.equal(ctx.source.content, 'body');
  await activation.stop();
});
test('older carriers keep each source port absent and supplied incomplete ports fail closed', async () => {
  const { context, activation } = await fixture(); assert.equal(portsOf(context).sourceFacts, undefined); assert.equal(portsOf(context).nativeContext, undefined); await activation.stop();
  await assert.rejects(fixture({ sourceFacts: {} }), /source facts port/);
  await assert.rejects(fixture({ nativeContext: {} }), /native context port/);
});
test('source ports require existing content grant before either Host call', async () => {
  let calls = 0; const { context, activation } = await fixture({ sourceFacts: { async read() { calls++; return source(); } }, nativeContext: { async current() { calls++; return native(); } } }, []);
  const ports = portsOf(context); assert.ok(ports.sourceFacts); assert.ok(ports.nativeContext);
  await assert.rejects(() => ports.sourceFacts!.read({ messageRef: 'message:origin' }), /thread.readContent/);
  await assert.rejects(() => ports.nativeContext!.current(), /thread.readContent/); assert.equal(calls, 0); await activation.stop();
});
test('source input rejects caller authority and native current rejects a body without sending it', async () => {
  let calls = 0; const { context, activation } = await fixture({ sourceFacts: { async read() { calls++; return source(); } }, nativeContext: { async current() { calls++; return native(); } } });
  const ports = portsOf(context); assert.ok(ports.sourceFacts); assert.ok(ports.nativeContext);
  await assert.rejects(() => ports.sourceFacts!.read({ messageRef: 'message:origin', userId: 'forged' }), TypeError);
  const current = ports.nativeContext.current as (body?: unknown) => Promise<unknown>;
  await assert.rejects(() => current({ originTriggerMessageId: 'other' }), TypeError); assert.equal(calls, 0); await activation.stop();
});
test('owner/native Host refusal is preserved with no retries or generic read fallback', async () => {
  const refusal = new Error('DELIVERY_REJECTED'); let calls = 0;
  const { context, activation } = await fixture({ sourceFacts: { async read() { calls++; throw refusal; } }, nativeContext: { async current() { calls++; throw refusal; } } });
  const ports = portsOf(context); assert.ok(ports.sourceFacts); assert.ok(ports.nativeContext);
  await assert.rejects(() => ports.sourceFacts!.read({ messageRef: 'message:origin' }), e => e === refusal);
  await assert.rejects(() => ports.nativeContext!.current(), e => e === refusal); assert.equal(calls, 2); await activation.stop();
});
test('both source ports reject late response after stop and do not send later calls', async () => {
  let finishRead!: (value: ReturnType<typeof source>) => void; let finishCurrent!: (value: ReturnType<typeof native>) => void; let calls = 0;
  const { context, activation } = await fixture({ sourceFacts: { async read() { calls++; return new Promise(resolve => { finishRead = resolve; }); } }, nativeContext: { async current() { calls++; return new Promise(resolve => { finishCurrent = resolve; }); } } });
  const ports = portsOf(context); assert.ok(ports.sourceFacts); assert.ok(ports.nativeContext);
  const read = ports.sourceFacts.read({ messageRef: 'message:origin' }), current = ports.nativeContext.current();
  await activation.stop(); finishRead(source()); finishCurrent(native());
  await assert.rejects(read, FeatureContextRevokedError); await assert.rejects(current, FeatureContextRevokedError);
  await assert.rejects(() => ports.sourceFacts!.read({ messageRef: 'message:origin' }), FeatureContextRevokedError);
  await assert.rejects(() => ports.nativeContext!.current(), FeatureContextRevokedError); assert.equal(calls, 2);
});
test('source and native Host responses reject expanded Work or private fields', async () => {
  const { context, activation } = await fixture({ sourceFacts: { async read() { return { ...source(), receipt: {} }; } }, nativeContext: { async current() { return { ...native(), binding: {} }; } } });
  const ports = portsOf(context); assert.ok(ports.sourceFacts); assert.ok(ports.nativeContext);
  await assert.rejects(() => ports.sourceFacts!.read({ messageRef: 'message:origin' }), /PluginSourceFact/);
  await assert.rejects(() => ports.nativeContext!.current(), /PluginNativeContext/); await activation.stop();
});
