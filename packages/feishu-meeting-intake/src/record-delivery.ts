import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, lstat, open, opendir, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { requireGeneratedArtifactDescriptor } from './artifact.js';
import type { FeishuGeneratedArtifact } from './gateway.js';

const RECORD_BYTES = 16 * 1024;
const RECORD_ID = /^[a-f0-9]{64}$/;
// The Host owns one active module writer per instance. These tails also serialize
// reopened handles within that process; they are not a cross-process locking claim.
const tails = new Map<string, Promise<void>>();

export interface MeetingRecordScope { assertCurrent(): Promise<void>; }
export interface MeetingNotificationInput {
  readonly threadId: string;
  readonly idempotencyKey: string;
  readonly payload: {
    readonly provenance: { readonly epistemicStatus: 'observation' };
    readonly elements: readonly [{ readonly elementId: 'generated'; readonly kind: 'text'; readonly payload: { readonly text: string } }];
  };
}
export interface MeetingRecord {
  readonly v: 1;
  readonly id: string;
  readonly pluginInstanceId: string;
  readonly descriptor: FeishuGeneratedArtifact;
  readonly source: { readonly handle: string };
  readonly notification: {
    readonly state: 'pending' | 'unknown' | 'delivered';
    readonly input: MeetingNotificationInput;
    readonly receipt?: { readonly messageId: string; readonly threadId: string };
  };
}
export type MeetingNotificationSend = (input: MeetingNotificationInput) => Promise<{ readonly messageId: string; readonly threadId: string }>;

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function requireId(id: string): void {
  if (!RECORD_ID.test(id)) throw new TypeError('invalid meeting record identifier');
}
function requireTarget(threadId: string): void {
  // Match the neutral messaging Host's threadId bound; IDs are never paths.
  if (typeof threadId !== 'string' || threadId.length < 1 || threadId.length > 500 || threadId.trim() !== threadId)
    throw new TypeError('invalid meeting notification target');
}
function candidate(descriptor: unknown, threadId: string, pluginInstanceId: string): MeetingRecord {
  requireTarget(threadId);
  const safe = requireGeneratedArtifactDescriptor(descriptor);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(safe.generatedAt) ||
    !Number.isFinite(Date.parse(safe.generatedAt)) || new Date(safe.generatedAt).toISOString().slice(0, 19) !== safe.generatedAt.slice(0, 19))
    throw new TypeError('meeting generation time must identify a valid UTC instant');
  const handle = `feishu://meeting-artifacts/${safe.kind}/${safe.artifactId}?revision=${safe.revision}`;
  const normalized: FeishuGeneratedArtifact = {
    artifactId: safe.artifactId, kind: safe.kind, revision: safe.revision, generatedAt: safe.generatedAt,
    ...(safe.title === undefined ? {} : { title: safe.title }),
    ...(safe.meetingId === undefined ? {} : { meetingId: safe.meetingId }),
  };
  const id = digest(handle);
  return {
    v: 1, id, pluginInstanceId, descriptor: normalized, source: { handle: handle },
    notification: { state: 'pending', input: {
      // JSON framing preserves opaque Unicode IDs, including lone surrogates,
      // rather than letting UTF-8 replacement collapse distinct Host identities.
      threadId, idempotencyKey: 'meeting:' + digest(JSON.stringify([pluginInstanceId, handle])),
      payload: { provenance: { epistemicStatus: 'observation' }, elements: [{ elementId: 'generated', kind: 'text',
        payload: { text: `会议资料已生成：${safe.title ?? safe.artifactId}\n记录：${id}\n来源：${handle}` } }] },
    } },
  };
}
function validRecord(value: unknown, id: string, pluginInstanceId: string): MeetingRecord {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const record = value as MeetingRecord;
    const expected = candidate(record.descriptor, record.notification.input.threadId, pluginInstanceId);
    const { receipt, state } = record.notification;
    if (!['pending', 'unknown', 'delivered'].includes(state) ||
      (state !== 'delivered' && receipt !== undefined) ||
      (state === 'delivered' && (!receipt || typeof receipt.messageId !== 'string' ||
        receipt.messageId.length < 1 || receipt.messageId.length > 512 || receipt.threadId !== expected.notification.input.threadId ||
        Object.keys(receipt).length !== 2)) ||
      id !== expected.id || !isDeepStrictEqual(record, {
        ...expected, notification: { ...expected.notification, state, ...(receipt ? { receipt } : {}) },
      })) throw new Error();
    return structuredClone(record);
  } catch { throw new Error('invalid persisted meeting record'); }
}

/** Internal package custody; read authorization belongs to the module/native caller.
 * No TTL or delete API. A delivery receipt never removes its source record. */
