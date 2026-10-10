import { createHash } from 'node:crypto';
import type { PluginMessagingHost, PluginStorageHost } from '@clowder-ai/plugin-sdk';
import { z } from 'zod';

const draftSchema = z.object({ sourceEventId: z.string().min(1), threadId: z.string().min(1), catId: z.string().min(1), briefing: z.string().min(1) }).strict();
export type NarratorDeliveryDraft = z.infer<typeof draftSchema>;
export interface NarratorDelivery { send(draft: NarratorDeliveryDraft): Promise<void> }
const recordSchema = z.object({ draft: draftSchema, messageId: z.string().min(1).nullable() }).strict();
const prefix = 'community.narrator.delivery.';
const keyOf = (sourceEventId: string) => prefix + createHash('sha256').update(sourceEventId).digest('hex');

/** One durable outbox record replaces claim-before-send. A retry always uses
 * the original target and briefing, and the Host's same idempotency key. No TTL,
 * private Redis client, or invented invocation accompanies a background wake. */
export class SdkNarratorDelivery implements NarratorDelivery {
  private stopped = false;
  constructor(private readonly storage: PluginStorageHost, private readonly messaging: Pick<PluginMessagingHost, 'send'>) {}
  async send(input: NarratorDeliveryDraft): Promise<void> {
    const draft = draftSchema.parse(input); const key = keyOf(draft.sourceEventId);
    this.assertActive();
    const found = await this.storage.get(key);
    if (!found) {
      this.assertActive();
      await this.storage.compareAndSet(key, null, { draft, messageId: null });
    }
    await this.flush(key, draft);
  }
  async recover(): Promise<void> {
    this.assertActive();
    for (const [key] of Object.entries(await this.storage.list())) {
      if (key.startsWith(prefix)) await this.flush(key);
    }
  }
  stop(): void { this.stopped = true; }
  private assertActive() { if (this.stopped) throw new Error('Narrator delivery stopped'); }
  private async flush(key: string, expected?: NarratorDeliveryDraft) {
    for (let attempt = 0; attempt < 64; attempt++) {
      this.assertActive();
      const entry = await this.storage.get(key);
      if (!entry) throw new Error('Narrator outbox record missing');
      const record = recordSchema.parse(entry.value);
      if (key !== keyOf(record.draft.sourceEventId)) throw new Error('Narrator outbox identity mismatch');
      if (expected && JSON.stringify(expected) !== JSON.stringify(record.draft)) throw new Error('Narrator source event already has a different delivery');
      if (record.messageId) return;
      this.assertActive();
      const idempotencyKey = 'github:narrator:' + key.slice(prefix.length);
      const sent = await this.messaging.send({
        threadId: record.draft.threadId, identity: 'github-notification', idempotencyKey,
        wake: { catId: record.draft.catId },
        payload: { provenance: { epistemicStatus: 'observation' }, elements: [{ elementId: idempotencyKey, kind: 'text', payload: { text: record.draft.briefing } }] },
      });
      if (sent.threadId !== record.draft.threadId || !sent.messageId) throw new Error('Narrator delivery receipt mismatch');
      this.assertActive();
      if ((await this.storage.compareAndSet(key, entry.revision, { ...record, messageId: sent.messageId })).applied) return;
    }
    throw new Error('Narrator outbox changed concurrently');
  }
}
