import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateCandidates, standOffsetM, ON_TRAIL_M } from './candidates.ts';
import { createRoutePlanner, astar, buildCostGrid } from './routes.ts';
import { inferHabitat, distanceToArea } from '../inference/habitat.ts';
import { at, fixtureProperty, userFeature } from '../test/fixtures.ts';
import { BEDDING_SETBACK_M } from '../season/phase.ts';
import { bearingVec, dist, dot, downwindBearing, pointInPolygon, projectOntoPolyline, sub } from '../geo/geometry.ts';
import { scoreAccess, scoreBeddingDistance, scorePressure, scoreShot, scoreWeatherTime, scoreWindFit, standContext, WEIGHTS } from './scoring.ts';
import type { PressureEvent, Stand } from '../models.ts';
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
    for (const b of habitat.bedding.filter((x) => x.probability >= 0.4)) {
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
