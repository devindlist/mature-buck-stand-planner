import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BEDDING_SETBACK_M, CORRIDOR_WEIGHTS, derivePhase, normalTempF } from './phase.ts';
import { SEASON_PHASES } from '../models.ts';

test('Midwest calendar boundaries', () => {
  const cases: Array<[string, string]> = [
    ['2026-09-15', 'early_season'],
    ['2026-10-14', 'early_season'],
    ['2026-10-15', 'october_lull'],
    ['2026-10-24', 'october_lull'],
    ['2026-10-25', 'pre_rut'],
    ['2026-11-03', 'pre_rut'],
    ['2026-11-04', 'seeking_chasing'],
    ['2026-11-12', 'seeking_chasing'],
    ['2026-11-13', 'lockdown'],
    ['2026-11-22', 'lockdown'],
    ['2026-11-23', 'post_rut'],
    ['2026-12-10', 'post_rut'],
    ['2026-12-11', 'late_season'],
    ['2027-01-15', 'late_season'],
  ];
  for (const [date, phase] of cases) assert.equal(derivePhase(date, 'IA').phase, phase, date);
});

test('override wins and is labeled as the hunter’s', () => {
  const r = derivePhase('2026-10-01', 'IL', 'seeking_chasing');
  assert.equal(r.phase, 'seeking_chasing');
  assert.equal(r.source, 'user');
});

test('non-Midwest states are flagged as not region-tuned', () => {
  const r = derivePhase('2026-11-07', 'AL');
  assert.equal(r.regionTuned, false);
  assert.match(r.note, /Midwest/);
  assert.equal(derivePhase('2026-11-07', 'wi').regionTuned, true);
});

test('out-of-season dates are noted', () => {
  assert.match(derivePhase('2026-06-01', 'IA').note, /outside typical deer seasons/);
});

test('setbacks tighten through the rut and every phase has corridor weights', () => {
  assert.ok(BEDDING_SETBACK_M.lockdown < BEDDING_SETBACK_M.pre_rut);
  assert.ok(BEDDING_SETBACK_M.pre_rut < BEDDING_SETBACK_M.early_season);
  for (const p of SEASON_PHASES) {
    assert.ok(CORRIDOR_WEIGHTS[p]);
    assert.ok(BEDDING_SETBACK_M[p] > 0);
  }
  assert.ok(CORRIDOR_WEIGHTS.seeking_chasing.cruise > CORRIDOR_WEIGHTS.early_season.cruise);
});

test('normal temps are colder in November than September', () => {
  assert.ok(normalTempF('2026-11-15', 'PM') < normalTempF('2026-09-15', 'PM'));
  assert.ok(normalTempF('2026-11-15', 'AM') < normalTempF('2026-11-15', 'PM'));
});

test('normal temps are anchored mid-month: the 15th hits the monthly normal, month ends are halfway', () => {
  // November normal high 48°F, December 34°F; PM sits shade 4°F under the high.
  assert.equal(normalTempF('2026-11-15', 'PM'), 44);
  assert.equal(normalTempF('2026-11-30', 'PM'), 37);
  // Early November is still between the October and November normals, not already November's.
  assert.ok(Math.abs(normalTempF('2026-11-01', 'PM') - (63 + (48 - 63) * (16 / 30) - 4)) < 1e-9);
  // Continuous across a month boundary, and across New Year.
  assert.ok(Math.abs(normalTempF('2026-10-31', 'AM') - normalTempF('2026-11-01', 'AM')) < 1);
  assert.ok(Math.abs(normalTempF('2026-12-31', 'AM') - normalTempF('2027-01-01', 'AM')) < 1);
  // A 38°F mid-November evening is ~6°F colder than normal (it read as normal before).
  assert.ok(normalTempF('2026-11-15', 'PM') - 38 >= 5);
});
