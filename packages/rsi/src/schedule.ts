import type { Data } from './types.js';

export interface ScheduleRule {
  /** Local weekdays 0=Sun..6=Sat; empty/omitted means every day. */
  days?: number[];
  /** Inclusive local start date YYYY-MM-DD. */
  dateFrom?: string;
  /** Inclusive local end date YYYY-MM-DD. */
  dateTo?: string;
  /** Local HH:MM start time (00:00..23:59). */
  start?: string;
  /** Local HH:MM end time (00:00..24:00). */
  end?: string;
}

export type SchedulePreset = 'anytime' | 'daytime_weekend' | 'daily' | 'weekdays' | 'weekends' | 'custom';

export interface ScheduleConfig {
  mode?: 'anytime' | 'rules';
  rules?: ScheduleRule[];
  window?: string;
  preset?: SchedulePreset;
  dateFrom?: string;
  dateTo?: string;
  start?: string;
  end?: string;
  custom?: string;
  cron?: string;
  /** Max scheduled cycles inside a single window; null/omitted means unlimited. */
  maxRuns?: number | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(\d{1,2}):(\d{2})$/;
const DAY_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const DAY_MAP: Record<string, number> = {
  '日': 0, '天': 0, '0': 0, '7': 0, sun: 0, sunday: 0,
  '一': 1, '1': 1, mon: 1, monday: 1,
  '二': 2, '2': 2, tue: 2, tues: 2, tuesday: 2,
  '三': 3, '3': 3, wed: 3, wednesday: 3,
  '四': 4, '4': 4, thu: 4, thur: 4, thurs: 4, thursday: 4,
  '五': 5, '5': 5, fri: 5, friday: 5,
  '六': 6, '6': 6, sat: 6, saturday: 6,
};

const pad2 = (n: number) => String(n).padStart(2, '0');
const localDateStr = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

function validDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!DATE_RE.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? s : null;
}

function parseClock(value: unknown, allow24 = false): { text: string; minutes: number } | null {
  if (typeof value !== 'string') return null;
  const m = TIME_RE.exec(value.trim());
  if (!m) return null;
  const hh = Number(m[1]), mm = Number(m[2]);
  if (allow24 && hh === 24 && mm === 0) return { text: '24:00', minutes: 1440 };
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return { text: `${pad2(hh)}:${pad2(mm)}`, minutes: hh * 60 + mm };
}

// Keep legacy "每晚 20:00–08:00" → "20:00–08:00" trimming, while preserving rich multi-rule / anytime descriptions intact.
export const timeRange = (w: unknown) => {
  if (typeof w !== 'string') return w;
  const trimmed = w.trim();
  const simpleNight = /^(?:每晚|每天|每日)\s*(\d{1,2}:\d{2}\s*[–—\-~至]\s*\d{1,2}:\d{2})$/.exec(trimmed);
  return simpleNight ? simpleNight[1] : trimmed;
};

export function windowMinutes(value: unknown): number[] | null {
  if (typeof value !== 'string') return null;
  const match = /(\d{1,2}):(\d{2})\s*[–—\-~至]\s*(\d{1,2}):(\d{2})/.exec(value);
  if (!match) return null;
  const start = parseClock(`${match[1]}:${match[2]}`, false);
  const end = parseClock(`${match[3]}:${match[4]}`, true);
  if (!start || !end) return null;
  return [start.minutes, end.minutes];
}

function formatDays(days?: number[]): string {
  if (!days || !days.length || days.length >= 7) return '';
  const uniq = [...new Set(days)].sort((a, b) => a - b);
  const key = uniq.join(',');
  if (key === '1,2,3,4,5') return '周一至周五';
  if (key === '0,6') return '周六至周日';
  return uniq.map((d) => DAY_ZH[d]).join('、');
}

function formatRule(rule: ScheduleRule): string {
  const parts: string[] = [];
  if (rule.dateFrom && rule.dateTo) parts.push(rule.dateFrom === rule.dateTo ? rule.dateFrom : `${rule.dateFrom}~${rule.dateTo}`);
  else if (rule.dateFrom) parts.push(`${rule.dateFrom}起`);
  else if (rule.dateTo) parts.push(`截至${rule.dateTo}`);
  const dayLabel = formatDays(rule.days);
  if (dayLabel) parts.push(dayLabel);
  const fullDay = !rule.start || !rule.end || (rule.start === '00:00' && rule.end === '24:00');
  parts.push(fullDay ? '全天' : `${rule.start}–${rule.end}`);
  return parts.join(' ');
}

