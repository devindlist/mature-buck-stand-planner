import type {
  BeddingArea,
  Corridor,
  HabitatSummary,
  HuntWindow,
  MapFeature,
  Modifier,
  PressureEvent,
  Route,
  ScoreBreakdown,
  ScoreComponent,
  SeasonPhase,
  Sighting,
  Stand,
  Vec,
  WeatherSnapshot,
} from '../models.ts';
import { clamp, compass16, dist, mToYds, pointGeometryDistance, projectOntoPolyline, round, ydsToM } from '../geo/geometry.ts';
import { BEDDING_MIN_PROB, distanceToArea } from '../inference/habitat.ts';
import { normalTempF } from '../season/phase.ts';
import { combinedModifierPoints } from '../modifiers/modifiers.ts';
import { effectiveSetback } from './candidates.ts';

/**
 * Scoring for stands that survived the wind gate. Weights (sum 100):
 *   wind fit 25 · access stealth 20 · movement likelihood 20 · bedding distance 10
 *   shot opportunity 10 · cover 5 · pressure history 5 · weather & time fit 5
 */
export const WEIGHTS = {
  windFit: 25,
  accessStealth: 20,
  movementLikelihood: 20,
  beddingDistance: 10,
  shotOpportunity: 10,
  cover: 5,
  pressureHistory: 5,
  weatherTimeFit: 5,
} as const;

const comp = (key: ScoreComponent['key'], label: string, max: number, value: number, reasons: string[], tags: ScoreComponent['tags'] = []): ScoreComponent => ({
  key,
  label,
  max,
  value: round(clamp(value, 0, max), 1),
  reasons,
  tags,
});

// --- Wind fit -------------------------------------------------------------

export function scoreWindFit(marginDeg: number, gustSpreadMph: number, light: boolean, softHits: string[], thermalsApplied: boolean): ScoreComponent {
  const reasons: string[] = [];
  let v = WEIGHTS.windFit * Math.min(1, marginDeg / 45);
  reasons.push(marginDeg >= 90 ? 'Wind can swing 90° either way and scent still misses bedding, food and the approach.' : `Wind can shift about ${Math.round(marginDeg)}° before your scent reaches deer.`);
  if (gustSpreadMph > 8) {
    v *= 1 - Math.min(0.35, (gustSpreadMph - 8) / 40);
    reasons.push(`Gusty (${Math.round(gustSpreadMph)} mph spread), so the plume will spread wider than forecast.`);
  }
  if (light) {
    v *= thermalsApplied ? 0.9 : 0.75;
    reasons.push(thermalsApplied ? 'Light wind, so thermals were accounted for.' : 'Light wind with unknown thermals. Expect swirl.');
  }
  for (const s of softHits) {
    v -= 3;
    reasons.push(s);
  }
  return comp('windFit', 'Wind fit', WEIGHTS.windFit, v, reasons);
}

// --- Access stealth ---------------------------------------------------------

/**
 * `unreachable`: start points exist but no legal walk reaches the stand (it sits in a
 * no-access zone, or water, a no-access zone or a neighbor line cuts it off). That is
 * zero stealth, not an unknown, so it never gets the benefit of the doubt.
 */
export function scoreAccess(entry: Route | null, exit: Route | null, noAccess: boolean, unreachable = false): ScoreComponent {
  const reasons: string[] = [];
  if (unreachable) {
    return comp('accessStealth', 'Access stealth', WEIGHTS.accessStealth, 0, [
      "No legal walking route from your access points to this stand: a no-access zone, water, a neighbor's line or the property line is in the way.",
    ]);
  }
  if (noAccess || !entry) {
    return comp('accessStealth', 'Access stealth', WEIGHTS.accessStealth, 8, ['No access point or road mapped, so the route could not be checked. Mark where you park.']);
  }
  const penalty = (r: Route, weight: number, label: string) => {
    const avoid = r.segments.filter((s) => s.status === 'avoid');
    const caution = r.segments.filter((s) => s.status === 'caution');
    let p = Math.min(16, avoid.length * 8) + Math.min(9, caution.length * 3);
    if (avoid.length) reasons.push(`${label}: ${avoid[0].reason}`);
    else if (caution.length) reasons.push(`${label}: ${caution[0].reason}`);
    else reasons.push(`${label} stays clear of bedding, feeding deer and travel.`);
    if (r.lengthM > 1200) {
      p += 2;
      reasons.push(`${label} is long (${Math.round(r.lengthM)} m), which means more chances to bump deer.`);
    }
    return p * weight;
  };
  let v = WEIGHTS.accessStealth - penalty(entry, 1, 'Entry') - (exit ? penalty(exit, 0.75, 'Exit') : 6);
  if (!exit) reasons.push('No separate exit route found.');
  if ((entry.overlapWithOther ?? 0) > 0.6) {
    v -= 2;
    reasons.push('Entry and exit share most of the same path.');
  }
  return comp('accessStealth', 'Access stealth', WEIGHTS.accessStealth, v, reasons);
}

