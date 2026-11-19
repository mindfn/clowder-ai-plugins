import type { Data } from './types.js';

// The time range of a window ("每晚 20:00–08:00" → "20:00–08:00"); the page says 每晚 itself.
export const timeRange = (w: unknown) => typeof w === 'string' ? /\d{1,2}:\d{2}\s*[–-]\s*\d{1,2}:\d{2}/.exec(w)?.[0] || w : w;

export function windowMinutes(value: unknown): number[] | null {
  if (typeof value !== 'string') return null;
  const match = /(\d{2}):(\d{2})\s*[–—\-~至]\s*(\d{2}):(\d{2})/.exec(value);
  if (!match || +match[1] > 23 || +match[2] > 59 || +match[3] > 23 || +match[4] > 59) return null;
  return [+match[1] * 60 + +match[2], +match[3] * 60 + +match[4]];
}

export function insideWindow(schedule: Data, now: number) {
  const window = windowMinutes(schedule.window);
  if (!window) return false;
  const [start, end] = window, date = new Date(now), minute = date.getHours() * 60 + date.getMinutes();
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

// When tonight's window opened: the latest start at or before now; without a window, twelve hours ago.
export function windowStart(schedule: Data, now: number) {
  const window = windowMinutes(schedule.window);
  if (!window) return now - 12 * 3_600_000;
  const date = new Date(now), start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(window[0] / 60), window[0] % 60).getTime();
  return start <= now ? start : start - 24 * 3_600_000;
}
