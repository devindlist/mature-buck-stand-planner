import {
  applyOverridesSafe,
  buildPlanCard,
  geoToLocal,
  planHunt,
  type LatLon,
  type Plan,
  type PlanCard,
  type Property,
  type WeatherSnapshot,
} from './engineFacade';
import { listPressure, listSightings, savePlan } from '../db/repos';
import { loadTerrain } from './landdata';
import type { PlanDraft } from '../state/store';
import { fmtTime, uid } from '../utils/format';

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

export async function runPlan(property: Property, draft: PlanDraft, forecast: WeatherSnapshot, location: LatLon): Promise<{ plan: Plan; card: PlanCard }> {
  const weather = applyOverridesSafe(forecast, draft.overrides);
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
