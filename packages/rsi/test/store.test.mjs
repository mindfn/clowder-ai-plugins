import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixtures } from '../dist/fixtures.js';
import { invalidateProjects, projects, PROJECTS_TTL_MS, threadProject, withLiveProjects } from '../dist/projects.js';
import { GC_GRACE_MS, isOwnerKey, LIMIT, listOwners, load, ownerKey, readState, retain, update } from '../dist/store.js';

const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function memStorage() {
  const entries = new Map();
  let revision = 0;
  const writes = [];
  return {
    entries,
    writes,
    async list() { return Object.fromEntries([...entries].map(([k, v]) => [k, clone(v)])); },
    async get(key) { return clone(entries.get(key)); },
    async compareAndSet(key, expected, value) {
      if (Buffer.byteLength(JSON.stringify(value)) > LIMIT) throw new TypeError(`exceeds ${LIMIT} bytes`);
      if (key.length > 256) throw new TypeError(`key too long: ${key.length}`);
      if ((entries.get(key)?.revision ?? null) !== expected) return { applied: false };
      entries.set(key, { revision: ++revision, value: clone(value) });
      writes.push(key);
      return { applied: true };
    },
    async delete(key) { return { deleted: entries.delete(key) }; },
  };
}

// Stores a legacy state and passes it through one write that compacts and shards it.
async function write(state) {
  const storage = memStorage();
  const key = ownerKey('owner');
  await storage.compareAndSet(key, null, clone(state));
  assert.deepEqual(await update(storage, key, () => ({ ok: true })), { ok: true });
  return (await readState(storage, key)).value;
}

test('every write takes delivered entries out of the outbox; an agent request stays until the turn it started is accounted for, a day at most', async () => {
  const state = createFixtures(1800000000000).state, now = Date.now(), entry = (id, kind, extra = {}) => ({ id, kind, objective: 'cp-converge', ...extra });
  state.experiments['cp-converge'].lifecycle = { ended: { replyTo: 'm-ended', outcome: 'completed', applied: true }, running: { replyTo: 'm-running' } };
  state.outbox = [entry('thread', 'createThread', { sent: now }), entry('run', 'run', { sent: now }), entry('executor', 'executor', { sent: now }),
    entry('schedule', 'schedule', { sent: now }), entry('message', 'message', { sent: now }), entry('queued', 'run'),
    entry('ended', 'agent', { section: 'goal', sent: now, messageId: 'm-ended' }),
    entry('running', 'agent', { section: 'scope', sent: now, messageId: 'm-running' }),
    // Handed over in a turn that has not ended: it wakes its member once if the step is still open then.
    entry('handed', 'agent', { section: 'rules', sent: now, messageId: 'm-handed', inTurn: 'turn' }),
    entry('old', 'agent', { section: 'design', sent: now - 25 * 3600_000, messageId: 'm-old' })];
  assert.deepEqual((await write(state)).outbox.map((e) => e.id), ['queued', 'running', 'handed']);
});

