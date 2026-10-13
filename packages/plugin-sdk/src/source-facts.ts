import { projectSourceProgress, type PluginSourceProgressFact } from './source-progress.js';
export type { PluginQueueProgress, PluginSourceProgressFact } from './source-progress.js';
import {
  assertPluginSourceFact, assertPluginSourceFactsReadInput, assertPluginNativeContext,
  type PluginSourceFact, type PluginNativeContext,
} from '@clowder-ai/plugin-contract';
export type { PluginSourceFact, PluginNativeContext, PluginSourceFactsReadInput } from '@clowder-ai/plugin-contract';

/** Host-owned authorization: same-instance owner source or the exact verified native origin only.
 * No Task/receipt/ancestor reads or background fallback are supplied by this slice. */
export interface PluginSourceFactsHost {
  read(input: { readonly messageRef: `message:${string}` }): Promise<PluginSourceFact>;
  /** Authenticated owner-only, content-free Queue display facts; absent on older carriers. */
  readProgress?(input: { readonly messageRef: `message:${string}` }): Promise<PluginSourceProgressFact>;
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
  if (host.readProgress !== undefined && typeof host.readProgress !== 'function') throw new TypeError('Host source facts readProgress must be callable');
  const readProgress = host.readProgress?.bind(host);
  return Object.freeze({
    ...(readProgress === undefined ? {} : { async readProgress(input: { readonly messageRef: `message:${string}` }) {
      assertContentAccess(); assertPluginSourceFactsReadInput(input);
      const result = await readProgress(Object.freeze({ messageRef: input.messageRef }));
      assertContentAccess();
      return freeze(projectSourceProgress(result, input.messageRef));
    } }),
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
