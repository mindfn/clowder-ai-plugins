import { seedState } from './fixtures.js';
import type { Data, RsiState, RsiStorage } from './types.js';

export const record = (value: unknown): value is Data => value !== null && typeof value === 'object' && !Array.isArray(value);
export const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
export const isState = (value: unknown): value is RsiState => record(value) && Array.isArray(value.projects)
  && record(value.objectives) && record(value.experiments) && record(value.details) && Array.isArray(value.outbox);
// An owner's whole state is one storage value, which the Host caps at 1 MB. Run logs keep their tail in the state (the full log is
// written to the run directory), failure texts their head and tail, and a delivered message leaves the outbox.
export const LOG_KEEP = 2000;
export const clip = (value: string) => value.length <= LOG_KEEP ? value : `${value.slice(0, LOG_KEEP / 4)}\n…\n${value.slice(-(LOG_KEEP * 3) / 4)}`;
export function compact(state: RsiState) {
  for (const d of Object.values(state.experiments)) {
    if (typeof d.executor?.probe?.log === 'string') d.executor.probe.log = d.executor.probe.log.slice(-LOG_KEEP);
    if (typeof d.executor?.probe?.error === 'string') d.executor.probe.error = clip(d.executor.probe.error);
    for (const r of d.rounds || []) for (const run of r.runs || []) {
      if (typeof run.log === 'string') run.log = run.log.slice(-LOG_KEEP);
      for (const failure of [run.error, ...(run.attempts || []).map((a: Data) => a.error)]) if (typeof failure?.raw === 'string') failure.raw = clip(failure.raw);
    }
  }
  state.outbox = state.outbox.filter((e) => !(e.sent && e.kind === 'message'));
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
