import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { createRsiMcpServer } from '../dist/mcp-server.js';
import { toolAction } from '../dist/tools.js';
import { viewModel } from '../dist/views.js';
import { buildCloseoutReport, finishCycle, orderedPairs, validPlan } from '../dist/cycles.js';
import { fixture } from './helpers.mjs';

function createMemoryPair() {
  const sent = [];
  const serverTransport = {
    async start() {},
    async send(msg) { sent.push(msg); },
    async close() {},
  };
  return {
    serverTransport,
    async rpc(msg) {
      const before = sent.length;
      serverTransport.onmessage(msg);
      for (let i = 0; i < 50 && sent.length === before; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      return sent[sent.length - 1];
    },
    sent,
  };
}

test('native RSI MCP server declares 8 flat strong-typed tools with zero oneOf and completes MCP handshake', async () => {
  const manifest = parse(readFileSync(new URL('../plugin.yaml', import.meta.url), 'utf8'));
  const mcpDecl = manifest.contributions.find((c) => c.type === 'mcp' && c.id === 'rsi-native');
  assert.ok(mcpDecl);
  assert.equal(mcpDecl.sharedFactory.module, 'dist/mcp-server.js');
  assert.equal(mcpDecl.sharedFactory.export, 'createRsiMcpServer');
  assert.ok(manifest.features[0].contributions.some((c) => c.type === 'mcp' && c.id === 'rsi-native'));
  const skillDecl = manifest.contributions.find((c) => c.type === 'skill' && c.id === 'rsi');
  assert.ok(skillDecl);
  assert.equal(skillDecl.path, 'skills/rsi');
  assert.ok(manifest.features[0].contributions.some((c) => c.type === 'skill' && c.id === 'rsi'));
  const skillMd = readFileSync(new URL('../skills/rsi/SKILL.md', import.meta.url), 'utf8');
  assert.match(skillMd, /^---\nname: rsi\n/);

  const calls = [];
  const server = createRsiMcpServer({
    async invoke(method, input, call) {
      calls.push({ method, input, call });
      return { ok: true, method, input };
    },
  });
  const pair = createMemoryPair();
  await server.connect(pair.serverTransport);

  const initRes = await pair.rpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  });
  assert.equal(initRes.result.protocolVersion, '2025-03-26');
  assert.deepEqual(initRes.result.capabilities, { tools: {} });
  assert.equal(initRes.result.serverInfo.name, 'official-rsi');

  // Notification must not emit a reply
  const beforeNotify = pair.sent.length;
  pair.serverTransport.onmessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(pair.sent.length, beforeNotify);

  const pingRes = await pair.rpc({ jsonrpc: '2.0', id: 2, method: 'ping' });
  assert.deepEqual(pingRes.result, {});

  const listRes = await pair.rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.deepEqual(listRes.result.tools.map((t) => t.name), [
    'rsi_task', 'rsi_submit', 'rsi_executor', 'rsi_version', 'rsi_conclude', 'rsi_propose', 'rsi_status', 'rsi_operate',
  ]);
  const versionTool = listRes.result.tools.find((t) => t.name === 'rsi_version');
  assert.deepEqual(versionTool.inputSchema.properties.order.enum, ['grouped', 'interleaved', 'balanced']);
  // No fragile oneOf constructs anywhere in native MCP schemas
  assert.equal(JSON.stringify(listRes.result.tools).includes('"oneOf"'), false);

  const callRes = await pair.rpc({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'rsi_task', arguments: {}, _meta: { threadId: 't-1' } },
  });
  assert.equal(callRes.result.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'rsi.task');
  assert.deepEqual(calls[0].call, { _meta: { threadId: 't-1' } });
  await server.close();
});

