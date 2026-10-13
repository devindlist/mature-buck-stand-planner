import type { HourlyWind, LatLon, PrecipType, PressureTrend, WeatherSnapshot } from '../models.ts';
import { compassToDeg } from '../geo/geometry.ts';
import { windChillF } from '../safety/safety.ts';

/**
 * National Weather Service (api.weather.gov) client and parsers.
 * Flow: /points/{lat},{lon} → forecastHourly + forecastGridData + observationStations.
 * NWS requires a descriptive User-Agent with contact info.
 */
export const NWS_BASE = 'https://api.weather.gov';

/** Per-request timeout. React Native's fetch never times out on its own, so a dead connection would hang forever. */
export const NWS_TIMEOUT_MS = 15_000;

/** A pressure trend observed more than this long before the sit starts says nothing about the sit. */
export const PRESSURE_TREND_MAX_LEAD_MS = 6 * 3_600_000;

export type FetchFn = typeof fetch;

export interface NwsPoint {
  forecastHourlyUrl: string;
  gridDataUrl: string;
  stationsUrl: string;
  timeZone: string;
  state?: string;
  city?: string;
}

export function parsePoint(body: unknown): NwsPoint {
  const p = (body as { properties?: Record<string, unknown> })?.properties;
  if (!p || typeof p.forecastHourly !== 'string') throw new Error('NWS: location is not covered (US only).');
  const rel = (p.relativeLocation as { properties?: { state?: string; city?: string } } | undefined)?.properties;
  return {
    forecastHourlyUrl: p.forecastHourly,
    gridDataUrl: String(p.forecastGridData),
    stationsUrl: String(p.observationStations),
    timeZone: String(p.timeZone ?? 'America/Chicago'),
    state: rel?.state,
    city: rel?.city,
  };
}

export interface HourlyPeriod {
  startTime: string;
  endTime: string;
  tempF: number;
  windSpeedMph: number;
  windFromDeg: number;
  /**
   * False when NWS gave no usable direction (blank, "VRB" variable): windFromDeg was
   * borrowed from the nearest hour that has one, so it never reads as a shift to north.
   */
  windDirKnown: boolean;
  precipChancePct: number;
  shortForecast: string;
}

/** "10 mph" or "5 to 10 mph" → upper number (conservative for scent spread). */
export function parseWindSpeed(s: unknown): number {
  if (typeof s !== 'string') return 0;
  const nums = s.match(/\d+(\.\d+)?/g)?.map(Number) ?? [];
  return nums.length ? Math.max(...nums) : 0;
}

export function parseHourly(body: unknown): HourlyPeriod[] {
  const periods = (body as { properties?: { periods?: Array<Record<string, unknown>> } })?.properties?.periods ?? [];
  const dirs = periods.map((p) => (typeof p.windDirection === 'string' ? compassToDeg(p.windDirection) : undefined));
  // Unknown or variable direction: borrow the nearest hour's direction (earlier hour on a tie)
  // rather than defaulting to north, which would read as a wind shift.
  const nearestKnown = (i: number): number | undefined => {
    for (let d = 1; d < dirs.length; d++) {
      const before = dirs[i - d];
      if (before !== undefined) return before;
      const after = dirs[i + d];
      if (after !== undefined) return after;
    }
    return undefined;
  };
  return periods.map((p, i) => {
    const unit = p.temperatureUnit === 'C' ? 'C' : 'F';
    const t = Number(p.temperature);
    const dir = dirs[i];
    return {
      startTime: String(p.startTime),
      endTime: String(p.endTime),
      tempF: unit === 'C' ? (t * 9) / 5 + 32 : t,
      windSpeedMph: parseWindSpeed(p.windSpeed),
      windFromDeg: dir ?? nearestKnown(i) ?? 0,
      windDirKnown: dir !== undefined,
      precipChancePct: Number((p.probabilityOfPrecipitation as { value?: number } | undefined)?.value ?? 0),
      shortForecast: String(p.shortForecast ?? ''),
    };
  });
}

