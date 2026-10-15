import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legalHours, legalHoursFor, legalMinutes, sunTimes } from './sun.ts';
import { moonInfo } from './moon.ts';

const minutesApart = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 60_000;

test('NOAA sunrise/sunset: New York City, June 20 2024', () => {
  // Published: sunrise 5:25 AM EDT (09:25 UTC), sunset 8:31 PM EDT (00:31 UTC next day).
  const s = sunTimes('2024-06-20', 40.7128, -74.006);
  assert.ok(minutesApart(s.sunrise, '2024-06-20T09:25:00Z') <= 2, s.sunrise);
  assert.ok(minutesApart(s.sunset, '2024-06-21T00:31:00Z') <= 2, s.sunset);
});

test('day length is ~12h at the equinox and short in December (Des Moines)', () => {
  const eq = sunTimes('2026-03-20', 41.59, -93.62);
  const lenEq = (Date.parse(eq.sunset) - Date.parse(eq.sunrise)) / 3_600_000;
  assert.ok(lenEq > 12 && lenEq < 12.3, `${lenEq}`);
  const dec = sunTimes('2026-12-21', 41.59, -93.62);
  const lenDec = (Date.parse(dec.sunset) - Date.parse(dec.sunrise)) / 3_600_000;
  assert.ok(lenDec > 9 && lenDec < 9.4, `${lenDec}`);
});

test('legal hours default to 30 min either side', () => {
  const s = sunTimes('2026-11-07', 41.85, -93.3);
  const l = legalHours(s);
  assert.equal(minutesApart(l.start, s.sunrise), 30);
  assert.equal(minutesApart(l.end, s.sunset), 30);
  assert.ok(Date.parse(l.start) < Date.parse(s.sunrise));
});

test('legal hours honor the hunter’s own offsets, and the rule text says whose they are', () => {
  const s = sunTimes('2026-11-07', 41.85, -93.3);
  const l = legalHours(s, 20, 0, true);
  assert.equal(minutesApart(l.start, s.sunrise), 20);
  assert.equal(l.end, s.sunset, '0 min after sunset ends at sunset');
  assert.equal(l.rule, '20 min before sunrise to 0 min after sunset: your setting');
  // Without a setting the rule keeps the "typical, verify" wording.
  assert.match(legalHoursFor(s, {}).rule, /30 min before sunrise to 30 min after sunset \(typical/);
  // One side set, the other default.
  const half = legalHoursFor(s, { legalMinutesAfter: 15 });
  assert.equal(minutesApart(half.start, s.sunrise), 30);
  assert.equal(minutesApart(half.end, s.sunset), 15);
  assert.match(half.rule, /your setting/);
  // A typo can't move legal light by hours or backwards.
  assert.equal(legalMinutes(500), 60);
  assert.equal(legalMinutes(-10), 0);
  assert.equal(legalMinutes(Number.NaN), 30);
  assert.equal(legalMinutes(undefined), 30);
});

test('moon phase: known full and new moons', () => {
  const full = moonInfo(new Date(Date.UTC(2024, 3, 23, 23, 49))); // full moon Apr 23 2024
  assert.equal(full.name, 'full');
  assert.ok(full.illumination > 0.97);
  const newMoon = moonInfo(new Date(Date.UTC(2024, 3, 8, 18, 21))); // eclipse new moon Apr 8 2024
  assert.equal(newMoon.name, 'new');
  assert.ok(newMoon.illumination < 0.03);
});
