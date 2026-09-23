import {
  definePlugin,
  definePluginModule,
  requireConnectorOutboundDelivery,
  type ConnectorOutboundDelivery,
  type FeatureContext,
  type PluginMessagingDelivery,
  type PluginMessagingDraft,
} from '@clowder-ai/plugin-sdk';

import { FeishuAdapter } from './FeishuAdapter.js';
import {
  createFeishuConnectorRuntime,
  requireFeishuWebhookInput,
  type FeishuConnectorRuntime,
  type FeishuConnectorRuntimeOptions,
  type FeishuHostInboundMessage,
  type FeishuWebhookResult,
} from './runtime.js';

type RuntimeFactory = (
  options: FeishuConnectorRuntimeOptions<FeishuAdapter>,
) => FeishuConnectorRuntime<FeishuAdapter>;

const CONNECTOR_ID = 'feishu';
const IDENTITY_ID = 'feishu-bot';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireDelivery(candidate: unknown): PluginMessagingDelivery {
  if (!object(candidate)) throw new TypeError('feishu delivery must be an object');
  if (Object.keys(candidate).some(key => !['deliveryId', 'threadId', 'envelope'].includes(key))) {
    throw new TypeError('feishu delivery contains an unsupported field');
  }
  if (typeof candidate.deliveryId !== 'string' || candidate.deliveryId.length === 0) {
    throw new TypeError('feishu deliveryId must be non-empty');
  }
  if (typeof candidate.threadId !== 'string' || candidate.threadId.length === 0) {
    throw new TypeError('feishu threadId must be non-empty');
  }
  if (!object(candidate.envelope) || candidate.envelope.threadId !== candidate.threadId) {
    throw new TypeError('feishu delivery envelope must match threadId');
  }
  return structuredClone(candidate) as unknown as PluginMessagingDelivery;
}

function threadTitle(message: FeishuHostInboundMessage): string {
  const value = message.conversation.title?.trim() || `Feishu ${message.externalConversationId}`;
  return value.length <= 200 ? value : value.slice(0, 200);
}

function draft(message: FeishuHostInboundMessage): PluginMessagingDraft {
  return {
    idempotencyKey: message.providerMessageId,
    sourceEventId: message.providerMessageId,
    identity: IDENTITY_ID,
    ...(message.sender === undefined ? {} : { sender: message.sender }),
    payload: {
      provenance: {
        origin: {
          kind: 'external', connectorId: CONNECTOR_ID,
          sourceAddress: { connectorId: CONNECTOR_ID, chatId: message.externalConversationId, messageId: message.providerMessageId },
        },
        epistemicStatus: 'observation',
      },
      elements: [
        { elementId: 'text-1', kind: 'text', payload: { text: message.text } },
        ...(message.attachments ?? []).map((attachment, index) => ({
          elementId: `media-${index + 1}`, kind: 'media_ref' as const,
          payload: {
            type: attachment.type, reference: attachment.platformKey,
            ...(attachment.fileName === undefined ? {} : { fileName: attachment.fileName }),
            ...(attachment.duration === undefined ? {} : { duration: attachment.duration }),
          },
        })),
      ],
    },
  };
}

async function createMessageBridge(context: FeatureContext) {
  const subscriptions = new Map<string, Promise<void>>();
  const subscribe = (threadId: string): Promise<void> => {
    const current = subscriptions.get(threadId);
    if (current !== undefined) return current;
    let pending!: Promise<void>;
    pending = context.messaging.subscribe(threadId, { contributionId: CONNECTOR_ID }).catch((error: unknown) => {
      if (subscriptions.get(threadId) === pending) subscriptions.delete(threadId);
      throw error;
    });
    subscriptions.set(threadId, pending);
    return pending;
  };
  for (const binding of await context.threads.listBindings()) await subscribe(binding.threadId);
  return {
    async deliver(message: FeishuHostInboundMessage): Promise<void> {
      const thread = await context.threads.ensureByKey(message.externalConversationId, { title: threadTitle(message) });
      await subscribe(thread.id);
      await context.messaging.send(thread.id, draft(message));
    },
    async outbound(candidate: unknown): Promise<ConnectorOutboundDelivery> {
      const input = requireDelivery(candidate);
      const binding = (await context.threads.listBindings()).find(item => item.threadId === input.threadId);
      if (binding === undefined) throw new TypeError(`feishu thread ${input.threadId} has no provider binding`);
      const text = input.envelope.payload.elements.filter(element => element.kind === 'text').map(element => element.payload.text).join('\n\n');
      const richBlocks = input.envelope.payload.elements.filter(element => element.kind === 'rich_block').map(element => element.payload);
      const media = input.envelope.payload.elements.flatMap((element) => {
        if (element.kind !== 'media_ref' || !object(element.payload)) return [];
        const type = element.payload.type;
        const reference = element.payload.reference;
        if (!['image', 'file', 'audio', 'video'].includes(String(type)) || typeof reference !== 'string') return [];
        return [{ type, reference, ...(typeof element.payload.fileName === 'string' ? { fileName: element.payload.fileName } : {}) }];
      });
      return requireConnectorOutboundDelivery({
        deliveryId: input.deliveryId,
        externalConversationId: binding.key,
        presentation: { header: input.envelope.actor.id, body: text, origin: input.envelope.actor.kind === 'cat' ? 'agent' : input.envelope.actor.kind === 'system' ? 'system' : 'direct' },
        ...(richBlocks.length === 0 ? {} : { richBlocks }),
        ...(media.length === 0 ? {} : { media }),
      });
    },
  };
}

