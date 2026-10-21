import type { PluginThreadHost, PluginThreadSummary } from '@clowder-ai/plugin-sdk';

/** Resolve an owner-visible summary through metadata grants; never request thread contents. */
export async function findThreadMetadata(threads: Pick<PluginThreadHost, 'list'>,
  id: string): Promise<PluginThreadSummary | null> {
  let before: { lastActiveAt: number; id: string } | undefined;
  for (;;) {
    const page = await threads.list({ limit: 50, ...(before ? { before } : {}) });
    const found = page.find(thread => thread.id === id);
    if (found) return found;
    if (page.length < 50) return null;
    const last = page.at(-1)!;
    before = { lastActiveAt: last.lastActiveAt, id: last.id };
  }
}
