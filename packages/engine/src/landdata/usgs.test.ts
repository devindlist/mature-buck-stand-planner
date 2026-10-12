import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchCdlCode, fetchElevationM, parseCdlValue, parseEpqs, parseNlcdFeatureInfo, toConusAlbers } from './usgs.ts';
import { shotLanes, laneFor } from '../safety/safety.ts';
import type { MapFeature } from '../models.ts';

test('EPQS parsing handles strings, numbers and no-data', () => {
  assert.equal(parseEpqs({ value: '312.55' }), 312.55);
  assert.equal(parseEpqs({ value: 280 }), 280);
  assert.equal(parseEpqs({ value: -1000000 }), undefined);
  assert.equal(parseEpqs(null), undefined);
});

test('NLCD GetFeatureInfo parsing', () => {
  assert.equal(parseNlcdFeatureInfo({ features: [{ properties: { PALETTE_INDEX: 41 } }] }), 41);
  assert.equal(parseNlcdFeatureInfo({ features: [{ properties: { GRAY_INDEX: 82 } }] }), 82);
  assert.equal(parseNlcdFeatureInfo({ features: [] }), undefined);
});

test('CropScape value parsing', () => {
  const body = '<ns1:GetCDLValueResponse><Result>{x: 182634.5, y: 2125843.5, value: 5, category: "Soybeans", color: "#267000"}</Result></ns1:GetCDLValueResponse>';
  assert.equal(parseCdlValue(body), 5);
  assert.equal(parseCdlValue('nothing'), undefined);
});

test('CONUS Albers (EPSG:5070): origin, central meridian and scale sanity', () => {
  const o = toConusAlbers({ lat: 23, lon: -96 });
  assert.ok(Math.abs(o.x) < 1e-6 && Math.abs(o.y) < 1e-6);
  const north = toConusAlbers({ lat: 41.85, lon: -96 });
  assert.ok(Math.abs(north.x) < 1e-6);
  // 18.85° of latitude ≈ 2,090 km of northing (equal-area projection distorts slightly).
  assert.ok(north.y > 2_050_000 && north.y < 2_130_000, `${north.y}`);
  const iowa = toConusAlbers({ lat: 41.85, lon: -93.3 });
  assert.ok(iowa.x > 200_000 && iowa.x < 250_000, `${iowa.x}`);
});

test('clients build the right URLs', async () => {
  const urls: string[] = [];
  const f = (async (u: string) => {
    urls.push(u);
    return new Response(u.includes('epqs') ? JSON.stringify({ value: 301.2 }) : '{value: 1, category: "Corn"}', { status: 200 });
  }) as unknown as typeof fetch;
  assert.equal(await fetchElevationM({ lat: 41.85, lon: -93.3 }, f), 301.2);
  assert.equal(await fetchCdlCode({ lat: 41.85, lon: -93.3 }, 2025, f), 1);
  assert.match(urls[0], /epqs\.nationalmap\.gov.*x=-93\.300000&y=41\.850000.*wkid=4326/);
  assert.match(urls[1], /GetCDLValue\?year=2025&x=\d+/);
});

test('shot lanes: no-shot toward a road within weapon danger distance', () => {
  const road: MapFeature = { id: 'r', type: 'road', geometry: { kind: 'line', points: [{ x: -500, y: -100 }, { x: 500, y: -100 }] }, confidence: 1, source: 'user', status: 'active' };
  const bow = shotLanes({ x: 0, y: 0 }, [road], 'bow', 30);
  assert.equal(laneFor(bow, 180).status, 'no_shot', 'road 100 m south is inside 150 yd');
  assert.equal(laneFor(bow, 0).status, 'open');
  const farRoad: MapFeature = { ...road, geometry: { kind: 'line', points: [{ x: -500, y: -400 }, { x: 500, y: -400 }] } };
  assert.equal(laneFor(shotLanes({ x: 0, y: 0 }, [farRoad], 'bow', 30), 180).status, 'open', 'bow is safe at 400 m');
  assert.equal(laneFor(shotLanes({ x: 0, y: 0 }, [farRoad], 'rifle', 200), 180).status, 'no_shot', 'rifle is not');
});
