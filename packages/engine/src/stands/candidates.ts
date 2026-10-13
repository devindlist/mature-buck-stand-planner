import type { BeddingArea, Corridor, HabitatSummary, HuntWindow, MapFeature, Property, SeasonPhase, Stand, Vec } from '../models.ts';
import {
  add,
  bearingVec,
  clamp,
  dist,
  dot,
  downwindBearing,
  pointAlong,
  pointGeometryDistance,
  pointInPolygon,
  polylineLength,
  projectOntoPolyline,
  rotate,
  scale,
  ydsToM,
} from '../geo/geometry.ts';
import { BEDDING_MIN_PROB, distanceToArea } from '../inference/habitat.ts';

/**
 * Candidate generation: put stands on the DOWNWIND side of probable travel, offset
 * inside shooting range, and never closer to bedding than the phase setback.
 */

export interface CandidateContext {
  phase: SeasonPhase;
  window: HuntWindow;
  windFromDeg: number;
  effectiveRangeYds: number;
  setbackM: number;
}

export interface Candidate {
  stand: Stand;
  corridorId?: string;
  anchorLabel: string;
}

/** Doe bedding gets a lighter setback: bumping does still ruins a rut sit. */
export const DOE_SETBACK_FACTOR = 0.6;

/** Generated stands never go directly over a trail: deer passing underneath wind and spot hunters. */
export const ON_TRAIL_M = 10;

/** A dismissed generated stand suppresses new proposals within this radius. */
export const DISMISS_RADIUS_M = 40;

export function effectiveSetback(b: BeddingArea, setbackM: number): number {
  return b.kind === 'doe' ? setbackM * DOE_SETBACK_FACTOR : setbackM;
}

export function standOffsetM(effectiveRangeYds: number): number {
  return clamp(ydsToM(effectiveRangeYds) * 0.5, 15, 90);
}

const PINCH_LABEL: Record<string, string> = {
  saddle: 'Saddle',
  funnel: 'Funnel',
  creek_crossing: 'Creek crossing',
  inside_corner: 'Inside corner',
};

interface Anchor {
  point: Vec;
  tangent: Vec;
  label: string;
}

function anchorsFor(c: Corridor, ctx: CandidateContext): Anchor[] {
  const L = polylineLength(c.points);
  const out: Anchor[] = [];
  for (const p of c.pinchPoints) {
    const proj = projectOntoPolyline(p.position, c.points);
    out.push({ point: proj.point, tangent: proj.tangent, label: PINCH_LABEL[p.type] ?? 'Pinch' });
  }
  const at = (d: number, label: string) => {
    if (d < 0 || d > L) return;
    const { point, tangent } = pointAlong(c.points, d);
    out.push({ point, tangent, label });
  };
  if (c.kind === 'bed_to_food') {
    // Intercept between bedding and food, just outside the setback.
    at(Math.min(L * 0.5, ctx.setbackM + 40), ctx.window === 'AM' ? 'Bedding intercept' : 'Staging cover');
    at(L * 0.7, `${capitalize(c.toLabel ?? 'Food')} approach`);
    // Field-edge sits work in PM early/late season when bucks hit food in daylight.
    if (ctx.window === 'PM' && (ctx.phase === 'early_season' || ctx.phase === 'late_season' || ctx.phase === 'post_rut')) at(Math.max(0, L - 30), `${capitalize(c.toLabel ?? 'Field')} edge`);
  } else {
    const label = c.kind === 'cruise' ? 'Downwind cruise' : c.kind === 'bed_to_bed' ? 'Cruising route' : capitalize(c.label);
    const n = Math.max(1, Math.min(4, Math.floor(L / 150)));
    for (let i = 0; i < n; i++) at((L * (i + 0.5)) / n, label);
  }
  return out;
}

function insideBoundary(p: Vec, property: Property): boolean {
  return !property.boundary || property.boundary.length < 3 || pointInPolygon(p, property.boundary);
}

/** No-access zones the hunter drew (polygons). The engine never proposes a stand inside one. */
export function noAccessZones(property: Property): Vec[][] {
  return (property.accessConstraints ?? []).filter((c) => c.kind === 'no_access_zone' && c.geometry.kind === 'polygon' && c.geometry.points.length >= 3).map((c) => c.geometry.points);
}

