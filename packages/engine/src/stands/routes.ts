import type { HabitatSummary, HuntWindow, MapFeature, Property, Route, RouteSegment, Status, Vec } from '../models.ts';
import {
  angleDiff,
  bearingTo,
  boundsOf,
  dist,
  downwindBearing,
  geometryCentroid,
  lerp,
  pointAlong,
  pointGeometryDistance,
  pointInPolygon,
  pointPolylineDistance,
  pointSegmentDistance,
  polylineLength,
  projectOntoPolyline,
  sectorPolygon,
  segmentsIntersect,
} from '../geo/geometry.ts';
import { BEDDING_MIN_PROB, FOOD_SENSITIVE_MIN, distanceToArea, edgePointToward } from '../inference/habitat.ts';
import { effectiveSetback, noAccessZones } from './candidates.ts';

/**
 * Entry and exit routing on a cost grid (A*).
 *
 * Where deer are matters more than distance walked:
 *   AM entry  (dark): deer on food / heading to bed → stay off fields and active travel.
 *   AM exit   (mid-morning): deer bedded → stay wide of bedding and keep scent off it.
 *   PM entry  (afternoon): deer bedded → same as AM exit, and don't cross open fields in daylight.
 *   PM exit   (after dark): deer on food → never walk out across the field they're feeding in.
 * Exit routes are pushed off the entry path so the two stay separate.
 *
 * Hunter constraints are hard: no route enters a no-access zone or water, crosses a
 * neighbor line, or skips a must-use gate. Only those HARD blocks make a stand unreachable.
 * Off-property ground and house buffers are SOFT blocks: free to use right by the truck or the
 * stand (parking at the farmhouse, on the road shoulder), and otherwise crossed only when there is
 * no other way in, at a steep cost, with those stretches flagged red ("get permission or mark a
 * different access point"). A parking spot a long way outside the line therefore gives a
 * caution, never a false "no legal route".
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
  /** Why a cell is impassable: BLOCK_OPEN, BLOCK_SOFT (house buffer, off-property) or BLOCK_HARD. */
  block: Uint8Array;
  kind: WalkKind;
}

export const BLOCK_OPEN = 0;
/** Within 50 m of a house or outside the property line: walkable only near the truck or the stand. */
export const BLOCK_SOFT = 1;
/** Water, a no-access zone or a neighbor line: never walked. */
export const BLOCK_HARD = 2;

/** How far from the truck or the stand a route may use soft-blocked ground to get out. */
const ESCAPE_M = 100;
/** Per-meter cost of that ground: used only when there is no other way out. */
const ESCAPE_COST = 25;
/**
 * Per-meter cost of soft-blocked ground anywhere on the map, in the second routing pass that runs
 * only when no walk exists without it. Steeper than any bedding intrusion, so the route crosses as
 * little of it as possible.
 */
const SOFT_CROSSING_COST = 60;
/** A scent problem that starts this close to the access point (by piece midpoint) is "at the parking spot". */
export const ACCESS_ZONE_M = 60;
/** ...and it stays "the parking spot's" while it runs unbroken out to this far from the access point. */
export const ACCESS_RUN_M = 200;

/** The scent verdicts of the route judge. A scent problem at the access point is the same on every stand. */
export const SCENT_REASONS = {
  foodAvoid: 'Wind carries your scent onto feeding deer.',
  foodCaution: 'Scent drifts toward the food deer may be on.',
  bedAvoid: 'Wind carries your scent into bedding here.',
  bedCaution: 'Scent may reach bedding here.',
  bedDrift: 'Scent drifts toward bedding here.',
} as const;
const SCENT_REASON_SET: ReadonlySet<string> = new Set(Object.values(SCENT_REASONS));
const FOOD_SCENT_REASONS: ReadonlySet<string> = new Set([SCENT_REASONS.foodAvoid, SCENT_REASONS.foodCaution]);

export const OFF_PROPERTY_REASON = 'Off your property: get permission or mark a different access point.';
export const HOUSE_BUFFER_REASON = 'Within 50 m of a house: get permission or mark a different access point.';

const COVER_TYPES = new Set(['creek', 'draw', 'road', 'edge']);
const WALK_PLUME_HALF_DEG = 30;
const WALK_PLUME_LEN_M = 200;
/** Walking scent this close to feeding deer is a red segment; out to the food plume length it's caution. */
const FOOD_SCENT_AVOID_M = 100;

