import { short, signed, testedVersion } from './cycles.js';
import { record, text } from './store.js';
import type { Data, Experiment } from './types.js';

export interface SliceStatSpec {
  id: string;
  name: string;
  unit?: string;
  dir: 'up' | 'down';
  threshold?: number;
  primary?: boolean;
}

export interface SliceTableSpec {
  id: string;
  name: string;
  axis: string;
  axisUnit?: string;
  stats: SliceStatSpec[];
}

export interface SliceRowInput {
  at: string | number;
  values: Record<string, number>;
  pass?: boolean;
}

const MAX_SLICE_TABLES = 8;
const MAX_SLICE_ROWS = 64;
const MAX_SLICE_STATS = 24;
const MAX_ADD_COLS = 24;

const numStr = (x: unknown): string | null =>
  typeof x === 'number' && Number.isFinite(x) ? short(x) : null;

export function validateSliceSpecs(raw: unknown): string | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_SLICE_TABLES) {
    return `metrics.slices must be an array of 1–${MAX_SLICE_TABLES} slice tables`;
  }
  const tableIds = new Set<string>();
  for (const tbl of raw) {
    if (!record(tbl) || !text(tbl.id) || !text(tbl.name) || !text(tbl.axis)) {
      return 'Each slice table requires non-empty id, name and axis';
    }
    if (tableIds.has(tbl.id)) return `Duplicate slice table id: ${tbl.id}`;
    tableIds.add(tbl.id);
    if (tbl.axisUnit !== undefined && typeof tbl.axisUnit !== 'string') {
      return `Slice table ${tbl.id} axisUnit must be a string`;
    }
    if (!Array.isArray(tbl.stats) || !tbl.stats.length || tbl.stats.length > MAX_SLICE_STATS) {
      return `Slice table ${tbl.id} requires 1–${MAX_SLICE_STATS} stats`;
    }
    const statIds = new Set<string>();
    for (const s of tbl.stats) {
      if (!record(s) || !text(s.id) || !text(s.name) || !['up', 'down'].includes(s.dir)) {
        return `Each stat in slice table ${tbl.id} requires id, name and dir ("up" | "down")`;
      }
      if (statIds.has(s.id)) return `Duplicate stat id ${s.id} in slice table ${tbl.id}`;
      statIds.add(s.id);
      if (s.unit !== undefined && typeof s.unit !== 'string') return `Stat ${s.id} unit must be a string`;
      if (s.primary !== undefined && typeof s.primary !== 'boolean') return `Stat ${s.id} primary must be a boolean`;
      if (s.threshold !== undefined && !(typeof s.threshold === 'number' && Number.isFinite(s.threshold))) {
        return `Stat ${s.id} threshold must be a finite number`;
      }
    }
  }
  return null;
}