export interface GridSeries {
  /** [startMs, endMs, value] */
  values: Array<[number, number, number]>;
}

/** ISO-8601 duration like PT3H, P1DT6H → milliseconds. */
export function durationMs(d: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(d);
  if (!m) return 3_600_000;
  return ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 60_000;
}

export function parseGridSeries(series: unknown, convert: (v: number) => number = (v) => v): GridSeries {
  const vals = (series as { values?: Array<{ validTime: string; value: number | null }> } | undefined)?.values ?? [];
  const out: Array<[number, number, number]> = [];
  for (const v of vals) {
    if (v.value === null || v.value === undefined) continue;
    const [start, dur] = v.validTime.split('/');
    const s = Date.parse(start);
    out.push([s, s + durationMs(dur), convert(v.value)]);
  }
  return { values: out };
}

export function gridValueAt(g: GridSeries, atMs: number): number | undefined {
  for (const [s, e, v] of g.values) if (atMs >= s && atMs < e) return v;
  return undefined;
}

const kmhToMph = (v: number) => v * 0.621371;

export interface GridData {
  windGustMph: GridSeries;
  skyCoverPct: GridSeries;
}

export function parseGridData(body: unknown): GridData {
  const p = (body as { properties?: Record<string, unknown> })?.properties ?? {};
  const gustUom = (p.windGust as { uom?: string } | undefined)?.uom ?? 'wmoUnit:km_h-1';
  return {
    windGustMph: parseGridSeries(p.windGust, gustUom.includes('km_h') ? kmhToMph : (v) => v),
    skyCoverPct: parseGridSeries(p.skyCover),
  };
}

export interface PressureObs {
  atMs: number;
  hPa: number;
  /**
   * Which NWS field the value came from: station barometric pressure or the METAR
   * sea-level pressure. They are reduced differently (often 0.5+ hPa apart), so a
   * trend never mixes them. Missing = barometric.
   */
  field?: 'baro' | 'slp';
}

