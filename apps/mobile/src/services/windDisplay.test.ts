import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WeatherSnapshot } from '@msp/engine';
import { badgeLabel, badgeScreen, draftBadgeWind, observedWindFresh, OBSERVED_WIND_TTL_MIN, planBadgeWind } from './windDisplay.ts';

const wx = (o: Partial<WeatherSnapshot> = {}): WeatherSnapshot => ({
  id: 'w',
  at: '2026-11-07T21:00:00.000Z',
  source: 'nws',
  windFromDeg: 315,
  windSpeedMph: 9,
  windGustMph: 14,
  tempF: 38,
  precipType: 'none',
  pressureTrend: 'steady',
  overriddenFields: [],
  ...o,
});
const settled = { current: true, loading: false };

test('the badge follows the plan on Results, the plan card and Hunt, and the draft everywhere else', () => {
  assert.equal(badgeScreen('/hunt'), 'hunt');
  assert.equal(badgeScreen('/hunt/'), 'hunt');
  assert.equal(badgeScreen('/results'), 'plan');
  assert.equal(badgeScreen('/results?standId=1'), 'plan');
  assert.equal(badgeScreen('/plan-card'), 'plan');
  assert.equal(badgeScreen('/plan'), 'draft', 'Plan Hunt edits the draft');
  assert.equal(badgeScreen('/'), 'draft');
  assert.equal(badgeScreen(null), 'draft');
  assert.equal(badgeScreen(undefined), 'draft');
});

test('a settled forecast for this sit is drawn as a plain wind', () => {
  const w = draftBadgeWind(wx(), {}, settled);
  assert.deepEqual(w, { kind: 'wind', fromDeg: 315, speedMph: 9, own: false, stale: undefined, from: 'draft' });
});

test('placeholder defaults are never drawn as a wind until the hunter sets one', () => {
  const placeholder = wx({ placeholder: true, source: 'manual' });
  assert.deepEqual(draftBadgeWind(placeholder, {}, settled), { kind: 'defaults', loading: false });
  assert.deepEqual(draftBadgeWind(placeholder, {}, { current: true, loading: true }), { kind: 'defaults', loading: true });
  // The hunter taps a direction: now it is theirs, so it is a wind (and marked as theirs).
  const w = draftBadgeWind(placeholder, { windFromDeg: 90 }, settled);
  assert.equal(w.kind, 'wind');
  if (w.kind === 'wind') {
    assert.equal(w.fromDeg, 90);
    assert.equal(w.own, true);
  }
  assert.deepEqual(draftBadgeWind(null, {}, settled), { kind: 'none' });
});

test('a forecast for another sit, or one still loading, is marked stale rather than shown as current', () => {
  const other = draftBadgeWind(wx(), {}, { current: false, loading: false });
  assert.ok(other.kind === 'wind' && other.stale === 'other_sit');
  const loading = draftBadgeWind(wx(), {}, { current: false, loading: true });
  assert.ok(loading.kind === 'wind' && loading.stale === 'loading');
});

test('the hunter’s own direction stands on its own, and never borrows a speed from the wrong sit', () => {
  const w = draftBadgeWind(wx(), { windFromDeg: 180 }, { current: false, loading: false });
  assert.ok(w.kind === 'wind');
  if (w.kind === 'wind') {
    assert.equal(w.fromDeg, 180);
    assert.equal(w.stale, undefined, 'their own wind is not stale');
    assert.equal(w.speedMph, undefined, 'the forecast speed belongs to another sit');
    assert.equal(w.own, true);
  }
  const both = draftBadgeWind(wx(), { windFromDeg: 180, windSpeedMph: 14 }, { current: false, loading: false });
  assert.ok(both.kind === 'wind' && both.speedMph === 14);
});

test('the plan badge: an observed wind at the tree wins; placeholders are defaults; hunter entries are marked', () => {
  assert.deepEqual(planBadgeWind(wx(), { fromDeg: 45 }), { kind: 'wind', fromDeg: 45, own: true, from: 'observed' });
  assert.deepEqual(planBadgeWind(null), { kind: 'none' });
  assert.deepEqual(planBadgeWind(wx({ placeholder: true })), { kind: 'defaults', loading: false });
  const plain = planBadgeWind(wx());
  assert.ok(plain.kind === 'wind' && plain.own === false && plain.from === 'plan' && plain.speedMph === 9);
  const edited = planBadgeWind(wx({ overriddenFields: ['windFromDeg'] }));
  assert.ok(edited.kind === 'wind' && edited.own === true);
  assert.ok((planBadgeWind(wx({ source: 'manual' })) as { own: boolean }).own, 'manual conditions are the hunter’s');
});

test('a wind tapped at the tree is trusted for three hours, then not', () => {
  const now = Date.parse('2026-11-07T20:00:00Z');
  const ago = (min: number) => new Date(now - min * 60_000).toISOString();
  assert.equal(OBSERVED_WIND_TTL_MIN, 180);
  assert.equal(observedWindFresh(undefined, now), false);
  assert.equal(observedWindFresh(ago(5), now), true);
  assert.equal(observedWindFresh(ago(179), now), true);
  assert.equal(observedWindFresh(ago(181), now), false);
  assert.equal(observedWindFresh('not a date', now), false);
});

test('the spoken label always names where the wind is from and what is uncertain', () => {
  assert.match(badgeLabel({ kind: 'none' }), /not set/);
  assert.match(badgeLabel({ kind: 'defaults', loading: false }), /not confirmed/);
  assert.match(badgeLabel({ kind: 'defaults', loading: true }), /loading/);
  const w = badgeLabel({ kind: 'wind', fromDeg: 315, speedMph: 9, own: false, from: 'draft' });
  assert.match(w, /Wind from NW, at 9 miles per hour\. Scent blows SE\./);
  assert.match(badgeLabel({ kind: 'wind', fromDeg: 315, speedMph: 1, own: false, from: 'draft' }), /1 mile per hour/);
  assert.match(badgeLabel({ kind: 'wind', fromDeg: 315, own: true, from: 'draft' }), /speed unknown.*Set by you/);
  assert.match(badgeLabel({ kind: 'wind', fromDeg: 315, speedMph: 9, own: false, from: 'plan' }), /^Plan wind from NW/);
  assert.match(badgeLabel({ kind: 'wind', fromDeg: 45, own: true, from: 'observed' }), /^Your wind at the tree from NE/);
  assert.match(badgeLabel({ kind: 'wind', fromDeg: 315, speedMph: 9, own: false, stale: 'other_sit', from: 'draft' }), /different sit/);
  assert.match(badgeLabel({ kind: 'wind', fromDeg: 315, speedMph: 9, own: false, stale: 'loading', from: 'draft' }), /still loading/);
});
