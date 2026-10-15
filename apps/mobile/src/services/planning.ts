import { create } from 'zustand';
import {
  AM_HOLD_MIN,
  addMinutes,
  applyOverridesSafe,
  buildPlanCard,
  derivePhase,
  geoToLocal,
  legalHoursFor,
  planHunt,
  sunTimes,
  type HuntWindow,
  type LatLon,
  type LegalHours,
  type Plan,
  type PlanCard,
  type Property,
  type SeasonPhase,
  type SunTimes,
  type WeatherSnapshot,
} from './engineFacade';
import { getSetting, listPressure, listSightings, savePlan, setSetting } from '../db/repos';
import { loadTerrain } from './landdata';
import { useAppStore, type PlanDraft } from '../state/store';
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
/** Bumped by every reset, so a read that was already in flight cannot bring old locations back. */
let approxGeneration = 0;

/** Loads saved approximate locations once per app run. Safe to call repeatedly. */
export function loadApproxLocations(): Promise<void> {
  const generation = approxGeneration;
  approxLoad ??= getSetting<Record<string, LatLon>>(APPROX_KEY, {})
    .then((saved) => {
      if (generation === approxGeneration) useApproxLocations.setState({ byProperty: { ...saved, ...useApproxLocations.getState().byProperty } });
    })
    .catch(() => undefined);
  return approxLoad;
}

/**
 * Forgets every approximate location: the in-memory store, the load memo and the saved copy.
 * Delete-all-data calls this, so no property position from before the wipe stays in memory
 * or is written back into the fresh database by the next GPS save. Never throws: when the
 * database cannot be written, the wipe itself reports that.
 */
export async function resetApproxLocations(): Promise<void> {
  approxGeneration += 1;
  approxLoad = null;
  useApproxLocations.setState({ byProperty: {} });
  await setSetting(APPROX_KEY, {}).catch(() => undefined);
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
// Legal hours: the hunter's own setting
// ---------------------------------------------------------------------------

/**
 * The legal-light offsets from Settings (minutes before sunrise / after sunset). They go into
 * every plan, and every screen that shows legal light or sizes a sit uses the same ones, so a
 * hunter who set 45 minutes sees 45 minutes on Home, in the forecast window and on the plan.
 */
export function legalMinutesSetting(): { legalMinutesBefore: number; legalMinutesAfter: number } {
  const { legalMinutesBefore, legalMinutesAfter } = useAppStore.getState().settings;
  return { legalMinutesBefore, legalMinutesAfter };
}

/** Legal shooting hours for a day's sun times, using the hunter's setting. */
export function legalHoursSetting(sun: SunTimes, minutes: { legalMinutesBefore: number; legalMinutesAfter: number } = legalMinutesSetting()): LegalHours {
  return legalHoursFor(sun, minutes);
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
    return nextSit(now, { amEnd: addMinutes(sun.sunrise, AM_HOLD_MIN[phase]), pmEnd: legalHoursSetting(sun).end });
  } catch {
    return nextSit(now);
  }
}

// ---------------------------------------------------------------------------
// Placeholder weather
// ---------------------------------------------------------------------------

/** The values a hunter vouches for when there is no forecast. */
export const CONFIRM_FIELDS = ['windFromDeg', 'windSpeedMph', 'windGustMph', 'tempF', 'precipType'] as const;

/**
 * True once the hunter has set or confirmed every value that gates a stand or a climb.
 * The draft's overrides always belong to the sit (property, date, window) now selected:
 * `installSitGuard` drops them when any of those change, so a confirmation given for one
 * sit can never vouch for another.
 */
export function conditionsConfirmed(o: PlanDraft['overrides']): boolean {
  return CONFIRM_FIELDS.every((k) => o[k] !== undefined);
}

type SitSlice = Pick<ReturnType<typeof useAppStore.getState>, 'draft' | 'properties' | 'activePropertyId'>;

/** Which sit the draft describes, as far as the hunter's own entries are concerned. */
export function overridesSitKey(s: SitSlice): string {
  const active = s.properties.find((p) => p.id === s.activePropertyId) ?? s.properties[0];
  return `${active?.id ?? ''}|${s.draft.date}|${s.draft.window}`;
}

let sitGuardInstalled = false;

/**
 * Wind, temperature and precipitation the hunter typed or confirmed are an observation about
 * ONE sit. When the property, the date or the AM/PM window changes without the entries being
 * edited at the same time, they are cleared, so a confirmation of placeholder defaults for
 * this morning cannot silently vouch for tomorrow's conditions (or another property's).
 * Runs once, when this module loads, so it covers every screen that can change the draft.
 */
export function installSitGuard(): void {
  if (sitGuardInstalled) return;
  sitGuardInstalled = true;
  useAppStore.subscribe((s, prev) => {
    if (s.draft.overrides !== prev.draft.overrides) return; // the hunter just set them: they are for this sit
    if (Object.keys(s.draft.overrides).length === 0) return;
    if (overridesSitKey(s) !== overridesSitKey(prev)) s.clearOverrides();
  });
}
installSitGuard();

/**
 * The weather the engine plans with: forecast plus the hunter's overrides. A
 * placeholder (no forecast) stays flagged until the hunter has confirmed every
 * gating value; then it is the hunter's own observation ("entered by you").
 */
export function effectiveWeather(forecast: WeatherSnapshot, overrides: PlanDraft['overrides']): WeatherSnapshot {
  const w = applyOverridesSafe(forecast, overrides);
  return w.placeholder && conditionsConfirmed(overrides) ? { ...w, placeholder: false } : w;
}

/**
 * Plans one sit. The hunter's own legal-light offsets (Settings) ride along with every plan; a
 * re-plan of a plan already on screen passes that plan's own offsets so the sit stays the same.
 */
export async function runPlan(
  property: Property,
  draft: PlanDraft,
  forecast: WeatherSnapshot,
  location: LatLon,
  legal: { legalMinutesBefore?: number; legalMinutesAfter?: number } = legalMinutesSetting(),
): Promise<{ plan: Plan; card: PlanCard }> {
  const weather = effectiveWeather(forecast, draft.overrides);
  const { legalMinutesBefore, legalMinutesAfter } = legal;
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
      legalMinutesBefore,
      legalMinutesAfter,
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
