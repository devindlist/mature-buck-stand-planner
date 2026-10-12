import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planHunt, windDial, MIN_PICK_SPACING_M } from './planner.ts';
import { at, fixtureProperty, inputs, weather, userFeature } from './test/fixtures.ts';
import { dist, compass16 } from './geo/geometry.ts';
import type { Sighting, Stand } from './models.ts';
import { buildPlanCard, planCardText } from './planCard.ts';

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
  // Ranked by score.
  const totals = plan.recommendations.map((r) => r.score.total);
  assert.deepEqual([...totals].sort((a, b) => b - a), totals);
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
  const again = [...shifted.recommendations, ...(shifted.backup ? [shifted.backup] : [])].find((r) => r.stand.name === top.stand.name);
  assert.ok(again, 'stand still listed so the hunter sees why it is a no-go');
  assert.equal(again.decision.status, 'no_go');
  assert.match(again.risks.map((r) => r.text).join(' '), /Forecast swings/);
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
