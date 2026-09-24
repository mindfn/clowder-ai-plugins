/**
 * Telegram Bot Adapter
 * Inbound: Parse Telegram update → extract private text message
 * Outbound: Send reply via Bot API
 *
 * Uses grammy for long polling (no public webhook needed).
 * MVP: DM-only, text-only, single-owner.
 *
 * F088 Multi-Platform Chat Gateway
 */

import { Bot, GrammyError, InputFile } from 'grammy';
import { fetchBoundedInboundMedia } from './inbound-download.js';
import type { ConnectorLogger, RichBlock } from './types.js';
import { formatTelegramHtml } from './telegram-html-formatter.js';
import { materializeMedia } from './materialize-media.js';

// Telegram Bot API multipart limits: photos 10 MB; other uploaded files 50 MB.
// Source: https://core.telegram.org/bots/api#sending-files
export const TELEGRAM_MEDIA_MAX_BYTES = {
  image: 10_000_000,
  file: 50_000_000,
  audio: 50_000_000,
} as const;

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const TELEGRAM_POLLING_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000] as const;
const TELEGRAM_MAX_CONFLICT_RETRIES = 10;

function splitText(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_MESSAGE_LENGTH) return [text];
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + TELEGRAM_MAX_MESSAGE_LENGTH, text.length);
    // Back up one code unit if we'd split a surrogate pair (high surrogate at boundary).
    if (end < text.length) {
      const charCode = text.charCodeAt(end - 1);
      if (charCode >= 0xd800 && charCode <= 0xdbff) end--;
    }
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

function splitHtml(html: string): string[] {
  if (html.length <= TELEGRAM_MAX_MESSAGE_LENGTH) return [html];
  const parts: string[] = [];
  let start = 0;
  while (start < html.length) {
    let end = Math.min(start + TELEGRAM_MAX_MESSAGE_LENGTH, html.length);
    if (end < html.length) {
      // Don't split a surrogate pair
      if ((html.charCodeAt(end - 1) & 0xfc00) === 0xd800) end--;
      // Don't split inside an HTML entity (&amp; &lt; &gt;)
      const entityStart = html.lastIndexOf('&', end - 1);
      if (entityStart >= start) {
        const entityEnd = html.indexOf(';', entityStart);
        if (entityEnd === -1 || entityEnd >= end) end = entityStart;
      }
      // Don't split inside a tag
      if (end > start) {
        const tagStart = html.lastIndexOf('<', end - 1);
        if (tagStart >= start) {
          const tagEnd = html.indexOf('>', tagStart);
          if (tagEnd === -1 || tagEnd >= end) end = tagStart;
        }
      }
      if (end <= start) end = start + 1;
    }
    parts.push(html.slice(start, end));
    start = end;
  }
  return parts;
}

function isTelegramHtmlParseError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { error_code?: unknown; description?: string; message?: string };
  if (e.error_code !== 400) return false;
  const desc = (e.description ?? e.message ?? '').toLowerCase();
  return desc.includes('parse entities') || desc.includes('button_data_invalid');
}

type TelegramStartOptions = Parameters<Bot['start']>[0];

interface TelegramPollingControls {
  start: (options: TelegramStartOptions) => Promise<void>;
  stop: () => Promise<void>;
  close: () => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  backoffMs: readonly number[];
  maxConflictRetries: number;
}

export interface TelegramAttachment {
  type: 'image' | 'file' | 'audio';
  telegramFileId: string;
  fileName?: string;
  duration?: number;
}

export interface TelegramInboundMessage {
  chatId: string;
  text: string;
  messageId: string;
  senderId: string;
  attachments?: TelegramAttachment[];
}

function isTelegramConflictError(err: unknown): boolean {
  if (err instanceof GrammyError) return err.error_code === 409;
  if (!err || typeof err !== 'object') return false;
  const errorCode = (err as { error_code?: unknown }).error_code;
  return errorCode === 409;
}

