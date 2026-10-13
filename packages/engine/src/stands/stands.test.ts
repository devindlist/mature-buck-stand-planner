import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateCandidates, standOffsetM, ON_TRAIL_M } from './candidates.ts';
import { createRoutePlanner, astar, buildCostGrid, makeSegmentJudge, type RouteContext } from './routes.ts';
import { inferHabitat, distanceToArea, BEDDING_MIN_PROB } from '../inference/habitat.ts';
import { at, fixtureProperty, userFeature } from '../test/fixtures.ts';
import { BEDDING_SETBACK_M } from '../season/phase.ts';
import { bearingVec, dist, dot, downwindBearing, pointInPolygon, pointPolylineDistance, projectOntoPolyline, segmentsIntersect, sub } from '../geo/geometry.ts';
import { scoreAccess, scoreBeddingDistance, scorePressure, scoreShot, scoreWeatherTime, scoreWindFit, standContext, WEIGHTS } from './scoring.ts';
import type { AccessConstraint, HabitatSummary, MapFeature, PressureEvent, Property, Stand, Vec } from '../models.ts';
import { weather } from '../test/fixtures.ts';
import { moonModifier, pressureModifier, combinedModifierPoints, OBSERVED_DATA_DAMPING } from '../modifiers/modifiers.ts';

const ctxFor = (windFromDeg: number) => ({ phase: 'pre_rut' as const, window: 'PM' as const, windFromDeg, effectiveRangeYds: 35, setbackM: BEDDING_SETBACK_M.pre_rut });

test('weights sum to 100', () => {
  assert.equal(Object.values(WEIGHTS).reduce((a, b) => a + b, 0), 100);
});

test('generated stands sit downwind of their corridor, outside setback, inside the boundary, never on a trail', () => {
  const property = fixtureProperty();
  const ctx = ctxFor(315);
  const habitat = inferHabitat(property.features, [], { phase: ctx.phase, window: ctx.window, windFromDeg: ctx.windFromDeg });
  const { candidates } = generateCandidates(property, habitat, ctx);
  assert.ok(candidates.length >= 5);
  const downwind = bearingVec(downwindBearing(315));
  let downwindCount = 0;
  for (const c of candidates) {
    const p = c.stand.position;
    for (const b of habitat.bedding.filter((x) => x.probability >= BEDDING_MIN_PROB)) {
      const sb = b.kind === 'doe' ? ctx.setbackM * 0.6 : ctx.setbackM;
      assert.ok(distanceToArea(p, b) >= sb - 1e-6, `${c.stand.name} inside setback`);
    }
    assert.ok(pointInPolygon(p, property.boundary!), `${c.stand.name} outside boundary`);
    for (const cor of habitat.corridors.filter((x) => x.strength >= 0.15)) assert.ok(projectOntoPolyline(p, cor.points).distance >= ON_TRAIL_M - 1e-6);
    const cor = habitat.corridors.find((x) => x.id === c.corridorId)!;
    const proj = projectOntoPolyline(p, cor.points);
    if (dot(sub(p, proj.point), downwind) > 0) downwindCount++;
  }
  assert.ok(downwindCount / candidates.length >= 0.7, `${downwindCount}/${candidates.length} downwind`);
});

test('stand offset scales with weapon range', () => {
  assert.ok(standOffsetM(25) < standOffsetM(40));
  assert.equal(standOffsetM(10), 15);
  assert.equal(standOffsetM(400), 90);
});

test('existing stands are always evaluated (never silently dropped), dismissed ones are skipped', () => {
  const mine: Stand = { id: 's-mine', propertyId: 'prop-1', name: 'Big Oak', position: at(0.8, 0.3), origin: 'existing', type: 'hang_on' };
  const gone: Stand = { ...mine, id: 's-gone', name: 'Old ladder', position: at(0.2, 0.2), dismissed: true };
  const property = fixtureProperty({ stands: [mine, gone] });
  const ctx = ctxFor(315);
  const habitat = inferHabitat(property.features, [], { phase: ctx.phase, window: ctx.window, windFromDeg: ctx.windFromDeg });
  const { candidates } = generateCandidates(property, habitat, ctx);
  assert.ok(candidates.some((c) => c.stand.id === 's-mine'), 'inside setback but still evaluated');
  assert.ok(!candidates.some((c) => c.stand.id === 's-gone'));
});

