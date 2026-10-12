import type { AccessConstraint, HabitatSummary, HuntWindow, MapFeature, Property, Route, RouteSegment, Status, Vec } from '../models.ts';
import {
  angleDiff,
  bearingTo,
  boundsOf,
  dist,
  downwindBearing,
  lerp,
  pointGeometryDistance,
  pointInPolygon,
  pointPolylineDistance,
  polylineLength,
  projectOntoPolyline,
  simplify,
} from '../geo/geometry.ts';
import { distanceToArea, edgePointToward } from '../inference/habitat.ts';
import { effectiveSetback } from './candidates.ts';

/**
 * Entry and exit routing on a cost grid (A*).
 *
 * Where deer are matters more than distance walked:
 *   AM entry  (dark): deer on food / heading to bed → stay off fields and active travel.
 *   AM exit   (mid-morning): deer bedded → stay wide of bedding and keep scent off it.
 *   PM entry  (afternoon): deer bedded → same as AM exit, and don't cross open fields in daylight.
 *   PM exit   (after dark): deer on food → never walk out across the field they're feeding in.
 * Exit routes are pushed off the entry path so the two stay separate.
 */

export type WalkKind = 'entry' | 'exit';

interface DeerState {
  bedded: number; // weight of bedding occupancy
  onFood: number; // weight of food occupancy
  moving: number; // weight of corridor activity
  daylight: boolean;
}

export function deerStateFor(window: HuntWindow, kind: WalkKind): DeerState {
  if (window === 'AM' && kind === 'entry') return { bedded: 0.4, onFood: 1, moving: 1, daylight: false };
  if (window === 'AM' && kind === 'exit') return { bedded: 1, onFood: 0.1, moving: 0.3, daylight: true };
  if (window === 'PM' && kind === 'entry') return { bedded: 1, onFood: 0.1, moving: 0.3, daylight: true };
  return { bedded: 0.4, onFood: 1, moving: 1, daylight: false };
}

export interface RouteContext {
  property: Property;
  habitat: HabitatSummary;
  setbackM: number;
  windFromDeg: number;
  windSpeedMph: number;
  window: HuntWindow;
}

export interface CostGrid {
  minX: number;
  minY: number;
  cell: number;
  cols: number;
  rows: number;
  /** Per-meter traversal multiplier; Infinity = impassable. */
  cost: Float64Array;
  kind: WalkKind;
}

const COVER_TYPES = new Set(['creek', 'draw', 'road', 'edge']);
const WALK_PLUME_HALF_DEG = 30;
const WALK_PLUME_LEN_M = 200;

/** Fast circle-vs-plume test: is the area within the walking scent plume from p? */
function scentReaches(p: Vec, downwind: number, half: number, area: { center: Vec; radiusM: number }, maxLen: number): boolean {
  const d = dist(p, area.center);
  if (d - area.radiusM > maxLen) return false;
  if (d <= area.radiusM) return true;
  const widen = Math.asin(Math.min(1, area.radiusM / d)) * (180 / Math.PI);
  return angleDiff(bearingTo(p, area.center), downwind) <= half + widen;
}

function blockedByConstraint(p: Vec, constraints: AccessConstraint[]): boolean {
  return constraints.some((c) => c.kind === 'no_access_zone' && c.geometry.kind === 'polygon' && pointInPolygon(p, c.geometry.points));
}

