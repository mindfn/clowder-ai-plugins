import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

import { GITHUB_SCHEDULES } from './schedules.js';

test('schedule inventory preserves all seven Core GitHub operations and polling budgets', () => {
  assert.deepEqual(GITHUB_SCHEDULES, [
    { id: 'cicd-check', everyMs: 60_000, timeoutMs: 30_000 },
    { id: 'conflict-check', everyMs: 300_000, timeoutMs: 30_000 },
    { id: 'review-feedback', everyMs: 60_000, timeoutMs: 30_000 },
    { id: 'repo-scan', everyMs: 300_000, timeoutMs: 30_000 },
    { id: 'issue-tracking', everyMs: 60_000, timeoutMs: 30_000 },
    { id: 'repo-comment-poll', everyMs: 60_000, timeoutMs: 30_000 },
    { id: 'community-reconciler', everyMs: 600_000, timeoutMs: 120_000 },
  ]);
});

test('manifest schedule contributions match package-owned inventory exactly', async () => {
  const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')) as {
    contributions: Array<{ type: string; id: string; schedule?: { everyMs?: number }; policy?: { timeoutMs?: number } }>;
    features: Array<{ capabilities: string[] }>;
  };
  const schedules = manifest.contributions
    .filter(item => item.type === 'schedule')
    .map(item => ({ id: item.id, everyMs: item.schedule?.everyMs, timeoutMs: item.policy?.timeoutMs }));
  assert.deepEqual(schedules, [...GITHUB_SCHEDULES]);
  assert.ok(manifest.features[0]?.capabilities.includes('messaging.send'));
  assert.ok(manifest.features[0]?.capabilities.includes('plugin.state.set'));
  assert.ok(!manifest.features[0]?.capabilities.includes('events.publish'));
});

test('runtime source contains no ambient token, env, or persistence fallback', async () => {
  const source = await readFile(new URL('./schedules.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /process\.env|readFile|writeFile|Redis|GITHUB_TOKEN|GITHUB_MCP_PAT/);
});

test('skills use generic declaration and repository MCP transport is not revived', async () => {
  const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8'));
  const skill = manifest.contributions.find((item: { type: string }) => item.type === 'skill');
  assert.equal(skill.path, 'skills/github-operations');
  const content = await readFile(new URL(`../${skill.path}/SKILL.md`, import.meta.url), 'utf8');
  assert.match(content, /plugin_list_tools/);
  assert.match(content, /plugin_call/);
  assert.equal(manifest.contributions.some((item: { type: string }) => item.type === 'mcp'), false);
  assert.equal(manifest.runtime.transport, 'builtin');
});
