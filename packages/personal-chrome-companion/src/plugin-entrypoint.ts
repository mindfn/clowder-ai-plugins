import { join } from 'node:path';

import type {
  CloudConversationHostContribution,
  OperationActionResult,
  OperationRow,
} from '@clowder-ai/plugin-contract';
import {
  definePlugin,
  definePluginModule,
  operationRowAction,
  rowsResult,
  type FeatureContext,
} from '@clowder-ai/plugin-sdk';

import {
  PERSONAL_CHROME_AUTHORIZATION_LIMIT,
  PersonalChromeConversationAuthorizationError,
  readPersonalChromeConversationAuthorizations,
  revokePersonalChromeConversation,
  type PersonalChromeConversationAuthorization,
  type PersonalChromeConversationAuthorizationCollection,
} from '../native-host/conversation-binding.mjs';
import {
  projectConversationTitles,
  readConversationTitles,
  type PersonalChromeConversationTitle,
} from '../native-host/conversation-titles.mjs';

export const PERSONAL_CHROME_FEATURE_ID = 'personal-chrome-host';
export const PERSONAL_CHROME_HOST_CONTRIBUTION_ID = 'personal-chrome-chatgpt-host';
export const PERSONAL_CHROME_LIST_METHOD = 'personal-chrome-host.authorizations.list';
export const PERSONAL_CHROME_REVOKE_METHOD = 'personal-chrome-host.authorizations.revoke';
export const PERSONAL_CHROME_STATUS_METHOD = 'personal-chrome-host.authorizations.status';
export const PERSONAL_CHROME_TEST_METHOD = 'personal-chrome-host.test';
export const PERSONAL_CHROME_APPEND_MESSAGE_METHOD = 'personal-chrome-host.append-message';
export const PERSONAL_CHROME_ASSISTANT_LIST_METHOD = 'personal-chrome-host.assistant-returns.list';
export const PERSONAL_CHROME_ASSISTANT_ACK_METHOD = 'personal-chrome-host.assistant-returns.ack';

const REVOKE_ROW_ACTION_ID = 'revoke';
const NO_AUTHORIZATION_EMPTY_TEXT =
  'No ChatGPT conversation is authorized yet. Authorize an exact https://chatgpt.com/c/<id> conversation first.';

export const personalChromeHostContribution: Omit<CloudConversationHostContribution, 'type'> = {
  id: PERSONAL_CHROME_HOST_CONTRIBUTION_ID,
  provider: 'chatgpt',
  appendMessage: { method: PERSONAL_CHROME_APPEND_MESSAGE_METHOD },
  assistantReturns: {
    list: { method: PERSONAL_CHROME_ASSISTANT_LIST_METHOD },
    ack: { method: PERSONAL_CHROME_ASSISTANT_ACK_METHOD },
  },
};

function truncateChars(value: string, limit: number): string {
  return [...value].slice(0, limit).join('');
}

/**
 * Maps one stored authorization to one Host-rendered row (contract h1):
 * key = conversationId, label = conversation title falling back to the id
 * (truncated to 200), detail = chatUrl (authorizedAt as defensive fallback),
 * and exactly one revoke row action carrying { conversationId } as input.
 */
export function buildAuthorizationRow(
  conversation: PersonalChromeConversationAuthorization & {
    readonly displayTitle?: string;
  },
): OperationRow {
  const label = conversation.displayTitle ?? conversation.conversationId;
  return {
    key: conversation.conversationId,
    label: truncateChars(label, 200),
    detail: conversation.chatUrl.length > 0 ? conversation.chatUrl : conversation.authorizedAt,
    actions: [operationRowAction(REVOKE_ROW_ACTION_ID, { conversationId: conversation.conversationId })],
  };
}

export function buildAuthorizationRows(
  collection: PersonalChromeConversationAuthorizationCollection,
  titles: readonly PersonalChromeConversationTitle[],
): OperationRow[] {
  return projectConversationTitles(collection.conversations, titles).map(buildAuthorizationRow);
}