export function scheduleSummary(schedule: Data | null | undefined): string {
  if (!schedule) return '';
  if (schedule.mode === 'anytime') {
    if (schedule.dateFrom || schedule.dateTo) {
      return formatRule({ dateFrom: schedule.dateFrom, dateTo: schedule.dateTo, start: '00:00', end: '24:00' });
    }
    return '不限制（全天）';
  }
  if (Array.isArray(schedule.rules) && schedule.rules.length) {
    return schedule.rules.map(formatRule).join('；');
  }
  return typeof schedule.window === 'string' ? schedule.window.trim() : '';
}

function parseDaysSegment(text: string): number[] | undefined {
  const days = new Set<number>();
  if (/工作日|weekdays?/i.test(text)) for (const d of [1, 2, 3, 4, 5]) days.add(d);
  if (/周末|双休|weekends?/i.test(text)) for (const d of [0, 6]) days.add(d);
  // Ranges like 周一至周五 / 周一-周五 / Mon-Fri
  const rangeRe = /(?:周|星期)?([一二三四五六日天]|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\s*[至到\-–—~]\s*(?:周|星期)?([一二三四五六日天]|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)/gi;
  for (const m of text.matchAll(rangeRe)) {
    const a = DAY_MAP[m[1].toLowerCase()], b = DAY_MAP[m[2].toLowerCase()];
    if (a != null && b != null) {
      let cur = a;
      for (let i = 0; i < 7; i++) { days.add(cur); if (cur === b) break; cur = (cur + 1) % 7; }
    }
  }
  // Individual days like 周一、周三、周五 or 周六
  const singleRe = /(?:周|星期)([一二三四五六日天])|\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day)?\b/gi;
  for (const m of text.matchAll(singleRe)) {
    const token = (m[1] || m[2] || '').toLowerCase();
    if (DAY_MAP[token] != null) days.add(DAY_MAP[token]);
  }
  if (days.size === 0 || days.size >= 7) return undefined;
  return [...days].sort((a, b) => a - b);
}

function parseRuleLine(raw: string): ScheduleRule | 'anytime' | null {
  const line = raw.trim();
  if (!line) return null;
  if (/^(?:不限制|无限制|随时|全天|anytime|always|24h|24\/7|不限)(?:（全天）|\(全天\))?$/i.test(line)) return 'anytime';
  let rest = line;
  let dateFrom: string | undefined, dateTo: string | undefined;
  const dateRange = /(\d{4}-\d{2}-\d{2})\s*[~至到–—-]\s*(\d{4}-\d{2}-\d{2})/.exec(rest);
  if (dateRange) {
    const a = validDate(dateRange[1]), b = validDate(dateRange[2]);
    if (!a || !b || a > b) return null;
    dateFrom = a; dateTo = b;
    rest = rest.replace(dateRange[0], ' ');
  } else {
    const singleDate = /(\d{4}-\d{2}-\d{2})/.exec(rest);
    if (singleDate) {
      const a = validDate(singleDate[1]);
      if (!a) return null;
      if (rest.includes(`${singleDate[1]}起`)) dateFrom = a;
      else if (rest.includes(`截至${singleDate[1]}`)) dateTo = a;
      else { dateFrom = a; dateTo = a; }
      rest = rest.replace(singleDate[0], ' ');
    }
  }
  const days = parseDaysSegment(rest);
  const timeMatch = /(\d{1,2}:\d{2})\s*[–—\-~至到]\s*(\d{1,2}:\d{2})/.exec(rest);
  let start: string | undefined, end: string | undefined;
  if (timeMatch) {
    const s = parseClock(timeMatch[1], false), e = parseClock(timeMatch[2], true);
    if (!s || !e) return null;
    start = s.text; end = e.text;
  } else if (/全天|不限|24h|all\s*day/i.test(rest) || dateFrom || dateTo || days) {
    start = '00:00'; end = '24:00';
  } else {
    return null;
  }
  return { ...(days ? { days } : {}), ...(dateFrom ? { dateFrom } : {}), ...(dateTo ? { dateTo } : {}), start, end };
}

