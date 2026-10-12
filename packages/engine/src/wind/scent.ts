import type { HuntWindow, Vec } from '../models.ts';
import { add, angleDiff, bearingTo, bearingVec, compass16, dist, downwindBearing, normDeg, scale, sectorPolygon, shapeDistance } from '../geo/geometry.ts';
import type { SlopeInfo } from '../terrain/terrain.ts';

/**
 * Scent dispersion model.
 *
 * Wind is a hard gate: a stand whose scent plume reaches the deer's approach path,
 * bedding, or the feeding area they are headed to is eliminated, however good it
 * scores otherwise. Mature bucks die of hunter mistakes, not hunter luck.
 *
 *  - Wind >= 6 mph: one plume straight downwind. Half-angle widens with gustiness
 *    and with forecast direction swings during the sit.
 *  - Wind < 6 mph: the wind no longer controls the plume on sloped ground, so thermals
 *    are applied. Cool air sinks downslope before sunrise and toward last light; warm air
 *    rises upslope mid-morning and early afternoon. Sits span both, so both plumes count.
 *  - Calm with unknown terrain: scent pools and swirls around the stand.
 */
export const LIGHT_WIND_MPH = 6;
export const CALM_MPH = 2;
export const WIND_PLUME_LENGTH_M = 400;
export const LIGHT_PLUME_LENGTH_M = 250;
export const THERMAL_PLUME_LENGTH_M = 200;
export const THERMAL_MIN_SLOPE_PCT = 4;
export const APEX_OFFSET_M = 6;

export type PlumeKind = 'wind' | 'thermal_falling' | 'thermal_rising' | 'swirl';

export interface ScentPlume {
  kind: PlumeKind;
  bearingDeg: number;
  halfAngleDeg: number;
  lengthM: number;
  note: string;
}

export interface WindState {
  windFromDeg: number;
  windSpeedMph: number;
  windGustMph: number;
  /** Max angular swing (degrees) of forecast wind during the sit window. */
  directionSpreadDeg?: number;
}

export interface ScentModel {
  plumes: ScentPlume[];
  thermalsApplied: boolean;
  notes: string[];
}

export function windSpreadHalfAngle(w: WindState): number {
  const gustSpread = Math.max(0, w.windGustMph - w.windSpeedMph);
  const dirSpread = Math.min(60, w.directionSpreadDeg ?? 0);
  return Math.max(15, Math.min(60, 15 + gustSpread * 1.0 + dirSpread * 0.5));
}

export function scentModel(w: WindState, slope: SlopeInfo | null, window: HuntWindow): ScentModel {
  const downwind = downwindBearing(w.windFromDeg);
  const notes: string[] = [];
  const plumes: ScentPlume[] = [];

  if (w.windSpeedMph >= LIGHT_WIND_MPH) {
    plumes.push({
      kind: 'wind',
      bearingDeg: downwind,
      halfAngleDeg: windSpreadHalfAngle(w),
      lengthM: WIND_PLUME_LENGTH_M,
      note: `${Math.round(w.windSpeedMph)} mph ${compass16(w.windFromDeg)} wind carries scent ${compass16(downwind)}.`,
    });
    return { plumes, thermalsApplied: false, notes };
  }

  if (w.windSpeedMph >= CALM_MPH) {
    plumes.push({
      kind: 'wind',
      bearingDeg: downwind,
      halfAngleDeg: Math.min(75, windSpreadHalfAngle(w) + 20),
      lengthM: LIGHT_PLUME_LENGTH_M,
      note: `Light ${compass16(w.windFromDeg)} wind, so expect a wide, wandering plume.`,
    });
  }

  if (slope && slope.slopePct >= THERMAL_MIN_SLOPE_PCT) {
    const down = slope.downslopeBearingDeg;
    const up = normDeg(down + 180);
    const falling: ScentPlume = {
      kind: 'thermal_falling',
      bearingDeg: down,
      halfAngleDeg: 30,
      lengthM: THERMAL_PLUME_LENGTH_M,
      note: window === 'AM' ? `Before sunrise, cool air drains scent downhill (${compass16(down)}).` : `Near last light, cooling air pulls scent downhill (${compass16(down)}).`,
    };
    const rising: ScentPlume = {
      kind: 'thermal_rising',
      bearingDeg: up,
      halfAngleDeg: 30,
      lengthM: THERMAL_PLUME_LENGTH_M,
      note: window === 'AM' ? `Once the sun warms the slope, scent lifts uphill (${compass16(up)}).` : `Early in the sit, warm air lifts scent uphill (${compass16(up)}).`,
    };
    plumes.push(falling, rising);
    notes.push(slope.source === 'elevation' ? 'Thermals applied using USGS elevation.' : 'Thermals estimated from mapped ridges and draws. Calibrate the map to coordinates for elevation-based thermals.');
    return { plumes, thermalsApplied: true, notes };
  }

  if (w.windSpeedMph < CALM_MPH) {
    plumes.push({ kind: 'swirl', bearingDeg: downwind, halfAngleDeg: 180, lengthM: 120, note: 'Near-calm air, so scent pools and swirls around the stand.' });
    notes.push('Calm conditions: scent direction is unpredictable.');
  } else if (!slope) {
    notes.push('Light wind, terrain unknown. Thermals could not be checked.');
  }
  return { plumes, thermalsApplied: false, notes };
}

