// Real-carrier entry test for the p2b module: the three cloud-conversation-host
// methods are real socket operations now. With no pairing record in the granted
// data directory they must honestly report the frozen (e) HOST_UNAVAILABLE /
// empty-list shapes through the real carrier, still passing the contract
// validators. Red history: on beta.8, start() threw FeaturePermissionError at
// plugin-entrypoint.ts `context.dataDirectory` (sol's R1, reproduced locally);
// before p2b the methods were placeholders returning the same shapes.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

import {
  isCloudConversationAckResult,
  isCloudConversationAppendMessageResult,
  isCloudConversationListResult,
} from '@clowder-ai/plugin-contract';
import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';

import entrypoint, {
  PERSONAL_CHROME_APPEND_MESSAGE_METHOD,
  PERSONAL_CHROME_ASSISTANT_ACK_METHOD,
  PERSONAL_CHROME_ASSISTANT_LIST_METHOD,
  PERSONAL_CHROME_LIST_METHOD,
  PERSONAL_CHROME_REVOKE_METHOD,
  PERSONAL_CHROME_STATUS_METHOD,
  PERSONAL_CHROME_TEST_METHOD,
} from '../src/plugin-entrypoint.js';

const H3_METHODS = [
  PERSONAL_CHROME_APPEND_MESSAGE_METHOD,
  PERSONAL_CHROME_ASSISTANT_LIST_METHOD,
  PERSONAL_CHROME_ASSISTANT_ACK_METHOD,
] as const;

const H3_VALIDATORS = [
  isCloudConversationAppendMessageResult,
  isCloudConversationListResult,
  isCloudConversationAckResult,
] as const;

function loadManifest(): Parameters<typeof entrypoint.create>[0] {
  return parse(readFileSync(new URL('../plugin.yaml', import.meta.url), 'utf8')) as Parameters<
    typeof entrypoint.create
  >[0];
}

function makeHost(dataDirectory: string): ModulePluginHostShape {
  const task = {
    id: 'task-1', kind: 'work', threadId: 'thread-1', subjectKey: 'fixture:1', title: 'Fixture task',
    ownerCatId: null, status: 'todo', why: '', createdBy: 'system', createdAt: 1, updatedAt: 1,
  } as const;
  return {
    dataDirectory,
    config: { get: async (_key: string) => undefined },
    secrets: { get: async (_key: string) => undefined },
    storage: {
      get: async (_key: string) => undefined,
      list: async () => ({}),
      set: async (_key: string, _value: unknown) => ({ revision: 1 }),
      compareAndSet: async (_key: string, _expectedRevision: number | null, _value: unknown) =>
        ({ applied: true, revision: 1 }),
      delete: async (_key: string, _expectedRevision?: number) => ({ deleted: true, revision: 1 }),
    },
    tasks: {
      get: async () => task,
      listByThread: async () => [task],
      listByKind: async () => [task],
      getBySubject: async () => task,
      create: async () => task,
      upsertBySubject: async (_input: unknown) => task,
      update: async () => task,
      updateIfThreadId: async () => task,
    },
    threads: {
      get: async () => null,
      create: async () => ({ id: 'thread-1', title: 'Fixture', createdAt: 1, lastActiveAt: 1 }),
      update: async () => ({ id: 'thread-1', title: 'Fixture', createdAt: 1, lastActiveAt: 1 }),
      findByKey: async () => null,
      ensureByKey: async (_key: string, _input: unknown) =>
        ({ id: 'thread-1', title: 'Fixture', createdAt: 1, lastActiveAt: 1 }),
      bind: async () => ({ key: 'fixture', threadId: 'thread-1', createdAt: 1 }),
      unbind: async () => true,
      listBindings: async () => [],
      ensureSystemThread: async () => ({ id: 'system-thread', title: 'System', createdAt: 1, lastActiveAt: 1 }),
    },
    messaging: {
      send: async () => ({ messageId: 'message-1', threadId: 'thread-1' }),
      subscribe: async () => undefined,
      unsubscribe: async () => undefined,
    },
    media: {
      read: async (input: { readonly offset: number }) =>
        ({ offset: input.offset, dataBase64: '', done: true }),
    },
    log: (_level: string, _message: string, _fields?: Readonly<Record<string, unknown>>) => undefined,
  };
}

test('real module entry starts across the SDK carrier and serves every p2b action', async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'p2a-real-entry-'));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));

  const activation = await entrypoint.create(loadManifest()).start(makeHost(dataDirectory));

  for (const method of [
    PERSONAL_CHROME_LIST_METHOD,
    PERSONAL_CHROME_REVOKE_METHOD,
    PERSONAL_CHROME_STATUS_METHOD,
    PERSONAL_CHROME_TEST_METHOD,
  ]) {
    assert.equal(Object.hasOwn(activation.actions, method), true, `actions owns ${method}`);
    assert.equal(typeof activation.actions[method], 'function', `actions ${method} is a function`);
  }

  // Host h3 enable preflight: the three cloud-conversation-host methods must be
  // own functions of the actions table and pass the contract validators through
  // the real carrier. Valid wire input with no pairing record in the granted
  // data directory must report the frozen (e) HOST_UNAVAILABLE / empty-list
  // shapes honestly (p2b makes them real socket operations).
  const h3Calls = [
    () => ({
      conversationId: 'conversation-1',
      text: 'hello from the test',
      idempotencyKey: 'delivery-1',
    }),
    () => ({}),
    () => ({
      conversationId: 'conversation-1',
      sourceMessageId: 'source-1',
      assistantMessageId: 'assistant-1',
    }),
  ];
  const expectedFrozenShapes = [
    { status: 'failed', errorCode: 'HOST_UNAVAILABLE' },
    { returns: [] },
    { status: 'failed', errorCode: 'HOST_UNAVAILABLE' },
  ] as const;
  for (let index = 0; index < H3_METHODS.length; index += 1) {
    const method = H3_METHODS[index]!;
    assert.equal(Object.hasOwn(activation.actions, method), true, `actions owns ${method}`);
    assert.equal(typeof activation.actions[method], 'function', `actions ${method} is a function`);
    const result = await activation.actions[method]!(h3Calls[index]!());
    assert.equal(
      H3_VALIDATORS[index]!(result),
      true,
      `${method} result passes the contract validator via real carrier`,
    );
    assert.deepEqual(result, expectedFrozenShapes[index], `${method} reports the frozen no-helper shape`);
  }

  const listed = await activation.actions[PERSONAL_CHROME_LIST_METHOD]!({});
  assert.ok(listed && typeof listed === 'object', 'list returns a result');
  const status = await activation.actions[PERSONAL_CHROME_STATUS_METHOD]!({});
  assert.ok(status && typeof status === 'object', 'status returns a result');
  // p2b makes `test` honest: the probe must actually attempt reachability and
  // report not-ok when no helper/pairing exists, never claiming reachability
  // without probing.
  const testResult = (await activation.actions[PERSONAL_CHROME_TEST_METHOD]!({})) as {
    ok?: boolean;
    message?: unknown;
  };
  assert.equal(testResult.ok, false, 'test action honestly reports unreachable');
  assert.equal(typeof testResult.message, 'string');
  assert.ok(
    typeof testResult.message === 'string' && testResult.message.length > 0,
    'test action explains the reason',
  );

  await activation.stop();
});