export function parseObservations(body: unknown): PressureObs[] {
  const feats = (body as { features?: Array<{ properties?: Record<string, unknown> }> })?.features ?? [];
  const out: PressureObs[] = [];
  for (const f of feats) {
    const pr = f.properties;
    if (!pr) continue;
    const baro = (pr.barometricPressure as { value?: number | null } | undefined)?.value;
    const slp = (pr.seaLevelPressure as { value?: number | null } | undefined)?.value;
    const atMs = Date.parse(String(pr.timestamp));
    if (typeof baro === 'number') out.push({ atMs, hPa: baro / 100, field: 'baro' });
    else if (typeof slp === 'number') out.push({ atMs, hPa: slp / 100, field: 'slp' });
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

export function pressureTrend(all: PressureObs[]): { trend: PressureTrend; change3h?: number; latest?: number } {
  // One field for the whole series: barometric when at least two readings have it, else sea-level.
  const baro = all.filter((o) => o.field !== 'slp');
  const obs = baro.length >= 2 ? baro : all.filter((o) => o.field === 'slp');
  if (obs.length < 2) return { trend: 'unknown', latest: all[all.length - 1]?.hPa };
  const latest = obs[obs.length - 1];
  const target = latest.atMs - 3 * 3_600_000;
  const earlier = obs.reduce((best, o) => (Math.abs(o.atMs - target) < Math.abs(best.atMs - target) ? o : best), obs[0]);
  if (latest.atMs - earlier.atMs < 3_600_000) return { trend: 'unknown', latest: latest.hPa };
  const change = ((latest.hPa - earlier.hPa) * 3 * 3_600_000) / (latest.atMs - earlier.atMs);
  const trend: PressureTrend = change >= 1 ? 'rising' : change <= -1 ? 'falling' : 'steady';
  return { trend, change3h: Math.round(change * 10) / 10, latest: latest.hPa };
}

export function precipFromForecast(shortForecast: string, popPct: number): PrecipType {
  const s = shortForecast.toLowerCase();
  if (s.includes('thunder')) return 'thunderstorm';
  if (s.includes('freezing rain') || s.includes('freezing drizzle')) return 'freezing_rain';
  if (s.includes('sleet') || s.includes('ice pellets')) return 'sleet';
  if (popPct < 30) return 'none';
  if (s.includes('snow') || s.includes('flurries')) return 'snow';
  if (s.includes('rain') || s.includes('shower') || s.includes('drizzle')) return 'rain';
  return 'none';
}

/**
 * Build the snapshot for a sit: conditions at the sit midpoint plus the hourly
 * winds, gusts and temperatures across the window (for shift detection and the
 * worst-hour weather gates). Precip uses the worst hour. The pressure trend is the
 * one observed now, so it is only used when the sit starts within a few hours.
 */
export function buildSnapshot(
  hourly: HourlyPeriod[],
  grid: GridData | null,
  obs: PressureObs[],
  windowStartIso: string,
  windowEndIso: string,
  id: string,
): WeatherSnapshot {
  const s = Date.parse(windowStartIso);
  const e = Date.parse(windowEndIso);
  const mid = (s + e) / 2;
  const inWindow = hourly.filter((h) => Date.parse(h.endTime) > s && Date.parse(h.startTime) < e);
  if (!inWindow.length) throw new Error('No forecast for that hunt window yet. NWS hourly forecasts run about 7 days out.');
  if (!inWindow.some((h) => h.windDirKnown)) throw new Error('NWS lists the wind as variable for your whole sit, so there is no direction to plan around. Set the wind by hand.');
  const at = inWindow.reduce((best, h) => (Math.abs(Date.parse(h.startTime) - mid) < Math.abs(Date.parse(best.startTime) - mid) ? h : best), inWindow[0]);
  const gustAt = (ms: number) => (grid ? gridValueAt(grid.windGustMph, ms) : undefined);
  const hourlyWinds: HourlyWind[] = inWindow.map((h) => ({
    at: new Date(Date.parse(h.startTime)).toISOString(),
    windFromDeg: h.windFromDeg,
    windSpeedMph: h.windSpeedMph,
    windGustMph: gustAt(Date.parse(h.startTime)),
    tempF: h.tempF,
  }));
  const severity: PrecipType[] = ['none', 'rain', 'snow', 'sleet', 'freezing_rain', 'thunderstorm'];
  const precipType = inWindow.map((h) => precipFromForecast(h.shortForecast, h.precipChancePct)).reduce((w, p) => (severity.indexOf(p) > severity.indexOf(w) ? p : w), 'none' as PrecipType);
  const latestObsMs = obs.length ? Math.max(...obs.map((o) => o.atMs)) : undefined;
  // Today's observed trend says nothing about a sit tomorrow or later in the week.
  const p = latestObsMs !== undefined && s - latestObsMs <= PRESSURE_TREND_MAX_LEAD_MS ? pressureTrend(obs) : { trend: 'unknown' as PressureTrend, change3h: undefined, latest: undefined };
  const gust = gustAt(Date.parse(at.startTime));
  return {
    id,
    at: new Date(Date.parse(at.startTime)).toISOString(),
    source: 'nws',
    windFromDeg: at.windFromDeg,
    windSpeedMph: at.windSpeedMph,
    windGustMph: Math.max(at.windSpeedMph, gust ?? at.windSpeedMph),
    tempF: at.tempF,
    cloudCoverPct: grid ? gridValueAt(grid.skyCoverPct, Date.parse(at.startTime)) : undefined,
    precipChancePct: Math.max(...inWindow.map((h) => h.precipChancePct)),
    precipType,
    pressureHpa: p.latest,
    pressureTrend: p.trend,
    pressureChange3hHpa: p.change3h,
    windChillF: Math.round(windChillF(at.tempF, at.windSpeedMph)),
    hourly: hourlyWinds,
    overriddenFields: [],
    shortForecast: at.shortForecast,
  };
}

/** Hunter overrides always win and are recorded so the UI can badge them. */
export function applyOverrides(w: WeatherSnapshot, o: Partial<Pick<WeatherSnapshot, 'windFromDeg' | 'windSpeedMph' | 'windGustMph' | 'tempF' | 'cloudCoverPct' | 'precipType' | 'pressureTrend'>>): WeatherSnapshot {
  const fields = Object.keys(o).filter((k) => (o as Record<string, unknown>)[k] !== undefined);
  if (!fields.length) return w;
  const next: WeatherSnapshot = { ...w, ...o, source: w.source === 'manual' ? 'manual' : 'mixed', overriddenFields: Array.from(new Set([...w.overriddenFields, ...fields])) };
  if (o.windFromDeg !== undefined || o.windSpeedMph !== undefined) {
    // A hand-entered wind replaces the forecast trend for the whole sit.
    next.hourly = next.hourly?.map((h) => ({ ...h, windFromDeg: o.windFromDeg ?? h.windFromDeg, windSpeedMph: o.windSpeedMph ?? h.windSpeedMph }));
  }
  next.windGustMph = Math.max(next.windGustMph, next.windSpeedMph);
  next.windChillF = Math.round(windChillF(next.tempF, next.windSpeedMph));
  return next;
}

export interface NwsClientOptions {
  fetchFn?: FetchFn;
  userAgent: string;
  /** Per-request timeout (ms). Default NWS_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * Runs a request with a hard deadline: aborts it (when the fetch supports AbortSignal)
 * and rejects even if the fetch ignores the signal, so callers can fall back to cache.
 */
async function withTimeout<T>(ms: number, label: string, run: (signal: AbortSignal | undefined) => Promise<T>): Promise<T> {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl?.abort();
      reject(new Error(`${label} timed out after ${Math.round(ms / 1000)} s`));
    }, ms);
  });
  try {
    return await Promise.race([run(ctrl?.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url: string, opts: NwsClientOptions): Promise<unknown> {
  return withTimeout(opts.timeoutMs ?? NWS_TIMEOUT_MS, 'NWS request', async (signal) => {
    const res = await (opts.fetchFn ?? fetch)(url, { headers: { 'User-Agent': opts.userAgent, Accept: 'application/geo+json' }, signal });
    if (!res.ok) throw new Error(`NWS ${res.status} for ${url}`);
    return res.json();
  });
}

export async function fetchSnapshot(loc: LatLon, windowStartIso: string, windowEndIso: string, opts: NwsClientOptions): Promise<{ snapshot: WeatherSnapshot; point: NwsPoint }> {
  const point = parsePoint(await getJson(`${NWS_BASE}/points/${loc.lat.toFixed(4)},${loc.lon.toFixed(4)}`, opts));
  const [hourlyBody, gridBody, stationsBody] = await Promise.all([
    getJson(point.forecastHourlyUrl, opts),
    getJson(point.gridDataUrl, opts).catch(() => null),
    getJson(point.stationsUrl, opts).catch(() => null),
  ]);
  const stationId = (stationsBody as { features?: Array<{ properties?: { stationIdentifier?: string } }> } | null)?.features?.[0]?.properties?.stationIdentifier;
  const obsBody = stationId ? await getJson(`${NWS_BASE}/stations/${stationId}/observations?limit=8`, opts).catch(() => null) : null;
  const snapshot = buildSnapshot(
    parseHourly(hourlyBody),
    gridBody ? parseGridData(gridBody) : null,
    obsBody ? parseObservations(obsBody) : [],
    windowStartIso,
    windowEndIso,
    `wx-${Date.now()}`,
  );
  return { snapshot, point };
}