export function parseScheduleText(value: unknown): ScheduleConfig | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/[;；\n]+/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const rules: ScheduleRule[] = [];
  for (const part of parts) {
    const parsed = parseRuleLine(part);
    if (!parsed) return null;
    if (parsed === 'anytime') return { mode: 'anytime', preset: 'anytime', window: '不限制（全天）' };
    rules.push(parsed);
  }
  if (!rules.length) return null;
  const config: ScheduleConfig = { mode: 'rules', preset: 'custom', rules, custom: parts.join('\n') };
  config.window = scheduleSummary(config);
  return config;
}

export function parseMaxRuns(value: unknown): { maxRuns: number | null } | { error: string } {
  if (value == null || value === '' || value === 0 || value === '0') return { maxRuns: null };
  if (typeof value === 'string' && /^(?:不限制|无限制|不限|unlimited)$/i.test(value.trim())) return { maxRuns: null };
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > 1000) return { error: '时间窗内最大执行次数请填写正整数，或留空 / 填 0 表示不限制' };
  return { maxRuns: n };
}

export function maxRunsText(schedule: Data | null | undefined): string {
  const n = schedule?.maxRuns;
  return typeof n === 'number' && n > 0 ? `最多 ${n} 次` : '不限制';
}

export function scheduleOf(input: Data): { schedule: ScheduleConfig } | { error: string } {
  const mode = (typeof input.mode === 'string' ? input.mode.trim() : '') as SchedulePreset;
  if (!['anytime', 'daytime_weekend', 'daily', 'weekdays', 'weekends', 'custom'].includes(mode)) {
    return { error: '请选择有效的执行模式（不限制 / 工作日白天+周末全天 / 每天固定时段 / 仅工作日 / 仅周末 / 自定义）' };
  }
  const parsedMaxRuns = parseMaxRuns(input.maxRuns);
  if ('error' in parsedMaxRuns) return parsedMaxRuns;
  const maxRunsField = parsedMaxRuns.maxRuns ? { maxRuns: parsedMaxRuns.maxRuns } : {};
  const rawFrom = typeof input.dateFrom === 'string' ? input.dateFrom.trim() : '';
  const rawTo = typeof input.dateTo === 'string' ? input.dateTo.trim() : '';
  const dateFrom = rawFrom ? validDate(rawFrom) : undefined;
  const dateTo = rawTo ? validDate(rawTo) : undefined;
  if (rawFrom && !dateFrom) return { error: '开始日期格式应为 YYYY-MM-DD' };
  if (rawTo && !dateTo) return { error: '结束日期格式应为 YYYY-MM-DD' };
  if (dateFrom && dateTo && dateFrom > dateTo) return { error: '开始日期不能晚于结束日期' };

  const rawStart = typeof input.start === 'string' ? input.start.trim() : '';
  const rawEnd = typeof input.end === 'string' ? input.end.trim() : '';
  const rawCustom = typeof input.custom === 'string' ? input.custom.trim() : '';
  const extraRules: ScheduleRule[] = [];
  if (rawCustom) {
    const parsed = parseScheduleText(rawCustom);
    if (!parsed) return { error: '自定义规则格式无法识别，例：「周一至周五 09:00–18:00；周六至周日 全天」或「2026-11-21~2026-11-30 09:00–18:00」' };
    if (parsed.mode === 'anytime') {
      const cfg: ScheduleConfig = { mode: 'anytime', preset: 'anytime', ...(dateFrom ? { dateFrom } : {}), ...(dateTo ? { dateTo } : {}), ...maxRunsField };
      cfg.window = scheduleSummary(cfg);
      return { schedule: cfg };
    }
    extraRules.push(...(parsed.rules || []));
  }

  const dateFields = { ...(dateFrom ? { dateFrom } : {}), ...(dateTo ? { dateTo } : {}) };

  if (mode === 'anytime') {
    if (dateFrom || dateTo) {
      const rules: ScheduleRule[] = [{ ...dateFields, start: '00:00', end: '24:00' }, ...extraRules];
      const cfg: ScheduleConfig = { mode: 'rules', preset: 'anytime', rules, ...dateFields, ...(rawCustom ? { custom: rawCustom } : {}), ...maxRunsField };
      cfg.window = scheduleSummary(cfg);
      return { schedule: cfg };
    }
    const cfg: ScheduleConfig = { mode: 'anytime', preset: 'anytime', window: '不限制（全天）', ...maxRunsField };
    return { schedule: cfg };
  }

  if (mode === 'custom') {
    if (!extraRules.length) return { error: '自定义模式请填写至少一条规则，例：「周一至周五 09:00–18:00」或「2026-11-21~2026-11-30 09:00–18:00」' };
    const rules = extraRules.map((r) => ({ ...dateFields, ...r }));
    const cfg: ScheduleConfig = { mode: 'rules', preset: 'custom', rules, ...dateFields, custom: rawCustom, ...maxRunsField };
    cfg.window = scheduleSummary(cfg);
    return { schedule: cfg };
  }

  const defaultStart = mode === 'daily' ? '20:00' : mode === 'weekends' ? '00:00' : '09:00';
  const defaultEnd = mode === 'daily' ? '08:00' : mode === 'weekends' ? '24:00' : '18:00';
  const startClock = parseClock(rawStart || defaultStart, false);
  const endClock = parseClock(rawEnd || defaultEnd, true);
  if (!startClock || !endClock) return { error: '起止时间格式应为 HH:MM（如 09:00、18:00）' };

  const rules: ScheduleRule[] = [];
  if (mode === 'daytime_weekend') {
    rules.push({ ...dateFields, days: [1, 2, 3, 4, 5], start: startClock.text, end: endClock.text });
    rules.push({ ...dateFields, days: [0, 6], start: '00:00', end: '24:00' });
  } else if (mode === 'daily') {
    rules.push({ ...dateFields, start: startClock.text, end: endClock.text });
  } else if (mode === 'weekdays') {
    rules.push({ ...dateFields, days: [1, 2, 3, 4, 5], start: startClock.text, end: endClock.text });
  } else if (mode === 'weekends') {
    rules.push({ ...dateFields, days: [0, 6], start: startClock.text, end: endClock.text });
  }
  rules.push(...extraRules);

  const cfg: ScheduleConfig = {
    mode: 'rules',
    preset: mode,
    rules,
    ...dateFields,
    start: startClock.text,
    end: endClock.text,
    ...(rawCustom ? { custom: rawCustom } : {}),
    ...maxRunsField,
  };
  cfg.window = scheduleSummary(cfg);
  return { schedule: cfg };
}

