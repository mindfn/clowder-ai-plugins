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
  readonly version: 1;
  readonly history: readonly LifecycleEvent[];
  readonly platformMessageId?: string;
  readonly actorDisplayName: string;
}

const STARTED_TEXT = '🤔 思考中...';
const CATCHING_UP_TEXT = '🔄 收到新消息，正在重新整理回复…';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function lifecycleError(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}

function storedLifecycle(value: unknown): StoredLifecycle {
  if (!object(value)
    || value.version !== 1
    || !Array.isArray(value.history)
    || typeof value.actorDisplayName !== 'string'
    || (value.platformMessageId !== undefined && typeof value.platformMessageId !== 'string')) {
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

  const handle = async (event: LifecycleEvent) => {
    const stateKey = `lifecycle/${event.lifecycleId}`;
    const entry = await context.storage.get(stateKey);
    const stored = entry === undefined ? undefined : storedLifecycle(entry.value);
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
    let actorDisplayName = stored?.actorDisplayName ?? '';
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
        actorDisplayName = event.presentation.actor.displayName;
        await safely('placeholder send', async () => {
          const displayName = actorDisplayName || '猫猫';
          const candidate = await callbacks.sendPlaceholder(
            binding.key,
            `【${displayName}🐱】${STARTED_TEXT}`,
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

    await context.storage.set(stateKey, {
      version: 1,
      history: [...history, event],
      ...(platformMessageId === undefined ? {} : { platformMessageId }),
      actorDisplayName,
    } satisfies StoredLifecycle);
    return { deliveryId: event.deliveryId };
  };

  return defineLifecycleAction(async (event) => {
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
}