export type SensitiveKind = 'bedding' | 'food' | 'approach';

export interface SensitiveArea {
  id: string;
  kind: SensitiveKind;
  label: string;
  shape: Vec[];
  closed: boolean;
  /** Plume reach (m) inside which a hit eliminates the stand. Beyond it, up to plume length, it's a caution. */
  hardRangeM: number;
}

export interface PlumeHit {
  area: SensitiveArea;
  plume: ScentPlume;
  hard: boolean;
  distanceM: number;
}

export interface GateResult {
  passes: boolean;
  hits: PlumeHit[];
}

/** Rough distance from the stand to the nearest part of an area. */
function areaDistance(origin: Vec, area: SensitiveArea): number {
  return shapeDistance([origin], false, area.shape, area.closed);
}

function plumeHitsArea(origin: Vec, plume: ScentPlume, area: SensitiveArea, lengthM: number): boolean {
  // Fast reject on distance before the polygon test.
  if (areaDistance(origin, area) > lengthM) return false;
  // From an elevated stand the plume starts drifting a few meters downwind of the tree,
  // so a trail passing directly under the stand isn't "hit" by the apex itself.
  const apex = plume.kind === 'swirl' ? origin : add(origin, scale(bearingVec(plume.bearingDeg), APEX_OFFSET_M));
  const sector = sectorPolygon(apex, plume.bearingDeg, plume.halfAngleDeg, lengthM);
  return shapeDistance(sector, true, area.shape, area.closed) === 0;
}

export function evaluateGate(origin: Vec, model: ScentModel, areas: SensitiveArea[]): GateResult {
  const hits: PlumeHit[] = [];
  for (const plume of model.plumes) {
    for (const area of areas) {
      const hardLen = Math.min(plume.lengthM, area.hardRangeM);
      if (plumeHitsArea(origin, plume, area, hardLen)) {
        hits.push({ area, plume, hard: true, distanceM: areaDistance(origin, area) });
      } else if (plume.lengthM > hardLen && plumeHitsArea(origin, plume, area, plume.lengthM)) {
        hits.push({ area, plume, hard: false, distanceM: areaDistance(origin, area) });
      }
    }
  }
  return { passes: !hits.some((h) => h.hard), hits };
}

/**
 * How far (degrees) the wind can swing either way before the stand fails.
 * 0 = fails now; 90 = robust to any reasonable shift.
 */
export function windMargin(passesAt: (windFromDeg: number) => boolean, windFromDeg: number, stepDeg = 5, maxDeg = 90): number {
  if (!passesAt(windFromDeg)) return 0;
  for (let d = stepDeg; d <= maxDeg; d += stepDeg) {
    if (!passesAt(normDeg(windFromDeg + d)) || !passesAt(normDeg(windFromDeg - d))) return d - stepDeg / 2;
  }
  return maxDeg;
}

/** Bearing from stand to the nearest point of an area, for "why" text. */
export function bearingToArea(origin: Vec, area: SensitiveArea): number {
  let best = area.shape[0];
  for (const p of area.shape) if (dist(origin, p) < dist(origin, best)) best = p;
  return bearingTo(origin, best);
}

/** Direction swing of forecast hourly winds relative to the current direction. */
export function directionSpread(current: number, dirs: number[]): number {
  return dirs.reduce((m, d) => Math.max(m, angleDiff(current, d)), 0);
}
