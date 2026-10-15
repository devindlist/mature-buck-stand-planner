import { OfflineManager } from '@maplibre/maplibre-react-native';
import { DEFAULT_SETTINGS, useAppStore } from '../state/store';
import { deleteMapPhotos, wipeAllData } from '../db/database';
import { cancelAllScheduled } from './checkin';
import { forgetHunts } from './huntSession';
import { resetApproxLocations } from './planning';
import { resetForecastState } from '../state/useForecast';
import { nextSit } from '../utils/format';

/** Offline basemap packs and the map tile cache (they reveal where the property is). */
export async function deleteOfflineMaps(): Promise<void> {
  try {
    await OfflineManager.resetDatabase();
    return;
  } catch {
    /* fall back to deleting our packs one by one */
  }
  const packs: Array<{ name: string }> = await OfflineManager.getPacks();
  for (const p of packs) {
    if (String(p.name).startsWith('msp-')) await OfflineManager.deletePack(p.name);
  }
  await OfflineManager.clearAmbientCache();
}

/**
 * Settings → Delete all data. Removes, from this phone: every table (properties, plans,
 * hunts, sightings, pressure, weather, cache, settings incl. the emergency contact), the
 * map photos (the encrypted copy goes with the database; the cache files and the picker and
 * image-manipulator temporary copies are deleted), offline map packs and tile cache, and
 * every scheduled check-in alarm. The database key is rotated so nothing deleted can be
 * decrypted from an old backup.
 * Returns the parts that could not be removed (empty when everything went).
 */
export async function deleteAllData(): Promise<string[]> {
  const failed: string[] = [];
  // Let any start/re-arm that is still scheduling finish first, then cancel: the other order lets a
  // late alarm slip in after the cancel and fire for a hunt that no longer exists.
  await forgetHunts();
  await cancelAllScheduled().catch(() => failed.push('scheduled reminders'));
  // Property positions the hunter gave for photo-only maps: gone from memory and from the saved
  // copy (before the wipe, so they are gone even if the wipe fails), and never written back.
  await resetApproxLocations();
  await deleteOfflineMaps().catch(() => failed.push('offline maps'));
  try {
    const report = await wipeAllData();
    if (!report.photosRemoved) failed.push('map photo copies');
  } catch {
    failed.push('the database');
    // The photo copies are files: remove them even though the database would not wipe.
    await deleteMapPhotos().catch(() => failed.push('map photo copies'));
  }
  // A forecast request still in flight must not put a deleted property's weather back.
  resetForecastState();
  useAppStore.getState().set({
    properties: [],
    activePropertyId: null,
    plan: null,
    selectedStandId: null,
    hunt: null,
    endedHunt: null,
    weather: null,
    weatherStatus: 'idle',
    weatherError: undefined,
    settings: DEFAULT_SETTINGS,
    draft: { ...nextSit(), weaponType: DEFAULT_SETTINGS.defaultWeapon, rangeYds: DEFAULT_SETTINGS.defaultRangeYds, overrides: {} },
  });
  return failed;
}
