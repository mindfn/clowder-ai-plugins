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
  createWeixinConnectorRuntime,
  type WeixinConnectorRuntime,
  type WeixinConnectorRuntimeOptions,
  type WeixinHostInboundMessage,
} from './runtime.js';
import { WeixinAdapter, type WeixinSessionState, type WeixinSessionStateStore } from './WeixinAdapter.js';
import { renderTypedMediaNotice } from './media-notice.js';
import { renderAllRichBlocksPlaintext } from './rich-block-plaintext.js';

type RuntimeFactory = (
  options: WeixinConnectorRuntimeOptions<WeixinAdapter>,
) => WeixinConnectorRuntime<WeixinAdapter>;

const CONNECTOR_ID = 'weixin';
const IDENTITY_ID = 'weixin-bot';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireDelivery(candidate: unknown): PluginMessagingDelivery {
  if (!object(candidate)) throw new TypeError('weixin delivery must be an object');
  if (Object.keys(candidate).some(key => !['deliveryId', 'threadId', 'envelope'].includes(key))) throw new TypeError('weixin delivery contains an unsupported field');
  if (typeof candidate.deliveryId !== 'string' || candidate.deliveryId.length === 0) throw new TypeError('weixin deliveryId must be non-empty');
  if (typeof candidate.threadId !== 'string' || candidate.threadId.length === 0) throw new TypeError('weixin threadId must be non-empty');
  if (!object(candidate.envelope) || candidate.envelope.threadId !== candidate.threadId) throw new TypeError('weixin delivery envelope must match threadId');
  return structuredClone(candidate) as unknown as PluginMessagingDelivery;
}

function draft(message: WeixinHostInboundMessage): PluginMessagingDraft {
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
    async deliver(message: WeixinHostInboundMessage): Promise<void> {
      const thread = await context.threads.ensureByKey(message.externalConversationId, { title: `WeChat ${message.externalConversationId}`.slice(0, 200) });
      await subscribe(thread.id);
      await context.messaging.send(thread.id, draft(message));
    },
    async outbound(candidate: unknown): Promise<ConnectorOutboundDelivery> {
      const input = requireDelivery(candidate);
      const binding = (await context.threads.listBindings()).find(item => item.threadId === input.threadId);
      if (binding === undefined) throw new TypeError(`weixin thread ${input.threadId} has no provider binding`);
      const text = input.envelope.payload.elements.flatMap((element) => {
        if (element.kind === 'text') return [element.payload.text];
        const notice = renderTypedMediaNotice(element);
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

function optionalString(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new TypeError(`${key} must be a declared string`);
  return value;
}

function optionalBoolean(value: unknown, key: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new TypeError(`${key} must be a declared boolean`);
  return value;
}

function sessionStatePort(context: FeatureContext): WeixinSessionStateStore {
  return {
    async load() {
      const value = await context.state.get('provider-session');
      return value !== null && typeof value === 'object' ? value as WeixinSessionState : null;
    },
    async save(value) { await context.state.set('provider-session', value); },
    async clear() { await context.state.set('provider-session', null); },
  };
}

export function createWeixinPluginModule(createRuntime: RuntimeFactory = createWeixinConnectorRuntime) {
  return definePluginModule((manifest) => definePlugin({
    manifest,
    activate: {
      'weixin-messaging': async (context) => {
        const [botToken, voiceItemMode, unsafeModesValue, captureVoiceValue] = await Promise.all([
          context.secrets.get('botToken'),
          context.config.get('voiceItemMode'),
          context.config.get('enableUnsafeVoiceModes'),
          context.config.get('captureInboundVoiceMedia'),
        ]);
        const mode = optionalString(voiceItemMode, 'voiceItemMode');
        if (mode !== undefined && !['minimal', 'playtime', 'playtime-sec', 'playtime-encode', 'metadata'].includes(mode)) {
          throw new TypeError('voiceItemMode is not declared by the manifest');
        }
        const unsafeModes = optionalBoolean(unsafeModesValue, 'enableUnsafeVoiceModes');
        const captureVoice = optionalBoolean(captureVoiceValue, 'captureInboundVoiceMedia');
        // Credentials may arrive only later via the weixin_qr_login operation —
        // the runtime starts healthy and idle (no connect, no polling) without them.
        const token = typeof botToken === 'string' ? botToken : '';
        const bridge = await createMessageBridge(context);
        const runtime = createRuntime({
          config: {
            botToken: token,
            ...(mode === undefined ? {} : { voiceItemMode: mode as 'minimal' | 'playtime' | 'playtime-sec' | 'playtime-encode' | 'metadata' }),
            ...(unsafeModes === undefined ? {} : { enableUnsafeVoiceModes: unsafeModes }),
            ...(captureVoice === undefined ? {} : { captureInboundVoiceMedia: captureVoice }),
          },
          state: sessionStatePort(context),
          host: { deliver: bridge.deliver },
          logger: context.logger,
        });
        await runtime.start();
        // Operation state (the in-flight QR payload) lives in runtime memory only —
        // the Host does not pass operation state back to the package.
        let qrPayload: string | undefined;
        return {
          actions: {
            'weixin.qr-generate': async () => {
              const result = await WeixinAdapter.fetchQrCode();
              qrPayload = result.qrPayload;
              // iLink returns a webpage URL, not an image — encode it as a real QR PNG.
              const QRCode = await import('qrcode');
              const url = await QRCode.toDataURL(result.qrUrl, { width: 384, margin: 2 });
              return { render: 'img', data: { url } };
            },
            'weixin.qr-status': async () => {
              if (qrPayload === undefined) {
                return { render: 'polling', data: { status: 'error', message: 'No QR payload — generate first' }, advance: false };
              }
              const status = await WeixinAdapter.pollQrCodeStatus(qrPayload);
              if (status.status === 'confirmed') {
                if (!status.botToken) {
                  return { render: 'polling', data: { status: 'error', message: 'confirmed but no bot_token' }, advance: false };
                }
                await runtime.connect(status.botToken);
                qrPayload = undefined;
                return {
                  render: 'status',
                  data: { status: 'confirmed' },
                  label: '已连接',
                  targetValues: { botToken: status.botToken },
                };
              }
              if (status.status === 'waiting' || status.status === 'scanned') {
                return { render: 'polling', data: { status: status.status }, advance: false };
              }
              return {
                render: 'polling',
                data: { status: status.status, ...(status.status === 'error' ? { message: status.message } : {}) },
                advance: false,
              };
            },
            'weixin.disconnect': async () => {
              qrPayload = undefined;
              await runtime.disconnect();
              return {
                render: 'status',
                data: { status: 'disconnected' },
                label: '已断开',
                targetValues: { botToken: '' },
              };
            },
            'weixin.test': async () => {
              const ok = runtime.isConnected();
              return { ok, ...(ok ? {} : { message: '微信未连接（需要扫码登录）' }) };
            },
            'weixin.outbound': async (candidate) => {
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

export default createWeixinPluginModule();