test('A* finds a path around impassable water', () => {
  const property = fixtureProperty({
    features: [userFeature('w', 'water', [at(0.4, 0.2), at(0.6, 0.2), at(0.6, 0.8), at(0.4, 0.8)], 'polygon')],
  });
  const habitat = { bedding: [], food: [], corridors: [] };
  const grid = buildCostGrid({ property, habitat, setbackM: 100, windFromDeg: 0, windSpeedMph: 10, window: 'PM' }, 'entry');
  const r = astar(grid, at(0.3, 0.5), at(0.7, 0.5))!;
  assert.ok(r);
  const water = property.features[0].geometry.points;
  assert.ok(r.path.every((p) => !pointInPolygon(p, water)));
  assert.ok(r.path.some((p) => p.y > at(0, 0.2).y || p.y < at(0, 0.8).y), 'went around');
});

test('PM entry avoids bedding; separate exit avoids the field after dark', () => {
  const property = fixtureProperty();
  const habitat = inferHabitat(property.features, [], { phase: 'early_season', window: 'PM', windFromDeg: 0 });
  const planner = createRoutePlanner({ property, habitat, setbackM: 200, windFromDeg: 0, windSpeedMph: 10, window: 'PM' });
  const stand = at(0.6, 0.55); // in the oak flat, north of the field
  const { entry, exit } = planner.plan(stand);
  assert.ok(entry && exit);
  assert.equal(entry.startLabel, 'Field gate');
  assert.ok(entry.minDistToBeddingM > 100, `entry ${entry.minDistToBeddingM}`);
  const field = property.features.find((f) => f.type === 'ag_field')!.geometry.points;
  const deepInField = exit.points.filter((p) => pointInPolygon(p, field) && projectOntoPolyline(p, [...field, field[0]]).distance > 15);
  assert.equal(deepInField.length, 0, 'exit after dark should not cut across the field');
  for (const s of [...entry.segments, ...exit.segments]) assert.ok(s.points.length >= 2);
});

test('routes start from the nearest road when no access point is mapped', () => {
  const property = fixtureProperty();
  property.features = property.features.filter((f) => f.type !== 'access_point');
  const habitat = inferHabitat(property.features, [], { phase: 'pre_rut', window: 'AM', windFromDeg: 315 });
  const planner = createRoutePlanner({ property, habitat, setbackM: 120, windFromDeg: 315, windSpeedMph: 10, window: 'AM' });
  const { entry } = planner.plan(at(0.5, 0.5));
  assert.ok(entry);
  assert.match(entry.notes.join(' '), /inferred/);
});

test('scoring components stay within their caps', () => {
  const property = fixtureProperty();
  const habitat = inferHabitat(property.features, [], { phase: 'pre_rut', window: 'PM', windFromDeg: 315 });
  const ctx = standContext(at(0.6, 0.45), habitat, 35);
  const comps = [
    scoreWindFit(90, 0, false, [], false),
    scoreWindFit(0, 30, true, ['x', 'y'], false),
    scoreAccess(null, null, true),
    scoreBeddingDistance(ctx, 120),
    scoreShot(ctx, 35, true),
    scoreWeatherTime(weather({ tempF: -20 }), '2026-11-07', 'PM', 'pre_rut', ctx, [], false),
  ];
  for (const c of comps) assert.ok(c.value >= 0 && c.value <= c.max, `${c.key}=${c.value}`);
  assert.equal(scoreWindFit(90, 0, false, [], false).value, 25);
});

test('bedding distance rewards the setback band and punishes intrusion', () => {
  const property = fixtureProperty();
  const habitat = inferHabitat(property.features, [], { phase: 'pre_rut', window: 'PM', windFromDeg: 315 });
  const ridge = habitat.bedding.find((b) => b.kind === 'buck')!;
  const inside = scoreBeddingDistance(standContext(ridge.center, habitat, 35), 120);
  const band = scoreBeddingDistance(standContext({ x: ridge.center.x, y: ridge.center.y - ridge.radiusM - 180 }, habitat, 35), 120);
  assert.ok(inside.value < band.value);
  assert.equal(band.value, 10);
});