export function buildCostGrid(ctx: RouteContext, kind: WalkKind, extraPoints: Vec[] = []): CostGrid {
  const { property, habitat } = ctx;
  const pts: Vec[] = [...extraPoints, ...(property.boundary ?? [])];
  for (const f of property.features) if (f.status === 'active') pts.push(...f.geometry.points);
  for (const s of property.stands) pts.push(s.position);
  if (pts.length === 0) pts.push({ x: 0, y: 0 });
  const b = boundsOf(pts, 150);
  const maxDim = Math.max(b.maxX - b.minX, b.maxY - b.minY);
  const cell = Math.max(15, maxDim / 140);
  const cols = Math.ceil((b.maxX - b.minX) / cell) + 1;
  const rows = Math.ceil((b.maxY - b.minY) / cell) + 1;
  const cost = new Float64Array(cols * rows);
  const state = deerStateFor(ctx.window, kind);
  const downwind = downwindBearing(ctx.windFromDeg);
  const half = ctx.windSpeedMph < 6 ? 90 : WALK_PLUME_HALF_DEG;
  const active = property.features.filter((f) => f.status === 'active');
  const water = active.filter((f) => f.type === 'water' && f.geometry.kind === 'polygon');
  const houses = active.filter((f) => f.type === 'house');
  const cover = active.filter((f) => COVER_TYPES.has(f.type));
  const openAg = active.filter((f) => (f.type === 'ag_field' || f.type === 'food_plot') && f.geometry.kind === 'polygon');
  const hasBoundary = (property.boundary?.length ?? 0) >= 3;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const p = { x: b.minX + c * cell, y: b.minY + r * cell };
      let k = 1;
      if (hasBoundary && !pointInPolygon(p, property.boundary as Vec[])) k = Infinity;
      else if (water.some((w) => pointInPolygon(p, w.geometry.points))) k = Infinity;
      else if (houses.some((h) => pointGeometryDistance(p, h.geometry) < 50)) k = Infinity;
      else if (blockedByConstraint(p, property.accessConstraints)) k = Infinity;
      if (k === Infinity) {
        cost[r * cols + c] = Infinity;
        continue;
      }
      for (const bed of habitat.bedding) {
        const d = distanceToArea(p, bed);
        const sb = effectiveSetback(bed, ctx.setbackM);
        if (d < sb) k += 50 * bed.probability * Math.max(0.4, state.bedded);
        else if (d < sb * 1.5) k += 8 * bed.probability * state.bedded;
        if (scentReaches(p, downwind, half, bed, WALK_PLUME_LEN_M)) k += 15 * bed.probability * state.bedded;
      }
      for (const food of habitat.food) {
        const d = distanceToArea(p, food);
        if (d === 0) k += 40 * food.probability * state.onFood;
        if (scentReaches(p, downwind, half, food, WALK_PLUME_LEN_M * 0.75)) k += 8 * food.probability * state.onFood;
      }
      for (const cor of habitat.corridors) {
        if (projectOntoPolyline(p, cor.points).distance < 30) k += 6 * cor.strength * state.moving;
      }
      if (state.daylight && openAg.some((a) => pointInPolygon(p, a.geometry.points))) k += 3;
      if (cover.some((f) => pointGeometryDistance(p, f.geometry) < 25)) k *= 0.7;
      cost[r * cols + c] = Math.max(0.5, k);
    }
  }
  return { minX: b.minX, minY: b.minY, cell, cols, rows, cost, kind };
}

// ---------------------------------------------------------------------------
// A*
// ---------------------------------------------------------------------------

class MinHeap {
  private items: Array<[number, number]> = [];
  push(priority: number, value: number): void {
    const a = this.items;
    a.push([priority, value]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): number | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0][1];
    const last = a.pop() as [number, number];
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  get size(): number {
    return this.items.length;
  }
}

function cellOf(g: CostGrid, p: Vec): number {
  const c = Math.max(0, Math.min(g.cols - 1, Math.round((p.x - g.minX) / g.cell)));
  const r = Math.max(0, Math.min(g.rows - 1, Math.round((p.y - g.minY) / g.cell)));
  return r * g.cols + c;
}

const cellCenter = (g: CostGrid, i: number): Vec => ({ x: g.minX + (i % g.cols) * g.cell, y: g.minY + Math.floor(i / g.cols) * g.cell });

const NEIGHBORS: Array<[number, number, number]> = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

