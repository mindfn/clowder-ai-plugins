import { z } from 'zod';
import type { PluginActionHandler } from '@clowder-ai/plugin-sdk';
import type { CollectiveConnector } from './business/connector/connector.js';
import { readCollectiveAccountabilityAttentionSource } from './accountability-attention.js';

/** Dot uses the ordinary authenticated owner operation; source decisions remain here. */
export function createAccountabilityAttentionAction(
  connector: CollectiveConnector,
  assertActive: () => void,
): PluginActionHandler {
  return async (input, native, caller) => {
    if (native || caller?.kind !== 'owner-operation' ||
        caller.operationKey !== 'accountability' || caller.actionId !== 'attention')
      throw new Error('Accountability attention requires its authenticated owner operation');
    z.object({ input: z.object({}).strict() }).strict().parse(input);
    const current = async () => {
      assertActive(); caller.signal.throwIfAborted();
      await caller.assertCurrent();
      assertActive(); caller.signal.throwIfAborted();
    };
    await current();
    const data = await readCollectiveAccountabilityAttentionSource(connector, caller.userId, current);
    await current();
    return { data };
  };
}
