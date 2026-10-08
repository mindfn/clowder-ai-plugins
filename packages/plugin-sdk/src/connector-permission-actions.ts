import type { PluginStorageHost } from './module-host.js';
import { createConnectorPermissionStore } from './connector-permissions.js';

/** The Host's existing owner-local operation carries merged stored config in
 * params.input. This wrapper selects the protocol envelope; the closed helper
 * still rejects malformed snapshots and never trusts an input owner claim. */
export function createConnectorPermissionActions(storage: PluginStorageHost) {
  const store = createConnectorPermissionStore(storage);
  return {
    'permissions.importLegacy': async (params: unknown) => {
      if (params === null || typeof params !== 'object' || Array.isArray(params)) throw new TypeError('permission action requires input');
      const input = (params as Record<string, unknown>).input;
      if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('permission action requires input');
      const source = input as Record<string, unknown>;
      return store.importLegacy({ protocolVersion: source.protocolVersion, sourceDigest: source.sourceDigest, snapshot: source.snapshot });
    },
  };
}
