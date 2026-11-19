import { seedState } from './fixtures.js';
import type { Data, RsiState, RsiStorage } from './types.js';

export const record = (value: unknown): value is Data => value !== null && typeof value === 'object' && !Array.isArray(value);
export const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
export const isState = (value: unknown): value is RsiState => record(value) && Array.isArray(value.projects)
  && record(value.objectives) && record(value.experiments) && record(value.details) && Array.isArray(value.outbox);
// An owner's whole state is one storage value, which the Host caps at 1 MiB, and every write is compacted before it is stored. Run logs
// keep their tail in the state (the full log is written to the run directory), a shorter one once the cycle is closed, where an attempt
// also drops the environment and metrics it shares with its run; failure texts keep their head and tail. A report keeps its comparison
// once (its cells are the report's matrix) and a cycle's library note only the outcome. A delivered entry leaves the outbox, except an
// agent request: the turn it started is matched to it until that turn's outcome is applied, for a day at most.
export const LIMIT = 1024 * 1024, LOG_KEEP = 2000, CLOSED_LOG_KEEP = 400, AGENT_KEEP = 24 * 3600_000;
export const clip = (value: string) => value.length <= LOG_KEEP ? value : `${value.slice(0, LOG_KEEP / 4)}\n…\n${value.slice(-(LOG_KEEP * 3) / 4)}`;
// What a cycle's library note keeps of its conclusion: the verdict, the confirmation and each group's mean of the main metric.
export const cycleResult = (verdict: string, compared: Data, confirmation: Data | null) => ({ verdict, metric: compared.metric,
  means: Object.fromEntries(compared.groups.map((g: Data) => [g.group, g.mean])), confirmation: confirmation && { status: confirmation.status, version: confirmation.version } });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function compact(state: RsiState, now = Date.now()) {
  for (const d of Object.values(state.experiments)) {
    if (typeof d.executor?.probe?.log === 'string') d.executor.probe.log = d.executor.probe.log.slice(-LOG_KEEP);
    if (typeof d.executor?.probe?.error === 'string') d.executor.probe.error = clip(d.executor.probe.error);
    for (const r of d.rounds || []) {
      const closed = ['done', 'repaired'].includes(r.state);
      if (r.report?.compare) delete r.report.compare.matrix;
      for (const run of r.runs || []) {
        if (typeof run.log === 'string') run.log = run.log.slice(-(closed ? CLOSED_LOG_KEEP : LOG_KEEP));
        for (const failure of [run.error, ...(run.attempts || []).map((a: Data) => a.error)]) if (typeof failure?.raw === 'string') failure.raw = clip(failure.raw);
        if (closed) for (const a of run.attempts || []) for (const k of ['env', 'metrics']) if (same(a[k], run[k])) delete a[k];
      }
    }
  }
  for (const doc of Object.values(state.library).flat()) if (doc.result?.comparison) doc.result = cycleResult(doc.result.verdict, doc.result.comparison, doc.result.confirmation);
  const answered = (e: Data) => Object.values<Data>(state.experiments[e.objective]?.lifecycle || {}).some((x) => x.applied && x.replyTo === e.messageId);
  state.outbox = state.outbox.filter((e) => !e.sent || e.kind === 'agent' && now - e.sent < AGENT_KEEP && !answered(e));
}

export const ownerKey = (userId: string) => `rsi:${Buffer.from(userId).toString('base64url')}`;

export async function load(storage: RsiStorage, key: string, assertCurrent: () => Promise<void>) {
  let current = await storage.get(key);
  if (!current) {
    await assertCurrent();
    await storage.compareAndSet(key, null, seedState());
    current = await storage.get(key);
  }
  return current;
}

export async function update(storage: RsiStorage, key: string, change: (state: RsiState) => Data, assertCurrent = async () => {}) {
  const current = await storage.get(key);
  if (!current || !isState(current.value)) return { error: 'Invalid RSI data', status: 500 };
  const next = structuredClone(current.value), result = change(next);
  if (result.error) return result;
  compact(next);
  // Still too large for the Host: say so, instead of the storage error the Host would throw.
  const bytes = Buffer.byteLength(JSON.stringify(next));
  if (bytes > LIMIT) return { error: `RSI 状态超过宿主 1 MiB 上限（${bytes} 字节，上限 ${LIMIT} 字节），这次的改动没有保存；删掉不再需要的评估项可以腾出空间。`, status: 507 };
  await assertCurrent();
  return (await storage.compareAndSet(key, current.revision, next)).applied ? result : { error: 'RSI state changed, please retry', status: 409 };
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