export class TelegramAdapter {
  readonly connectorId = 'telegram';
  private readonly bot: Bot;
  private readonly botToken: string;
  private readonly log: ConnectorLogger;
  private sendMessageFn: ((chatId: string, text: string, opts?: Record<string, unknown>) => Promise<unknown>) | null =
    null;
  private readonly placeholderChats = new Map<string, string>();
  /** Legacy deliveries without lifecycleId remain FIFO; lifecycle deliveries use the exact map below. */
  private readonly pendingInlineFinal = new Map<string, string[]>();
  private readonly pendingInlineFinalByLifecycle = new Map<
    string,
    { readonly externalChatId: string; readonly platformMessageId: string }
  >();
  private botApiSendMessageFn: ((chatId: number, text: string) => Promise<{ message_id: number }>) | null = null;
  private botApiEditMessageFn:
    | ((chatId: number, messageId: number, text: string, options?: Record<string, unknown>) => Promise<void>)
    | null = null;
  private botApiDeleteMessageFn: ((chatId: number, messageId: number) => Promise<void>) | null = null;
  private sendMediaFns: {
    sendPhoto: (chatId: number, input: string | InputFile) => Promise<unknown>;
    sendDocument: (chatId: number, input: string | InputFile) => Promise<unknown>;
    sendVoice: (chatId: number, input: string | InputFile) => Promise<unknown>;
  } | null = null;
  private pollingStopped = false;
  private pollingRunId = 0;
  private pollingControls: TelegramPollingControls | null = null;

  constructor(botToken: string, log: ConnectorLogger) {
    this.botToken = botToken;
    this.bot = new Bot(botToken);
    this.log = log;
  }

  async downloadInboundMedia(locator: { readonly platformKey: string }): Promise<Buffer> {
    const file = await this.bot.api.getFile(locator.platformKey);
    if (!file.file_path) throw new Error('Telegram getFile returned no file_path');
    const { response, bytes } = await fetchBoundedInboundMedia(
      globalThis.fetch,
      `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`,
    );
    if (!response.ok) throw new Error(`Telegram media download HTTP ${response.status}`);
    return bytes;
  }

  private getPollingControls(): TelegramPollingControls {
    return (
      this.pollingControls ?? {
        start: (options) => this.bot.start(options),
        stop: () => this.bot.stop(),
        close: () => this.bot.api.close(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        backoffMs: TELEGRAM_POLLING_BACKOFF_MS,
        maxConflictRetries: TELEGRAM_MAX_CONFLICT_RETRIES,
      }
    );
  }

  /**
   * Parse a Telegram update into an inbound message.
   * Supports text, photo, document, and voice messages.
   * Returns null for group or bot messages.
   */
  parseUpdate(update: unknown): TelegramInboundMessage | null {
    if (!update || typeof update !== 'object') return null;

    const u = update as Record<string, unknown>;
    const message = u.message as Record<string, unknown> | undefined;
    if (!message) return null;

    // MVP: DM only (private chats)
    const chat = message.chat as Record<string, unknown> | undefined;
    if (!chat || chat.type !== 'private') return null;

    // Skip bot messages
    const from = message.from as Record<string, unknown> | undefined;
    if (!from || from.is_bot === true) return null;

    const base = {
      chatId: String(chat.id),
      messageId: String(message.message_id),
      senderId: String(from.id),
    };

    const caption = typeof message.caption === 'string' ? message.caption : undefined;

    // Text message
    const text = message.text;
    if (typeof text === 'string') {
      return { ...base, text };
    }

    // Photo message — pick largest photo (last in array)
    const photo = message.photo as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(photo) && photo.length > 0) {
      const largest = photo[photo.length - 1]!;
      return {
        ...base,
        text: caption ?? '[图片]',
        attachments: [{ type: 'image', telegramFileId: largest.file_id as string }],
      };
    }

    // Document message
    const document = message.document as Record<string, unknown> | undefined;
    if (document) {
      const fileName = document.file_name as string | undefined;
      return {
        ...base,
        text: caption ?? (fileName ? `[文件] ${fileName}` : '[文件]'),
        attachments: [{ type: 'file', telegramFileId: document.file_id as string, ...(fileName ? { fileName } : {}) }],
      };
    }

    // Voice message
    const voice = message.voice as Record<string, unknown> | undefined;
    if (voice) {
      const duration = voice.duration as number | undefined;
      return {
        ...base,
        text: '[语音]',
        attachments: [
          { type: 'audio', telegramFileId: voice.file_id as string, ...(duration != null ? { duration } : {}) },
        ],
      };
    }

    return null;
  }

