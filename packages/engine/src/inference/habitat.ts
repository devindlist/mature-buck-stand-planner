import type {
  BeddingArea,
  Corridor,
  CorridorKind,
  CropType,
  FoodSource,
  HabitatSummary,
  HuntWindow,
  MapFeature,
  PinchPoint,
  SeasonPhase,
  Sighting,
  Vec,
} from '../models.ts';
import {
  add,
  bearingVec,
  centroid,
  dist,
  downwindBearing,
  geometryCentroid,
  normalize,
  pointGeometryDistance,
  pointInPolygon,
  pointSegmentDistance,
  polygonArea,
  shapeDistance,
  polylineLength,
  projectOntoPolyline,
  rotate,
  scale,
  sub,
  closestPointOnSegment,
} from '../geo/geometry.ts';
import { CORRIDOR_WEIGHTS } from '../season/phase.ts';

/**
 * Habitat inference: probable bedding, food and travel corridors from mapped features.
 * Everything here is a hypothesis the hunter can move, edit or dismiss. User-placed
 * features (confidence 1, source 'user') always outrank vision detections.
 */

const active = (features: MapFeature[]) => features.filter((f) => f.status === 'active');

const DEFAULT_RADIUS_M = 60;

/**
 * Every bedding area the engine infers (prob >= this) is real enough to protect:
 * the wind gate, setbacks and route judging all use this same floor.
 */
export const BEDDING_MIN_PROB = 0.25;

function polygonRadius(points: Vec[]): number {
  return Math.max(25, Math.sqrt(polygonArea(points) / Math.PI));
}

/** Closest point on an area's outline (or circle) toward a target. */
export function edgePointToward(area: { center: Vec; polygon?: Vec[]; radiusM: number }, target: Vec): Vec {
  if (area.polygon && area.polygon.length >= 3) {
    let best = area.polygon[0];
    let bestD = Infinity;
    for (let i = 0; i < area.polygon.length; i++) {
      const a = area.polygon[i];
      const b = area.polygon[(i + 1) % area.polygon.length];
      const { point } = closestPointOnSegment(target, a, b);
      const d = dist(point, target);
      if (d < bestD) {
        bestD = d;
        best = point;
      }
    }
    return best;
  }
  const dir = normalize(sub(target, area.center));
  return add(area.center, scale(dir, area.radiusM));
}

/** Distance from a point to the edge of an area (0 inside). */
export function distanceToArea(p: Vec, area: { center: Vec; polygon?: Vec[]; radiusM: number }): number {
  if (area.polygon && area.polygon.length >= 3) {
    return pointGeometryDistance(p, { kind: 'polygon', points: area.polygon });
  }
  return Math.max(0, dist(p, area.center) - area.radiusM);
}

// ---------------------------------------------------------------------------
// Bedding
// ---------------------------------------------------------------------------

