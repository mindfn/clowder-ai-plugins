import {
  definePlugin,
  definePluginModule,
  requireConnectorOutboundDelivery,
  type ConnectorOutboundDelivery,
  type FeatureContext,
  type PluginMessagingDelivery,
  type PluginMessagingDraft,
} from '@clowder-ai/plugin-sdk';

import { WeComAgentAdapter } from './WeComAgentAdapter.js';
import { renderAllRichBlocksPlaintext } from './rich-block-plaintext.js';
import {
  createWeComAgentConnectorRuntime,
  requireWeComAgentWebhookInput,
  type WeComAgentConnectorRuntime,
  type WeComAgentConnectorRuntimeOptions,
  type WeComAgentHostInboundMessage,
  type WeComAgentWebhookInput,
  type WeComAgentWebhookResult,
} from './runtime.js';

type RuntimeFactory = (
  options: WeComAgentConnectorRuntimeOptions<WeComAgentAdapter>,
) => WeComAgentConnectorRuntime<WeComAgentAdapter>;

const CONNECTOR_ID = 'wecom-agent';
const IDENTITY_ID = 'wecom-agent';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireDelivery(candidate: unknown): PluginMessagingDelivery {
  if (!object(candidate)) throw new TypeError('wecom-agent delivery must be an object');
  if (Object.keys(candidate).some(key => !['deliveryId', 'threadId', 'envelope'].includes(key))) {
    throw new TypeError('wecom-agent delivery contains an unsupported field');
  }
  if (typeof candidate.deliveryId !== 'string' || candidate.deliveryId.length === 0) throw new TypeError('wecom-agent deliveryId must be non-empty');
  if (typeof candidate.threadId !== 'string' || candidate.threadId.length === 0) throw new TypeError('wecom-agent threadId must be non-empty');
  if (!object(candidate.envelope) || candidate.envelope.threadId !== candidate.threadId) throw new TypeError('wecom-agent delivery envelope must match threadId');
  return structuredClone(candidate) as unknown as PluginMessagingDelivery;
}

function draft(message: WeComAgentHostInboundMessage): PluginMessagingDraft {
  return {
    idempotencyKey: message.providerMessageId,
    sourceEventId: message.providerMessageId,
    identity: IDENTITY_ID,
    sender: { id: message.externalSenderId },
    payload: {
      provenance: {
        origin: { kind: 'external', connectorId: CONNECTOR_ID, sourceAddress: { connectorId: CONNECTOR_ID, chatId: message.externalConversationId, messageId: message.providerMessageId } },
        epistemicStatus: 'observation',
      },
      elements: [
        { elementId: 'text-1', kind: 'text', payload: { text: message.text } },
        ...(message.attachments ?? []).map((attachment, index) => ({
          elementId: `media-${index + 1}`, kind: 'media_ref' as const,
          payload: { type: attachment.type, reference: attachment.platformKey, ...(attachment.fileName === undefined ? {} : { fileName: attachment.fileName }) },
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
    async deliver(message: WeComAgentHostInboundMessage): Promise<void> {
      const thread = await context.threads.ensureByKey(message.externalConversationId, { title: `WeCom ${message.externalConversationId}`.slice(0, 200) });
      await subscribe(thread.id);
      await context.messaging.send(thread.id, draft(message));
    },
    async outbound(candidate: unknown): Promise<ConnectorOutboundDelivery> {
      const input = requireDelivery(candidate);
      const binding = (await context.threads.listBindings()).find(item => item.threadId === input.threadId);
      if (binding === undefined) throw new TypeError(`wecom-agent thread ${input.threadId} has no provider binding`);
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

function forwardedWebhookInput(candidate: unknown): WeComAgentWebhookInput {
  if (!object(candidate) || !object(candidate.request)) {
    throw new TypeError('wecom-agent webhook action requires a forwarded request');
  }
  if (Object.keys(candidate).some(key => key !== 'request')) {
    throw new TypeError('wecom-agent webhook action contains an unsupported field');
  }
  const request = candidate.request;
  if ((request.method !== 'GET' && request.method !== 'POST') || request.path !== 'connectors/wecom-agent') {
    throw new TypeError('wecom-agent webhook request must match the declared GET or POST path');
  }
  return requireWeComAgentWebhookInput({ body: request.body, query: request.query });
}

function webhookHttpResponse(result: WeComAgentWebhookResult) {
  switch (result.kind) {
    case 'challenge': return { status: 200, headers: { 'content-type': 'text/plain' }, body: result.response };
    case 'processed': return { status: 200, headers: {}, body: { ok: true, messageId: result.messageId } };
    case 'skipped': return { status: 200, headers: {}, body: { ok: true, skipped: result.reason } };
    case 'error': return { status: result.status, headers: {}, body: { error: result.message } };
    default: throw new TypeError('wecom-agent webhook runtime returned an invalid result');
  }
}

export function createWeComAgentPluginModule(createRuntime: RuntimeFactory = createWeComAgentConnectorRuntime) {
  return definePluginModule((manifest) => definePlugin({
    manifest,
    activate: {
      'wecom-agent-messaging': async (context) => {
        const [corpId, agentId, agentSecret, callbackToken, encodingAesKey] = await Promise.all([
          context.config.get('corpId'),
          context.config.get('agentId'),
          context.secrets.get('agentSecret'),
          context.secrets.get('callbackToken'),
          context.secrets.get('encodingAesKey'),
        ]);
        if (typeof corpId !== 'string') throw new TypeError('corpId must be a declared string');
        if (typeof agentId !== 'string') throw new TypeError('agentId must be a declared string');
        if (typeof agentSecret !== 'string') throw new TypeError('agentSecret must be a declared secret');
        if (typeof callbackToken !== 'string') throw new TypeError('callbackToken must be a declared secret');
        if (typeof encodingAesKey !== 'string') throw new TypeError('encodingAesKey must be a declared secret');
        const bridge = await createMessageBridge(context);
        const runtime = createRuntime({
          config: { corpId, agentId, agentSecret, callbackToken, encodingAesKey },
          host: { deliver: bridge.deliver },
          logger: context.logger,
        });
        await runtime.start();
        return {
          actions: {
            'wecom-agent.outbound': async (candidate) => {
              const input = await bridge.outbound(candidate);
              const blocks = [...(input.richBlocks ?? [])];
              if (blocks.length > 0) {
                await runtime.outbound.sendReply(
                  input.externalConversationId,
                  input.presentation.body + '\n\n' + renderAllRichBlocksPlaintext(blocks),
                );
              } else {
                await runtime.outbound.sendFormattedReply(input.externalConversationId, {
                  header: input.presentation.header,
                  body: input.presentation.body,
                  origin: input.presentation.origin === 'callback' ? 'callback' : 'direct',
                  ...(input.presentation.subtitle === undefined ? {} : { subtitle: input.presentation.subtitle }),
                  ...(input.presentation.footer === undefined ? {} : { footer: input.presentation.footer }),
                });
              }
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
            'wecom-agent.webhook': async candidate => webhookHttpResponse(
              await runtime.handleWebhook(forwardedWebhookInput(candidate)),
            ),
          },
          dispose: () => runtime.stop(),
        };
      },
    },
  }));
}

export default createWeComAgentPluginModule();
