import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnectorPermissionActions } from './connector-permission-actions.js';
import type { PluginStorageHost } from './module-host.js';

// Published Host canonical vector. Raw JSON strings are deliberately not reparsed for hashing.
const input = { protocolVersion: 1,
  sourceDigest: '449c5887711ea90c6c14ff8f26adfeefc2d7f129f2bac9db59259c2915b5cad3',
  snapshot: { config: { whitelistEnabled: 'true', commandAdminOnly: 'false', adminOpenIds: '[]' },
    groups: { chat: '{"label":"Group","addedAt":12}' } } };
function host(): PluginStorageHost {
  const entries = new Map<string, { revision: number; value: unknown }>();
  let revision = 0;
  return {
    async get(key) { return entries.get(key); },
    async list() { return Object.fromEntries(entries); },
    async set(key, value) { const entry = { revision: ++revision, value }; entries.set(key, entry); return entry; },
    async compareAndSet(key, expected, value) {
      if ((entries.get(key)?.revision ?? null) !== expected) return { applied: false };
      const entry = { revision: ++revision, value }; entries.set(key, entry); return { applied: true, revision: entry.revision };
    },
    async delete(key) { return { deleted: entries.delete(key) }; },
  };
}
test('generic operation wrapper extracts only the raw envelope from stored configuration plus input', async () => {
  const storage = host();
  const actions = createConnectorPermissionActions(storage);
  const first = await actions['permissions.importLegacy']({ input: { appSecret: 'never-copy', ...input } });
  assert.equal(first.data.status, 'imported');
  assert.equal(first.data.sourceDigest, input.sourceDigest);
  assert.equal(JSON.stringify(first).includes('never-copy'), false);
  assert.equal(JSON.stringify(await storage.list()).includes('never-copy'), false);
  assert.equal((await actions['permissions.importLegacy']({ input })).data.status, 'already_applied');
});
test('operation wrapper rejects bare or malformed envelopes without initializing state', async () => {
  const storage = host(); const actions = createConnectorPermissionActions(storage);
  for (const params of [input, null, { input: [] }, { input: { ...input, sourceDigest: '0'.repeat(64) } }]) {
    await assert.rejects(actions['permissions.importLegacy'](params));
  }
  assert.deepEqual(await storage.list(), {});
});