export function scheduleForm(schedule: Data | null | undefined) {
  const s = schedule || {};
  const maxRuns = typeof s.maxRuns === 'number' && s.maxRuns > 0 ? String(s.maxRuns) : '';
  if (s.mode === 'anytime' || s.preset === 'anytime') {
    return { mode: 'anytime', dateFrom: s.dateFrom || '', dateTo: s.dateTo || '', start: '', end: '', custom: s.custom || '', maxRuns };
  }
  if (s.preset) {
    return { mode: s.preset, dateFrom: s.dateFrom || '', dateTo: s.dateTo || '', start: s.start || '', end: s.end || '', custom: s.custom || '', maxRuns };
  }
  const parsed = parseScheduleText(s.window);
  if (parsed?.mode === 'anytime') {
    return { mode: 'anytime', dateFrom: '', dateTo: '', start: '', end: '', custom: '', maxRuns };
  }
  const legacy = windowMinutes(s.window);
  if (legacy && (!parsed?.rules || (parsed.rules.length === 1 && !parsed.rules[0].days && !parsed.rules[0].dateFrom && !parsed.rules[0].dateTo))) {
    const start = `${pad2(Math.floor(legacy[0] / 60))}:${pad2(legacy[0] % 60)}`;
    const end = legacy[1] === 1440 ? '24:00' : `${pad2(Math.floor(legacy[1] / 60))}:${pad2(legacy[1] % 60)}`;
    return { mode: 'daily', dateFrom: '', dateTo: '', start, end, custom: '', maxRuns };
  }
  if (parsed?.rules?.length) {
    return { mode: 'custom', dateFrom: '', dateTo: '', start: '', end: '', custom: parsed.rules.map(formatRule).join('\n'), maxRuns };
  }
  return { mode: 'daytime_weekend', dateFrom: '', dateTo: '', start: '09:00', end: '18:00', custom: '', maxRuns };
}