/** Fast circle-vs-plume test: is the area within the walking scent plume from p? */
function scentReaches(p: Vec, downwind: number, half: number, area: { center: Vec; radiusM: number }, maxLen: number): boolean {
  const d = dist(p, area.center);
  if (d - area.radiusM > maxLen) return false;
  if (d <= area.radiusM) return true;
  const widen = Math.asin(Math.min(1, area.radiusM / d)) * (180 / Math.PI);
  return angleDiff(bearingTo(p, area.center), downwind) <= half + widen;
}

/** Do two polygons overlap (a vertex inside the other, or crossing edges)? Stops at the first hit. */
function polygonsOverlap(a: Vec[], b: Vec[]): boolean {
  if (a.some((p) => pointInPolygon(p, b)) || b.some((p) => pointInPolygon(p, a))) return true;
  for (let i = 0; i < a.length; i++) {
    const a1 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) if (segmentsIntersect(a[i], a1, b[j], b[(j + 1) % b.length])) return true;
  }
  return false;
}

/**
 * Plume test against an area's real outline when it has one. A circle stand-in would say a
 * hunter walking along a long field puts scent on it in any wind.
 */
function scentReachesArea(p: Vec, downwind: number, half: number, area: { center: Vec; polygon?: Vec[]; radiusM: number }, maxLen: number): boolean {
  if (!area.polygon || area.polygon.length < 3) return scentReaches(p, downwind, half, area, maxLen);
  if (pointInPolygon(p, area.polygon)) return true;
  if (pointPolylineDistance(p, area.polygon, true) > maxLen) return false;
  return polygonsOverlap(sectorPolygon(p, downwind, half, maxLen), area.polygon);
}

/** Points every `step` meters around a polygon outline (for fast plume tests on the cost grid). */
function outlineSamples(poly: Vec[], step: number): Vec[] {
  const ring = [...poly, poly[0]];
  const L = polylineLength(ring);
  const out: Vec[] = [];
  for (let d = 0; d < L; d += step) out.push(pointAlong(ring, d).point);
  return out;
}

/**
 * Cost-grid version of scentReachesArea for one area and one plume (downwind bearing, half-angle):
 * how far from p the plume first touches the area (0 inside it, Infinity if it never does within
 * maxLen). Polygons are tested against outline samples a cell apart, plenty for a 30°+ cone.
 */
function makeAreaPlumeReach(area: { center: Vec; polygon?: Vec[]; radiusM: number }, step: number, downwind: number, half: number, maxLen: number): (p: Vec) => number {
  if (!area.polygon || area.polygon.length < 3) {
    return (p) => {
      if (!scentReaches(p, downwind, half, area, maxLen)) return Infinity;
      return Math.max(0, dist(p, area.center) - area.radiusM);
    };
  }
  const poly = area.polygon;
  const samples = outlineSamples(poly, step);
  const box = boundsOf(poly, maxLen);
  const dw = { x: Math.sin((downwind * Math.PI) / 180), y: Math.cos((downwind * Math.PI) / 180) };
  const cosHalf = Math.cos((Math.min(180, half) * Math.PI) / 180);
  const max2 = maxLen * maxLen;
  return (p) => {
    if (p.x < box.minX || p.x > box.maxX || p.y < box.minY || p.y > box.maxY) return Infinity;
    if (pointInPolygon(p, poly)) return 0;
    let best = Infinity;
    for (const q of samples) {
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > max2 || d2 >= best * best) continue;
      const d = Math.sqrt(d2);
      if (dx * dw.x + dy * dw.y >= d * cosHalf) best = d;
    }
    return best;
  };
}

/** Hunter access constraints and water, in the shapes the router needs. */
interface Barriers {
  /** No-access zones (polygons): never entered. */
  zones: Vec[][];
  /** Water polygons: never entered. */
  water: Vec[][];
  /** Neighbor lines and no-access zones drawn as lines: never crossed. */
  lines: Vec[][];
  /** Must-use gates: every walk passes through one of them. */
  gates: AccessStart[];
  /** Every edge a straightened route segment must not cross (zones, water, lines, property line). */
  edges: Array<[Vec, Vec]>;
}

function closedEdges(poly: Vec[]): Array<[Vec, Vec]> {
  return poly.map((p, i) => [p, poly[(i + 1) % poly.length]] as [Vec, Vec]);
}

function openEdges(line: Vec[]): Array<[Vec, Vec]> {
  return line.slice(1).map((p, i) => [line[i], p] as [Vec, Vec]);
}

