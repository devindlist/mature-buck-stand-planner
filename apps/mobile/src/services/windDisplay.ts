import { compass16, downwindBearing, type WeatherSnapshot } from '@msp/engine';
import type { PlanDraft } from '../state/store';

/**
 * What the global wind badge (top right of every screen) shows, decided in one place.
 *
 * The rule behind all of it: a wind is only drawn as a wind when somebody vouches for it. A
 * forecast does. The hunter's own entry does. Placeholder defaults (no forecast, nothing
 * confirmed) do not, and a forecast for another sit, or one that is still loading, is shown
 * dimmed and marked, never as if it were current.
 */
export type BadgeWind =
  /** Nothing to show: no forecast and no entry. */
  | { kind: 'none' }
  /** Placeholder defaults the hunter has not set or confirmed. `loading` while a forecast is on its way. */
  | { kind: 'defaults'; loading: boolean }
  | {
      kind: 'wind';
      /** Where the wind blows FROM, degrees. */
      fromDeg: number;
      /** Unknown (undefined) shows as "?" rather than an invented number. */
      speedMph?: number;
      /** The hunter set or observed it (marked with a dot). */
      own: boolean;
      /** Dimmed, with this word instead of the speed: the forecast shown is not for the sit on screen. */
      stale?: 'loading' | 'other_sit';
      /** Where it comes from, for the spoken label. */
      from: 'draft' | 'plan' | 'observed';
    };

/** How long a wind the hunter tapped at the tree stays the best wind there is (mirrors Hunt mode). */
export const OBSERVED_WIND_TTL_MIN = 180;

/**
 * Which wind the badge follows on the current screen. Results, the plan card and Hunt mode are
 * about a finished plan, so they show the plan's own wind (Hunt: the wind the hunter tapped at
 * the tree, while it is fresh). Every other screen shows the conditions of the sit in the draft.
 */
export type BadgeScreen = 'draft' | 'plan' | 'hunt';

/** The badge's source for a route path as expo-router reports it. */
export function badgeScreen(pathname: string | null | undefined): BadgeScreen {
  const path = (pathname ?? '').split('?')[0].replace(/\/+$/, '') || '/';
  return path === '/hunt' ? 'hunt' : path === '/results' || path === '/plan-card' ? 'plan' : 'draft';
}

/** True when the wind the hunter tapped at the tree is recent enough to rely on. */
export function observedWindFresh(observedAt: string | undefined, now: number): boolean {
  if (!observedAt) return false;
  const at = Date.parse(observedAt);
  return Number.isFinite(at) && now - at < OBSERVED_WIND_TTL_MIN * 60_000;
}

/**
 * The wind for Home, Plan Hunt, the map screens and the rest: the conditions of the sit
 * in the draft. `fresh` says whether the stored weather belongs to that sit and has settled.
 */
export function draftBadgeWind(weather: WeatherSnapshot | null, overrides: PlanDraft['overrides'], fresh: { current: boolean; loading: boolean }): BadgeWind {
  // Placeholder defaults are never a wind. (Once the hunter has confirmed them they are in `overrides`.)
  const forecast = weather && !weather.placeholder ? weather : undefined;
  const settled = fresh.current && !fresh.loading;
  const ownDir = overrides.windFromDeg !== undefined;
  const fromDeg = overrides.windFromDeg ?? forecast?.windFromDeg;
  if (fromDeg === undefined) return weather?.placeholder ? { kind: 'defaults', loading: fresh.loading } : { kind: 'none' };
  const own = ownDir || overrides.windSpeedMph !== undefined;
  // The hunter's direction stands on its own; a speed from a forecast that is not settled does not.
  const speedMph = overrides.windSpeedMph ?? (ownDir && !settled ? undefined : forecast?.windSpeedMph);
  const stale = !ownDir && !settled ? (fresh.loading ? 'loading' : 'other_sit') : undefined;
  return { kind: 'wind', fromDeg, speedMph, own, stale, from: 'draft' };
}

/** The wind a plan was made with (its own weather, hunter entries already applied). */
export function planBadgeWind(planWeather: WeatherSnapshot | null | undefined, observed?: { fromDeg: number }): BadgeWind {
  if (observed) return { kind: 'wind', fromDeg: observed.fromDeg, own: true, from: 'observed' };
  if (!planWeather) return { kind: 'none' };
  if (planWeather.placeholder) return { kind: 'defaults', loading: false };
  const own = planWeather.overriddenFields.includes('windFromDeg') || planWeather.overriddenFields.includes('windSpeedMph') || planWeather.source === 'manual';
  return { kind: 'wind', fromDeg: planWeather.windFromDeg, speedMph: planWeather.windSpeedMph, own, from: 'plan' };
}

const mph = (n: number) => `${Math.round(n)} mile${Math.round(n) === 1 ? '' : 's'} per hour`;

/** What a screen reader says for the badge: always names where the wind comes from, and what is uncertain. */
export function badgeLabel(w: BadgeWind): string {
  if (w.kind === 'none') return 'Wind not set. Opens wind settings.';
  if (w.kind === 'defaults') return w.loading ? 'Wind unknown: the forecast is loading. Opens wind settings.' : 'Wind unknown: no forecast, and the default values are not confirmed. Opens wind settings to set the wind.';
  const who = w.from === 'plan' ? 'Plan wind' : w.from === 'observed' ? 'Your wind at the tree' : 'Wind';
  const speed = w.speedMph === undefined ? 'speed unknown' : `at ${mph(w.speedMph)}`;
  const base = `${who} from ${compass16(w.fromDeg)}, ${speed}. Scent blows ${compass16(downwindBearing(w.fromDeg))}.`;
  if (w.stale === 'loading') return `${base} Not confirmed: the forecast for this sit is still loading.`;
  if (w.stale === 'other_sit') return `${base} Not current: this is the forecast for a different sit.`;
  return `${base}${w.own && w.from === 'draft' ? ' Set by you.' : ''}`;
}