function normalizedRules(schedule: Data | null | undefined): 'anytime' | ScheduleRule[] {
  if (!schedule) return [];
  if (schedule.mode === 'anytime') {
    if (schedule.dateFrom || schedule.dateTo) {
      return [{ dateFrom: schedule.dateFrom, dateTo: schedule.dateTo, start: '00:00', end: '24:00' }];
    }
    return 'anytime';
  }
  if (Array.isArray(schedule.rules) && schedule.rules.length) return schedule.rules;
  const parsed = parseScheduleText(schedule.window);
  if (parsed?.mode === 'anytime') return 'anytime';
  if (parsed?.rules?.length) return parsed.rules;
  const legacy = windowMinutes(schedule.window);
  if (!legacy) return [];
  return [{ start: `${pad2(Math.floor(legacy[0] / 60))}:${pad2(legacy[0] % 60)}`, end: legacy[1] === 1440 ? '24:00' : `${pad2(Math.floor(legacy[1] / 60))}:${pad2(legacy[1] % 60)}` }];
}

export function hasValidSchedule(schedule: Data | null | undefined): boolean {
  const norm = normalizedRules(schedule);
  return norm === 'anytime' || norm.length > 0;
}

function dateMatches(date: Date, rule: ScheduleRule): boolean {
  if (rule.days && rule.days.length && !rule.days.includes(date.getDay())) return false;
  const ymd = localDateStr(date);
  if (rule.dateFrom && ymd < rule.dateFrom) return false;
  if (rule.dateTo && ymd > rule.dateTo) return false;
  return true;
}

function ruleMatches(rule: ScheduleRule, now: number): boolean {
  const startClock = parseClock(rule.start || '00:00', false);
  const endClock = parseClock(rule.end || '24:00', true);
  if (!startClock || !endClock) return false;
  const start = startClock.minutes, end = endClock.minutes;
  const date = new Date(now), minute = date.getHours() * 60 + date.getMinutes();
  if (start === 0 && end === 1440) return dateMatches(date, rule);
  if (start < end) {
    return minute >= start && minute < end && dateMatches(date, rule);
  }
  // Overnight window (e.g. 20:00–08:00): evening belongs to today's rule, post-midnight belongs to yesterday's rule.
  if (minute >= start) return dateMatches(date, rule);
  if (minute < end) {
    const yesterday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1);
    return dateMatches(yesterday, rule);
  }
  return false;
}

export function insideWindow(schedule: Data, now: number): boolean {
  const norm = normalizedRules(schedule);
  if (norm === 'anytime') return true;
  if (!norm.length) return false;
  return norm.some((rule) => ruleMatches(rule, now));
}

function simpleDailyMinutes(schedule: Data | null | undefined): number[] | null {
  const norm = normalizedRules(schedule);
  if (norm === 'anytime' || norm.length !== 1) return null;
  const r = norm[0];
  if (r.days?.length || r.dateFrom || r.dateTo) return null;
  const s = parseClock(r.start || '00:00', false), e = parseClock(r.end || '24:00', true);
  if (!s || !e || (s.minutes === 0 && e.minutes === 1440)) return null;
  return [s.minutes, e.minutes];
}

// When the window opened: the latest start at or before now; without a bounded window, twelve hours ago.
export function windowStart(schedule: Data, now: number) {
  const simple = simpleDailyMinutes(schedule);
  if (simple) {
    const date = new Date(now), start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(simple[0] / 60), simple[0] % 60).getTime();
    return start <= now ? start : start - 24 * 3_600_000;
  }
  return now - 12 * 3_600_000;
}

// When the last bounded daily window closed: the latest end at or before now; without one (e.g. anytime), null.
export function windowEnd(schedule: Data, now: number) {
  const simple = simpleDailyMinutes(schedule);
  if (!simple) return null;
  const date = new Date(now), end = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(simple[1] / 60), simple[1] % 60).getTime();
  return end <= now ? end : end - 24 * 3_600_000;
}

export function withinWindowLimit(schedule: Data | null | undefined, rounds: Data[], now: number): boolean {
  const maxRuns = schedule?.maxRuns;
  if (typeof maxRuns !== 'number' || maxRuns <= 0) return true;
  const since = windowStart(schedule!, now);
  const count = rounds.filter((r) => r.scheduled && typeof r.start === 'number' && r.start >= since).length;
  return count < maxRuns;
}
