import {
  definePlugin,
  definePluginModule,
  requireConnectorOutboundDelivery,
  type ConnectorOutboundDelivery,
  type FeatureContext,
  type PluginMessagingDelivery,
  type PluginMessagingDraft,
} from '@clowder-ai/plugin-sdk';

import { WeComBotAdapter } from './WeComBotAdapter.js';
import {
  createWeComBotConnectorRuntime,
  type WeComBotConnectorRuntime,
  type WeComBotConnectorRuntimeOptions,
  type WeComBotHostInboundMessage,
} from './runtime.js';

type RuntimeFactory = (
  options: WeComBotConnectorRuntimeOptions<WeComBotAdapter>,
) => WeComBotConnectorRuntime<WeComBotAdapter>;

type ValidateCredentialsFn = (
  botId: string,
  secret: string,
) => Promise<{ valid: boolean; error?: string }>;

const CONNECTOR_ID = 'wecom-bot';
const IDENTITY_ID = 'wecom-bot';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireDelivery(candidate: unknown): PluginMessagingDelivery {
  if (!object(candidate)) throw new TypeError('wecom-bot delivery must be an object');
  if (Object.keys(candidate).some(key => !['deliveryId', 'threadId', 'envelope'].includes(key))) throw new TypeError('wecom-bot delivery contains an unsupported field');
  if (typeof candidate.deliveryId !== 'string' || candidate.deliveryId.length === 0) throw new TypeError('wecom-bot deliveryId must be non-empty');
  if (typeof candidate.threadId !== 'string' || candidate.threadId.length === 0) throw new TypeError('wecom-bot threadId must be non-empty');
  if (!object(candidate.envelope) || candidate.envelope.threadId !== candidate.threadId) throw new TypeError('wecom-bot delivery envelope must match threadId');
  return structuredClone(candidate) as unknown as PluginMessagingDelivery;
}

function draft(message: WeComBotHostInboundMessage): PluginMessagingDraft {
  return {
    idempotencyKey: message.providerMessageId,
    sourceEventId: message.providerMessageId,
    identity: IDENTITY_ID,
    sender: message.sender,
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
    async deliver(message: WeComBotHostInboundMessage): Promise<void> {
      const thread = await context.threads.ensureByKey(message.externalConversationId, { title: `WeCom ${message.externalConversationId}`.slice(0, 200) });
      await subscribe(thread.id);
      await context.messaging.send(thread.id, draft(message));
    },
    async outbound(candidate: unknown): Promise<ConnectorOutboundDelivery> {
      const input = requireDelivery(candidate);
      const binding = (await context.threads.listBindings()).find(item => item.threadId === input.threadId);
      if (binding === undefined) throw new TypeError(`wecom-bot thread ${input.threadId} has no provider binding`);
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

export function createWeComBotPluginModule(
  createRuntime: RuntimeFactory = createWeComBotConnectorRuntime,
  validateCredentials: ValidateCredentialsFn = (botId, secret) => WeComBotAdapter.validateCredentials(botId, secret),
) {
  return definePluginModule((manifest) => definePlugin({
    manifest,
    activate: {
      'wecom-bot-messaging': async (context) => {
        // Credentials may be filled only after the plugin is enabled — the runtime
        // starts healthy and idle (no provider stream) without them.
        const [botId, botSecret] = await Promise.all([
          context.config.get('botId'),
          context.secrets.get('botSecret'),
        ]);
        const bridge = await createMessageBridge(context);
        const runtime = createRuntime({
          config: {
            botId: typeof botId === 'string' ? botId : '',
            botSecret: typeof botSecret === 'string' ? botSecret : '',
          },
          host: { deliver: bridge.deliver },
          logger: context.logger,
        });
        await runtime.start();
        return {
          actions: {
            'wecom-bot.validate': async () => {
              const [currentBotId, currentSecret] = await Promise.all([
                context.config.get('botId'),
                context.secrets.get('botSecret'),
              ]);
              const id = typeof currentBotId === 'string' ? currentBotId.trim() : '';
              const secret = typeof currentSecret === 'string' ? currentSecret.trim() : '';
              if (id.length === 0 || secret.length === 0) {
                return {
                  render: 'status',
                  data: { status: 'error', message: '未填写 Bot ID / Bot Secret — 先在配置中填写并保存' },
                  advance: false,
                };
              }
              const result = await validateCredentials(id, secret);
              if (!result.valid) {
                return {
                  render: 'status',
                  data: { status: 'error', message: result.error ?? 'credentials rejected by provider' },
                  advance: false,
                };
              }
              await runtime.connect({ botId: id, botSecret: secret });
              return {
                render: 'status',
                data: { status: 'confirmed' },
                label: '已连接',
                targetValues: { botId: id, botSecret: secret },
              };
            },
            'wecom-bot.disconnect': async () => {
              await runtime.disconnect();
              return {
                render: 'status',
                data: { status: 'disconnected' },
                label: '已断开',
                targetValues: { botId: '', botSecret: '' },
              };
            },
            'wecom-bot.test': async () => {
              const ok = runtime.isConnected();
              return { ok, ...(ok ? {} : { message: '企微未连接（需要测试并连接）' }) };
            },
            'wecom-bot.outbound': async (candidate) => {
              const input = await bridge.outbound(candidate);
              const blocks = [...(input.richBlocks ?? [])];
              if (blocks.length > 0) {
                await runtime.outbound.sendRichMessage(
                  input.externalConversationId,
                  input.presentation.body,
                  blocks as unknown as Parameters<WeComBotAdapter['sendRichMessage']>[2],
                  input.presentation.header,
                  input.metadata,
                );
              } else {
                await runtime.outbound.sendFormattedReply(
                  input.externalConversationId,
                  {
                    header: input.presentation.header,
                    body: input.presentation.body,
                    origin: input.presentation.origin === 'callback' ? 'callback' : 'direct',
                    ...(input.presentation.subtitle === undefined ? {} : { subtitle: input.presentation.subtitle }),
                    ...(input.presentation.footer === undefined ? {} : { footer: input.presentation.footer }),
                  },
                  input.metadata,
                );
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
          },
          dispose: () => runtime.stop(),
        };
      },
    },
  }));
}

export default createWeComBotPluginModule();
