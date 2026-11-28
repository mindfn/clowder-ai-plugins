import { record, text } from './store.js';
import type { Data, Experiment } from './types.js';

export interface Tier {
  id: string; label: string; requireControl: boolean; seedPolicy: 'fresh' | 'fixed'; requireCycleVars: boolean;
  resourceVars?: string[];
  promoteFrom?: string; promotion?: { verdicts: string[]; minCycles: number; sameScenario?: boolean };
}
const positiveVerdicts = ['keep', 'tune', 'baseline'];
export function validateTiers(value: unknown): string | null {
  if (!Array.isArray(value) || !value.length || value.length > 12) return 'tiers must contain 1–12 ordered levels';
  const seen = new Set<string>();
  for (const [i, t] of value.entries()) {
    if (!record(t) || !text(t.id) || !/^[a-zA-Z0-9_-]+$/.test(t.id) || seen.has(t.id) || !text(t.label)
      || typeof t.requireControl !== 'boolean' || typeof t.requireCycleVars !== 'boolean' || !['fresh','fixed'].includes(t.seedPolicy)) return 'Each tier needs a unique id, label, requireControl, seedPolicy (fresh/fixed), and requireCycleVars';
    if (i === 0 ? t.promoteFrom !== undefined : !seen.has(t.promoteFrom)) return 'Each higher tier must reference an earlier promoteFrom tier';
    if (t.promotion !== undefined && (!record(t.promotion) || !Array.isArray(t.promotion.verdicts) || !t.promotion.verdicts.length || t.promotion.verdicts.some((v: unknown) => !positiveVerdicts.includes(String(v))) || !Number.isInteger(t.promotion.minCycles) || t.promotion.minCycles < 1 || t.promotion.minCycles > 20 || t.promotion.sameScenario !== undefined && typeof t.promotion.sameScenario !== 'boolean')) return 'promotion requires positive verdicts and minCycles (1–20), with optional sameScenario';
    if (t.resourceVars !== undefined && (!Array.isArray(t.resourceVars) || t.resourceVars.length > 32 || t.resourceVars.some((k: unknown) => !text(k) || ['seed', 'tier', 'reservedSeeds', 'pairedPlan'].includes(String(k))) || new Set(t.resourceVars).size !== t.resourceVars.length)) return 'resourceVars must be distinct resource/topology parameter names (not executor protocol fields)';
    seen.add(t.id);
  }
  const top = value.at(-1);
  if (!top.requireControl || top.seedPolicy !== 'fresh') return 'The adoption tier must require control and fresh seeds';
  return null;
}

// Legacy rules are projected, never migrated into stored historical records.
export function tiersOf(d: Experiment): Tier[] {
  return d.policy.tiers || [
    { id: 'explore', label: '探索', requireControl: false, seedPolicy: 'fresh', requireCycleVars: !!d.policy.requireCycleVars },
    { id: 'confirm', label: '确认', requireControl: true, seedPolicy: 'fresh', requireCycleVars: !!d.policy.requireCycleVars },
  ];
}
export function tierOf(d: Experiment, plan: Data): Tier | undefined {
  const tiers = tiersOf(d);
  return tiers.find((t) => t.id === (plan.tier || (d.policy.tiers ? tiers[0].id : 'confirm')));
}
export function screeningRound(round: Data): boolean {
  return round.plan.tierRule ? !round.plan.tierRule.adoption : round.plan.tier === 'explore';
}
const canonical = (v: any): string => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : record(v) ? `{${Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')}}` : JSON.stringify(v);
const same = (a: unknown,b: unknown) => canonical(a) === canonical(b);

// Compare the config actually submitted, not just the group's nominal overrides. File
// bases can only be reused when pinned to the same commit; a mutable path is not proof.
function sameParameters(d: Experiment, plan: Data, group: Data, round: Data, old: Data): boolean {
  const version = d.versions.find((v: Data) => v.id === (group.version || d.objective.currentVersion));
  if (!version) return false;
  const targetRule = tierOf(d, plan);
  const resourceKeys = (round.plan.tierRule.resourceVars || []).filter((k: string) => targetRule?.resourceVars?.includes(k));
  const identity = (values: Data) => Object.fromEntries(Object.entries(values).filter(([k]) =>
    !['seed', 'tier', 'reservedSeeds', 'pairedPlan'].includes(k) && !resourceKeys.includes(k)));
  return round.runs.filter((run: Data) => run.group === old.id).every((run: Data) => {
    const snapshot = run.parameters;
    if (!snapshot || !same(snapshot.config, version.config) || snapshot.commit !== (version.commit || null)) return false;
    if (typeof version.config === 'string' && !version.commit) return false;
    const desired = { ...snapshot.base, ...version.vars, ...group.vars, ...plan.cycleVars };
    return same(identity(snapshot.effective), identity(desired));
  });
}

