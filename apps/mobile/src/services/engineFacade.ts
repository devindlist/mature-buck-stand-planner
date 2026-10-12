/**
 * Single import point for the engine inside the app, plus tiny adapters.
 * Keeps screens decoupled from engine module layout.
 */
export * from '@msp/engine';
import { nws, type WeatherSnapshot } from '@msp/engine';
import type { PlanDraft } from '../state/store';

export function applyOverridesSafe(w: WeatherSnapshot, o: PlanDraft['overrides']): WeatherSnapshot {
  return nws.applyOverrides(w, o);
}