  /**
   * Send a reply to a Telegram chat.
   * K2: If a lifecycleId is supplied, edits only that lifecycle's placeholder. Legacy
   *     deliveries without lifecycleId retain the per-chat FIFO behavior.
   *     If editMessage fails (message deleted etc.), falls back to sending a new message.
   * K3: Splits content exceeding 4096 chars into multiple messages.
   */
  async sendReply(
    externalChatId: string,
    content: string,
    _metadata?: Record<string, unknown>,
    lifecycleId?: string,
  ): Promise<void> {
    const inlineMsgId = this.takeInlinePlaceholder(externalChatId, lifecycleId);
    if (inlineMsgId !== undefined) {
      const [firstPart, ...restParts] = splitText(content);
      let editSucceeded = false;
      try {
        await this.editMessage(externalChatId, inlineMsgId, firstPart);
        editSucceeded = true;
        this.placeholderChats.delete(inlineMsgId);
      } catch (err) {
        this.log.warn({ err }, '[TelegramAdapter] sendReply: editMessage failed, falling back to send');
        // ID already consumed from queue; delete the stale streaming card before sending.
        await this.deleteMessage(inlineMsgId, externalChatId).catch(() => {});
      }
      if (editSucceeded) {
        // ID already consumed above — send any remaining split parts.
        for (const part of restParts) {
          if (this.sendMessageFn) {
            await this.sendMessageFn(externalChatId, part);
          } else {
            await this.bot.api.sendMessage(externalChatId, part);
          }
        }
        return;
      }
      for (const segment of splitText(content)) {
        if (this.sendMessageFn) {
          await this.sendMessageFn(externalChatId, segment);
        } else {
          await this.bot.api.sendMessage(externalChatId, segment);
        }
      }
      return;
    }

    for (const segment of splitText(content)) {
      if (this.sendMessageFn) {
        await this.sendMessageFn(externalChatId, segment);
      } else {
        await this.bot.api.sendMessage(externalChatId, segment);
      }
    }
  }

  /**
   * Start long polling for inbound messages.
   * Handles text, photo, document, and voice DMs.
   */
  startPolling(handler: (msg: TelegramInboundMessage) => Promise<void>): void {
    this.pollingStopped = false;
    const runId = ++this.pollingRunId;
    const handleUpdate = async (ctx: { message?: unknown }) => {
      if (!ctx.message) return;
      const parsed = this.parseUpdate({ message: ctx.message });
      if (!parsed) return;

      try {
        await handler(parsed);
      } catch (err) {
        this.log.error({ err, chatId: parsed.chatId }, '[TelegramAdapter] Handler error');
      }
    };

    this.bot.on('message:text', handleUpdate);
    this.bot.on('message:photo', handleUpdate);
    this.bot.on('message:document', handleUpdate);
    this.bot.on('message:voice', handleUpdate);

    void this.runPollingLoop(runId);
  }

  private async runPollingLoop(runId: number): Promise<void> {
    const controls = this.getPollingControls();
    let attempt = 0;
    while (!this.pollingStopped && runId === this.pollingRunId) {
      try {
        await controls.start({
          onStart: () => {
            attempt = 0;
            this.log.info('[TelegramAdapter] Long polling started');
          },
        });
        return;
      } catch (err) {
        if (this.pollingStopped || runId !== this.pollingRunId) return;

        if (!isTelegramConflictError(err)) {
          this.log.error({ err }, '[TelegramAdapter] Long polling failed');
          return;
        }

        const shouldRetry = await this.recoverPollingConflict(err, controls, attempt);
        if (!shouldRetry) return;
        attempt += 1;
      }
    }
  }

