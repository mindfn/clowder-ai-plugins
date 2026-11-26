import { basename, dirname } from 'node:path';
import type { Data, RsiHost, RsiState } from './types.js';

export const PROJECTS_TTL_MS = 30_000;

interface ProjectsCacheEntry {
  at: number;
  live?: Data[];
  inflight?: Promise<Data[]>;
}

const projectsCache = new WeakMap<RsiHost, ProjectsCacheEntry>();
const threadProjectCache = new WeakMap<RsiHost, Map<string, { at: number; projectRef: string }>>();

export function invalidateProjects(host: RsiHost) {
  projectsCache.delete(host);
}

export async function projects(host: RsiHost, options?: { fresh?: boolean }): Promise<Data[]> {
  const now = Date.now();
  const entry = projectsCache.get(host);
  if (!options?.fresh && entry?.live && now - entry.at < PROJECTS_TTL_MS) return entry.live;
  if (!options?.fresh && entry?.inflight) return entry.inflight;
  const load = (async () => {
    const paths = new Set<string>();
    let before: { id: string; lastActiveAt: number } | undefined;
    for (;;) {
      const rows = await host.threads.list({ limit: 50, ...(before ? { before } : {}) });
      for (const row of rows) if (row.projectRef && row.projectRef !== 'default') paths.add(row.projectRef);
      if (rows.length < 50) break;
      const last = rows[rows.length - 1];
      before = { id: last.id, lastActiveAt: last.lastActiveAt };
    }
    const names = [...paths].map((path) => basename(path));
    return [...paths].map((path, i) => ({
      id: path,
      name: names.indexOf(names[i]) === names.lastIndexOf(names[i]) ? names[i] : basename(dirname(path)) + '/' + names[i],
      exp: true,
      projectPath: path,
    }));
  })();
  const nextEntry: ProjectsCacheEntry = { at: entry?.at ?? 0, live: entry?.live, inflight: load };
  projectsCache.set(host, nextEntry);
  try {
    const live = await load;
    if (projectsCache.get(host) === nextEntry) {
      projectsCache.set(host, { at: Date.now(), live });
    }
    return live;
  } catch (err) {
    if (projectsCache.get(host) === nextEntry) {
      if (nextEntry.live) projectsCache.set(host, { at: nextEntry.at, live: nextEntry.live });
      else projectsCache.delete(host);
    }
    throw err;
  }
}

export async function threadProject(host: RsiHost, threadId: string): Promise<string | undefined> {
  const now = Date.now();
  let map = threadProjectCache.get(host);
  const hit = map?.get(threadId);
  if (hit && now - hit.at < PROJECTS_TTL_MS) return hit.projectRef;
  const projectRef = (await host.threads.get(threadId).catch(() => null))?.projectRef;
  if (typeof projectRef === 'string' && projectRef) {
    if (!map) threadProjectCache.set(host, map = new Map());
    if (map.size >= 256) map.clear();
    map.set(threadId, { at: Date.now(), projectRef });
  }
  return projectRef;
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

export function withLiveProjects(state: RsiState, live: Data[]): RsiState {
  const demos = state.projects.filter((p) => !p.projectPath);
  const objectives = { ...state.objectives };
  const groups = { ...state.groups };
  const units = { ...state.units };
  const library = { ...state.library };
  const policy = { ...state.policy };
  for (const project of live) {
    objectives[project.id] ||= [];
    groups[project.id] ||= [];
    units[project.id] ||= [];
    library[project.id] ||= [];
    policy[project.id] ||= {};
  }
  return { ...state, projects: [...live, ...demos], objectives, groups, units, library, policy };
}
