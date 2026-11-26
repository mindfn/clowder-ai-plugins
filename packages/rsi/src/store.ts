import { createHash, randomUUID } from 'node:crypto';
import { seedState } from './fixtures.js';
import type { Data, Experiment, RsiState, RsiStorage } from './types.js';

export const record = (value: unknown): value is Data => value !== null && typeof value === 'object' && !Array.isArray(value);
export const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
export const isState = (value: unknown): value is RsiState => record(value) && Array.isArray(value.projects)
  && record(value.objectives) && record(value.experiments) && record(value.details) && Array.isArray(value.outbox);

// Host caps each storage value at 1 MiB. An owner's state is sharded across multiple keys under one atomic root manifest
// (`rsi:<b64>`): root keeps lightweight metadata/outbox/index (~40 KB), while each experiment (`:e:`), each closed cycle
// (`:r:`), built-in demo details (`:d:`), and each non-empty project library (`:l:`) live in their own keys. Unchanged
// shards are reused across writes without rewriting; root CAS is the sole commit fence.
export const LIMIT = 1024 * 1024, LOG_KEEP = 2000, CLOSED_LOG_KEEP = 400, ARCHIVED_LOG_KEEP = 120, AGENT_KEEP = 24 * 3600_000, MAX_MESSAGES = 60, MAX_HISTORY_REVS = 5, GC_GRACE_MS = 60_000;
export const clip = (value: string) => value.length <= LOG_KEEP ? value : `${value.slice(0, LOG_KEEP / 4)}\n…\n${value.slice(-(LOG_KEEP * 3) / 4)}`;
// What a cycle's library note keeps of its conclusion: the verdict, the confirmation and each group's mean of the main metric.
export const cycleResult = (verdict: string, compared: Data, confirmation: Data | null) => ({ verdict, metric: compared.metric,
  means: Object.fromEntries(compared.groups.map((g: Data) => [g.group, g.mean])), confirmation: confirmation && { status: confirmation.status, version: confirmation.version } });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function compact(state: RsiState, now = Date.now()) {
  for (const d of Object.values(state.experiments)) {
    if (typeof d.executor?.probe?.log === 'string') d.executor.probe.log = d.executor.probe.log.slice(-LOG_KEEP);
    if (typeof d.executor?.probe?.error === 'string') d.executor.probe.error = clip(d.executor.probe.error);
    if (Array.isArray(d.messages) && d.messages.length > MAX_MESSAGES) d.messages = d.messages.slice(-MAX_MESSAGES);
    if (d.stepHistory) {
      for (const [k, hist] of Object.entries<Data[]>(d.stepHistory)) {
        if (!Array.isArray(hist)) continue;
        if (hist.length > MAX_HISTORY_REVS) hist.splice(0, hist.length - MAX_HISTORY_REVS);
        const latestRev = d.steps?.[k as keyof typeof d.steps]?.rev;
        for (const h of hist) if (latestRev != null && h.rev === latestRev && h.items) delete h.items;
      }
    }
    const rounds = d.rounds || [];
    for (let idx = 0; idx < rounds.length; idx++) {
      const r = rounds[idx];
      const closed = ['done', 'repaired'].includes(r.state);
      const archived = closed && idx < rounds.length - 3;
      if (r.metrics && d.metrics && same(r.metrics, d.metrics)) delete r.metrics;
      if (r.report?.compare) delete r.report.compare.matrix;
      const baseEnv = archived ? r.runs?.[0]?.env : undefined;
      for (let ri = 0; ri < (r.runs || []).length; ri++) {
        const run = r.runs[ri];
        if (typeof run.log === 'string') run.log = run.log.slice(-(archived ? ARCHIVED_LOG_KEEP : closed ? CLOSED_LOG_KEEP : LOG_KEEP));
        if (archived && ri > 0 && run.env && baseEnv && same(run.env, baseEnv)) delete run.env;
        for (const failure of [run.error, ...(run.attempts || []).map((a: Data) => a.error)]) if (typeof failure?.raw === 'string') failure.raw = clip(failure.raw);
        if (closed) for (const a of run.attempts || []) for (const k of ['env', 'metrics', 'slices']) if (same(a[k], run[k])) delete a[k];
      }
    }
  }
  for (const doc of Object.values(state.library).flat()) if (doc.result?.comparison) doc.result = cycleResult(doc.result.verdict, doc.result.comparison, doc.result.confirmation);
  const answered = (e: Data) => Object.values<Data>(state.experiments[e.objective]?.lifecycle || {}).some((x) => x.applied && x.replyTo === e.messageId);
  state.outbox = state.outbox.filter((e) => !e.sent || e.kind === 'agent' && now - e.sent < AGENT_KEEP && !answered(e));
}

