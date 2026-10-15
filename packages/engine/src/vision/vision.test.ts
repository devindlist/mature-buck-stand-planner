import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVisionResult, visionToFeatures, VISION_JSON_SCHEMA } from './schema.ts';
import { MOCK_VISION_RESULT } from './mock.ts';
import { analyzeMapPhoto, VisionError } from './client.ts';
import { crossCheckFeatures, cropFromCdl, nlcdCheck, sampleElevationGrid, type LandDataProvider } from './crossCheck.ts';
import { calibrationFromNorthAndScale } from '../calibration/calibration.ts';
import { geoToLocal } from '../geo/localFrame.ts';
import { cropForPlanning, FOOD_SENSITIVE_MIN, inferFood } from '../inference/habitat.ts';

/** The planner's food floor for the wind gate (shared with the route judge, inference/habitat.ts). */
const FOOD_GATE_MIN = FOOD_SENSITIVE_MIN;
import type { LatLon, MapFeature } from '../models.ts';
import { FEATURE_TYPES } from '../models.ts';

test('mock result is valid against the parser with no issues', () => {
  const { result, issues } = parseVisionResult(JSON.parse(JSON.stringify(MOCK_VISION_RESULT)));
  assert.deepEqual(issues, []);
  assert.equal(result.features.length, MOCK_VISION_RESULT.features.length);
});

test('parser drops bad features but keeps good ones, and clamps values', () => {
  const { result, issues } = parseVisionResult({
    map_type: 'satellite?',
    features: [
      { type: 'ridge', geometry_kind: 'line', points: [{ x: -0.2, y: 0.5 }, { x: 1.4, y: 0.5 }], confidence: 85, label: 'R', rationale: '' },
      { type: 'unicorn', geometry_kind: 'point', points: [{ x: 0.5, y: 0.5 }], confidence: 0.5 },
      { type: 'thick_cover', geometry_kind: 'polygon', points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 }], confidence: 0.5 },
      { type: 'saddle', geometry_kind: 'point', points: [[0.3, 0.4]] },
    ],
    scale_bar_detected: true,
    scale_bar_meters: 100,
    scale_bar_points: [{ x: 0.1, y: 0.9 }],
  });
  assert.equal(result.map_type, 'unknown');
  assert.equal(result.features.length, 2);
  assert.equal(result.features[0].points[0].x, 0);
  assert.equal(result.features[0].points[1].x, 1);
  assert.equal(result.features[0].confidence, 0.85, 'percent → fraction');
  assert.equal(result.features[1].confidence, 0.5, 'missing confidence defaults to 0.5');
  assert.equal(result.scale_bar_detected, false, 'scale bar needs two points');
  assert.equal(issues.length, 2);
  assert.ok(parseVisionResult(null).issues.length > 0);
});

test('JSON schema enumerates every feature type and is strict', () => {
  const items = VISION_JSON_SCHEMA.properties.features.items;
  assert.deepEqual([...items.properties.type.enum], [...FEATURE_TYPES]);
  assert.equal(items.additionalProperties, false);
  assert.equal(VISION_JSON_SCHEMA.additionalProperties, false);
});

test('vision features convert into local meters through the calibration', () => {
  const cal = calibrationFromNorthAndScale({ imageWidth: 1000, imageHeight: 1000, northRotationDeg: 0, metersPerPixel: 1 });
  const fs = visionToFeatures(
    { ...MOCK_VISION_RESULT, features: [{ type: 'saddle', geometry_kind: 'point', points: [{ x: 1, y: 0.5 }], confidence: 0.7, label: 'S', rationale: '' }] },
    cal,
  );
  assert.equal(fs[0].geometry.points[0].x, 500);
  assert.equal(fs[0].source, 'vision');
  assert.equal(fs[0].status, 'active');
});

