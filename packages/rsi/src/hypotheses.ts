import { randomUUID } from 'node:crypto';
import { record, text } from './store.js';
import type { Data, Experiment } from './types.js';

export function collectHypotheses(d: Experiment, round: Data, now: number) {
  for (const direction of round.report?.directions || []) {
    if (!['code', 'variable', 'discriminate'].includes(direction.kind)) continue;
    const pool: Data[] = d.hypotheses ||= [];
    if (pool.some((h) => h.source.kind === 'direction' && h.source.cycle === round.n && h.source.directionId === direction.id && h.source.member === direction.by)) continue;
    pool.push({ id: `h-${randomUUID()}`, title: direction.title,
      source: { kind: 'direction', cycle: round.n, directionId: direction.id, member: direction.by },
      note: direction.why, createdAt: now });
  }
}

export function editHypothesis(d: Experiment, input: Data, by: string, now: number): Data {
  // Console form values are text; native tools use the typed object directly.
  input = { ...input };
  if (input.scenariosText !== undefined) {
    if (typeof input.scenariosText !== 'string') return { error: 'Invalid scenarios', status: 400 };
    input.scenarios = input.scenariosText.split(',').map((s: string) => s.trim()).filter(Boolean);
  }
  if (['cards','minutes','cardHours'].some((k) => input[k] !== undefined)) {
    const budget: Data = {};
    for (const k of ['cards','minutes','cardHours']) if (input[k] !== undefined && input[k] !== '') budget[k] = Number(input[k]);
    input.budget = Object.keys(budget).length ? budget : null;
  }
  if (input.hypothesisId === '') delete input.hypothesisId;
  const existing = input.hypothesisId === undefined ? undefined : (d.hypotheses || []).find((h: Data) => h.id === input.hypothesisId);
  if (input.hypothesisId !== undefined && !existing) return { error: 'Hypothesis not found', status: 404 };
  if ((!existing || input.title !== undefined) && (!text(input.title) || input.title.trim().length > 240)) return { error: 'Provide a hypothesis title of 1–240 characters', status: 400 };
  if (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 2000)) return { error: 'note must be a string of up to 2000 characters', status: 400 };
  if (input.archived !== undefined && typeof input.archived !== 'boolean') return { error: 'archived must be a boolean', status: 400 };
  if (input.scenarios !== undefined && (!Array.isArray(input.scenarios) || input.scenarios.some((s: unknown) => !text(s)) || new Set(input.scenarios).size !== input.scenarios.length)) return { error: 'scenarios must be distinct non-empty strings', status: 400 };
  if (input.budget !== undefined && input.budget !== null && (!record(input.budget) || Object.entries(input.budget).some(([k,v]) => !['cards','minutes','cardHours'].includes(k) || typeof v !== 'number' || !Number.isFinite(v) || v < 0))) return { error: 'budget accepts non-negative finite cards/minutes/cardHours', status: 400 };
  const h = existing || { id: `h-${randomUUID()}`, source: { kind: 'manual', by }, createdAt: now };
  for (const k of ['title', 'note', 'scenarios', 'budget', 'archived']) if (input[k] !== undefined) h[k] = structuredClone(k === 'title' ? input[k].trim() : input[k]);
  if (!existing) (d.hypotheses ||= []).push(h);
  return { ok: true, hypothesisId: h.id };
}

export function hypothesisViews(d: Experiment) {
  return (d.hypotheses || []).map((h: Data) => {
    const rounds = d.rounds.filter((r: Data) => r.hypothesisIds?.includes(h.id));
    const latest = rounds.at(-1);
    const status = h.archived ? 'archived' : !latest ? 'untested'
      : ['running','evaluating','interrupted','aborting'].includes(latest.state) ? 'working'
      : latest.aborted?.reason === 'env' || latest.runs.some((r: Data) => r.error?.kind === 'env') ? 'blocked'
      : latest.report?.disposition === 'dead_end' || ['rollback','sunset'].includes(latest.report?.verdict) ? 'negative'
      : latest.aborted || !latest.report || latest.report.verdict === 'insufficient' ? 'incomplete'
      : latest.report.compare?.groups?.some((g: Data) => g.beatsControl) ? 'positive' : 'tested';
    return { ...h, scenariosText: (h.scenarios || []).join(', '), status, cycles: rounds.map((r: Data) => r.n), latestCycle: latest?.n ?? null,
      versions: d.versions.filter((v: Data) => v.hypothesisId === h.id).map((v: Data) => v.id) };
  });
}

export function planAssociations(d: Experiment, plan: Data): string | null {
  if (plan.scenario !== undefined && !text(plan.scenario)) return 'scenario must be a non-empty string';
  if (plan.scenario && d.policy.scenarios?.length && !d.policy.scenarios.includes(plan.scenario)) return 'scenario is not in the experiment specification';
  if (plan.hypothesisIds !== undefined && (!Array.isArray(plan.hypothesisIds) || new Set(plan.hypothesisIds).size !== plan.hypothesisIds.length || plan.hypothesisIds.some((id: unknown) => !(d.hypotheses || []).some((h: Data) => h.id === id && !h.archived)))) return 'hypothesisIds must reference distinct active hypotheses';
  return null;
}