// --- Movement likelihood ----------------------------------------------------

export interface StandContext {
  /** Corridors within effective range, nearest first. */
  corridors: Array<{ corridor: Corridor; distanceM: number; along: number }>;
  /**
   * The bedding this stand presses hardest: the smallest distance relative to that bed's
   * setback (doe bedding gets a lighter one). A buck bed 150 m away matters more than a doe
   * bed 130 m away, so the setback check and score never look past it.
   */
  nearestBedding: { area: BeddingArea; distanceM: number } | null;
  nearestFoodM: number;
}

export function standContext(p: Vec, habitat: HabitatSummary, effectiveRangeYds: number): StandContext {
  const reach = ydsToM(effectiveRangeYds) * 1.1;
  const corridors = habitat.corridors
    .map((c) => {
      const proj = projectOntoPolyline(p, c.points);
      return { corridor: c, distanceM: proj.distance, along: proj.along };
    })
    .filter((x) => x.distanceM <= reach)
    .sort((a, b) => a.distanceM - b.distanceM);
  let nearestBedding: StandContext['nearestBedding'] = null;
  let worstRatio = Infinity;
  for (const b of habitat.bedding) {
    if (b.probability < BEDDING_MIN_PROB) continue;
    const d = distanceToArea(p, b);
    // Setbacks scale together with the phase, so the ratio needs only the per-kind factor.
    const ratio = d / effectiveSetback(b, 1);
    if (ratio < worstRatio) {
      worstRatio = ratio;
      nearestBedding = { area: b, distanceM: d };
    }
  }
  const nearestFoodM = habitat.food.reduce((m, f) => Math.min(m, distanceToArea(p, f)), Infinity);
  return { corridors, nearestBedding, nearestFoodM };
}

const DAY_MS = 86_400_000;

export function relevantSightings(p: Vec, sightings: Sighting[], nowMs: number, radiusM = 200, days = 30): Sighting[] {
  return sightings.filter((s) => s.position && dist(s.position, p) <= radiusM && nowMs - Date.parse(s.at) <= days * DAY_MS && nowMs >= Date.parse(s.at) - DAY_MS);
}

export function scoreMovement(ctx: StandContext, maxCorridorStrength: number, sightingsNear: Sighting[], phase: SeasonPhase, window: HuntWindow): ScoreComponent {
  const reasons: string[] = [];
  const tags: ScoreComponent['tags'] = [];
  if (ctx.corridors.length === 0) {
    reasons.push('No probable travel within your effective range.');
  }
  let base = 0;
  for (const c of ctx.corridors) {
    const rel = maxCorridorStrength > 0 ? c.corridor.strength / maxCorridorStrength : 0;
    const abs = Math.min(1, c.corridor.strength / 0.5);
    base = Math.max(base, 0.6 * rel + 0.4 * abs);
  }
  if (ctx.corridors.length) reasons.push(ctx.corridors[0].corridor.reasons[0]);
  const pinch = ctx.corridors.some((c) => c.corridor.pinchPoints.some((pp) => Math.abs(projectOntoPolyline(pp.position, c.corridor.points).along - c.along) < 80));
  if (pinch) {
    base += 0.15;
    reasons.push('Terrain pinch point within range concentrates movement.');
  }
  if (ctx.corridors.length >= 2) {
    base += 0.1;
    reasons.push(`${ctx.corridors.length} travel routes converge within range.`);
  }
  // Window fit: food-side stands are weak in the morning outside the rut.
  const outsideRut = phase === 'early_season' || phase === 'october_lull' || phase === 'late_season' || phase === 'post_rut';
  if (window === 'AM' && outsideRut && ctx.nearestFoodM < 100) {
    base *= 0.6;
    reasons.push('Near food on a morning sit. Deer usually leave the field before light.');
  }
  // Observed data outranks inference.
  const mature = sightingsNear.filter((s) => s.maturity === 'mature_buck');
  const other = sightingsNear.filter((s) => s.maturity !== 'mature_buck');
  if (mature.length) {
    base += Math.min(0.4, mature.length * 0.25);
    reasons.push(`${mature.length} mature buck ${mature.length === 1 ? 'sighting' : 'sightings'} within 200 m in the last 30 days.`);
    tags.push('observed_data');
  }
  if (other.length) {
    base += Math.min(0.1, other.length * 0.03);
    reasons.push(`${other.length} other deer ${other.length === 1 ? 'sighting' : 'sightings'} nearby.`);
    if (!tags.includes('observed_data')) tags.push('observed_data');
  }
  return comp('movementLikelihood', 'Movement likelihood', WEIGHTS.movementLikelihood, WEIGHTS.movementLikelihood * clamp(base, 0, 1), reasons, tags);
}

