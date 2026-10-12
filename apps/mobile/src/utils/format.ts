import { compass16, mToYds } from '@msp/engine';

export const uid = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function todayLocal(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** The next sit from now: before 4 AM → this morning; before 2 PM → this evening; else tomorrow morning. */
export function nextSit(now = new Date()): { date: string; window: 'AM' | 'PM' } {
  const h = now.getHours();
  if (h < 4) return { date: todayLocal(now), window: 'AM' };
  if (h < 14) return { date: todayLocal(now), window: 'PM' };
  return { date: addDays(todayLocal(now), 1), window: 'AM' };
}

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