test('shot score is zero beyond range or toward a road', () => {
  const property = fixtureProperty();
  const habitat = inferHabitat(property.features, [], { phase: 'pre_rut', window: 'PM', windFromDeg: 315 });
  const ctx = standContext(at(0.6, 0.45), habitat, 35);
  if (ctx.corridors.length) assert.equal(scoreShot(ctx, 35, false).value, 0);
  const far = standContext(at(0.6, 0.45), { ...habitat, corridors: [] }, 35);
  assert.equal(scoreShot(far, 35, true).value, 0);
});

test('pressure history: fresh beats over-hunted; bumped deer costs points', () => {
  const s: Stand = { id: 's', propertyId: 'p', name: 'x', position: { x: 0, y: 0 }, origin: 'existing', type: 'hang_on' };
  const now = Date.parse('2026-11-07T12:00:00Z');
  const sit = (d: string): PressureEvent => ({ id: d, propertyId: 'p', at: d, kind: 'sit', standId: 's' });
  assert.equal(scorePressure(s.position, s, [], now).value, 5);
  assert.equal(scorePressure(s.position, s, [sit('2026-11-01T12:00:00Z'), sit('2026-11-03T12:00:00Z'), sit('2026-11-05T12:00:00Z')], now).value, 1);
  assert.equal(scorePressure(s.position, s, [sit('2026-09-01T12:00:00Z')], now).value, 5, 'old sits age out');
  const bump: PressureEvent = { id: 'b', propertyId: 'p', at: '2026-11-06T12:00:00Z', kind: 'bumped_deer', position: { x: 50, y: 0 } };
  assert.equal(scorePressure(s.position, s, [bump], now).value, 3);
});

test('moon and pressure are low-confidence, capped, and damped by observed data', () => {
  const m = moonModifier(new Date('2024-04-23T23:49:00Z'), 'AM');
  const p = pressureModifier(weather({ pressureTrend: 'rising', pressureChange3hHpa: 3 }));
  assert.equal(m.tag, 'low_confidence');
  assert.equal(p.tag, 'low_confidence');
  const raw = combinedModifierPoints([m, p], false);
  assert.ok(Math.abs(raw) <= 0.75);
  assert.equal(combinedModifierPoints([m, p], true), raw * OBSERVED_DATA_DAMPING);
  const property = fixtureProperty();
  const habitat = inferHabitat(property.features, [], { phase: 'pre_rut', window: 'PM', windFromDeg: 315 });
  const ctx = standContext(at(0.6, 0.45), habitat, 35);
  const c = scoreWeatherTime(weather(), '2026-11-07', 'PM', 'pre_rut', ctx, [m, p], true);
  assert.ok(c.tags.includes('low_confidence'));
  assert.ok(c.reasons.some((r) => r.includes('outranks')));
});

test('dist helper sanity for fixtures', () => {
  assert.ok(Math.abs(dist(at(0, 0.5), at(1, 0.5)) - 1400) < 1e-6);
});

test('dismissed generated stands are never proposed again', () => {
  const property = fixtureProperty();
  const ctx = ctxFor(315);
  const habitat = inferHabitat(property.features, [], { phase: ctx.phase, window: ctx.window, windFromDeg: ctx.windFromDeg });
  const first = generateCandidates(property, habitat, ctx).candidates.filter((c) => c.stand.origin === 'generated');
  const victim = first[0].stand.position;
  const again = generateCandidates({ ...property, dismissedCandidatePositions: [victim] }, habitat, ctx).candidates;
  assert.ok(again.every((c) => dist(c.stand.position, victim) >= 40));
});

// --- Reachability, access constraints and route judging ---------------------------

const emptyHabitat = () => ({ bedding: [], food: [], corridors: [] }) as HabitatSummary;
/** 800×800 m property, boundary 0..800, with the given features and constraints. */
const square = (features: MapFeature[], accessConstraints: AccessConstraint[] = []) =>
  fixtureProperty({ boundary: [{ x: 0, y: 0 }, { x: 800, y: 0 }, { x: 800, y: 800 }, { x: 0, y: 800 }], features, accessConstraints });
