import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, fmtDuration, fmtWind, minutesUntil, nextSit, sitOrder, todayLocal } from './format.ts';

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);

test('todayLocal is the device’s calendar day, zero-padded', () => {
  assert.equal(todayLocal(local(2026, 11, 7, 23, 59)), '2026-11-07');
  assert.equal(todayLocal(local(2027, 1, 2)), '2027-01-02');
});

test('addDays rolls over months, years and leap days', () => {
  assert.equal(addDays('2026-11-30', 1), '2026-12-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-11-07', -7), '2026-10-31');
});

test('nextSit: this morning until it is over, then this evening, then tomorrow morning', () => {
  assert.deepEqual(nextSit(local(2026, 11, 7, 5, 30)), { date: '2026-11-07', window: 'AM' });
  assert.deepEqual(nextSit(local(2026, 11, 7, 9, 59)), { date: '2026-11-07', window: 'AM' });
  assert.deepEqual(nextSit(local(2026, 11, 7, 10, 0)), { date: '2026-11-07', window: 'PM' });
  assert.deepEqual(nextSit(local(2026, 11, 7, 17, 59)), { date: '2026-11-07', window: 'PM' });
  assert.deepEqual(nextSit(local(2026, 11, 7, 18, 0)), { date: '2026-11-08', window: 'AM' });
  assert.deepEqual(nextSit(local(2026, 12, 31, 22, 0)), { date: '2027-01-01', window: 'AM' });
});

test('nextSit uses the property’s own sun times when it has them', () => {
  const ends = { amEnd: local(2026, 11, 7, 9, 0).toISOString(), pmEnd: local(2026, 11, 7, 17, 30).toISOString() };
  assert.deepEqual(nextSit(local(2026, 11, 7, 9, 30), ends), { date: '2026-11-07', window: 'PM' });
  assert.deepEqual(nextSit(local(2026, 11, 7, 17, 45), ends), { date: '2026-11-08', window: 'AM' });
});

test('sitOrder sorts by date, then AM before PM', () => {
  const sits = [
    { date: '2026-11-08', window: 'AM' as const },
    { date: '2026-11-07', window: 'PM' as const },
    { date: '2026-11-07', window: 'AM' as const },
  ];
  assert.deepEqual(sits.sort((a, b) => sitOrder(a).localeCompare(sitOrder(b))).map((s) => `${s.date}${s.window}`), ['2026-11-07AM', '2026-11-07PM', '2026-11-08AM']);
});

test('time and wind formatting', () => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  assert.equal(minutesUntil('2026-11-07T12:30:00Z', now), 30);
  assert.equal(minutesUntil('2026-11-07T11:45:00Z', now), -15);
  assert.equal(fmtDuration(125), '2h 5m');
  assert.equal(fmtDuration(59), '59m');
  assert.equal(fmtDuration(-5), '-5m');
  assert.equal(fmtWind(315, 9), 'NW 9 mph');
  assert.equal(fmtWind(315, 9, 14), 'NW 9–14 mph');
  assert.equal(fmtWind(315, 9, 10), 'NW 9 mph', 'a 1 mph gust is not worth showing');
});