  private async recoverPollingConflict(
    err: unknown,
    controls: TelegramPollingControls,
    attempt: number,
  ): Promise<boolean> {
    if (attempt >= controls.maxConflictRetries) {
      this.log.error({ err, attempts: attempt }, '[TelegramAdapter] 409 conflict retry limit reached');
      return false;
    }

    const waitMs =
      controls.backoffMs[Math.min(attempt, controls.backoffMs.length - 1)] ?? controls.backoffMs.at(-1) ?? 60_000;
    this.log.warn(
      { err, attempt: attempt + 1, waitMs },
      '[TelegramAdapter] 409 conflict; releasing session and retrying',
    );
    try {
      await controls.close();
    } catch (closeErr) {
      this.log.warn({ err: closeErr }, '[TelegramAdapter] bot.api.close() failed during 409 recovery');
    }
    await controls.sleep(waitMs);
    return true;
  }

  /**
   * Stop long polling gracefully.
   */
  async stopPolling(): Promise<void> {
    this.pollingStopped = true;
    this.pollingRunId += 1;
    const controls = this.getPollingControls();
    try {
      await controls.stop();
    } catch (err) {
      this.log.warn({ err }, '[TelegramAdapter] bot.stop() failed');
    }
    try {
      await controls.close();
    } catch (err) {
      this.log.warn({ err }, '[TelegramAdapter] bot.api.close() failed');
    }
  }

  /**
   * Send a rich message as Telegram HTML-formatted text.
   * K2: If a lifecycleId is supplied, edits only that lifecycle's placeholder. Legacy
   *     deliveries without lifecycleId retain the per-chat FIFO behavior.
   *     Falls back to plain text edit if HTML parse fails.
   *     Falls back to sending a new message if editMessage fails entirely.
   * K3: HTML parse error falls back to plain text; long plain text is split.
   */
  async sendRichMessage(
    externalChatId: string,
    textContent: string,
    blocks: RichBlock[],
    catDisplayName: string,
    lifecycleId?: string,
  ): Promise<void> {
    const html = formatTelegramHtml(blocks, catDisplayName, textContent);

    const inlineMsgId = this.takeInlinePlaceholder(externalChatId, lifecycleId);
    if (inlineMsgId !== undefined) {
      const [firstHtmlPart, ...restHtmlParts] = splitHtml(html);
      let richEditSucceeded = false;
      try {
        await this.editMessage(externalChatId, inlineMsgId, firstHtmlPart!, { parse_mode: 'HTML' });
        richEditSucceeded = true;
        this.placeholderChats.delete(inlineMsgId);
      } catch (err) {
        this.log.warn({ err }, '[TelegramAdapter] sendRichMessage: editMessage failed, falling back to send');
        // ID already consumed; delete the stale streaming card before sending.
        await this.deleteMessage(inlineMsgId, externalChatId).catch(() => {});
      }
      if (richEditSucceeded) {
        // ID already consumed above — send any overflow segments as new messages.
        // K3 cloud-R11 P1: apply the same HTML-parse-error fallback as the non-inline path.
        let overflowUseHtml = true;
        for (const part of restHtmlParts) {
          if (!overflowUseHtml) {
            const stripped = part
              .replace(/<[^>]+>/g, '')
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .trim();
            if (this.sendMessageFn) {
              await this.sendMessageFn(externalChatId, stripped || part);
            } else {
              await this.bot.api.sendMessage(externalChatId, stripped || part);
            }
            continue;
          }
          try {
            if (this.sendMessageFn) {
              await this.sendMessageFn(externalChatId, part, { parse_mode: 'HTML' });
            } else {
              await this.bot.api.sendMessage(externalChatId, part, { parse_mode: 'HTML' } as Record<string, unknown>);
            }
          } catch (htmlErr) {
            if (!isTelegramHtmlParseError(htmlErr)) throw htmlErr;
            overflowUseHtml = false;
            const stripped = part
              .replace(/<[^>]+>/g, '')
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .trim();
            if (this.sendMessageFn) {
              await this.sendMessageFn(externalChatId, stripped || part);
            } else {
              await this.bot.api.sendMessage(externalChatId, stripped || part);
            }
          }
        }
        return;
      }
      // Fallback: split long HTML across multiple messages.
      // Mid-stream HTML parse error: switch to plain-text for the failing chunk and all remaining.
      let inlineSentCount = 0;
      let inlineUseHtml = true;
      for (const part of splitHtml(html)) {
        if (!inlineUseHtml) {
          const stripped = part
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .trim();
          if (this.sendMessageFn) {
            await this.sendMessageFn(externalChatId, stripped || part);
          } else {
            await this.bot.api.sendMessage(externalChatId, stripped || part);
          }
          continue;
        }
        try {
          if (this.sendMessageFn) {
            await this.sendMessageFn(externalChatId, part, { parse_mode: 'HTML' });
          } else {
            await this.bot.api.sendMessage(externalChatId, part, { parse_mode: 'HTML' } as Record<string, unknown>);
          }
          inlineSentCount++;
        } catch (htmlErr) {
          if (!isTelegramHtmlParseError(htmlErr)) throw htmlErr;
          if (inlineSentCount === 0) {
            this.log.warn(
              { err: htmlErr },
              '[TelegramAdapter] sendRichMessage: HTML parse error, falling back to plain text',
            );
            const strippedHtml = html
              .replace(/<[^>]+>/g, '')
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .trim();
            const plainFallback = strippedHtml || textContent;
            for (const segment of splitText(plainFallback)) {
              if (this.sendMessageFn) {
                await this.sendMessageFn(externalChatId, segment);
              } else {
                await this.bot.api.sendMessage(externalChatId, segment);
              }
            }
            return;
          }
          inlineUseHtml = false;
          const stripped = part
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .trim();
          if (this.sendMessageFn) {
            await this.sendMessageFn(externalChatId, stripped || part);
          } else {
            await this.bot.api.sendMessage(externalChatId, stripped || part);
          }
        }
      }
      return;
    }

    // Non-inline send path: split long HTML across multiple messages.
    // Mid-stream HTML parse error: switch to plain-text for the failing chunk and all remaining.
    let sentCount = 0;
    let useHtml = true;
    for (const part of splitHtml(html)) {
      if (!useHtml) {
        const stripped = part
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .trim();
        if (this.sendMessageFn) {
          await this.sendMessageFn(externalChatId, stripped || part);
        } else {
          await this.bot.api.sendMessage(externalChatId, stripped || part);
        }
        continue;
      }
      try {
        if (this.sendMessageFn) {
          await this.sendMessageFn(externalChatId, part, { parse_mode: 'HTML' });
        } else {
          await this.bot.api.sendMessage(externalChatId, part, { parse_mode: 'HTML' } as Record<string, unknown>);
        }
        sentCount++;
      } catch (htmlErr) {
        if (!isTelegramHtmlParseError(htmlErr)) throw htmlErr;
        if (sentCount === 0) {
          this.log.warn(
            { err: htmlErr },
            '[TelegramAdapter] sendRichMessage: HTML parse error, falling back to plain text',
          );
          const strippedHtml = html
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .trim();
          const plainFallback = strippedHtml || textContent;
          for (const segment of splitText(plainFallback)) {
            if (this.sendMessageFn) {
              await this.sendMessageFn(externalChatId, segment);
            } else {
              await this.bot.api.sendMessage(externalChatId, segment);
            }
          }
          return;
        }
        useHtml = false;
        const stripped = part
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .trim();
        if (this.sendMessageFn) {
          await this.sendMessageFn(externalChatId, stripped || part);
        } else {
          await this.bot.api.sendMessage(externalChatId, stripped || part);
        }
      }
    }
  }

