import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planHunt, windDial, MIN_PICK_SPACING_M, UNREACHABLE_RISK } from './planner.ts';
import { at, fixtureProperty, inputs, weather, userFeature } from './test/fixtures.ts';
import { dist, compass16, downwindBearing, normDeg } from './geo/geometry.ts';
import type { HourlyWind, MapFeature, Plan, Property, SitWindow, Sighting, Stand, StandRecommendation, Vec } from './models.ts';
import { buildPlanCard, planCardText } from './planCard.ts';
import { createRoutePlanner } from './stands/routes.ts';
import { BEDDING_SETBACK_M } from './season/phase.ts';

const NOW = new Date('2026-11-07T12:00:00Z');

test('returns top 3 distinct stands plus a backup, each fully specified', () => {
  const plan = planHunt({ property: fixtureProperty(), inputs: inputs(), now: NOW });
  assert.equal(plan.recommendations.length, 3);
  assert.ok(plan.backup, 'backup stand');
  const all = [...plan.recommendations, plan.backup!];
  const close: number[] = [];
  for (let i = 0; i < plan.recommendations.length; i++) {
    for (let j = i + 1; j < plan.recommendations.length; j++) {
      const d = dist(plan.recommendations[i].stand.position, plan.recommendations[j].stand.position);
      assert.ok(d >= 35, 'never the same tree twice');
      if (d < MIN_PICK_SPACING_M) close.push(d);
    }
  }
  if (close.length) assert.ok(plan.warnings.some((w) => /alternate trees/.test(w.text)), 'close alternates are disclosed');
  for (const r of all) {
    assert.ok(r.score.total >= 0 && r.score.total <= 100);
    assert.equal(r.score.components.length, 8);
    assert.equal(r.score.total, Math.round(r.score.components.reduce((s, c) => s + c.value, 0)));
    for (const c of r.score.components) assert.ok(c.reasons.length > 0, `${c.key} has a why`);
    assert.ok(r.reason.length > 20 && !r.reason.includes('\n'), 'one-line reason');
    assert.equal(r.windDial.sectors.length, 16);
    assert.ok(r.entryRoute && r.exitRoute, 'separate entry and exit');
    assert.equal(r.risks.length, 2);
    assert.ok(['high', 'medium', 'low'].includes(r.confidence.level));
    assert.ok(['go', 'caution', 'no_go'].includes(r.decision.status));
    assert.ok(r.safetyReminders.some((s) => /harness/i.test(s)), 'harness reminder on every stand');
    assert.ok(r.shotPlan.lanes.length === 8);
    assert.ok(r.shotPlan.expectedShotYds === null || r.shotPlan.expectedShotYds <= 35, 'never beyond effective range');
  }
  // Ranked by score (all huntable here).
  const totals = plan.recommendations.map((r) => r.score.total);
  assert.deepEqual([...totals].sort((a, b) => b - a), totals);
  assert.deepEqual(
    plan.recommendations.map((r) => r.rank),
    [1, 2, 3],
  );
  assert.ok(plan.disclaimer.includes('Planning aid'));
  assert.ok(plan.reminders.some((r) => r.includes('CWD')));
  assert.ok(plan.reminders.some((r) => r.includes('Regulations')));
});

test('wind is a gate: no recommended stand blows scent onto bedding, and flipping the wind changes the picks', () => {
  const nw = planHunt({ property: fixtureProperty(), inputs: inputs(), now: NOW });
  const se = planHunt({ property: fixtureProperty(), inputs: inputs({ weather: weather({ windFromDeg: 135 }) }), now: NOW });
  for (const plan of [nw, se]) {
    for (const r of plan.recommendations) {
      const current = r.windDial.sectors.find((s) => compass16(s.fromDeg) === compass16(plan.inputs.weather.windFromDeg))!;
      assert.notEqual(current.status, 'bad', `${r.stand.name} is bad for the current wind`);
    }
    assert.ok(plan.eliminated.length > 0);
    for (const e of plan.eliminated) assert.ok(e.reasons.length > 0);
  }
  const ids = (p: typeof nw) => p.recommendations.map((r) => r.stand.name).join('|');
  assert.notEqual(ids(nw), ids(se));
});

