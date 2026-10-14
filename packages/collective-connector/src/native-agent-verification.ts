import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import type { FeatureContext } from '@clowder-ai/plugin-sdk';
import type { VerifiedAgent } from './business/connector/state.js';

/** Owner scope exists only inside its authenticated action; concurrent/native calls cannot borrow it. */
export function createCollectiveAgentVerification(context: FeatureContext, assertActive: () => void, taskContext?: () => FeatureContext['nativeContext']) {
  const owners = new AsyncLocalStorage<{ readonly agent: VerifiedAgent; readonly assertCurrent: () => Promise<void>; live: boolean }>();
  return Object.freeze({
    withOwner<T>(agent: VerifiedAgent, assertCurrent: () => Promise<void>, run: () => Promise<T>): Promise<T> {
      const owner = { agent: Object.freeze({ ...agent }), assertCurrent, live: true };
      return owners.run(owner, async () => { try { return await run(); } finally { owner.live = false; } });
    },
    async verifyAgent(agent: VerifiedAgent): Promise<boolean> {
      assertActive();
      const owner = owners.getStore();
      if (owner) {
        if (!owner.live) return false;
        await owner.assertCurrent(); assertActive();
        return owner.live && isDeepStrictEqual(agent, owner.agent);
      }
      if (agent.agentId !== agent.catId) return false;
      const task = taskContext?.();
      if (task) {
        try {
          const native = await task.current({includeTask: true});assertActive();
          return native.catId === agent.catId && native.invocationId === agent.sessionRef;
        } catch {assertActive();}
      }
      // The two authenticated source families have different Host read paths.
      // A Task denial cannot become a public success: its private trigger is
      // rejected by the ordinary native source reader.
      if (!context.nativeContext) return false;
      try {
        const native = await context.nativeContext.current(); assertActive();
        return native.catId === agent.catId && native.invocationId === agent.sessionRef;
      } catch {
        assertActive(); return false;
      }
    },
  });
}