export function inferBedding(features: MapFeature[], sightings: Sighting[]): BeddingArea[] {
  const fs = active(features);
  const terrainBedding = fs.filter((f) => f.type === 'bench' || f.type === 'ridge');
  const disturbance = fs.filter((f) => f.type === 'road' || f.type === 'house');
  const ag = fs.filter((f) => f.type === 'ag_field' || f.type === 'food_plot');
  const out: BeddingArea[] = [];

  for (const f of fs) {
    if (f.type === 'bedding') {
      const isPoly = f.geometry.kind === 'polygon' && f.geometry.points.length >= 3;
      const kind = f.attributes?.beddingKind ?? 'unknown';
      out.push({
        id: `bed-${f.id}`,
        label: f.label ?? 'Marked bedding',
        center: geometryCentroid(f.geometry),
        polygon: isPoly ? f.geometry.points : undefined,
        radiusM: isPoly ? polygonRadius(f.geometry.points) : DEFAULT_RADIUS_M,
        probability: 0.95 * Math.max(0.5, f.confidence),
        kind,
        featureIds: [f.id],
        reasons: [f.source === 'user' ? 'You marked this bedding.' : 'Detected bedding.'],
      });
      continue;
    }
    if (f.type !== 'thick_cover' || f.geometry.points.length < 3 || f.geometry.kind !== 'polygon') continue;
    const center = centroid(f.geometry.points);
    const reasons = ['Thick cover is the security mature bucks bed in.'];
    let p = 0.55 * f.confidence;
    const nearTerrain = terrainBedding.some((t) => pointGeometryDistance(center, t.geometry) < 80 || t.geometry.points.some((q) => pointInPolygon(q, f.geometry.points)));
    if (nearTerrain) {
      p += 0.2;
      reasons.push('Bench or ridge point inside the cover, a classic buck bed with a wind advantage.');
    }
    const nearestDisturbance = disturbance.reduce((m, d) => Math.min(m, pointGeometryDistance(center, d.geometry)), Infinity);
    if (nearestDisturbance < 150) {
      p *= 0.6;
      reasons.push('Close to a road or house, so mature bucks avoid it more often.');
    } else if (nearestDisturbance > 300) {
      p += 0.05;
      reasons.push('Remote from roads and houses.');
    }
    const nearFood = ag.some((a) => shapeDistance(f.geometry.points, true, a.geometry.points, a.geometry.kind === 'polygon') < 150);
    const kind: BeddingArea['kind'] = nearFood && !nearTerrain ? 'doe' : nearTerrain || nearestDisturbance > 300 ? 'buck' : 'unknown';
    if (kind === 'doe') reasons.push('Cover tight to food often holds doe family groups.');
    out.push({
      id: `bed-${f.id}`,
      label: f.label ?? 'Thick cover',
      center,
      polygon: f.geometry.points,
      radiusM: polygonRadius(f.geometry.points),
      probability: Math.min(0.9, p),
      kind,
      featureIds: [f.id],
      reasons,
    });
  }

  // Benches without mapped cover still make buck beds (often overlooked by hunters).
  for (const b of fs.filter((f) => f.type === 'bench')) {
    const c = geometryCentroid(b.geometry);
    if (out.some((o) => distanceToArea(c, o) < 50)) continue;
    out.push({
      id: `bed-${b.id}`,
      label: b.label ?? 'Bench',
      center: c,
      radiusM: DEFAULT_RADIUS_M,
      probability: 0.4 * b.confidence,
      kind: 'buck',
      featureIds: [b.id],
      reasons: ['A bench lets a buck watch below and smell above, so it is a likely bed.'],
    });
  }

  // Observed bedded mature bucks are hard evidence.
  for (const s of sightings) {
    if (!s.position || s.behavior !== 'bedded' || s.maturity !== 'mature_buck') continue;
    const existing = out.find((o) => distanceToArea(s.position as Vec, o) < 100);
    if (existing) {
      existing.probability = Math.max(existing.probability, 0.9);
      existing.kind = 'buck';
      existing.reasons.push('A mature buck was seen bedded here.');
    } else {
      out.push({
        id: `bed-sighting-${s.id}`,
        label: 'Observed bed',
        center: s.position,
        radiusM: DEFAULT_RADIUS_M,
        probability: 0.85,
        kind: 'buck',
        featureIds: [],
        reasons: ['A mature buck was seen bedded here.'],
      });
    }
  }
  return out.filter((b) => b.probability >= BEDDING_MIN_PROB);
}

// ---------------------------------------------------------------------------
// Food
// ---------------------------------------------------------------------------

type PhaseRow = Record<SeasonPhase, number>;
const row = (e: number, l: number, pr: number, s: number, lo: number, po: number, la: number): PhaseRow => ({
  early_season: e,
  october_lull: l,
  pre_rut: pr,
  seeking_chasing: s,
  lockdown: lo,
  post_rut: po,
  late_season: la,
});