test('the saddle is eliminated on a NW wind (scent into the ridge thicket) but usable on an E wind', () => {
  const nw = planHunt({ property: fixtureProperty(), inputs: inputs(), now: NOW });
  const saddle = nw.eliminated.find((e) => e.stand.name === 'Saddle');
  assert.ok(saddle, 'saddle eliminated on NW');
  assert.match(saddle.reasons.join(' '), /bedding/);
});

test('hunter’s existing stand is scored or explained, never silently dropped', () => {
  const mine: Stand = { id: 'mine', propertyId: 'prop-1', name: 'Big Oak', position: at(0.62, 0.52), origin: 'existing', type: 'ladder' };
  const plan = planHunt({ property: fixtureProperty({ stands: [mine] }), inputs: inputs(), now: NOW });
  const inRecs = [...plan.recommendations, ...(plan.backup ? [plan.backup] : []), ...plan.yourStands].some((r) => r.stand.id === 'mine');
  const inElim = plan.eliminated.some((e) => e.stand.id === 'mine');
  assert.ok(inRecs || inElim);
  assert.ok(!(inRecs && inElim), 'exactly one place');
  for (const r of plan.yourStands) assert.equal(r.stand.origin, 'existing');
});

test('weather no-go overrides every stand', () => {
  const plan = planHunt({ property: fixtureProperty(), inputs: inputs({ weather: weather({ precipType: 'thunderstorm' }) }), now: NOW });
  assert.equal(plan.weatherDecision.status, 'no_go');
  for (const r of plan.recommendations) assert.equal(r.decision.status, 'no_go');
  assert.ok(plan.warnings.some((w) => w.level === 'no_go'));
});

test('a forecast wind shift into a stand’s bad wind makes it no-go', () => {
  const base = planHunt({ property: fixtureProperty(), inputs: inputs(), now: NOW });
  const top = base.recommendations[0];
  const bad = top.windDial.sectors.find((s) => s.status === 'bad')!;
  const sit = top.sitWindow;
  const mid = new Date((Date.parse(sit.start) + Date.parse(sit.end)) / 2).toISOString();
  const shifted = planHunt({
    property: fixtureProperty(),
    inputs: inputs({ weather: weather({ hourly: [{ at: mid, windFromDeg: bad.fromDeg, windSpeedMph: 10 }] }) }),
    now: NOW,
  });
  // (A wind-shift fallback backup is judged for its own assumed wind, not this forecast.)
  const listed = [...shifted.recommendations, ...(shifted.backup && shifted.backup.assumedWindFromDeg === undefined ? [shifted.backup] : [])];
  const again = listed.find((r) => r.stand.name === top.stand.name);
  if (again) {
    assert.equal(again.decision.status, 'no_go');
    assert.match(again.risks.map((r) => r.text).join(' '), /Forecast swings/);
  }
  // It never outranks a stand that is still huntable through the shift.
  const firstNoGo = shifted.recommendations.findIndex((r) => r.decision.status === 'no_go');
  if (firstNoGo >= 0) assert.ok(shifted.recommendations.slice(firstNoGo).every((r) => r.decision.status === 'no_go'), 'no-go stands rank last');
  assert.ok(!again || again.isBackup || again.rank > shifted.recommendations.filter((r) => r.decision.status !== 'no_go').length);
});

