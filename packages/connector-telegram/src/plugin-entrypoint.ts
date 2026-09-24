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
  createTelegramConnectorRuntime,
  type TelegramHostInboundMessage,
  type TelegramConnectorRuntime,
  type TelegramConnectorRuntimeOptions,
} from './runtime.js';
import { TelegramAdapter } from './TelegramAdapter.js';
import { renderTypedMediaNotice } from './media-notice.js';
import { createInboundMediaSourceActions, releaseInboundMedia, retainInboundMedia } from './inbound-media-source.js';

type TelegramRuntimeFactory = (
  options: TelegramConnectorRuntimeOptions<TelegramAdapter>,
) => TelegramConnectorRuntime<TelegramAdapter>;

const CONNECTOR_ID = 'telegram';
const IDENTITY_ID = 'telegram-bot';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireDelivery(candidate: unknown): PluginMessagingDelivery {
  if (!object(candidate)) throw new TypeError('telegram delivery must be an object');
  if (Object.keys(candidate).some(key => !['deliveryId', 'threadId', 'envelope'].includes(key))) {
    throw new TypeError('telegram delivery contains an unsupported field');
  }
  if (typeof candidate.deliveryId !== 'string' || candidate.deliveryId.length === 0) {
    throw new TypeError('telegram deliveryId must be non-empty');
  }
  if (typeof candidate.threadId !== 'string' || candidate.threadId.length === 0) {
    throw new TypeError('telegram threadId must be non-empty');
  }
  if (!object(candidate.envelope) || candidate.envelope.threadId !== candidate.threadId) {
    throw new TypeError('telegram delivery envelope must match threadId');
  }
  return structuredClone(candidate) as unknown as PluginMessagingDelivery;
}

function threadTitle(externalConversationId: string): string {
  const value = `Telegram ${externalConversationId}`;
  return value.length <= 200 ? value : value.slice(0, 200);
}

async function draft(context: FeatureContext, message: TelegramHostInboundMessage): Promise<PluginMessagingDraft> {
  const media = await retainInboundMedia(
    context, CONNECTOR_ID, 'telegram-media', message.providerMessageId,
    (message.attachments ?? []).map(attachment => ({
      type: attachment.type, platformKey: attachment.platformKey,
      ...(attachment.fileName === undefined ? {} : { fileName: attachment.fileName }),
      ...(attachment.duration === undefined ? {} : { duration: attachment.duration }),
    })),
  );
  return {
    idempotencyKey: message.providerMessageId,
    sourceEventId: message.providerMessageId,
    identity: IDENTITY_ID,
    sender: { id: message.externalSenderId },
    payload: {
      provenance: {
        origin: {
          kind: 'external',
          connectorId: CONNECTOR_ID,
          sourceAddress: {
            connectorId: CONNECTOR_ID,
            chatId: message.externalConversationId,
            messageId: message.providerMessageId,
          },
        },
        epistemicStatus: 'observation',
      },
      elements: [
        { elementId: 'text-1', kind: 'text', payload: { text: message.text } },
        ...media,
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
    pending = context.messaging.subscribe(threadId, { contributionId: CONNECTOR_ID })
      .catch((error: unknown) => {
        if (subscriptions.get(threadId) === pending) subscriptions.delete(threadId);
        throw error;
      });
    subscriptions.set(threadId, pending);
    return pending;
  };
  for (const binding of await context.threads.listBindings()) await subscribe(binding.threadId);
  return {
    async deliver(message: TelegramHostInboundMessage): Promise<void> {
      const thread = await context.threads.ensureByKey(message.externalConversationId, {
        title: threadTitle(message.externalConversationId),
      });
      await subscribe(thread.id);
      const prepared = await draft(context, message);
      try {
        await context.messaging.send(thread.id, prepared);
      } catch (error) {
        await releaseInboundMedia(context, prepared.payload.elements, error);
        throw error;
      }
    },
    async outbound(candidate: unknown): Promise<ConnectorOutboundDelivery> {
      const input = requireDelivery(candidate);
      const binding = (await context.threads.listBindings()).find(item => item.threadId === input.threadId);
      if (binding === undefined) throw new TypeError(`telegram thread ${input.threadId} has no provider binding`);
      const text = input.envelope.payload.elements.flatMap((element) => {
        if (element.kind === 'text') return [element.payload.text];
        const notice = renderTypedMediaNotice(element, {
          elements: input.envelope.payload.elements,
          warnInvalid: elementId => context.log('warn', 'Invalid typed media notice ignored', { elementId }),
        });
        return notice === undefined ? [] : [notice];
      }).join('\n\n');
      const richBlocks = input.envelope.payload.elements
        .filter(element => element.kind === 'rich_block')
        .map(element => element.payload);
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
        presentation: {
          header: input.envelope.actor.id,
          body: text,
          origin: input.envelope.actor.kind === 'cat' ? 'agent' : input.envelope.actor.kind === 'system' ? 'system' : 'direct',
        },
        ...(richBlocks.length === 0 ? {} : { richBlocks }),
        ...(media.length === 0 ? {} : { media }),
      });
    },
  };
}

