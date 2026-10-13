import { create } from 'zustand';
import {
  AM_HOLD_MIN,
  addMinutes,
  applyOverridesSafe,
  buildPlanCard,
  derivePhase,
  geoToLocal,
  legalHours,
  planHunt,
  sunTimes,
  type HuntWindow,
  type LatLon,
  type Plan,
  type PlanCard,
  type Property,
  type SeasonPhase,
  type WeatherSnapshot,
} from './engineFacade';
import { getSetting, listPressure, listSightings, savePlan, setSetting } from '../db/repos';
import { loadTerrain } from './landdata';
import type { PlanDraft } from '../state/store';
import { fmtTime, nextSit, todayLocal, uid } from '../utils/format';

/**
 * Glue between the app and the rules engine. All of it runs on-device, offline.
 */

export function propertyLocation(p: Property, fallback?: LatLon): LatLon | undefined {
  return p.calibration?.originGeo ?? fallback;
}

/** Where a GPS fix lands on the calibrated map (local meters), if geo-referenced. */
export function gpsToLocal(p: Property, gps: LatLon) {
  return p.calibration?.originGeo ? geoToLocal(gps, p.calibration.originGeo) : undefined;
}

// ---------------------------------------------------------------------------
// Approximate location for photo-only maps
// ---------------------------------------------------------------------------

/**
 * A map calibrated with north and scale only has no coordinates. Sun times, legal
 * hours and the forecast still need a location, so the hunter can give the phone's
 * GPS position (taken at or near the property) as an approximate one. Stored
 * per property in encrypted local settings; never used to place anything on the map.
 */
interface ApproxLocationState {
  byProperty: Record<string, LatLon>;
}

export const useApproxLocations = create<ApproxLocationState>(() => ({ byProperty: {} }));

const APPROX_KEY = 'approxLocations';
let approxLoad: Promise<void> | null = null;

/** Loads saved approximate locations once per app run. Safe to call repeatedly. */
export function loadApproxLocations(): Promise<void> {
  approxLoad ??= getSetting<Record<string, LatLon>>(APPROX_KEY, {})
    .then((saved) => useApproxLocations.setState({ byProperty: { ...saved, ...useApproxLocations.getState().byProperty } }))
    .catch(() => undefined);
  return approxLoad;
}

export async function setApproxLocation(propertyId: string, loc: LatLon): Promise<void> {
  const byProperty = { ...useApproxLocations.getState().byProperty, [propertyId]: loc };
  useApproxLocations.setState({ byProperty });
  await setSetting(APPROX_KEY, byProperty);
}

/**
 * The location sun, legal-hours and forecast math uses for a property: the map's
 * own origin when it is geo-referenced, else the hunter's approximate GPS location.
 */
export function planLocation(p: Property, approx: LatLon | undefined = useApproxLocations.getState().byProperty[p.id]): { loc?: LatLon; approximate: boolean } {
  const origin = p.calibration?.originGeo;
  if (origin) return { loc: origin, approximate: false };
  return { loc: approx, approximate: !!approx };
}

// ---------------------------------------------------------------------------
// Default sit
// ---------------------------------------------------------------------------

/**
 * The next sit that has not ended yet, using this property's sun times when known:
 * the AM sit runs until sunrise plus the phase's hold time, the PM sit until legal light ends.
 */
export function defaultSit(property: Property | null, phaseOverride?: SeasonPhase, now = new Date()): { date: string; window: HuntWindow } {
  const loc = property ? planLocation(property).loc : undefined;
  if (!property || !loc) return nextSit(now);
  try {
    const today = todayLocal(now);
    const sun = sunTimes(today, loc.lat, loc.lon);
    const phase = derivePhase(today, property.stateCode, phaseOverride).phase;
    return nextSit(now, { amEnd: addMinutes(sun.sunrise, AM_HOLD_MIN[phase]), pmEnd: legalHours(sun).end });
  } catch {
    return nextSit(now);
  }
}

// ---------------------------------------------------------------------------
// Placeholder weather
// ---------------------------------------------------------------------------

/** The values a hunter vouches for when there is no forecast. */
export const CONFIRM_FIELDS = ['windFromDeg', 'windSpeedMph', 'windGustMph', 'tempF', 'precipType'] as const;

/** True once the hunter has set or confirmed every value that gates a stand or a climb. */
export function conditionsConfirmed(o: PlanDraft['overrides']): boolean {
  return CONFIRM_FIELDS.every((k) => o[k] !== undefined);
}

/**
 * The weather the engine plans with: forecast plus the hunter's overrides. A
 * placeholder (no forecast) stays flagged until the hunter has confirmed every
 * gating value; then it is the hunter's own observation ("entered by you").
 */
export function effectiveWeather(forecast: WeatherSnapshot, overrides: PlanDraft['overrides']): WeatherSnapshot {
  const w = applyOverridesSafe(forecast, overrides);
  return w.placeholder && conditionsConfirmed(overrides) ? { ...w, placeholder: false } : w;
}

export async function runPlan(property: Property, draft: PlanDraft, forecast: WeatherSnapshot, location: LatLon): Promise<{ plan: Plan; card: PlanCard }> {
  const weather = effectiveWeather(forecast, draft.overrides);
  const since = new Date(Date.now() - 45 * 86_400_000).toISOString();
  const [sightings, pressure, terrain] = await Promise.all([listSightings(property.id, since), listPressure(property.id), loadTerrain(property)]);
  const plan = planHunt({
    property,
    inputs: {
      propertyId: property.id,
      date: draft.date,
      window: draft.window,
      location,
      weather,
      weapon: { type: draft.weaponType, effectiveRangeYds: draft.rangeYds },
      phaseOverride: draft.phaseOverride,
      beddingSetbackOverrideM: draft.setbackOverrideM,
    },
    sightings,
    pressure,
    terrain,
    planId: uid('plan'),
  });
  const card = buildPlanCard(plan, property.name, fmtTime);
  await savePlan(plan, card);
  return { plan, card };
}
