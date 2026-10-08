import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const factories = { feishu: 'createFeishuPluginModule', dingtalk: 'createDingTalkPluginModule',
  telegram: 'createTelegramPluginModule', 'wecom-agent': 'createWeComAgentPluginModule',
  'wecom-bot': 'createWeComBotPluginModule', weixin: 'createWeixinPluginModule', xiaoyi: 'createXiaoyiPluginModule' };
const canonical = value => value && typeof value === 'object' && !Array.isArray(value)
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  : JSON.stringify(value);

// The optional roots select physically extracted archives outside the checkout.
// Provider transport and Host ports remain substituted in both modes: packed
// execution proves closure, not production provider/Host installation acceptance.
const packedRoots = process.env.CLOWDER_CONNECTOR_PACKED_ROOTS === undefined
  ? undefined : JSON.parse(process.env.CLOWDER_CONNECTOR_PACKED_ROOTS);
if (packedRoots !== undefined) assert.deepEqual(Object.keys(packedRoots).sort(), Object.keys(factories).sort());
for (const [name, factoryName] of Object.entries(factories)) {
  test(`${name} ${packedRoots ? 'packed' : 'source'} entrypoint intercepts commands and preserves permission authority`, async () => {
    const packageRoot = packedRoots?.[name];
    const entry = await import(packageRoot === undefined
      ? `../packages/connector-${name}/src/plugin-entrypoint.ts`
      : pathToFileURL(join(packageRoot, 'dist/plugin-entrypoint.js')).href);
    const manifest = parse(await readFile(packageRoot === undefined
      ? new URL(`../packages/connector-${name}/plugin.yaml`, import.meta.url)
      : join(packageRoot, 'plugin.yaml'), 'utf8'));
    if (packageRoot !== undefined) {
      const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
      const sdk = JSON.parse(await readFile(join(packageRoot, 'node_modules/@clowder-ai/plugin-sdk/package.json'), 'utf8'));
      assert.equal(pkg.version, '0.1.0-alpha.3'); assert.equal(manifest.version, pkg.version);
      assert.equal(pkg.dependencies['@clowder-ai/plugin-sdk'], '0.2.0-beta.13');
      assert.equal(sdk.version, '0.2.0-beta.13');
    }
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
    let delayedPermissionRead;
    const outbound = { async sendFormattedReply(chat, envelope, metadata) { replies.push({ chat, body: envelope.body, metadata }); },
      async sendReply(chat, body) { replies.push({ chat, body }); },
      async onDeliveryBatchDone(chat, done) { closes.push({ chat, done }); } };
    const entrypoint = entry[factoryName](options => { inbound = options.host.deliver;
      return { outbound, async start() {}, async stop() {} }; });
    const summary = id => ({ id, title: 'Bound', createdAt: 1, lastActiveAt: 1, preferredCats: [], featureRefs: [] });
    const threads = new Map([['bound', { ...summary('bound'), featureRefs: ['F202'] }]]);
    for (let i = 0; i < 50; i++) threads.set(`recent-${i}`, { ...summary(`recent-${i}`), lastActiveAt: 100 + i });
    threads.set('old-far', { ...summary('old-far'), title: 'Older thread 51', lastActiveAt: 0, featureRefs: ['F999'] });
    const bindings = new Map([['chat', 'bound']]);
    const cat = { catId: 'cat-eqdvbcxw', displayName: '砚砚', aliases: ['@sol'] };
    const host = {
      config: { get: async key => ({ connectionMode: 'webhook', appKey: 'app', corpId: 'corp', agentId: 'agent',
        botId: 'bot', accessKey: 'access' })[key] }, secrets: { get: async () => 'secret' },
      storage: { get: async key => key === 'connector.permissions.v1' && delayedPermissionRead !== undefined
        ? delayedPermissionRead() : state.get(key), list: async () => Object.fromEntries(state),
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
        list: async ({ limit = 50, before } = {}) => [...threads.values()]
          .sort((a, b) => b.lastActiveAt - a.lastActiveAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .filter(row => before === undefined || row.lastActiveAt < before.lastActiveAt ||
            (row.lastActiveAt === before.lastActiveAt && row.id > before.id)).slice(0, limit),
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
      assert.equal((await active.actions['permissions.importLegacy']({ input: { protocolVersion: 1,
        sourceDigest: receipt.data.sourceDigest, snapshot } })).data.status, 'already_applied');
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
      await inbound(input('/use F999', 'far-inventory'));
      assert.equal(bindings.get('chat'), 'old-far', 'actual entrypoint selects beyond the first 50 inventory rows');
      await inbound(input('/use F202', 'restore-far-inventory'));
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
      if (name === 'xiaoyi') assert.equal(closes.length, replies.length - 2,
        'only two explicit bodies remain unsettled');
      assert.equal(JSON.stringify(state.get('connector.permissions.v1')).includes('never-store'), false);
      const persisted = structuredClone(state.get('connector.permissions.v1'));
      const beforeStop = sent.length;
      const repliesBeforeStop = replies.length;
      let enterRead, finishRead;
      const entered = new Promise(resolve => { enterRead = resolve; });
      const lateReceipt = new Promise(resolve => { finishRead = resolve; });
      delayedPermissionRead = () => { enterRead(); return lateReceipt; };
      const inFlight = inbound(input('/where', 'in-flight-before-stop'));
      await entered;
      await active.stop();
      finishRead(persisted);
      await assert.rejects(inFlight, /revoked/i, 'late Host permission receipt cannot cross the revoked carrier');
      delayedPermissionRead = undefined;
      await assert.rejects(inbound(input('/where', 'late-after-stop')));
      assert.equal(sent.length, beforeStop, 'stopped carrier cannot deliver late command events');
      assert.equal(replies.length, repliesBeforeStop, 'in-flight command cannot reply success after stop');
      assert.deepEqual(state.get('connector.permissions.v1'), persisted, 'stop preserves owner permission state');
      state.clear(); // isolated fixture only: start a separate fresh-owner journey.
      const fresh = await entrypoint.create(manifest).start(host);
      try {
        const empty = await fresh.actions['permissions.read']({});
        assert.equal(empty.data.status, 'uninitialized'); assert.equal(state.size, 0);
        await fresh.actions['permissions.configure']({ input: empty.targetValues });
        const configured = await fresh.actions['permissions.read']({});
        assert.equal(configured.data.status, 'configured');
        assert.equal(configured.targetValues.permissionAdminIdsJson, '[]');
        assert.equal((await fresh.actions['permissions.importLegacy']({ input: { protocolVersion: 1,
          sourceDigest: receipt.data.sourceDigest, snapshot } })).data.status, 'preserved_existing');
      } finally { await fresh.stop(); }
    } finally { await active.stop(); }
  });
}