export function astar(g: CostGrid, start: Vec, goal: Vec, penalty?: Float64Array): { path: Vec[]; cost: number } | null {
  const s = cellOf(g, start);
  const t = cellOf(g, goal);
  const n = g.cols * g.rows;
  const gScore = new Float64Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const goalPt = cellCenter(g, t);
  const h = (i: number) => 0.5 * dist(cellCenter(g, i), goalPt);
  // Start and goal cells are always walkable (the stand and the truck are where they are).
  const costAt = (i: number) => {
    const base = i === s || i === t ? Math.min(g.cost[i], 5) : g.cost[i];
    return base + (penalty ? penalty[i] : 0);
  };
  const heap = new MinHeap();
  gScore[s] = 0;
  heap.push(h(s), s);
  while (heap.size) {
    const cur = heap.pop() as number;
    if (cur === t) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const cx = cur % g.cols;
    const cy = Math.floor(cur / g.cols);
    for (const [dx, dy, stepK] of NEIGHBORS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= g.cols || ny >= g.rows) continue;
      const ni = ny * g.cols + nx;
      const k = costAt(ni);
      if (!Number.isFinite(k) || closed[ni]) continue;
      const tentative = gScore[cur] + stepK * g.cell * 0.5 * (costAt(cur) + k);
      if (tentative < gScore[ni]) {
        gScore[ni] = tentative;
        came[ni] = cur;
        heap.push(tentative + h(ni), ni);
      }
    }
  }
  if (!Number.isFinite(gScore[t])) return null;
  const cells: number[] = [];
  for (let i = t; i !== -1; i = came[i]) cells.push(i);
  cells.reverse();
  const path = cells.map((i) => cellCenter(g, i));
  path[0] = start;
  path[path.length - 1] = goal;
  return { path, cost: gScore[t] };
}

// ---------------------------------------------------------------------------
// Access points & route assembly
// ---------------------------------------------------------------------------

export interface AccessStart {
  position: Vec;
  label: string;
  inferred: boolean;
}

export function accessStarts(property: Property, stand: Vec): AccessStart[] {
  const active = property.features.filter((f) => f.status === 'active');
  const marked = active.filter((f) => f.type === 'access_point');
  if (marked.length) return marked.map((f) => ({ position: f.geometry.points[0], label: f.label ?? 'Access point', inferred: false }));
  const roads = active.filter((f) => f.type === 'road');
  if (roads.length) {
    let best: AccessStart | null = null;
    for (const r of roads) {
      const p = r.geometry.points.length === 1 ? r.geometry.points[0] : projectOntoPolyline(stand, r.geometry.points).point;
      if (!best || dist(p, stand) < dist(best.position, stand)) best = { position: p, label: r.label ?? 'Nearest road', inferred: true };
    }
    return best ? [best] : [];
  }
  if (property.boundary && property.boundary.length >= 3) {
    const p = edgePointToward({ center: stand, polygon: property.boundary, radiusM: 0 }, stand);
    return [{ position: p, label: 'Property line', inferred: true }];
  }
  return [];
}

export interface SegmentJudge {
  (a: Vec, b: Vec, stand?: Vec): { status: Status; reason: string };
}

/** The last stretch at the tree is unavoidable; field-edge stands shouldn't flag their own base. */
const STAND_APRON_M = 25;
/** Walking the tree line along a field isn't "in" the field. */
const FIELD_EDGE_TOLERANCE_M = 10;

/** How far inside an area a point is (0 when outside). */
function insideDepth(p: Vec, area: { center: Vec; polygon?: Vec[]; radiusM: number }): number {
  if (area.polygon && area.polygon.length >= 3) return pointInPolygon(p, area.polygon) ? pointPolylineDistance(p, area.polygon, true) : 0;
  return Math.max(0, area.radiusM - dist(p, area.center));
}