test('rsi_submit accepts flat 2–3 level payloads (string step, string[]/record facts, 2-level values) via native MCP', async () => {
  const f = fixture();
  await f.seed();
  const id = await f.newObjective();
  const state = await f.read();
  const exp = state.experiments[id];
  exp.objective.thread = 'th-mcp-1';
  exp.objective.projectPath = '/tmp/demo';
  const evalCatId = exp.members.find((m) => m.role === 'evaluate').catId;

  const ctx = { catId: evalCatId, threadId: 'th-mcp-1', userId: 'u-1', invocationId: 'inv-1', async assertCurrent() {} };
  const server = createRsiMcpServer({
    async invoke(method, input) {
      return toolAction(state, method, input, ctx, state.now + 1000);
    },
  });
  const pair = createMemoryPair();
  await server.connect(pair.serverTransport);

  const taskRes = await pair.rpc({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'rsi_task', arguments: {} } });
  assert.equal(taskRes.result.isError, undefined, taskRes.result.content[0].text);
  const taskPayload = JSON.parse(taskRes.result.content[0].text);
  assert.equal(taskPayload.steps[0].step, 1);
  const step1Ids = taskPayload.steps[0].items.filter((x) => !x.userOwned).map((x) => x.id);
  assert.ok(step1Ids.length >= 2);

  // Submit with flat 3-level payload: string step "1", string[] facts, record facts, array unknowns/next
  const submitRes = await pair.rpc({
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: {
      name: 'rsi_submit',
      arguments: {
        step: '1',
        items: [
          { id: step1Ids[0], value: 'P99 降到 20ms 以内', facts: ['依据：README', '单条纯文本依据'] },
          { id: step1Ids[1], value: '护栏不降才采用', facts: { 规则: '零回归' } },
          ...step1Ids.slice(2).map((itemId) => ({ id: itemId, value: '已核对' })),
        ],
        unknowns: ['硬件温控波动未知', '长序列分布待测'],
        next: ['先跑基线控制组'],
      },
    },
  });
  assert.equal(submitRes.result.isError, undefined, submitRes.result.content[0].text);
  const updated = state.experiments[id];
  const firstItem = updated.prep.find((x) => x.id === step1Ids[0]);
  assert.deepEqual(firstItem.facts, [{ k: '依据', v: 'README' }, { k: '依据', v: '单条纯文本依据' }]);
  const secondItem = updated.prep.find((x) => x.id === step1Ids[1]);
  assert.deepEqual(secondItem.facts, [{ k: '规则', v: '零回归' }]);
  assert.equal(updated.steps.goal.unknowns, '硬件温控波动未知\n长序列分布待测');
  assert.equal(updated.steps.goal.next, '先跑基线控制组');

  // Verify 2-level values shorthand on a second fresh objective
  const id2 = await f.newObjective();
  const state2 = await f.read();
  const exp2 = state2.experiments[id2];
  exp2.objective.thread = 'th-mcp-2';
  exp2.objective.projectPath = '/tmp/demo';
  const ctx2 = { catId: exp2.members.find((m) => m.role === 'evaluate').catId, threadId: 'th-mcp-2', userId: 'u-1', invocationId: 'inv-2', async assertCurrent() {} };
  const t2 = toolAction(state2, 'rsi.task', {}, ctx2, state2.now + 2000);
  const vals = Object.fromEntries(t2.steps[0].items.filter((x) => !x.userOwned).map((x) => [x.id, `简洁值-${x.id}`]));
  const r2 = toolAction(state2, 'rsi.submit', { step: '1', values: vals, unknowns: ['待测项'], next: ['继续'] }, ctx2, state2.now + 3000);
  assert.equal(r2.error, undefined);
  assert.equal(state2.experiments[id2].steps.goal.rev, 1);

  // Verify 2-level values shorthand also works on Step 2 (own=true, newly created items without explicit title)
  const prepCatId = exp2.members.find((m) => m.role === 'prepare').catId;
  const ctxPrep = { catId: prepCatId, threadId: 'th-mcp-2', userId: 'u-1', invocationId: 'inv-prep-2', async assertCurrent() {} };
  const tStep2 = toolAction(state2, 'rsi.task', {}, ctxPrep, state2.now + 4000);
  assert.equal(tStep2.steps[0].step, 2);
  const rStep2 = toolAction(
    state2,
    'rsi.submit',
    {
      step: '2',
      values: {
        'bge-contract': '200 条候选契约与精度硬闸门固定不变',
        'bf16-110-baseline': '以显式 110 作为保守参照，111 单列候选',
      },
      unknowns: ['长文本 >128 路由待补验证集'],
      next: ['继续推进第 3 步执行器与时段'],
    },
    ctxPrep,
    state2.now + 5000,
  );
  assert.equal(rStep2.error, undefined, JSON.stringify(rStep2));
  assert.equal(state2.experiments[id2].steps.scope.rev, 1);
  assert.equal(state2.experiments[id2].prep.find((x) => x.id === 'bge-contract')?.title, 'bge-contract');

  // Verify views.ts never renders [object Object] for legacy params: {}, and signatureOf skips JSON analyze blobs.
  const targetExp = state2.experiments[id2];
  targetExp.executor = {
    mcp: 'rsi.executor',
    state: 'passed',
    commands: { preflight: '/old/abs/preflight.sh', submit: '/old/abs/submit.sh', collect: '/old/abs/collect.sh' },
    ops: [{ op: 'submit', tool: '/old/abs/submit.sh', params: {} }],
    resultMap: [{ metric: 'score', field: 'score' }],
  };
  const expVm = viewModel(state2, 'exp', { thread: 'th-mcp-2', project: 'cartpole', pick: `obj:${id2}` });
  assert.equal(expVm.executor.ops[0].params, '/old/abs/submit.sh');
  assert.ok(!JSON.stringify(expVm.executor.ops).includes('[object Object]'));

  const failedRound = {
    n: 1, version: 'v1', state: 'running', start: state2.now,
    plan: { groups: [{ id: 'control', label: 'Control', version: 'v1', vars: {}, control: true }], seeds: [1] },
    runs: [{ id: 'r1', group: 'control', seed: 1, state: 'failed', retries: 1, error: { kind: 'env', step: 'submit', raw: 'submit exited 1: NPU 4 not claimed', analysis: '{"schema":"v1","metrics":{"duration_s":5.0}}' }, log: '' }],
  };
  targetExp.rounds = [failedRound];
  finishCycle(state2, targetExp, failedRound, state2.now + 6000);
  assert.equal(targetExp.versionRequest.repair.signature, 'submit exited #: NPU # not claimed');

  await server.close();
});

