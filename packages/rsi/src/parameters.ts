import { createHash } from 'node:crypto';
import { record } from './store.js';
import type { Data } from './types.js';

const canonical = (v: any): string => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : record(v) ? `{${Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',')}}` : JSON.stringify(v);
export const fingerprint = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
const resourceKeys = (plan: Data): string[] => [...(plan.tierRule?.resourceVars || [])].sort();
const scientific = (values: Data, resources: string[]) => Object.fromEntries(Object.entries(values).filter(([key]) =>
  !['seed', 'tier', 'reservedSeeds', 'pairedPlan'].includes(key) && !resources.includes(key)));

// File contents are deliberately not guessed here. The execution boundary checks
// the resolved config against prior evidence before submitting any candidate job.
export function plannedParameters(version: Data, group: Data, plan: Data): Data {
  const resources = resourceKeys(plan), overrides = { ...version.vars, ...group.vars, ...plan.cycleVars };
  return { format: 3, definition: fingerprint({ config: version.config, commit: version.commit || null }),
    resources: fingerprint(resources), overrides: fingerprint(scientific(overrides, resources)),
    ...(record(version.config) ? { effective: fingerprint(scientific({ ...version.config, ...overrides }, resources)) } : {}) };
}

export function executionParameters(version: Data, group: Data, plan: Data, effective: Data, revision: string | null, measurement = fingerprint({})): Data {
  return { ...plannedParameters(version, group, plan), effective: fingerprint(scientific(effective, resourceKeys(plan))), revision, measurement };
}

export function parametersMatch(snapshot: Data | undefined, expected: Data, actual?: Data): boolean {
  if (snapshot?.format !== 3 || typeof snapshot.effective !== 'string' || typeof snapshot.measurement !== 'string' || snapshot.revision === undefined) return false;
  const fields = Object.entries(expected).filter(([key]) => key !== 'overrides' || expected.effective === undefined);
  if (!fields.every(([key, value]) => snapshot[key] === value)) return false;
  return !actual || actual.format === 3 && fields.every(([key, value]) => actual[key] === value)
    && actual.effective === snapshot.effective && actual.revision === snapshot.revision && actual.measurement === snapshot.measurement;
}
