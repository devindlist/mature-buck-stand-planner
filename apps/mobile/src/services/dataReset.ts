import { OfflineManager } from '@maplibre/maplibre-react-native';
import { DEFAULT_SETTINGS, useAppStore } from '../state/store';
import { deleteMapPhotos, wipeAllData } from '../db/database';
import { cancelAllScheduled } from './checkin';
import { forgetHunts } from './huntSession';
import { nextSit } from '../utils/format';

/** Offline basemap packs and the map tile cache (they reveal where the property is). */
async function deleteOfflineMaps(): Promise<void> {
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
  await cancelAllScheduled().catch(() => failed.push('scheduled reminders'));
  await forgetHunts();
  await deleteOfflineMaps().catch(() => failed.push('offline maps'));
  try {
    const report = await wipeAllData();
    if (!report.photosRemoved) failed.push('map photo copies');
  } catch {
    failed.push('the database');
    // The photo copies are files: remove them even though the database would not wipe.
    await deleteMapPhotos().catch(() => failed.push('map photo copies'));
  }
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
