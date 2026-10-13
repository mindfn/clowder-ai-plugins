import type { PluginTaskReadItem } from '@clowder-ai/plugin-sdk';
/** Read-only fields consumed by the original owner view. These are not admission/execution authority. */
export interface OwnerViewThread { readonly id: string; readonly title: string | null; readonly createdBy: string;
  readonly participants: readonly string[]; readonly deletedAt?: number | null; }
export interface OwnerQueueCustody { readonly executionScope: string; readonly allTargetCats: readonly string[];
  readonly handledByCatIds: readonly string[]; readonly failedByCatIds: readonly string[]; readonly seenByCatIds: readonly string[];
  readonly targetOutcomeByCatId?: Readonly<Record<string, unknown>>; readonly bodyExposures?: readonly { readonly targetCatId: string }[]; }
export interface OwnerViewMessage { readonly id: string; readonly userId: string; readonly threadId: string;
  readonly source?: { readonly meta?: Readonly<Record<string, unknown>> }; readonly queueCustody?: OwnerQueueCustody; }
export type OwnerViewTask = PluginTaskReadItem;
export interface OwnerViewThreadStore { list(userId: string): Promise<readonly OwnerViewThread[]>; }
export interface OwnerViewMessageStore { getById(id: string): Promise<OwnerViewMessage | null | undefined>; }
export interface OwnerViewTaskStore { listByKind(kind: 'work'): Promise<readonly OwnerViewTask[]>; }