export function makeSegmentJudge(ctx: RouteContext, kind: WalkKind): SegmentJudge {
  const state = deerStateFor(ctx.window, kind);
  const downwind = downwindBearing(ctx.windFromDeg);
  const half = ctx.windSpeedMph < 6 ? 90 : WALK_PLUME_HALF_DEG;
  return (a, b, stand) => {
    const samples = [a, lerp(a, b, 0.5), b];
    let status: Status = 'safe';
    let reason = 'Clear of bedding, food and travel.';
    const raise = (s: Status, r: string) => {
      const rank = { safe: 0, caution: 1, avoid: 2 } as const;
      if (rank[s] > rank[status]) {
        status = s;
        reason = r;
      }
    };
    for (const p of samples) {
      for (const bed of ctx.habitat.bedding) {
        if (bed.probability < 0.4) continue;
        const d = distanceToArea(p, bed);
        const sb = effectiveSetback(bed, ctx.setbackM);
        if (d < sb) raise('avoid', `Within ${Math.round(d)} m of probable bedding.`);
        else if (d < sb * 1.5) raise('caution', `Passes ${Math.round(d)} m from bedding.`);
        if (state.bedded >= 0.5 && scentReaches(p, downwind, half, bed, 150)) raise('avoid', 'Wind carries your scent into bedding here.');
        else if (state.bedded >= 0.5 && scentReaches(p, downwind, half, bed, WALK_PLUME_LEN_M)) raise('caution', 'Scent drifts toward bedding here.');
      }
      const atStand = stand !== undefined && dist(p, stand) < STAND_APRON_M;
      for (const food of ctx.habitat.food) {
        if (food.probability < 0.35 || atStand) continue;
        const inside = insideDepth(p, food) > FIELD_EDGE_TOLERANCE_M;
        if (state.onFood >= 0.5 && inside) raise('avoid', 'Crosses food where deer are likely feeding.');
        else if (state.onFood >= 0.5 && distanceToArea(p, food) < FIELD_EDGE_TOLERANCE_M) raise('caution', 'Walks the edge of a field deer may be feeding in.');
        else if (state.daylight && inside) raise('caution', 'Open ground in daylight.');
      }
      if (state.moving >= 0.5 && !atStand) {
        for (const cor of ctx.habitat.corridors) {
          if (cor.strength >= 0.2 && projectOntoPolyline(p, cor.points).distance < 25) raise('caution', 'Crosses an active travel route.');
        }
      }
    }
    return { status, reason };
  };
}

function assembleRoute(kind: WalkKind, start: AccessStart, path: Vec[], judge: SegmentJudge, ctx: RouteContext, cell: number): Route {
  const points = simplify(path, cell * 0.6);
  // Re-split long straight runs so the color coding stays meaningful.
  const dense: Vec[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const n = Math.max(1, Math.ceil(dist(points[i - 1], points[i]) / 60));
    for (let k = 1; k <= n; k++) dense.push(lerp(points[i - 1], points[i], k / n));
  }
  const stand = kind === 'entry' ? dense[dense.length - 1] : dense[0];
  // Judge each short piece, then merge consecutive pieces with the same verdict.
  const segments: RouteSegment[] = [];
  for (let i = 1; i < dense.length; i++) {
    const j = judge(dense[i - 1], dense[i], stand);
    const last = segments[segments.length - 1];
    if (last && last.status === j.status && last.reason === j.reason) last.points.push(dense[i]);
    else segments.push({ points: [dense[i - 1], dense[i]], status: j.status, reason: j.reason });
  }
  const minBed = ctx.habitat.bedding.reduce((m, b) => Math.min(m, ...dense.map((p) => distanceToArea(p, b))), Infinity);
  const worst: Status = segments.some((s) => s.status === 'avoid') ? 'avoid' : segments.some((s) => s.status === 'caution') ? 'caution' : 'safe';
  const notes: string[] = [];
  if (start.inferred) notes.push(`Starts at ${start.label.toLowerCase()} (inferred). Mark your parking or access point for better routes.`);
  if (kind === 'exit' && ctx.window === 'PM') notes.push('Leave after dark without a headlamp sweep across the field. Use a red light and go slow.');
  if (kind === 'entry' && ctx.window === 'AM') notes.push('Be in the stand 30+ minutes before legal light.');
  if (kind === 'exit' && ctx.window === 'AM') notes.push('Wait for a lull in movement, then climb down quietly.');
  return {
    kind,
    startLabel: start.label,
    points: dense,
    segments,
    lengthM: polylineLength(dense),
    minDistToBeddingM: Number.isFinite(minBed) ? minBed : -1,
    notes,
    worstStatus: worst,
  };
}