export function createMeetingRecordDelivery(directory: string, options: { readonly pluginInstanceId: string }) {
  if (!isAbsolute(directory)) throw new TypeError('meeting record directory must be absolute');
  // H5 is 1..512 opaque code points, not a filesystem-safe alphabet.
  if (typeof options.pluginInstanceId !== 'string' || options.pluginInstanceId.length === 0 ||
    [...options.pluginInstanceId].length > 512) throw new TypeError('invalid meeting instance identifier');
  const root = resolve(directory), instanceId = options.pluginInstanceId;
  async function ensureDirectory(): Promise<void> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('meeting record directory must be private and regular');
  }
  async function get(id: string): Promise<MeetingRecord | undefined> {
    requireId(id);
    await ensureDirectory();
    let file;
    // Nonblocking open lets us reject a FIFO before any read; fstat after a
    // blocking FIFO open would never reach the regular-file check.
    try { file = await open(join(root, id + '.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error('meeting record must be a regular private file');
      throw error;
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > RECORD_BYTES) throw new Error('meeting record must be a regular private bounded file');
      // Read a bounded buffer even if an unexpected external writer grows it after stat.
      const bytes = Buffer.alloc(RECORD_BYTES + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > RECORD_BYTES) throw new Error('meeting record exceeds its bound');
      let value: unknown;
      try { value = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')); }
      catch { throw new Error('invalid persisted meeting record'); }
      return validRecord(value, id, instanceId);
    } finally { await file.close(); }
  }
  function serialized<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const key = root + '/' + id;
    const result = (tails.get(key) ?? Promise.resolve()).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    tails.set(key, tail);
    void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return result;
  }
  async function commit(record: MeetingRecord, scope: MeetingRecordScope): Promise<void> {
    await scope.assertCurrent();
    await ensureDirectory();
    const encoded = JSON.stringify(record) + '\n';
    if (Buffer.byteLength(encoded) > RECORD_BYTES) throw new Error('meeting record exceeds its bound');
    const temp = join(root, '.' + randomUUID() + '.tmp');
    try {
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(encoded, 'utf8'); await file.sync(); }
      finally { await file.close(); }
      await scope.assertCurrent();
      await rename(temp, join(root, record.id + '.json'));
      const dir = await open(root, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    } finally { await rm(temp, { force: true }); }
  }
  return {
    get,
    async record(descriptor: unknown, threadId: string, scope: MeetingRecordScope): Promise<MeetingRecord> {
      const next = candidate(descriptor, threadId, instanceId);
      return serialized(next.id, async () => {
        await scope.assertCurrent();
        const existing = await get(next.id);
        if (existing) {
          if (!isDeepStrictEqual(existing.descriptor, next.descriptor) ||
            !isDeepStrictEqual(existing.notification.input, next.notification.input)) throw new Error('meeting source and notification intent are immutable');
          return existing;
        }
        await commit(next, scope);
        return structuredClone(next);
      });
    },
    async deliver(id: string, send: MeetingNotificationSend, scope: MeetingRecordScope): Promise<MeetingRecord> {
      requireId(id);
      return serialized(id, async () => {
        await scope.assertCurrent();
        const record = await get(id);
        if (!record) throw new Error('meeting record not found');
        if (record.notification.state === 'delivered') return record;
        const attempt: MeetingRecord = { ...record, notification: { ...record.notification, state: 'unknown' } };
        // Persist the possible effect before entering SDK send. Recovery must reuse
        // the exact Host idempotency key/body/target, never >=500 retry heuristics.
        await commit(attempt, scope);
        await scope.assertCurrent();
        const receipt = await send(structuredClone(attempt.notification.input));
        await scope.assertCurrent();
        // SDK receipts include revision/sequence and a Host capability handle.
        // Keep only the durable settlement identity, never that capability.
        const accepted: MeetingRecord = { ...attempt, notification: { ...attempt.notification, state: 'delivered',
          receipt: { messageId: receipt.messageId, threadId: receipt.threadId } } };
        const checked = validRecord(accepted, id, instanceId);
        await commit(checked, scope);
        return checked;
      });
    },
    async list(input: { readonly limit: number; readonly after?: string }): Promise<{ readonly records: readonly MeetingRecord[]; readonly next?: string }> {
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 64) throw new TypeError('meeting page limit must be 1..64');
      if (input.after !== undefined) requireId(input.after);
      await ensureDirectory();
      // Stream directory membership and retain only this page + one lookahead.
      // User records have no TTL; page memory must not grow with total history.
      const ids: string[] = [];
      for await (const entry of await opendir(root)) {
        if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
        const id = entry.name.slice(0, -5);
        if (input.after !== undefined && id <= input.after) continue;
        ids.push(id); ids.sort();
        if (ids.length > input.limit + 1) ids.pop();
      }
      const page = ids.slice(0, input.limit);
      const records: MeetingRecord[] = [];
      for (const id of page) {
        const record = await get(id);
        if (!record) throw new Error('meeting page changed unexpectedly');
        records.push(record);
      }
      return { records, ...(ids.length > page.length ? { next: page.at(-1) } : {}) };
    },
  };
}
