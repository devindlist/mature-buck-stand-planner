import type {
  Confidence,
  Corridor,
  Decision,
  EliminatedStand,
  HabitatSummary,
  Modifier,
  Plan,
  PlanInputs,
  PlanWarning,
  PressureEvent,
  Property,
  Risk,
  ScoreComponent,
  Sighting,
  SitWindow,
  Stand,
  StandRecommendation,
  SunTimes,
  Vec,
  WindDial,
  WindDialSector,
  WeatherSnapshot,
  ShotPlan,
} from './models.ts';
import { bearingTo, circlePolygon, compass16, dist, downwindBearing, mToYds, normDeg, pointGeometryDistance, slicePolyline, polylineLength, projectOntoPolyline, round } from './geo/geometry.ts';
import { derivePhase, AM_HOLD_MIN, BEDDING_SETBACK_M, PM_SETTLE_MIN, PHASE_TACTICS } from './season/phase.ts';
import { addMinutes, legalHours, sunTimes } from './astro/sun.ts';
import { inferHabitat } from './inference/habitat.ts';
import { generateCandidates, type Candidate, effectiveSetback } from './stands/candidates.ts';
import { createRoutePlanner, type RoutePair } from './stands/routes.ts';
import { directionSpread, evaluateGate, LIGHT_WIND_MPH, scentModel, windMargin, type GateResult, type ScentModel, type SensitiveArea, type WindState } from './wind/scent.ts';
import { slopeAt, type SlopeInfo, type TerrainModel } from './terrain/terrain.ts';
import {
  relevantSightings,
  scoreAccess,
  scoreBeddingDistance,
  scoreCover,
  scoreMovement,
  scorePressure,
  scoreShot,
  scoreWeatherTime,
  scoreWindFit,
  standContext,
  totalScore,
  type StandContext,
} from './stands/scoring.ts';
import { assessWeather, DISCLAIMER, HARNESS_REMINDER, laneFor, planReminders, shotLanes, weaponSafetyReminders } from './safety/safety.ts';
import { moonModifier, pressureModifier } from './modifiers/modifiers.ts';

export const ENGINE_VERSION = '0.1.0';
export const MIN_PICK_SPACING_M = 100;
export const FOOD_SENSITIVE_MIN = 0.3;
/** A backup must be good in at least this many 22.5° wind sectors where the #1 stand is bad. */
export const MIN_BACKUP_EXTRA_SECTORS = 2;

export interface PlanRequest {
  property: Property;
  inputs: PlanInputs;
  sightings?: Sighting[];
  pressure?: PressureEvent[];
  terrain?: TerrainModel;
  now?: Date;
  planId?: string;
}

// ---------------------------------------------------------------------------
// Sit window
// ---------------------------------------------------------------------------

export function sitWindow(inputs: PlanInputs, phase: Plan['phase']['phase'], sun: SunTimes): SitWindow {
  const legal = legalHours(sun);
  if (inputs.window === 'AM') {
    const hold = AM_HOLD_MIN[phase];
    const allDay = phase === 'seeking_chasing' || phase === 'lockdown';
    return {
      start: legal.start,
      end: addMinutes(sun.sunrise, hold),
      label: allDay ? 'In by legal light; stay through midday. Rut bucks move at any hour.' : 'In by legal light; hold through the mid-morning return to bed.',
    };
  }
  const settle = PM_SETTLE_MIN[phase];
  return {
    start: addMinutes(sun.sunset, -settle),
    end: legal.end,
    label: phase === 'late_season' ? 'Settle in early afternoon on the coldest days; the last hour is prime.' : 'Settle in early and stay to the end of legal light. Mature bucks move last.',
  };
}

// ---------------------------------------------------------------------------
// Sensitive areas per stand
// ---------------------------------------------------------------------------

function baseSensitiveAreas(habitat: HabitatSummary, inputs: PlanInputs): SensitiveArea[] {
  const out: SensitiveArea[] = [];
  for (const b of habitat.bedding) {
    if (b.probability < 0.4) continue;
    out.push({
      id: b.id,
      kind: 'bedding',
      label: b.kind === 'doe' ? 'doe bedding' : b.kind === 'buck' ? 'buck bedding' : 'bedding',
      shape: b.polygon ?? circlePolygon(b.center, b.radiusM),
      closed: true,
      hardRangeM: 400,
    });
  }
  for (const f of habitat.food) {
    // Any food deer are likely to visit this sit counts: scent rolling into the field
    // you're hunting gets you busted by the first doe that steps out.
    if (f.probability < FOOD_SENSITIVE_MIN) continue;
    out.push({
      id: f.id,
      kind: 'food',
      label: f.kind === 'ag' ? 'the field' : f.kind === 'mast' ? 'the acorns' : 'the food plot',
      shape: f.polygon ?? circlePolygon(f.center, f.radiusM),
      closed: true,
      hardRangeM: inputs.window === 'PM' ? 200 : 150,
    });
  }
  return out;
}