test('client: mock mode works offline; proxy mode reports errors clearly', async () => {
  const mock = await analyzeMapPhoto({ imageBase64: 'x', mediaType: 'image/jpeg' }, { mode: 'mock', mockDelayMs: 0 });
  assert.equal(mock.mode, 'mock');
  assert.ok(mock.result.features.length > 5);
  await assert.rejects(analyzeMapPhoto({ imageBase64: 'x', mediaType: 'image/jpeg' }, { mode: 'proxy' }), VisionError);
  const okFetch = (async () => new Response(JSON.stringify({ result: MOCK_VISION_RESULT, model: 'test-model' }), { status: 200 })) as typeof fetch;
  const proxied = await analyzeMapPhoto({ imageBase64: 'x', mediaType: 'image/jpeg' }, { mode: 'proxy', proxyUrl: 'https://proxy.example', fetchFn: okFetch });
  assert.equal(proxied.model, 'test-model');
  const errFetch = (async () => new Response(JSON.stringify({ error: 'busy' }), { status: 529 })) as typeof fetch;
  await assert.rejects(analyzeMapPhoto({ imageBase64: 'x', mediaType: 'image/jpeg' }, { mode: 'proxy', proxyUrl: 'https://p', fetchFn: errFetch }), (e: VisionError) => e.retryable && e.message === 'busy');
});

// --- Cross-check -------------------------------------------------------------

const ORIGIN: LatLon = { lat: 41.85, lon: -93.3 };
/** Synthetic terrain: an E–W ridge along y = 0 (crest 300 m), with a saddle dip at x = 0. */
function ridgeElevation(p: LatLon): number {
  const v = geoToLocal(p, ORIGIN);
  const ridge = 300 - Math.abs(v.y) * 0.15;
  const dip = 12 * Math.exp(-(v.x * v.x) / (2 * 60 * 60));
  return ridge - dip;
}

const provider: LandDataProvider = {
  elevationAt: async (p) => ridgeElevation(p),
  landCoverAt: async () => 82,
  cropAt: async () => ({ code: 1, year: 2025 }),
};

const feat = (id: string, type: MapFeature['type'], points: { x: number; y: number }[], kind: MapFeature['geometry']['kind']): MapFeature => ({
  id,
  type,
  geometry: { kind, points },
  confidence: 0.5,
  source: 'vision',
  status: 'active',
});

test('3DEP confirms a real ridge and saddle; rejects a fake ridge', async () => {
  const cal = calibrationFromNorthAndScale({ imageWidth: 1000, imageHeight: 1000, northRotationDeg: 0, metersPerPixel: 1, originGeo: ORIGIN });
  const out = await crossCheckFeatures(
    [
      feat('r', 'ridge', [{ x: -400, y: 0 }, { x: 400, y: 0 }], 'line'),
      feat('fake', 'ridge', [{ x: 300, y: -200 }, { x: 300, y: 200 }], 'line'),
      feat('s', 'saddle', [{ x: 0, y: 0 }], 'point'),
      feat('a', 'ag_field', [{ x: 0, y: -300 }, { x: 100, y: -300 }, { x: 100, y: -200 }], 'polygon'),
      feat('t', 'thick_cover', [{ x: 0, y: 300 }, { x: 100, y: 300 }, { x: 100, y: 200 }], 'polygon'),
    ],
    cal,
    provider,
    '2026-11-07',
  );
  const byId = Object.fromEntries(out.map((f) => [f.id, f]));
  assert.ok(byId.r.confidence > 0.5, 'ridge confirmed');
  assert.ok(byId.fake.confidence < 0.5, 'N–S "ridge" across a slope rejected');
  assert.ok(byId.s.confidence > 0.5, 'saddle confirmed');
  assert.ok(byId.a.confidence > 0.5, 'NLCD 82 agrees with ag field');
  assert.ok(byId.t.confidence < 0.5, 'NLCD 82 disagrees with thick cover');
  assert.equal(byId.a.attributes?.crop, 'soybeans', 'CDL 2025 corn → rotation → beans in 2026 (family only; stage is resolved at plan time)');
  assert.ok(byId.r.attributes?.crossCheck?.[0].source === '3DEP');
});

