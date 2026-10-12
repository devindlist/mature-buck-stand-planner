import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferBedding, inferCorridors, inferFood, inferHabitat } from './habitat.ts';
import { at, fixtureFeatures, userFeature } from '../test/fixtures.ts';
import type { Sighting } from '../models.ts';

test('mock farm: ridge thicket with a bench is buck bedding, cedar thicket near the field is doe bedding', () => {
  const beds = inferBedding(fixtureFeatures(), []);
  const ridge = beds.find((b) => b.label === 'Ridge thicket');
  const cedar = beds.find((b) => b.label === 'Cedar thicket');
  assert.ok(ridge && cedar);
  assert.equal(ridge.kind, 'buck');
  assert.equal(cedar.kind, 'doe');
  assert.ok(ridge.probability > cedar.probability);
});

test('user-marked bedding outranks detections, and dismissed features are ignored', () => {
  const fs = fixtureFeatures().map((f) => (f.label === 'Ridge thicket' ? { ...f, status: 'dismissed' as const } : f));
  fs.push(userFeature('u1', 'bedding', [at(0.5, 0.1)], 'point', { attributes: { beddingKind: 'buck' } }));
  const beds = inferBedding(fs, []);
  assert.ok(!beds.some((b) => b.label === 'Ridge thicket'));
  const mine = beds.find((b) => b.featureIds.includes('u1'));
  assert.ok(mine && mine.probability >= 0.9 && mine.kind === 'buck');
});

test('cover near roads is downgraded', () => {
  const cover = userFeature('c', 'thick_cover', [at(0.5, 0.9), at(0.6, 0.9), at(0.6, 0.93), at(0.5, 0.93)], 'polygon', { confidence: 0.8, source: 'vision' });
  const road = userFeature('r', 'road', [at(0, 0.96), at(1, 0.96)], 'line');
  const remote = userFeature('c2', 'thick_cover', [at(0.5, 0.1), at(0.6, 0.1), at(0.6, 0.13), at(0.5, 0.13)], 'polygon', { confidence: 0.8, source: 'vision' });
  const beds = inferBedding([cover, road, remote], []);
  const near = beds.find((b) => b.featureIds.includes('c'))!;
  const far = beds.find((b) => b.featureIds.includes('c2'))!;
  assert.ok(near.probability < far.probability);
});

test('observed bedded mature buck creates or boosts bedding', () => {
  const s: Sighting = { id: 's1', propertyId: 'p', at: '2026-11-01T15:00:00Z', position: at(0.5, 0.05), maturity: 'mature_buck', count: 1, behavior: 'bedded', source: 'observed' };
  const beds = inferBedding(fixtureFeatures(), [s]);
  assert.ok(beds.some((b) => b.id === 'bed-sighting-s1' && b.kind === 'buck'));
});

test('food value follows the season: acorns peak in October, standing beans in late season', () => {
  const fs = fixtureFeatures();
  const oakLull = inferFood(fs, 'october_lull').find((f) => f.kind === 'mast')!;
  const oakLate = inferFood(fs, 'late_season').find((f) => f.kind === 'mast');
  assert.ok(!oakLate || oakLull.probability > oakLate.probability);
  const beans = fs.map((f) => (f.type === 'ag_field' ? { ...f, attributes: { crop: 'soybeans_standing' as const } } : f));
  const late = inferFood(beans, 'late_season').find((f) => f.kind === 'ag')!;
  const lock = inferFood(beans, 'lockdown').find((f) => f.kind === 'ag')!;
  assert.ok(late.probability > lock.probability);
});

test('corridors: bed→food dominates early season; cruising routes appear in the rut', () => {
  const fs = fixtureFeatures();
  const early = inferHabitat(fs, [], { phase: 'early_season', window: 'PM', windFromDeg: 315 });
  const rut = inferHabitat(fs, [], { phase: 'seeking_chasing', window: 'PM', windFromDeg: 315 });
  const strongestB2F = (h: typeof early) => Math.max(0, ...h.corridors.filter((c) => c.kind === 'bed_to_food').map((c) => c.strength));
  assert.ok(strongestB2F(early) > strongestB2F(rut));
  assert.ok(!early.corridors.some((c) => c.kind === 'cruise'));
  assert.ok(rut.corridors.some((c) => c.kind === 'cruise'));
  assert.ok(rut.corridors.some((c) => c.kind === 'bed_to_bed'));
});

test('downwind cruise line sits on the downwind side of doe bedding and moves with the wind', () => {
  const fs = fixtureFeatures();
  const beds = inferBedding(fs, []);
  const food = inferFood(fs, 'seeking_chasing');
  const doe = beds.find((b) => b.kind === 'doe')!;
  const nw = inferCorridors(fs, beds, food, { phase: 'seeking_chasing', window: 'PM', windFromDeg: 315 }).find((c) => c.kind === 'cruise')!;
  const se = inferCorridors(fs, beds, food, { phase: 'seeking_chasing', window: 'PM', windFromDeg: 135 }).find((c) => c.kind === 'cruise')!;
  const mid = (c: typeof nw) => ({ x: (c.points[0].x + c.points[1].x) / 2, y: (c.points[0].y + c.points[1].y) / 2 });
  // NW wind → scent to SE → cruise line SE of the bedding.
  assert.ok(mid(nw).x > doe.center.x && mid(nw).y < doe.center.y);
  assert.ok(mid(se).x < doe.center.x && mid(se).y > doe.center.y);
});

test('corridors route through pinch points and carry readable labels', () => {
  const h = inferHabitat(fixtureFeatures(), [], { phase: 'pre_rut', window: 'PM', windFromDeg: 315 });
  assert.ok(h.corridors.some((c) => c.pinchPoints.length > 0));
  for (const c of h.corridors) assert.ok(c.label.length > 0);
  const b2f = h.corridors.find((c) => c.kind === 'bed_to_food');
  assert.ok(b2f && b2f.fromLabel && b2f.toLabel);
});