export function normalizeSlicesInput(raw: unknown): Record<string, SliceRowInput[]> | undefined {
  if (!record(raw)) return undefined;
  const out: Record<string, SliceRowInput[]> = {};
  let tableCount = 0;
  for (const [tableId, rows] of Object.entries(raw)) {
    if (!text(tableId) || !Array.isArray(rows) || tableCount >= MAX_SLICE_TABLES) continue;
    const cleanRows: SliceRowInput[] = [];
    for (const row of rows) {
      if (cleanRows.length >= MAX_SLICE_ROWS || !record(row)) continue;
      const at = typeof row.at === 'number' && Number.isFinite(row.at)
        ? row.at
        : text(row.at) ? row.at.trim() : null;
      if (at === null || !record(row.values)) continue;
      const values: Record<string, number> = {};
      for (const [k, v] of Object.entries(row.values)) {
        if (text(k) && typeof v === 'number' && Number.isFinite(v)) values[k] = v;
      }
      if (!Object.keys(values).length) continue;
      cleanRows.push({ at, values, ...(typeof row.pass === 'boolean' ? { pass: row.pass } : {}) });
    }
    if (cleanRows.length) {
      out[tableId.trim()] = cleanRows;
      tableCount++;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function sortSliceKeys(keys: (string | number)[]): (string | number)[] {
  const allNum = keys.length > 0 && keys.every((k) => typeof k === 'number' || (typeof k === 'string' && /^-?\d+(\.\d+)?$/.test(k.trim())));
  if (!allNum) return keys;
  return [...keys].sort((a, b) => Number(a) - Number(b));
}

export function sliceSpecsOf(d: Experiment, round: Data): SliceTableSpec[] {
  const declared: SliceTableSpec[] = Array.isArray((round.metrics || d.metrics)?.slices)
    ? (round.metrics || d.metrics).slices
    : [];
  const byId = new Map<string, SliceTableSpec>(declared.map((s) => [s.id, s]));
  const extraOrder: string[] = [];
  const extraStats = new Map<string, Set<string>>();
  for (const run of round.runs || []) {
    if (!record(run.slices)) continue;
    for (const [tid, rows] of Object.entries(run.slices)) {
      if (byId.has(tid) || !Array.isArray(rows)) continue;
      if (!extraStats.has(tid)) { extraStats.set(tid, new Set()); extraOrder.push(tid); }
      const set = extraStats.get(tid)!;
      for (const row of rows) {
        if (record(row) && record(row.values)) {
          for (const k of Object.keys(row.values)) set.add(k);
        }
      }
    }
  }
  const inferred: SliceTableSpec[] = extraOrder.map((tid) => ({
    id: tid,
    name: tid,
    axis: tid,
    stats: [...(extraStats.get(tid) || [])].slice(0, MAX_SLICE_STATS).map((sid, idx) => ({
      id: sid,
      name: sid,
      dir: 'up' as const,
      ...(idx === 0 ? { primary: true } : {}),
    })),
  })).filter((t) => t.stats.length > 0);
  return [...declared, ...inferred];
}

export function sliceMatrix(d: Experiment, round: Data): Data[] {
  const specs = sliceSpecsOf(d, round);
  if (!specs.length) return [];
  const out: Data[] = [];
  for (const spec of specs) {
    const levelMap = new Map<string, string | number>();
    for (const run of round.runs || []) {
      const rows = run.slices?.[spec.id];
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (!record(row) || row.at === undefined || row.at === null) continue;
        const key = String(row.at);
        if (!levelMap.has(key)) levelMap.set(key, row.at);
      }
    }
    if (!levelMap.size) continue;
    const levels = sortSliceKeys([...levelMap.values()]);
    const cells: Data[] = [];
    for (const group of round.plan?.groups || []) {
      const groupRuns = (round.runs || []).filter((r: Data) => r.group === group.id);
      for (const at of levels) {
        const atKey = String(at);
        const matchedRuns = groupRuns.map((run: Data) => {
          const rows = Array.isArray(run.slices?.[spec.id]) ? run.slices[spec.id] : [];
          const row = rows.find((x: Data) => record(x) && String(x.at) === atKey) || null;
          return { seed: run.seed, state: run.state, error: run.error, row };
        });
        const validRuns = matchedRuns.filter((x: Data) => x.state === 'done' && x.error?.kind !== 'env' && x.row);
        const statsAgg: Record<string, Data> = {};
        const thresholdStats = spec.stats.filter((s) => typeof s.threshold === 'number' && Number.isFinite(s.threshold));
        let allThresholdsPass = thresholdStats.length > 0 && validRuns.length > 0;
        for (const stat of spec.stats) {
          const seeds = matchedRuns.map((x: Data) => {
            const val = x.row?.values?.[stat.id];
            const finite = typeof val === 'number' && Number.isFinite(val);
            const pass = typeof stat.threshold === 'number' && Number.isFinite(stat.threshold) && finite
              ? (stat.dir === 'up' ? val >= stat.threshold : val <= stat.threshold)
              : null;
            return { seed: x.seed, value: finite ? val : null, pass, state: x.state, error: x.error };
          });
          const values = seeds.filter((s: Data) => s.state === 'done' && s.error?.kind !== 'env' && typeof s.value === 'number').map((s: Data) => s.value as number);
          const n = values.length;
          const mean = n ? values.reduce((a: number, b: number) => a + b, 0) / n : null;
          const sd = n > 1 ? Math.sqrt(values.reduce((sum: number, v: number) => sum + (v - mean!) ** 2, 0) / (n - 1)) : null;
          const statPass = typeof stat.threshold === 'number' && Number.isFinite(stat.threshold) && n > 0
            ? seeds.filter((s: Data) => s.state === 'done' && s.error?.kind !== 'env').every((s: Data) => s.pass === true)
            : null;
          if (statPass === false) allThresholdsPass = false;
          statsAgg[stat.id] = { mean, sd, n, pass: statPass, seeds: seeds.map((s: Data) => ({ seed: s.seed, value: s.value, pass: s.pass })) };
        }
        const reportedPass = validRuns.filter((x: Data) => typeof x.row?.pass === 'boolean').map((x: Data) => x.row.pass as boolean);
        let pass: boolean | null = null;
        if (validRuns.length > 0) {
          if (thresholdStats.length > 0 && reportedPass.length > 0) {
            pass = allThresholdsPass && reportedPass.every(Boolean);
          } else if (thresholdStats.length > 0) {
            pass = allThresholdsPass;
          } else if (reportedPass.length > 0) {
            pass = reportedPass.every(Boolean);
          }
        }
        cells.push({ group: group.id, at, stats: statsAgg, pass, n: validRuns.length });
      }
    }
    out.push({
      id: spec.id,
      name: spec.name,
      axis: spec.axis,
      ...(spec.axisUnit ? { axisUnit: spec.axisUnit } : {}),
      stats: spec.stats,
      levels,
      cells,
    });
  }
  return out;
}

export function roundSlicesOf(d: Experiment, round: Data): Data[] {
  if (Array.isArray(round.report?.slices) && round.report.slices.length) return round.report.slices;
  return sliceMatrix(d, round);
}

interface ColRef {
  id: string;
  cycle: number;
  cycleLabel: string;
  groupId: string;
  groupLabel: string;
  version: string;
  role: 'control' | 'candidate' | 'confirm' | 'explore' | 'ref';
  sameCycle: boolean;
  current: boolean;
  parent: boolean;
  metricVersion: string;
  round: Data;
  group: Data;
}

function primaryGroupOfRound(r: Data): Data | null {
  const groups: Data[] = Array.isArray(r.plan?.groups) ? r.plan.groups : [];
  const tested = groups.filter((g) => g.version === r.version);
  const nonCtrl = tested.filter((g) => !g.control);
  if (nonCtrl.length) {
    const eligibleIds = new Set((r.report?.compare?.groups || []).filter((g: Data) => g.eligible).map((g: Data) => g.group));
    return nonCtrl.find((g) => eligibleIds.has(g.id)) || nonCtrl[0];
  }
  return tested[0] || groups.find((g) => !g.control) || groups[0] || null;
}

function buildColumnPool(d: Experiment, round: Data, allRounds: Data[]): { pool: ColRef[]; defaults: string[] } {
  const verObj = d.versions.find((v: Data) => v.id === round.version);
  const parentVer = verObj?.parent || '';
  const curVer = d.objective.currentVersion || '';
  const scaleOf = (r: Data) => (r.metrics || d.metrics)?.version || '';
  const cycleLabelOf = (r: Data) => `${r.version}-${r.k ?? 1}`;

  const pool: ColRef[] = [];
  const seen = new Set<string>();
  const addCol = (r: Data, g: Data, sameCycle: boolean) => {
    const id = `c${r.n}:${g.id}`;
    if (seen.has(id)) return;
    seen.add(id);
    const hasCtrl = (r.plan?.groups || []).some((x: Data) => x.control);
    const role: ColRef['role'] = !sameCycle ? 'ref'
      : g.control ? 'control'
      : g.confirm ? 'confirm'
      : hasCtrl ? 'candidate'
      : 'explore';
    pool.push({
      id,
      cycle: r.n,
      cycleLabel: cycleLabelOf(r),
      groupId: g.id,
      groupLabel: g.label || g.id,
      version: g.version || r.version,
      role,
      sameCycle,
      current: (g.version || r.version) === curVer,
      parent: !!parentVer && (g.version || r.version) === parentVer,
      metricVersion: scaleOf(r),
      round: r,
      group: g,
    });
  };

  // Current cycle columns: control first, then candidates.
  const ownGroups: Data[] = [
    ...(round.plan?.groups || []).filter((g: Data) => g.control),
    ...(round.plan?.groups || []).filter((g: Data) => !g.control),
  ];
  for (const g of ownGroups) addCol(round, g, true);

  // Concluded historical rounds (most recent first, prioritizing currentVersion & parent).
  const otherRounds = allRounds
    .filter((x: Data) => x.n !== round.n && x.report && (x.report.matrix || []).some((c: Data) => typeof c.mean === 'number' && Number.isFinite(c.mean)))
    .reverse();

  const prioritized = [
    ...otherRounds.filter((x) => x.version === curVer),
    ...otherRounds.filter((x) => x.version === parentVer && x.version !== curVer),
    ...otherRounds.filter((x) => x.version !== curVer && x.version !== parentVer),
  ];
  for (const x of prioritized) {
    const g = primaryGroupOfRound(x);
    if (g) addCol(x, g, false);
  }

  // Smart defaults: all current-cycle groups; if current cycle has only 1 group (e.g. skipControl explore),
  // automatically prepend 1 same-scale reference (currentVersion preferred, else parent).
  const defaults = pool.filter((c) => c.sameCycle).map((c) => c.id);
  if (defaults.length === 1) {
    const ownScale = scaleOf(round);
    const sameScaleRefs = pool.filter((c) => !c.sameCycle && c.metricVersion === ownScale);
    const bestRef = sameScaleRefs.find((c) => c.current) || sameScaleRefs.find((c) => c.parent);
    if (bestRef) defaults.unshift(bestRef.id);
  }

  return { pool, defaults };
}

function parseScopedSelection(raw: string | undefined, scope: string): string[] | null {
  if (!raw || typeof raw !== 'string') return null;
  const idx = raw.indexOf('|');
  if (idx < 0) return null;
  if (raw.slice(0, idx) !== scope) return null;
  const items = raw.slice(idx + 1).split(',').map((s) => s.trim()).filter(Boolean);
  return items.length ? items : null;
}

const encodeScoped = (scope: string, ids: string[]) => `${scope}|${ids.join(',')}`;

function colDisplayLabel(c: ColRef, hasControlInCycle: boolean): string {
  if (!c.sameCycle) return `${c.cycleLabel}`;
  if (c.role === 'control') return hasControlInCycle ? `对照 ${c.version}` : `本轮 ${c.version}`;
  if (c.role === 'confirm') return `复验 ${c.version}`;
  if (c.role === 'explore') return `探索 ${c.version}`;
  return `候选 ${c.version}`;
}

function colMenuLabel(c: ColRef, anchorScale: string): string {
  const tags: string[] = [];
  if (c.sameCycle) tags.push('本轮');
  else tags.push('跨周期参考');
  if (c.current) tags.push('当前默认');
  else if (c.parent) tags.push('父版本');
  if (anchorScale && c.metricVersion && c.metricVersion !== anchorScale) tags.push(`不同量尺 ${c.metricVersion}`);
  const base = c.sameCycle ? `${c.groupLabel} (${c.version})` : `${c.cycleLabel} · c${c.cycle}`;
  return `${base}${tags.length ? ` · ${tags.join(' · ')}` : ''}`;
}

function formatRatio(cand: number, base: number): string {
  if (!Number.isFinite(cand) || !Number.isFinite(base) || base <= 0 || cand <= 0) return '';
  const r = cand / base;
  if (!Number.isFinite(r) || Math.abs(r - 1) < 0.005) return '';
  return `${Number(r.toPrecision(3))}×`;
}

export interface CompareQueryOpts {
  activeTrendId?: string;
  seriesIds?: Set<string>;
  cmpCols?: string;
  cmpMetrics?: string;
  cmpStats?: string;
  cmpView?: string;
}

export function buildComparisonTable(
  d: Experiment,
  round: Data,
  allRounds: Data[],
  opts: CompareQueryOpts = {},
): Data {
  const objId = d.objective.id;
  const colScope = `${objId}:${round.n}`;
  const metricScope = objId;
  const items: Data[] = (round.metrics || d.metrics)?.items || [];
  const lead = items.find((m: Data) => !m.guard) || items[0];
  const { pool, defaults } = buildColumnPool(d, round, allRounds);
  const poolById = new Map<string, ColRef>(pool.map((c) => [c.id, c]));

  const requestedCols = parseScopedSelection(opts.cmpCols, colScope);
  const validRequestedCols = requestedCols ? requestedCols.filter((id) => poolById.has(id)) : null;
  const selectedColIds = validRequestedCols && validRequestedCols.length ? validRequestedCols : defaults;
  const colCustomized = !!(validRequestedCols && validRequestedCols.length && selectedColIds.join(',') !== defaults.join(','));
  const selectedCols = selectedColIds.map((id) => poolById.get(id)!).filter(Boolean);

  const hasControlInCycle = (round.plan?.groups || []).some((g: Data) => g.control) && (round.plan?.groups || []).some((g: Data) => !g.control);
  const sameCycleCtrlCol = selectedCols.find((c) => c.sameCycle && c.role === 'control') || null;
  const firstRefCol = selectedCols.find((c) => !c.sameCycle) || null;
  const firstSameCycleCol = selectedCols.find((c) => c.sameCycle) || null;
  const anchorCol = sameCycleCtrlCol || (firstRefCol && firstSameCycleCol ? firstRefCol : selectedCols[0]) || null;
  const compareCol = (anchorCol && sameCycleCtrlCol
    ? selectedCols.find((c) => c.id !== anchorCol.id && c.sameCycle) || selectedCols.find((c) => c.id !== anchorCol.id)
    : anchorCol && firstRefCol && firstSameCycleCol
      ? firstSameCycleCol
      : selectedCols.find((c) => c.id !== anchorCol?.id)) || null;
  const anchorScale = anchorCol?.metricVersion || (round.metrics || d.metrics)?.version || '';
  const hasPair = !!(anchorCol && compareCol);
  const pairSameCycle = !!(hasPair && anchorCol!.sameCycle && compareCol!.sameCycle);
  const pairSameScale = !!(hasPair && anchorCol!.metricVersion === compareCol!.metricVersion);
  const pairReferenceOnly = !!(hasPair && (!pairSameCycle || !sameCycleCtrlCol));

  const columns = selectedCols.map((c) => {
    const label = colDisplayLabel(c, hasControlInCycle);
    const sameScale = !anchorScale || !c.metricVersion || c.metricVersion === anchorScale;
    const crossCycle = !c.sameCycle;
    const nextIds = selectedColIds.filter((id) => id !== c.id);
    return {
      id: c.id,
      cycle: c.cycle,
      cycleLabel: c.cycleLabel,
      groupId: c.groupId,
      version: c.version,
      label,
      chipLabel: crossCycle ? `${label} · 跨周期参考` : label,
      chipTone: c.role === 'control' ? 'info' : crossCycle ? 'warn' : '',
      role: c.role,
      sameCycle: c.sameCycle,
      crossCycle,
      current: c.current,
      metricVersion: c.metricVersion,
      sameScale,
      isAnchor: anchorCol?.id === c.id,
      removable: selectedColIds.length > 1,
      removeVal: nextIds.length ? encodeScoped(colScope, nextIds) : '',
    };
  });

  const addColumns = pool
    .filter((c) => !selectedColIds.includes(c.id))
    .slice(0, MAX_ADD_COLS)
    .map((c) => ({
      id: c.id,
      menuLabel: colMenuLabel(c, anchorScale),
      addVal: encodeScoped(colScope, [...selectedColIds, c.id]),
    }));

  // Helper to read a metric cell for any ColRef
  const cellOf = (c: ColRef, metricId: string) =>
    (c.round.report?.matrix || []).find((m: Data) => m.group === c.groupId && m.metric === metricId) || null;
  const judgedOf = (c: ColRef) =>
    (c.round.report?.compare?.groups || []).find((g: Data) => g.group === c.groupId) || null;

  // Build ordered scalar metric definitions (lead first, then guardrails, then other)
  const orderedDefs: Data[] = lead
    ? [lead, ...items.filter((m: Data) => m.guard && m.id !== lead.id), ...items.filter((m: Data) => !m.guard && m.id !== lead.id)]
    : [...items];

  const seriesIds = opts.seriesIds || new Set<string>();
  const activeTrendId = opts.activeTrendId || lead?.id || '';

  const allMetricRows = orderedDefs.map((m: Data) => {
    const role = m === lead ? 'main' : m.guard ? 'guard' : 'other';
    const cells = selectedCols.map((c) => {
      const cell = cellOf(c, m.id);
      const j = judgedOf(c);
      const meanVal = typeof cell?.mean === 'number' && Number.isFinite(cell.mean) ? cell.mean : null;
      const sdVal = typeof cell?.sd === 'number' && Number.isFinite(cell.sd) ? cell.sd : null;
      const seedCount = Array.isArray(c.round.plan?.seeds) ? c.round.plan.seeds.length : 0;
      const checks = m.guard && j ? (j.guardrails || []).filter((x: Data) => x.metric === m.id) : [];
      const crossed = checks.filter((x: Data) => !x.pass).map((x: Data) => x.seed);
      let guardState = '';
      if (m.guard) {
        if (checks.length) guardState = crossed.length ? 'fail' : 'pass';
        else if (meanVal !== null && typeof m.threshold === 'number') {
          guardState = (m.dir === 'up' ? meanVal >= m.threshold : meanVal <= m.threshold) ? 'pass' : 'fail';
        }
      }
      const standing = role === 'main' && c.sameCycle && !c.group.control && j
        ? (j.beatsControl ? 'beats' : j.eligible ? 'below' : !c.round.report?.compare?.comparable ? 'control' : (j.guardrails || []).some((x: Data) => !x.pass) ? 'guard' : 'runs')
        : '';
      return {
        colId: c.id,
        version: c.version,
        sameCycle: c.sameCycle,
        crossCycle: !c.sameCycle,
        sameScale: c.metricVersion === anchorScale,
        rawMean: meanVal,
        mean: numStr(meanVal),
        sd: numStr(sdVal),
        n: cell ? cell.n : 0,
        partial: !!cell && cell.n > 0 && seedCount > 0 && cell.n < seedCount,
        guard: guardState,
        crossed,
        standing,
        seeds: c.sameCycle && Array.isArray(cell?.seeds)
          ? cell.seeds.map((s: Data, idx: number) => {
              const hasVal = typeof s.value === 'number' && Number.isFinite(s.value);
              const seedState = crossed.includes(s.seed) ? 'cross'
                : hasVal && s.state === 'done' ? ''
                : s.error ? (s.error.kind === 'env' ? 'env' : 'failed')
                : s.state === 'done' ? '' : 'failed';
              return { round: idx + 1, seed: s.seed, value: numStr(s.value), state: seedState };
            })
          : [],
      };
    });

    const anchorCell = anchorCol ? cells.find((x) => x.colId === anchorCol.id) || null : null;
    const compareCell = compareCol ? cells.find((x) => x.colId === compareCol.id) || null : null;
    let delta: string | null = null;
    let better = '';
    let deltaSuppressed = false;
    if (hasPair && anchorCell && compareCell) {
      if (!pairSameScale) {
        deltaSuppressed = true;
      } else if (typeof anchorCell.rawMean === 'number' && typeof compareCell.rawMean === 'number') {
        const diff = compareCell.rawMean - anchorCell.rawMean;
        delta = diff === 0 ? '0' : signed(diff);
        better = diff === 0 ? 'same' : ((diff > 0) === (m.dir === 'up') ? 'better' : 'worse');
      }
    }

    const anyValue = cells.some((x) => x.mean !== null);
    const anyFail = role === 'guard' && cells.some((x) => x.guard === 'fail');
    const allPass = role === 'guard' && anyValue && !anyFail && cells.some((x) => x.guard === 'pass');
    let status = 'info', statusText = '';
    if (!anyValue) {
      status = 'missing'; statusText = '本轮未测';
    } else if (role === 'main') {
      if (pairReferenceOnly) {
        status = better === 'better' ? 'info' : better === 'worse' ? 'warn' : 'info';
        statusText = !pairSameScale ? '量尺不同' : '跨周期参考';
      } else if (cells.some((x) => x.standing === 'beats')) { status = 'win'; statusText = '胜过对照'; }
      else if (cells.some((x) => x.standing === 'guard')) { status = 'fail'; statusText = '护栏越线'; }
      else if (cells.some((x) => x.standing === 'control' || x.standing === 'runs')) { status = 'warn'; statusText = '不可比'; }
      else if (better === 'better') { status = 'win'; statusText = '更好'; }
      else if (better === 'worse') { status = 'fail'; statusText = '更差'; }
      else if (better === 'same') { status = 'info'; statusText = '持平'; }
      else { status = 'info'; statusText = '基线'; }
    } else if (role === 'guard') {
      if (anyFail) { status = 'fail'; statusText = '越线'; }
      else if (allPass) { status = 'pass'; statusText = '通过'; }
      else { status = 'missing'; statusText = '未测'; }
    } else if (hasPair) {
      if (!pairSameScale) { status = 'muted'; statusText = '量尺不同'; }
      else if (pairReferenceOnly) { status = 'info'; statusText = '参考'; }
      else if (better === 'better') { status = 'pass'; statusText = '更好'; }
      else if (better === 'worse') { status = 'warn'; statusText = '更差'; }
      else if (better === 'same') { status = 'info'; statusText = '持平'; }
    }

    const ruleText = role === 'guard' && typeof m.threshold === 'number'
      ? `${m.dir === 'up' ? '≥' : '≤'} ${m.threshold}${m.unit ? ' ' + m.unit : ''}`
      : `${m.dir === 'up' ? '↑ 越大越好' : '↓ 越小越好'}${m.unit ? ' · ' + m.unit : ''}`;

    return {
      id: m.id,
      name: m.name,
      role,
      dir: m.dir,
      unit: m.unit || '',
      ruleText,
      hasTrend: seriesIds.has(m.id),
      active: m.id === activeTrendId,
      status,
      statusText,
      anyValue,
      cells: cells.map(({ rawMean: _drop, ...rest }) => rest),
      delta,
      better,
      deltaSuppressed,
      deltaRef: pairReferenceOnly,
    };
  });

  // Guardrail rollup summary (computed across ALL guardrails, regardless of custom metric filter)
  const guardRows = allMetricRows.filter((r) => r.role === 'guard');
  const guardFailed = guardRows.filter((r) => r.status === 'fail');
  const guardPassed = guardRows.filter((r) => r.status === 'pass');
  const guardMissing = guardRows.filter((r) => !r.anyValue);
  const guardMeasured = guardPassed.length + guardFailed.length;
  const guardSummary = guardRows.length ? {
    total: guardRows.length,
    measured: guardMeasured,
    passed: guardPassed.length,
    failed: guardFailed.length,
    missing: guardMissing.length,
    tone: guardFailed.length > 0 ? 'danger' : guardMeasured > 0 ? 'ok' : 'muted',
    text: guardFailed.length > 0
      ? `质量护栏 ${guardPassed.length}/${guardMeasured} 通过 · ${guardFailed.length} 项越线`
      : guardMeasured > 0
        ? `质量护栏 ${guardPassed.length}/${guardMeasured} 全部通过`
        : `质量护栏 ${guardRows.length} 项暂未测`,
  } : null;

  // Smart default visible metrics vs user-customized metric chips
  const collapsePassGuards = guardPassed.length > 3 || guardFailed.length > 0;
  const defaultVisibleMetrics = allMetricRows.filter((r) => {
    if (r.role === 'main') return true;
    if (r.role === 'guard' && r.status === 'fail') return true;
    if (r.role === 'guard' && r.status === 'pass') return !collapsePassGuards;
    if (r.role === 'other' && r.anyValue) return true;
    return false;
  });
  // Cap default auxiliary rows at 5 if many
  const defaultAux = defaultVisibleMetrics.filter((r) => r.role === 'other');
  const defaultMetricIds = (defaultAux.length > 5
    ? defaultVisibleMetrics.filter((r) => r.role !== 'other' || defaultAux.indexOf(r) < 5)
    : defaultVisibleMetrics
  ).map((r) => r.id);

  const allMetricIdSet = new Set(allMetricRows.map((r) => r.id));
  const reqMetrics = parseScopedSelection(opts.cmpMetrics, metricScope);
  const validReqMetrics = reqMetrics ? reqMetrics.filter((id) => allMetricIdSet.has(id)) : null;
  const metricCustomized = !!(validReqMetrics && validReqMetrics.length && validReqMetrics.join(',') !== defaultMetricIds.join(','));
  const activeMetricIds = validReqMetrics && validReqMetrics.length ? validReqMetrics : defaultMetricIds;
  const activeMetricSet = new Set(activeMetricIds);

  const metricChips = activeMetricIds.map((id) => {
    const row = allMetricRows.find((r) => r.id === id)!;
    const nextIds = activeMetricIds.filter((x) => x !== id);
    return {
      id: row.id,
      label: row.name,
      tone: row.role === 'main' ? 'info' : row.status === 'fail' ? 'danger' : '',
      removable: activeMetricIds.length > 1,
      removeVal: nextIds.length ? encodeScoped(metricScope, nextIds) : '',
    };
  });
  const addMetrics = allMetricRows
    .filter((r) => !activeMetricSet.has(r.id))
    .map((r) => ({
      id: r.id,
      menuLabel: `${r.name}${r.role === 'guard' ? (r.status === 'fail' ? ' · 护栏越线' : r.status === 'pass' ? ' · 护栏通过' : ' · 护栏') : ''}`,
      addVal: encodeScoped(metricScope, [...activeMetricIds, r.id]),
    }));

  // Build scalar table sections:
  // When user hasn't customized metrics, show active sections + a collapsed passing-guardrails rollup section if collapsed.
  // When user HAS customized metrics, show exactly the selected metrics in clean grouped sections.
  const shownRows = allMetricRows.filter((r) => activeMetricSet.has(r.id));
  const secMain = shownRows.filter((x) => x.role === 'main');
  const secGuardFail = shownRows.filter((x) => x.role === 'guard' && x.anyValue && x.status === 'fail');
  const secGuardPassShown = shownRows.filter((x) => x.role === 'guard' && x.anyValue && x.status === 'pass');
  const secGuardPassCollapsed = !metricCustomized && collapsePassGuards ? guardPassed : [];
  const secOther = shownRows.filter((x) => x.role === 'other' && x.anyValue);
  const secMissing = shownRows.filter((x) => !x.anyValue && x.role !== 'main');

  const sections = [
    { k: 'main', title: '主指标', defaultOpen: true, tone: 'info', rows: secMain },
    { k: 'guard_fail', title: '未通过护栏', defaultOpen: true, tone: 'danger', rows: secGuardFail },
    ...(secGuardPassShown.length ? [{ k: 'guard_pass', title: '已通过护栏', defaultOpen: true, tone: 'ok', rows: secGuardPassShown }] : []),
    ...(secGuardPassCollapsed.length ? [{
      k: 'guard_pass',
      title: `已通过护栏（${secGuardPassCollapsed.length}/${guardRows.length} 全部通过，点击展开）`,
      defaultOpen: false,
      tone: 'ok',
      rows: secGuardPassCollapsed,
    }] : []),
    { k: 'other', title: '诊断与辅助指标', defaultOpen: true, tone: '', rows: secOther },
    { k: 'missing', title: '本轮未测 / 暂无数据', defaultOpen: false, tone: 'muted', rows: secMissing },
  ].filter((sec) => sec.rows.length > 0);

  // Build sliced views across selected columns
  const colSlicesById = new Map<string, Data[]>();
  const sliceTableCatalog = new Map<string, { id: string; name: string; axis: string; axisUnit?: string; stats: SliceStatSpec[] }>();
  for (const c of selectedCols) {
    const sl = roundSlicesOf(d, c.round);
    colSlicesById.set(c.id, sl);
    for (const tbl of sl) {
      if (!sliceTableCatalog.has(tbl.id)) {
        sliceTableCatalog.set(tbl.id, {
          id: tbl.id,
          name: tbl.name,
          axis: tbl.axis,
          ...(tbl.axisUnit ? { axisUnit: tbl.axisUnit } : {}),
          stats: tbl.stats,
        });
      }
    }
  }

  const sliceDefs = [...sliceTableCatalog.values()];
  const hasSlices = sliceDefs.length > 0;
  const viewOptions = hasSlices
    ? [
        ...sliceDefs.map((s) => ({ v: `slice:${s.id}`, label: s.name })),
        { v: 'scalar', label: '汇总指标' },
      ]
    : [];
  const defaultView = hasSlices ? `slice:${sliceDefs[0].id}` : 'scalar';
  const activeView = hasSlices && opts.cmpView && viewOptions.some((o) => o.v === opts.cmpView)
    ? opts.cmpView
    : defaultView;
  const isSliceView = activeView.startsWith('slice:');

  let sliceTable: Data | null = null;
  let statChips: Data[] = [];
  let addStats: Data[] = [];
  let statCustomized = false;

  if (isSliceView) {
    const activeSliceId = activeView.slice('slice:'.length);
    const spec = sliceTableCatalog.get(activeSliceId)!;
    const statScope = `${objId}:${activeSliceId}`;
    const allStats = spec.stats;
    // Default stats: prioritize primary + thresholded + first few up to 4
    const defaultStatsList = allStats.length <= 4
      ? allStats
      : [
          ...allStats.filter((s) => s.primary),
          ...allStats.filter((s) => !s.primary && typeof s.threshold === 'number'),
          ...allStats.filter((s) => !s.primary && typeof s.threshold !== 'number'),
        ].slice(0, 4);
    const defaultStatIds = defaultStatsList.map((s) => s.id);
    const allStatIdSet = new Set(allStats.map((s) => s.id));
    const reqStats = parseScopedSelection(opts.cmpStats, statScope);
    const validReqStats = reqStats ? reqStats.filter((id) => allStatIdSet.has(id)) : null;
    statCustomized = !!(validReqStats && validReqStats.length && validReqStats.join(',') !== defaultStatIds.join(','));
    const activeStatIds = validReqStats && validReqStats.length ? validReqStats : defaultStatIds;
    const activeStatSet = new Set(activeStatIds);
    const activeStats = activeStatIds.map((id) => allStats.find((s) => s.id === id)!).filter(Boolean);
    const primaryStat = activeStats.find((s) => s.primary) || activeStats[0] || allStats[0];

    statChips = activeStats.map((st) => {
      const nextIds = activeStatIds.filter((x) => x !== st.id);
      return {
        id: st.id,
        label: st.unit ? `${st.name} (${st.unit})` : st.name,
        tone: st.primary ? 'info' : typeof st.threshold === 'number' ? 'warn' : '',
        removable: activeStatIds.length > 1,
        removeVal: nextIds.length ? encodeScoped(statScope, nextIds) : '',
      };
    });
    addStats = allStats
      .filter((st) => !activeStatSet.has(st.id))
      .map((st) => ({
        id: st.id,
        menuLabel: `${st.name}${st.unit ? ` (${st.unit})` : ''}${typeof st.threshold === 'number' ? ` · ${st.dir === 'up' ? '≥' : '≤'}${st.threshold}` : ''}`,
        addVal: encodeScoped(statScope, [...activeStatIds, st.id]),
      }));

    // Union levels across selected columns for this slice table
    const levelMap = new Map<string, string | number>();
    for (const c of selectedCols) {
      const tbl = (colSlicesById.get(c.id) || []).find((t) => t.id === activeSliceId);
      if (!tbl) continue;
      for (const lv of tbl.levels || []) {
        const k = String(lv);
        if (!levelMap.has(k)) levelMap.set(k, lv);
      }
    }
    const levels = sortSliceKeys([...levelMap.values()]);
    let anyPassField = allStats.some((s) => typeof s.threshold === 'number');

    const rows = levels.map((at) => {
      const atKey = String(at);
      const colCells = selectedCols.map((c) => {
        const tbl = (colSlicesById.get(c.id) || []).find((t) => t.id === activeSliceId);
        const cell = tbl?.cells?.find((x: Data) => x.group === c.groupId && String(x.at) === atKey) || null;
        if (cell && typeof cell.pass === 'boolean') anyPassField = true;
        const statCells = activeStats.map((st) => {
          const agg = cell?.stats?.[st.id];
          return {
            statId: st.id,
            rawMean: typeof agg?.mean === 'number' && Number.isFinite(agg.mean) ? agg.mean : null,
            mean: numStr(agg?.mean),
            sd: numStr(agg?.sd),
            pass: agg?.pass ?? null,
            seeds: c.sameCycle && Array.isArray(agg?.seeds)
              ? agg.seeds.map((s: Data) => ({ seed: s.seed, value: numStr(s.value), pass: s.pass }))
              : [],
          };
        });
        return {
          colId: c.id,
          sameCycle: c.sameCycle,
          pass: cell?.pass ?? null,
          stats: statCells,
        };
      });

      let diff: Data | null = null;
      if (hasPair && primaryStat) {
        const aCol = colCells.find((x) => x.colId === anchorCol!.id);
        const bCol = colCells.find((x) => x.colId === compareCol!.id);
        const aVal = aCol?.stats.find((s) => s.statId === primaryStat.id)?.rawMean ?? null;
        const bVal = bCol?.stats.find((s) => s.statId === primaryStat.id)?.rawMean ?? null;
        if (!pairSameScale) {
          diff = { suppressed: true, delta: null, ratio: '', better: '', ref: pairReferenceOnly };
        } else if (typeof aVal === 'number' && typeof bVal === 'number') {
          const dVal = bVal - aVal;
          const better = dVal === 0 ? 'same' : ((dVal > 0) === (primaryStat.dir === 'up') ? 'better' : 'worse');
          diff = {
            suppressed: false,
            delta: dVal === 0 ? '0' : signed(dVal),
            ratio: formatRatio(bVal, aVal),
            better,
            ref: pairReferenceOnly,
          };
        }
      }

      return {
        at: atKey,
        label: spec.axisUnit ? `${atKey} ${spec.axisUnit}` : atKey,
        cols: colCells.map((cc) => ({
          colId: cc.colId,
          sameCycle: cc.sameCycle,
          pass: cc.pass,
          stats: cc.stats.map(({ rawMean: _drop, ...rest }) => rest),
        })),
        diff,
      };
    });

    sliceTable = {
      id: spec.id,
      name: spec.name,
      axis: spec.axis,
      axisUnit: spec.axisUnit || '',
      showPass: anyPassField,
      primaryStat: primaryStat ? { id: primaryStat.id, name: primaryStat.name, dir: primaryStat.dir, unit: primaryStat.unit || '' } : null,
      stats: activeStats.map((st) => ({
        id: st.id,
        name: st.name,
        unit: st.unit || '',
        dir: st.dir,
        threshold: typeof st.threshold === 'number' ? st.threshold : null,
        ruleText: typeof st.threshold === 'number' ? `${st.dir === 'up' ? '≥' : '≤'}${st.threshold}${st.unit || ''}` : '',
        primary: !!st.primary,
      })),
      rows,
    };
  }

  // Backward-compatible legacy header metadata (controlGroup / candidateGroups) for existing unit tests & callers
  const ctrlGroup = (round.plan?.groups || []).find((g: Data) => g.control) || null;
  const nonCtrlGroups = (round.plan?.groups || []).filter((g: Data) => !g.control);

  return {
    tier: round.plan?.tier || '',
    skipControl: !!round.plan?.skipControl,
    selectedMetric: activeTrendId,
    cycleLabel: `${round.version}-${round.k ?? 1}`,
    seeds: round.plan?.seeds || [],
    hasPair,
    pairSameScale,
    pairReferenceOnly,
    anchorColId: anchorCol?.id || null,
    compareColId: compareCol?.id || null,
    controlGroup: ctrlGroup ? { id: ctrlGroup.id, version: ctrlGroup.version, label: ctrlGroup.label } : null,
    candidateGroups: nonCtrlGroups.map((g: Data) => ({ id: g.id, version: g.version, label: g.label, confirm: !!g.confirm })),
    columns,
    hasCols: columns.length > 0,
    addColumns,
    hasAddCols: addColumns.length > 0,
    colCustomized,
    guardSummary,
    hasSlices,
    viewOptions,
    activeView,
    isSliceView,
    metricChips,
    addMetrics,
    hasAddMetrics: addMetrics.length > 0,
    metricCustomized,
    statChips,
    addStats,
    hasAddStats: addStats.length > 0,
    statCustomized,
    sections,
    sliceTable,
    totalMetrics: allMetricRows.length,
  };
}

function mdEsc(s: unknown): string {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
}

export function formatComparisonMarkdown(d: Experiment, round: Data): string {
  if (!round?.report) return '';
  const allRounds = (d.rounds || [])
    .filter((r: Data) => r.state !== 'planned')
    .map((r: Data) => ({ ...r, version: testedVersion(r.plan) }))
    .map((r: Data, _i: number, arr: Data[]) => ({ ...r, k: arr.filter((x) => x.version === r.version && x.n <= r.n).length }));
  const target = allRounds.find((x: Data) => x.n === round.n) || { ...round, version: testedVersion(round.plan), k: 1 };
  const table = buildComparisonTable(d, target, allRounds, {});
  if (!table.columns?.length) return '';

  const lines: string[] = [];
  const colHdr = (c: Data) => `${c.label}${c.crossCycle ? ' (跨周期参考)' : ''}`;

  if (table.isSliceView && table.sliceTable?.rows?.length) {
    const st = table.sliceTable;
    if (table.guardSummary) lines.push(`> ${table.guardSummary.text}`);
    const headers: string[] = [st.axis];
    for (const c of table.columns) {
      for (const s of st.stats) {
        headers.push(`${colHdr(c)} ${s.name}${s.unit ? `(${s.unit})` : ''}`);
      }
      if (st.showPass) headers.push(`${c.version} 判定`);
    }
    if (table.hasPair && st.primaryStat) {
      headers.push(`${st.primaryStat.name} 对比${table.pairReferenceOnly ? ' (参考)' : ''}`);
    }
    lines.push(`| ${headers.map(mdEsc).join(' | ')} |`);
    lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
    for (const row of st.rows) {
      const cells: string[] = [row.label];
      for (const cc of row.cols) {
        for (const s of cc.stats) {
          const val = s.mean == null ? '—' : (s.sd != null ? `${s.mean}±${s.sd}` : s.mean);
          cells.push(s.pass === false ? `**${val}**` : val);
        }
        if (st.showPass) cells.push(cc.pass === true ? 'PASS' : cc.pass === false ? '**FAIL**' : '—');
      }
      if (table.hasPair && st.primaryStat) {
        const diff = row.diff;
        if (!diff || diff.suppressed) cells.push('—');
        else cells.push([diff.ratio, diff.delta].filter(Boolean).join(' / ') || '—');
      }
      lines.push(`| ${cells.map(mdEsc).join(' | ')} |`);
    }
    // Also surface any failed guardrails concisely below slice table
    const failRows = (table.sections || []).find((s: Data) => s.k === 'guard_fail')?.rows || [];
    if (failRows.length) {
      lines.push('');
      lines.push(`越线护栏：${failRows.map((r: Data) => `${r.name}（${r.ruleText}）`).join('；')}`);
    }
    return lines.join('\n');
  }

  // Flat scalar Markdown table (concise: main + failed guardrails + up to 4 aux; passing guardrails rolled up into 1 line!)
  const displayRows: Data[] = [];
  for (const sec of table.sections || []) {
    if (sec.k === 'missing') continue;
    if (sec.k === 'guard_pass' && !sec.defaultOpen) continue;
    if (sec.k === 'other') displayRows.push(...sec.rows.slice(0, 4));
    else displayRows.push(...sec.rows);
  }
  if (!displayRows.some((r) => r.anyValue)) return '';

  const headers: string[] = ['指标', ...table.columns.map(colHdr)];
  if (table.hasPair) headers.push(`Δ${table.pairReferenceOnly ? ' (参考)' : ''}`);
  headers.push('判定');
  lines.push(`| ${headers.map(mdEsc).join(' | ')} |`);
  lines.push(`| ${headers.map(() => '---').join(' | ')} |`);

  for (const row of displayRows) {
    const cells: string[] = [row.name];
    for (const c of row.cells) {
      const val = c.mean == null ? '—' : (c.sd != null ? `${c.mean} ± ${c.sd}` : c.mean);
      cells.push(c.guard === 'fail' ? `**${val}**` : val);
    }
    if (table.hasPair) cells.push(row.deltaSuppressed ? '—' : (row.delta ?? '—'));
    cells.push(row.status === 'fail' ? `**${row.statusText}**` : (row.statusText || '—'));
    lines.push(`| ${cells.map(mdEsc).join(' | ')} |`);
  }
  if (table.guardSummary) {
    lines.push('');
    lines.push(table.guardSummary.text);
  }
  return lines.join('\n');
}
