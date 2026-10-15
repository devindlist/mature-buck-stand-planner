import { useCallback, useEffect } from 'react';
import { derivePhase, type LatLon, type Property } from '@msp/engine';
import { useAppStore, type PlanDraft } from './store';
import { cachedForecast, forecastKey, forecastKeyOf, loadForecast, manualSnapshot, tagForecast } from '../services/weather';
import { loadApproxLocations, planLocation, useApproxLocations } from '../services/planning';

/**
 * Keeps `weather` in the store in sync with the active property, date, window and phase.
 * Geo-referenced maps (or photo-only maps with an approximate GPS location) auto-fill
 * from NWS; everything else gets placeholder values the hunter must confirm.
 * Hunter overrides live in the draft and are applied on top at plan time.
 *
 * Every request is numbered and only the newest one may write to the store, so a slow
 * response for a sit the hunter has already moved away from can never overwrite the
 * forecast for the sit they are looking at.
 *
 * A request never leaves the store empty while it runs: the screen is seeded at once with
 * the last forecast downloaded for this sit, or with placeholder values the hunter confirms
 * or edits. A slow or missing network (the usual case at the truck) therefore never blocks
 * Plan Hunt; the real forecast replaces the seed when it arrives.
 */

/** Which sit the current draft needs a forecast for (see forecastKey). */
export function forecastKeyFor(property: Property, draft: Pick<PlanDraft, 'date' | 'window' | 'phaseOverride'>, approx?: LatLon): string {
  const { loc } = planLocation(property, approx);
  const phase = derivePhase(draft.date, property.stateCode, draft.phaseOverride).phase;
  return forecastKey(loc, draft.date, draft.window, phase, property.id);
}

let latestRequest = 0;
let inflight: { key: string; promise: Promise<void> } | null = null;

/**
 * Forgets any request in progress: whatever it returns is dropped instead of written to the
 * store. Delete-all-data calls this, so a forecast for a deleted property cannot reappear.
 */
export function resetForecastState(): void {
  latestRequest += 1;
  inflight = null;
}

/**
 * Loads the forecast for the store's current property and draft. Requests for the
 * same sit that are already in flight are shared (Home and Plan both ask on mount);
 * `force` (Retry) always starts a new one.
 */
export function refreshForecast(force = false): Promise<void> {
  const state = useAppStore.getState();
  const property = state.activeProperty();
  const { date, window, phaseOverride } = state.draft;
  const key = property ? forecastKeyFor(property, state.draft) : 'none';
  if (!force && inflight?.key === key) return inflight.promise;

  const id = ++latestRequest;
  const current = () => id === latestRequest;
  const { set } = state;
  const run = (async () => {
    const loc = property ? planLocation(property).loc : undefined;
    if (!property || !loc) {
      const manual = tagForecast(await manualSnapshot(), key);
      if (!current()) return;
      set({
        weather: manual,
        weatherStatus: 'error',
        weatherError: property ? 'No forecast: this map has no coordinates. Give an approximate location (your GPS) on Plan Hunt, or set the conditions by hand.' : undefined,
      });
      return;
    }
    set({ weatherStatus: 'loading', weatherError: undefined });
    try {
      // Seed the store for THIS sit unless it already holds a forecast for it (a Retry keeps its own).
      if (forecastKeyOf(useAppStore.getState().weather) !== key) {
        const seed = tagForecast((await cachedForecast(loc, date, window, property.stateCode, phaseOverride)) ?? (await manualSnapshot()), key);
        if (!current()) return;
        set({ weather: seed });
      }
      const r = await loadForecast(loc, date, window, property.stateCode, phaseOverride);
      if (!current()) return;
      set({ weather: r.snapshot, weatherStatus: r.status, weatherError: r.note });
    } catch (e) {
      const manual = tagForecast(await manualSnapshot(), key);
      if (!current()) return;
      const why = (e instanceof Error ? e.message : 'Forecast unavailable').replace(/ for https?:\/\/\S+/, '').trim();
      set({ weather: manual, weatherStatus: 'error', weatherError: `${why}${/[.!?]$/.test(why) ? '' : '.'} No forecast loaded: confirm or set the conditions by hand.` });
    }
  })();
  const entry = { key, promise: run };
  inflight = entry;
  return run.finally(() => {
    if (inflight === entry) inflight = null;
  });
}

/** Mount in any screen that shows conditions. Returns a Retry function (forces a new request). */
export function useForecast(): () => Promise<void> {
  const property = useAppStore((s) => s.activeProperty());
  const date = useAppStore((s) => s.draft.date);
  const window = useAppStore((s) => s.draft.window);
  const phaseOverride = useAppStore((s) => s.draft.phaseOverride);
  const approx = useApproxLocations((s) => (property ? s.byProperty[property.id] : undefined));

  useEffect(() => {
    void loadApproxLocations();
  }, []);

  const origin = property?.calibration?.originGeo;
  useEffect(() => {
    void refreshForecast();
  }, [property?.id, property?.stateCode, origin?.lat, origin?.lon, approx?.lat, approx?.lon, date, window, phaseOverride]); // eslint-disable-line react-hooks/exhaustive-deps

  return useCallback(() => refreshForecast(true), []);
}

/**
 * Whether the store's weather belongs to the sit the draft describes. Screens show
 * and plan with it only when `current` is true; while `loading`, Generate waits.
 */
export function useForecastFreshness(): { current: boolean; loading: boolean } {
  const property = useAppStore((s) => s.activeProperty());
  const draft = useAppStore((s) => s.draft);
  const weather = useAppStore((s) => s.weather);
  const status = useAppStore((s) => s.weatherStatus);
  const approx = useApproxLocations((s) => (property ? s.byProperty[property.id] : undefined));
  const current = !!property && !!weather && forecastKeyOf(weather) === forecastKeyFor(property, draft, approx);
  return { current, loading: status === 'loading' || status === 'idle' };
}
