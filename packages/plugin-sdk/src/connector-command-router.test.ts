import assert from 'node:assert/strict';
import test from 'node:test';
import { routeConnectorCommand, createConnectorCommandRouter, executeConnectorPermissionCommand } from './connector-command-router.js';
import { decodeLegacyConnectorPermissions } from './connector-permissions.js';

const policy = decodeLegacyConnectorPermissions({ config: {
  whitelistEnabled: 'true', commandAdminOnly: 'true', adminOpenIds: '["admin"]',
}, groups: { allowed: '{"addedAt":10}' } });
const direct = { chatId: 'direct', providerMessageId: 'event-1', group: false, senderId: 'admin', text: '/where' };
function fixture() {
  const calls: string[] = [];
  return { calls, ports: {
    async getPermissions() { calls.push('permissions'); return policy; },
    async execute(command: { name: string }) { calls.push(`execute:${command.name}`); return { response: 'reply' }; },
    async reply(_chatId: string, text: string) { calls.push(`reply:${text}`); },
    async audit(_input: unknown, _response: string) { calls.push('audit'); },
    async forward(_input: unknown, _body: unknown) { calls.push('forward'); },
    async settle(_input: unknown) { calls.push('settle'); },
  } };
}
test('every recognized slash is intercepted; only command body forwarding is opt-in', async () => {
  for (const name of ['where', 'new', 'threads', 'use', 'thread', 'commands', 'cats', 'status', 'history', 'unbind', 'allow-group', 'deny-group', 'focus', 'ask']) {
    const { calls, ports } = fixture();
    assert.equal(await routeConnectorCommand({ ...direct, text: `/${name}` }, ports), 'command');
    assert.deepEqual(calls, ['permissions', `execute:${name}`, 'reply:reply', 'audit', 'settle']);
  }
});
test('ordinary messages and unknown commands pass through only after permission checks', async () => {
  for (const text of ['hello', '/unknown']) {
    const { calls, ports } = fixture();
    assert.equal(await routeConnectorCommand({ ...direct, text }, ports), 'message');
    assert.deepEqual(calls, ['permissions']);
  }
});
test('denied group has zero command/audit/forward effects', async () => {
  const { calls, ports } = fixture();
  assert.equal(await routeConnectorCommand({ ...direct, chatId: 'blocked', group: true }, ports), 'blocked');
  assert.deepEqual(calls, ['permissions', 'reply:🔒 此群未在白名单中，请联系管理员。', 'settle']);
});
test('missing sender cannot bypass admin-only guard in an allowed group', async () => {
  const { calls, ports } = fixture();
  assert.equal(await routeConnectorCommand({ text: '/where', providerMessageId: 'event-1', chatId: 'allowed', group: true }, ports), 'blocked');
  assert.equal(calls.some(call => call.startsWith('execute:')), false);
});

test('provider replay is fenced before concurrent command mutation and permission side effects', async () => {
  const { calls, ports } = fixture();
  const route = createConnectorCommandRouter(ports);
  const results = await Promise.all([route({ ...direct, text: '/new' }), route({ ...direct, text: '/new' })]);
  assert.deepEqual(results.sort(), ['command', 'duplicate']);
  assert.equal(calls.filter(call => call === 'execute:new').length, 1);
  assert.equal(calls.filter(call => call === 'settle').length, 1);
});
test('permission initialization failure does not consume the provider event before an owner import', async () => {
  const { calls, ports } = fixture(); let ready = false;
  ports.getPermissions = async () => { if (!ready) throw new Error('not initialized'); return policy; };
  const route = createConnectorCommandRouter(ports);
  await assert.rejects(route(direct), /not initialized/);
  ready = true;
  assert.equal(await route(direct), 'command');
  assert.equal(calls.filter(value => value === 'execute:where').length, 1);
});
test('runtime dedup is bounded, chat-specific and rejects absent provider event identity', async () => {
  const { calls, ports } = fixture();
  const route = createConnectorCommandRouter(ports, 2);
  await route(direct);
  await route({ ...direct, chatId: 'second' });
  assert.equal(await route({ ...direct, providerMessageId: 'event-2' }), 'command');
  assert.equal(await route(direct), 'command', 'oldest entry is evicted at the existing runtime bound');
  const before = calls.length;
  await assert.rejects(route({ ...direct, providerMessageId: '' }), /event identity/);
  assert.equal(calls.length, before);
});
test('a command handler failure never becomes ordinary ingress', async () => {
  const { calls, ports } = fixture();
  ports.execute = async () => { throw new Error('unavailable'); };
  await assert.rejects(routeConnectorCommand(direct, ports), /unavailable/);
  assert.deepEqual(calls, ['permissions']);
});
test('invalid provider facts and unexpected forwarding fail without reply, audit or ordinary delivery', async () => {
  const { calls, ports } = fixture();
  await assert.rejects(routeConnectorCommand({ ...direct, group: undefined as unknown as boolean }, ports), /provider/);
  assert.deepEqual(calls, []);
  ports.execute = async () => ({ response: 'reply', forward: { threadId: 'thread', text: 'injected body' } });
  await assert.rejects(routeConnectorCommand(direct, ports), /only ask\/thread/);
  assert.deepEqual(calls, ['permissions']);
});
test('ask/thread explicit body is forwarded only after provider reply and quiet audit', async () => {
  const { calls, ports } = fixture();
  ports.execute = async () => ({ response: 'reply', forward: { text: 'body', threadId: 'thread', catId: 'cat-eqdvbcxw' } });
  assert.equal(await routeConnectorCommand({ ...direct, text: '/ask sol body' }, ports), 'command');
  assert.deepEqual(calls, ['permissions', 'reply:reply', 'audit', 'forward']);
});
test('allow/deny-group enforce admin identity even in a direct conversation', async () => {
  let effects = 0;
  const store = { async allowGroup() { effects++; return { allowedGroups: [] }; }, async denyGroup() { effects++; return false; } };
  for (const name of ['allow-group', 'deny-group'] as const) {
    for (const senderId of [undefined, 'guest']) {
      const result = await executeConnectorPermissionCommand({ name, args: '' }, { chatId: 'direct', senderId }, policy, store);
      assert.match(result.response, /仅管理员/);
    }
  }
  assert.equal(effects, 0);
});
test('admin allow/deny use the explicit chat or current chat and return truthful mutation results', async () => {
  const calls: string[] = [];
  const store = { async allowGroup(id: string) { calls.push(`allow:${id}`); return { allowedGroups: [{ externalChatId: id }] }; }, async denyGroup(id: string) { calls.push(`deny:${id}`); return false; } };
  await executeConnectorPermissionCommand({ name: 'allow-group', args: 'target' }, direct, policy, store);
  const denied = await executeConnectorPermissionCommand({ name: 'deny-group', args: '' }, direct, policy, store);
  assert.deepEqual(calls, ['allow:target', 'deny:direct']);
  assert.match(denied.response, /不在白名单/);
});