/**
 * The deer's approach path for this sit: where they come FROM toward the stand.
 * Bed→food corridors are ordered bedding-first: PM deer come from the bedding end,
 * AM deer come from the food end. Other corridors are two-way.
 */
export function approachPaths(ctx: StandContext, window: PlanInputs['window']): SensitiveArea[] {
  const out: SensitiveArea[] = [];
  const top = [...ctx.corridors].sort((a, b) => b.corridor.strength - a.corridor.strength).slice(0, 2);
  for (const { corridor, along } of top) {
    const L = polylineLength(corridor.points);
    let from: number;
    let to: number;
    if (corridor.kind === 'bed_to_food') {
      if (window === 'PM') {
        from = 0;
        to = along + 40;
      } else {
        from = along - 40;
        to = L;
      }
    } else {
      from = along - 150;
      to = along + 150;
    }
    const shape = slicePolyline(corridor.points, from, to);
    if (shape.length >= 2) out.push({ id: `approach-${corridor.id}`, kind: 'approach', label: 'the approach trail', shape, closed: false, hardRangeM: 400 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Wind dial
// ---------------------------------------------------------------------------

export function windDial(passesAt: (fromDeg: number) => boolean, currentFromDeg: number): WindDial {
  const sectors: WindDialSector[] = [];
  for (let i = 0; i < 16; i++) {
    const c = i * 22.5;
    const ok = passesAt(c);
    const edgesOk = passesAt(normDeg(c - 11.25)) && passesAt(normDeg(c + 11.25));
    sectors.push({ fromDeg: c, status: !ok ? 'bad' : edgesOk ? 'good' : 'caution' });
  }
  return { sectors, currentFromDeg };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

interface Evaluated {
  candidate: Candidate;
  slope: SlopeInfo | null;
  model: ScentModel;
  areas: SensitiveArea[];
  gate: GateResult;
  ctx: StandContext;
  passesAt: (fromDeg: number) => boolean;
  shotPlan: ShotPlan;
  eliminatedReasons: string[];
  windOnly: boolean;
}

function describeHit(origin: Vec, h: GateResult['hits'][number]): string {
  const where = h.area.shape.reduce((best, p) => (dist(origin, p) < dist(origin, best) ? p : best), h.area.shape[0]);
  const plume = h.plume.kind === 'wind' ? 'Wind carries' : h.plume.kind === 'thermal_falling' ? 'Falling thermals carry' : h.plume.kind === 'thermal_rising' ? 'Rising thermals carry' : 'Swirling air carries';
  return `${plume} scent onto ${h.area.label} (${Math.round(h.distanceM)} m ${compass16(bearingTo(origin, where))}).`;
}

function evaluate(c: Candidate, req: PlanRequest, habitat: HabitatSummary, windState: WindState, baseAreas: SensitiveArea[]): Evaluated {
  const { inputs, property, terrain } = req;
  const p = c.stand.position;
  const slope = slopeAt(p, property.features, terrain);
  const ctx = standContext(p, habitat, inputs.weapon.effectiveRangeYds);
  const areas = [...baseAreas, ...approachPaths(ctx, inputs.window)];
  const modelFor = (fromDeg: number, speed = windState.windSpeedMph) => scentModel({ ...windState, windFromDeg: fromDeg, windSpeedMph: speed }, slope, inputs.window);
  const model = modelFor(windState.windFromDeg);
  const gate = evaluateGate(p, model, areas);
  const passesAt = (fromDeg: number) => evaluateGate(p, modelFor(fromDeg), areas).passes;

  const lanes = shotLanes(p, property.features, inputs.weapon.type, inputs.weapon.effectiveRangeYds);
  // The shot is at the travel the stand was set for; a trail directly under the stand isn't a shot plan.
  const shotTarget = ctx.corridors.find((x) => x.corridor.id === c.corridorId && x.distanceM >= 5) ?? ctx.corridors.find((x) => x.distanceM >= 5) ?? ctx.corridors[0];
  let primaryBearing: number | null = null;
  let expected: number | null = null;
  if (shotTarget) {
    const proj = projectOntoPolyline(p, shotTarget.corridor.points);
    primaryBearing = bearingTo(p, proj.point);
    expected = Math.max(5, Math.round(mToYds(proj.distance)));
  }
  const notes = [`No shots beyond ${inputs.weapon.effectiveRangeYds} yds.`];
  if (inputs.weapon.type === 'bow' || inputs.weapon.type === 'crossbow') notes.push('Broadside or quartering-away only. Let him clear the lane before drawing.');
  if (lanes.some((l) => l.status === 'no_shot')) notes.push('Red lanes point toward a road or house. Never shoot that way.');
  if (ctx.corridors.some((x) => x.distanceM < 5)) notes.push('A trail passes right under this stand. Expect close, steep shots and deer that may spot or wind you.');
  const shotPlan: ShotPlan = { effectiveRangeYds: inputs.weapon.effectiveRangeYds, expectedShotYds: expected, primaryBearingDeg: primaryBearing, lanes, notes };

  const reasons: string[] = [];
  if (!gate.passes) for (const h of gate.hits.filter((x) => x.hard)) reasons.push(describeHit(p, h));
  let windOnly = reasons.length > 0;
  if (primaryBearing !== null && laneFor(lanes, primaryBearing).status === 'no_shot') {
    reasons.push('The only shot toward deer travel points at a road or house.');
    windOnly = false;
  }
  return { candidate: c, slope, model, areas, gate, ctx, passesAt, shotPlan, eliminatedReasons: reasons, windOnly };
}

function confidenceFor(e: Evaluated, req: PlanRequest, sightingsNear: Sighting[], marginDeg: number, windState: WindState): Confidence {
  const factors: string[] = [];
  const p = e.candidate.stand.position;
  const near = req.property.features.filter((f) => f.status === 'active' && pointGeometryDistance(p, f.geometry) < 200);
  const meanConf = near.length ? near.reduce((s, f) => s + f.confidence, 0) / near.length : 0.4;
  factors.push(near.length ? `Map features nearby average ${Math.round(meanConf * 100)}% confidence.` : 'Few mapped features nearby.');
  let v = 0.25 + 0.5 * meanConf;
  if (req.property.calibration?.originGeo) {
    v += 0.05;
  } else {
    v -= 0.05;
    factors.push('Map not geo-referenced, so no elevation or land-cover cross-check.');
  }
  if (e.slope?.source === 'elevation') {
    v += 0.05;
    factors.push('Terrain from USGS 3DEP elevation.');
  }
  if (sightingsNear.some((s) => s.maturity === 'mature_buck')) {
    v += 0.1;
    factors.push('Backed by your own mature buck observations.');
  }
  const gust = windState.windGustMph - windState.windSpeedMph;
  if (windState.windSpeedMph < LIGHT_WIND_MPH) {
    v -= 0.1;
    factors.push('Light wind makes scent less predictable.');
  } else if (gust > 10) {
    v -= 0.08;
    factors.push('Gusty wind widens the scent cone.');
  }
  if (marginDeg < 20) {
    v -= 0.05;
    factors.push('Little room for a wind shift.');
  }
  v = Math.max(0.05, Math.min(0.95, v));
  return { value: round(v, 2), level: v >= 0.7 ? 'high' : v >= 0.45 ? 'medium' : 'low', factors };
}

const lower = (s?: string) => (s ? s[0].toLowerCase() + s.slice(1) : '');

export function corridorPhrase(c: Corridor): string {
  switch (c.kind) {
    case 'bed_to_food':
      return `between the ${lower(c.fromLabel)} and the ${lower(c.toLabel)}`;
    case 'bed_to_bed':
      return `on the cruising route between the ${lower(c.fromLabel)} and the ${lower(c.toLabel)}`;
    case 'cruise':
      return `downwind of the ${lower(c.fromLabel)}, where bucks scent-check does`;
    default:
      return `along the ${lower(c.label)}`;
  }
}

const PINCH_LEADS = new Set(['Saddle', 'Funnel', 'Creek crossing', 'Inside corner', 'Your stand']);

function oneLineReason(e: Evaluated, windFromDeg: number): string {
  const s = e.candidate.stand;
  const own = e.ctx.corridors.find((x) => x.corridor.id === e.candidate.corridorId);
  const c = (own ?? e.ctx.corridors[0])?.corridor;
  const lead = e.candidate.anchorLabel === 'Your stand' ? 'Your stand' : e.candidate.anchorLabel;
  const phrase = c ? corridorPhrase(c) : '';
  const what = !c ? `${s.name}, with no mapped travel in range` : PINCH_LEADS.has(lead) ? `${lead} ${phrase}` : phrase[0].toUpperCase() + phrase.slice(1);
  const bed = e.ctx.nearestBedding ? `, ${Math.round(e.ctx.nearestBedding.distanceM)} m off ${e.ctx.nearestBedding.area.kind === 'unknown' ? '' : e.ctx.nearestBedding.area.kind + ' '}bedding` : '';
  return `${what}${bed}. ${compass16(windFromDeg)} wind carries scent ${compass16(downwindBearing(windFromDeg))}, clear of the approach and bedding.`;
}

interface Scored {
  e: Evaluated;
  routes: RoutePair;
  components: ScoreComponent[];
  total: number;
  margin: number;
  sightingsNear: Sighting[];
  shiftFailures: Array<{ at: string; fromDeg: number }>;
}

function risksFor(s: Scored, req: PlanRequest, setbackM: number, windState: WindState): Risk[] {
  const risks: Risk[] = [];
  const p = s.e.candidate.stand.position;
  const { inputs } = req;
  if (s.shiftFailures.length) {
    risks.push({ severity: 3, text: `Forecast swings to ${compass16(s.shiftFailures[0].fromDeg)} during the sit, which puts scent on deer.` });
  }
  if (s.margin < 25) {
    for (const side of [1, -1]) {
      const test = normDeg(windState.windFromDeg + side * (s.margin + 5));
      const g = evaluateGate(p, scentModel({ ...windState, windFromDeg: test }, s.e.slope, inputs.window), s.e.areas);
      const hit = g.hits.find((h) => h.hard);
      if (hit) {
        risks.push({ severity: 3, text: `Thin wind margin (~${Math.round(s.margin)}°). A shift toward ${compass16(test)} puts scent on ${hit.area.label}.` });
        break;
      }
    }
  }
  const nb = s.e.ctx.nearestBedding;
  if (nb && nb.distanceM < effectiveSetback(nb.area, setbackM)) risks.push({ severity: 3, text: `Only ${Math.round(nb.distanceM)} m from bedding. One mistake on entry and he's gone for days.` });
  for (const r of [s.routes.entry, s.routes.exit]) {
    if (!r) continue;
    const bad = r.segments.find((x) => x.status === 'avoid');
    const warn = r.segments.find((x) => x.status === 'caution');
    if (bad) risks.push({ severity: 3, text: `${r.kind === 'entry' ? 'Entry' : 'Exit'}: ${bad.reason}` });
    else if (warn) risks.push({ severity: 2, text: `${r.kind === 'entry' ? 'Entry' : 'Exit'}: ${warn.reason}` });
  }
  for (const h of s.e.gate.hits.filter((x) => !x.hard)) risks.push({ severity: 2, text: `Scent may drift toward ${h.area.label} (${Math.round(h.distanceM)} m).` });
  if (s.e.model.thermalsApplied) {
    const falling = s.e.model.plumes.find((x) => x.kind === 'thermal_falling');
    if (falling) risks.push({ severity: 2, text: inputs.window === 'PM' ? `At last light, thermals pull scent downhill (${compass16(falling.bearingDeg)}).` : `Before sunrise, scent drains downhill (${compass16(falling.bearingDeg)}) until the slope warms.` });
  }
  const pressure = s.components.find((c) => c.key === 'pressureHistory');
  if (pressure && pressure.value <= 2.5) risks.push({ severity: 2, text: pressure.reasons[0] });
  if (!s.routes.entry) risks.push({ severity: 2, text: 'No access point mapped, so the entry route is unverified.' });
  const shotYds = s.e.shotPlan.expectedShotYds;
  if (shotYds !== null && shotYds > inputs.weapon.effectiveRangeYds * 0.85) risks.push({ severity: 1, text: `Expected shot (~${shotYds} yds) is near your max range.` });
  risks.push({ severity: 1, text: `Mature bucks scent-check downwind. Watch the ${compass16(downwindBearing(windState.windFromDeg))} side; that's where he'll try to wind you.` });
  risks.push({ severity: 1, text: 'Tree suitability is unverified from a photo. Confirm a straight, healthy tree with back cover.' });
  const seen = new Set<string>();
  return risks
    .sort((a, b) => b.severity - a.severity)
    .filter((r) => (seen.has(r.text) ? false : (seen.add(r.text), true)))
    .slice(0, 2);
}

function decisionFor(s: Scored, weather: Decision, windState: WindState): Decision {
  const reasons: string[] = [];
  let status: Decision['status'] = 'go';
  if (weather.status === 'no_go') return { status: 'no_go', reasons: weather.reasons };
  const raise = (st: Decision['status'], r: string) => {
    reasons.push(r);
    if (st === 'no_go' || (st === 'caution' && status === 'go')) status = st;
  };
  if (s.shiftFailures.length) raise('no_go', `Forecast wind shifts to ${compass16(s.shiftFailures[0].fromDeg)} mid-sit, a direction this stand can't handle.`);
  if (s.margin < 15) raise('caution', 'The wind barely works. Check it at the truck and again at the base of the tree.');
  if (s.routes.entry?.worstStatus === 'avoid') raise('caution', 'Entry route crosses a red zone. Only go if you can take the alternate edge.');
  if (s.total < 45) raise('caution', 'Low odds today. Consider saving this stand for a better day.');
  if (weather.status === 'caution') for (const r of weather.reasons) raise('caution', r);
  if (windState.windSpeedMph < 2) raise('caution', 'Near-calm air. Scent will pool, so expect the unexpected.');
  if (status === 'go') reasons.push('Wind, access and timing all line up.');
  return { status, reasons };
}

export function planHunt(req: PlanRequest): Plan {
  const { property, inputs } = req;
  const now = req.now ?? new Date();
  const sightings = req.sightings ?? [];
  const pressure = req.pressure ?? [];
  const w = inputs.weather;

  const phase = derivePhase(inputs.date, property.stateCode, inputs.phaseOverride);
  const setbackM = inputs.beddingSetbackOverrideM ?? BEDDING_SETBACK_M[phase.phase];
  const sun = sunTimes(inputs.date, inputs.location.lat, inputs.location.lon);
  const legal = legalHours(sun);
  const sit = sitWindow(inputs, phase.phase, sun);
  const weatherDecision = assessWeather(w);

  const hourlyInWindow = (w.hourly ?? []).filter((h) => {
    const t = Date.parse(h.at);
    return t >= Date.parse(sit.start) - 3_600_000 && t <= Date.parse(sit.end);
  });
  const windState: WindState = {
    windFromDeg: w.windFromDeg,
    windSpeedMph: w.windSpeedMph,
    windGustMph: Math.max(w.windGustMph, w.windSpeedMph),
    directionSpreadDeg: directionSpread(w.windFromDeg, hourlyInWindow.map((h) => h.windFromDeg)),
  };

  const habitat = inferHabitat(property.features, sightings, { phase: phase.phase, window: inputs.window, windFromDeg: w.windFromDeg });
  const { candidates } = generateCandidates(property, habitat, {
    phase: phase.phase,
    window: inputs.window,
    windFromDeg: w.windFromDeg,
    effectiveRangeYds: inputs.weapon.effectiveRangeYds,
    setbackM,
  });
  const baseAreas = baseSensitiveAreas(habitat, inputs);
  const evaluated = candidates.map((c) => evaluate(c, req, habitat, windState, baseAreas));
  const survivors = evaluated.filter((e) => e.eliminatedReasons.length === 0);
  const eliminated: EliminatedStand[] = evaluated.filter((e) => e.eliminatedReasons.length > 0).map((e) => ({ stand: e.candidate.stand, reasons: e.eliminatedReasons }));

  const routePlanner = createRoutePlanner(
    { property, habitat, setbackM, windFromDeg: w.windFromDeg, windSpeedMph: w.windSpeedMph, window: inputs.window },
    candidates.map((c) => c.stand.position),
  );
  const maxCorridorStrength = habitat.corridors.reduce((m, c) => Math.max(m, c.strength), 0);
  const midSit = new Date((Date.parse(sit.start) + Date.parse(sit.end)) / 2);
  const modifiers: Modifier[] = [moonModifier(midSit, inputs.window), pressureModifier(w)];
  const nowMs = now.getTime();

  const scoreOne = (e: Evaluated, ws: WindState, weather: WeatherSnapshot): Scored => {
    const p = e.candidate.stand.position;
    const margin = windMargin(e.passesAt, ws.windFromDeg);
    const routes = routePlanner.plan(p);
    const sightingsNear = relevantSightings(p, sightings, nowMs);
    const softHits = e.gate.hits.filter((h) => !h.hard).map((h) => `Scent may drift toward ${h.area.label} ${Math.round(h.distanceM)} m out.`);
    const components = [
      scoreWindFit(margin, Math.max(0, ws.windGustMph - ws.windSpeedMph), ws.windSpeedMph < LIGHT_WIND_MPH, softHits, e.model.thermalsApplied),
      scoreAccess(routes.entry, routes.exit, routes.noAccess),
      scoreMovement(e.ctx, maxCorridorStrength, sightingsNear, phase.phase, inputs.window),
      scoreBeddingDistance(e.ctx, setbackM),
      scoreShot(e.ctx, inputs.weapon.effectiveRangeYds, e.shotPlan.primaryBearingDeg === null || laneFor(e.shotPlan.lanes, e.shotPlan.primaryBearingDeg).status === 'open'),
      scoreCover(p, property.features, e.candidate.stand),
      scorePressure(p, e.candidate.stand, pressure, nowMs),
      scoreWeatherTime(weather, inputs.date, inputs.window, phase.phase, e.ctx, modifiers, sightingsNear.length > 0),
    ];
    if (e.candidate.stand.origin === 'existing') components[0].reasons.push('Your existing stand. Scored with the same rules.');
    const shiftFailures = hourlyInWindow
      .filter((h) => {
        const g = evaluateGate(p, scentModel({ windFromDeg: h.windFromDeg, windSpeedMph: h.windSpeedMph, windGustMph: h.windGustMph ?? h.windSpeedMph }, e.slope, inputs.window), e.areas);
        return !g.passes;
      })
      .map((h) => ({ at: h.at, fromDeg: h.windFromDeg }));
    return { e, routes, components, total: totalScore(components).total, margin, sightingsNear, shiftFailures };
  };

  const scored = survivors.map((e) => scoreOne(e, windState, w)).sort((a, b) => b.total - a.total);

  const build = (s: Scored, rank: number, isBackup: boolean, ws: WindState, backupNote?: string): StandRecommendation => ({
    stand: s.e.candidate.stand,
    rank,
    isBackup,
    backupNote,
    score: totalScore(s.components),
    reason: oneLineReason(s.e, ws.windFromDeg),
    sitWindow: sit,
    windDial: windDial(s.e.passesAt, ws.windFromDeg),
    entryRoute: s.routes.entry,
    exitRoute: s.routes.exit,
    shotPlan: s.e.shotPlan,
    risks: risksFor(s, req, setbackM, ws),
    confidence: confidenceFor(s.e, req, s.sightingsNear, s.margin, ws),
    decision: decisionFor(s, weatherDecision, ws),
    safetyReminders: [HARNESS_REMINDER, ...weaponSafetyReminders(inputs.weapon.type)],
    plumes: scentModel(ws, s.e.slope, inputs.window).plumes.map(({ kind, bearingDeg, halfAngleDeg, lengthM }) => ({ kind, bearingDeg, halfAngleDeg, lengthM })),
  });

  // Top 3, kept at least 100 m apart so the hunter gets real alternatives, not one spot three times.
  const picked: Scored[] = [];
  for (const s of scored) {
    if (picked.length === 3) break;
    if (picked.every((p) => dist(p.e.candidate.stand.position, s.e.candidate.stand.position) >= MIN_PICK_SPACING_M)) picked.push(s);
  }
  const spacedCount = picked.length;
  for (const s of scored) {
    if (picked.length === 3) break;
    if (!picked.includes(s)) picked.push(s);
  }
  const closeAlternates = picked.length > spacedCount;
  const recommendations = picked.map((s, i) => build(s, i + 1, false, windState));

  // Backup: a stand that tolerates winds the #1 pick can't.
  let backup: StandRecommendation | null = null;
  if (recommendations.length) {
    const topDial = recommendations[0].windDial;
    const differs = (dial: WindDial) => dial.sectors.filter((sec, i) => sec.status === 'good' && topDial.sectors[i].status === 'bad').length;
    const pool = scored.filter((s) => !picked.includes(s)).map((s) => ({ s, diff: differs(windDial(s.e.passesAt, windState.windFromDeg)) }));
    // A stand you can hunt TODAY that also covers winds the #1 can't beats a hypothetical one.
    const pick = pool.find((x) => x.diff >= MIN_BACKUP_EXTRA_SECTORS);
    if (pick) {
      backup = build(pick.s, 4, true, windState, `Handles winds the top stand can't. Switch here if the wind turns.`);
    }
  }
  if (!backup) {
    // Fall back to a stand eliminated by today's wind but good for the likely shift.
    const shiftDirs: number[] = [];
    const forecastShift = hourlyInWindow.find((h) => Math.abs(normDeg(h.windFromDeg - w.windFromDeg + 180) - 180) >= 30);
    if (forecastShift) shiftDirs.push(forecastShift.windFromDeg);
    shiftDirs.push(normDeg(w.windFromDeg + 45), normDeg(w.windFromDeg - 45), normDeg(w.windFromDeg + 90), normDeg(w.windFromDeg - 90));
    let best: { s: Scored; dir: number } | null = null;
    for (const e of evaluated.filter((x) => x.windOnly)) {
      for (const dir of shiftDirs) {
        if (!e.passesAt(dir)) continue;
        const ws = { ...windState, windFromDeg: dir };
        const s = scoreOne(e, ws, { ...w, windFromDeg: dir });
        if (!best || s.total > best.s.total) best = { s, dir };
        break;
      }
    }
    if (best) {
      const note = `Only if the wind shifts to ${compass16(best.dir)}. Today's wind blows scent onto deer here.`;
      backup = build(best.s, 4, true, { ...windState, windFromDeg: best.dir }, note);
      // Scored as if the wind had shifted, so it is never a plain GO for today's wind.
      if (backup.decision.status === 'go') backup.decision = { status: 'caution', reasons: [note] };
      else backup.decision.reasons.unshift(note);
    }
  }

  // The hunter's own stands are always shown with their score and reasons, never silently dropped.
  const shown = new Set([...recommendations, ...(backup ? [backup] : [])].map((r) => r.stand.id));
  const yourStands = scored
    .filter((s) => s.e.candidate.stand.origin === 'existing' && !shown.has(s.e.candidate.stand.id))
    .map((s) => build(s, scored.indexOf(s) + 1, false, windState));

  const warnings: PlanWarning[] = [];
  if (!phase.regionTuned || phase.source === 'calendar') warnings.push({ level: 'info', text: phase.note || PHASE_TACTICS[phase.phase] });
  if (!property.calibration?.originGeo) warnings.push({ level: 'info', text: 'Map not geo-referenced. Weather auto-fill, elevation and land-cover checks are off. Add two reference points to turn them on.' });
  if (!property.features.some((f) => f.status === 'active' && f.type === 'access_point')) warnings.push({ level: 'caution', text: 'No access point marked. Routes start from the nearest road or property line.' });
  if (habitat.bedding.length === 0) warnings.push({ level: 'caution', text: 'No bedding identified. Mark known bedding for much better stand placement.' });
  if (scored.length === 0) warnings.push({ level: 'no_go', text: 'No stand passes today’s wind. Best move may be to stay out and save the property.' });
  else if (scored.length < 3) warnings.push({ level: 'caution', text: `Only ${scored.length} stand${scored.length === 1 ? '' : 's'} pass the wind gate today.` });
  if (closeAlternates) warnings.push({ level: 'info', text: `Today's wind leaves only ${spacedCount} distinct setup${spacedCount === 1 ? '' : 's'}; the others are alternate trees near them.` });
  if (w.windSpeedMph < LIGHT_WIND_MPH) warnings.push({ level: 'caution', text: 'Light wind. Thermals control your scent, so plume arrows show both directions.' });
  if (weatherDecision.status !== 'go') for (const r of weatherDecision.reasons) warnings.push({ level: weatherDecision.status === 'no_go' ? 'no_go' : 'caution', text: r });

  return {
    id: req.planId ?? `plan-${inputs.date}-${inputs.window}-${nowMs}`,
    propertyId: property.id,
    createdAt: now.toISOString(),
    engineVersion: ENGINE_VERSION,
    inputs,
    phase,
    sun,
    legal,
    habitat,
    recommendations,
    backup,
    yourStands,
    eliminated,
    warnings,
    modifiers,
    weatherDecision,
    reminders: planReminders(property.stateCode, inputs.weapon.type),
    disclaimer: DISCLAIMER,
  };
}

export type { Stand };
