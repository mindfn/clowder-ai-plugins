import type { Data } from './types.js';

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