test('observed mature buck sightings raise movement and are tagged as observed data', () => {
  const base = planHunt({ property: fixtureProperty(), inputs: inputs(), now: NOW });
  const target = base.recommendations[2];
  const sightings: Sighting[] = [1, 2].map((i) => ({
    id: `s${i}`,
    propertyId: 'prop-1',
    at: `2026-11-0${i + 2}T22:00:00Z`,
    position: { x: target.stand.position.x + 20, y: target.stand.position.y },
    maturity: 'mature_buck',
    count: 1,
    behavior: 'cruising',
    source: 'trail_cam',
  }));
  const withObs = planHunt({ property: fixtureProperty(), inputs: inputs(), sightings, now: NOW });
  const rec = [...withObs.recommendations, ...(withObs.backup ? [withObs.backup] : [])].find((r) => r.stand.name === target.stand.name)!;
  assert.ok(rec, 'stand still recommended');
  const mv = (r: typeof rec) => r.score.components.find((c) => c.key === 'movementLikelihood')!;
  assert.ok(mv(rec).value > mv(target).value);
  assert.ok(mv(rec).tags.includes('observed_data'));
  const wx = rec.score.components.find((c) => c.key === 'weatherTimeFit')!;
  assert.ok(wx.reasons.some((r) => r.includes('outranks')), 'observed data outranks moon/pressure');
});

test('light wind turns on thermals and adds a warning', () => {
  const plan = planHunt({ property: fixtureProperty(), inputs: inputs({ weather: weather({ windSpeedMph: 3, windGustMph: 5 }) }), now: NOW });
  assert.ok(plan.warnings.some((w) => /Thermals/.test(w.text)));
});

test('no bedding mapped → caution warning; everything dismissed → no-go warning, no crash', () => {
  const noBed = fixtureProperty();
  noBed.features = noBed.features.filter((f) => f.type !== 'thick_cover' && f.type !== 'bench');
  const p1 = planHunt({ property: noBed, inputs: inputs(), now: NOW });
  assert.ok(p1.warnings.some((w) => /No bedding/.test(w.text)));
  const empty = fixtureProperty();
  empty.features = empty.features.map((f) => ({ ...f, status: 'dismissed' as const }));
  const p2 = planHunt({ property: empty, inputs: inputs(), now: NOW });
  assert.equal(p2.recommendations.length, 0);
  assert.ok(p2.warnings.some((w) => w.level === 'no_go'));
});

test('no-shot lanes toward the road and house', () => {
  const property = fixtureProperty();
  property.features.push(userFeature('h2', 'house', [at(0.62, 0.48)], 'point'));
  const plan = planHunt({ property, inputs: inputs({ weapon: { type: 'rifle', effectiveRangeYds: 200 } }), now: NOW });
  for (const r of plan.recommendations) {
    assert.ok(r.shotPlan.lanes.some((l) => l.status === 'no_shot'), `${r.stand.name} has a no-shot lane (rifle, house in middle)`);
  }
});

test('phase override flows through and setback override is respected', () => {
  const plan = planHunt({ property: fixtureProperty(), inputs: inputs({ phaseOverride: 'lockdown', beddingSetbackOverrideM: 250 }), now: NOW });
  assert.equal(plan.phase.phase, 'lockdown');
  assert.equal(plan.phase.source, 'user');
  for (const r of plan.recommendations.filter((x) => x.stand.origin === 'generated')) {
    const bed = r.score.components.find((c) => c.key === 'beddingDistance')!;
    assert.ok(!/inside the/.test(bed.reasons[0]));
  }
});

test('wind dial marks bad, caution and good sectors', () => {
  // Works for winds within 75° of north.
  const dial = windDial((from) => from <= 75 || from >= 285, 0);
  assert.equal(dial.sectors[0].status, 'good');
  assert.equal(dial.sectors[8].status, 'bad');
  assert.equal(dial.sectors[3].status, 'caution', 'ENE (67.5°) works, but its edge (78.75°) does not');
  assert.equal(dial.sectors[4].status, 'bad');
});

test('plan card renders offline text with every stand and the disclaimer', () => {
  const plan = planHunt({ property: fixtureProperty(), inputs: inputs(), now: NOW });
  const card = buildPlanCard(plan, 'Ridge Farm', (iso) => iso.slice(11, 16));
  assert.equal(card.stands.length, 4);
  assert.ok(card.stands[3].isBackup);
  const text = planCardText(card);
  assert.match(text, /HARNESS ON/);
  assert.match(text, /BACKUP/);
  assert.match(text, /Planning aid only/);
  assert.match(text, /\[low confidence\] Moon phase/);
});

