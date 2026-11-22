import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { createRsiMcpServer } from '../dist/mcp-server.js';
import { toolAction } from '../dist/tools.js';
import { viewModel } from '../dist/views.js';
import { finishCycle } from '../dist/cycles.js';
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
