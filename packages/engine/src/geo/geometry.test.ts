import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  angleDiff,
  bearingTo,
  bearingVec,
  compass16,
  compassToDeg,
  downwindBearing,
  pointInPolygon,
  pointPolylineDistance,
  projectOntoPolyline,
  rotate,
  sectorPolygon,
  segmentsIntersect,
  shapeDistance,
  simplify,
  slicePolyline,
  polylineLength,
} from './geometry.ts';
import { geoToLocal, isInUS, localToGeo } from './localFrame.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test('bearings follow compass convention (0 = north, 90 = east)', () => {
  near(bearingTo({ x: 0, y: 0 }, { x: 0, y: 10 }), 0);
  near(bearingTo({ x: 0, y: 0 }, { x: 10, y: 0 }), 90);
  near(bearingTo({ x: 0, y: 0 }, { x: 0, y: -10 }), 180);
  near(bearingTo({ x: 0, y: 0 }, { x: -10, y: 0 }), 270);
  const v = bearingVec(90);
  near(v.x, 1);
  near(v.y, 0);
});

test('downwind is opposite the meteorological FROM direction', () => {
  assert.equal(downwindBearing(315), 135);
  assert.equal(downwindBearing(90), 270);
  assert.equal(downwindBearing(200), 20);
});

test('angleDiff wraps around north', () => {
  assert.equal(angleDiff(350, 10), 20);
  assert.equal(angleDiff(0, 180), 180);
  assert.equal(angleDiff(-90, 270), 0);
});

test('rotate turns vectors clockwise in compass terms', () => {
  const east = rotate({ x: 0, y: 1 }, 90);
  near(east.x, 1);
  near(east.y, 0);
});

test('compass labels round-trip', () => {
  assert.equal(compass16(0), 'N');
  assert.equal(compass16(314), 'NW');
  assert.equal(compass16(359), 'N');
  assert.equal(compassToDeg('WNW'), 292.5);
  assert.equal(compassToDeg('bogus'), undefined);
});

test('point-in-polygon and polygon distances', () => {
  const sq = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  assert.ok(pointInPolygon({ x: 5, y: 5 }, sq));
  assert.ok(!pointInPolygon({ x: 15, y: 5 }, sq));
  near(pointPolylineDistance({ x: 15, y: 5 }, sq, true), 5);
  assert.equal(shapeDistance([{ x: 5, y: 5 }], false, sq, true), 0);
  near(shapeDistance([{ x: 20, y: 0 }, { x: 20, y: 10 }], false, sq, true), 10);
});

test('segment intersection includes touching endpoints', () => {
  assert.ok(segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }));
  assert.ok(segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }));
  assert.ok(!segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 1 }, { x: 10, y: 1 }));
});

test('sector polygon covers its axis and not the opposite side', () => {
  const s = sectorPolygon({ x: 0, y: 0 }, 90, 20, 100);
  assert.ok(pointInPolygon({ x: 50, y: 5 }, s));
  assert.ok(!pointInPolygon({ x: -50, y: 0 }, s));
  assert.ok(!pointInPolygon({ x: 50, y: 40 }, s), 'outside the 20° half-angle');
});

test('projection and slicing along a polyline', () => {
  const line = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ];
  const p = projectOntoPolyline({ x: 110, y: 50 }, line);
  near(p.distance, 10);
  near(p.along, 150);
  const part = slicePolyline(line, 50, 150);
  near(polylineLength(part), 100);
});

test('simplify keeps corners and drops collinear points', () => {
  const pts = [
    { x: 0, y: 0 },
    { x: 1, y: 0.01 },
    { x: 2, y: 0 },
    { x: 2, y: 2 },
  ];
  assert.equal(simplify(pts, 0.1).length, 3);
});

test('local frame round-trips and US check', () => {
  const origin = { lat: 41.85, lon: -93.3 };
  const p = { lat: 41.8545, lon: -93.2912 };
  const local = geoToLocal(p, origin);
  const back = localToGeo(local, origin);
  near(back.lat, p.lat, 1e-9);
  near(back.lon, p.lon, 1e-9);
  near(local.y, 497.6, 1); // 0.0045° lat ≈ 497.6 m
  assert.ok(isInUS(origin));
  assert.ok(!isInUS({ lat: 51.5, lon: -0.12 }));
});