export const CROP_ATTRACTION: Record<CropType, PhaseRow> = {
  soybeans_green: row(0.95, 0.5, 0.2, 0.2, 0.2, 0.2, 0.2),
  soybeans_standing: row(0.3, 0.4, 0.5, 0.45, 0.4, 0.8, 1.0),
  soybeans_cut: row(0.2, 0.4, 0.45, 0.4, 0.35, 0.5, 0.45),
  corn_standing: row(0.4, 0.6, 0.6, 0.5, 0.45, 0.75, 0.95),
  corn_picked: row(0.1, 0.35, 0.45, 0.4, 0.35, 0.6, 0.75),
  alfalfa_clover: row(0.9, 0.7, 0.6, 0.45, 0.4, 0.6, 0.4),
  winter_wheat: row(0.5, 0.65, 0.6, 0.45, 0.4, 0.65, 0.7),
  brassicas: row(0.2, 0.35, 0.45, 0.4, 0.4, 0.75, 1.0),
  unknown: row(0.7, 0.55, 0.55, 0.45, 0.4, 0.7, 0.8),
  // Stage unknown: typical Midwest progression (green → standing → harvested/left standing).
  corn: row(0.4, 0.6, 0.55, 0.45, 0.4, 0.65, 0.85),
  soybeans: row(0.95, 0.45, 0.45, 0.4, 0.35, 0.6, 0.8),
};
export const MAST_ATTRACTION: PhaseRow = row(0.55, 0.9, 0.8, 0.5, 0.4, 0.45, 0.25);
export const FOOD_PLOT_ATTRACTION: PhaseRow = row(0.8, 0.7, 0.65, 0.5, 0.45, 0.75, 0.9);

export function inferFood(features: MapFeature[], phase: SeasonPhase): FoodSource[] {
  const out: FoodSource[] = [];
  for (const f of active(features)) {
    let kind: FoodSource['kind'];
    let attraction: number;
    const reasons: string[] = [];
    if (f.type === 'ag_field') {
      kind = 'ag';
      const crop = f.attributes?.crop ?? 'unknown';
      attraction = CROP_ATTRACTION[crop][phase];
      reasons.push(crop === 'unknown' ? 'Ag field (crop unknown; set it for better results).' : `Ag field: ${crop.replace(/_/g, ' ')}.`);
    } else if (f.type === 'mast_timber') {
      kind = 'mast';
      attraction = MAST_ATTRACTION[phase];
      reasons.push('Mast timber. Acorns pull deer hardest from late September through the pre-rut.');
    } else if (f.type === 'food_plot') {
      kind = 'food_plot';
      const crop = f.attributes?.crop;
      attraction = crop ? Math.max(CROP_ATTRACTION[crop][phase], 0.4) : FOOD_PLOT_ATTRACTION[phase];
      reasons.push('Food plot.');
    } else {
      continue;
    }
    const isPoly = f.geometry.kind === 'polygon' && f.geometry.points.length >= 3;
    out.push({
      id: `food-${f.id}`,
      label: f.label ?? (kind === 'ag' ? 'Field' : kind === 'mast' ? 'Acorns' : 'Food plot'),
      center: geometryCentroid(f.geometry),
      polygon: isPoly ? f.geometry.points : undefined,
      radiusM: isPoly ? polygonRadius(f.geometry.points) : 40,
      probability: attraction * (f.source === 'user' ? 1 : Math.max(0.4, f.confidence)),
      kind,
      featureIds: [f.id],
      reasons,
    });
  }
  return out.filter((f) => f.probability >= 0.15);
}

// ---------------------------------------------------------------------------
// Corridors
// ---------------------------------------------------------------------------

const PINCH_TYPES = new Set(['saddle', 'funnel', 'creek_crossing', 'inside_corner']);

