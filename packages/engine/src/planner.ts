import type {
  Confidence,
  Corridor,
  Decision,
  EliminatedStand,
  HabitatSummary,
  HourlyWind,
  Modifier,
  Plan,
  PlanInputs,
  PlanWarning,
  PressureEvent,
  Property,
  Risk,
  Route,
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
import { angleDiff, bearingTo, circlePolygon, compass16, dist, downwindBearing, mToYds, normDeg, pointGeometryDistance, slicePolyline, polylineLength, projectOntoPolyline, round, ydsToM } from './geo/geometry.ts';
import { derivePhase, AM_HOLD_MIN, BEDDING_SETBACK_M, PM_SETTLE_MIN, PHASE_TACTICS } from './season/phase.ts';
import { addMinutes, legalHoursFor, sunTimes } from './astro/sun.ts';
import { BEDDING_MIN_PROB, FOOD_SENSITIVE_MIN, inferHabitat } from './inference/habitat.ts';
import { generateCandidates, type Candidate, effectiveSetback } from './stands/candidates.ts';
import { createRoutePlanner, findSharedAccessHazards, type AccessHazard, type RoutePair, type RoutePlanner, type SharedAccess } from './stands/routes.ts';
import { directionSpread, evaluateGate, LIGHT_WIND_MPH, scentModel, windMargin, type GateResult, type PlumeHit, type ScentModel, type SensitiveArea, type WindState } from './wind/scent.ts';
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
import { cloudCoverModifier, moonModifier, pressureModifier } from './modifiers/modifiers.ts';

export const ENGINE_VERSION = '0.1.0';
export const MIN_PICK_SPACING_M = 100;
/**
 * Food the engine keeps (and builds travel toward) but that is less likely to be fed than
 * FOOD_SENSITIVE_MIN (inference/habitat.ts; the hard wind-gate floor, shared with the route judge):
 * scent drifting into it is a caution and a wind-fit penalty, not an elimination.
 */
export const FOOD_SOFT_MIN = 0.15;
/** A backup must be good in at least this many 22.5° wind sectors where the #1 stand is bad. */
export const MIN_BACKUP_EXTRA_SECTORS = 2;
/** A forecast hour at least one compass sector off today's wind is a forecast shift (NWS gives 16-point directions). */
export const FORECAST_SHIFT_DEG = 22.5;
/** Risk text for a stand no legal route reaches (the plan card keys off it). Only hard blocks cause it. */
export const UNREACHABLE_RISK = 'No legal walking route from your access points. A no-access zone, water or a neighbor line blocks every path in.';
/** Risk text for a stand whose only walk crosses ground off the property line or beside a house. */
export const SOFT_CROSSING_RISK = 'Walk crosses ground off your property: get permission or mark a different access point.';

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
  const legal = legalHoursFor(sun, inputs);
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
    // Every bed the engine maps (and builds travel from) is protected by the gate.
    if (b.probability < BEDDING_MIN_PROB) continue;
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
    // you're hunting gets you busted by the first doe that steps out. Less likely food
    // is still flagged (soft: caution and a wind-fit penalty) rather than ignored.
    if (f.probability < FOOD_SOFT_MIN) continue;
    out.push({
      id: f.id,
      kind: 'food',
      label: f.kind === 'ag' ? 'the field' : f.kind === 'mast' ? 'the acorns' : 'the food plot',
      shape: f.polygon ?? circlePolygon(f.center, f.radiusM),
      closed: true,
      hardRangeM: f.probability < FOOD_SENSITIVE_MIN ? SOFT_ONLY : inputs.window === 'PM' ? 200 : 150,
    });
  }
  return out;
}

/** hardRangeM for an area that only ever raises a caution, even for a stand inside it. */
const SOFT_ONLY = 0;

/** The wind gate, with soft-only areas never counted as a hard (eliminating) hit. */
function gateAt(origin: Vec, model: ScentModel, areas: SensitiveArea[]): GateResult {
  const g = evaluateGate(origin, model, areas);
  if (!g.hits.some((h) => h.hard && h.area.hardRangeM <= SOFT_ONLY)) return g;
  const hits = g.hits.map((h) => (h.area.hardRangeM <= SOFT_ONLY ? { ...h, hard: false } : h));
  return { passes: !hits.some((h) => h.hard), hits };
}