export const ownerKey = (userId: string) => `rsi:${Buffer.from(userId).toString('base64url')}`;
export const isOwnerKey = (key: string) => key.startsWith('rsi:') && !key.includes(':', 4);

interface ShardManifest {
  details?: string;
  library: Record<string, string>;
  experiments: Record<string, { key: string; rounds: Record<string, string> }>;
}

interface ShardedRoot extends Data {
  sharded: 1;
  seq: number;
  shards: ShardManifest;
  gc?: { key: string; at: number }[];
}

interface LoadedState {
  revision: number;
  value: unknown;
  legacy: boolean;
  root?: ShardedRoot;
  shards?: Map<string, unknown>;
  shardJson?: Map<string, string>;
}

const INCREMENTAL_SHARD_LIMIT = 8;
const ownerCache = new WeakMap<RsiStorage, Map<string, LoadedState>>();
const cacheFor = (storage: RsiStorage) => {
  let map = ownerCache.get(storage);
  if (!map) ownerCache.set(storage, map = new Map());
  return map;
};

const isShardedRoot = (value: unknown): value is ShardedRoot =>
  record(value) && value.sharded === 1 && Array.isArray(value.projects) && record(value.objectives) && record(value.shards) && Array.isArray(value.outbox);

const shortId = (id: string) => /^[\w-]{1,48}$/.test(id) ? id : `h${createHash('sha256').update(id).digest('hex').slice(0, 20)}`;
const hash16 = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);
const shardTag = (seq: number) => `${seq}-${randomUUID().slice(0, 6)}`;
const isClosedRound = (r: Data) => ['done', 'repaired'].includes(r?.state) && typeof r.n === 'number';

function referencedShardKeys(shards: ShardManifest | undefined): Set<string> {
  const keys = new Set<string>();
  if (!shards) return keys;
  if (shards.details) keys.add(shards.details);
  for (const k of Object.values(shards.library || {})) keys.add(k);
  for (const exp of Object.values(shards.experiments || {})) {
    keys.add(exp.key);
    for (const rk of Object.values(exp.rounds || {})) keys.add(rk);
  }
  return keys;
}

function buildShardedState(
  root: ShardedRoot,
  values: Map<string, unknown>,
  shardJson: Map<string, string>,
  revision: number,
): LoadedState {
  const shards = root.shards;
  const details = shards.details ? (values.get(shards.details) as Record<string, Data>) : {};
  const library: Record<string, Data[]> = {};
  for (const p of root.projects as Data[]) library[p.id] = [];
  for (const pid of Object.keys(root.objectives as Data)) library[pid] ||= [];
  for (const [pid, k] of Object.entries(shards.library || {})) {
    const entry = values.get(k) as Data;
    library[pid] = Array.isArray(entry?.items) ? entry.items : [];
  }
  const experiments: Record<string, Experiment> = {};
  for (const [expId, meta] of Object.entries(shards.experiments || {})) {
    const rawExp = values.get(meta.key) as Experiment;
    const rounds = Array.isArray(rawExp.rounds)
      ? rawExp.rounds.map((r: Data) =>
          record(r) && typeof r.__roundRef === 'number' && meta.rounds[String(r.__roundRef)]
            ? values.get(meta.rounds[String(r.__roundRef)]) as Data
            : r)
      : rawExp.rounds;
    experiments[expId] = { ...rawExp, ...(rounds !== undefined ? { rounds } : {}) };
  }
  const { sharded: _s, seq: _q, shards: _m, gc: _g, ...meta } = root;
  const state = { ...meta, details, library, experiments } as RsiState;
  return { revision, value: state, legacy: false, root, shards: values, shardJson };
}