test('every write slims what earlier versions stored: a report keeps its comparison once, a cycle note its outcome, a closed cycle short logs and attempts without the run’s data', async () => {
  const state = createFixtures(1800000000000).state, d = state.experiments['cp-converge'], env = { seed: 1, commit: 'abc1234', hw: 'cpu' };
  const run = (log) => ({ id: 'run', group: 'control', seed: 1, state: 'done', env, metrics: { score: 1 }, log, error: null, attempts: [{ start: 1, end: 2, env, metrics: { score: 1 }, error: null, jobId: null }] });
  const cells = [{ group: 'control', metric: 'score', mean: 1, n: 1, seeds: [{ seed: 1, value: 1, state: 'done', error: null }] }, { group: 'change', metric: 'score', mean: 2, n: 1, seeds: [{ seed: 1, value: 2, state: 'done', error: null }] }];
  const compared = { cycle: 1, against: 'control', metric: 'score', dir: 'up', comparable: true, matrix: cells,
    groups: [{ group: 'control', version: 'v1', control: true, mean: 1, delta: 0, eligible: true, guardrails: [], beatsControl: false }, { group: 'change', version: 'v2', control: false, mean: 2, delta: 1, eligible: true, guardrails: [], beatsControl: true }] };
  d.rounds = [{ n: 1, state: 'done', runs: [run('x'.repeat(3000))], report: { verdict: 'keep', matrix: cells, compare: { ...compared, note: 'same cycle' } } },
    { n: 2, state: 'evaluating', runs: [run('y'.repeat(3000))], report: null }];
  state.library.cartpole.push({ id: 'cp-converge-cycle-1', kind: 'feedback', cycle: 1, objectives: ['cp-converge'],
    result: { verdict: 'keep', comparison: compared, confirmation: { status: 'candidate', group: 'change', version: 'v2', cycle: 1 } } });
  const after = await write(state), [closed, open] = after.experiments['cp-converge'].rounds;
  assert.deepEqual(closed.report.matrix, cells);
  assert.deepEqual(closed.report.compare, { cycle: 1, against: 'control', metric: 'score', dir: 'up', comparable: true, groups: compared.groups, note: 'same cycle' });
  assert.equal(closed.runs[0].log, 'x'.repeat(400));
  assert.deepEqual(closed.runs[0].attempts, [{ start: 1, end: 2, error: null, jobId: null }]);
  // An open cycle keeps everything: its evaluator reads it, and a retry would replace the run's environment.
  assert.equal(open.runs[0].log.length, 2000); assert.deepEqual(open.runs[0].attempts[0].env, env);
  assert.deepEqual(after.library.cartpole.at(-1).result, { verdict: 'keep', metric: 'score', means: { control: 1, change: 2 }, confirmation: { status: 'candidate', version: 'v2' } });
});

test('sharded storage holds > 1.5 MiB across multiple experiments and closed rounds without hitting 1 MiB per key', async () => {
  const storage = memStorage();
  const key = ownerKey('heavy-owner');
  await load(storage, key, async () => {});

  const pad = 'x'.repeat(90_000);
  await retain(storage, key, (state) => {
    const base = state.experiments['cp-converge'];
    for (let e = 1; e <= 3; e++) {
      const id = `obj-heavy-${e}`;
      const exp = clone(base);
      exp.objective.id = id;
      exp.objective.name = `Heavy ${e}`;
      exp.rounds = Array.from({ length: 5 }, (_, i) => ({
        n: i + 1, state: 'done', version: 'v1', start: 1000 + i, end: 2000 + i,
        runs: [{ id: `r-${e}-${i}`, state: 'done', metrics: { note: pad } }],
        report: { verdict: 'keep', summary: `round ${i + 1}` },
      }));
      state.experiments[id] = exp;
    }
  });

  const assembled = await readState(storage, key);
  const totalBytes = Buffer.byteLength(JSON.stringify(assembled.value));
  assert.ok(totalBytes > 1_400_000, `expected > 1.4 MiB assembled, got ${totalBytes}`);

  const rootRaw = await storage.get(key);
  assert.equal(rootRaw.value.sharded, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(rootRaw.value)) < 64 * 1024);
  for (const [k, entry] of storage.entries) {
    assert.ok(Buffer.byteLength(JSON.stringify(entry.value)) < LIMIT, `key ${k} exceeded 1 MiB`);
  }

  const owners = await listOwners(storage);
  assert.equal(owners.length, 1);
  assert.equal(owners[0][0], key);
  assert.equal(isOwnerKey(owners[0][0]), true);
  assert.equal(owners[0][1].value.experiments['obj-heavy-3'].rounds.length, 5);
  assert.equal(owners[0][1].value.experiments['obj-heavy-3'].rounds[4].runs[0].metrics.note.length, 90_000);
});