/** Generated stands must sit where a stand can actually go. */
function unsuitable(p: Vec, features: MapFeature[]): string | null {
  for (const f of features) {
    if (f.status !== 'active') continue;
    const d = pointGeometryDistance(p, f.geometry);
    if (f.type === 'water' && d === 0) return 'in water';
    if ((f.type === 'road' || f.type === 'house') && d < 50) return 'too close to a road or house';
    if (f.type === 'ag_field' && f.geometry.kind === 'polygon' && pointInPolygon(p, f.geometry.points)) {
      // Allow a stand on the field edge, but not out in the open field.
      const edgeD = pointGeometryDistance(p, { kind: 'line', points: [...f.geometry.points, f.geometry.points[0]] });
      if (edgeD > 20) return 'in the open field';
    }
  }
  return null;
}

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const COMPASS_8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** Give every generated stand a unique, readable name: "Timber edge · W", then numbers if needed. */
function uniqueNames(cands: Candidate[], center: Vec): void {
  const groups = new Map<string, Candidate[]>();
  for (const c of cands) groups.set(c.stand.name, [...(groups.get(c.stand.name) ?? []), c]);
  for (const [name, group] of groups) {
    if (group.length < 2) continue;
    for (const c of group) {
      const b = Math.atan2(c.stand.position.x - center.x, c.stand.position.y - center.y) / (Math.PI / 180);
      c.stand.name = `${name} · ${COMPASS_8[Math.round((((b % 360) + 360) % 360) / 45) % 8]}`;
    }
  }
  const seen = new Map<string, number>();
  for (const c of cands) {
    const n = (seen.get(c.stand.name) ?? 0) + 1;
    seen.set(c.stand.name, n);
    if (n > 1) c.stand.name = `${c.stand.name} ${n}`;
  }
}

let nextId = 0;
const genId = (p: Vec) => `gen-${Math.round(p.x)}_${Math.round(p.y)}-${nextId++}`;

export function generateCandidates(property: Property, habitat: HabitatSummary, ctx: CandidateContext): { candidates: Candidate[]; rejected: Array<{ position: Vec; reason: string }> } {
  nextId = 0;
  const features = property.features;
  const downwind = bearingVec(downwindBearing(ctx.windFromDeg));
  const offset = standOffsetM(ctx.effectiveRangeYds);
  const out: Candidate[] = [];
  const rejected: Array<{ position: Vec; reason: string }> = [];
  const zones = noAccessZones(property);

  for (const c of habitat.corridors.slice(0, 12)) {
    for (const a of anchorsFor(c, ctx)) {
      const normal = rotate(a.tangent, 90);
      const s = dot(normal, downwind);
      const sides = Math.abs(s) >= 0.25 ? [Math.sign(s)] : [1, -1];
      for (const side of sides) {
        const p = add(a.point, scale(normal, side * offset));
        // Every bedding area the engine keeps gets its setback, however it was inferred.
        const tooClose = habitat.bedding.find((b) => b.probability >= BEDDING_MIN_PROB && distanceToArea(p, b) < effectiveSetback(b, ctx.setbackM));
        if (tooClose) {
          rejected.push({ position: p, reason: `Inside the ${Math.round(effectiveSetback(tooClose, ctx.setbackM))} m bedding setback` });
          continue;
        }
        if (!insideBoundary(p, property)) {
          rejected.push({ position: p, reason: 'Outside the property boundary' });
          continue;
        }
        if (zones.some((z) => pointInPolygon(p, z))) {
          rejected.push({ position: p, reason: 'Inside a no-access zone you marked' });
          continue;
        }
        const onTrail = habitat.corridors.find((o) => o.strength >= 0.15 && projectOntoPolyline(p, o.points).distance < ON_TRAIL_M);
        if (onTrail) {
          rejected.push({ position: p, reason: 'Right on top of a travel route' });
          continue;
        }
        const bad = unsuitable(p, features);
        if (bad) {
          rejected.push({ position: p, reason: `Unsuitable: ${bad}` });
          continue;
        }
        if (out.some((o) => dist(o.stand.position, p) < 35)) continue;
        if (property.dismissedCandidatePositions?.some((d) => dist(d, p) < DISMISS_RADIUS_M)) {
          rejected.push({ position: p, reason: 'You dismissed a stand here' });
          continue;
        }
        out.push({
          corridorId: c.id,
          anchorLabel: a.label,
          stand: {
            id: genId(p),
            propertyId: property.id,
            name: a.label,
            position: p,
            origin: 'generated',
            type: 'hang_on',
          },
        });
      }
    }
  }

  const allPts = features.filter((f) => f.status === 'active').flatMap((f) => f.geometry.points);
  const center = allPts.length ? { x: allPts.reduce((s, p) => s + p.x, 0) / allPts.length, y: allPts.reduce((s, p) => s + p.y, 0) / allPts.length } : { x: 0, y: 0 };
  const kept = out.slice(0, 40);
  uniqueNames(kept, center);

  // The hunter's own stands are always evaluated, never silently dropped: one inside a
  // no-access zone still comes back, and routing reports it as unreachable.
  const existing: Candidate[] = property.stands.filter((s) => !s.dismissed).map((s) => ({ stand: s, anchorLabel: 'Your stand' }));
  return { candidates: [...existing, ...kept], rejected };
}
