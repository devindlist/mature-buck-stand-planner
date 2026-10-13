import Constants from 'expo-constants';
import {
  nws,
  derivePhase,
  sunTimes,
  legalHours,
  addMinutes,
  AM_HOLD_MIN,
  PM_SETTLE_MIN,
  type HuntWindow,
  type LatLon,
  type SeasonPhase,
  type WeatherSnapshot,
} from '@msp/engine';
import { cacheGet, cacheSet, lastWeather } from '../db/repos';
import { uid } from '../utils/format';

/**
 * Forecast auto-fill from the National Weather Service. Cached for offline use:
 * a hunter can plan at home on Wi-Fi and still open everything at the truck.
 */
const FORECAST_TTL_MS = 45 * 60_000;
const STALE_OK_MS = 18 * 3_600_000;
/** Per NWS request. The engine client aborts a request that runs longer. */
const NWS_REQUEST_TIMEOUT_MS = 10_000;
/** The whole forecast (points + hourly + grid + observations). After this, fall back to cache or manual entry. */
export const FORECAST_DEADLINE_MS = 25_000;

/**
 * The sit window the forecast is fetched for. Uses the same phase as the planner
 * (the hunter's override when set), so every hour of the planned sit has hourly winds.
 */
export function sitBounds(date: string, window: HuntWindow, loc: LatLon, stateCode: string, phaseOverride?: SeasonPhase): { start: string; end: string } {
  const phase = derivePhase(date, stateCode, phaseOverride).phase;
  const sun = sunTimes(date, loc.lat, loc.lon);
  const legal = legalHours(sun);
  return window === 'AM'
    ? { start: legal.start, end: addMinutes(sun.sunrise, AM_HOLD_MIN[phase]) }
    : { start: addMinutes(sun.sunset, -PM_SETTLE_MIN[phase]), end: legal.end };
}

/**
 * Identifies which sit a snapshot was made for: location, date, window and the phase
 * that sets the window length. Screens compare it with the current draft so a snapshot
 * for another date, window or phase is never planned with or shown as current.
 */
export function forecastKey(loc: LatLon | undefined, date: string, window: HuntWindow, phase: SeasonPhase, propertyId = ''): string {
  return loc ? `${loc.lat.toFixed(3)},${loc.lon.toFixed(3)}|${date}|${window}|${phase}` : `nogeo:${propertyId}|${date}|${window}`;
}

const snapshotKeys = new WeakMap<WeatherSnapshot, string>();

/** Records which sit a snapshot belongs to (see forecastKey). */
export function tagForecast(w: WeatherSnapshot, key: string): WeatherSnapshot {
  snapshotKeys.set(w, key);
  return w;
}

/** The sit a snapshot was loaded for, or undefined if it was never tagged. */
export function forecastKeyOf(w: WeatherSnapshot | null | undefined): string | undefined {
  return w ? snapshotKeys.get(w) : undefined;
}

export interface WeatherResult {
  snapshot: WeatherSnapshot;
  status: 'ok' | 'offline';
  note?: string;
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`No answer from the National Weather Service in ${Math.round(ms / 1000)} s.`)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Forecast for one sit. `phaseOverride` (optional) is the hunter's phase override; it
 * changes how long the sit runs, so it changes the hours fetched and the cache key.
 */
export async function loadForecast(loc: LatLon, date: string, window: HuntWindow, stateCode: string, phaseOverride?: SeasonPhase): Promise<WeatherResult> {
  const phase = derivePhase(date, stateCode, phaseOverride).phase;
  const tag = forecastKey(loc, date, window, phase);
  const key = `nws:${tag}`;
  const fresh = await cacheGet<WeatherSnapshot>(key, FORECAST_TTL_MS);
  if (fresh) return { snapshot: tagForecast(fresh, tag), status: 'ok' };
  const { start, end } = sitBounds(date, window, loc, stateCode, phaseOverride);
  try {
    const userAgent = String(Constants.expoConfig?.extra?.nwsUserAgent ?? 'MatureBuckStandPlanner/0.1');
    const { snapshot } = await withDeadline(nws.fetchSnapshot(loc, start, end, { userAgent, timeoutMs: NWS_REQUEST_TIMEOUT_MS }), FORECAST_DEADLINE_MS);
    await cacheSet(key, snapshot);
    return { snapshot: tagForecast(snapshot, tag), status: 'ok' };
  } catch (e) {
    const stale = await cacheGet<WeatherSnapshot>(key, STALE_OK_MS);
    if (stale) return { snapshot: tagForecast(stale, tag), status: 'offline', note: 'Offline: showing the last forecast you downloaded.' };
    throw new Error(e instanceof Error ? e.message : 'Forecast unavailable');
  }
}

/**
 * Starting values for when there is no forecast (offline, too far out, or no location).
 * They are placeholders, not conditions: the UI never gives them a weather all-clear,
 * and the hunter confirms or edits them before a plan is made.
 */
export async function manualSnapshot(): Promise<WeatherSnapshot> {
  const last = await lastWeather().catch(() => null);
  return {
    id: uid('wx'),
    at: new Date().toISOString(),
    source: 'manual',
    windFromDeg: last?.windFromDeg ?? 315,
    windSpeedMph: last?.windSpeedMph ?? 8,
    windGustMph: last?.windGustMph ?? 12,
    tempF: last?.tempF ?? 45,
    cloudCoverPct: undefined,
    precipChancePct: undefined,
    precipType: 'none',
    pressureTrend: 'unknown',
    overriddenFields: [],
    placeholder: true,
  };
}