  /**
   * Send a placeholder message for streaming and return its message ID.
   * Records the externalChatId mapping so deleteMessage can clean it up later.
   */
  async sendPlaceholder(externalChatId: string, text: string): Promise<string> {
    const msg = this.botApiSendMessageFn
      ? await this.botApiSendMessageFn(Number(externalChatId), text)
      : await this.bot.api.sendMessage(Number(externalChatId), text);
    const msgId = String(msg.message_id);
    this.placeholderChats.set(msgId, externalChatId);
    return msgId;
  }

  /**
   * Delete a placeholder message after outbound delivery succeeds.
   * No-op if platformMessageId is unknown (delivery failed before placeholder was registered).
   * Cleans up the mapping after deletion to prevent double-delete.
   */
  async deleteMessage(platformMessageId: string, externalChatId?: string): Promise<void> {
    // Prefer caller-provided chatId; fall back to Map for adapters that don't pass it.
    // Telegram message_ids are only unique per-chat, so the Map alone is unsafe for multi-chat.
    const chatId = externalChatId ?? this.placeholderChats.get(platformMessageId);
    if (!chatId) return;
    try {
      if (this.botApiDeleteMessageFn) {
        await this.botApiDeleteMessageFn(Number(chatId), Number(platformMessageId));
      } else {
        await this.bot.api.deleteMessage(Number(chatId), Number(platformMessageId));
      }
    } finally {
      this.placeholderChats.delete(platformMessageId);
    }
  }

