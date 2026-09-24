import {
  decideLifecycleTransition,
  defineLifecycleAction,
  lifecycleRejectReason,
  type FeatureContext,
  type LifecycleAction,
} from '@clowder-ai/plugin-sdk';

type LifecycleEvent = Parameters<LifecycleAction>[0];
type SettledEvent = Extract<LifecycleEvent, { readonly state: 'settled' }>;

export interface ConnectorLifecycleCallbacks {
  sendPlaceholder(externalConversationId: string, text: string): Promise<string>;
  editPlaceholder(
    externalConversationId: string,
    platformMessageId: string,
    text: string,
    phase: 'catching_up' | 'blocked',
    lifecycleId: string,
  ): Promise<boolean>;
  sendRecovery(externalConversationId: string, text: string): Promise<void>;
  /** Resolve the sender display name recorded for a Host message id; only connectors with a reply-sender mapping implement this. */
  resolveReplySenderName?(replyTo: string): Promise<string | undefined>;
  onPlaceholder?(
    externalConversationId: string,
    platformMessageId: string,
    lifecycleId: string,
  ): void | Promise<void>;
  settle(input: {
    readonly externalConversationId: string;
    readonly platformMessageId?: string;
    readonly actorDisplayName: string;
    readonly recoveryText?: string;
    readonly event: SettledEvent;
  }): Promise<void>;
}

interface StoredLifecycle {
  readonly version: 1 | 2;
  readonly history: readonly LifecycleEvent[];
  readonly platformMessageId?: string;
  readonly actorDisplayName: string;
  /** v2 only: last write time, drives stranded-record sweep TTL. */
  readonly updatedAt?: number;
  /** v2 tombstone only: compressed settled record with the minimum replay/reject identity. */
  readonly tombstone?: boolean;
  /** v2 tombstone only: every accepted deliveryId, so pre-settle redeliveries still answer replay. */
  readonly deliveryIds?: readonly string[];
  /** v2 tombstone only: when the lifecycle settled, drives tombstone sweep TTL. */
  readonly settledAt?: number;
}

const STARTED_TEXT = '🤔 思考中...';
const CATCHING_UP_TEXT = '🔄 收到新消息，正在重新整理回复…';

const LIFECYCLE_KEY_PREFIX = 'lifecycle/';
// A settled tombstone only answers Host redeliveries with replay/reject; a
// day is far beyond any sane redelivery horizon, so keeping it longer only
// accumulates dead keys.
const LIFECYCLE_TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;
// Records that never settled are Host-crash orphans: their placeholder text
// is already terminal. The TTL must exceed the longest legitimate in-flight
// turn (cat work can span many hours), so 24h bounds orphans without
// deleting lifecycles that are still actively running.
const LIFECYCLE_STRANDED_TTL_MS = 24 * 60 * 60 * 1000;
const SWEEP_EVERY_WRITES = 25;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function lifecycleError(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}

function storedLifecycle(value: unknown): StoredLifecycle {
  if (!object(value)
    || (value.version !== 1 && value.version !== 2)
    || !Array.isArray(value.history)
    || typeof value.actorDisplayName !== 'string'
    || (value.platformMessageId !== undefined && typeof value.platformMessageId !== 'string')
    || (value.updatedAt !== undefined && typeof value.updatedAt !== 'number')
    || (value.tombstone !== undefined && typeof value.tombstone !== 'boolean')
    || (value.deliveryIds !== undefined && (!Array.isArray(value.deliveryIds) || value.deliveryIds.some(id => typeof id !== 'string')))
    || (value.settledAt !== undefined && typeof value.settledAt !== 'number')) {
    throw lifecycleError('PLUGIN_INTERNAL', 'stored lifecycle state is invalid');
  }
  return structuredClone(value) as unknown as StoredLifecycle;
}

function recoveryText(event: Extract<LifecycleEvent, { readonly state: 'blocked' }>): string {
  return `⚠️ 未能完成最新消息重读（${event.reason}）。请打开 Clowder AI 重试${event.recoveryUrl ? `：${event.recoveryUrl}` : '。'}`;
}

