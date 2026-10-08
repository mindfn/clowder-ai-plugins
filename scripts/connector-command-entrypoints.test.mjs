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
    const state = new Map(); const replies = []; const sent = []; const closes = []; let inbound;
    const outbound = { async sendFormattedReply(chat, envelope, metadata) { replies.push({ chat, body: envelope.body, metadata }); },
      async sendReply(chat, body) { replies.push({ chat, body }); },
      async onDeliveryBatchDone(chat, done) { closes.push({ chat, done }); } };
    const entrypoint = entry[factoryName](options => { inbound = options.host.deliver;
      return { outbound, async start() {}, async stop() {} }; });
    const summary = id => ({ id, title: 'Bound', createdAt: 1, lastActiveAt: 1, preferredCats: [], featureRefs: [] });
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
      threads: { listBindings: async () => [], findByKey: async () => summary('bound'),
        ensureSystemThread: async () => summary('system'), ensureByKey: async () => summary('bound') },
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
      const snapshot = { config: { whitelistEnabled: 'true', commandAdminOnly: 'true', adminOpenIds: '["admin"]' }, groups: {} };
      const receipt = await active.actions['permissions.importLegacy']({ input: { appSecret: 'never-store', protocolVersion: 1,
        sourceDigest: createHash('sha256').update(canonical(snapshot)).digest('hex'), snapshot } });
      assert.equal(receipt.data.status, 'imported');
      await inbound(input('/where', 'repairable'));
      assert.equal(replies.length, 1); assert.match(replies[0].body, /Bound/);
      assert.equal(sent.length, 1); assert.equal(sent[0].threadId, 'system'); assert.equal(sent[0].wake, undefined);
      await inbound(input('/where', 'repairable'));
      assert.equal(replies.length, 1, 'redelivery does not repeat command');
      if (['feishu', 'dingtalk', 'wecom-bot'].includes(name)) {
        await inbound(input('blocked ordinary', 'blocked-group', true, 'outsider'));
        assert.equal(sent.length, 1, 'unlisted group ordinary ingress is denied');
        await inbound(input('/allow-group', 'allow-group', true));
        assert.equal(state.get('connector.permissions.v1').value.allowedGroups[0].externalChatId, 'chat');
        const auditCount = sent.length;
        await inbound(input('/where', 'denied', true, 'outsider'));
        assert.equal(sent.length, auditCount, 'admin-only group command never wakes or audits');
      }
      if (name === 'xiaoyi') assert.deepEqual(closes, [{ chat: 'chat', done: true }]);
      assert.equal(JSON.stringify(state.get('connector.permissions.v1')).includes('never-store'), false);
    } finally { await active.stop(); }
  });
}