test('orderedPairs and validPlan project grouped, interleaved, and balanced AB/BA queues and reject invalid order', () => {
  const twoGroups = [{ id: 'control', label: 'Control', vars: {} }, { id: 'change', label: 'Change', vars: {} }];
  const seeds = [101, 102, 103, 104];
  const fmt = (pairs) => pairs.map((p) => `${p.group.id}:${p.seed}`);

  // Default (omitted) and explicit grouped preserve legacy group-first AAAA / BBBB order.
  const expectedGrouped = ['control:101', 'control:102', 'control:103', 'control:104', 'change:101', 'change:102', 'change:103', 'change:104'];
  assert.deepEqual(fmt(orderedPairs(twoGroups, seeds)), expectedGrouped);
  assert.deepEqual(fmt(orderedPairs(twoGroups, seeds, 'grouped')), expectedGrouped);

  // Interleaved runs per-seed fixed AB / AB / AB / AB.
  assert.deepEqual(fmt(orderedPairs(twoGroups, seeds, 'interleaved')), [
    'control:101', 'change:101', 'control:102', 'change:102', 'control:103', 'change:103', 'control:104', 'change:104',
  ]);

  // Balanced runs per-seed counterbalanced AB / BA / AB / BA.
  assert.deepEqual(fmt(orderedPairs(twoGroups, seeds, 'balanced')), [
    'control:101', 'change:101', 'change:102', 'control:102', 'control:103', 'change:103', 'change:104', 'control:104',
  ]);

  // Single-group and 3-group edge cases do not mutate input arrays and alternate cleanly.
  const threeGroups = [...twoGroups, { id: 'alt', label: 'Alt', vars: {} }];
  assert.deepEqual(fmt(orderedPairs([twoGroups[0]], [1, 2, 3], 'balanced')), ['control:1', 'control:2', 'control:3']);
  assert.deepEqual(fmt(orderedPairs(threeGroups, [1, 2], 'balanced')), ['control:1', 'change:1', 'alt:1', 'alt:2', 'change:2', 'control:2']);
  assert.deepEqual(threeGroups.map((g) => g.id), ['control', 'change', 'alt']);

  // validPlan accepts omitted and valid order values, and rejects invalid ones.
  assert.equal(validPlan({ groups: twoGroups, seeds }), true);
  assert.equal(validPlan({ groups: twoGroups, seeds, order: 'grouped' }), true);
  assert.equal(validPlan({ groups: twoGroups, seeds, order: 'interleaved' }), true);
  assert.equal(validPlan({ groups: twoGroups, seeds, order: 'balanced' }), true);
  for (const bad of ['zigzag', '', null, 42, true, {}]) {
    assert.equal(validPlan({ groups: twoGroups, seeds, order: bad }), false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('rsi.version inherits last cycle order when omitted, allows explicit override to grouped, and preserves order on direct repair', async () => {
  const f = fixture();
  await f.seed();
  const id = await f.newObjective();
  const state = await f.read();
  const exp = state.experiments[id];
  exp.objective.thread = 'th-order-1';
  exp.objective.projectPath = '/tmp/demo';
  const iterCatId = exp.members.find((m) => m.role === 'iterate').catId;
  const ctx = { catId: iterCatId, threadId: 'th-order-1', userId: 'u-1', invocationId: 'inv-ord', async assertCurrent() {} };

  exp.rounds = [{
    n: 1, version: 'v1', state: 'done', start: state.now,
    plan: { groups: [{ id: 'control', label: 'Control', version: 'v1', vars: {}, control: true }], seeds: [1, 2], order: 'balanced' },
    runs: [],
  }];

  // Omitting order inherits 'balanced' from last cycle.
  exp.versionRequest = { cycle: 1, title: 'follow-up', since: state.now, decision: 'next' };
  toolAction(state, 'rsi.task', {}, ctx, state.now + 900);
  const inheritRes = toolAction(state, 'rsi.version', { change: 'inherit order', config: { a: 1 } }, ctx, state.now + 1000);
  assert.equal(inheritRes.ok, true, JSON.stringify(inheritRes));
  assert.equal(exp.upcoming.order, 'balanced');

  // Explicit order: 'grouped' overrides inherited 'balanced'.
  exp.versionRequest = { cycle: 1, title: 'switch back', since: state.now + 2000, decision: 'next2' };
  toolAction(state, 'rsi.task', {}, ctx, state.now + 1900);
  const overrideRes = toolAction(state, 'rsi.version', { change: 'switch grouped', config: { a: 2 }, order: 'grouped' }, ctx, state.now + 2000);
  assert.equal(overrideRes.ok, true, JSON.stringify(overrideRes));
  assert.equal(exp.upcoming.order, 'grouped');

  // Direct execution repair preserves last cycle's order when omitted.
  exp.versionRequest = { cycle: 1, title: 'repair', direct: true, since: state.now + 3000, repair: { signature: 'err', failures: [] } };
  toolAction(state, 'rsi.task', {}, ctx, state.now + 2900);
  const repairRes = toolAction(state, 'rsi.version', { change: 'fix env', config: { a: 3 } }, ctx, state.now + 3000);
  assert.equal(repairRes.ok, true, JSON.stringify(repairRes));
  assert.equal(exp.upcoming.order, 'balanced');
});

test('buildCloseoutReport P1 fixes: baseline excludes skipControl explore, roles distinguish aux, tail advance metrics prioritized, cross-rubric labeled', async () => {
  const f = fixture();
  await f.seed();
  const id = await f.newObjective();
  const state = await f.read();
  const exp = state.experiments[id];
  exp.objective.currentVersion = 'v1';
  exp.versions = [
    { id: 'v1', parent: null, commit: 'aaa1111', current: true, desc: 'baseline' },
    { id: 'v2', parent: 'v1', commit: 'bbb2222', current: false, desc: 'explore candidate' },
    { id: 'v3', parent: 'v2', commit: 'ccc3333', current: false, desc: 'graduated candidate' },
  ];
  // 20 metrics: 1 main (non-guard), 1 aux (non-guard), 18 guards (last two only measured on v3).
  const items = [
    { id: 'qps', name: '可持续QPS', unit: 'qps', guard: false },
    { id: 'hbm', name: '峰值显存', unit: 'GiB', guard: false },
    ...Array.from({ length: 16 }, (_, i) => ({ id: `g${i + 1}`, name: `常规护栏${i + 1}`, unit: 'ms', guard: true, line: '<= 100' })),
    { id: 'soak-p99', name: '长稳P99', unit: 'ms', guard: true, line: '<= 80' },
    { id: 'soak-err', name: '长稳错误', unit: '笔', guard: true, line: '= 0' },
  ];
  exp.metrics = { version: 'E2', items, versions: [] };
  exp.rounds = [
    // Round 1: true baseline (plan.baseline = true, rubric E1 != current E2)
    {
      n: 1, version: 'v1', state: 'done', start: state.now - 3000,
      metrics: { version: 'E1' },
      plan: { baseline: true, groups: [{ id: 'base', label: 'v1', version: 'v1', vars: {} }], seeds: [1] },
      runs: [{ id: 'r1', group: 'base', seed: 1, state: 'done', metrics: { qps: 10, hbm: 8.5, g1: 50 } }],
      report: { verdict: 'baseline', summary: 'v1 baseline' },
    },
    // Round 2: skipControl explore round (groups[0] is v2 without control:true and without plan.baseline)
    // Must NOT leak v2 into the baseline column for soak-p99 or g2!
    {
      n: 2, version: 'v2', state: 'done', start: state.now - 2000,
      metrics: { version: 'E2' },
      plan: { skipControl: true, groups: [{ id: 'explore', label: 'v2', version: 'v2', vars: {} }], seeds: [1] },
      runs: [{ id: 'r2', group: 'explore', seed: 1, state: 'done', metrics: { qps: 15, hbm: 12, g2: 40, 'soak-p99': 99 } }],
      report: { verdict: 'tune', summary: 'v2 explore' },
    },
    // Round 3: advancing milestone v3 with tail graduation metrics soak-p99 & soak-err
    {
      n: 3, version: 'v3', state: 'done', start: state.now - 1000,
      metrics: { version: 'E2' },
      plan: { skipControl: true, groups: [{ id: 'cand', label: 'v3', version: 'v3', vars: {} }], seeds: [1] },
      runs: [{ id: 'r3', group: 'cand', seed: 1, state: 'done', metrics: { hbm: 17.17, 'soak-p99': 76.01, 'soak-err': 0 } }],
      report: { verdict: 'tune', disposition: 'advance', tag: '长稳门过', summary: 'v3 passed soak' },
    },
  ];

  const report = buildCloseoutReport(exp, state.now, 'lang');
  const md = report.markdown;
  // P1-4: non-same-cycle disclaimer & cross-rubric tag (E1 vs current E2)
  assert.match(md, /不是同周期对照，不能直接相减/);
  assert.match(md, /\| 可持续QPS \| 主指标 \| 10 qps（v1·C1·E1） \| 10 qps（v1·C1·E1） \| — \|/);
  // P1-2: second non-guard metric labeled 辅助, not 主指标
  assert.match(md, /\| 峰值显存 \| 辅助 \| 8\.5 GiB（v1·C1·E1） \| 8\.5 GiB（v1·C1·E1） \| 17\.17 GiB（v3·C3） \|/);
  // P1-1: skipControl explore round v2·C2 must NOT leak into baseline column
  assert.doesNotMatch(md, /v2·C2/);
  assert.match(md, /\| 长稳P99 \| 护栏（<= 80） \| — \| — \| 76\.01 ms（v3·C3） \|/);
  assert.match(md, /\| 长稳错误 \| 护栏（= 0） \| — \| — \| 0 笔（v3·C3） \|/);
  // P1-3: cap at 16 rows + neutral footnote ("其余 4 项指标略", not "辅助指标")
  assert.match(md, /其余 4 项指标略/);
  assert.doesNotMatch(md, /项辅助指标略/);
});