export interface PersonalChromeAuthorizationOperations {
  readonly list: () => Promise<OperationActionResult>;
  readonly revoke: (input: unknown) => Promise<OperationActionResult>;
  readonly status: () => Promise<OperationActionResult>;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function revokeConversationId(input: unknown): string {
  if (!isObjectRecord(input)) throw new TypeError('revoke input must be an object');
  const candidate = isObjectRecord(input.input) ? input.input : input;
  const conversationId = candidate.conversationId;
  if (typeof conversationId !== 'string' || conversationId.length === 0) {
    throw new TypeError('revoke input must contain a conversationId string');
  }
  return conversationId;
}

function isNeedsAuthorization(error: unknown): boolean {
  return (
    error instanceof PersonalChromeConversationAuthorizationError &&
    error.code === 'NEEDS_AUTHORIZATION'
  );
}

export function createAuthorizationOperations(options: {
  readonly authorizationPath: string;
  readonly now?: () => Date;
}): PersonalChromeAuthorizationOperations {
  const { authorizationPath } = options;
  const now = options.now ?? (() => new Date());

  const readRows = async (): Promise<OperationActionResult> => {
    let collection: PersonalChromeConversationAuthorizationCollection;
    try {
      collection = await readPersonalChromeConversationAuthorizations(authorizationPath);
    } catch (error) {
      if (isNeedsAuthorization(error)) {
        return rowsResult([], { empty: NO_AUTHORIZATION_EMPTY_TEXT });
      }
      throw error;
    }
    const titles = await readConversationTitles(authorizationPath);
    return rowsResult(buildAuthorizationRows(collection, titles), {
      label: `${collection.conversations.length} authorized conversation(s)`,
    });
  };

  return {
    list: readRows,
    revoke: async (input) => {
      const conversationId = revokeConversationId(input);
      await revokePersonalChromeConversation(authorizationPath, conversationId, now().toISOString());
      return readRows();
    },
    status: async () => {
      try {
        const collection = await readPersonalChromeConversationAuthorizations(authorizationPath);
        return {
          render: 'status',
          data: {
            status: 'ready',
            authorizedCount: collection.conversations.length,
            authorizationLimit: PERSONAL_CHROME_AUTHORIZATION_LIMIT,
            updatedAt: collection.updatedAt,
          },
          label: `${collection.conversations.length}/${PERSONAL_CHROME_AUTHORIZATION_LIMIT} conversations authorized`,
        };
      } catch (error) {
        if (isNeedsAuthorization(error)) {
          return {
            render: 'status',
            data: { status: 'needs-authorization', authorizedCount: 0, authorizationLimit: PERSONAL_CHROME_AUTHORIZATION_LIMIT },
            label: NO_AUTHORIZATION_EMPTY_TEXT,
          };
        }
        throw error;
      }
    },
  };
}

/**
 * p2a placeholders for the three cloud-conversation-host methods. p2b replaces
 * them with the native-host socket client:
 * - appendMessage: read the pairing record, open the native socket, send the
 *   append frame, and surface NEEDS_BINDING / BOUND_CONVERSATION_MISMATCH /
 *   STALE_* / AMBIGUOUS_EFFECT per contract beta.24 (d).
 * - assistantReturns.list: drain one return from the native assistant-return
 *   inbox per poll cycle.
 * - assistantReturns.ack: acknowledge one return so the inbox can retire it.
 * HOST_UNAVAILABLE here is truthful: with no socket client the request never
 * left the package, so no effect could have happened.
 */
export function createConversationHostPlaceholders(): Record<string, (input: unknown) => Promise<unknown>> {
  return {
    [PERSONAL_CHROME_APPEND_MESSAGE_METHOD]: async (_input: unknown) => ({
      status: 'failed',
      errorCode: 'HOST_UNAVAILABLE',
    }),
    [PERSONAL_CHROME_ASSISTANT_LIST_METHOD]: async (_input: unknown) => ({ returns: [] }),
    [PERSONAL_CHROME_ASSISTANT_ACK_METHOD]: async (_input: unknown) => ({
      status: 'failed',
      errorCode: 'HOST_UNAVAILABLE',
    }),
  };
}

export function createPersonalChromePluginModule() {
  return definePluginModule((manifest) =>
    definePlugin({
      manifest,
      activate: {
        [PERSONAL_CHROME_FEATURE_ID]: async (context: FeatureContext) => {
          // Throws FeaturePermissionError (code 'PERMISSION') when the owning
          // feature is not granted the data.directory capability.
          const dataDirectory = context.dataDirectory;
          const operations = createAuthorizationOperations({
            authorizationPath: join(dataDirectory, 'conversation-binding.json'),
          });
          const registration = await context.conversationHosts.register(
            personalChromeHostContribution,
          );
          const placeholders = createConversationHostPlaceholders();
          return {
            actions: {
              [PERSONAL_CHROME_LIST_METHOD]: operations.list,
              [PERSONAL_CHROME_REVOKE_METHOD]: operations.revoke,
              [PERSONAL_CHROME_STATUS_METHOD]: operations.status,
              [PERSONAL_CHROME_TEST_METHOD]: async () => ({
                ok: true,
                message:
                  'personal-chrome-host module skeleton active; the native socket client lands in p2b',
              }),
              ...placeholders,
            },
            dispose: async () => {
              await registration.dispose();
            },
          };
        },
      },
    }),
  );
}

export default createPersonalChromePluginModule();