function optionalString(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new TypeError(`${key} must be a declared string`);
  return value;
}

function forwardedWebhookBody(candidate: unknown): unknown {
  if (!object(candidate) || !object(candidate.request)) {
    throw new TypeError('feishu webhook action requires a forwarded request');
  }
  if (Object.keys(candidate).some(key => key !== 'request')) {
    throw new TypeError('feishu webhook action contains an unsupported field');
  }
  const request = candidate.request;
  if (request.method !== 'POST' || request.path !== 'feishu/events') {
    throw new TypeError('feishu webhook request must match the declared POST path');
  }
  return requireFeishuWebhookInput({ body: request.body }).body;
}

function webhookHttpResponse(result: FeishuWebhookResult) {
  switch (result.kind) {
    case 'challenge': return { status: 200, headers: {}, body: result.response };
    case 'processed': return { status: 200, headers: {}, body: { ok: true, messageId: result.messageId } };
    case 'skipped': return { status: 200, headers: {}, body: { ok: true, skipped: result.reason } };
    case 'error': return { status: result.status, headers: {}, body: { error: result.message } };
    default: throw new TypeError('feishu webhook runtime returned an invalid result');
  }
}

export function createFeishuPluginModule(createRuntime: RuntimeFactory = createFeishuConnectorRuntime) {
  return definePluginModule((manifest) => definePlugin({
    manifest,
    activate: {
      'feishu-messaging': async (context) => {
        const [appId, appSecret, modeValue, verificationToken, groupBotMentionsJson] = await Promise.all([
          context.config.get('appId'),
          context.secrets.get('appSecret'),
          context.config.get('connectionMode'),
          context.secrets.get('verificationToken'),
          context.config.get('groupBotMentionsJson'),
        ]);
        if (typeof appId !== 'string') throw new TypeError('appId must be a declared string');
        if (typeof appSecret !== 'string') throw new TypeError('appSecret must be a declared secret');
        const mode = modeValue === undefined ? 'webhook' : modeValue;
        if (mode !== 'webhook' && mode !== 'websocket') throw new TypeError('connectionMode must be webhook or websocket');
        const bridge = await createMessageBridge(context);
        const runtime = createRuntime({
          config: {
            appId,
            appSecret,
            connectionMode: mode,
            ...(verificationToken === '' ? {} : { verificationToken }),
            ...(optionalString(groupBotMentionsJson, 'groupBotMentionsJson') === undefined
              ? {} : { groupBotMentionsJson: groupBotMentionsJson as string }),
          },
          host: { deliver: bridge.deliver },
          logger: context.logger,
        });
        await runtime.start();
        return {
          actions: {
            'feishu.outbound': async (candidate) => {
              const input = await bridge.outbound(candidate);
              await runtime.outbound.sendFormattedReply(input.externalConversationId, {
                header: input.presentation.header,
                subtitle: input.presentation.subtitle ?? '',
                body: input.presentation.body,
                footer: input.presentation.footer ?? '',
                origin: input.presentation.origin === 'callback' ? 'callback' : 'agent',
                ...(input.presentation.cardActions === undefined
                  ? {} : { cardActions: input.presentation.cardActions.map(action => ({ label: action.label, value: { ...action.value } })) }),
              }, input.metadata);
              for (const media of input.media ?? []) {
                if (media.type === 'video') {
                  await runtime.outbound.sendReply(input.externalConversationId, `🎬 ${media.reference}`);
                } else {
                  await runtime.outbound.sendMedia(input.externalConversationId, {
                    type: media.type,
                    url: media.reference,
                    ...(media.fileName === undefined ? {} : { fileName: media.fileName }),
                  });
                }
              }
            },
            'feishu.webhook': async candidate => webhookHttpResponse(
              await runtime.handleWebhook({ body: forwardedWebhookBody(candidate) }),
            ),
          },
          dispose: () => runtime.stop(),
        };
      },
    },
  }));
}

export default createFeishuPluginModule();
