import type { Geometry, Vec } from '../models.ts';

export const DEG = Math.PI / 180;
export const METERS_PER_YARD = 0.9144;

export const ydsToM = (yds: number): number => yds * METERS_PER_YARD;
export const mToYds = (m: number): number => m / METERS_PER_YARD;

export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec, b: Vec): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a: Vec, b: Vec, t: number): Vec => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

export function normalize(a: Vec): Vec {
  const l = len(a);
  return l === 0 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

/** Normalize an angle to [0, 360). */
export function normDeg(d: number): number {
  const r = d % 360;
  return r < 0 ? r + 360 : r;
}

/** Smallest absolute difference between two bearings, 0..180. */
export function angleDiff(a: number, b: number): number {
  const d = Math.abs(normDeg(a) - normDeg(b));
  return d > 180 ? 360 - d : d;
}

/** Unit vector pointing along a compass bearing (0 = north, 90 = east). */
export function bearingVec(bearingDeg: number): Vec {
  return { x: Math.sin(bearingDeg * DEG), y: Math.cos(bearingDeg * DEG) };
}

/** Compass bearing from a to b. */
export function bearingTo(a: Vec, b: Vec): number {
  return normDeg(Math.atan2(b.x - a.x, b.y - a.y) / DEG);
}

export function rotate(v: Vec, clockwiseDeg: number): Vec {
  // Rotating a compass bearing clockwise == rotating the math angle negatively.
  const r = -clockwiseDeg * DEG;
  return { x: v.x * Math.cos(r) - v.y * Math.sin(r), y: v.x * Math.sin(r) + v.y * Math.cos(r) };
}

/** Direction scent travels for a meteorological wind direction. */
export const downwindBearing = (windFromDeg: number): number => normDeg(windFromDeg + 180);

const COMPASS_16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export function compass16(bearingDeg: number): string {
  return COMPASS_16[Math.round(normDeg(bearingDeg) / 22.5) % 16];
}

export function compassToDeg(c: string): number | undefined {
  const i = COMPASS_16.indexOf(c.trim().toUpperCase());
  return i < 0 ? undefined : i * 22.5;
}

// ---------------------------------------------------------------------------
// Distances
// ---------------------------------------------------------------------------

export function closestPointOnSegment(p: Vec, a: Vec, b: Vec): { point: Vec; t: number } {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 === 0) return { point: a, t: 0 };
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  return { point: lerp(a, b, t), t };
}

export const pointSegmentDistance = (p: Vec, a: Vec, b: Vec): number => dist(p, closestPointOnSegment(p, a, b).point);

export function segmentsIntersect(a: Vec, b: Vec, c: Vec, d: Vec): boolean {
  const d1 = cross(sub(b, a), sub(c, a));
  const d2 = cross(sub(b, a), sub(d, a));
  const d3 = cross(sub(d, c), sub(a, c));
  const d4 = cross(sub(d, c), sub(b, c));
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const onSeg = (p: Vec, q: Vec, r: Vec) =>
    Math.min(p.x, q.x) - 1e-9 <= r.x && r.x <= Math.max(p.x, q.x) + 1e-9 && Math.min(p.y, q.y) - 1e-9 <= r.y && r.y <= Math.max(p.y, q.y) + 1e-9;
  if (d1 === 0 && onSeg(a, b, c)) return true;
  if (d2 === 0 && onSeg(a, b, d)) return true;
  if (d3 === 0 && onSeg(c, d, a)) return true;
  if (d4 === 0 && onSeg(c, d, b)) return true;
  return false;
}

export function segmentSegmentDistance(a: Vec, b: Vec, c: Vec, d: Vec): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
}

