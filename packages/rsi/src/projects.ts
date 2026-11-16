import { basename } from 'node:path';
import type { Data, RsiHost, RsiState } from './types.js';

export async function projects(host: RsiHost) {
  const paths = new Set<string>();
  let before: { id: string; lastActiveAt: number } | undefined;
  for (;;) {
    const rows = await host.threads.list({ limit: 100, ...(before ? { before } : {}) });
    for (const row of rows) if (row.projectRef) paths.add(row.projectRef);
    if (rows.length < 100) break;
    const last = rows[rows.length - 1];
    before = { id: last.id, lastActiveAt: last.lastActiveAt };
  }
  return [...paths].map((path) => ({ id: path, name: basename(path), exp: true, projectPath: path }));
}

export function mergeProjects(state: RsiState, live: Data[]) {
  const demos = state.projects.filter((p) => !p.projectPath);
  state.projects = [...live, ...demos];
  for (const project of live) {
    state.objectives[project.id] ||= [];
    state.groups[project.id] ||= [];
    state.units[project.id] ||= [];
    state.library[project.id] ||= [];
    state.policy[project.id] ||= {};
  }
}