test('unchanged shards are reused without rewriting, obsolete shards survive the grace window then GC, and CAS 409 cleans up staged shards', async (t) => {
  const storage = memStorage();
  const key = ownerKey('gc-owner');
  await load(storage, key, async () => {});

  const beforeRoot = (await storage.get(key)).value;
  const oldCpKey = beforeRoot.shards.experiments['cp-converge'].key;
  storage.writes.length = 0;

  await retain(storage, key, (state) => {
    state.experiments['cp-converge'].objective.name = 'Updated title';
  });
  const afterRoot = (await storage.get(key)).value;
  assert.equal(afterRoot.shards.details, beforeRoot.shards.details);
  assert.equal(afterRoot.shards.experiments['pd-ttft'].key, beforeRoot.shards.experiments['pd-ttft'].key);
  assert.notEqual(afterRoot.shards.experiments['cp-converge'].key, oldCpKey);
  assert.deepEqual(storage.writes.length, 2);
  // Old shard stays readable during the grace window so concurrent readers never hit 500.
  assert.equal(storage.entries.has(oldCpKey), true);
  assert.ok(afterRoot.gc?.some((g) => g.key === oldCpKey));

  const snapSize = storage.entries.size;
  const origCas = storage.compareAndSet.bind(storage);
  storage.compareAndSet = async (k, exp, val) => k === key ? { applied: false } : origCas(k, exp, val);
  const res = await update(storage, key, (state) => {
    state.experiments['pd-ttft'].objective.name = 'Should rollback';
    return { ok: true };
  });
  storage.compareAndSet = origCas;
  assert.equal(res.status, 409);
  assert.equal(storage.entries.size, snapSize);
  assert.notEqual((await readState(storage, key)).value.experiments['pd-ttft'].objective.name, 'Should rollback');

  // After the grace window elapses, the next write deletes expired obsolete shards.
  const deletedExpKey = afterRoot.shards.experiments['pd-ttft'].key;
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + GC_GRACE_MS + 1000 });
  await retain(storage, key, (state) => { delete state.experiments['pd-ttft']; });
  assert.equal(storage.entries.has(oldCpKey), false);
  // Newly deleted experiment shard enters grace window and is collected after the next grace window.
  assert.equal(storage.entries.has(deletedExpKey), true);
  t.mock.timers.tick(GC_GRACE_MS + 1000);
  await retain(storage, key, () => {});
  assert.equal(storage.entries.has(deletedExpKey), false);
});

test('concurrent readState calls use 1 storage RPC each and never burst past Host worker RPC capacity', async () => {
  const storage = memStorage();
  const key = ownerKey('burst-owner');
  await load(storage, key, async () => {});

  // Create 20 closed rounds so the owner spans > 25 shard keys.
  await retain(storage, key, (state) => {
    const d = state.experiments['cp-converge'];
    d.rounds = Array.from({ length: 20 }, (_, i) => ({
      n: i + 1, state: 'done', version: 'v1', runs: [{ id: `r${i + 1}`, state: 'done', metrics: { score: i } }],
    }));
  });
  assert.ok(storage.entries.size > 24);

  let inFlight = 0, peakInFlight = 0, totalCalls = 0;
  const wrap = (fn) => async (...args) => {
    totalCalls++;
    inFlight++;
    if (inFlight > peakInFlight) peakInFlight = inFlight;
    await new Promise((r) => setTimeout(r, 5));
    try { return await fn(...args); } finally { inFlight--; }
  };
  const counted = {
    list: wrap(storage.list.bind(storage)),
    get: wrap(storage.get.bind(storage)),
    compareAndSet: wrap(storage.compareAndSet.bind(storage)),
    delete: wrap(storage.delete.bind(storage)),
  };

  // 4 concurrent UI requests (e.g. home + exp + refresh) must only issue 4 total RPCs, not 4 * 25 = 100.
  const results = await Promise.all(Array.from({ length: 4 }, () => readState(counted, key)));
  assert.equal(results.length, 4);
  for (const r of results) assert.equal(r.value.experiments['cp-converge'].rounds.length, 20);
  assert.equal(totalCalls, 4);
  assert.ok(peakInFlight <= 4, `peakInFlight=${peakInFlight} exceeded 4`);
});

