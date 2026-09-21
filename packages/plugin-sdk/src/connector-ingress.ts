import type {
  MediaRefMessageElement,
  MessageDraft,
  MessageElement,
  TextMessageElement,
} from '@clowder-ai/plugin-contract';

import type { ConnectorInboundMessage, FeatureContext } from './feature-context.js';

/**
 * Host-projected config key carrying the thread handle issued at activation.
 *
 * ASSUMPTION (Train C1): the frozen activation row (`broker.ready`) carries only
 * `bindingNonce` and the session binding has no handle field, so the Host issues
 * the connector's inbound thread handle through its projected config namespace
 * under this key. The builtin runtime must populate it before `activate` runs;
 * if it is absent the connector cannot address inbound platform messages and
 * activation fails closed with a clear error.
 */
export const INBOUND_THREAD_HANDLE_CONFIG_KEY = 'messaging.inboundThreadHandle';

export class InboundThreadHandleMissingError extends Error {
  constructor(key: string) {
    super(
      `Host did not issue an inbound thread handle at activation `
      + `(expected config key "${key}" to hold a non-empty thread handle string)`,
    );
    this.name = 'InboundThreadHandleMissingError';
  }
}

/** Reads the Host-issued inbound thread handle; this is the single place the handle is consumed. */
export async function requireInboundThreadHandle(context: FeatureContext): Promise<string> {
  const value = await context.config.get(INBOUND_THREAD_HANDLE_CONFIG_KEY);
  if (typeof value !== 'string' || value.length === 0) {
    throw new InboundThreadHandleMissingError(INBOUND_THREAD_HANDLE_CONFIG_KEY);
  }
  return value;
}

export interface InboundMessageSenderOptions {
  /** The context messaging send client (builtin transport routes through the Host adapter). */
  readonly send: FeatureContext['messaging']['send'];
  /** Host-issued thread handle the inbound platform thread is addressed to. */
  readonly threadHandle: string;
  /** Connector contribution id; becomes the external provenance connectorId. */
  readonly connectorId: string;
}

export interface InboundMessageSender {
  /** Delivers one provider-fact inbound message to the Host-owned inbound thread. */
  deliver(message: ConnectorInboundMessage): Promise<void>;
}

function draftElements(message: ConnectorInboundMessage): readonly MessageElement[] {
  const text: TextMessageElement = {
    elementId: 'text-1',
    kind: 'text',
    payload: { text: message.text },
  };
  const media: readonly MediaRefMessageElement[] = (message.attachments ?? []).map((attachment, index) => ({
    elementId: `media-${index + 1}`,
    kind: 'media_ref',
    payload: {
      type: attachment.type,
      reference: attachment.platformKey,
      ...(attachment.fileName === undefined ? {} : { fileName: attachment.fileName }),
      ...(attachment.duration === undefined ? {} : { duration: attachment.duration }),
    },
  }));
  return [text, ...media];
}

/**
 * Maps provider facts to one frozen `messaging.send` MessageDraft addressed to
 * the Host-issued thread handle. The plugin supplies only observations; the
 * Host remains the admission, identity, and formatting authority downstream.
 *
 * The frozen draft shape cannot represent sender/conversation metadata, so only
 * text and attachment references cross this boundary.
 */
export function createInboundMessageSender(options: InboundMessageSenderOptions): InboundMessageSender {
  return {
    async deliver(message: ConnectorInboundMessage): Promise<void> {
      const draft: MessageDraft = {
        address: { kind: 'thread_handle', handle: options.threadHandle },
        idempotencyKey: message.providerMessageId,
        payload: {
          provenance: {
            origin: {
              kind: 'external',
              connectorId: options.connectorId,
              sourceAddress: {
                connectorId: options.connectorId,
                chatId: message.externalConversationId,
                messageId: message.providerMessageId,
              },
            },
            epistemicStatus: 'observation',
          },
          elements: draftElements(message),
        },
      };
      await options.send(draft);
    },
  };
}
