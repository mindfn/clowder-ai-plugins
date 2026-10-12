import {
  assertPluginSourceFact, assertPluginSourceFactsReadInput, assertPluginNativeContext,
  type PluginSourceFact, type PluginNativeContext,
} from '@clowder-ai/plugin-contract';
export type { PluginSourceFact, PluginNativeContext, PluginSourceFactsReadInput } from '@clowder-ai/plugin-contract';

/** Host-owned authorization: same-instance owner source or the exact verified native origin only.
 * No Task/receipt/ancestor reads or background fallback are supplied by this slice. */
export interface PluginSourceFactsHost {
  read(input: { readonly messageRef: `message:${string}` }): Promise<PluginSourceFact>;
}
/** Native-only authenticated identity; neither a tool body nor typed-wait source supplies identity. */
export interface PluginNativeContextHost {
  current(): Promise<PluginNativeContext>;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}
export function createSourceFactsClient(host: PluginSourceFactsHost, assertContentAccess: () => void): PluginSourceFactsHost {
  if (!host || typeof host.read !== 'function') throw new TypeError('Host source facts port requires read');
  return Object.freeze({
    async read(input: { readonly messageRef: `message:${string}` }) {
      assertContentAccess();
      assertPluginSourceFactsReadInput(input);
      const result = await host.read(Object.freeze({ messageRef: input.messageRef }));
      assertContentAccess();
      assertPluginSourceFact(result);
      return freeze(structuredClone(result));
    },
  });
}
export function createNativeContextClient(host: PluginNativeContextHost, assertContentAccess: () => void): PluginNativeContextHost {
  if (!host || typeof host.current !== 'function') throw new TypeError('Host native context port requires current');
  return Object.freeze({
    async current(input?: unknown) {
      assertContentAccess();
      if (input !== undefined) throw new TypeError('Native context current accepts no body');
      const result = await host.current();
      assertContentAccess();
      assertPluginNativeContext(result);
      return freeze(structuredClone(result));
    },
  });
}