function featurePoint(f: MapFeature, near: Vec): Vec {
  return f.geometry.points.length === 1 ? f.geometry.points[0] : projectOntoPolyline(near, f.geometry.points).point;
}

/**
 * Route a corridor through terrain pinch points that lie near the straight line,
 * the way deer bend travel through saddles, crossings and inside corners.
 */
function routeThroughPinches(start: Vec, end: Vec, pinches: MapFeature[]): { points: Vec[]; used: PinchPoint[] } {
  const L = dist(start, end);
  const buffer = Math.max(100, 0.3 * L);
  const ab = sub(end, start);
  const candidates: Array<{ t: number; p: Vec; f: MapFeature }> = [];
  for (const f of pinches) {
    const p = featurePoint(f, start);
    const { t } = closestPointOnSegment(p, start, end);
    if (t <= 0.05 || t >= 0.95) continue;
    if (pointSegmentDistance(p, start, end) > buffer) continue;
    candidates.push({ t: (p.x - start.x) * ab.x + (p.y - start.y) * ab.y, p, f });
  }
  candidates.sort((a, b) => a.t - b.t);
  return {
    points: [start, ...candidates.map((c) => c.p), end],
    used: candidates.map((c) => ({ position: c.p, featureId: c.f.id, type: c.f.type })),
  };
}

function pinchesNear(points: Vec[], pinches: MapFeature[], already: PinchPoint[]): PinchPoint[] {
  const out = [...already];
  for (const f of pinches) {
    if (out.some((p) => p.featureId === f.id)) continue;
    const p = featurePoint(f, points[0]);
    if (projectOntoPolyline(p, points).distance <= 60) out.push({ position: p, featureId: f.id, type: f.type });
  }
  return out;
}

export interface CorridorContext {
  phase: SeasonPhase;
  window: HuntWindow;
  windFromDeg: number;
}