const routeCtx = (property: Property, habitat: HabitatSummary = emptyHabitat(), over: Partial<RouteContext> = {}): RouteContext => ({
  property,
  habitat,
  setbackM: 120,
  windFromDeg: 0,
  windSpeedMph: 10,
  window: 'PM',
  ...over,
});
const rect = (x0: number, y0: number, x1: number, y1: number) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const zone = (id: string, points: Vec[], kind: AccessConstraint['kind'] = 'no_access_zone', geometryKind: 'polygon' | 'line' | 'point' = 'polygon'): AccessConstraint => ({ id, kind, geometry: { kind: geometryKind, points } });
const crosses = (route: Vec[], poly: Vec[]) => {
  for (let i = 1; i < route.length; i++) for (let j = 0; j < poly.length; j++) if (segmentsIntersect(route[i - 1], route[i], poly[j], poly[(j + 1) % poly.length])) return true;
  return false;
};

test('parking at the farmhouse or just outside the property line still routes', () => {
  const house = userFeature('h', 'house', [{ x: 100, y: 100 }], 'point');
  const atHouse = square([house, userFeature('a', 'access_point', [{ x: 120, y: 100 }], 'point', { label: 'Park at the house' })]);
  const r1 = createRoutePlanner(routeCtx(atHouse)).plan({ x: 600, y: 600 });
  assert.ok(r1.entry && r1.exit, 'route out of the house buffer');
  assert.equal(r1.noAccess, false);
  assert.equal(r1.unreachable, false);
  // Away from the parking spot the route still keeps clear of the house.
  assert.ok(r1.entry.points.filter((p) => dist(p, { x: 120, y: 100 }) > 120).every((p) => dist(p, { x: 100, y: 100 }) >= 50));
  // The hunter's own stand 30 m from the house is reachable too.
  const farParking = square([house, userFeature('a', 'access_point', [{ x: 600, y: 600 }], 'point')]);
  const backyard = createRoutePlanner(routeCtx(farParking)).plan({ x: 100, y: 130 });
  assert.ok(backyard.entry && !backyard.unreachable);

  const shoulder = square([userFeature('a', 'access_point', [{ x: 400, y: -40 }], 'point', { label: 'Road shoulder' })]);
  const r2 = createRoutePlanner(routeCtx(shoulder)).plan({ x: 600, y: 600 });
  assert.ok(r2.entry && r2.exit, 'route in from 40 m outside the line');
  assert.ok(r2.entry.notes.some((n) => /property line/.test(n)));
  // Only the stretch by the truck may be outside the line.
  assert.ok(r2.entry.points.filter((p) => !pointInPolygon(p, shoulder.boundary!)).every((p) => dist(p, { x: 400, y: -40 }) <= 120));
});

test('a stand inside a no-access zone, or cut off by water, is unreachable (not "no access point")', () => {
  const access = userFeature('a', 'access_point', [{ x: 400, y: 20 }], 'point');
  const sanctuary = zone('z', rect(500, 500, 700, 700));
  const p = square([access], [sanctuary]);
  const inside = createRoutePlanner(routeCtx(p)).plan({ x: 600, y: 600 });
  assert.deepEqual([inside.entry, inside.exit, inside.noAccess, inside.unreachable], [null, null, false, true]);
  // Inside the zone but within a cell of its edge: still unreachable, never a route into the sanctuary.
  const edge = createRoutePlanner(routeCtx(p)).plan({ x: 505, y: 600 });
  assert.equal(edge.unreachable, true);

  const moat = square([access, userFeature('w', 'water', rect(-50, 300, 850, 360), 'polygon')]);
  const cutOff = createRoutePlanner(routeCtx(moat)).plan({ x: 400, y: 700 });
  assert.equal(cutOff.unreachable, true);
  assert.equal(cutOff.noAccess, false);
  const none = createRoutePlanner(routeCtx({ ...square([]), boundary: undefined })).plan({ x: 400, y: 700 });
  assert.deepEqual([none.noAccess, none.unreachable], [true, false]);
});