export function pointInPolygon(p: Vec, poly: Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function edges(points: Vec[], closed: boolean): Array<[Vec, Vec]> {
  const out: Array<[Vec, Vec]> = [];
  for (let i = 0; i + 1 < points.length; i++) out.push([points[i], points[i + 1]]);
  if (closed && points.length > 2) out.push([points[points.length - 1], points[0]]);
  return out;
}

/** Distance from a point to a polyline (closed = polygon outline). */
export function pointPolylineDistance(p: Vec, points: Vec[], closed = false): number {
  if (points.length === 1) return dist(p, points[0]);
  let best = Infinity;
  for (const [a, b] of edges(points, closed)) best = Math.min(best, pointSegmentDistance(p, a, b));
  return best;
}

/** Distance from a point to a geometry; 0 if inside a polygon. */
export function pointGeometryDistance(p: Vec, g: Geometry): number {
  if (g.kind === 'polygon' && g.points.length >= 3 && pointInPolygon(p, g.points)) return 0;
  return pointPolylineDistance(p, g.points, g.kind === 'polygon');
}

/** Distance between two shapes given as vertex lists (polygons when closed). 0 if overlapping. */
export function shapeDistance(a: Vec[], aClosed: boolean, b: Vec[], bClosed: boolean): number {
  if (aClosed && a.length >= 3 && b.some((p) => pointInPolygon(p, a))) return 0;
  if (bClosed && b.length >= 3 && a.some((p) => pointInPolygon(p, b))) return 0;
  const ea = a.length === 1 ? [[a[0], a[0]] as [Vec, Vec]] : edges(a, aClosed);
  const eb = b.length === 1 ? [[b[0], b[0]] as [Vec, Vec]] : edges(b, bClosed);
  let best = Infinity;
  for (const [p, q] of ea) for (const [r, s] of eb) best = Math.min(best, segmentSegmentDistance(p, q, r, s));
  return best;
}

export function polylineLength(points: Vec[]): number {
  let l = 0;
  for (let i = 1; i < points.length; i++) l += dist(points[i - 1], points[i]);
  return l;
}

/** Point at distance `d` meters along a polyline, with the local unit tangent. */
export function pointAlong(points: Vec[], d: number): { point: Vec; tangent: Vec } {
  if (points.length === 1) return { point: points[0], tangent: { x: 0, y: 1 } };
  let remaining = Math.max(0, d);
  for (let i = 1; i < points.length; i++) {
    const seg = dist(points[i - 1], points[i]);
    if (remaining <= seg || i === points.length - 1) {
      const t = seg === 0 ? 0 : Math.min(1, remaining / seg);
      return { point: lerp(points[i - 1], points[i], t), tangent: normalize(sub(points[i], points[i - 1])) };
    }
    remaining -= seg;
  }
  return { point: points[points.length - 1], tangent: { x: 0, y: 1 } };
}

/** Closest point on a polyline plus the distance along the line to it. */
export function projectOntoPolyline(p: Vec, points: Vec[]): { point: Vec; distance: number; along: number; tangent: Vec } {
  if (points.length === 1) return { point: points[0], distance: dist(p, points[0]), along: 0, tangent: { x: 0, y: 1 } };
  let best = { point: points[0], distance: Infinity, along: 0, tangent: { x: 0, y: 1 } };
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const { point, t } = closestPointOnSegment(p, a, b);
    const d = dist(p, point);
    const segLen = dist(a, b);
    if (d < best.distance) best = { point, distance: d, along: acc + t * segLen, tangent: normalize(sub(b, a)) };
    acc += segLen;
  }
  return best;
}

/** Portion of a polyline between two along-distances. */
export function slicePolyline(points: Vec[], fromD: number, toD: number): Vec[] {
  const total = polylineLength(points);
  const a = Math.max(0, Math.min(fromD, toD));
  const b = Math.min(total, Math.max(fromD, toD));
  const out: Vec[] = [pointAlong(points, a).point];
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    acc += dist(points[i - 1], points[i]);
    if (acc > a && acc < b) out.push(points[i]);
  }
  out.push(pointAlong(points, b).point);
  return out;
}

export function centroid(points: Vec[]): Vec {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length < 3) {
    const s = points.reduce((acc, p) => add(acc, p), { x: 0, y: 0 });
    return scale(s, 1 / points.length);
  }
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const f = points[j].x * points[i].y - points[i].x * points[j].y;
    a += f;
    cx += (points[j].x + points[i].x) * f;
    cy += (points[j].y + points[i].y) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const s = points.reduce((acc, p) => add(acc, p), { x: 0, y: 0 });
    return scale(s, 1 / points.length);
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

export function polygonArea(points: Vec[]): number {
  let a = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) a += points[j].x * points[i].y - points[i].x * points[j].y;
  return Math.abs(a / 2);
}

export function geometryCentroid(g: Geometry): Vec {
  if (g.kind === 'line') return pointAlong(g.points, polylineLength(g.points) / 2).point;
  return centroid(g.points);
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function boundsOf(points: Vec[], pad = 0): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

/**
 * Circular sector (a scent cone) approximated as a polygon.
 * Apex at `origin`, axis along `bearingDeg`, half-angle in degrees, radius in meters.
 */
export function sectorPolygon(origin: Vec, bearingDeg: number, halfAngleDeg: number, radiusM: number, steps = 8): Vec[] {
  if (halfAngleDeg >= 180) return circlePolygon(origin, radiusM, 24);
  const pts: Vec[] = [origin];
  for (let i = 0; i <= steps; i++) {
    const b = bearingDeg - halfAngleDeg + (2 * halfAngleDeg * i) / steps;
    pts.push(add(origin, scale(bearingVec(b), radiusM)));
  }
  return pts;
}

export function circlePolygon(center: Vec, r: number, steps = 16): Vec[] {
  const pts: Vec[] = [];
  for (let i = 0; i < steps; i++) pts.push(add(center, scale(bearingVec((360 * i) / steps), r)));
  return pts;
}

/** Douglas–Peucker simplification. */
export function simplify(points: Vec[], tolerance: number): Vec[] {
  if (points.length <= 2) return points.slice();
  let maxD = 0;
  let idx = 0;
  const a = points[0];
  const b = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = pointSegmentDistance(points[i], a, b);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD <= tolerance) return [a, b];
  const left = simplify(points.slice(0, idx + 1), tolerance);
  const right = simplify(points.slice(idx), tolerance);
  return left.slice(0, -1).concat(right);
}

export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
export const round = (v: number, digits = 0): number => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};
