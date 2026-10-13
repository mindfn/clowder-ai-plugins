import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMeetingPluginModule } from '../src/plugin-entrypoint.js';
import type { ModulePluginHostShape, PluginActionContext, PluginOwnerOperationContext } from '@clowder-ai/plugin-sdk';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-shipped-journey-'));
  const config = new Map<string, unknown>([['appId','cli_fixture'],['notificationThreadId','thread'],['minutesReference','minute1']]);
  const calls: string[][] = [], sends: unknown[] = [];
  let revoked = false, blocked = false, failCompletion = false;
  const current = async () => { if (revoked) throw new Error('owner revoked'); };
  const owner = (actionId: string, operationKey = 'account'): PluginOwnerOperationContext => ({ kind: 'owner-operation', userId: 'owner', pluginInstanceId: 'installed-meeting', operationKey, actionId, requestId: actionId, signal: new AbortController().signal, assertCurrent: current });
  const minute = { ok: true, data: { minute: { token: 'minute1', create_time: '1786381200000', title: 'Meeting title' } } };
  const scopes = 'minutes:minutes.search:read minutes:minutes.basic:read vc:meeting.search:read vc:meeting.meetingevent:read vc:record:readonly';
  const host = { dataDirectory: directory, config: { async get(key: string) { return config.get(key); } }, secrets: { async get() { return 'fixture-private-app-secret'; } },
    storage: {}, tasks: {}, threads: { async get(id: string) { if (blocked) return null; return { id, deepLinkUrl: 'http://127.0.0.1/thread', title: null, createdAt: 1, lastActiveAt: 1, preferredCats: ['cat'], featureRefs: [] }; } }, media: {},
    messaging: { async send(input: { threadId: string }) { sends.push(input); return { messageId: 'notice', threadId: input.threadId }; } }, log() {},

  } as unknown as ModulePluginHostShape;
  const module = createMeetingPluginModule({ command: () => async (args, signal, cwd) => {
    signal.throwIfAborted(); calls.push([...args]);
    if (args[0] === 'auth' && args[1] === 'status') return { appId: 'cli_fixture', identity: 'user', verified: true, identities: { user: { scope: scopes } } };
    if (args[0] === 'auth' && args[1] === 'login' && !args.includes('--no-wait') && failCompletion) throw new Error('Token exchange result lost');
    if (args[0] === 'auth' && args[1] === 'login') return args.includes('--no-wait') ? { device_code: 'private-device-code', verification_url: 'https://accounts.feishu.cn/device?user_code=fixture', expires_in: 240 } : { ok: true };
    if (args[0] === 'minutes' && args[1] === 'minutes') return minute;
    if (args[0] === 'minutes' && args[1] === '+detail') {
      await mkdir(join(cwd!, 'artifact'), { recursive: true });
      await writeFile(join(cwd!, 'artifact', 'transcript.txt'), 'Source transcript', { mode: 0o600 });
      return { data: { minutes: [{ minute_token: 'minute1', artifacts: { transcript_file: 'artifact/transcript.txt' } }] } };
    }
    throw new Error('Unexpected fixture command');
  } });
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  let active = await module.create(manifest).start(host);
  const native: PluginActionContext = { userId: 'owner', threadId: 'thread', catId: 'cat', invocationId: 'invocation', assertCurrent: current };
  const input = (body: Record<string, unknown> = {}) => ({ input: { ...Object.fromEntries(config), ...body } });
  return { directory, get active() { return active; }, async restart() { await active.stop(); active = await module.create(manifest).start(host); }, native, input, owner, config, calls, sends, loseCompletion() { failCompletion = true; }, revoke() { revoked = true; }, block() { blocked = true; }, async close() { await active.stop(); await rm(directory, { recursive: true, force: true }); } };
}

