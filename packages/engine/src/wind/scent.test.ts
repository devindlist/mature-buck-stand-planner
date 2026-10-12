import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGate, scentModel, windMargin, windSpreadHalfAngle, directionSpread, type SensitiveArea } from './scent.ts';
import { circlePolygon } from '../geo/geometry.ts';
import { GridTerrain, slopeFromFeatures, slopeFromTerrain } from '../terrain/terrain.ts';

// Bedding 200 m due EAST of the stand.
const bedding: SensitiveArea = { id: 'b', kind: 'bedding', label: 'buck bedding', shape: circlePolygon({ x: 200, y: 0 }, 50), closed: true, hardRangeM: 400 };
const stand = { x: 0, y: 0 };

test('west wind blows scent east into bedding → eliminated', () => {
  const m = scentModel({ windFromDeg: 270, windSpeedMph: 10, windGustMph: 12 }, null, 'PM');
  const g = evaluateGate(stand, m, [bedding]);
  assert.equal(g.passes, false);
  assert.equal(g.hits[0].area.id, 'b');
});

test('east wind blows scent away from bedding → passes', () => {
  const m = scentModel({ windFromDeg: 90, windSpeedMph: 10, windGustMph: 12 }, null, 'PM');
  assert.equal(evaluateGate(stand, m, [bedding]).passes, true);
});

test('crosswind passes, but gusts widen the cone until it fails', () => {
  // North wind, scent goes south; bedding is 90° off-axis.
  const steady = scentModel({ windFromDeg: 0, windSpeedMph: 10, windGustMph: 10 }, null, 'PM');
  assert.equal(evaluateGate(stand, steady, [bedding]).passes, true);
  // A wind from NNE (30°) sends scent SSW: still clear. Make bedding closer to the axis instead.
  const offAxis: SensitiveArea = { ...bedding, shape: circlePolygon({ x: 120, y: -200 }, 30) }; // ~149° from stand
  const gustless = scentModel({ windFromDeg: 0, windSpeedMph: 10, windGustMph: 10 }, null, 'PM');
  assert.equal(evaluateGate(stand, gustless, [offAxis]).passes, true);
  const gusty = scentModel({ windFromDeg: 0, windSpeedMph: 10, windGustMph: 35, directionSpreadDeg: 30 }, null, 'PM');
  assert.equal(evaluateGate(stand, gusty, [offAxis]).passes, false);
});

test('half-angle grows with gust spread and forecast swing, clamped', () => {
  assert.equal(windSpreadHalfAngle({ windFromDeg: 0, windSpeedMph: 10, windGustMph: 10 }), 15);
  assert.ok(windSpreadHalfAngle({ windFromDeg: 0, windSpeedMph: 10, windGustMph: 20 }) > 15);
  assert.equal(windSpreadHalfAngle({ windFromDeg: 0, windSpeedMph: 10, windGustMph: 90, directionSpreadDeg: 180 }), 60);
});

test('beyond hard range is a soft (caution) hit, not elimination', () => {
  const food: SensitiveArea = { id: 'f', kind: 'food', label: 'the field', shape: circlePolygon({ x: 300, y: 0 }, 40), closed: true, hardRangeM: 200 };
  const m = scentModel({ windFromDeg: 270, windSpeedMph: 10, windGustMph: 10 }, null, 'PM');
  const g = evaluateGate(stand, m, [food]);
  assert.equal(g.passes, true);
  assert.equal(g.hits.length, 1);
  assert.equal(g.hits[0].hard, false);
});

test('thermals apply only in light wind and only on slopes', () => {
  const slope = { downslopeBearingDeg: 90, slopePct: 12, source: 'elevation' as const };
  const strong = scentModel({ windFromDeg: 90, windSpeedMph: 12, windGustMph: 14 }, slope, 'PM');
  assert.equal(strong.thermalsApplied, false);
  assert.equal(strong.plumes.length, 1);
  const light = scentModel({ windFromDeg: 90, windSpeedMph: 3, windGustMph: 4 }, slope, 'PM');
  assert.equal(light.thermalsApplied, true);
  assert.ok(light.plumes.some((p) => p.kind === 'thermal_falling' && p.bearingDeg === 90));
  assert.ok(light.plumes.some((p) => p.kind === 'thermal_rising' && p.bearingDeg === 270));
  // Falling thermals drain scent downhill (east) into the bedding even though the light wind is from the east.
  assert.equal(evaluateGate(stand, light, [bedding]).passes, false);
  const flat = scentModel({ windFromDeg: 90, windSpeedMph: 3, windGustMph: 4 }, { ...slope, slopePct: 1 }, 'PM');
  assert.equal(flat.thermalsApplied, false);
});

test('calm air with unknown terrain swirls in every direction', () => {
  const m = scentModel({ windFromDeg: 0, windSpeedMph: 0.5, windGustMph: 1 }, null, 'AM');
  assert.ok(m.plumes.some((p) => p.kind === 'swirl'));
  const close: SensitiveArea = { ...bedding, shape: circlePolygon({ x: -90, y: 0 }, 20) };
  assert.equal(evaluateGate(stand, m, [close]).passes, false);
});

test('wind margin measures how far the wind can swing', () => {
  // Fails when the wind comes from 240..300 (scent into the east bedding).
  const passes = (from: number) => {
    const m = scentModel({ windFromDeg: from, windSpeedMph: 10, windGustMph: 10 }, null, 'PM');
    return evaluateGate(stand, m, [bedding]).passes;
  };
  assert.equal(windMargin(passes, 270), 0);
  assert.equal(windMargin(passes, 90), 90);
  const m = windMargin(passes, 180);
  assert.ok(m > 20 && m < 75, `${m}`);
});

test('direction spread is the largest swing in the forecast', () => {
  assert.equal(directionSpread(300, [290, 320, 350]), 50);
  assert.equal(directionSpread(10, [350]), 20);
});

test('slope from an elevation grid and from mapped features', () => {
  // Plane rising to the north: z = 100 + 0.1*y → downslope is south (180°), 10%.
  const cols = 21;
  const rows = 21;
  const values: number[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) values.push(100 + 0.1 * (r * 10 - 100));
  const t = new GridTerrain({ x: -100, y: -100 }, 10, cols, rows, values);
  const s = slopeFromTerrain(t, { x: 0, y: 0 })!;
  assert.ok(Math.abs(s.downslopeBearingDeg - 180) < 1e-6);
  assert.ok(Math.abs(s.slopePct - 10) < 1e-6);
  const fs = slopeFromFeatures(
    [{ id: 'r', type: 'ridge', geometry: { kind: 'line', points: [{ x: -200, y: 80 }, { x: 200, y: 80 }] }, confidence: 1, source: 'user', status: 'active' }],
    { x: 0, y: 0 },
  )!;
  assert.equal(fs.downslopeBearingDeg, 180, 'ridge to the north → downhill is south');
  assert.equal(fs.source, 'features');
});
