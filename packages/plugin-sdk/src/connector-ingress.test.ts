import assert from 'node:assert/strict';
import test from 'node:test';

import { validateMessagingRowInput, type MessageDraft } from '@clowder-ai/plugin-contract';

import {
  INBOUND_THREAD_HANDLE_CONFIG_KEY,
  InboundThreadHandleMissingError,
  createInboundMessageSender,
  requireInboundThreadHandle,
} from './connector-ingress.js';
import type { FeatureContext, FeatureHostAdapter } from './feature-context.js';

function contextWithConfig(values: Record<string, unknown>): FeatureContext {
  return {
    featureId: 'fixture-messaging',
    config: { get: async (key: string) => values[key] },
  } as unknown as FeatureContext;
}

test('requireInboundThreadHandle returns the Host-issued handle from projected config', async () => {
  const context = contextWithConfig({ [INBOUND_THREAD_HANDLE_CONFIG_KEY]: 'thread-handle-1' });
  assert.equal(await requireInboundThreadHandle(context), 'thread-handle-1');
});

test('requireInboundThreadHandle fails closed when the Host issued no handle', async (t) => {
  for (const [name, value] of [['absent', undefined], ['empty string', ''], ['non-string', 42]] as const) {
    await t.test(name, async () => {
      const context = contextWithConfig(
        value === undefined ? {} : { [INBOUND_THREAD_HANDLE_CONFIG_KEY]: value },
      );
      await assert.rejects(requireInboundThreadHandle(context), InboundThreadHandleMissingError);
    });
  }
});

test('inbound sender addresses the frozen thread_handle shape and passes contract validation', async () => {
  const drafts: unknown[] = [];
  const send: FeatureContext['messaging']['send'] = async (input) => {
    drafts.push(input);
    return {
      messageId: 'message-1',
      threadId: 'thread-1',
      revision: 1,
      messageHandle: { kind: 'message', token: 'handle-1' },
    };
  };
  const sender = createInboundMessageSender({
    send,
    threadHandle: 'thread-handle-1',
    connectorId: 'fixture-connector',
  });

  await sender.deliver({
    externalConversationId: 'provider-chat-42',
    providerMessageId: 'provider-message-1',
    text: 'hello from provider',
    attachments: [{ type: 'image', platformKey: 'provider-file-1', fileName: 'photo.png' }],
  });

  assert.equal(drafts.length, 1);
  const draft = drafts[0] as MessageDraft;
  assert.deepEqual(draft.address, { kind: 'thread_handle', handle: 'thread-handle-1' });
  assert.equal(draft.idempotencyKey, 'provider-message-1');
  assert.equal(draft.payload.provenance.epistemicStatus, 'observation');
  assert.deepEqual(draft.payload.provenance.origin, {
    kind: 'external',
    connectorId: 'fixture-connector',
    sourceAddress: {
      connectorId: 'fixture-connector',
      chatId: 'provider-chat-42',
      messageId: 'provider-message-1',
    },
  });
  assert.deepEqual(draft.payload.elements.map((element) => element.kind), ['text', 'media_ref']);

  const validation = validateMessagingRowInput('messaging.send', draft);
  assert.ok(validation.valid, JSON.stringify(validation.errors));
});

test('inbound sender maps a text-only message to a single text element', async () => {
  const drafts: unknown[] = [];
  const sender = createInboundMessageSender({
    send: async (input) => { drafts.push(input); return {} as never; },
    threadHandle: 'thread-handle-1',
    connectorId: 'fixture-connector',
  });

  await sender.deliver({
    externalConversationId: 'provider-chat-42',
    providerMessageId: 'provider-message-2',
    text: 'plain text',
  });

  const draft = drafts[0] as MessageDraft;
  assert.deepEqual(draft.payload.elements, [{
    elementId: 'text-1',
    kind: 'text',
    payload: { text: 'plain text' },
  }]);
  assert.ok(validateMessagingRowInput('messaging.send', draft).valid);
});
