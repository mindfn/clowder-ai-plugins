import {
  type CloudBridgeFailureDiagnosticV1,
  type CloudConversationAckResult,
  type CloudConversationAppendMessageResult,
  type CloudConversationListResult,
  isCloudBridgeFailureDiagnosticV1,
  isCloudConversationAckInput,
  isCloudConversationAppendMessageInput,
} from '@clowder-ai/plugin-contract';

import {
  createPersonalChromeHostAdapter,
  isPersonalChromeNotInstalled,
  readPersonalChromeAdapterOptions,
} from './pairing-record.js';
import { PersonalChromeHostError, PersonalChromeHostRequestTracker, type PersonalChromeHostAdapterOptions } from './personal-chrome-host-transport.js';
import type { PersonalChromeAssistantReturnCursor } from './assistant-return-cursor.js';

export interface PersonalChromeConversationHostOperations {
  readonly appendMessage: (input: unknown) => Promise<CloudConversationAppendMessageResult>;
  readonly list: (input: unknown) => Promise<CloudConversationListResult>;
  readonly ack: (input: unknown) => Promise<CloudConversationAckResult>;
  /** Honest reachability probe for the `test` action: never claims ok without a real probe. */
  readonly probe: () => Promise<{ readonly ok: boolean; readonly message: string }>;
  readonly dispose: () => Promise<void>;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asContractDiagnostic(diagnostic: unknown): Record<string, unknown> {
  return isCloudBridgeFailureDiagnosticV1(diagnostic) ? { diagnostic } : {};
}

function appendFailure(
  errorCode: string,
  extras: Readonly<Record<string, unknown>> = {},
): CloudConversationAppendMessageResult {
  return { status: 'failed', errorCode, ...extras } as CloudConversationAppendMessageResult;
}

function ackFailure(errorCode: string, extras: Readonly<Record<string, unknown>> = {}): CloudConversationAckResult {
  return { status: 'failed', errorCode, ...extras } as CloudConversationAckResult;
}

/**
 * Resolves the pairing record from the granted data directory. A missing record
 * is one of the three (e) cases and maps to HOST_UNAVAILABLE; a corrupt record is
 * INVALID_CONFIGURATION. Both are PersonalChromeHostError codes passed through.
 */
async function resolveAdapterOptions(
  dataDirectory: string,
): Promise<PersonalChromeHostAdapterOptions> {
  try {
    return await readPersonalChromeAdapterOptions(dataDirectory);
  } catch (error) {
    if (isPersonalChromeNotInstalled(error)) {
      throw new PersonalChromeHostError('HOST_UNAVAILABLE', 'personal Chrome host is not installed');
    }
    throw error;
  }
}

function toCursor(value: unknown): PersonalChromeAssistantReturnCursor | undefined {
  if (!isObjectRecord(value)) return undefined;
  const { conversationId, sourceMessageId, assistantMessageId } = value;
  if (
    typeof conversationId !== 'string' ||
    typeof sourceMessageId !== 'string' ||
    typeof assistantMessageId !== 'string'
  ) {
    return undefined;
  }
  return { conversationId, sourceMessageId, assistantMessageId };
}

/**
 * The three cloud-conversation-host methods (contract beta.24 h3) backed by the
 * package's own native-host socket client. None of these throw: the Host treats
 * any throw after the call as AMBIGUOUS_EFFECT, so every failure is returned as
 * data per the (d) error-code table and every result passes the contract
 * validators with no extra fields.
 */
export function createConversationHostOperations(options: {
  readonly dataDirectory: string;
  readonly timeoutMs?: number;
}): PersonalChromeConversationHostOperations {
  const { dataDirectory } = options;
  let disposed = false;
  // Cancels every in-flight helper request on stop: dispose destroys their
  // sockets and settles the pending promises (written ones as AMBIGUOUS_EFFECT)
  // instead of leaking them until their timeouts (ledger h3 (e)).
  const requestTracker = new PersonalChromeHostRequestTracker();

  const appendMessage = async (input: unknown): Promise<CloudConversationAppendMessageResult> => {
    if (disposed) return appendFailure('HOST_UNAVAILABLE');
    if (!isCloudConversationAppendMessageInput(input)) {
      return appendFailure('INVALID_REQUEST');
    }
    let adapterOptions: PersonalChromeHostAdapterOptions;
    try {
      adapterOptions = {
        ...(await resolveAdapterOptions(dataDirectory)),
        timeoutMs: options.timeoutMs,
        requestTracker,
      };
    } catch (error) {
      if (error instanceof PersonalChromeHostError) return appendFailure(error.code);
      return appendFailure('AMBIGUOUS_EFFECT');
    }
    // Stop may have run while the pairing record was being read: no socket has
    // been created yet, so nothing was sent and HOST_UNAVAILABLE stays truthful
    // (cancelAll alone cannot cover requests that register after it returns).
    if (disposed) return appendFailure('HOST_UNAVAILABLE');
    try {
      const receipt = await createPersonalChromeHostAdapter(adapterOptions).append_message(
        input.conversationId,
        input.text,
        input.idempotencyKey,
      );
      return {
        status: 'appended',
        providerMessageId: receipt.hostMessageId,
        ...(receipt.idempotentReplay === undefined ? {} : { idempotentReplay: receipt.idempotentReplay }),
      };
    } catch (error) {
      if (error instanceof PersonalChromeHostError) {
        return appendFailure(error.code, {
          ...asContractDiagnostic(error.diagnostic),
          ...(error.idempotentReplay === undefined ? {} : { idempotentReplay: error.idempotentReplay }),
        });
      }
      // The request may have reached the helper; without a typed code the only
      // truthful answer is "effect unknown" (ledger h3 (e)).
      return appendFailure('AMBIGUOUS_EFFECT');
    }
  };

  const list = async (input: unknown): Promise<CloudConversationListResult> => {
    if (disposed) return { returns: [] };
    let adapterOptions: PersonalChromeHostAdapterOptions;
    try {
      adapterOptions = {
        ...(await resolveAdapterOptions(dataDirectory)),
        timeoutMs: options.timeoutMs,
        requestTracker,
      };
    } catch {
      // Unreachable helper is an empty poll round, not an error (Host h3b backs
      // off on its own cadence); failed lists never log here.
      return { returns: [] };
    }
    // Stop during pairing resolution: nothing sent yet, report an empty round.
    if (disposed) return { returns: [] };
    try {
      const after = toCursor(isObjectRecord(input) ? input.after : undefined);
      const returns = await createPersonalChromeHostAdapter(adapterOptions).list_assistant_returns(after);
      return { returns: [...returns] };
    } catch {
      return { returns: [] };
    }
  };

  const ack = async (input: unknown): Promise<CloudConversationAckResult> => {
    if (disposed) return ackFailure('HOST_UNAVAILABLE');
    if (!isCloudConversationAckInput(input)) {
      return ackFailure('INVALID_REQUEST');
    }
    let adapterOptions: PersonalChromeHostAdapterOptions;
    try {
      adapterOptions = {
        ...(await resolveAdapterOptions(dataDirectory)),
        timeoutMs: options.timeoutMs,
        requestTracker,
      };
    } catch (error) {
      if (error instanceof PersonalChromeHostError) return ackFailure(error.code);
      return ackFailure('AMBIGUOUS_EFFECT');
    }
    // Stop during pairing resolution: no socket created, nothing was sent.
    if (disposed) return ackFailure('HOST_UNAVAILABLE');
    try {
      await createPersonalChromeHostAdapter(adapterOptions).ack_assistant_return(
        input.conversationId,
        input.sourceMessageId,
        input.assistantMessageId,
      );
      return { status: 'acknowledged' };
    } catch (error) {
      if (error instanceof PersonalChromeHostError) {
        // ASSISTANT_RETURN_NOT_FOUND means the return is already settled; pass it
        // through so the Host stops retrying that entry.
        return ackFailure(error.code, asContractDiagnostic(error.diagnostic));
      }
      return ackFailure('AMBIGUOUS_EFFECT');
    }
  };

  const probe = async (): Promise<{ readonly ok: boolean; readonly message: string }> => {
    if (disposed) return { ok: false, message: 'personal Chrome host module is stopped' };
    let adapterOptions: PersonalChromeHostAdapterOptions;
    try {
      adapterOptions = {
        ...(await resolveAdapterOptions(dataDirectory)),
        timeoutMs: options.timeoutMs,
        requestTracker,
      };
    } catch (error) {
      if (error instanceof PersonalChromeHostError && error.code === 'HOST_UNAVAILABLE') {
        return { ok: false, message: 'personal Chrome host is not installed (no pairing record)' };
      }
      if (error instanceof PersonalChromeHostError) {
        return { ok: false, message: `personal Chrome pairing record rejected: ${error.code}` };
      }
      return { ok: false, message: 'personal Chrome pairing record is unreadable' };
    }
    // Stop during pairing resolution: never probe after stop returned.
    if (disposed) return { ok: false, message: 'personal Chrome host module is stopped' };
    try {
      const health = await createPersonalChromeHostAdapter(adapterOptions).check_health();
      if (health.status === 'ready') {
        return { ok: true, message: 'personal Chrome host helper answered the health probe' };
      }
      const reason = health.errorCode ?? health.status;
      return { ok: false, message: `personal Chrome host health probe reported ${reason}` };
    } catch (error) {
      if (error instanceof PersonalChromeHostError) {
        return { ok: false, message: `personal Chrome host is not reachable: ${error.code}` };
      }
      return { ok: false, message: 'personal Chrome host health probe failed unexpectedly' };
    }
  };

  return {
    appendMessage,
    list,
    ack,
    probe,
    dispose: async () => {
      disposed = true;
      requestTracker.cancelAll();
    },
  };
}