test('legacy monolithic single-key state reads seamlessly and migrates losslessly to sharded keys on update', async () => {
  const storage = memStorage();
  const key = ownerKey('legacy-owner');
  const legacy = createFixtures(1800000000000).state;
  legacy.experiments['cp-converge'].rounds = [{ n: 1, state: 'done', version: 'v1', runs: [{ id: 'r1', state: 'done', metrics: { score: 0.9 } }] }];
  await storage.compareAndSet(key, null, legacy);

  const before = await readState(storage, key);
  assert.equal(before.legacy, true);
  assert.equal(before.value.experiments['cp-converge'].rounds[0].runs[0].metrics.score, 0.9);

  await retain(storage, key, () => {});
  const afterRoot = await storage.get(key);
  assert.equal(afterRoot.value.sharded, 1);
  assert.ok(afterRoot.value.shards.details);
  assert.ok(afterRoot.value.shards.experiments['cp-converge'].rounds['1']);

  const after = await readState(storage, key);
  assert.equal(after.legacy, false);
  assert.deepEqual(after.value.experiments['cp-converge'].rounds[0].runs[0].metrics, { score: 0.9 });
  assert.deepEqual(Object.keys(after.value.details).sort(), Object.keys(legacy.details).sort());
  assert.deepEqual(after.value.library, legacy.library);
});

test('warm readState hits cache via 1 root get, incrementally fetches only new shards on revision change, and handles deletion cleanly', async () => {
  const entries = new Map();
  let revision = 0;
  const counts = { list: 0, get: 0, getKeys: [] };
  const storage = {
    entries,
    async list() { counts.list++; return Object.fromEntries([...entries].map(([k, v]) => [k, clone(v)])); },
    async get(k) { counts.get++; counts.getKeys.push(k); return clone(entries.get(k)); },
    async compareAndSet(k, expected, value) {
      if ((entries.get(k)?.revision ?? null) !== expected) return { applied: false };
      const rev = ++revision;
      entries.set(k, { revision: rev, value: clone(value) });
      return { applied: true, revision: rev };
    },
    async delete(k) { return { deleted: entries.delete(k) }; },
  };
  const key = ownerKey('cache-owner');
  await load(storage, key, async () => {});
  await retain(storage, key, (state) => {
    state.experiments['cp-converge'].rounds = Array.from({ length: 12 }, (_, i) => ({
      n: i + 1, state: 'done', version: 'v1', runs: [{ id: `r${i + 1}`, state: 'done', metrics: { score: i } }],
    }));
  });

  // Warm cache hit: 1 root get, 0 list, 0 shard gets.
  counts.list = 0; counts.get = 0; counts.getKeys.length = 0;
  const hit = await readState(storage, key);
  assert.equal(hit.value.experiments['cp-converge'].rounds.length, 12);
  assert.equal(counts.list, 0);
  assert.deepEqual(counts.getKeys, [key]);

  // Simulate an external writer (separate storage wrapper so it does not touch `storage`'s cache)
  // adding 1 closed round (changes 1 experiment shard + adds 1 closed round shard = 2 new shards).
  const external = {
    list: () => storage.list(),
    get: (k) => storage.get(k),
    compareAndSet: (k, exp, val) => storage.compareAndSet(k, exp, val),
    delete: (k) => storage.delete(k),
  };
  await retain(external, key, (state) => {
    state.experiments['cp-converge'].rounds.push({
      n: 13, state: 'done', version: 'v2', runs: [{ id: 'r13', state: 'done', metrics: { score: 99 } }],
    });
  });

  // Warm reader sees new revision and fetches ONLY root + 2 new shards, 0 list().
  counts.list = 0; counts.get = 0; counts.getKeys.length = 0;
  const inc = await readState(storage, key);
  assert.equal(inc.value.experiments['cp-converge'].rounds.length, 13);
  assert.equal(inc.value.experiments['cp-converge'].rounds[12].runs[0].metrics.score, 99);
  assert.equal(counts.list, 0);
  assert.equal(counts.getKeys.length, 3);
  assert.equal(counts.getKeys[0], key);

  // Subsequent read is a 1-get hit again, and mutating default readState output never poisons cache.
  counts.list = 0; counts.get = 0; counts.getKeys.length = 0;
  const hit2 = await readState(storage, key);
  assert.equal(hit2.value.experiments['cp-converge'].rounds.length, 13);
  assert.equal(counts.list, 0);
  assert.deepEqual(counts.getKeys, [key]);
  hit2.value.experiments['cp-converge'].objective.name = 'mutated-by-caller';
  const hit3 = await readState(storage, key, { readonly: true });
  assert.notEqual(hit3.value.experiments['cp-converge'].objective.name, 'mutated-by-caller');

  // Deleting root evicts cache and returns undefined cleanly.
  await storage.delete(key);
  assert.equal(await readState(storage, key), undefined);
});