// --- Bedding distance -------------------------------------------------------

export function scoreBeddingDistance(ctx: StandContext, setbackM: number): ScoreComponent {
  const max = WEIGHTS.beddingDistance;
  if (!ctx.nearestBedding) return comp('beddingDistance', 'Bedding distance', max, 5, ['No bedding identified. Mark known bedding to improve this.']);
  const sb = effectiveSetback(ctx.nearestBedding.area, setbackM);
  const d = ctx.nearestBedding.distanceM;
  let v: number;
  if (d < sb) v = max * clamp((d - sb * 0.4) / (sb * 0.6), 0, 1) * 0.6;
  else if (d <= sb * 2.5) v = max;
  else v = Math.max(3, max - ((d - sb * 2.5) / 400) * 7);
  const reasons = [
    d < sb
      ? `Only ${Math.round(d)} m from probable bedding. That's inside the ${Math.round(sb)} m setback for this phase, so you risk bumping him.`
      : d <= sb * 2.5
        ? `${Math.round(d)} m from bedding is close enough for daylight movement without intruding.`
        : `${Math.round(d)} m from bedding. Daylight movement this far out is less likely.`,
  ];
  return comp('beddingDistance', 'Bedding distance', max, v, reasons);
}

// --- Shot opportunity -------------------------------------------------------

export function scoreShot(ctx: StandContext, effectiveRangeYds: number, primaryLaneOpen: boolean): ScoreComponent {
  const max = WEIGHTS.shotOpportunity;
  if (ctx.corridors.length === 0) return comp('shotOpportunity', 'Shot opportunity', max, 0, ['Travel is beyond your effective range. No ethical shot expected.']);
  const yds = mToYds(ctx.corridors[0].distanceM);
  if (!primaryLaneOpen) return comp('shotOpportunity', 'Shot opportunity', max, 0, ['The lane toward travel points at a road or house. No shot.']);
  if (yds > effectiveRangeYds) return comp('shotOpportunity', 'Shot opportunity', max, 0, [`Expected shot ~${Math.round(yds)} yds is beyond your ${effectiveRangeYds} yd range.`]);
  const ideal = effectiveRangeYds * 0.6;
  const v = yds <= ideal ? max : max - ((yds - ideal) / (effectiveRangeYds - ideal)) * 6;
  return comp('shotOpportunity', 'Shot opportunity', max, v, [`Expected shot about ${Math.round(yds)} yds, inside your ${effectiveRangeYds} yd range.`]);
}

// --- Cover ------------------------------------------------------------------

export function scoreCover(p: Vec, features: MapFeature[], stand: Stand): ScoreComponent {
  const max = WEIGHTS.cover;
  const coverTypes = new Set(['thick_cover', 'mast_timber', 'edge', 'draw', 'bench']);
  let d = Infinity;
  for (const f of features) if (f.status === 'active' && coverTypes.has(f.type)) d = Math.min(d, pointGeometryDistance(p, f.geometry));
  let v = d <= 15 ? 5 : d <= 40 ? 3.5 : d <= 80 ? 2 : 1;
  const reasons = [d <= 15 ? 'Good background cover to break up your outline.' : d <= 80 ? `Cover about ${Math.round(d)} m away. Pick a tree with back cover.` : 'Open setting. You will be skylined without good back cover.'];
  if ((stand.type === 'ground_blind' || stand.type === 'box_blind') && v < 3.5) {
    v = 3.5;
    reasons.push('A blind provides its own concealment.');
  }
  return comp('cover', 'Cover', max, v, reasons);
}