export function createConnectorLifecycleAction(
  context: FeatureContext,
  callbacks: ConnectorLifecycleCallbacks,
) {
  const tails = new Map<string, Promise<void>>();
  let writesSinceSweep = 0;
  let sweepInFlight = false;

  const sweep = async (): Promise<void> => {
    let listed: Readonly<Record<string, { readonly value: unknown }>>;
    try {
      listed = await context.storage.list();
    } catch (error) {
      context.log('warn', 'Connector lifecycle sweep failed', {
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      return;
    }
    const now = Date.now();
    for (const [key, item] of Object.entries(listed)) {
      if (!key.startsWith(LIFECYCLE_KEY_PREFIX)) continue;
      let record: StoredLifecycle;
      try {
        record = storedLifecycle(item?.value);
      } catch {
        continue;
      }
      if (record.tombstone === true) {
        const settledAt = record.settledAt ?? record.updatedAt;
        if (settledAt !== undefined && settledAt + LIFECYCLE_TOMBSTONE_TTL_MS < now) {
          await context.storage.delete(key).catch(() => undefined);
        }
        continue;
      }
      // v1 records carry no updatedAt, so their age is unknown; the v2 write
      // path re-binds them with a timestamp on the next transition.
      if (record.updatedAt !== undefined && record.updatedAt + LIFECYCLE_STRANDED_TTL_MS < now) {
        await context.storage.delete(key).catch(() => undefined);
      }
    }
  };

  // Single-flight background sweep, mirroring reply-sender-map: the hot path
  // only counts writes. console.warn (not context.log) is deliberate here —
  // log() throws FeatureContextRevokedError after feature shutdown, which
  // would turn this last-resort guard into an unhandled rejection.
  const sweepInBackground = (): void => {
    if (sweepInFlight) return;
    sweepInFlight = true;
    void sweep()
      .catch((error: unknown) => {
        console.warn('Connector lifecycle sweep failed', {
          errorName: error instanceof Error ? error.name : 'unknown',
        });
      })
      .finally(() => {
        sweepInFlight = false;
      });
  };

  const countWrite = (): void => {
    writesSinceSweep += 1;
    if (writesSinceSweep < SWEEP_EVERY_WRITES) return;
    writesSinceSweep = 0;
    sweepInBackground();
  };

  const handle = async (event: LifecycleEvent) => {
    const stateKey = `lifecycle/${event.lifecycleId}`;
    const entry = await context.storage.get(stateKey);
    const stored = entry === undefined ? undefined : storedLifecycle(entry.value);
    if (stored?.tombstone === true) {
      // The tombstone keeps the settled event plus every accepted deliveryId:
      // an exact redelivery of anything the Host already acked is still
      // answered as replay, anything else is out of order.
      const deliveryIds = stored.deliveryIds ?? stored.history.map(candidate => candidate.deliveryId);
      if (deliveryIds.includes(event.deliveryId)) {
        return { deliveryId: event.deliveryId };
      }
      throw lifecycleError('LIFECYCLE_OUT_OF_ORDER', 'lifecycle is already settled');
    }
    const history = stored?.history ?? [];
    const decision = decideLifecycleTransition(history, event);
    if (decision.kind === 'replay') return { deliveryId: event.deliveryId };
    if (decision.kind === 'reject') {
      throw lifecycleError(lifecycleRejectReason(decision), `lifecycle ${decision.reason.toLowerCase()}`);
    }

    const binding = (await context.threads.listBindings()).find(candidate => candidate.threadId === event.threadId);
    if (binding === undefined) {
      throw lifecycleError('PLUGIN_INTERNAL', `lifecycle thread ${event.threadId} has no provider binding`);
    }

    let platformMessageId = stored?.platformMessageId;
    const actorDisplayName = event.state === 'started'
      ? event.presentation.actor.displayName
      : stored?.actorDisplayName ?? '';

    // Settled records compress into a tombstone: the settled event plus the
    // deliveryId set is the minimum needed to answer redeliveries, so the
    // full event history stops accumulating.
    const nextRecord = (messageId: string | undefined): StoredLifecycle => ({
      version: 2,
      history: event.state === 'settled' ? [event] : [...history, event],
      ...(messageId === undefined ? {} : { platformMessageId: messageId }),
      actorDisplayName,
      updatedAt: Date.now(),
      ...(event.state === 'settled'
        ? { tombstone: true, deliveryIds: [...history.map(candidate => candidate.deliveryId), event.deliveryId], settledAt: Date.now() }
        : {}),
    });

    // Write-ahead: persist the accepted event before any platform side
    // effect, so a crash between effect and store cannot leave later events
    // orphaned as OUT_OF_ORDER. If even the identical retry fails we throw
    // before any side effect: no half-persisted record, no duplicate sends.
    const preWrite = nextRecord(stored?.platformMessageId);
    try {
      await context.storage.set(stateKey, preWrite);
      countWrite();
    } catch {
      try {
        await context.storage.set(stateKey, preWrite);
        countWrite();
      } catch (error) {
        throw lifecycleError(
          'PLUGIN_INTERNAL',
          `lifecycle ${event.lifecycleId} state pre-write failed: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      }
    }

    const safely = async (label: string, effect: () => unknown | Promise<unknown>): Promise<boolean> => {
      try {
        await effect();
        return true;
      } catch (error) {
        context.log('warn', `Connector lifecycle ${label} failed`, {
          lifecycleId: event.lifecycleId,
          state: event.state,
          errorName: error instanceof Error ? error.name : 'unknown',
        });
        return false;
      }
    };

    switch (event.state) {
      case 'started':
        // Resolve the sender name before the safely() wrapper: a throwing
        // callback must not take down the whole placeholder send. resolve()
        // in reply-sender-map already swallows storage errors; this catch
        // covers every other failure reason.
        let senderName: string | undefined;
        if (event.replyTo !== undefined && callbacks.resolveReplySenderName !== undefined) {
          try {
            senderName = await callbacks.resolveReplySenderName(event.replyTo);
          } catch (error) {
            context.log('warn', 'Connector lifecycle sender name resolution failed', {
              lifecycleId: event.lifecycleId,
              errorName: error instanceof Error ? error.name : 'unknown',
            });
            senderName = undefined;
          }
        }
        const senderSuffix = senderName ? `→${senderName}` : '';
        await safely('placeholder send', async () => {
          const displayName = actorDisplayName || '猫猫';
          const placeholderLine = event.placeholderLine ?? STARTED_TEXT;
          const candidate = await callbacks.sendPlaceholder(
            binding.key,
            `【${displayName}🐱${senderSuffix}】${placeholderLine}`,
          );
          platformMessageId = candidate.length > 0 ? candidate : undefined;
          if (platformMessageId !== undefined) {
            await callbacks.onPlaceholder?.(binding.key, platformMessageId, event.lifecycleId);
          }
        });
        break;
      case 'catching_up':
        if (platformMessageId !== undefined) {
          await safely('catching-up edit', () => callbacks.editPlaceholder(
            binding.key,
            platformMessageId!,
            CATCHING_UP_TEXT,
            'catching_up',
            event.lifecycleId,
          ));
        }
        break;
      case 'blocked':
        {
          const text = recoveryText(event);
          const edited = platformMessageId !== undefined && await safely('blocked edit', async () => {
            const applied = await callbacks.editPlaceholder(
              binding.key,
              platformMessageId!,
              text,
              'blocked',
              event.lifecycleId,
            );
            if (!applied) throw new Error('placeholder is no longer editable');
          });
          if (!edited) {
            await safely('blocked recovery send', () => callbacks.sendRecovery(binding.key, text));
          }
        }
        break;
      case 'settled': {
        const blocked = [...history].reverse().find((candidate): candidate is Extract<LifecycleEvent, { readonly state: 'blocked' }> => (
          candidate.state === 'blocked'
        ));
        await safely('settlement', () => callbacks.settle({
          externalConversationId: binding.key,
          ...(platformMessageId === undefined ? {} : { platformMessageId }),
          actorDisplayName,
          ...(blocked === undefined ? {} : { recoveryText: recoveryText(blocked) }),
          event,
        }));
        break;
      }
    }

    try {
      await context.storage.set(stateKey, nextRecord(platformMessageId));
      countWrite();
    } catch (error) {
      // Post-write failure is warn-only: the event already sits in history
      // via the write-ahead, so a Host replay of this delivery is answered
      // as replay and never re-runs the platform side effects. The only
      // loss is the fresh platformMessageId, covered by the existing
      // undefined-platformMessageId fallback for later edits.
      context.log('warn', 'Connector lifecycle state post-write failed', {
        lifecycleId: event.lifecycleId,
        state: event.state,
        errorName: error instanceof Error ? error.name : 'unknown',
      });
    }
    return { deliveryId: event.deliveryId };
  };

  const action = defineLifecycleAction(async (event) => {
    const previous = tails.get(event.lifecycleId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => handle(event));
    const tail = current.then(() => undefined, () => undefined);
    tails.set(event.lifecycleId, tail);
    try {
      return await current;
    } finally {
      if (tails.get(event.lifecycleId) === tail) tails.delete(event.lifecycleId);
    }
  });
  // Test/debug hook: force the background sweep synchronously.
  return Object.assign(action, { sweepNow: sweep });
}
