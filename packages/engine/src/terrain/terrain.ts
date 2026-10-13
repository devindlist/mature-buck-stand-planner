import type { MapFeature, Vec } from '../models.ts';
import { bearingTo, pointGeometryDistance, projectOntoPolyline } from '../geo/geometry.ts';

/**
 * Elevation access. Backed by a USGS 3DEP grid when the photo is geo-referenced
 * (sampled through the EPQS service and cached on device), otherwise absent.
 */
export interface TerrainModel {
  /** Elevation in meters at a local point, or undefined outside coverage. */
  elevationAt(p: Vec): number | undefined;
}

/**
 * Regular grid of elevations in local meters. Row 0 is the southern edge.
 * Missing samples (a failed 3DEP point) are NaN. A grid that went through JSON (the
 * on-device cache) has them as null instead: both mean "no data", never 0 m.
 */
export class GridTerrain implements TerrainModel {
  readonly origin: Vec;
  readonly cellM: number;
  readonly cols: number;
  readonly rows: number;
  readonly values: Float64Array;

  constructor(origin: Vec, cellM: number, cols: number, rows: number, values: Float64Array | ArrayLike<number | null | undefined>) {
    if (values.length !== cols * rows) throw new Error('Elevation grid size mismatch');
    this.origin = origin;
    this.cellM = cellM;
    this.cols = cols;
    this.rows = rows;
    // Float64Array.from(null) would give 0, so map anything that isn't a finite number to NaN.
    this.values = Float64Array.from(values as ArrayLike<unknown>, (x) => (typeof x === 'number' && Number.isFinite(x) ? x : NaN));
  }

  /** Share of grid nodes with a real elevation (0..1). */
  coverage(): number {
    let n = 0;
    for (const x of this.values) if (Number.isFinite(x)) n++;
    return this.values.length ? n / this.values.length : 0;
  }

  elevationAt(p: Vec): number | undefined {
    const fx = (p.x - this.origin.x) / this.cellM;
    const fy = (p.y - this.origin.y) / this.cellM;
    if (!(fx >= 0 && fy >= 0 && fx <= this.cols - 1 && fy <= this.rows - 1)) return undefined;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, this.cols - 1);
    const y1 = Math.min(y0 + 1, this.rows - 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const v = (x: number, y: number) => this.values[y * this.cols + x];
    const q00 = v(x0, y0);
    const q10 = v(x1, y0);
    const q01 = v(x0, y1);
    const q11 = v(x1, y1);
    // Any missing corner means no elevation here: let the caller fall back to mapped features.
    if (!Number.isFinite(q00) || !Number.isFinite(q10) || !Number.isFinite(q01) || !Number.isFinite(q11)) return undefined;
    const a = q00 * (1 - tx) + q10 * tx;
    const b = q01 * (1 - tx) + q11 * tx;
    const r = a * (1 - ty) + b * ty;
    return Number.isFinite(r) ? r : undefined;
  }
}

export interface SlopeInfo {
  /** Direction water (and cool, sinking air) would flow. */
  downslopeBearingDeg: number;
  slopePct: number;
  source: 'elevation' | 'features';
}

/** Slope from the elevation model using central differences over `stepM`. */
export function slopeFromTerrain(t: TerrainModel, p: Vec, stepM = 30): SlopeInfo | null {
  const e = t.elevationAt({ x: p.x + stepM, y: p.y });
  const w = t.elevationAt({ x: p.x - stepM, y: p.y });
  const n = t.elevationAt({ x: p.x, y: p.y + stepM });
  const s = t.elevationAt({ x: p.x, y: p.y - stepM });
  if (e === undefined || w === undefined || n === undefined || s === undefined) return null;
  const dzdx = (e - w) / (2 * stepM);
  const dzdy = (n - s) / (2 * stepM);
  const grad = Math.hypot(dzdx, dzdy);
  if (grad < 1e-6) return { downslopeBearingDeg: 0, slopePct: 0, source: 'elevation' };
  return { downslopeBearingDeg: bearingTo({ x: 0, y: 0 }, { x: -dzdx, y: -dzdy }), slopePct: grad * 100, source: 'elevation' };
}

/**
 * Fallback when no elevation is available: infer slope direction from mapped
 * ridges (uphill) and draws/creeks (downhill) within ~150 m.
 */
export function slopeFromFeatures(features: MapFeature[], p: Vec): SlopeInfo | null {
  let best: { bearing: number; d: number } | null = null;
  for (const f of features) {
    if (f.status !== 'active') continue;
    const downhill = f.type === 'draw' || f.type === 'creek' || f.type === 'creek_crossing';
    const uphill = f.type === 'ridge';
    if (!downhill && !uphill) continue;
    const d = pointGeometryDistance(p, f.geometry);
    if (d < 15 || d > 150) continue;
    const target = f.geometry.points.length === 1 ? f.geometry.points[0] : projectOntoPolyline(p, f.geometry.points).point;
    const toward = bearingTo(p, target);
    const bearing = downhill ? toward : (toward + 180) % 360;
    if (!best || d < best.d) best = { bearing, d };
  }
  // Without elevation we only know the direction; assume a modest 8% slope.
  return best ? { downslopeBearingDeg: best.bearing, slopePct: 8, source: 'features' } : null;
}

export function slopeAt(p: Vec, features: MapFeature[], terrain?: TerrainModel): SlopeInfo | null {
  return (terrain && slopeFromTerrain(terrain, p)) || slopeFromFeatures(features, p);
}