async function deliver(
  adapter: TelegramAdapter,
  input: ConnectorOutboundDelivery,
  context: FeatureContext,
): Promise<void> {
  const blocks = [...(input.richBlocks ?? [])];
  if (blocks.length > 0) {
    await adapter.sendRichMessage(
      input.externalConversationId,
      input.presentation.body,
      blocks as unknown as Parameters<TelegramAdapter['sendRichMessage']>[2],
      input.presentation.header,
    );
  } else {
    const text = [input.presentation.subtitle, input.presentation.body, input.presentation.footer]
      .filter((value): value is string => value !== undefined && value.length > 0)
      .join('\n\n');
    await adapter.sendReply(input.externalConversationId, text);
  }
  for (const media of input.media ?? []) {
    if (media.type === 'video') {
      await adapter.sendReply(input.externalConversationId, '⚠️ 视频附件暂不支持发送');
      continue;
    }
    if (!media.reference.startsWith('hmr_')) {
      await adapter.sendReply(input.externalConversationId, '⚠️ 媒体不可用（旧引用无法读取）');
      continue;
    }
    try {
      await adapter.sendMedia(input.externalConversationId, {
        type: media.type,
        content: context.media.read(media.reference),
        ...(media.fileName === undefined ? {} : { fileName: media.fileName }),
      });
    } catch (error) {
      context.log('warn', 'Telegram outbound media delivery failed', {
        mediaType: media.type,
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      await adapter.sendReply(
        input.externalConversationId,
        error instanceof RangeError ? '⚠️ 媒体过大，超过 Telegram 发送上限' : '⚠️ 媒体不可用（读取或上传失败）',
      );
    }
  }
}

export function createTelegramPluginModule(
  createRuntime: TelegramRuntimeFactory = createTelegramConnectorRuntime,
) {
  return definePluginModule((manifest) => definePlugin({
    manifest,
    activate: {
      'telegram-messaging': async (context) => {
        const botToken = await context.secrets.get('botToken');
        const bridge = await createMessageBridge(context);
        // The feature stays activatable without a token so telegram.test can
        // report the not-configured state; polling starts once a token exists.
        const runtime = typeof botToken === 'string' && botToken.trim().length > 0
          ? createRuntime({
            config: { botToken },
            host: { deliver: bridge.deliver },
            logger: context.logger,
          })
          : undefined;
        await runtime?.start();
        const mediaSource = createInboundMediaSourceActions(context, async locator => {
          if (runtime === undefined) throw new Error('Telegram Bot Token 未配置');
          return runtime.outbound.downloadInboundMedia(locator);
        });
        return {
          actions: {
            'telegram.media-source.read': mediaSource.read,
            'telegram.media-source.settle': mediaSource.settle,
            'telegram.test': async () => {
              if (runtime === undefined) return { ok: false, message: 'Telegram Bot Token 未配置' };
              const ok = runtime.isPolling();
              return { ok, ...(ok ? {} : { message: 'Telegram 未在轮询（Token 已配置）' }) };
            },
            'telegram.outbound': async (input) => {
              if (runtime === undefined) throw new Error('Telegram Bot Token 未配置');
              return deliver(runtime.outbound, await bridge.outbound(input), context);
            },
          },
          dispose: () => runtime?.stop() ?? Promise.resolve(),
        };
      },
    },
  }));
}

export default createTelegramPluginModule();
