import { seedState } from './fixtures.js';
import { viewModel } from './views.js';
import { act } from './actions.js';
import type { OwnerContext, RsiState, RsiStorage } from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isState(value: unknown): value is RsiState {
  return isRecord(value) && Array.isArray(value.projects) && isRecord(value.objectives)
    && isRecord(value.experiments) && isRecord(value.details) && Array.isArray(value.outbox);
}

export function ownerKey(userId: string) {
  return `rsi:${Buffer.from(userId).toString('base64url')}`;
}

export function json(status: number, payload: unknown) {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify(payload ?? null) };
}

export function createRsi(storage: RsiStorage) {
  async function handle(input: unknown, context: OwnerContext | undefined, method: 'GET' | 'POST') {
    if (context?.kind !== 'owner-http-request') return json(403, { error: 'Owner request required' });
    if (!isRecord(input) || !isRecord(input.request)) return json(400, { error: 'Invalid request' });
    if (input.request.method !== method) return json(405, { error: 'Invalid method' });
    if (context.operation !== (method === 'GET' ? 'read' : 'write')) return json(403, { error: 'Invalid owner operation' });
    if (input.request.query !== undefined && !isRecord(input.request.query)) return json(400, { error: 'Invalid query' });
    if (method === 'POST' && (!isRecord(input.request.body) || typeof input.request.body.op !== 'string')) return json(400, { error: 'Invalid operation' });
    await context.assertCurrent();
    const key = ownerKey(context.userId), query = input.request.query || {};
    let current = await storage.get(key);
    if (!current) {
      await context.assertCurrent();
      await storage.compareAndSet(key, null, seedState());
      current = await storage.get(key);
      if (!current) return json(409, { error: 'RSI state changed, please retry' });
    }
    if (!isState(current.value)) return json(500, { error: 'Invalid RSI data' });
    if (method === 'GET') {
      if (typeof query.view !== 'string') return json(400, { error: 'Provide a view' });
      if (query.project && !current.value.projects.some((p) => p.id === query.project)) return json(404, { error: 'Project not found' });
      const result = viewModel(current.value, query.view, query);
      return result === undefined ? json(400, { error: 'Unknown view' }) : json(200, result);
    }
    const next = structuredClone(current.value), body = input.request.body as Record<string, unknown>;
    const result = act(next, body, query, Date.now());
    if (result.error) {
      const { status = 400, ...payload } = result;
      return json(status, payload);
    }
    await context.assertCurrent();
    const write = await storage.compareAndSet(key, current.revision, next);
    return write.applied ? json(200, result) : json(409, { error: 'RSI state changed, please retry' });
  }
  return {
    view: (input: unknown, context?: OwnerContext) => handle(input, context, 'GET'),
    act: (input: unknown, context?: OwnerContext) => handle(input, context, 'POST'),
  };
}
