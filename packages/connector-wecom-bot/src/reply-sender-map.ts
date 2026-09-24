import type { FeatureContext } from '@clowder-ai/plugin-sdk';

export interface ReplySender {
  readonly id: string;
  readonly name?: string;
}

interface ReplySenderEntry {
  readonly sender: ReplySender;
  readonly storedAt: number;
}

interface ReplySenderMapState {
  readonly version: 1;
  readonly entries: Record<string, ReplySenderEntry>;
}

const STATE_KEY = 'reply-senders';
const ENTRY_TTL_MS = 24 * 60 * 60 * 1000;
const ENTRY_CAP = 100;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sender(value: unknown): ReplySender | undefined {
  if (!object(value) || typeof value.id !== 'string' || value.id.length === 0) return undefined;
  return {
    id: value.id,
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
  };
}

function state(value: unknown): ReplySenderMapState {
  if (!object(value) || value.version !== 1 || !object(value.entries)) return { version: 1, entries: {} };
  const entries: Record<string, ReplySenderEntry> = {};
  for (const [key, entry] of Object.entries(value.entries)) {
    if (!object(entry) || typeof entry.storedAt !== 'number') continue;
    const resolved = sender(entry.sender);
    if (resolved !== undefined) entries[key] = { sender: resolved, storedAt: entry.storedAt };
  }
  return { version: 1, entries };
}

function prune(entries: Record<string, ReplySenderEntry>, now: number): Record<string, ReplySenderEntry> {
  const live = Object.entries(entries).filter(([, entry]) => now - entry.storedAt < ENTRY_TTL_MS);
  live.sort((a, b) => a[1].storedAt - b[1].storedAt);
  const kept = live.slice(Math.max(0, live.length - (ENTRY_CAP - 1)));
  return Object.fromEntries(kept);
}

export function createReplySenderMap(context: FeatureContext) {
  return {
    async record(hostMessageId: string, replySender: ReplySender): Promise<void> {
      const now = Date.now();
      const stored = state((await context.storage.get(STATE_KEY))?.value);
      await context.storage.set(STATE_KEY, {
        version: 1,
        entries: {
          ...prune(stored.entries, now),
          [hostMessageId]: { sender: replySender, storedAt: now },
        },
      });
    },
    async resolve(hostMessageId: string | undefined): Promise<ReplySender | undefined> {
      if (hostMessageId === undefined) return undefined;
      let stored: ReplySenderMapState;
      try {
        stored = state((await context.storage.get(STATE_KEY))?.value);
      } catch (error) {
        context.log('warn', 'Connector reply-sender mapping lookup failed', {
          errorName: error instanceof Error ? error.name : 'unknown',
        });
        return undefined;
      }
      const entry = stored.entries[hostMessageId];
      if (entry === undefined || Date.now() - entry.storedAt >= ENTRY_TTL_MS) return undefined;
      return entry.sender;
    },
  };
}