test('routes never cut across a no-access zone: no diagonal leaks, no corner cutting', () => {
  const access = userFeature('a', 'access_point', [{ x: 60, y: 60 }], 'point');
  // A 16 m wide diagonal strip (a neighbor's fenced lane) that fully separates access from stand.
  const d = 8 * Math.SQRT1_2;
  const strip = zone('lane', [{ x: -100 - d, y: 900 - d }, { x: 900 - d, y: -100 - d }, { x: 900 + d, y: -100 + d }, { x: -100 + d, y: 900 + d }]);
  const sep = createRoutePlanner(routeCtx(square([access], [strip]))).plan({ x: 600, y: 600 });
  assert.equal(sep.unreachable, true, 'no route through the strip');

  // A block the route has to walk around: no route point inside, no segment through it.
  const block = rect(250, 150, 550, 550);
  const around = createRoutePlanner(routeCtx(square([access], [zone('z', block)]))).plan({ x: 700, y: 650 });
  assert.ok(around.entry && around.exit);
  for (const r of [around.entry, around.exit]) {
    assert.ok(r.points.every((q) => !pointInPolygon(q, block)), `${r.kind} enters the zone`);
    assert.equal(crosses(r.points, block), false, `${r.kind} cuts a corner of the zone`);
  }
});

test('neighbor lines block routes; a must-use gate is where the route crosses', () => {
  const access = userFeature('a', 'access_point', [{ x: 400, y: 20 }], 'point');
  const fence = zone('n', [{ x: -20, y: 400 }, { x: 820, y: 400 }], 'neighbor_line', 'line');
  const stand = { x: 600, y: 700 };
  const blocked = createRoutePlanner(routeCtx(square([access], [fence]))).plan(stand);
  assert.equal(blocked.unreachable, true, 'fence line with no gate');

  const gate = zone('g', [{ x: 100, y: 400 }], 'must_use_gate', 'point');
  const viaGate = createRoutePlanner(routeCtx(square([access], [fence, gate]))).plan(stand);
  assert.ok(viaGate.entry && viaGate.exit);
  for (const r of [viaGate.entry, viaGate.exit]) {
    assert.ok(pointPolylineDistance({ x: 100, y: 400 }, r.points) < 20, `${r.kind} uses the gate`);
    const crossing = r.points.findIndex((q, i) => i > 0 && (q.y - 400) * (r.points[i - 1].y - 400) <= 0);
    assert.ok(crossing > 0 && Math.abs(r.points[crossing].x - 100) < 30, `${r.kind} crosses the fence at the gate`);
  }
  // Without a fence, a must-use gate is still a waypoint on the way in and out.
  const open = createRoutePlanner(routeCtx(square([access], [gate]))).plan({ x: 600, y: 300 });
  assert.ok(open.entry && pointPolylineDistance({ x: 100, y: 400 }, open.entry.points) < 20);
});

