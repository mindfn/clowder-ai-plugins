import type { CommunityEvent } from '../../model/index.js';
import type { GitHubTarget } from '../../../tracking-runtime.js';

export interface RoutingTrackingPort {
  register(target: GitHubTarget): Promise<unknown>;
}

/**
 * Preserve case.routed → automatic tracking, but register in this plugin's
 * private runtime, not a Host task/automationState projection.
 * Call only for newly ingested canonical routing events, never projector replay.
 * Runtime registration seeds both comment endpoints and fails closed on a failed
 * baseline read; it cannot silently replay all history after a seed failure.
 */
export async function registerRoutingTracking(event: CommunityEvent, tracking: RoutingTrackingPort): Promise<void> {
  if (event.kind !== 'case.routed') return;
  const threadId = typeof event.payload.ownerThreadId === 'string' ? event.payload.ownerThreadId : '';
  const catId = typeof event.payload.catId === 'string' ? event.payload.catId : '';
  if (!threadId || !catId) return;
  const subject = /^(pr|issue):([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)$/.exec(event.subjectKey);
  if (!subject) throw new TypeError('Invalid routed GitHub subject');
  await tracking.register({
    kind: subject[1] as 'pr' | 'issue', repoFullName: subject[2]!, number: Number(subject[3]), threadId, catId,
  });
}
