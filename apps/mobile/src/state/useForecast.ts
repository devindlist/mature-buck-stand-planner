import { useCallback, useEffect } from 'react';
import { useAppStore } from './store';
import { loadForecast, manualSnapshot } from '../services/weather';
import { propertyLocation } from '../services/planning';

/**
 * Keeps `weather` in the store in sync with the active property, date and window.
 * Geo-referenced maps auto-fill from NWS; everything else falls back to manual entry.
 * Hunter overrides live in the draft and are applied on top at plan time.
 */
export function useForecast() {
  const property = useAppStore((s) => s.activeProperty());
  const date = useAppStore((s) => s.draft.date);
  const window = useAppStore((s) => s.draft.window);
  const set = useAppStore((s) => s.set);

  const refresh = useCallback(async () => {
    const loc = property ? propertyLocation(property) : undefined;
    if (!property || !loc) {
      const manual = await manualSnapshot();
      set({ weather: manual, weatherStatus: 'error', weatherError: property ? 'Map is not geo-referenced. Set the wind by hand.' : undefined });
      return;
    }
    set({ weatherStatus: 'loading' });
    try {
      const r = await loadForecast(loc, date, window, property.stateCode);
      set({ weather: r.snapshot, weatherStatus: r.status, weatherError: r.note });
    } catch (e) {
      const manual = await manualSnapshot();
      set({ weather: manual, weatherStatus: 'error', weatherError: e instanceof Error ? e.message : 'Forecast unavailable. Set the wind by hand.' });
    }
  }, [property?.id, property?.calibration?.originGeo?.lat, date, window, set]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return refresh;
}