test('route judge flags scent onto feeding deer and into buck bedding on an AM entry', () => {
  const food = { id: 'f', label: 'Beans', center: { x: 0, y: 0 }, polygon: rect(-100, -100, 100, 100), radiusM: 113, probability: 0.9, kind: 'ag' as const, featureIds: [], reasons: [] };
  const withFood = { ...emptyHabitat(), food: [food] };
  const a = { x: -50, y: 140 };
  const b = { x: 50, y: 140 };
  for (const [window, kind] of [['AM', 'entry'], ['PM', 'exit']] as const) {
    const judge = makeSegmentJudge(routeCtx(square([]), withFood, { window, windFromDeg: 0 }), kind);
    assert.equal(judge(a, b).status, 'avoid', `${window} ${kind}: north wind blows scent across the field`);
    // A wind from the field toward the hunter is fine.
    assert.equal(makeSegmentJudge(routeCtx(square([]), withFood, { window, windFromDeg: 180 }), kind)(a, b).status, 'safe');
  }
  // Mid-day, deer are bedded: scent toward the field is not flagged.
  assert.equal(makeSegmentJudge(routeCtx(square([]), withFood, { window: 'PM', windFromDeg: 0 }), 'entry')(a, b).status, 'safe');
  // A long field's real outline matters: walking past its end with a crosswind is not "onto the field".
  const long = { ...food, polygon: rect(-400, -50, 400, 50), radiusM: 113 };
  const cross = makeSegmentJudge(routeCtx(square([]), { ...emptyHabitat(), food: [long] }, { window: 'AM', windFromDeg: 0 }), 'entry');
  assert.equal(cross({ x: 30, y: 130 }, { x: 90, y: 130 }).status, 'avoid', 'north wind over the field, 80 m out');
  assert.equal(cross({ x: 30, y: 175 }, { x: 90, y: 175 }).status, 'caution', '125 m out: scent drifts toward it');
  const side = makeSegmentJudge(routeCtx(square([]), { ...emptyHabitat(), food: [long] }, { window: 'AM', windFromDeg: 90 }), 'entry');
  assert.equal(side({ x: 30, y: 175 }, { x: 90, y: 175 }).status, 'safe', 'east wind carries scent west, parallel to the field');
  // 50 m off the long side (inside a same-area circle) with the wind blowing away from the field.
  const away = makeSegmentJudge(routeCtx(square([]), { ...emptyHabitat(), food: [long] }, { window: 'AM', windFromDeg: 180 }), 'entry');
  assert.equal(away({ x: -30, y: 100 }, { x: 30, y: 100 }).status, 'safe', 'south wind carries scent away from the field');

  const bed = { id: 'b', label: 'Ridge', center: { x: 0, y: 0 }, radiusM: 60, probability: 0.9, kind: 'buck' as const, featureIds: [], reasons: [] };
  const beds = { ...emptyHabitat(), bedding: [bed] };
  const w = { x: -190, y: 60 };
  const s = { x: -190, y: -60 };
  const ctx = (window: 'AM' | 'PM') => routeCtx(square([]), beds, { window, windFromDeg: 270, setbackM: 80 });
  assert.equal(makeSegmentJudge(ctx('AM'), 'entry')(w, s).status, 'avoid', 'AM entry upwind of buck bedding');
  assert.equal(makeSegmentJudge(ctx('AM'), 'exit')(w, s).status, 'avoid');
  assert.equal(makeSegmentJudge(ctx('PM'), 'exit')(w, s).status, 'caution', 'after dark the beds are mostly empty, but still flagged');
  const doe = { ...beds, bedding: [{ ...bed, kind: 'doe' as const }] };
  assert.equal(makeSegmentJudge(routeCtx(square([]), doe, { window: 'AM', windFromDeg: 270, setbackM: 80 }), 'entry')(w, s).status, 'caution');
  // Low-probability bedding (a vision bench) is judged too: one floor for all bedding.
  const bench = { ...beds, bedding: [{ ...bed, probability: BEDDING_MIN_PROB + 0.05 }] };
  assert.equal(makeSegmentJudge(routeCtx(square([]), bench, { window: 'PM', windFromDeg: 270, setbackM: 80 }), 'entry')(w, s).status, 'avoid');
});

test('entry/exit overlap is measured against the entry path, not its sample points', () => {
  // Two ponds leave a single 30 m wide dam: both walks must use it for ~800 m.
  const access = userFeature('a', 'access_point', [{ x: 30, y: 500 }], 'point');
  const ponds = [userFeature('w1', 'water', rect(100, -50, 700, 485), 'polygon'), userFeature('w2', 'water', rect(100, 515, 700, 850), 'polygon')];
  const r = createRoutePlanner(routeCtx(square([access, ...ponds]))).plan({ x: 770, y: 500 });
  assert.ok(r.entry && r.exit);
  assert.ok((r.exit.overlapWithOther ?? 0) > 0.6, `overlap ${r.exit.overlapWithOther}`);
  assert.ok(r.exit.notes.some((n) => /back along your entry/.test(n)));
  // Separate walks on open ground are not called shared.
  const open = createRoutePlanner(routeCtx(square([access]))).plan({ x: 770, y: 500 });
  assert.ok(open.entry && open.exit && (open.exit.overlapWithOther ?? 0) <= 0.6);
});

