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

export function sitBounds(date: string, window: HuntWindow, loc: LatLon, stateCode: string): { start: string; end: string } {
  const phase = derivePhase(date, stateCode).phase;
  const sun = sunTimes(date, loc.lat, loc.lon);
  const legal = legalHours(sun);
  return window === 'AM'
    ? { start: legal.start, end: addMinutes(sun.sunrise, AM_HOLD_MIN[phase]) }
    : { start: addMinutes(sun.sunset, -PM_SETTLE_MIN[phase]), end: legal.end };
}

export interface WeatherResult {
  snapshot: WeatherSnapshot;
  status: 'ok' | 'offline';
  note?: string;
}

export async function loadForecast(loc: LatLon, date: string, window: HuntWindow, stateCode: string): Promise<WeatherResult> {
  const key = `nws:${loc.lat.toFixed(3)},${loc.lon.toFixed(3)}:${date}:${window}`;
  const fresh = await cacheGet<WeatherSnapshot>(key, FORECAST_TTL_MS);
  if (fresh) return { snapshot: fresh, status: 'ok' };
  const { start, end } = sitBounds(date, window, loc, stateCode);
  try {
    const userAgent = String(Constants.expoConfig?.extra?.nwsUserAgent ?? 'MatureBuckStandPlanner/0.1');
    const { snapshot } = await nws.fetchSnapshot(loc, start, end, { userAgent });
    await cacheSet(key, snapshot);
    return { snapshot, status: 'ok' };
  } catch (e) {
    const stale = await cacheGet<WeatherSnapshot>(key, STALE_OK_MS);
    if (stale) return { snapshot: stale, status: 'offline', note: 'Offline: showing the last forecast you downloaded.' };
    throw new Error(e instanceof Error ? e.message : 'Forecast unavailable');
  }
}

/** A blank manual snapshot for when there is no forecast (offline, or map not geo-referenced). */
export async function manualSnapshot(): Promise<WeatherSnapshot> {
  const last = await lastWeather();
  return {
    id: uid('wx'),
    at: new Date().toISOString(),
    source: 'manual',
    windFromDeg: last?.windFromDeg ?? 315,
    windSpeedMph: last?.windSpeedMph ?? 8,
    windGustMph: last?.windGustMph ?? 12,
    tempF: last?.tempF ?? 45,
    cloudCoverPct: undefined,
    precipChancePct: 0,
    precipType: 'none',
    pressureTrend: 'unknown',
    overriddenFields: [],
  };
}