/** Must-use gates the hunter marked: every walk on the property goes through one of them. */
function gateStarts(property: Property): AccessStart[] {
  return (property.accessConstraints ?? [])
    .filter((c) => c.kind === 'must_use_gate' && c.geometry?.points?.length)
    .map((c) => ({ position: c.geometry.kind === 'point' ? c.geometry.points[0] : geometryCentroid(c.geometry), label: c.note?.trim() || 'Gate', inferred: false }));
}

function barriersFor(property: Property): Barriers {
  const zones = noAccessZones(property);
  const lines: Vec[][] = [];
  for (const c of property.accessConstraints ?? []) {
    const g = c.geometry;
    if (!g?.points || g.points.length < 2) continue;
    if (c.kind === 'no_access_zone' && g.kind !== 'polygon') lines.push(g.points);
    else if (c.kind === 'neighbor_line') lines.push(g.kind === 'polygon' && g.points.length >= 3 ? [...g.points, g.points[0]] : g.points);
  }
  const gates = gateStarts(property);
  const water = property.features.filter((f) => f.status === 'active' && f.type === 'water' && f.geometry.kind === 'polygon' && f.geometry.points.length >= 3).map((f) => f.geometry.points);
  const edges: Array<[Vec, Vec]> = [...zones.flatMap(closedEdges), ...water.flatMap(closedEdges), ...lines.flatMap(openEdges)];
  if (property.boundary && property.boundary.length >= 3) edges.push(...closedEdges(property.boundary));
  return { zones, water, lines, gates, edges };
}

export function buildCostGrid(ctx: RouteContext, kind: WalkKind, extraPoints: Vec[] = []): CostGrid {
  const { property, habitat } = ctx;
  const barriers = barriersFor(property);
  const pts: Vec[] = [...extraPoints, ...(property.boundary ?? [])];
  for (const f of property.features) if (f.status === 'active') pts.push(...f.geometry.points);
  for (const s of property.stands) pts.push(s.position);
  for (const g of barriers.gates) pts.push(g.position);
  if (pts.length === 0) pts.push({ x: 0, y: 0 });
  const b = boundsOf(pts, 150);
  const maxDim = Math.max(b.maxX - b.minX, b.maxY - b.minY);
  const cell = Math.max(15, maxDim / 140);
  const cols = Math.ceil((b.maxX - b.minX) / cell) + 1;
  const rows = Math.ceil((b.maxY - b.minY) / cell) + 1;
  const cost = new Float64Array(cols * rows);
  const block = new Uint8Array(cols * rows);
  const state = deerStateFor(ctx.window, kind);
  const downwind = downwindBearing(ctx.windFromDeg);
  const half = ctx.windSpeedMph < 6 ? 90 : WALK_PLUME_HALF_DEG;
  const active = property.features.filter((f) => f.status === 'active');
  const houses = active.filter((f) => f.type === 'house');
  const cover = active.filter((f) => COVER_TYPES.has(f.type));
  const openAg = active.filter((f) => (f.type === 'ag_field' || f.type === 'food_plot') && f.geometry.kind === 'polygon');
  const hasBoundary = (property.boundary?.length ?? 0) >= 3;
  // Hunter constraints are rasterized conservatively: a cell within half a cell of a zone's
  // edge or a neighbor line is blocked, so a thin zone or a line can't slip between cell centers.
  const reach = cell / 2;
  // Food scent follows the field's real outline, like the route judge, so the router steers
  // around what the judge would color red instead of only paying a flat toll near any field.
  const foodPlume = state.onFood > 0 ? habitat.food.map((f) => makeAreaPlumeReach(f, cell, downwind, half, WALK_PLUME_LEN_M * 0.75)) : [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const p = { x: b.minX + c * cell, y: b.minY + r * cell };
      let blocked: number = BLOCK_OPEN;
      if (
        barriers.water.some((w) => pointInPolygon(p, w)) ||
        barriers.zones.some((z) => pointInPolygon(p, z) || pointPolylineDistance(p, z, true) <= reach) ||
        barriers.lines.some((l) => pointPolylineDistance(p, l) <= reach)
      )
        blocked = BLOCK_HARD;
      else if ((hasBoundary && !pointInPolygon(p, property.boundary as Vec[])) || houses.some((h) => pointGeometryDistance(p, h.geometry) < 50)) blocked = BLOCK_SOFT;
      if (blocked !== BLOCK_OPEN) {
        cost[r * cols + c] = Infinity;
        block[r * cols + c] = blocked;
        continue;
      }
      let k = 1;
      for (const bed of habitat.bedding) {
        const d = distanceToArea(p, bed);
        const sb = effectiveSetback(bed, ctx.setbackM);
        if (d < sb) k += 50 * bed.probability * Math.max(0.4, state.bedded);
        else if (d < sb * 1.5) k += 8 * bed.probability * state.bedded;
        if (scentReaches(p, downwind, half, bed, WALK_PLUME_LEN_M)) k += 15 * bed.probability * state.bedded;
      }
      habitat.food.forEach((food, i) => {
        const d = distanceToArea(p, food);
        if (d === 0) k += 40 * food.probability * state.onFood;
        const plume = foodPlume[i]?.(p) ?? Infinity;
        if (plume <= WALK_PLUME_LEN_M * 0.75) k += 8 * food.probability * state.onFood;
        if (plume <= FOOD_SCENT_AVOID_M) k += 12 * food.probability * state.onFood;
      });
      for (const cor of habitat.corridors) {
        if (projectOntoPolyline(p, cor.points).distance < 30) k += 6 * cor.strength * state.moving;
      }
      if (state.daylight && openAg.some((a) => pointInPolygon(p, a.geometry.points))) k += 3;
      if (cover.some((f) => pointGeometryDistance(p, f.geometry) < 25)) k *= 0.7;
      cost[r * cols + c] = Math.max(0.5, k);
    }
  }
  return { minX: b.minX, minY: b.minY, cell, cols, rows, cost, block, kind };
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

