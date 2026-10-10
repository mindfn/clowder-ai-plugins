import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { CommunityRequestContext } from './business/routes/community-request-context.js';
import { memoryStorage } from '../test/memory-storage.js';

test('request storage rejects writes after native invocation loss or module stop', async t => {
  const app = Fastify(); t.after(() => app.close());
  const context = new CommunityRequestContext(app);
  const backing = memoryStorage();
  const storage = context.mutationStorage(backing);
  let current = true;
  app.post('/write', async () => {
    await storage.get('record');
    current = false;
    await storage.compareAndSet('record', null, 'should not persist');
  });
  app.post('/stop', async () => {
    context.stop();
    await storage.set('late', 'should not persist');
  });
  const caller = { catId: 'cat', threadId: 'thread', userId: 'owner', invocationId: 'inv', assertCurrent: async () => { if (!current) throw new Error('stale'); } };
  assert.equal((await context.injectNative(caller, { method: 'POST', url: '/write' })).statusCode, 500);
  assert.deepEqual(await backing.list(), {});
  await backing.set('kept', 'value');
  await assert.rejects(storage.delete('kept'), /Authenticated/);
  assert.equal((await context.injectOwner({ kind: 'owner', id: 'owner' }, { method: 'POST', url: '/stop' })).statusCode, 500);
  assert.equal(await backing.get('late'), undefined);
  await assert.rejects(async () => context.injectOwner({ kind: 'owner', id: 'owner' }, { method: 'POST', url: '/stop' }), /stopped/);
});

test('request identity comes from Host context, never copied headers or business fields', async () => {
  const app = Fastify(); const context = new CommunityRequestContext(app);
  app.get('/who', async request => ({ user: context.userId(request), cat: context.caller()?.catId ?? null }));
  const anonymous = await app.inject({ url: '/who', headers: { 'x-cat-cafe-user': 'forged', 'x-callback-token': 'fake' } });
  assert.deepEqual(anonymous.json(), { user: null, cat: null });
  const owner = await context.injectOwner({ kind: 'owner', id: 'real-owner' }, { url: '/who', headers: { 'X-Community-Local-Request': 'forged' } });
  assert.deepEqual(owner.json(), { user: 'real-owner', cat: null });
  await app.close();
});

test('concurrent native requests keep separate authenticated identities and recheck liveness', async () => {
  const app = Fastify(); const context = new CommunityRequestContext(app); let checks = 0;
  app.get('/who', async request => {
    await new Promise(resolve => setTimeout(resolve, 5));
    await context.assertCurrent();
    return { user: context.userId(request), cat: context.caller()?.catId };
  });
  const caller = (catId: string) => ({ catId, threadId: 'thread', userId: 'owner-'+catId, invocationId: 'inv-'+catId, assertCurrent: async () => { checks++; } });
  const responses = await Promise.all(['a','b'].map(cat => context.injectNative(caller(cat), { url: '/who' })));
  assert.deepEqual(responses.map(r=>r.json()), [{ user: 'owner-a', cat: 'a' }, { user: 'owner-b', cat: 'b' }]);
  assert.equal(checks, 4);
  await assert.rejects(context.injectNative({ ...caller('a'), assertCurrent: async () => { throw new Error('stale'); } }, { url: '/who' }), /stale/);
  assert.equal(context.caller(), null);
  await app.close();
});