/**
 * The deer's approach path for this sit: where they come FROM toward the stand.
 * Bed→food corridors are ordered bedding-first: PM deer come from the bedding end,
 * AM deer come from the food end. Other corridors are two-way.
 * Every travel route the stand is scored for (all within range) is gated, not just
 * the strongest: a weaker trail directly downwind still carries deer into your scent.
 */
export function approachPaths(ctx: StandContext, window: PlanInputs['window']): SensitiveArea[] {
  const out: SensitiveArea[] = [];
  for (const { corridor, along } of ctx.corridors) {
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
// Plan-level route warnings
// ---------------------------------------------------------------------------

const NOT_SHARED: SharedAccess = { entry: false, exit: false };

/** One warning for a parking spot that puts scent on deer for most stands: actionable, and said once. */
export function accessHazardWarning(h: AccessHazard): string {
  const what = h.targets.includes('food') && h.targets.includes('bedding') ? 'the field and bedding' : h.targets.includes('food') ? 'the field' : 'bedding';
  const walk = h.walks.length === 2 ? 'in and out' : h.walks[0] === 'entry' ? 'walking in' : 'walking out';
  return `Your parking spot (${h.label}) is upwind of ${what} in today's wind, so the stretch by the truck (${walk}) carries your scent onto deer. It is the same for the ${h.stands} stands that start there, so it is not counted against any one of them. Park somewhere else, approach from the other side, or mark another access point.`;
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
  /** Yards to the travel the stand was set for when it lies beyond the hunter's range (no shot planned). */
  travelBeyondRangeYds: number | null;
  eliminatedReasons: string[];
  windOnly: boolean;
}

const plumeVerb = (h: PlumeHit) => (h.plume.kind === 'wind' ? 'Wind carries' : h.plume.kind === 'thermal_falling' ? 'Falling thermals carry' : h.plume.kind === 'thermal_rising' ? 'Rising thermals carry' : 'Swirling air carries');

function describeHit(origin: Vec, h: PlumeHit): string {
  const where = h.area.shape.reduce((best, p) => (dist(origin, p) < dist(origin, best) ? p : best), h.area.shape[0]);
  return `${plumeVerb(h)} scent onto ${h.area.label} (${Math.round(h.distanceM)} m ${compass16(bearingTo(origin, where))}).`;
}

function evaluate(c: Candidate, req: PlanRequest, habitat: HabitatSummary, windState: WindState, baseAreas: SensitiveArea[]): Evaluated {
  const { inputs, property, terrain } = req;
  const p = c.stand.position;
  const slope = slopeAt(p, property.features, terrain);
  const ctx = standContext(p, habitat, inputs.weapon.effectiveRangeYds);
  const areas = [...baseAreas, ...approachPaths(ctx, inputs.window)];
  const modelFor = (fromDeg: number, speed = windState.windSpeedMph) => scentModel({ ...windState, windFromDeg: fromDeg, windSpeedMph: speed }, slope, inputs.window);
  const model = modelFor(windState.windFromDeg);
  const gate = gateAt(p, model, areas);
  const passesAt = (fromDeg: number) => gateAt(p, modelFor(fromDeg), areas).passes;

  const rangeYds = inputs.weapon.effectiveRangeYds;
  const lanes = shotLanes(p, property.features, inputs.weapon.type, rangeYds);
  // The shot is at the travel the stand was set for; a trail directly under the stand isn't a shot plan.
  // Travel inside the hunter's range wins over travel just beyond it.
  const shootable = (x: StandContext['corridors'][number]) => x.distanceM >= 5 && x.distanceM <= ydsToM(rangeYds);
  const shotTarget =
    ctx.corridors.find((x) => x.corridor.id === c.corridorId && shootable(x)) ??
    ctx.corridors.find(shootable) ??
    ctx.corridors.find((x) => x.corridor.id === c.corridorId && x.distanceM >= 5) ??
    ctx.corridors.find((x) => x.distanceM >= 5) ??
    ctx.corridors[0];
  let primaryBearing: number | null = null;
  let expected: number | null = null;
  let travelBeyondRangeYds: number | null = null;
  const notes = [`No shots beyond ${rangeYds} yds.`];
  if (shotTarget) {
    const proj = projectOntoPolyline(p, shotTarget.corridor.points);
    primaryBearing = bearingTo(p, proj.point);
    const yds = Math.max(5, Math.round(mToYds(proj.distance)));
    // The shot plan never states a shot beyond the hunter's effective range.
    if (yds <= rangeYds) expected = yds;
    else {
      travelBeyondRangeYds = yds;
      notes.push(`Deer travel passes ~${yds} yds ${compass16(primaryBearing)}, beyond your ${rangeYds} yd range. No shot unless he comes closer.`);
    }
  }
  if (inputs.weapon.type === 'bow' || inputs.weapon.type === 'crossbow') notes.push('Broadside or quartering-away only. Let him clear the lane before drawing.');
  if (lanes.some((l) => l.status === 'no_shot')) notes.push('Red lanes point toward a road or house. Never shoot that way.');
  if (ctx.corridors.some((x) => x.distanceM < 5)) notes.push('A trail passes right under this stand. Expect close, steep shots and deer that may spot or wind you.');
  const shotPlan: ShotPlan = { effectiveRangeYds: rangeYds, expectedShotYds: expected, primaryBearingDeg: primaryBearing, lanes, notes };

  const reasons: string[] = [];
  if (!gate.passes) for (const h of gate.hits.filter((x) => x.hard)) reasons.push(describeHit(p, h));
  let windOnly = reasons.length > 0;
  if (primaryBearing !== null && laneFor(lanes, primaryBearing).status === 'no_shot') {
    reasons.push('The only shot toward deer travel points at a road or house.');
    windOnly = false;
  }
  return { candidate: c, slope, model, areas, gate, ctx, passesAt, shotPlan, travelBeyondRangeYds, eliminatedReasons: reasons, windOnly };
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

function oneLineReason(e: Evaluated, windFromDeg: number, assumedWind = false): string {
  const s = e.candidate.stand;
  const own = e.ctx.corridors.find((x) => x.corridor.id === e.candidate.corridorId);
  const c = (own ?? e.ctx.corridors[0])?.corridor;
  const lead = e.candidate.anchorLabel === 'Your stand' ? 'Your stand' : e.candidate.anchorLabel;
  const phrase = c ? corridorPhrase(c) : '';
  const what = !c ? `${s.name}, with no mapped travel in range` : PINCH_LEADS.has(lead) ? `${lead} ${phrase}` : phrase[0].toUpperCase() + phrase.slice(1);
  const bed = e.ctx.nearestBedding ? `, ${Math.round(e.ctx.nearestBedding.distanceM)} m off ${e.ctx.nearestBedding.area.kind === 'unknown' ? '' : e.ctx.nearestBedding.area.kind + ' '}bedding` : '';
  if (assumedWind) return `If the wind turns ${compass16(windFromDeg)}: ${what}${bed}. Scent would carry ${compass16(downwindBearing(windFromDeg))}, clear of the approach and bedding.`;
  return `${what}${bed}. ${compass16(windFromDeg)} wind carries scent ${compass16(downwindBearing(windFromDeg))}, clear of the approach and bedding.`;
}

/** A forecast hour that fails the gate in the SAME direction the stand works for: light air (thermals, swirl) or gusts. */
interface LightAirFailure {
  at: string;
  speedMph: number;
  hit: PlumeHit;
}

interface Scored {
  e: Evaluated;
  /** The wind this stand was scored for (today's, or the assumed wind of a wind-shift backup). */
  ws: WindState;
  routes: RoutePair;
  /** Which walks have a scent problem at the parking spot that the plan reports once, for every stand. */
  shared: SharedAccess;
  components: ScoreComponent[];
  total: number;
  margin: number;
  sightingsNear: Sighting[];
  /** Forecast hours whose wind DIRECTION puts scent on deer here. */
  shiftFailures: Array<{ at: string; fromDeg: number }>;
  lightAirFailures: LightAirFailure[];
}

/** No-go for reasons of the stand itself (not the weather): never ranked above a huntable stand. */
const standNoGo = (s: Scored) => s.routes.unreachable || s.shiftFailures.length > 0;
const rankOrder = (a: Scored, b: Scored) => Number(standNoGo(a)) - Number(standNoGo(b)) || b.total - a.total;

function lightAirText(f: LightAirFailure): string {
  const verb = plumeVerb(f.hit).toLowerCase();
  return f.speedMph < LIGHT_WIND_MPH
    ? `Light air (${Math.round(f.speedMph)} mph) during part of the sit: ${verb} scent onto ${f.hit.area.label}.`
    : `Gusts during part of the sit widen the scent cone onto ${f.hit.area.label}.`;
}

function risksFor(s: Scored, req: PlanRequest, setbackM: number): Risk[] {
  const risks: Risk[] = [];
  const windState = s.ws;
  const p = s.e.candidate.stand.position;
  const { inputs } = req;
  if (s.routes.unreachable) risks.push({ severity: 3, text: UNREACHABLE_RISK });
  if (s.routes.softCrossing) risks.push({ severity: 3, text: SOFT_CROSSING_RISK });
  if (s.shiftFailures.length) {
    risks.push({ severity: 3, text: `Forecast swings to ${compass16(s.shiftFailures[0].fromDeg)} during the sit, which puts scent on deer.` });
  }
  if (s.lightAirFailures.length) {
    const f = s.lightAirFailures[0];
    risks.push({ severity: f.hit.area.kind === 'bedding' ? 3 : 2, text: lightAirText(f) });
  }
  if (s.margin < 25) {
    for (const side of [1, -1]) {
      const test = normDeg(windState.windFromDeg + side * (s.margin + 5));
      const g = gateAt(p, scentModel({ ...windState, windFromDeg: test }, s.e.slope, inputs.window), s.e.areas);
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
    // Off-property ground has its own risk above; a parking-spot scent problem is a plan warning.
    const own = (x: Route['segments'][number]) => !x.ground && !(x.atAccess && s.shared[r.kind]);
    const bad = r.segments.find((x) => x.status === 'avoid' && own(x));
    const warn = r.segments.find((x) => x.status === 'caution' && own(x));
    if (bad) risks.push({ severity: 3, text: `${r.kind === 'entry' ? 'Entry' : 'Exit'}: ${bad.reason}` });
    else if (warn) risks.push({ severity: 2, text: `${r.kind === 'entry' ? 'Entry' : 'Exit'}: ${warn.reason}` });
  }
  const travelYds = s.e.travelBeyondRangeYds;
  if (travelYds !== null) risks.push({ severity: 3, text: `Deer travel is ~${travelYds} yds out, beyond your ${inputs.weapon.effectiveRangeYds} yd range. No ethical shot unless he comes closer.` });
  for (const h of s.e.gate.hits.filter((x) => !x.hard)) risks.push({ severity: 2, text: `Scent may drift toward ${h.area.label} (${Math.round(h.distanceM)} m).` });
  if (s.e.model.thermalsApplied) {
    const falling = s.e.model.plumes.find((x) => x.kind === 'thermal_falling');
    if (falling) risks.push({ severity: 2, text: inputs.window === 'PM' ? `At last light, thermals pull scent downhill (${compass16(falling.bearingDeg)}).` : `Before sunrise, scent drains downhill (${compass16(falling.bearingDeg)}) until the slope warms.` });
  }
  const pressure = s.components.find((c) => c.key === 'pressureHistory');
  if (pressure && pressure.value <= 2.5) risks.push({ severity: 2, text: pressure.reasons[0] });
  if (s.routes.noAccess) risks.push({ severity: 2, text: 'No access point mapped, so the entry route is unverified.' });
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

function decisionFor(s: Scored, weather: Decision, req: PlanRequest): Decision {
  const reasons: string[] = [];
  let status: Decision['status'] = 'go';
  // A fresh array: callers may prepend stand-specific notes (the backup note) to it.
  if (weather.status === 'no_go') return { status: 'no_go', reasons: [...weather.reasons] };
  const raise = (st: Decision['status'], r: string) => {
    reasons.push(r);
    if (st === 'no_go' || (st === 'caution' && status === 'go')) status = st;
  };
  if (s.routes.unreachable) raise('no_go', 'No legal walking route in from your access points. Mark another access point or skip this stand.');
  if (s.routes.softCrossing) raise('caution', 'The only walk in crosses ground off your property (or within 50 m of a house). Get permission, or mark a different access point.');
  if (s.shiftFailures.length) raise('no_go', `Forecast wind shifts to ${compass16(s.shiftFailures[0].fromDeg)} mid-sit, a direction this stand can't handle.`);
  if (s.lightAirFailures.length) raise('caution', `${lightAirText(s.lightAirFailures[0])} Check the air at the base of the tree.`);
  if (s.margin < 15) raise('caution', 'The wind barely works. Check it at the truck and again at the base of the tree.');
  // Red stretches that are the stand's own: not off-property ground (raised above) and not the
  // parking-spot scent problem every stand shares (reported once as a plan warning).
  const ownRed = (r: Route | null) => r?.segments.find((x) => x.status === 'avoid' && !x.ground && !(x.atAccess && s.shared[r.kind]));
  const entryBad = ownRed(s.routes.entry);
  if (entryBad) raise('caution', `Entry route crosses a red zone (${lower(entryBad.reason).replace(/\.$/, '')}). Mark a different access point, or pick another stand for this wind.`);
  const exitBad = ownRed(s.routes.exit);
  if (exitBad) raise('caution', `Exit crosses a red zone (${lower(exitBad.reason).replace(/\.$/, '')}). Wait for deer to clear out before you climb down, or mark a different access point.`);
  if (s.e.travelBeyondRangeYds !== null) raise('caution', `Deer travel here is ~${s.e.travelBeyondRangeYds} yds out, beyond your ${req.inputs.weapon.effectiveRangeYds} yd range.`);
  if (s.total < 45) raise('caution', 'Low odds today. Consider saving this stand for a better day.');
  if (weather.status === 'caution') for (const r of weather.reasons) raise('caution', r);
  if (s.ws.windSpeedMph < 2) raise('caution', 'Near-calm air. Scent will pool, so expect the unexpected.');
  if (status === 'go') reasons.push(s.shared.entry || s.shared.exit ? 'Wind, access and timing line up once you are past the parking spot (see the plan warning about it).' : 'Wind, access and timing all line up.');
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
  const legal = legalHoursFor(sun, inputs);
  const sit = sitWindow(inputs, phase.phase, sun);

  // Forecast hours that overlap the sit (an hour starting just before the sit still covers its first minutes).
  const sitStartMs = Date.parse(sit.start);
  const sitEndMs = Date.parse(sit.end);
  const hourlyInWindow = (w.hourly ?? []).filter((h) => {
    const t = Date.parse(h.at);
    return t + 3_600_000 > sitStartMs && t < sitEndMs;
  });
  // Weather gates use the worst hour of the sit, not just the snapshot hour.
  const weatherDecision = assessWeather(w, hourlyInWindow);
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

  const plannerFor = (windFromDeg: number, routeHabitat: HabitatSummary) =>
    createRoutePlanner(
      { property, habitat: routeHabitat, setbackM, windFromDeg, windSpeedMph: w.windSpeedMph, window: inputs.window },
      candidates.map((c) => c.stand.position),
    );
  const routePlanner = plannerFor(w.windFromDeg, habitat);
  const maxCorridorStrength = habitat.corridors.reduce((m, c) => Math.max(m, c.strength), 0);
  const midSit = new Date((sitStartMs + sitEndMs) / 2);
  const cloud = cloudCoverModifier(w, inputs.window);
  const modifiers: Modifier[] = [moonModifier(midSit, inputs.window), pressureModifier(w), ...(cloud ? [cloud] : [])];
  const nowMs = now.getTime();

  const scoreOne = (e: Evaluated, ws: WindState, weather: WeatherSnapshot, opts: { hourly?: HourlyWind[]; routePlanner?: RoutePlanner; routes?: RoutePair; shared?: SharedAccess } = {}): Scored => {
    const p = e.candidate.stand.position;
    const margin = windMargin(e.passesAt, ws.windFromDeg);
    const routes = opts.routes ?? (opts.routePlanner ?? routePlanner).plan(p);
    const shared = opts.shared ?? NOT_SHARED;
    const sightingsNear = relevantSightings(p, sightings, nowMs);
    // Re-run the gate for each forecast hour. A failure in a direction the stand handles
    // (per its dial) is light air or gusts, not a wind shift, and is reported as such.
    const shiftFailures: Scored['shiftFailures'] = [];
    const lightAirFailures: LightAirFailure[] = [];
    for (const h of opts.hourly ?? hourlyInWindow) {
      const g = gateAt(p, scentModel({ windFromDeg: h.windFromDeg, windSpeedMph: h.windSpeedMph, windGustMph: Math.max(h.windGustMph ?? h.windSpeedMph, h.windSpeedMph) }, e.slope, inputs.window), e.areas);
      if (g.passes) continue;
      if (!e.passesAt(h.windFromDeg)) shiftFailures.push({ at: h.at, fromDeg: h.windFromDeg });
      else lightAirFailures.push({ at: h.at, speedMph: h.windSpeedMph, hit: g.hits.find((x) => x.hard) ?? g.hits[0] });
    }
    const softHits = e.gate.hits.filter((h) => !h.hard).map((h) => `Scent may drift toward ${h.area.label} ${Math.round(h.distanceM)} m out.`);
    if (lightAirFailures.length) softHits.push(lightAirText(lightAirFailures[0]));
    const components = [
      scoreWindFit(margin, Math.max(0, ws.windGustMph - ws.windSpeedMph), ws.windSpeedMph < LIGHT_WIND_MPH, softHits, e.model.thermalsApplied),
      scoreAccess(routes.entry, routes.exit, routes.noAccess, routes.unreachable, shared),
      scoreMovement(e.ctx, maxCorridorStrength, sightingsNear, phase.phase, inputs.window),
      scoreBeddingDistance(e.ctx, setbackM),
      scoreShot(e.ctx, inputs.weapon.effectiveRangeYds, e.shotPlan.primaryBearingDeg === null || laneFor(e.shotPlan.lanes, e.shotPlan.primaryBearingDeg).status === 'open'),
      scoreCover(p, property.features, e.candidate.stand),
      scorePressure(p, e.candidate.stand, pressure, nowMs),
      scoreWeatherTime(weather, inputs.date, inputs.window, phase.phase, e.ctx, modifiers, sightingsNear.length > 0),
    ];
    if (e.candidate.stand.origin === 'existing') components[0].reasons.push('Your existing stand. Scored with the same rules.');
    return { e, ws, routes, shared, components, total: totalScore(components).total, margin, sightingsNear, shiftFailures, lightAirFailures };
  };

  // Route every surviving stand first: a scent problem at the parking spot recurs on most of them,
  // so it is found across stands, reported once, and not held against each stand's score.
  const routed = survivors.map((e) => ({ e, routes: routePlanner.plan(e.candidate.stand.position) }));
  const { hazards: accessHazards, shared: sharedAccess } = findSharedAccessHazards(routed.map((r) => r.routes));
  // A stand that is no-go on its own (forecast shift, no legal route) never ranks above a huntable one.
  const scored = routed.map(({ e, routes }) => scoreOne(e, windState, w, { routes, shared: sharedAccess.get(routes) })).sort(rankOrder);
  const huntable = scored.filter((s) => !standNoGo(s));

  const build = (s: Scored, rank: number, isBackup: boolean, backupNote?: string, assumedWind = false): StandRecommendation => ({
    stand: s.e.candidate.stand,
    rank,
    isBackup,
    backupNote,
    score: totalScore(s.components),
    reason: oneLineReason(s.e, s.ws.windFromDeg, assumedWind),
    sitWindow: sit,
    windDial: windDial(s.e.passesAt, s.ws.windFromDeg),
    entryRoute: s.routes.entry,
    exitRoute: s.routes.exit,
    shotPlan: s.e.shotPlan,
    risks: risksFor(s, req, setbackM),
    confidence: confidenceFor(s.e, req, s.sightingsNear, s.margin, s.ws),
    decision: decisionFor(s, weatherDecision, req),
    safetyReminders: [HARNESS_REMINDER, ...weaponSafetyReminders(inputs.weapon.type)],
    plumes: scentModel(s.ws, s.e.slope, inputs.window).plumes.map(({ kind, bearingDeg, halfAngleDeg, lengthM }) => ({ kind, bearingDeg, halfAngleDeg, lengthM })),
    ...(assumedWind ? { assumedWindFromDeg: s.ws.windFromDeg } : {}),
  });

  // Top 3, kept at least 100 m apart so the hunter gets real alternatives, not one spot three times.
  // Huntable stands first (distinct setups, then alternate trees), then no-go stands only to fill.
  const picked: Scored[] = [];
  const spaced = (s: Scored, among: Scored[]) => among.every((p) => dist(p.e.candidate.stand.position, s.e.candidate.stand.position) >= MIN_PICK_SPACING_M);
  for (const pool of [huntable, scored.filter(standNoGo)]) {
    for (const s of pool) if (picked.length < 3 && spaced(s, picked)) picked.push(s);
    for (const s of pool) if (picked.length < 3 && !picked.includes(s)) picked.push(s);
  }
  // Ranks follow the same order as everywhere else: huntable before no-go, then score.
  picked.sort(rankOrder);
  const spacedCount = picked.filter((s, i) => spaced(s, picked.slice(0, i))).length;
  const closeAlternates = picked.length > spacedCount;
  const recommendations = picked.map((s, i) => build(s, i + 1, false));

  // Backup: a stand you can hunt TODAY that tolerates winds the #1 pick can't.
  let backup: StandRecommendation | null = null;
  if (recommendations.length) {
    const topDial = recommendations[0].windDial;
    const differs = (dial: WindDial) => dial.sectors.filter((sec, i) => sec.status === 'good' && topDial.sectors[i].status === 'bad').length;
    const pool = huntable.filter((s) => !picked.includes(s)).map((s) => ({ s, diff: differs(windDial(s.e.passesAt, windState.windFromDeg)) }));
    // A stand you can hunt TODAY that also covers winds the #1 can't beats a hypothetical one.
    const pick = pool.find((x) => x.diff >= MIN_BACKUP_EXTRA_SECTORS);
    if (pick) {
      backup = build(pick.s, 4, true, `Handles winds the top stand can't. Switch here if the wind turns.`);
    }
  }
  if (!backup) {
    // Fall back to a stand eliminated by today's wind but good for a shift: the forecast
    // shift first, a hypothetical ±45°/±90° swing only when nothing works for the forecast.
    // It is evaluated end to end for that wind (gate, dial, plumes, routes), and only the
    // forecast hours after the shift count against it.
    const shiftIdx = hourlyInWindow.findIndex((h) => angleDiff(h.windFromDeg, w.windFromDeg) >= FORECAST_SHIFT_DEG);
    // Cruise lines sit downwind of doe bedding for TODAY's wind; under another wind they move.
    const shiftHabitat: HabitatSummary = { ...habitat, corridors: habitat.corridors.filter((c) => c.kind !== 'cruise') };
    const cruiseIds = new Set(habitat.corridors.filter((c) => c.kind === 'cruise').map((c) => c.id));
    const pool = evaluated.filter((x) => x.windOnly && !(x.candidate.corridorId && cruiseIds.has(x.candidate.corridorId)));
    // Stage 1 (cheap): find each stand's wind and score it without routes.
    // Stage 2: route only the few best for their assumed wind, then pick.
    const unrouted: RoutePair = { entry: null, exit: null, noAccess: true, unreachable: false, softCrossing: false };
    const options: Array<{ e: Evaluated; ws: WindState; hours: HourlyWind[]; rough: Scored }> = [];
    const tryWind = (e: Evaluated, dir: number, hours: HourlyWind[]): boolean => {
      const ws: WindState = { ...windState, windFromDeg: dir, directionSpreadDeg: hours.length ? directionSpread(dir, hours.map((h) => h.windFromDeg)) : windState.directionSpreadDeg };
      const e2 = evaluate(e.candidate, req, shiftHabitat, ws, baseAreas);
      if (e2.eliminatedReasons.length) return false;
      options.push({ e: e2, ws, hours, rough: scoreOne(e2, ws, { ...w, windFromDeg: dir }, { hourly: hours, routes: unrouted }) });
      return true;
    };
    if (shiftIdx >= 0) {
      const after = hourlyInWindow.slice(shiftIdx);
      for (const e of pool) tryWind(e, after[0].windFromDeg, after);
    }
    if (!options.length) {
      const swings = [45, -45, 90, -90].map((d) => normDeg(w.windFromDeg + d));
      for (const e of pool) for (const dir of swings) if (tryWind(e, dir, [])) break;
    }
    const planners = new Map<number, RoutePlanner>();
    const routerFor = (dir: number) => {
      if (!planners.has(dir)) planners.set(dir, plannerFor(dir, shiftHabitat));
      return planners.get(dir) as RoutePlanner;
    };
    const finalists = options.sort((a, b) => rankOrder(a.rough, b.rough)).slice(0, 3);
    const best = finalists
      .map((o) => scoreOne(o.e, o.ws, { ...w, windFromDeg: o.ws.windFromDeg }, { hourly: o.hours, routePlanner: routerFor(o.ws.windFromDeg) }))
      .sort(rankOrder)[0];
    if (best) {
      const note = `Only if the wind shifts to ${compass16(best.ws.windFromDeg)}. Today's wind blows scent onto deer here.`;
      backup = build(best, 4, true, note, true);
      // Scored as if the wind had shifted, so it is never a plain GO for today's wind.
      if (backup.decision.status === 'go') backup.decision = { status: 'caution', reasons: [note] };
      else backup.decision.reasons.unshift(note);
    }
  }

  // The hunter's own stands are always shown with their score and reasons, never silently dropped.
  const shown = new Set([...recommendations, ...(backup ? [backup] : [])].map((r) => r.stand.id));
  const yourStands = scored
    .filter((s) => s.e.candidate.stand.origin === 'existing' && !shown.has(s.e.candidate.stand.id))
    .map((s) => build(s, scored.indexOf(s) + 1, false));

  const warnings: PlanWarning[] = [];
  if (property.analysisMode === 'mock') warnings.push({ level: 'caution', text: 'Map features are sample data, not detected from your photo' });
  if (!phase.regionTuned || phase.source === 'calendar') warnings.push({ level: 'info', text: phase.note || PHASE_TACTICS[phase.phase] });
  if (!property.calibration?.originGeo) warnings.push({ level: 'info', text: 'Map not geo-referenced. Weather auto-fill, elevation and land-cover checks are off. Add two reference points to turn them on.' });
  if (!property.features.some((f) => f.status === 'active' && f.type === 'access_point')) warnings.push({ level: 'caution', text: 'No access point marked. Routes start from the nearest road or property line.' });
  for (const h of accessHazards) warnings.push({ level: 'caution', text: accessHazardWarning(h) });
  const reachable = scored.filter((x) => !x.routes.unreachable && !x.routes.noAccess);
  const crossing = reachable.filter((x) => x.routes.softCrossing).length;
  if (crossing) warnings.push({ level: 'caution', text: `${crossing === reachable.length ? 'Every walk in' : `${crossing} of ${reachable.length} walks in`} crosses ground off your property or within 50 m of a house. Get permission, or mark an access point you can use. Those stretches are red on the map.` });
  if (habitat.bedding.length === 0) warnings.push({ level: 'caution', text: 'No bedding identified. Mark known bedding for much better stand placement.' });
  if (scored.length === 0) warnings.push({ level: 'no_go', text: 'No stand passes today’s wind. Best move may be to stay out and save the property.' });
  else if (huntable.length === 0) warnings.push({ level: 'no_go', text: 'Every stand that passes today’s wind is a no-go for this sit (forecast wind shift or no legal route in). Best move may be to stay out.' });
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