export interface RoutePair {
  entry: Route | null;
  exit: Route | null;
  /** No access point, road or boundary to start from. */
  noAccess: boolean;
  /** Start points exist, but no legal walking route reaches the stand (water, no-access zone, off-property). */
  unreachable: boolean;
}

export interface RoutePlanner {
  plan(stand: Vec): RoutePair;
}

/** Build both cost grids once per plan; route any number of stands against them. */
export function createRoutePlanner(ctx: RouteContext, extraPoints: Vec[] = []): RoutePlanner {
  const entryGrid = buildCostGrid(ctx, 'entry', extraPoints);
  const exitGrid = buildCostGrid(ctx, 'exit', extraPoints);
  const entryJudge = makeSegmentJudge(ctx, 'entry');
  const exitJudge = makeSegmentJudge(ctx, 'exit');

  return {
    plan(stand: Vec): RoutePair {
      const starts = accessStarts(ctx.property, stand);
      if (starts.length === 0) return { entry: null, exit: null, noAccess: true, unreachable: false };

      let bestEntry: { start: AccessStart; path: Vec[]; cost: number } | null = null;
      for (const st of starts) {
        const r = astar(entryGrid, st.position, stand);
        if (r && (!bestEntry || r.cost < bestEntry.cost)) bestEntry = { start: st, path: r.path, cost: r.cost };
      }
      if (!bestEntry) return { entry: null, exit: null, noAccess: false, unreachable: true };

      // Penalize re-using the entry path on the way out (outside the stand and truck zones).
      const penalty = new Float64Array(exitGrid.cols * exitGrid.rows);
      for (const p of bestEntry.path) {
        if (dist(p, stand) < 60 || dist(p, bestEntry.start.position) < 60) continue;
        const ci = cellOf(exitGrid, p);
        const cx = ci % exitGrid.cols;
        const cy = Math.floor(ci / exitGrid.cols);
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const x = cx + dx;
            const y = cy + dy;
            if (x >= 0 && y >= 0 && x < exitGrid.cols && y < exitGrid.rows) penalty[y * exitGrid.cols + x] = 4;
          }
      }
      let bestExit: { start: AccessStart; path: Vec[]; cost: number } | null = null;
      for (const st of starts) {
        const r = astar(exitGrid, stand, st.position, penalty);
        if (r && (!bestExit || r.cost < bestExit.cost)) bestExit = { start: st, path: r.path, cost: r.cost };
      }

      const entry = assembleRoute('entry', bestEntry.start, bestEntry.path, entryJudge, ctx, entryGrid.cell);
      const exit = bestExit ? assembleRoute('exit', bestExit.start, bestExit.path, exitJudge, ctx, exitGrid.cell) : null;
      if (entry && exit) {
        const shared = exit.points.filter((p) => dist(p, stand) > 60 && entry.points.some((q) => dist(p, q) < entryGrid.cell)).length;
        const overlap = exit.points.length ? shared / exit.points.length : 0;
        entry.overlapWithOther = overlap;
        exit.overlapWithOther = overlap;
        if (overlap > 0.6) exit.notes.push('Terrain forces the exit back along your entry path. Go extra slow and quiet.');
      }
      return { entry, exit, noAccess: false, unreachable: false };
    },
  };
}

export function featuresForRouting(features: MapFeature[]): MapFeature[] {
  return features.filter((f) => f.status === 'active');
}
