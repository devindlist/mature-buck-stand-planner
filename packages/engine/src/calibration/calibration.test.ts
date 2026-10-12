import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calibrationFromNorthAndScale,
  calibrationFromTwoPoints,
  geoToPixel,
  imageCornersGeo,
  localToPixel,
  pixelToGeo,
  pixelToLocal,
  referenceResiduals,
  scaleFromKnownDistance,
} from './calibration.ts';
import { geoToLocal, localToGeo } from '../geo/localFrame.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b} (±${eps})`);

test('north-up photo: right = east, up = north', () => {
  const cal = calibrationFromNorthAndScale({ imageWidth: 1000, imageHeight: 800, northRotationDeg: 0, metersPerPixel: 2 });
  const east = pixelToLocal(cal, { x: 600, y: 400 });
  near(east.x, 200);
  near(east.y, 0);
  const north = pixelToLocal(cal, { x: 500, y: 300 });
  near(north.x, 0);
  near(north.y, 200);
});

test('rotated photo: north arrow pointing to the right edge', () => {
  // North is 90° clockwise from photo-up, so photo-up is WEST.
  const cal = calibrationFromNorthAndScale({ imageWidth: 1000, imageHeight: 800, northRotationDeg: 90, metersPerPixel: 1 });
  const up = pixelToLocal(cal, { x: 500, y: 300 });
  near(up.x, -100);
  near(up.y, 0, 1e-9);
  const right = pixelToLocal(cal, { x: 600, y: 400 });
  near(right.x, 0, 1e-9);
  near(right.y, 100);
});

test('pixel ↔ local round-trips for arbitrary rotation', () => {
  const cal = calibrationFromNorthAndScale({ imageWidth: 1200, imageHeight: 900, northRotationDeg: 37, metersPerPixel: 1.7 });
  for (const p of [
    { x: 0, y: 0 },
    { x: 1200, y: 900 },
    { x: 333, y: 777 },
  ]) {
    const back = localToPixel(cal, pixelToLocal(cal, p));
    near(back.x, p.x, 1e-6);
    near(back.y, p.y, 1e-6);
  }
});

test('scale from a scale bar', () => {
  near(scaleFromKnownDistance({ x: 100, y: 700 }, { x: 300, y: 700 }, 500), 2.5);
  assert.throws(() => scaleFromKnownDistance({ x: 0, y: 0 }, { x: 3, y: 0 }, 100));
  assert.throws(() => scaleFromKnownDistance({ x: 0, y: 0 }, { x: 300, y: 0 }, 0));
});

test('two geo reference points solve rotation, scale and position', () => {
  const origin = { lat: 41.85, lon: -93.3 };
  // Ground truth: photo rotated 30° (north points 30° clockwise of up) at 1.25 m/px.
  const truth = calibrationFromNorthAndScale({ imageWidth: 1000, imageHeight: 800, northRotationDeg: 30, metersPerPixel: 1.25, originPixel: { x: 120, y: 650 }, originGeo: origin });
  const p2 = { x: 880, y: 140 };
  const g2 = pixelToGeo(truth, p2)!;
  const cal = calibrationFromTwoPoints({
    imageWidth: 1000,
    imageHeight: 800,
    refs: [
      { pixel: { x: 120, y: 650 }, geo: origin },
      { pixel: p2, geo: g2 },
    ],
  });
  near(cal.northRotationDeg, 30, 1e-6);
  near(cal.metersPerPixel, 1.25, 1e-9);
  assert.equal(cal.method, 'two_point_geo');
  assert.deepEqual(cal.warnings, []);
  for (const r of referenceResiduals(cal)) assert.ok(r < 0.01);
  // Any third point lands where the truth says.
  const p3 = { x: 500, y: 400 };
  const a = pixelToGeo(cal, p3)!;
  const b = pixelToGeo(truth, p3)!;
  near(a.lat, b.lat, 1e-8);
  near(a.lon, b.lon, 1e-8);
  const px = geoToPixel(cal, b)!;
  near(px.x, 500, 1e-4);
  near(px.y, 400, 1e-4);
});

test('two-point calibration warns when it disagrees with the hunter’s north and scale', () => {
  const origin = { lat: 41.85, lon: -93.3 };
  const g2 = localToGeo({ x: 600, y: 0 }, origin); // due east, 600 m
  const cal = calibrationFromTwoPoints({
    imageWidth: 1000,
    imageHeight: 800,
    refs: [
      { pixel: { x: 100, y: 400 }, geo: origin },
      { pixel: { x: 700, y: 400 }, geo: g2 },
    ],
    estimatedNorthDeg: 45,
    estimatedMetersPerPixel: 2,
  });
  near(cal.northRotationDeg, 0, 1e-6);
  near(cal.metersPerPixel, 1, 1e-3);
  assert.equal(cal.warnings.length, 2);
});

test('two-point calibration rejects degenerate input', () => {
  const g = { lat: 41.85, lon: -93.3 };
  assert.throws(() => calibrationFromTwoPoints({ imageWidth: 100, imageHeight: 100, refs: [{ pixel: { x: 10, y: 10 } }, { pixel: { x: 90, y: 90 }, geo: g }] }));
  assert.throws(() => calibrationFromTwoPoints({ imageWidth: 100, imageHeight: 100, refs: [{ pixel: { x: 10, y: 10 }, geo: g }, { pixel: { x: 12, y: 12 }, geo: localToGeo({ x: 300, y: 0 }, g) }] }));
});

test('image corners are geo-referenced in MapLibre order', () => {
  const origin = { lat: 41.85, lon: -93.3 };
  const cal = calibrationFromNorthAndScale({ imageWidth: 1000, imageHeight: 800, northRotationDeg: 0, metersPerPixel: 1, originGeo: origin });
  const [tl, tr, br, bl] = imageCornersGeo(cal)!;
  assert.ok(tl.lat > bl.lat && tr.lat > br.lat, 'top is north');
  assert.ok(tr.lon > tl.lon && br.lon > bl.lon, 'right is east');
  const w = geoToLocal(tr, origin).x - geoToLocal(tl, origin).x;
  near(w, 1000, 0.01);
});