export function inferCorridors(features: MapFeature[], bedding: BeddingArea[], food: FoodSource[], ctx: CorridorContext): Corridor[] {
  const fs = active(features);
  const w = CORRIDOR_WEIGHTS[ctx.phase];
  const pinches = fs.filter((f) => PINCH_TYPES.has(f.type));
  const out: Corridor[] = [];
  const push = (
    kind: CorridorKind,
    label: string,
    points: Vec[],
    strength: number,
    reasons: string[],
    used: PinchPoint[],
    from?: { id: string; label: string },
    to?: { id: string; label: string },
  ) => {
    if (strength <= 0.02 || points.length < 2) return;
    const pp = pinchesNear(points, pinches, used);
    const bonus = Math.min(0.3, pp.length * 0.15);
    out.push({
      id: `cor-${kind}-${out.length}`,
      kind,
      label,
      points,
      strength: Math.min(1, strength * (1 + bonus)),
      pinchPoints: pp,
      reasons,
      fromId: from?.id,
      toId: to?.id,
      fromLabel: from?.label,
      toLabel: to?.label,
    });
  };

  // Bed → food: the bread-and-butter pattern outside the rut.
  for (const b of bedding) {
    if (b.probability < 0.35) continue;
    const foods = food
      .map((f) => ({ f, d: dist(b.center, f.center) }))
      .filter((x) => x.d <= 1600)
      .sort((x, y) => y.f.probability * Math.exp(-y.d / 1500) - x.f.probability * Math.exp(-x.d / 1500))
      .slice(0, 3);
    for (const { f } of foods) {
      const start = edgePointToward(b, f.center);
      const end = edgePointToward(f, b.center);
      const { points, used } = routeThroughPinches(start, end, pinches);
      const L = polylineLength(points);
      push(
        'bed_to_food',
        `${b.label} → ${f.label}`,
        points,
        b.probability * f.probability * Math.exp(-L / 1500) * w.bed_to_food,
        [`Travel between ${b.kind === 'buck' ? 'buck' : 'probable'} bedding and ${f.kind === 'ag' ? 'the field' : f.kind === 'mast' ? 'the acorns' : 'the plot'}.`],
        used,
        b,
        f,
      );
    }
  }

  // Bed ↔ bed: bucks check doe groups from the pre-rut on.
  for (let i = 0; i < bedding.length; i++) {
    for (let j = i + 1; j < bedding.length; j++) {
      const a = bedding[i];
      const b = bedding[j];
      const d = dist(a.center, b.center);
      if (d > 1400 || d < 80) continue;
      const { points, used } = routeThroughPinches(edgePointToward(a, b.center), edgePointToward(b, a.center), pinches);
      push('bed_to_bed', `${a.label} ↔ ${b.label}`, points, a.probability * b.probability * Math.exp(-d / 1500) * w.bed_to_bed, ['Bucks cruise between bedding areas looking for does.'], used, a, b);
    }
  }

  // Downwind cruise: bucks scent-check doe bedding from its downwind side.
  if (w.cruise > 0) {
    const downwind = bearingVec(downwindBearing(ctx.windFromDeg));
    const across = rotate(downwind, 90);
    for (const b of bedding) {
      if (b.kind === 'buck' || b.probability < 0.4) continue;
      const mid = add(b.center, scale(downwind, b.radiusM + 80));
      const half = b.radiusM + 80;
      push(
        'cruise',
        `Downwind of ${b.label}`,
        [add(mid, scale(across, -half)), add(mid, scale(across, half))],
        b.probability * w.cruise * 0.8,
        ['Bucks cruise the downwind side of doe bedding to scent-check it. This line moves with the wind.'],
        [],
        b,
      );
    }
  }

  // Terrain travel: benches (military crest), edges, draws, ridges.
  const TERRAIN_FACTOR: Partial<Record<string, number>> = { bench: 1.0, edge: 0.8, draw: 0.7, ridge: 0.6, creek: 0.4 };
  for (const f of fs) {
    const k = TERRAIN_FACTOR[f.type];
    if (k === undefined || f.geometry.kind !== 'line' || f.geometry.points.length < 2) continue;
    const label: Record<string, string> = {
      bench: 'Bucks travel benches just below the ridgeline.',
      edge: 'Edges are natural travel lines.',
      draw: 'Draws give deer a hidden route.',
      ridge: 'Ridge spines are travel routes, though bucks favor the downwind side.',
      creek: 'Deer parallel creek bottoms.',
    };
    push('terrain_travel', f.label ?? f.type.replace('_', ' '), f.geometry.points, f.confidence * k * 0.55 * w.terrain_travel, [label[f.type]], []);
  }

  // Isolated pinch points (saddle / funnel with no corridor through them yet).
  for (const f of pinches) {
    const p = f.geometry.points[0];
    if (out.some((c) => projectOntoPolyline(p, c.points).distance < 80)) continue;
    const nearestBed = bedding.reduce<BeddingArea | null>((m, b) => (!m || dist(p, b.center) < dist(p, m.center) ? b : m), null);
    const dir = nearestBed ? normalize(sub(nearestBed.center, p)) : { x: 0, y: 1 };
    push(
      'terrain_travel',
      f.label ?? f.type.replace('_', ' '),
      [add(p, scale(dir, -80)), p, add(p, scale(dir, 80))],
      f.confidence * 0.6 * w.terrain_travel,
      [`Isolated ${f.type.replace('_', ' ')} that pinches movement.`],
      [{ position: p, featureId: f.id, type: f.type }],
    );
  }

  return out.sort((a, b) => b.strength - a.strength).slice(0, 15);
}

export function inferHabitat(features: MapFeature[], sightings: Sighting[], ctx: CorridorContext): HabitatSummary {
  const bedding = inferBedding(features, sightings);
  const food = inferFood(features, ctx.phase);
  const corridors = inferCorridors(features, bedding, food, ctx);
  return { bedding, food, corridors };
}