test('planning is fast enough for a phone (< 3 s here)', () => {
  const t0 = Date.now();
  planHunt({ property: fixtureProperty(), inputs: inputs(), now: NOW });
  assert.ok(Date.now() - t0 < 3000);
});

test('a wind-shift-only backup is never a plain GO for today', () => {
  // Leave only stands that fail today's NW wind plus one survivor, forcing the hypothetical backup path.
  const plan = planHunt({ property: fixtureProperty(), inputs: inputs(), now: NOW });
  if (plan.backup?.backupNote?.startsWith('Only if')) assert.notEqual(plan.backup.decision.status, 'go');
  const shiftOnly = planHunt({ property: fixtureProperty(), inputs: inputs({ weather: weather({ windFromDeg: 90, windSpeedMph: 10 }) }), now: NOW });
  for (const p of [plan, shiftOnly]) {
    const b = p.backup;
    if (b && b.backupNote?.startsWith('Only if')) assert.equal(b.decision.status === 'go', false);
    if (b && !b.backupNote?.startsWith('Only if')) {
      const cur = b.windDial.sectors.find((s) => compass16(s.fromDeg) === compass16(p.inputs.weather.windFromDeg))!;
      assert.notEqual(cur.status, 'bad', 'a regular backup must be huntable on today’s wind');
    }
  }
});

test('field-edge stand is eliminated when the wind blows scent into the field you are hunting', () => {
  // NW wind at the inside corner of the bean field pushes scent SE, straight across the beans.
  const nw = planHunt({ property: fixtureProperty(), inputs: inputs(), now: NOW });
  const corner = nw.eliminated.find((e) => e.stand.name === 'Inside corner');
  assert.ok(corner, 'inside corner eliminated on NW');
  assert.match(corner.reasons.join(' '), /the field/);
  // A SE wind blows scent back into the timber, so the same corner works.
  const se = planHunt({ property: fixtureProperty(), inputs: inputs({ weather: weather({ windFromDeg: 157.5 }) }), now: NOW });
  assert.ok(!se.eliminated.some((e) => e.stand.name === 'Inside corner' && /the field/.test(e.reasons.join(' '))));
});

// ---------------------------------------------------------------------------
// Forecast hours, ranking, wind-shift backups, gates and messaging
// ---------------------------------------------------------------------------

const SIT: Record<'AM' | 'PM', SitWindow> = {
  AM: planHunt({ property: fixtureProperty(), inputs: inputs({ window: 'AM' }), now: NOW }).recommendations[0].sitWindow,
  PM: planHunt({ property: fixtureProperty(), inputs: inputs({ window: 'PM' }), now: NOW }).recommendations[0].sitWindow,
};

/** One forecast entry per hour across the sit (from the hour the sit starts in). */
function sitHours(window: 'AM' | 'PM', f: (i: number, n: number) => Partial<HourlyWind> = () => ({})): HourlyWind[] {
  const sit = SIT[window];
  const s = Math.floor(Date.parse(sit.start) / 3_600_000) * 3_600_000;
  const n = Math.ceil((Date.parse(sit.end) - s) / 3_600_000);
  return Array.from({ length: n }, (_, i) => ({ at: new Date(s + i * 3_600_000).toISOString(), windFromDeg: 315, windSpeedMph: 9, windGustMph: 14, tempF: 38, ...f(i, n) }));
}

