import { compass16, mToYds } from '@msp/engine';

export const uid = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function todayLocal(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Without sun times: the morning sit is treated as over at 10 AM, the evening sit at 6 PM. */
const DEFAULT_AM_END_HOUR = 10;
const DEFAULT_PM_END_HOUR = 18;

/**
 * The next sit that has not ended yet: this morning until the morning sit is over,
 * then this evening until legal light ends, then tomorrow morning. A hunter opening
 * the app at 5:30 AM gets this morning's sit, not the evening's.
 * `ends` (ISO times for today) come from the property's sun times when known.
 */
export function nextSit(now = new Date(), ends?: { amEnd: string; pmEnd: string }): { date: string; window: 'AM' | 'PM' } {
  const today = todayLocal(now);
  const at = (hour: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour).getTime();
  const amEnd = ends ? Date.parse(ends.amEnd) : at(DEFAULT_AM_END_HOUR);
  const pmEnd = ends ? Date.parse(ends.pmEnd) : at(DEFAULT_PM_END_HOUR);
  const t = now.getTime();
  if (t < amEnd) return { date: today, window: 'AM' };
  if (t < pmEnd) return { date: today, window: 'PM' };
  return { date: addDays(today, 1), window: 'AM' };
}

/** Sort key for a sit: later date, or same date and PM after AM, sorts higher. */
export const sitOrder = (s: { date: string; window: 'AM' | 'PM' }): string => `${s.date}${s.window === 'AM' ? 0 : 1}`;

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return todayLocal(new Date(y, m - 1, d + n));
}

/** Device-local clock time, e.g. "6:42 AM". */
export const fmtTime = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function fmtDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

export const fmtYds = (m: number): string => `${Math.round(mToYds(m))} yds`;
export const fmtWind = (fromDeg: number, mph: number, gust?: number): string =>
  `${compass16(fromDeg)} ${Math.round(mph)}${gust && gust > mph + 2 ? `–${Math.round(gust)}` : ''} mph`;

export function minutesUntil(iso: string, now = Date.now()): number {
  return Math.round((Date.parse(iso) - now) / 60_000);
}

export function fmtDuration(min: number): string {
  const sign = min < 0 ? '-' : '';
  const m = Math.abs(min);
  return m >= 60 ? `${sign}${Math.floor(m / 60)}h ${m % 60}m` : `${sign}${m}m`;
}