test('cross-check is a no-op without geo-reference and never touches user features', async () => {
  const cal = calibrationFromNorthAndScale({ imageWidth: 10, imageHeight: 10, northRotationDeg: 0, metersPerPixel: 1 });
  const fs = [feat('r', 'ridge', [{ x: 0, y: 0 }, { x: 1, y: 0 }], 'line')];
  assert.equal(await crossCheckFeatures(fs, cal, provider, '2026-11-07'), fs);
  const geoCal = { ...cal, originGeo: ORIGIN };
  const user = { ...fs[0], source: 'user' as const };
  const [out] = await crossCheckFeatures([user], geoCal, provider, '2026-11-07');
  assert.equal(out, user);
});

test('NLCD and CDL lookups', () => {
  assert.equal(nlcdCheck('thick_cover', 41)?.agrees, true);
  assert.equal(nlcdCheck('water', 82)?.agrees, false);
  assert.equal(nlcdCheck('ridge', 41), null);
  assert.equal(cropFromCdl(5, 2026, '2026-09-20')?.crop, 'soybeans');
  assert.equal(cropFromCdl(1, 2025, '2026-09-20')?.crop, 'soybeans', 'last year corn → beans this year');
  assert.equal(cropFromCdl(5, 2025, '2026-11-20')?.crop, 'corn', 'last year beans → corn this year');
  assert.equal(cropFromCdl(36, 2025, '2026-11-01')?.crop, 'alfalfa_clover');
  assert.equal(cropFromCdl(999, 2025, '2026-11-01'), null);
});

test('a CDL crop guessed in September keeps its food value through the season', async () => {
  const cal = calibrationFromNorthAndScale({ imageWidth: 1000, imageHeight: 1000, northRotationDeg: 0, metersPerPixel: 1, originGeo: ORIGIN });
  const field = { ...feat('a', 'ag_field', [{ x: 0, y: -300 }, { x: 300, y: -300 }, { x: 300, y: -100 }, { x: 0, y: -100 }], 'polygon'), confidence: 0.8 };
  // Calibrated 2026-09-20; CDL 2025 shows corn, so beans this year.
  const [checked] = await crossCheckFeatures([field], cal, provider, '2026-09-20');
  assert.equal(checked.attributes?.crop, 'soybeans');
  const unknown = { ...checked, attributes: { ...checked.attributes, crop: 'unknown' as const } };
  for (const phase of ['pre_rut', 'seeking_chasing', 'post_rut', 'late_season'] as const) {
    const [food] = inferFood([checked], phase);
    assert.ok(food && food.probability >= FOOD_GATE_MIN, `${phase}: ${food?.probability} must still count for the wind gate`);
    assert.ok(food.probability >= 0.75 * inferFood([unknown], phase)[0].probability, `${phase}: about as strong as an unknown crop`);
  }
  // Older builds froze 'soybeans_green' from CDL. Unconfirmed, it is read as the family…
  const legacy = { ...checked, attributes: { ...checked.attributes, crop: 'soybeans_green' as const } };
  assert.equal(cropForPlanning(legacy), 'soybeans');
  assert.ok(inferFood([legacy], 'pre_rut')[0].probability >= FOOD_GATE_MIN);
  // …but a crop the hunter set is never overridden.
  assert.equal(cropForPlanning({ ...legacy, userEdited: true }), 'soybeans_green');
  assert.equal(cropForPlanning({ ...legacy, source: 'user' }), 'soybeans_green');
});

test('elevation grid sampler produces a full grid', async () => {
  const g = await sampleElevationGrid(provider, ORIGIN, { x: 0, y: 0 }, 100, 50);
  assert.equal(g.cols, 5);
  assert.equal(g.values.length, 25);
  assert.ok(g.values.every((v) => Number.isFinite(v)));
});
