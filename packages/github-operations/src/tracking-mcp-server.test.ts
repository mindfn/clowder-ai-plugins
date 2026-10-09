import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTrackingMcpServer } from './tracking-mcp-server.js';

test('native MCP exposes the three tracking tools and dispatches directly to package handlers', async () => {
  const calls: unknown[] = [];
  const server = createTrackingMcpServer({
    registerPr: async input => { calls.push(input); return { registered: true }; },
    registerIssue: async input => { calls.push(input); return { registered: true }; },
    unregister: async input => { calls.push(input); return { unregistered: true }; },
  });
  const client = new Client({ name: 'tracking-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), [
      'cat_cafe_register_issue_tracking', 'cat_cafe_register_pr_tracking', 'cat_cafe_unregister_tracking',
    ]);
    assert.ok(tools.every(t => !Object.hasOwn(t.inputSchema.properties ?? {}, 'threadId')));
    const result = await client.callTool({ name: 'cat_cafe_register_pr_tracking',
      arguments: { repoFullName: 'owner/repo', prNumber: 1 } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, [{ repoFullName: 'owner/repo', prNumber: 1 }]);
    const bad = await client.callTool({ name: 'cat_cafe_register_issue_tracking',
      arguments: { repoFullName: 'owner/repo', issueNumber: 0 } });
    assert.equal(bad.isError, true); assert.equal(calls.length, 1);
  } finally { await client.close(); await server.close(); }
});