  /**
   * Edit an already-sent message in place (for streaming progressive updates and K2 inline final).
   * Truncates to Telegram's 4096-char limit.
   * opts.parse_mode: pass 'HTML' when editing with rich HTML content (K2 sendRichMessage inline).
   */
  async editMessage(
    externalChatId: string,
    platformMessageId: string,
    text: string,
    opts?: { parse_mode?: string },
  ): Promise<boolean> {
    const truncated =
      text.length > TELEGRAM_MAX_MESSAGE_LENGTH ? `${text.slice(0, TELEGRAM_MAX_MESSAGE_LENGTH - 1)}…` : text;
    if (this.botApiEditMessageFn) {
      await this.botApiEditMessageFn(Number(externalChatId), Number(platformMessageId), truncated, opts);
    } else if (opts?.parse_mode) {
      await this.bot.api.editMessageText(
        Number(externalChatId),
        Number(platformMessageId),
        truncated,
        opts as Record<string, unknown>,
      );
    } else {
      await this.bot.api.editMessageText(Number(externalChatId), Number(platformMessageId), truncated);
    }
    return true;
  }

  /** Stop lifecycle-final correlation while leaving a blocked recovery message visible. */
  preserveInlinePlaceholder(externalChatId: string, platformMessageId: string, lifecycleId: string): void {
    const pending = this.pendingInlineFinalByLifecycle.get(lifecycleId);
    if (pending?.externalChatId === externalChatId && pending.platformMessageId === platformMessageId) {
      this.pendingInlineFinalByLifecycle.delete(lifecycleId);
    }
    this.placeholderChats.delete(platformMessageId);
  }

  /**
   * K2: Register a pending inline-final placeholder.
   * Lifecycle-aware deliveries use lifecycleId as the exact correlation key; callers
   * without one retain the legacy per-chat FIFO behavior. Consumed on first use.
   */
  registerInlinePlaceholder(
    externalChatId: string,
    platformMessageId: string,
    lifecycleId?: string,
  ): void {
    if (lifecycleId !== undefined) {
      this.pendingInlineFinalByLifecycle.set(lifecycleId, { externalChatId, platformMessageId });
      return;
    }
    const queue = this.pendingInlineFinal.get(externalChatId) ?? [];
    queue.push(platformMessageId);
    this.pendingInlineFinal.set(externalChatId, queue);
  }

  private takeInlinePlaceholder(externalChatId: string, lifecycleId?: string): string | undefined {
    if (lifecycleId !== undefined) {
      const pending = this.pendingInlineFinalByLifecycle.get(lifecycleId);
      if (pending?.externalChatId !== externalChatId) return undefined;
      this.pendingInlineFinalByLifecycle.delete(lifecycleId);
      return pending.platformMessageId;
    }
    const queue = this.pendingInlineFinal.get(externalChatId);
    // Consume before the async edit so concurrent legacy deliveries cannot select the same ID.
    const platformMessageId = queue?.shift();
    if (queue !== undefined && queue.length === 0) this.pendingInlineFinal.delete(externalChatId);
    return platformMessageId;
  }

