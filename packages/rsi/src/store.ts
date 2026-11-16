import { seedState } from './fixtures.js';
import type { Data, RsiState, RsiStorage } from './types.js';

export const record = (value: unknown): value is Data => value !== null && typeof value === 'object' && !Array.isArray(value);
export const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
export const isState = (value: unknown): value is RsiState => record(value) && Array.isArray(value.projects)
  && record(value.objectives) && record(value.experiments) && record(value.details) && Array.isArray(value.outbox);
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
