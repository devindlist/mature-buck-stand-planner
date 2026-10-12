import type { ISODate, PhaseResult, SeasonPhase } from '../models.ts';

/**
 * Season phase calendar — tuned for the Midwest (Phase 1 scope).
 *
 * Whitetail breeding timing is photoperiod-driven and remarkably consistent across the
 * Midwest: peak breeding lands around Nov 10–20 nearly every year. Moon theories aside,
 * observed data (sightings, cams, chasing) is what should move a hunter off this calendar,
 * which is why the phase can always be overridden.
 *
 * Boundaries are inclusive month/day starts.
 */
interface PhaseStart {
  month: number;
  day: number;
  phase: SeasonPhase;
}

const MIDWEST_CALENDAR: PhaseStart[] = [
  { month: 1, day: 1, phase: 'late_season' },
  { month: 9, day: 1, phase: 'early_season' },
  { month: 10, day: 15, phase: 'october_lull' },
  { month: 10, day: 25, phase: 'pre_rut' },
  { month: 11, day: 4, phase: 'seeking_chasing' },
  { month: 11, day: 13, phase: 'lockdown' },
  { month: 11, day: 23, phase: 'post_rut' },
  { month: 12, day: 11, phase: 'late_season' },
];

export const MIDWEST_STATES = new Set(['IA', 'IL', 'IN', 'OH', 'MO', 'KS', 'NE', 'WI', 'MN', 'MI', 'ND', 'SD']);

export const PHASE_LABELS: Record<SeasonPhase, string> = {
  early_season: 'Early season',
  october_lull: 'October lull',
  pre_rut: 'Pre-rut',
  seeking_chasing: 'Seeking & chasing',
  lockdown: 'Lockdown',
  post_rut: 'Post-rut',
  late_season: 'Late season',
};

export const PHASE_TACTICS: Record<SeasonPhase, string> = {
  early_season: 'Bucks are on bed-to-food patterns. Hunt evenings on the edge of food, stay out of bedding, and take only perfect winds.',
  october_lull: 'Daylight movement drops. Hunt short evening sits near secondary food and staging cover, or save the stand.',
  pre_rut: 'Scrapes heat up and bucks start cruising. Sit funnels and scrape lines between bedding areas, and start mornings.',
  seeking_chasing: 'Bucks cruise downwind of doe bedding at any hour. All-day sits in funnels and saddles pay off.',
  lockdown: 'Bucks tend does in thick cover. Hunt close to doe bedding and expect odd-hour movement.',
  post_rut: 'Worn-down bucks return to food. Evening food sits come back, and the last unbred does bring a second wave.',
  late_season: 'Cold weather drives deer to high-energy food. Hunt the coldest afternoons on standing grain or brassicas.',
};

function phaseStartIndex(month: number, day: number): number {
  let idx = 0;
  for (let i = 0; i < MIDWEST_CALENDAR.length; i++) {
    const s = MIDWEST_CALENDAR[i];
    if (month > s.month || (month === s.month && day >= s.day)) idx = i;
  }
  return idx;
}

export function derivePhase(date: ISODate, stateCode: string, override?: SeasonPhase): PhaseResult {
  const regionTuned = MIDWEST_STATES.has(stateCode.toUpperCase());
  if (override) {
    return {
      phase: override,
      source: 'user',
      label: PHASE_LABELS[override],
      regionTuned,
      note: 'You set this phase by hand. It overrides the calendar.',
    };
  }
  const [, m, d] = date.split('-').map(Number);
  const phase = MIDWEST_CALENDAR[phaseStartIndex(m, d)].phase;
  const notes: string[] = [];
  if (!regionTuned) notes.push(`The rut calendar is tuned for the Midwest. Rut timing in ${stateCode.toUpperCase()} may differ, so override the phase if your observations disagree.`);
  if (m >= 2 && m <= 8) notes.push('This date is outside typical deer seasons.');
  if (phase === 'late_season' && m === 12 && d <= 20) notes.push('Watch for second-rut chasing about 28 days after peak breeding.');
  return {
    phase,
    source: 'calendar',
    label: PHASE_LABELS[phase],
    regionTuned,
    note: notes.join(' ') || PHASE_TACTICS[phase],
  };
}

/**
 * Minimum distance (meters) a stand should sit from probable buck bedding.
 * Tightens as the rut pulls bucks out of their core, and widens again when
 * bucks return to bed-to-food patterns and are most sensitive to intrusion.
 */
export const BEDDING_SETBACK_M: Record<SeasonPhase, number> = {
  early_season: 200,
  october_lull: 180,
  pre_rut: 120,
  seeking_chasing: 100,
  lockdown: 80,
  post_rut: 150,
  late_season: 180,
};

/** How much each corridor type matters per phase (0..1). */
export const CORRIDOR_WEIGHTS: Record<SeasonPhase, { bed_to_food: number; bed_to_bed: number; cruise: number; terrain_travel: number }> = {
  early_season: { bed_to_food: 1.0, bed_to_bed: 0.1, cruise: 0.0, terrain_travel: 0.5 },
  october_lull: { bed_to_food: 0.85, bed_to_bed: 0.3, cruise: 0.2, terrain_travel: 0.5 },
  pre_rut: { bed_to_food: 0.75, bed_to_bed: 0.75, cruise: 0.7, terrain_travel: 0.8 },
  seeking_chasing: { bed_to_food: 0.5, bed_to_bed: 1.0, cruise: 1.0, terrain_travel: 0.9 },
  lockdown: { bed_to_food: 0.35, bed_to_bed: 0.6, cruise: 0.55, terrain_travel: 0.5 },
  post_rut: { bed_to_food: 0.9, bed_to_bed: 0.35, cruise: 0.3, terrain_travel: 0.6 },
  late_season: { bed_to_food: 1.0, bed_to_bed: 0.15, cruise: 0.1, terrain_travel: 0.5 },
};

/** Minutes before sunset to be settled for PM sits, by phase. */
export const PM_SETTLE_MIN: Record<SeasonPhase, number> = {
  early_season: 180,
  october_lull: 150,
  pre_rut: 210,
  seeking_chasing: 270,
  lockdown: 240,
  post_rut: 180,
  late_season: 150,
};

/** Minutes after sunrise to stay seated for AM sits, by phase. */
export const AM_HOLD_MIN: Record<SeasonPhase, number> = {
  early_season: 150,
  october_lull: 150,
  pre_rut: 240,
  seeking_chasing: 330,
  lockdown: 300,
  post_rut: 180,
  late_season: 150,
};

/**
 * Rough Midwest normal temperatures (°F) for "colder than normal" scoring.
 * Linear interpolation between monthly anchors (Des Moines-ish climate normals).
 */
const NORMAL_HIGH_F = [30, 35, 48, 61, 72, 81, 85, 83, 76, 63, 48, 34];
const NORMAL_LOW_F = [13, 18, 29, 40, 51, 61, 66, 63, 54, 42, 30, 18];

export function normalTempF(date: ISODate, window: 'AM' | 'PM'): number {
  const [, m, d] = date.split('-').map(Number);
  const arr = window === 'AM' ? NORMAL_LOW_F : NORMAL_HIGH_F;
  const i = m - 1;
  const j = (i + 1) % 12;
  const t = (d - 1) / 30;
  // Anchors are mid-month-ish; interpolation toward next month is close enough for a ±5°F signal.
  const v = arr[i] * (1 - t) + arr[j] * t;
  // PM sits happen after the afternoon high; shade it a few degrees down.
  return window === 'PM' ? v - 4 : v + 4;
}