async function assemble(
  raw: { revision: number; value: unknown },
  getShard: (shardKey: string) => Promise<unknown>,
  cached?: LoadedState,
): Promise<LoadedState> {
  if (isState(raw.value)) return { revision: raw.revision, value: raw.value, legacy: true };
  if (!isShardedRoot(raw.value)) return { revision: raw.revision, value: raw.value, legacy: false };
  const root = raw.value, shards = root.shards;
  const needed = [...referencedShardKeys(shards)];
  const values = new Map<string, unknown>(), shardJson = new Map<string, string>();
  const missing: string[] = [];
  for (const k of needed) {
    if (cached?.shards?.has(k)) {
      const v = cached.shards.get(k);
      values.set(k, v);
      shardJson.set(k, cached.shardJson?.get(k) ?? JSON.stringify(v));
    } else {
      missing.push(k);
    }
  }
  if (missing.length) {
    const fetched = await Promise.all(missing.map(async (k) => [k, await getShard(k)] as const));
    for (const [k, v] of fetched) {
      if (v === undefined) return { revision: raw.revision, value: { corrupted: true, missingShard: k }, legacy: false };
      values.set(k, v);
      shardJson.set(k, JSON.stringify(v));
    }
  }
  return buildShardedState(root, values, shardJson, raw.revision);
}

function saveCache(storage: RsiStorage, key: string, loaded: LoadedState) {
  const cache = cacheFor(storage);
  if (isState(loaded.value)) cache.set(key, loaded);
  else cache.delete(key);
}

function presentState(loaded: LoadedState, readonly: boolean): LoadedState {
  return readonly ? loaded : { ...loaded, value: structuredClone(loaded.value) };
}

export async function readState(storage: RsiStorage, key: string, options?: { readonly?: boolean }): Promise<LoadedState | undefined> {
  const readonly = !!options?.readonly;
  const cache = cacheFor(storage);
  const cached = cache.get(key);
  if (cached) {
    // Warm path: 1 lightweight root get (~40–80 KB) instead of full multi-MB storage.list().
    const raw = await storage.get(key);
    if (!raw) {
      cache.delete(key);
      return undefined;
    }
    if (raw.revision === cached.revision) return presentState(cached, readonly);
    if (isShardedRoot(raw.value) && cached.shards) {
      const needed = [...referencedShardKeys(raw.value.shards)];
      const missing = needed.filter((k) => !cached.shards!.has(k));
      if (missing.length <= INCREMENTAL_SHARD_LIMIT) {
        const loaded = await assemble(raw, async (k) => (await storage.get(k))?.value, cached);
        if (isState(loaded.value)) {
          cache.set(key, loaded);
          return presentState(loaded, readonly);
        }
        // A shard disappeared between root get and shard get (or state is genuinely corrupted):
        // fall through to 1 atomic storage.list() snapshot to verify before reporting corruption.
      }
    } else if (!isShardedRoot(raw.value)) {
      const loaded = await assemble(raw, async () => undefined);
      saveCache(storage, key, loaded);
      return presentState(loaded, readonly);
    }
  }
  // Cold path (or bulk shard delta): 1 storage.list() = 1 Host RPC & 1 atomic Redis HGETALL snapshot.
  const all = await storage.list();
  const raw = all[key];
  if (!raw) {
    cache.delete(key);
    return undefined;
  }
  const loaded = await assemble(raw, async (k) => all[k]?.value, cached);
  saveCache(storage, key, loaded);
  return presentState(loaded, readonly);
}

