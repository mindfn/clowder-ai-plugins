import {
  definePlugin,
  definePluginModule,
  requireConnectorOutboundDelivery,
  type ConnectorOutboundDelivery,
  type FeatureContext,
  type PluginMessagingDelivery,
  type PluginMessagingDraft,
} from '@clowder-ai/plugin-sdk';

import {
  createXiaoyiConnectorRuntime,
  type XiaoyiConnectorRuntime,
  type XiaoyiConnectorRuntimeOptions,
  type XiaoyiHostInboundMessage,
} from './runtime.js';
import { XiaoyiAdapter } from './XiaoyiAdapter.js';
import { renderTypedMediaNotice } from './media-notice.js';
import { renderAllRichBlocksPlaintext } from './rich-block-plaintext.js';
import { createConnectorLifecycleAction } from './lifecycle-action.js';

type RuntimeFactory = (
  options: XiaoyiConnectorRuntimeOptions<XiaoyiAdapter>,
) => XiaoyiConnectorRuntime<XiaoyiAdapter>;

const CONNECTOR_ID = 'xiaoyi';
const IDENTITY_ID = 'xiaoyi-agent';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireDelivery(candidate: unknown): PluginMessagingDelivery {
  if (!object(candidate)) throw new TypeError('xiaoyi delivery must be an object');
  if (Object.keys(candidate).some(key => !['deliveryId', 'lifecycleId', 'threadId', 'envelope', 'presentation'].includes(key))) throw new TypeError('xiaoyi delivery contains an unsupported field');
  if (typeof candidate.deliveryId !== 'string' || candidate.deliveryId.length === 0) throw new TypeError('xiaoyi deliveryId must be non-empty');
  if (typeof candidate.threadId !== 'string' || candidate.threadId.length === 0) throw new TypeError('xiaoyi threadId must be non-empty');
  if (!object(candidate.envelope) || candidate.envelope.threadId !== candidate.threadId) throw new TypeError('xiaoyi delivery envelope must match threadId');
  return structuredClone(candidate) as unknown as PluginMessagingDelivery;
}

function draft(message: XiaoyiHostInboundMessage): PluginMessagingDraft {
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
      elements: [{ elementId: 'text-1', kind: 'text', payload: { text: message.text } }],
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
    async deliver(message: XiaoyiHostInboundMessage): Promise<void> {
      const thread = await context.threads.ensureByKey(message.externalConversationId, { title: `XiaoYi ${message.externalConversationId}`.slice(0, 200) });
      await subscribe(thread.id);
      await context.messaging.send(thread.id, draft(message));
    },
    async outbound(candidate: unknown): Promise<ConnectorOutboundDelivery> {
      const input = requireDelivery(candidate);
      const binding = (await context.threads.listBindings()).find(item => item.threadId === input.threadId);
      if (binding === undefined) throw new TypeError(`xiaoyi thread ${input.threadId} has no provider binding`);
      const text = input.envelope.payload.elements.flatMap((element) => {
        if (element.kind === 'text') return [element.payload.text];
        const notice = renderTypedMediaNotice(element, {
          elements: input.envelope.payload.elements,
          warnInvalid: elementId => context.log('warn', 'Invalid typed media notice ignored', { elementId }),
        });
        return notice === undefined ? [] : [notice];
      }).join('\n\n');
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

export function createXiaoyiPluginModule(createRuntime: RuntimeFactory = createXiaoyiConnectorRuntime) {
  return definePluginModule((manifest) => definePlugin({
    manifest,
    activate: {
      'xiaoyi-messaging': async (context) => {
        const [accessKey, secretKey, agentId] = await Promise.all([
          context.config.get('accessKey'),
          context.secrets.get('secretKey'),
          context.config.get('agentId'),
        ]);
        if (typeof accessKey !== 'string') throw new TypeError('accessKey must be a declared string');
        if (typeof agentId !== 'string') throw new TypeError('agentId must be a declared string');
        if (typeof secretKey !== 'string') throw new TypeError('secretKey must be a declared secret');
        const bridge = await createMessageBridge(context);
        const runtime = createRuntime({
          config: { accessKey, secretKey, agentId },
          host: { deliver: bridge.deliver },
          logger: context.logger,
        });
        await runtime.start();
        const lifecycle = createConnectorLifecycleAction(context, {
          sendPlaceholder: (externalConversationId, text) => runtime.outbound.sendPlaceholder(externalConversationId, text),
          editPlaceholder: () => runtime.outbound.editMessage(),
          sendRecovery: (externalConversationId, text) => runtime.outbound.sendReply(externalConversationId, text),
          settle: ({ externalConversationId, event }) => runtime.outbound.onDeliveryBatchDone(
            externalConversationId,
            event.chainDone,
          ),
        });
        return {
          actions: {
            'host.messaging.lifecycle': lifecycle,
            'xiaoyi.outbound': async (candidate) => {
              const input = await bridge.outbound(candidate);
              const text = [input.presentation.header, input.presentation.subtitle, input.presentation.body, input.presentation.footer]
                .filter((value): value is string => value !== undefined && value.length > 0)
                .join('\n\n');
              const blocks = [...(input.richBlocks ?? [])];
              await runtime.outbound.sendReply(
                input.externalConversationId,
                blocks.length > 0 ? text + '\n\n' + renderAllRichBlocksPlaintext(blocks) : text,
              );
              for (const media of input.media ?? []) {
                const label = media.type === 'audio' ? '语音'
                  : media.type === 'image' ? '图片'
                    : media.type === 'video' ? '视频'
                      : '文件';
                await runtime.outbound.sendReply(input.externalConversationId, `⚠️ 这条${label}无法在小艺里发送`);
              }
            },
          },
          dispose: () => runtime.stop(),
        };
      },
    },
  }));
}

export default createXiaoyiPluginModule();
