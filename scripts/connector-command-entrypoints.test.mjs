import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { parse } from 'yaml';

const factories = { feishu: 'createFeishuPluginModule', dingtalk: 'createDingTalkPluginModule',
  telegram: 'createTelegramPluginModule', 'wecom-agent': 'createWeComAgentPluginModule',
  'wecom-bot': 'createWeComBotPluginModule', weixin: 'createWeixinPluginModule', xiaoyi: 'createXiaoyiPluginModule' };
const canonical = value => value && typeof value === 'object' && !Array.isArray(value)
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  : JSON.stringify(value);

// Real package module + real SDK carrier; only provider transport and Host ports
// are substituted. This is entrypoint evidence, not final packed acceptance.
for (const [name, factoryName] of Object.entries(factories)) {
  test(`${name} actual entrypoint intercepts commands and preserves permission authority`, async () => {
    const entry = await import(`../packages/connector-${name}/src/plugin-entrypoint.ts`);
    const manifest = parse(await readFile(new URL(`../packages/connector-${name}/plugin.yaml`, import.meta.url), 'utf8'));
    const targets = ['permissionWhitelistEnabled', 'permissionCommandAdminOnly', 'permissionAdminIdsJson', 'permissionGroupsJson', 'permissionRevision'];
    const settings = manifest.configuration.find(field => field.key === 'connector_permissions');
    assert.equal(settings.kind, 'operation'); assert.equal(settings.hidden, undefined);
    assert.deepEqual(settings.target, targets);
    assert.deepEqual(settings.actions.map(action => [action.id, action.action.method]), [['read', 'permissions.read']]);
    const apply = manifest.configuration.find(field => field.key === 'connector_permissions_apply');
    assert.equal(apply.kind, 'operation'); assert.equal(apply.hidden, undefined);
    assert.deepEqual(apply.target, targets);
    assert.deepEqual(apply.actions.map(action => [action.id, action.action.method]), [['configure', 'permissions.configure']]);
    assert.ok(apply.actions[0].confirm, 'mutation requires owner confirmation while read remains independently reachable');
    const fields = manifest.configuration.filter(field => targets.includes(field.key));
    assert.deepEqual(fields.map(field => field.key), targets);
    assert.deepEqual(fields.map(field => field.kind), ['select', 'select', 'string', 'string', 'string']);
    assert.ok(fields.every(field => field.default === undefined));
    assert.ok(fields.slice(0, 4).every(field => field.hidden === undefined));
    assert.equal(fields[4].hidden, true, 'only optimistic revision token is an internal form field');
    const state = new Map(); const replies = []; const sent = []; const closes = []; let inbound;
    const outbound = { async sendFormattedReply(chat, envelope, metadata) { replies.push({ chat, body: envelope.body, metadata }); },
      async sendReply(chat, body) { replies.push({ chat, body }); },
      async onDeliveryBatchDone(chat, done) { closes.push({ chat, done }); } };
    const entrypoint = entry[factoryName](options => { inbound = options.host.deliver;
      return { outbound, async start() {}, async stop() {} }; });
    const summary = id => ({ id, title: 'Bound', createdAt: 1, lastActiveAt: 1, preferredCats: [], featureRefs: [] });
    const threads = new Map([['bound', { ...summary('bound'), featureRefs: ['F202'] }]]);
    const bindings = new Map([['chat', 'bound']]);
    const cat = { catId: 'cat-eqdvbcxw', displayName: '砚砚', aliases: ['@sol'] };
    const host = {
      config: { get: async key => ({ connectionMode: 'webhook', appKey: 'app', corpId: 'corp', agentId: 'agent',
        botId: 'bot', accessKey: 'access' })[key] }, secrets: { get: async () => 'secret' },
      storage: { get: async key => state.get(key), list: async () => Object.fromEntries(state),
        compareAndSet: async (key, expected, value) => {
          const current = state.get(key);
          if ((current?.revision ?? null) !== expected) return { applied: false, revision: current?.revision };
          const revision = (current?.revision ?? 0) + 1; state.set(key, { revision, value }); return { applied: true, revision };
        }, set: async (key, value) => { const revision = (state.get(key)?.revision ?? 0) + 1;
          state.set(key, { revision, value }); return { revision }; }, delete: async key => ({ deleted: state.delete(key) }) },
      threads: {
        listBindings: async () => [...bindings].map(([key, threadId]) => ({ key, threadId, createdAt: 1 })),
        findByKey: async key => threads.get(bindings.get(key)) ?? null,
        get: async id => threads.get(id) ?? null,
        list: async () => [...threads.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt),
        create: async ({ title }) => { const thread = { ...summary(`new-${threads.size}`), title, lastActiveAt: 2 };
          threads.set(thread.id, thread); return thread; },
        bind: async (key, threadId) => { bindings.set(key, threadId); return { key, threadId, createdAt: 1 }; },
        unbind: async key => bindings.delete(key),
        update: async (id, patch) => { const thread = { ...threads.get(id), ...patch }; threads.set(id, thread); return thread; },
        getCats: async () => ({ participants: [{ ...cat, lastMessageAt: 1, messageCount: 1 }],
          routableNow: [cat], routableNotJoined: [], notRoutable: [] }),
        readMessages: async () => [{ id: 'owner-message', timestamp: 1, sender: { kind: 'owner' }, content: '真实历史问题' },
          { id: 'cat-message', timestamp: 2, sender: { kind: 'cat', catId: cat.catId }, content: '真实历史回答' }],
        ensureSystemThread: async () => summary('system'), ensureByKey: async () => summary('bound'),
      },
      messaging: { subscribe: async () => {}, unsubscribe: async () => {}, send: async input => {
        sent.push(input); return { messageId: `m-${sent.length}`, threadId: input.threadId }; } }, log() {},
    };
    const active = await entrypoint.create(manifest).start(host);
    const input = (text, id, group = false, sender = 'admin') => ({ externalConversationId: 'chat',
      externalSenderId: sender, providerConversationId: 'provider-chat', providerMessageId: id, text,
      chatType: group ? 'group' : 'p2p', conversation: { type: group ? 'group' : 'direct' }, sender: { id: sender } });
    try {
      await assert.rejects(inbound(input('/where', 'repairable')), /permission.*initializ/i);
      assert.equal(sent.length, 0, 'uninitialized policy cannot deliver or audit');
      assert.equal((await active.actions['permissions.read']({})).data.status, 'uninitialized');
      assert.equal(state.size, 0, 'reading owner form never initializes permission state');
      const snapshot = { config: { whitelistEnabled: 'true', commandAdminOnly: 'true', adminOpenIds: '["admin"]' }, groups: {} };
      const receipt = await active.actions['permissions.importLegacy']({ input: { appSecret: 'never-store', protocolVersion: 1,
        sourceDigest: createHash('sha256').update(canonical(snapshot)).digest('hex'), snapshot } });
      assert.equal(receipt.data.status, 'imported');
      const form = await active.actions['permissions.read']({});
      assert.equal(form.targetValues.permissionAdminIdsJson, '["admin"]');
      const updated = await active.actions['permissions.configure']({ input: { ...form.targetValues, appSecret: 'never-store' } });
      assert.equal(updated.data.status, 'configured');
      const repeated = await active.actions['permissions.importLegacy']({ input: { protocolVersion: 1,
        sourceDigest: receipt.data.sourceDigest, snapshot } });
      assert.equal(repeated.data.status, 'preserved_existing');
      await inbound(input('/where', 'repairable'));
      assert.equal(replies.length, 1); assert.match(replies[0].body, /Bound/);
      assert.equal(sent.length, 1); assert.equal(sent[0].threadId, 'system'); assert.equal(sent[0].wake, undefined);
      await inbound(input('/where', 'repairable'));
      assert.equal(replies.length, 1, 'redelivery does not repeat command');
      const commands = ['/commands', '/threads', '/use F202', '/thread bound explicit-thread-body', '/cats', '/status',
        '/history 1', '/focus sol', '/focus clear', '/ask sol explicit-ask-body', '/new Owner-created', '/where',
        '/unbind', '/allow-group explicit-group', '/deny-group explicit-group'];
      const seenCommands = new Set(['/where']);
      for (const [index, text] of commands.entries()) {
        const previousReplies = replies.length;
        await inbound(input(text, `command-${index}`));
        seenCommands.add(text.split(' ')[0]);
        assert.equal(replies.length, previousReplies + 1, `${text} must reply once through provider adapter`);
        if (text === '/focus sol') assert.deepEqual(threads.get('bound').preferredCats, [cat.catId]);
        if (text === '/focus clear') assert.deepEqual(threads.get('bound').preferredCats, []);
        if (text === '/history 1') assert.match(replies.at(-1).body, /真实历史问题/);
        if (text === '/where') assert.match(replies.at(-1).body, /Owner-created/);
        if (text === '/unbind') assert.equal(bindings.has('chat'), false);
        if (text === '/allow-group explicit-group') assert.equal(state.get('connector.permissions.v1').value.allowedGroups[0].externalChatId, 'explicit-group');
        if (text === '/deny-group explicit-group') assert.deepEqual(state.get('connector.permissions.v1').value.allowedGroups, []);
      }
      assert.equal(seenCommands.size, 14);
      const forwarded = sent.filter(send => send.payload.provenance.origin?.kind === 'external');
      assert.equal(forwarded.length, 2, 'only the two explicit bodies invoke an agent');
      assert.deepEqual(forwarded.map(send => send.payload.elements[0].payload.text), ['explicit-thread-body', 'explicit-ask-body']);
      assert.deepEqual(forwarded.map(send => send.wake), ['auto', { catId: cat.catId }]);
      assert.ok(sent.filter(send => !forwarded.includes(send)).every(send => send.threadId === 'system' && send.wake === undefined),
        'all command audit stays quiet in the system thread');
      await inbound(input('/use F202', 'restore-binding'));
      if (['feishu', 'dingtalk', 'wecom-bot'].includes(name)) {
        const beforeDenied = sent.length;
        await inbound(input('blocked ordinary', 'blocked-group', true, 'outsider'));
        assert.equal(sent.length, beforeDenied, 'unlisted group ordinary ingress is denied');
        await inbound(input('/allow-group', 'allow-group', true));
        assert.equal(state.get('connector.permissions.v1').value.allowedGroups[0].externalChatId, 'chat');
        const auditCount = sent.length;
        await inbound(input('/where', 'denied', true, 'outsider'));
        assert.equal(sent.length, auditCount, 'admin-only group command never wakes or audits');
      }
      if (name === 'xiaoyi') assert.equal(closes.length, commands.length,
        'two explicit bodies remain unsettled; initial where and restored binding are settled');
      assert.equal(JSON.stringify(state.get('connector.permissions.v1')).includes('never-store'), false);
    } finally { await active.stop(); }
  });
}
