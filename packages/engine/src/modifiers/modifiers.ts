import type { HuntWindow, Modifier, WeatherSnapshot } from '../models.ts';
import { moonInfo } from '../astro/moon.ts';

/**
 * Low-confidence modifiers. Moon phase, barometric trend and cloud cover have weak, contested
 * evidence behind them, so they:
 *   - only move points inside the 5-point "weather & time fit" bucket,
 *   - are capped at ±0.75 combined (MAX_MODIFIER_POINTS),
 *   - always carry a visible 'low_confidence' tag,
 *   - are damped to 25% when the hunter has observed data near the stand.
 */
export const OBSERVED_DATA_DAMPING = 0.25;
/** The most all low-confidence modifiers together can move the 5-point weather & time fit. */
export const MAX_MODIFIER_POINTS = 0.75;

export function moonModifier(at: Date, window: HuntWindow): Modifier {
  const m = moonInfo(at);
  // Popular (weakly supported) belief: bright nights shift movement toward mornings.
  const bright = m.illumination >= 0.75;
  const dark = m.illumination <= 0.25;
  let points = 0;
  let detail = `${m.label} (${Math.round(m.illumination * 100)}% lit). No meaningful effect expected.`;
  if (bright) {
    points = window === 'AM' ? 0.25 : -0.25;
    detail = `${m.label} (${Math.round(m.illumination * 100)}% lit). Some hunters see better midday and morning movement around bright moons.`;
  } else if (dark) {
    points = window === 'PM' ? 0.25 : 0;
    detail = `${m.label} (${Math.round(m.illumination * 100)}% lit). Some hunters favor evenings around dark moons.`;
  }
  return { key: 'moon', label: 'Moon phase', detail, tag: 'low_confidence', points };
}

export function pressureModifier(w: WeatherSnapshot): Modifier {
  const change = w.pressureChange3hHpa ?? 0;
  let points = 0;
  let detail = 'Barometric trend unknown.';
  switch (w.pressureTrend) {
    case 'rising':
      points = change >= 1.5 ? 0.5 : 0.25;
      detail = 'Rising pressure after a front often lines up with good movement.';
      break;
    case 'falling':
      points = change <= -2 ? 0.4 : 0;
      detail = change <= -2 ? 'Sharply falling pressure ahead of a front can trigger feeding.' : 'Slowly falling pressure. Little expected effect.';
      break;
    case 'steady':
      detail = 'Steady pressure. Neutral.';
      break;
    default:
      break;
  }
  return { key: 'pressure_trend', label: 'Pressure trend', detail, tag: 'low_confidence', points };
}

/** Cloud cover at or above this is "overcast" for the cloud modifier (matches the Plan screen's 75% choice). */
export const OVERCAST_MIN_PCT = 75;

/**
 * Cloud cover. Heavy overcast is commonly said to keep deer moving a little earlier in the
 * evening and later in the morning; the evidence is thin, so it is worth at most 0.3 points and
 * is tagged low confidence like the others (and damped when the hunter has observed data).
 * Null when no cloud figure is known: an unknown is not a modifier.
 */
export function cloudCoverModifier(w: WeatherSnapshot, window: HuntWindow): Modifier | null {
  const pct = w.cloudCoverPct;
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
  const shown = Math.round(Math.max(0, Math.min(100, pct)));
  let points = 0;
  let detail = `${shown}% cloud. No meaningful effect expected.`;
  if (pct >= OVERCAST_MIN_PCT) {
    points = window === 'PM' ? 0.3 : 0.2;
    detail = `Overcast (${shown}% cloud). Some hunters see deer move earlier in the evening and linger later in the morning under heavy cloud.`;
  }
  return { key: 'cloud_cover', label: 'Cloud cover', detail, tag: 'low_confidence', points };
}

export function combinedModifierPoints(mods: Modifier[], hasObservedData: boolean): number {
  const raw = mods.reduce((s, m) => s + m.points, 0);
  const capped = Math.max(-MAX_MODIFIER_POINTS, Math.min(MAX_MODIFIER_POINTS, raw));
  return hasObservedData ? capped * OBSERVED_DATA_DAMPING : capped;
}