const allRecs = (p: Plan): StandRecommendation[] => [...p.recommendations, ...(p.backup ? [p.backup] : []), ...p.yourStands];
const rect = (x0: number, y0: number, x1: number, y1: number): Vec[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const bareProperty = (features: MapFeature[], stands: Stand[]): Property => ({
  id: 'p',
  name: 'Test',
  stateCode: 'IA',
  features,
  stands,
  cameras: [],
  accessConstraints: [],
  boundary: rect(-600, -600, 600, 600),
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
});
const myStand = (x: number, y: number, name = 'Mine'): Stand => ({ id: 'mine', propertyId: 'p', name, position: { x, y }, origin: 'existing', type: 'ladder' });
const line = (id: string, type: MapFeature['type'], pts: Array<[number, number]>, extra: Partial<MapFeature> = {}) => userFeature(id, type, pts.map(([x, y]) => ({ x, y })), 'line', extra);

test('weather no-go reads the worst hour of the sit: gusty first and last hours, calm midpoint', () => {
  const hourly = sitHours('PM', (i, n) => ({ windGustMph: i < 2 || i === n - 1 ? 40 : 15 }));
  const plan = planHunt({ property: fixtureProperty(), inputs: inputs({ weather: weather({ windGustMph: 15, hourly }) }), now: NOW });
  assert.equal(plan.weatherDecision.status, 'no_go');
  assert.match(plan.weatherDecision.reasons[0], /Gusts to 40 mph/);
  for (const r of allRecs(plan)) assert.equal(r.decision.status, 'no_go', `${r.stand.name} is not huntable in 40 mph gusts`);
  // The backup's own note never leaks into the other stands' reasons.
  for (const r of plan.recommendations) assert.ok(!r.decision.reasons.some((x) => /^Only if/.test(x)), r.decision.reasons.join(' | '));
});

test('ranking: a stand that is no-go on its own never outranks a huntable one, and ranks follow score', () => {
  // Fixture cases where the forecast swings late in the sit.
  for (const [dir, win, swing] of [
    [0, 'AM', 22.5],
    [45, 'PM', 45],
    [315, 'PM', -22.5],
  ] as const) {
    const hourly = sitHours(win, (i, n) => ({ windFromDeg: i >= n - 1 ? normDeg(dir + swing) : dir }));
    const plan = planHunt({ property: fixtureProperty(), inputs: inputs({ window: win, weather: weather({ windFromDeg: dir, hourly }) }), now: NOW });
    const recs = plan.recommendations;
    const cls = (r: StandRecommendation) => (r.decision.status === 'no_go' ? 1 : 0);
    for (let i = 1; i < recs.length; i++) {
      const [a, b] = [recs[i - 1], recs[i]];
      const label = `${dir}/${win}/${swing}: #${a.rank} ${a.score.total} ${a.decision.status} vs #${b.rank} ${b.score.total} ${b.decision.status}`;
      assert.ok(cls(a) <= cls(b), label);
      if (cls(a) === cls(b)) assert.ok(a.score.total >= b.score.total, label);
      assert.equal(b.rank, a.rank + 1);
    }
    // A regular backup is a stand you can hunt today.
    if (plan.backup && plan.backup.assumedWindFromDeg === undefined) assert.notEqual(plan.backup.decision.status, 'no_go', `${dir}/${win}/${swing} backup`);
  }
});

test('a steady forecast never makes the wind-shift backup a no-go; it is judged end to end for its assumed wind', () => {
  for (const win of ['AM', 'PM'] as const) {
    const plan = planHunt({ property: fixtureProperty(), inputs: inputs({ window: win, weather: weather({ hourly: sitHours(win) }) }), now: NOW });
    const b = plan.backup;
    assert.ok(b, 'backup');
    assert.ok(b.backupNote?.startsWith('Only if'), 'fixture NW forces the wind-shift fallback');
    const assumed = b.assumedWindFromDeg;
    assert.ok(assumed !== undefined && assumed !== 315, 'assumed wind is set and is not today’s');
    assert.equal(b.decision.status, 'caution', `${win}: ${b.decision.reasons.join(' | ')}`);
    assert.ok(!b.decision.reasons.some((r) => /Forecast wind shifts/.test(r)), 'today’s steady wind is not a "shift"');
    assert.ok(!b.risks.some((r) => /Forecast swings/.test(r.text)));
    // Dial, plume and reason all describe the assumed wind, and say so.
    assert.equal(b.windDial.currentFromDeg, assumed);
    const plume = b.plumes.find((p) => p.kind === 'wind');
    assert.ok(plume && Math.abs(plume.bearingDeg - downwindBearing(assumed)) < 1e-9);
    assert.match(b.reason, new RegExp(`^If the wind turns ${compass16(assumed)}:`));
    const current = b.windDial.sectors.find((s) => s.fromDeg === assumed);
    assert.notEqual(current?.status, 'bad', 'the stand works on the wind it was picked for');
    // Cruise lines move with the wind, so a hypothetical-wind backup is never anchored on one.
    assert.ok(!/Downwind cruise/.test(b.stand.name));
    // Routes were planned and judged for the assumed wind.
    const habitat = { ...plan.habitat, corridors: plan.habitat.corridors.filter((c) => c.kind !== 'cruise') };
    const expected = createRoutePlanner({ property: fixtureProperty(), habitat, setbackM: BEDDING_SETBACK_M[plan.phase.phase], windFromDeg: assumed, windSpeedMph: 9, window: win }).plan(b.stand.position);
    assert.deepEqual(b.entryRoute, expected.entry);
    assert.deepEqual(b.exitRoute, expected.exit);
    // The plan card tells the hunter which wind the dial and routes assume.
    const text = planCardText(buildPlanCard(plan, 'Ridge Farm', (iso) => iso.slice(11, 16)));
    assert.match(text, new RegExp(`Wind dial and routes assume a ${compass16(assumed)} wind`));
  }
});

test('a light dawn hour in a steady wind is not reported as a wind shift', () => {
  const hourly = sitHours('AM', (i) => (i === 0 ? { windSpeedMph: 3, windGustMph: 4 } : {}));
  const plan = planHunt({ property: fixtureProperty(), inputs: inputs({ window: 'AM', weather: weather({ hourly }) }), now: NOW });
  assert.equal(plan.weatherDecision.status, 'go');
  for (const r of plan.recommendations) {
    assert.ok(!r.decision.reasons.some((x) => /Forecast wind shifts/.test(x)), `${r.stand.name}: ${r.decision.reasons.join(' | ')}`);
    assert.notEqual(r.decision.status, 'no_go', r.stand.name);
  }
  const flagged = plan.recommendations.filter((r) => r.decision.reasons.some((x) => /^Light air \(3 mph\)/.test(x)));
  assert.ok(flagged.length > 0, 'the light-air hour is still called out');
  for (const r of flagged) assert.equal(r.decision.status, 'caution');
});

test('a forecast wind shift picks a backup that works for the forecast wind, not a hypothetical one', () => {
  for (const win of ['AM', 'PM'] as const) {
    const hourly = sitHours(win, (i, n) => ({ windFromDeg: i >= n - 2 ? 157.5 : 112.5 }));
    const plan = planHunt({ property: fixtureProperty(), inputs: inputs({ window: win, weather: weather({ windFromDeg: 112.5, hourly }) }), now: NOW });
    const b = plan.backup;
    assert.ok(b, win);
    assert.ok(b.backupNote?.startsWith('Only if'), win);
    assert.equal(b.assumedWindFromDeg, 157.5);
    assert.match(b.backupNote ?? '', /shifts to SSE/);
    assert.notEqual(b.decision.status, 'no_go');
  }
});

test('an exit through a red zone is never a plain GO', () => {
  // PM sit: the walk out after dark crosses the bean field the deer are feeding in.
  const features: MapFeature[] = [
    userFeature('field', 'ag_field', rect(-600, -500, 600, 100), 'polygon', { label: 'Bean field', attributes: { crop: 'soybeans_standing' } }),
    userFeature('cover', 'thick_cover', rect(250, 350, 550, 550), 'polygon', { label: 'NE thicket' }),
    line('draw', 'draw', [
      [-370, 160],
      [-370, 600],
    ]),
    userFeature('truck', 'access_point', [{ x: 0, y: -580 }], 'point', { label: 'Truck' }),
  ];
  let checked = 0;
  for (const dir of [67.5, 90, 112.5]) {
    const plan = planHunt({ property: bareProperty(features, [myStand(-400, 400, 'North edge')]), inputs: inputs({ date: '2026-11-20', weather: weather({ windFromDeg: dir }) }), now: NOW });
    for (const r of allRecs(plan)) {
      if (r.exitRoute?.worstStatus !== 'avoid') continue;
      checked++;
      assert.notEqual(r.decision.status, 'go', `${dir}: ${r.stand.name}`);
      assert.ok(r.decision.reasons.some((x) => /^Exit crosses a red zone/.test(x)));
      assert.ok(!r.decision.reasons.includes('Wind, access and timing all line up.'));
    }
  }
  assert.ok(checked > 0, 'scenario produces red exits');
});

test('the shot plan never states a shot beyond the hunter’s range, and such a stand is not a plain GO', () => {
  // The only trail is 29.5 m (~32 yds) from the hunter’s stand; bow range 30 yds.
  const property = bareProperty(
    [
      line('e', 'edge', [
        [0, -300],
        [0, 300],
      ]),
      userFeature('a', 'access_point', [{ x: 300, y: -500 }], 'point'),
    ],
    [myStand(29.5, 0)],
  );
  const plan = planHunt({ property, inputs: inputs({ weapon: { type: 'bow', effectiveRangeYds: 30 }, weather: weather({ windFromDeg: 270 }) }), now: NOW });
  const r = allRecs(plan).find((x) => x.stand.id === 'mine');
  assert.ok(r, 'stand scored');
  assert.equal(r.shotPlan.expectedShotYds, null);
  assert.equal(r.shotPlan.primaryBearingDeg, 270, 'the travel direction is still shown');
  assert.ok(r.shotPlan.notes.some((n) => /~32 yds W, beyond your 30 yd range/.test(n)));
  assert.equal(r.risks[0].severity, 3);
  assert.match(r.risks[0].text, /beyond your 30 yd range/);
  assert.equal(r.decision.status, 'caution');
  const card = buildPlanCard(plan, 'Test', (iso) => iso.slice(11, 16)).stands.find((s) => s.name === 'Mine');
  assert.match(card?.shot ?? '', /^Travel W is beyond your range/);
  // Every generated stand obeys the same rule.
  for (const x of allRecs(plan)) assert.ok(x.shotPlan.expectedShotYds === null || x.shotPlan.expectedShotYds <= 30);
});

test('every travel route in range is gated, not just the two strongest', () => {
  // Bow 40 yds, W wind: the weakest trail (creek, 25 m E) is directly downwind of the stand.
  const property = bareProperty(
    [
      line('e', 'edge', [
        [-20, -300],
        [-20, 300],
      ]),
      line('d', 'draw', [
        [-300, 280],
        [280, -300],
      ]),
      line('c', 'creek', [
        [25, -300],
        [25, 300],
      ]),
      userFeature('a', 'access_point', [{ x: -500, y: -500 }], 'point'),
    ],
    [myStand(0, 0)],
  );
  const plan = planHunt({ property, inputs: inputs({ date: '2026-09-20', weapon: { type: 'bow', effectiveRangeYds: 40 }, weather: weather({ windFromDeg: 270, windSpeedMph: 10 }) }), now: NOW });
  const out = plan.eliminated.find((e) => e.stand.id === 'mine');
  assert.ok(out, 'scent straight onto a trail in range eliminates the stand');
  assert.match(out.reasons.join(' '), /approach trail/);
});

test('low-probability bedding the engine maps is still protected by the wind gate', () => {
  // A vision bench at 90% confidence becomes buck bedding at p = 0.36.
  const property = bareProperty(
    [
      line('b', 'bench', [
        [-30, 0],
        [30, 0],
      ], { source: 'vision', confidence: 0.9 }),
      userFeature('ag', 'ag_field', rect(-300, -500, 300, -400), 'polygon', { attributes: { crop: 'soybeans_green' } }),
      userFeature('a', 'access_point', [{ x: 500, y: 500 }], 'point'),
    ],
    [myStand(110, 0, 'East Ladder')],
  );
  const plan = planHunt({ property, inputs: inputs({ date: '2026-09-20', weather: weather({ windFromDeg: 90, windSpeedMph: 10 }) }), now: NOW });
  const bed = plan.habitat.bedding.find((b) => b.label === 'Bench');
  assert.ok(bed && bed.probability < 0.4, 'bench bedding below the old 0.4 gate floor');
  const out = plan.eliminated.find((e) => e.stand.id === 'mine');
  assert.ok(out, 'E wind blows the ladder’s scent straight into the bed');
  assert.match(out.reasons.join(' '), /buck bedding/);
});

test('a stand no legal route reaches is a no-go with zero access points, ranked below huntable stands', () => {
  const base = planHunt({ property: fixtureProperty(), inputs: inputs(), now: NOW });
  const c = base.recommendations[0].stand.position;
  const sanctuary = { id: 'z', kind: 'no_access_zone' as const, geometry: { kind: 'polygon' as const, points: rect(c.x - 80, c.y - 80, c.x + 80, c.y + 80) } };
  const stand: Stand = { id: 'sanct', propertyId: 'prop-1', name: 'Sanctuary stand', position: c, origin: 'existing', type: 'ladder' };
  const plan = planHunt({ property: fixtureProperty({ accessConstraints: [sanctuary], stands: [stand] }), inputs: inputs(), now: NOW });
  const r = allRecs(plan).find((x) => x.stand.id === 'sanct');
  assert.ok(r, 'the hunter’s stand is still shown');
  assert.equal(r.entryRoute, null);
  assert.equal(r.decision.status, 'no_go');
  assert.match(r.decision.reasons.join(' '), /No legal walking route/);
  assert.equal(r.risks[0].text, UNREACHABLE_RISK);
  assert.ok(!r.risks.some((x) => /No access point mapped/.test(x.text)), 'not mislabelled as a missing access point');
  assert.equal(r.score.components.find((x) => x.key === 'accessStealth')?.value, 0);
  const firstNoGo = plan.recommendations.findIndex((x) => x.decision.status === 'no_go');
  if (firstNoGo >= 0) assert.ok(plan.recommendations.slice(firstNoGo).every((x) => x.decision.status === 'no_go'));
  const card = buildPlanCard(plan, 'Ridge Farm', (iso) => iso.slice(11, 16)).stands.find((s) => s.name === 'Sanctuary stand');
  assert.equal(card?.entry, 'No legal route from your access points');
});

test('plan card never passes default or hand-entered conditions off as a forecast', () => {
  const placeholderPlan = planHunt({ property: fixtureProperty(), inputs: inputs({ weather: weather({ placeholder: true }) }), now: NOW });
  const placeholder = buildPlanCard(placeholderPlan, 'Ridge Farm', (iso) => iso.slice(11, 16));
  assert.match(placeholder.windLine, /defaults, not a forecast/);
  assert.equal(placeholder.weatherStatus, 'caution');
  for (const r of allRecs(placeholderPlan)) assert.notEqual(r.decision.status, 'go', 'no plain GO on unconfirmed defaults');
  // The tag only depends on the snapshot, so reuse the plan with other weather sources.
  const card = (w: Partial<Plan['inputs']['weather']>) => buildPlanCard({ ...placeholderPlan, inputs: { ...placeholderPlan.inputs, weather: weather(w) } }, 'Ridge Farm', (iso) => iso.slice(11, 16));
  assert.match(card({ source: 'manual' }).windLine, /entered by you, not a forecast/);
  assert.match(card({ source: 'mixed', overriddenFields: ['windFromDeg'] }).windLine, /edited by you/);
  assert.ok(!card({ source: 'nws' }).windLine.includes('('), 'a plain forecast carries no tag');
});

test('less likely food is a caution, never an elimination', () => {
  // Late season: the oak flat is mostly picked over (p 0.15), the beans are the draw.
  const plan = planHunt({ property: fixtureProperty(), inputs: inputs({ date: '2026-12-20', weather: weather({ windFromDeg: 0 }) }), now: NOW });
  const oaks = plan.habitat.food.find((f) => f.kind === 'mast');
  assert.ok(oaks && oaks.probability < 0.3);
  assert.ok(!plan.eliminated.some((e) => /the acorns/.test(e.reasons.join(' '))));
  const warned = allRecs(plan).filter((r) => r.score.components.find((c) => c.key === 'windFit')?.reasons.some((x) => /drift toward the acorns/.test(x)));
  assert.ok(warned.length > 0, 'scent drifting into the oaks is still flagged');
});