export async function listOwners(storage: RsiStorage): Promise<[string, { revision: number; value: RsiState; legacy: boolean }][]> {
  const cache = cacheFor(storage);
  const all = await storage.list();
  const out: [string, { revision: number; value: RsiState; legacy: boolean }][] = [];
  for (const [key, entry] of Object.entries(all)) {
    if (!isOwnerKey(key)) continue;
    const cached = cache.get(key);
    const loaded = cached && cached.revision === entry.revision
      ? cached
      : await assemble(entry, async (k) => all[k]?.value, cached);
    saveCache(storage, key, loaded);
    if (isState(loaded.value)) out.push([key, { revision: loaded.revision, value: loaded.value, legacy: loaded.legacy }]);
  }
  return out;
}

async function deleteBestEffort(storage: RsiStorage, keys: Iterable<string>) {
  if (!storage.delete) return;
  for (const k of keys) {
    try { await storage.delete(k); } catch {}
  }
}

async function commitSharded(
  storage: RsiStorage,
  key: string,
  expectedRevision: number | null,
  next: RsiState,
  prevRoot?: ShardedRoot,
  prevShardsMap?: Map<string, unknown>,
  prevJson?: Map<string, string>,
  assertCurrent: () => Promise<void> = async () => {},
): Promise<{ ok: true } | { error: string; status: number }> {
  const nextSeq = (prevRoot?.seq || 0) + 1;
  const tag = shardTag(nextSeq);
  const prevShards = prevRoot?.shards;
  const staged = new Map<string, { value: unknown; json: string; bytes: number }>();

  const planShard = (prevKey: string | undefined, newKey: string, value: unknown): string => {
    const json = JSON.stringify(value);
    if (prevKey && prevJson?.get(prevKey) === json) return prevKey;
    staged.set(newKey, { value, json, bytes: Buffer.byteLength(json) });
    return newKey;
  };

  const nextShards: ShardManifest = { library: {}, experiments: {} };
  if (Object.keys(next.details).length > 0) {
    nextShards.details = planShard(prevShards?.details, `${key}:d:${tag}`, next.details);
  }
  for (const [pid, items] of Object.entries(next.library)) {
    if (!Array.isArray(items) || items.length === 0) continue;
    nextShards.library[pid] = planShard(prevShards?.library?.[pid], `${key}:l:${hash16(pid)}:${tag}`, { project: pid, items });
  }
  for (const [expId, exp] of Object.entries(next.experiments)) {
    const prevExp = prevShards?.experiments?.[expId];
    const roundMap: Record<string, string> = {};
    const seen = new Set<string>();
    const compactRounds = (exp.rounds || []).map((r: Data) => {
      if (!isClosedRound(r)) return r;
      const rk = String(r.n);
      if (seen.has(rk)) return r;
      seen.add(rk);
      roundMap[rk] = planShard(prevExp?.rounds?.[rk], `${key}:r:${shortId(expId)}:${rk}:${tag}`, r);
      return { __roundRef: r.n };
    });
    const expBody = { ...exp, rounds: compactRounds };
    const expKey = planShard(prevExp?.key, `${key}:e:${shortId(expId)}:${tag}`, expBody);
    nextShards.experiments[expId] = { key: expKey, rounds: roundMap };
  }

  const now = Date.now();
  const kept = referencedShardKeys(nextShards);
  const newlyObsolete = prevShards
    ? [...referencedShardKeys(prevShards)].filter((k) => !kept.has(k)).map((k) => ({ key: k, at: now }))
    : [];
  const priorGc = Array.isArray(prevRoot?.gc) ? prevRoot.gc.filter((g) => g && typeof g.key === 'string' && !kept.has(g.key)) : [];
  const expiredGc = priorGc.filter((g) => now - g.at >= GC_GRACE_MS).map((g) => g.key);
  const pendingGc = [...priorGc.filter((g) => now - g.at < GC_GRACE_MS), ...newlyObsolete];

  const { details: _d, library: _l, experiments: _e, ...topMeta } = next;
  const nextRoot: ShardedRoot = { ...topMeta, sharded: 1, seq: nextSeq, shards: nextShards, ...(pendingGc.length ? { gc: pendingGc } : {}) };
  const rootJson = JSON.stringify(nextRoot);
  const rootBytes = Buffer.byteLength(rootJson);
  if (rootBytes > LIMIT) {
    return { error: `RSI 状态超过宿主 1 MiB 上限（${rootBytes} 字节，上限 ${LIMIT} 字节），这次的改动没有保存。`, status: 507 };
  }
  for (const [, entry] of staged) {
    if (entry.bytes > LIMIT) {
      return { error: `RSI 状态超过宿主 1 MiB 上限（${entry.bytes} 字节，上限 ${LIMIT} 字节），这次的改动没有保存。`, status: 507 };
    }
  }

  await assertCurrent();
  const written: string[] = [];
  for (const [sk, entry] of staged) {
    const res = await storage.compareAndSet(sk, null, entry.value);
    if (!res.applied) {
      await deleteBestEffort(storage, written);
      return { error: 'RSI state changed, please retry', status: 409 };
    }
    written.push(sk);
  }

  const committed = await storage.compareAndSet(key, expectedRevision, nextRoot);
  if (!committed.applied) {
    await deleteBestEffort(storage, written);
    return { error: 'RSI state changed, please retry', status: 409 };
  }

  // Keep shard cache warm with JSON-roundtripped values so the next read avoids re-fetching staged shards.
  const nextShardsMap = new Map<string, unknown>();
  const nextShardJson = new Map<string, string>();
  let complete = true;
  for (const k of kept) {
    const s = staged.get(k);
    if (s) {
      nextShardsMap.set(k, JSON.parse(s.json));
      nextShardJson.set(k, s.json);
    } else if (prevShardsMap?.has(k)) {
      const v = prevShardsMap.get(k);
      nextShardsMap.set(k, v);
      nextShardJson.set(k, prevJson?.get(k) ?? JSON.stringify(v));
    } else {
      complete = false;
      break;
    }
  }
  if (complete) {
    const parsedRoot = JSON.parse(rootJson) as ShardedRoot;
    const rev = typeof committed.revision === 'number' ? committed.revision : -1;
    cacheFor(storage).set(key, buildShardedState(parsedRoot, nextShardsMap, nextShardJson, rev));
  }

  if (expiredGc.length) await deleteBestEffort(storage, expiredGc);
  return { ok: true };
}

export async function load(storage: RsiStorage, key: string, assertCurrent: () => Promise<void>, options?: { readonly?: boolean }) {
  let current = await readState(storage, key, options);
  if (!current) {
    const seeded = seedState();
    compact(seeded);
    await commitSharded(storage, key, null, seeded, undefined, undefined, undefined, assertCurrent);
    current = await readState(storage, key, options);
  }
  return current;
}

export async function update(storage: RsiStorage, key: string, change: (state: RsiState) => Data, assertCurrent = async () => {}) {
  const current = await readState(storage, key, { readonly: true });
  if (!current || !isState(current.value)) return { error: 'Invalid RSI data', status: 500 };
  const next = structuredClone(current.value), result = change(next);
  if (result.error) return result;
  compact(next);
  const saved = await commitSharded(storage, key, current.revision, next, current.root, current.shards, current.shardJson, assertCurrent);
  return 'error' in saved ? saved : result;
}

export async function retain(storage: RsiStorage, key: string, change: (state: RsiState) => void) {
  for (;;) {
    const result = await update(storage, key, (state) => { change(state); return { ok: true }; });
    if (result.status !== 409) {
      if (result.error) throw new Error(result.error);
      return;
    }
  }
}