test('actual Settings → device authorization → retained notification → native read survives module restart', async () => {
  const f = await fixture();
  try {
    assert.equal(f.calls.length, 0);
    const challenge = await f.active.actions['meeting.connect']!(f.input(), undefined, f.owner('connect', 'authorization'));
    assert.ok(!JSON.stringify(challenge).includes('private-device-code'));
    const pending = await f.active.actions['meeting.status']!(f.input(), undefined, f.owner('status')) as { data: { auth: string; collectionIntent: string } };
    assert.equal(pending.data.auth, 'pending'); assert.equal(pending.data.collectionIntent, 'disabled');
    await f.active.actions['meeting.complete']!(f.input(), undefined, f.owner('complete', 'authorization'));
    await f.active.actions['meeting.import']!(f.input(), undefined, f.owner('import', 'manualImport'));
    assert.equal(f.sends.length, 1);
    const page = await f.active.actions['meeting.records.list']!({}, f.native) as { records: { id: string }[] };
    assert.equal(page.records.length, 1);
    const read = await f.active.actions['meeting.records.read']!({ recordId: page.records[0]!.id }, f.native) as { text: string; generationRevision: string; textSha256: string };
    assert.equal(read.text, 'Source transcript'); assert.equal(read.generationRevision, '1786381200000'); assert.match(read.textSha256, /^[a-f0-9]{64}$/);
    await f.active.actions['meeting.import']!(f.input(), undefined, f.owner('import', 'manualImport'));
    assert.equal(f.sends.length, 1, 'delivered record is retained and never notified twice');
    const prior = f.calls.length; await f.restart(); assert.equal(f.calls.length, prior, 'restart remains control-only');
    const retained = await f.active.actions['meeting.records.list']!({}, f.native) as { records: { id: string }[] };
    assert.equal(retained.records[0]?.id, page.records[0]!.id);
    await assert.rejects(() => f.active.actions['meeting.records.read']!({ recordId: page.records[0]!.id, userId: 'owner' }, f.native) as Promise<unknown>);
    await assert.rejects(() => f.active.actions['meeting.records.read']!({ recordId: page.records[0]!.id }, { ...f.native, threadId: 'foreign' }) as Promise<unknown>, /thread|unavailable/);
    f.block();
    await assert.rejects(() => f.active.actions['meeting.import']!(f.input(), undefined, f.owner('import', 'manualImport')) as Promise<unknown>, /thread.*unavailable/);
    assert.equal(f.sends.length, 1);
    f.revoke();
    await assert.rejects(() => f.active.actions['meeting.status']!(f.input(), undefined, f.owner('status')) as Promise<unknown>, /revoked/);
  } finally { await f.close(); }
});

test('native action rejects owner/ordinary calls and Settings refuses body identity or naked input', async () => {
  const f = await fixture();
  try {
    await assert.rejects(() => f.active.actions['meeting.records.list']!({}) as Promise<unknown>, /native invocation/);
    await assert.rejects(() => f.active.actions['meeting.status']!({ input: { userId: 'owner' } }, undefined, f.owner('status')) as Promise<unknown>);
    await assert.rejects(() => f.active.actions['meeting.status']!({}, undefined, f.owner('status')) as Promise<unknown>);
    assert.equal(f.calls.length, 0); assert.equal(f.sends.length, 0);
  } finally { await f.close(); }
});


test('interrupted authorization retains unknown truth and never blindly repeats token exchange', async () => {
  const f = await fixture();
  try {
    await f.active.actions['meeting.connect']!(f.input(), undefined, f.owner('connect', 'authorization'));
    f.loseCompletion();
    await assert.rejects(() => f.active.actions['meeting.complete']!(f.input(), undefined, f.owner('complete', 'authorization')) as Promise<unknown>, /result lost/);
    const unknown = await f.active.actions['meeting.status']!(f.input(), undefined, f.owner('status')) as { data: { auth: string } };
    assert.equal(unknown.data.auth, 'unknown');
    const calls = f.calls.length;
    await assert.rejects(() => f.active.actions['meeting.complete']!(f.input(), undefined, f.owner('complete', 'authorization')) as Promise<unknown>, /verification/);
    assert.equal(f.calls.length, calls, 'no second exchange');
    await f.restart();
    await f.active.actions['meeting.verify']!(f.input(), undefined, f.owner('verify', 'verifyAccount'));
    const status = await f.active.actions['meeting.status']!(f.input(), undefined, f.owner('status')) as { data: { auth: string; collectionIntent: string } };
    assert.equal(status.data.auth, 'connected'); assert.equal(status.data.collectionIntent, 'disabled');
  } finally { await f.close(); }
});