test('projects() caches with TTL and single-flight dedup, threadProject() caches positive hits, and withLiveProjects() does not mutate state', async (t) => {
  let listCalls = 0, getCalls = 0;
  const rows = [
    { id: 't1', projectRef: '/ws/alpha', lastActiveAt: 10 },
    { id: 't2', projectRef: '/ws/beta', lastActiveAt: 9 },
  ];
  const host = {
    threads: {
      async list() {
        listCalls++;
        await new Promise((r) => setTimeout(r, 5));
        return clone(rows);
      },
      async get(id) {
        getCalls++;
        return clone(rows.find((r) => r.id === id) || null);
      },
    },
  };

  // Concurrent cold calls share a single scan (single-flight).
  const [p1, p2] = await Promise.all([projects(host), projects(host)]);
  assert.equal(listCalls, 1);
  assert.deepEqual(p1.map((p) => p.id), ['/ws/alpha', '/ws/beta']);
  assert.deepEqual(p2.map((p) => p.id), ['/ws/alpha', '/ws/beta']);

  // Cached hit within TTL makes 0 RPCs.
  const p3 = await projects(host);
  assert.equal(listCalls, 1);
  assert.equal(p3.length, 2);

  // Explicit fresh or invalidateProjects forces a re-scan.
  rows.push({ id: 't3', projectRef: '/ws/gamma', lastActiveAt: 11 });
  const p4 = await projects(host, { fresh: true });
  assert.equal(listCalls, 2);
  assert.deepEqual(p4.map((p) => p.id), ['/ws/alpha', '/ws/beta', '/ws/gamma']);

  invalidateProjects(host);
  await projects(host);
  assert.equal(listCalls, 3);

  // TTL expiration refreshes automatically.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + PROJECTS_TTL_MS + 1000 });
  await projects(host);
  assert.equal(listCalls, 4);

  // threadProject caches positive hits and does not negative-cache missing threads.
  assert.equal(await threadProject(host, 't1'), '/ws/alpha');
  assert.equal(await threadProject(host, 't1'), '/ws/alpha');
  assert.equal(getCalls, 1);
  assert.equal(await threadProject(host, 'missing'), undefined);
  assert.equal(await threadProject(host, 'missing'), undefined);
  assert.equal(getCalls, 3);

  // withLiveProjects returns merged view without mutating the cached base state.
  const base = createFixtures(1800000000000).state;
  const beforeProjects = base.projects.map((p) => p.id);
  const merged = withLiveProjects(base, p4);
  assert.deepEqual(base.projects.map((p) => p.id), beforeProjects);
  assert.equal(base.objectives['/ws/gamma'], undefined);
  assert.ok(merged.projects.some((p) => p.id === '/ws/gamma'));
  assert.deepEqual(merged.objectives['/ws/gamma'], []);
});