// --- Pressure history -------------------------------------------------------

export function scorePressure(p: Vec, stand: Stand, events: PressureEvent[], nowMs: number): ScoreComponent {
  const max = WEIGHTS.pressureHistory;
  const near = (e: PressureEvent) => e.standId === stand.id || (e.position ? dist(e.position, p) < 60 : false);
  const sits = events.filter((e) => e.kind === 'sit' && near(e) && nowMs - Date.parse(e.at) <= 14 * DAY_MS);
  const bumps = events.filter((e) => e.kind === 'bumped_deer' && (e.position ? dist(e.position, p) < 200 : near(e)) && nowMs - Date.parse(e.at) <= 7 * DAY_MS);
  let v = sits.length === 0 ? 5 : sits.length === 1 ? 4 : sits.length === 2 ? 2.5 : 1;
  const reasons = [sits.length === 0 ? 'Fresh: not sat in the last 14 days.' : `Sat ${sits.length}× in the last 14 days. Mature bucks pattern hunters.`];
  if (bumps.length) {
    v -= 2;
    reasons.push(`Deer bumped near here in the last 7 days.`);
  }
  return comp('pressureHistory', 'Pressure history', max, v, reasons);
}

// --- Weather & time fit -----------------------------------------------------

export function scoreWeatherTime(
  w: WeatherSnapshot,
  date: string,
  window: HuntWindow,
  phase: SeasonPhase,
  ctx: StandContext,
  modifiers: Modifier[],
  hasObservedData: boolean,
): ScoreComponent {
  const max = WEIGHTS.weatherTimeFit;
  const reasons: string[] = [];
  const tags: ScoreComponent['tags'] = [];
  let v = 2.5;
  const normal = normalTempF(date, window);
  const delta = normal - w.tempF;
  if (delta >= 10) {
    v += 1.5;
    reasons.push(`${Math.round(delta)}°F colder than normal, which boosts daylight movement.`);
  } else if (delta >= 5) {
    v += 0.75;
    reasons.push(`${Math.round(delta)}°F colder than normal.`);
  } else if (delta <= -10) {
    v -= 1.5;
    reasons.push(`${Math.round(-delta)}°F warmer than normal, which suppresses daylight movement.`);
  }
  if (w.windSpeedMph >= 5 && w.windSpeedMph <= 12) {
    v += 0.5;
    reasons.push('Steady 5–12 mph wind gives predictable scent and covers your noise.');
  } else if (w.windSpeedMph > 18) {
    v -= 1;
    reasons.push('High wind keeps mature bucks tight to cover.');
  }
  if (w.precipType === 'rain' || w.precipType === 'snow') {
    if ((w.precipChancePct ?? 0) < 60) {
      v += 0.5;
      reasons.push('Light precip often gets deer up and moving.');
    } else {
      v -= 0.5;
      reasons.push('Steady precipitation through the sit.');
    }
  }
  const nearBed = ctx.nearestBedding ? ctx.nearestBedding.distanceM : Infinity;
  const rut = phase === 'pre_rut' || phase === 'seeking_chasing' || phase === 'lockdown';
  if (window === 'AM' && rut && nearBed < 400) {
    v += 0.5;
    reasons.push('Rut morning near bedding is prime time.');
  }
  if (window === 'PM' && !rut && ctx.nearestFoodM < 200) {
    v += 0.5;
    reasons.push('Evening sit on the way to food fits this phase.');
  }
  const modPoints = combinedModifierPoints(modifiers, hasObservedData);
  if (modifiers.length) {
    v += modPoints;
    tags.push('low_confidence');
    for (const m of modifiers) reasons.push(`[Low confidence] ${m.label}: ${m.detail}`);
    if (hasObservedData) reasons.push('Your observed deer activity outranks moon and pressure, so their effect was reduced.');
  }
  return comp('weatherTimeFit', 'Weather & time fit', max, v, reasons, tags);
}

export function totalScore(components: ScoreComponent[]): ScoreBreakdown {
  return { total: Math.round(components.reduce((s, c) => s + c.value, 0)), components };
}

export function windPhrase(windFromDeg: number): string {
  return `${compass16(windFromDeg)} wind`;
}