test('every kept bedding area gets its setback, including a vision bench below 0.4', () => {
  // A vision bench at confidence 0.9 → buck bedding at p = 0.36, with a field 400 m south.
  const bench = { ...userFeature('bench', 'bench', [{ x: 250, y: 600 }, { x: 550, y: 600 }], 'line'), source: 'vision' as const, confidence: 0.9 };
  const field = userFeature('field', 'ag_field', rect(150, 50, 650, 200), 'polygon');
  const property = square([bench, field, userFeature('a', 'access_point', [{ x: 20, y: 20 }], 'point')]);
  const ctx = { phase: 'early_season' as const, window: 'PM' as const, windFromDeg: 90, effectiveRangeYds: 35, setbackM: BEDDING_SETBACK_M.early_season };
  const habitat = inferHabitat(property.features, [], ctx);
  const bed = habitat.bedding.find((b) => b.featureIds.includes('bench'))!;
  assert.ok(bed && bed.probability < 0.4 && bed.probability >= BEDDING_MIN_PROB, `bench bed p=${bed?.probability}`);
  const { candidates, rejected } = generateCandidates(property, habitat, ctx);
  assert.ok(rejected.some((r) => /bedding setback/.test(r.reason)), 'some anchors fall inside the setback');
  for (const c of candidates) assert.ok(distanceToArea(c.stand.position, bed) >= ctx.setbackM - 1e-6, `${c.stand.name} ${Math.round(distanceToArea(c.stand.position, bed))} m off the bench bed`);
});

test("no generated stand inside a no-access zone; the hunter's own stand there is kept and unreachable", () => {
  const property = fixtureProperty();
  const ctx = ctxFor(315);
  const habitat = inferHabitat(property.features, [], { phase: ctx.phase, window: ctx.window, windFromDeg: ctx.windFromDeg });
  const before = generateCandidates(property, habitat, ctx).candidates;
  const target = before[0].stand.position;
  const sanctuary = rect(target.x - 150, target.y - 150, target.x + 150, target.y + 150);
  const mine: Stand = { id: 's-mine', propertyId: 'prop-1', name: 'Sanctuary ladder', position: { x: target.x + 10, y: target.y }, origin: 'existing', type: 'ladder' };
  const fenced = { ...property, stands: [mine], accessConstraints: [zone('z', sanctuary)] };
  const { candidates, rejected } = generateCandidates(fenced, habitat, ctx);
  const generated = candidates.filter((c) => c.stand.origin === 'generated');
  assert.ok(generated.length > 0);
  assert.ok(generated.every((c) => !pointInPolygon(c.stand.position, sanctuary)));
  assert.ok(rejected.some((r) => r.reason === 'Inside a no-access zone you marked'));
  assert.ok(candidates.some((c) => c.stand.id === 's-mine'), 'never silently dropped');
  const routes = createRoutePlanner(routeCtx(fenced, habitat, { windFromDeg: 315 })).plan(mine.position);
  assert.deepEqual([routes.entry, routes.noAccess, routes.unreachable], [null, false, true]);
  const access = scoreAccess(routes.entry, routes.exit, routes.noAccess, routes.unreachable);
  assert.equal(access.value, 0);
  assert.match(access.reasons[0], /No legal walking route/);
});

test('access score: unreachable is 0, an unmapped access point is a neutral 8', () => {
  const unreachable = scoreAccess(null, null, false, true);
  assert.equal(unreachable.value, 0);
  assert.ok(!/Mark where you park/.test(unreachable.reasons.join(' ')));
  const unmapped = scoreAccess(null, null, true);
  assert.equal(unmapped.value, 8);
  assert.match(unmapped.reasons[0], /Mark where you park/);
});

test('bedding distance checks the bed whose setback the stand presses hardest, not just the closest', () => {
  // Early season (200 m setback): doe bedding 130 m W (doe setback 120 m), buck bedding 150 m E.
  const bed = (id: string, kind: 'buck' | 'doe', x: number) => ({ id, label: id, center: { x, y: 0 }, radiusM: 50, probability: 0.8, kind, featureIds: [], reasons: [] });
  const habitat = { ...emptyHabitat(), bedding: [bed('doe', 'doe', -180), bed('buck', 'buck', 200)] };
  const ctx = standContext({ x: 0, y: 0 }, habitat, 35);
  assert.equal(ctx.nearestBedding?.area.id, 'buck');
  assert.equal(Math.round(ctx.nearestBedding!.distanceM), 150);
  const score = scoreBeddingDistance(ctx, 200);
  assert.ok(score.value < 10, `${score.value}`);
  assert.match(score.reasons[0], /inside the 200 m setback/);
  // Far from both: the closer-to-setback bed is still the one reported.
  const far = standContext({ x: 0, y: 600 }, habitat, 35);
  assert.ok(far.nearestBedding);
});