export function sliceGuardsPass(metrics: Data, round: Data): boolean {
  return (metrics.slices || []).every((spec: Data) => {
    const guards = spec.stats.filter((s: Data) => typeof s.threshold === 'number');
    if (!guards.length) return true;
    // Every observed workload level must be measured in every arm/seed. A missing
    // required table or value is not a pass, even if other rows have good averages.
    const levels = new Set(round.runs.flatMap((run: Data) => (run.slices?.[spec.id] || []).map((row: Data) => String(row.at))));
    return levels.size > 0 && round.runs.every((run: Data) => [...levels].every(at => {
      const row = run.slices?.[spec.id]?.find((row: Data) => String(row.at) === at);
      return row && row.pass !== false && guards.every((s: Data) => {
        const value = row.values?.[s.id];
        return typeof value === 'number' && Number.isFinite(value) && (s.dir === 'up' ? value >= s.threshold : value <= s.threshold);
      });
    }));
  });
}

export function tierEvidence(d: Experiment, plan: Data, sourceTier: string, rule: Tier['promotion'] = { verdicts: ['keep','tune','baseline'], minCycles: 1 }): number[] {
  const currentRule = tiersOf(d).find((t) => t.id === sourceTier);
  const ruleIdentity = (t: Data) => ({ id: t.id, requireControl: t.requireControl, seedPolicy: t.seedPolicy,
    requireCycleVars: t.requireCycleVars, resourceVars: [...(t.resourceVars || [])].sort(), promoteFrom: t.promoteFrom,
    promotion: t.promoteFrom ? t.promotion || { verdicts: positiveVerdicts, minCycles: 1 } : undefined });
  const targets = plan.groups.filter((g: Data) => !g.control && g.id !== 'control');
  if (!targets.length) return [];
  return d.rounds.filter((r: Data) => {
    if (!currentRule || !r.plan.tierRule || !same(ruleIdentity(r.plan.tierRule), ruleIdentity({ ...currentRule, requireCycleVars: !!d.policy.requireCycleVars || currentRule.requireCycleVars }))) return false;
    if (r.tier !== sourceTier || r.state !== 'done' || r.aborted || !r.report || r.report.disposition === 'dead_end' || !rule.verdicts.includes(r.report.verdict)) return false;
    if (!plan.hypothesisIds?.length || !plan.hypothesisIds.every((id: string) => r.hypothesisIds?.includes(id))) return false;
    if (rule.sameScenario !== false && r.scenario !== plan.scenario) return false;
    const metrics = r.metrics || d.metricHistory?.find((m: Data) => m.version === r.metricVersion);
    if (!metrics || !same({version:metrics.version,items:metrics.items,slices:metrics.slices}, {version:d.metrics.version,items:d.metrics.items,slices:d.metrics.slices})) return false;
    if (!r.plan.seeds?.length || !r.plan.groups?.length || r.runs.some((run: Data) => run.error || run.state !== 'done' || run.evidence !== true)) return false;
    const guards = metrics.items.filter((m: Data) => m.guard);
    if (r.runs.some((run: Data) => guards.some((m: Data) => {
      const value = run.metrics?.[m.id];
      return typeof value !== 'number' || !Number.isFinite(value) || (m.dir === 'up' ? value < m.threshold : value > m.threshold);
    }))) return false;
    if (!r.plan.groups.every((g: Data) => r.plan.seeds.every((seed: number) => r.runs.some((run: Data) => run.group === g.id && run.seed === seed && run.state === 'done' && run.evidence === true)))) return false;
    if (!sliceGuardsPass(metrics, r)) return false;
    const candidates = r.plan.groups.filter((g: Data) => !g.control && g.id !== 'control');
    const hasControl = r.plan.groups.some((g: Data) => g.control || g.id === 'control');
    // A whole-cycle verdict only identifies an arm in a single-arm screen. With
    // control, use the plugin's per-arm criterion; never borrow a control or peer's win.
    const qualified = candidates.filter((g: Data) => hasControl
      ? r.report.compare?.groups?.some((c: Data) => c.group === g.id && c.eligible === true && c.beatsControl === true)
      : candidates.length === 1 && r.plan.tierRule.requireControl === false);
    return targets.every((g: Data) => qualified.some((old: Data) =>
      old.version === (g.version || d.objective.currentVersion) && sameParameters(d, plan, g, r, old)));
  }).map((r: Data) => r.n);
}

export function tierBlocker(d: Experiment, plan: Data, tier: Tier): string | null {
  if (!tier.promoteFrom) return null;
  const needed = tier.promotion?.minCycles || 1;
  const found = tierEvidence(d, plan, tier.promoteFrom, tier.promotion);
  return found.length >= needed ? null : `${tier.promoteFrom} → ${tier.id}: ${found.length}/${needed}`;
}