/**
 * Cheapest walk from start to goal on the grid.
 *
 * Only HARD blocks (water, no-access zones, neighbor lines) are ever impassable. Soft ground
 * (off the property line, within 50 m of a house) is free to leave or reach within ESCAPE_M of the
 * truck or the stand and otherwise blocked, unless `relaxSoft` is set: then it is walkable
 * everywhere at SOFT_CROSSING_COST per meter, so a stand is never "unreachable" just because the
 * truck is parked a long way outside the line or a farmhouse sits in the only gap.
 */
export function astar(g: CostGrid, start: Vec, goal: Vec, penalty?: Float64Array, relaxSoft = false): { path: Vec[]; cost: number } | null {
  const s = cellOf(g, start);
  const t = cellOf(g, goal);
  const n = g.cols * g.rows;
  const gScore = new Float64Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const goalPt = cellCenter(g, t);
  const h = (i: number) => 0.5 * dist(cellCenter(g, i), goalPt);
  const walk = new Float64Array(n);
  for (let i = 0; i < n; i++) walk[i] = g.cost[i] + (penalty ? penalty[i] : 0);
  if (relaxSoft) for (let i = 0; i < n; i++) if (g.block[i] === BLOCK_SOFT) walk[i] = SOFT_CROSSING_COST + (penalty ? penalty[i] : 0);
  // Parking at the farmhouse or on the road shoulder: let the walk get out (or in) there.
  const reach = Math.max(ESCAPE_M, 3 * g.cell) / g.cell;
  const r = Math.floor(reach);
  for (const e of [s, t]) {
    const ex = e % g.cols;
    const ey = Math.floor(e / g.cols);
    for (let y = Math.max(0, ey - r); y <= Math.min(g.rows - 1, ey + r); y++) {
      for (let x = Math.max(0, ex - r); x <= Math.min(g.cols - 1, ex + r); x++) {
        const i = y * g.cols + x;
        if (g.block[i] === BLOCK_SOFT && (x - ex) ** 2 + (y - ey) ** 2 <= reach * reach) walk[i] = ESCAPE_COST + (penalty ? penalty[i] : 0);
      }
    }
  }
  // Start and goal cells are always walkable (the stand and the truck are where they are). This
  // deliberately applies to hard-blocked cells too: a stand or an access point sits where the hunter
  // put it, and the grid is a cell wide, so a start or goal within about one cell of a fence, water
  // edge or zone can take its last hop across it (a straight run of at most one cell). The stand
  // inside a no-access zone is rejected before routing (RoutePlanner.plan), so a route never ends in
  // the zone's interior; only the cell-wide edge fuzz is tolerated here.
  walk[s] = Math.min(g.cost[s], 5) + (penalty ? penalty[s] : 0);
  walk[t] = Math.min(g.cost[t], 5) + (penalty ? penalty[t] : 0);
  const costAt = (i: number) => walk[i];
  const open = (i: number) => Number.isFinite(walk[i]);
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
      // Never squeeze diagonally between two blocked cells (a thin zone, a fence line, a corner).
      if (dx !== 0 && dy !== 0 && (!open(cy * g.cols + nx) || !open(ny * g.cols + cx))) continue;
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
  // No parking spot marked: a gate the hunter must use is where the walk begins.
  const gates = gateStarts(property);
  if (gates.length) return gates;
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
  // Before first light bucks are heading back to (or already in) their beds.
  const bucksReturning = ctx.window === 'AM' && kind === 'entry';
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
        if (bed.probability < BEDDING_MIN_PROB) continue;
        const d = distanceToArea(p, bed);
        const sb = effectiveSetback(bed, ctx.setbackM);
        if (d < sb) raise('avoid', `Within ${Math.round(d)} m of probable bedding.`);
        else if (d < sb * 1.5) raise('caution', `Passes ${Math.round(d)} m from bedding.`);
        if (scentReachesArea(p, downwind, half, bed, 150)) {
          // Bedded deer, or bucks returning before light: scent in the bed blows the sit.
          if (state.bedded >= 0.5 || (bucksReturning && bed.kind === 'buck')) raise('avoid', SCENT_REASONS.bedAvoid);
          else raise('caution', SCENT_REASONS.bedCaution);
        } else if (state.bedded >= 0.5 && scentReachesArea(p, downwind, half, bed, WALK_PLUME_LEN_M)) raise('caution', SCENT_REASONS.bedDrift);
      }
      const atStand = stand !== undefined && dist(p, stand) < STAND_APRON_M;
      for (const food of ctx.habitat.food) {
        if (food.probability < FOOD_SENSITIVE_MIN || atStand) continue;
        const inside = insideDepth(p, food) > FIELD_EDGE_TOLERANCE_M;
        if (state.onFood >= 0.5) {
          if (inside) raise('avoid', 'Crosses food where deer are likely feeding.');
          else if (distanceToArea(p, food) < FIELD_EDGE_TOLERANCE_M) raise('caution', 'Walks the edge of a field deer may be feeding in.');
          // In the dark deer are on the food: scent blowing onto it busts them as surely as walking it.
          if (scentReachesArea(p, downwind, half, food, FOOD_SCENT_AVOID_M)) raise('avoid', SCENT_REASONS.foodAvoid);
          else if (scentReachesArea(p, downwind, half, food, WALK_PLUME_LEN_M * 0.75)) raise('caution', SCENT_REASONS.foodCaution);
        } else if (state.daylight && inside) raise('caution', 'Open ground in daylight.');
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

/**
 * Douglas–Peucker that never straightens a run across a barrier: a simplified segment that
 * would cut a no-access zone, water, a neighbor line or the property line keeps its corners.
 */
function simplifyAround(points: Vec[], tolerance: number, edges: Array<[Vec, Vec]>): Vec[] {
  if (points.length <= 2) return points.slice();
  const a = points[0];
  const b = points[points.length - 1];
  let maxD = 0;
  let idx = Math.floor(points.length / 2);
  for (let i = 1; i < points.length - 1; i++) {
    const d = pointSegmentDistance(points[i], a, b);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD <= tolerance && !edges.some(([c, d]) => segmentsIntersect(a, b, c, d))) return [a, b];
  const left = simplifyAround(points.slice(0, idx + 1), tolerance, edges);
  const right = simplifyAround(points.slice(idx), tolerance, edges);
  return left.slice(0, -1).concat(right);
}

/** What soft-blocked ground a point is on, if any: off the drawn property line, or inside a house buffer. */
type SoftGround = NonNullable<RouteSegment['ground']>;
type SoftGroundAt = (p: Vec) => SoftGround | null;

function makeSoftGroundAt(property: Property): SoftGroundAt {
  const boundary = property.boundary && property.boundary.length >= 3 ? property.boundary : undefined;
  const houses = property.features.filter((f) => f.status === 'active' && f.type === 'house');
  return (p) => {
    if (boundary && !pointInPolygon(p, boundary)) return 'off_property';
    if (houses.some((h) => pointGeometryDistance(p, h.geometry) < 50)) return 'house_buffer';
    return null;
  };
}

function assembleRoute(kind: WalkKind, start: AccessStart, path: Vec[], judge: SegmentJudge, ctx: RouteContext, cell: number, barriers: Barriers, softAt: SoftGroundAt | null): Route {
  const points = simplifyAround(path, cell * 0.6, barriers.edges);
  // Re-split long straight runs so the color coding stays meaningful.
  const dense: Vec[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const n = Math.max(1, Math.ceil(dist(points[i - 1], points[i]) / 60));
    for (let k = 1; k <= n; k++) dense.push(lerp(points[i - 1], points[i], k / n));
  }
  const stand = kind === 'entry' ? dense[dense.length - 1] : dense[0];
  // Soft ground is only tolerated by the truck or at the stand; a walk that needs more of it than
  // that (the router's second pass) gets those stretches flagged red.
  const apronM = Math.max(ESCAPE_M, 3 * cell);
  const groundOf = (a: Vec, b: Vec): SoftGround | undefined => {
    if (!softAt) return undefined;
    let found: SoftGround | undefined;
    for (const p of [a, lerp(a, b, 0.5), b]) {
      if (dist(p, start.position) <= apronM || dist(p, stand) <= apronM) continue;
      const g = softAt(p);
      if (g === 'off_property') return g;
      if (g) found = g;
    }
    return found;
  };
  // Judge each short piece.
  const pieces = dense.slice(1).map((b, k) => {
    const a = dense[k];
    const ground = groundOf(a, b);
    const verdict = judge(a, b, stand);
    const j = ground ? { status: 'avoid' as Status, reason: ground === 'off_property' ? OFF_PROPERTY_REASON : HOUSE_BUFFER_REASON } : verdict;
    return { a, b, ground, j, atAccess: false };
  });
  // A scent problem that begins at the access point and runs on unbroken (the parking spot is upwind
  // of a field) is the same on every stand that starts there: mark it so the planner can report it
  // once instead of holding it against each stand.
  const fromAccess = kind === 'entry' ? pieces : [...pieces].reverse();
  let inRun = false;
  for (const piece of fromAccess) {
    const d = dist(lerp(piece.a, piece.b, 0.5), start.position);
    const scent = !piece.ground && piece.j.status !== 'safe' && SCENT_REASON_SET.has(piece.j.reason);
    if (!scent) {
      if (inRun || d >= ACCESS_ZONE_M) break;
      continue;
    }
    if (!inRun && d >= ACCESS_ZONE_M) break;
    if (d >= ACCESS_RUN_M) break;
    inRun = true;
    piece.atAccess = true;
  }
  // Merge consecutive pieces with the same verdict.
  const segments: RouteSegment[] = [];
  for (const { a, b, ground, j, atAccess } of pieces) {
    const last = segments[segments.length - 1];
    if (last && last.status === j.status && last.reason === j.reason && last.ground === ground && !!last.atAccess === atAccess) last.points.push(b);
    else segments.push({ points: [a, b], status: j.status, reason: j.reason, ...(ground ? { ground } : {}), ...(atAccess ? { atAccess: true } : {}) });
  }
  const minBed = ctx.habitat.bedding.reduce((m, b) => Math.min(m, ...dense.map((p) => distanceToArea(p, b))), Infinity);
  const worst: Status = segments.some((s) => s.status === 'avoid') ? 'avoid' : segments.some((s) => s.status === 'caution') ? 'caution' : 'safe';
  const notes: string[] = [];
  if (start.inferred) notes.push(`Starts at ${start.label.toLowerCase()} (inferred). Mark your parking or access point for better routes.`);
  const boundary = ctx.property.boundary;
  if (boundary && boundary.length >= 3 && dense.some((p) => !pointInPolygon(p, boundary))) notes.push('Part of this walk is outside your property line. Only cross ground you have permission to use.');
  if (segments.some((s) => s.ground === 'off_property')) notes.push('No walk reaches this stand without crossing ground off your property. Get permission, or mark a different access point.');
  if (segments.some((s) => s.ground === 'house_buffer')) notes.push('The walk passes within 50 m of a house. Only go that way with the owner’s OK, or mark a different access point.');
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
  /** No access point, gate, road or boundary to start from. */
  noAccess: boolean;
  /**
   * No legal walking route reaches the stand: it sits inside a no-access zone, or water,
   * a no-access zone or a neighbor line cuts it off from every start point. Only HARD blocks
   * make a stand unreachable; ground off the property line or near a house never does.
   */
  unreachable: boolean;
  /**
   * The walk reaches the stand only by crossing ground off the property line or within 50 m of
   * a house (beyond the stretch by the truck or the stand). Those stretches are flagged red with a
   * `ground` on the segment; the stand is a caution, never a no-go for this reason.
   */
  softCrossing: boolean;
}

/** Exit points this close to the stand, the truck or a gate are shared by necessity. */
const SHARED_APRON_M = 60;

/** Share of the exit (by length) that walks back along the entry path. */
function sharedFraction(exit: Vec[], entry: Vec[], withinM: number, exempt: Vec[]): number {
  const L = polylineLength(exit);
  const step = Math.max(5, withinM / 2);
  let shared = 0;
  let total = 0;
  for (let d = step / 2; d < L; d += step) {
    const p = pointAlong(exit, d).point;
    if (exempt.some((q) => dist(p, q) < SHARED_APRON_M)) continue;
    total++;
    if (pointPolylineDistance(p, entry) < withinM) shared++;
  }
  return total ? shared / total : 0;
}

interface Leg {
  path: Vec[];
  cost: number;
}

/** Cheapest route from → to, through one of the must-use gates when there are any. */
function routeVia(g: CostGrid, from: Vec, to: Vec, gates: Vec[], penalty?: Float64Array, relaxSoft = false): Leg | null {
  if (gates.length === 0) return astar(g, from, to, penalty, relaxSoft);
  let best: Leg | null = null;
  for (const gate of gates) {
    const a = astar(g, from, gate, penalty, relaxSoft);
    const b = a && astar(g, gate, to, penalty, relaxSoft);
    if (a && b && (!best || a.cost + b.cost < best.cost)) best = { path: [...a.path, ...b.path.slice(1)], cost: a.cost + b.cost };
  }
  return best;
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
  const barriers = barriersFor(ctx.property);
  const softAt = makeSoftGroundAt(ctx.property);
  const gatePoints = barriers.gates.map((g) => g.position);
  // A walk that starts at a gate has already used it.
  const gatesFor = (st: AccessStart) => (gatePoints.some((g) => dist(g, st.position) < 1) ? [] : gatePoints);

  return {
    plan(stand: Vec): RoutePair {
      const starts = accessStarts(ctx.property, stand);
      // A stand inside a no-access zone is never routed to, however close to the edge it sits.
      if (barriers.zones.some((z) => pointInPolygon(stand, z))) return { entry: null, exit: null, noAccess: starts.length === 0, unreachable: true, softCrossing: false };
      if (starts.length === 0) return { entry: null, exit: null, noAccess: true, unreachable: false, softCrossing: false };

      // Pass 1 walks only ground the hunter may use. Pass 2 (only when pass 1 finds nothing) also
      // crosses soft ground, at a steep cost, so a parking spot far outside the line or a farmhouse
      // in the only gap yields a flagged route rather than a false "no legal route".
      const findEntry = (relaxSoft: boolean) => {
        let best: (Leg & { start: AccessStart }) | null = null;
        for (const st of starts) {
          const r = routeVia(entryGrid, st.position, stand, gatesFor(st), undefined, relaxSoft);
          if (r && (!best || r.cost < best.cost)) best = { ...r, start: st };
        }
        return best;
      };
      let entryRelaxed = false;
      let bestEntry = findEntry(false);
      if (!bestEntry) {
        bestEntry = findEntry(true);
        entryRelaxed = bestEntry !== null;
      }
      if (!bestEntry) return { entry: null, exit: null, noAccess: false, unreachable: true, softCrossing: false };

      // Penalize re-using the entry path on the way out (outside the stand, truck and gate zones).
      const apron = [stand, bestEntry.start.position, ...gatePoints];
      const penalty = new Float64Array(exitGrid.cols * exitGrid.rows);
      for (const p of bestEntry.path) {
        if (apron.some((q) => dist(p, q) < SHARED_APRON_M)) continue;
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
      const findExit = (relaxSoft: boolean) => {
        let best: (Leg & { start: AccessStart }) | null = null;
        for (const st of starts) {
          const r = routeVia(exitGrid, stand, st.position, gatesFor(st), penalty, relaxSoft);
          if (r && (!best || r.cost < best.cost)) best = { ...r, start: st };
        }
        return best;
      };
      let exitRelaxed = entryRelaxed;
      let bestExit = findExit(entryRelaxed);
      if (!bestExit && !entryRelaxed) {
        bestExit = findExit(true);
        exitRelaxed = bestExit !== null;
      }

      const entry = assembleRoute('entry', bestEntry.start, bestEntry.path, entryJudge, ctx, entryGrid.cell, barriers, entryRelaxed ? softAt : null);
      const exit = bestExit ? assembleRoute('exit', bestExit.start, bestExit.path, exitJudge, ctx, exitGrid.cell, barriers, exitRelaxed ? softAt : null) : null;
      if (entry && exit && bestExit) {
        // Walking within ~1.5 cells of the entry path is walking the same ground.
        const overlap = sharedFraction(exit.points, entry.points, entryGrid.cell * 1.5, [...apron, bestExit.start.position]);
        entry.overlapWithOther = overlap;
        exit.overlapWithOther = overlap;
        if (overlap > 0.6) exit.notes.push('Terrain forces the exit back along your entry path. Go extra slow and quiet.');
      }
      const softCrossing = [entry, exit].some((r) => r?.segments.some((x) => x.ground));
      return { entry, exit, noAccess: false, unreachable: false, softCrossing };
    },
  };
}

// ---------------------------------------------------------------------------
// A scent problem at the parking spot is a plan-level fact, not a per-stand one
// ---------------------------------------------------------------------------

/** A parking spot whose own surroundings put scent on deer, shared by most stands that start there. */
export interface AccessHazard {
  /** The access point's label, e.g. "Field gate". */
  label: string;
  position: Vec;
  walks: WalkKind[];
  /** What the scent reaches. */
  targets: Array<'food' | 'bedding'>;
  /** How many stands start here and are hit by it. */
  stands: number;
}

/** Which of a stand's walks have their at-access scent stretch discounted (it is reported once, plan-wide). */
export type SharedAccess = { entry: boolean; exit: boolean };

/** Share of the stands starting at one access point that must hit the same scent problem to call it the parking spot's. */
const SHARED_ACCESS_FRACTION = 0.6;
/** Fewer than this many stands is just that stand's problem. */
const SHARED_ACCESS_MIN_STANDS = 2;

/**
 * Finds scent problems that sit at an access point and recur on most stands that start there (the
 * parking spot is upwind of a field). The same stretch is red on every stand and no choice of stand
 * clears it, so the planner reports it once and does not hold it against any one stand's score or
 * decision. Hazards that only some stands share stay per-stand.
 */
export function findSharedAccessHazards(pairs: readonly RoutePair[]): { hazards: AccessHazard[]; shared: Map<RoutePair, SharedAccess> } {
  const groups = new Map<string, { kind: WalkKind; label: string; position: Vec; members: Array<{ pair: RoutePair; route: Route }> }>();
  for (const pair of pairs) {
    for (const route of [pair.entry, pair.exit]) {
      if (!route || route.points.length < 2) continue;
      const position = route.kind === 'entry' ? route.points[0] : route.points[route.points.length - 1];
      const key = `${route.kind}|${route.startLabel}|${Math.round(position.x / 5)}:${Math.round(position.y / 5)}`;
      const g = groups.get(key) ?? { kind: route.kind, label: route.startLabel, position, members: [] };
      g.members.push({ pair, route });
      groups.set(key, g);
    }
  }
  const shared = new Map<RoutePair, SharedAccess>();
  const merged = new Map<string, AccessHazard>();
  for (const g of groups.values()) {
    const hit = g.members.filter((m) => m.route.segments.some((x) => x.atAccess));
    if (g.members.length < SHARED_ACCESS_MIN_STANDS || hit.length < SHARED_ACCESS_MIN_STANDS || hit.length / g.members.length < SHARED_ACCESS_FRACTION) continue;
    for (const m of hit) shared.set(m.pair, { entry: false, exit: false, ...shared.get(m.pair), [g.kind]: true });
    const targets = new Set<'food' | 'bedding'>();
    for (const m of hit) for (const x of m.route.segments) if (x.atAccess) targets.add(FOOD_SCENT_REASONS.has(x.reason) ? 'food' : 'bedding');
    const key = `${g.label}|${Math.round(g.position.x / 5)}:${Math.round(g.position.y / 5)}`;
    const h = merged.get(key) ?? { label: g.label, position: g.position, walks: [], targets: [], stands: 0 };
    if (!h.walks.includes(g.kind)) h.walks.push(g.kind);
    for (const t of targets) if (!h.targets.includes(t)) h.targets.push(t);
    h.stands = Math.max(h.stands, hit.length);
    merged.set(key, h);
  }
  return { hazards: [...merged.values()], shared };
}

export function featuresForRouting(features: MapFeature[]): MapFeature[] {
  return features.filter((f) => f.status === 'active');
}