  /**
   * K2: Clear a registered inline-final placeholder without delivering content.
   * Called when delivery is skipped so stale state doesn't corrupt the next delivery.
   * Removes the specific platformMessageId from the FIFO queue (K3: queue per chatId).
   * If the placeholder was already consumed by sendReply/sendRichMessage, this is a no-op.
   * Deletes the streaming card from Telegram when entry was still pending (delivery skipped).
   */
  async clearInlinePlaceholder(
    chatId: string,
    platformMessageId?: string,
    lifecycleId?: string,
  ): Promise<void> {
    if (platformMessageId) {
      if (lifecycleId !== undefined) {
        const pending = this.pendingInlineFinalByLifecycle.get(lifecycleId);
        if (pending?.externalChatId === chatId && pending.platformMessageId === platformMessageId) {
          this.pendingInlineFinalByLifecycle.delete(lifecycleId);
          await this.deleteMessage(platformMessageId, chatId).catch(() => {});
        } else {
          // The matching final delivery already consumed this lifecycle placeholder.
          this.placeholderChats.delete(platformMessageId);
        }
        return;
      }
      const queue = this.pendingInlineFinal.get(chatId);
      if (queue) {
        const idx = queue.indexOf(platformMessageId);
        if (idx !== -1) {
          // ID still pending: delivery was skipped — remove from queue and delete the streaming card.
          queue.splice(idx, 1);
          if (queue.length === 0) this.pendingInlineFinal.delete(chatId);
          await this.deleteMessage(platformMessageId, chatId).catch(() => {});
        } else {
          // ID already consumed by delivery — just clean the tracking map to prevent unbounded growth.
          this.placeholderChats.delete(platformMessageId);
        }
      } else {
        // No queue at all — ID was consumed and queue was deleted — still clean tracking map.
        this.placeholderChats.delete(platformMessageId);
      }
    } else {
      if (lifecycleId !== undefined) {
        this.pendingInlineFinalByLifecycle.delete(lifecycleId);
      } else {
        this.pendingInlineFinal.delete(chatId);
      }
    }
  }

  /** Send Host-authorized bytes to Telegram before the action entitlement closes. */
  async sendMedia(
    externalChatId: string,
    payload: {
      type: 'image' | 'file' | 'audio';
      content: AsyncIterable<Uint8Array>;
      fileName?: string;
    },
  ): Promise<void> {
    const chatId = Number(externalChatId);
    const materialized = await materializeMedia(
      payload.content,
      payload.fileName,
      TELEGRAM_MEDIA_MAX_BYTES[payload.type],
    );
    const source = new InputFile(materialized.path);
    const fns = this.sendMediaFns ?? {
      sendPhoto: (cid: number, input: string | InputFile) => this.bot.api.sendPhoto(cid, input),
      sendDocument: (cid: number, input: string | InputFile) => this.bot.api.sendDocument(cid, input),
      sendVoice: (cid: number, input: string | InputFile) => this.bot.api.sendVoice(cid, input),
    };
    try {
      switch (payload.type) {
        case 'image':
          await fns.sendPhoto(chatId, source);
          break;
        case 'file':
          await fns.sendDocument(chatId, source);
          break;
        case 'audio':
          await fns.sendVoice(chatId, source);
          break;
      }
    } finally {
      await materialized.cleanup().catch(() => undefined);
    }
  }

  /**
   * Test helper: inject a mock sendMessage function.
   * @internal
   */
  _injectSendMessage(fn: (chatId: string, text: string, opts?: Record<string, unknown>) => Promise<unknown>): void {
    this.sendMessageFn = fn;
  }

  /**
   * Test helper: inject mock media send functions.
   * @internal
   */
  _injectSendMedia(fns: {
    sendPhoto: (chatId: number, input: string | InputFile) => Promise<unknown>;
    sendDocument: (chatId: number, input: string | InputFile) => Promise<unknown>;
    sendVoice: (chatId: number, input: string | InputFile) => Promise<unknown>;
  }): void {
    this.sendMediaFns = fns;
  }

  /** @internal */
  _injectBotApiSendMessage(fn: (chatId: number, text: string) => Promise<{ message_id: number }>): void {
    this.botApiSendMessageFn = fn;
  }

  /** @internal */
  _injectBotApiEditMessage(
    fn: (chatId: number, messageId: number, text: string, options?: Record<string, unknown>) => Promise<void>,
  ): void {
    this.botApiEditMessageFn = fn;
  }

  /** @internal */
  _injectBotApiDeleteMessage(fn: (chatId: number, messageId: number) => Promise<void>): void {
    this.botApiDeleteMessageFn = fn;
  }

  /**
   * Test helper: inject long polling lifecycle controls.
   * @internal
   */
  _injectPollingControls(fns: Partial<TelegramPollingControls>): void {
    const defaults = this.getPollingControls();
    this.pollingControls = { ...defaults, ...fns };
  }
}
