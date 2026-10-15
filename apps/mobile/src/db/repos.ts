import type { Hunt, Plan, PlanCard, PressureEvent, Property, Sighting, WeatherSnapshot } from '@msp/engine';
import { dataEpoch, getDb, MAPS_DIR } from './database';

export { dataEpoch };
import { ensureMapPhotoFile, deletePropertyPhoto, photoToStore, resolvePhotoUri, toStoredPhotoUri, writePhotoRow } from './mapPhotos';

/** Thin JSON-document repositories over the encrypted SQLite database. */

const parse = <T,>(s: string): T => JSON.parse(s) as T;

// --- Map photos ----------------------------------------------------------
//
// The photo bytes live in the encrypted database (map_images); the JPEG a screen shows is
// a cache file that is re-created from the database whenever it is missing (db/mapPhotos.ts).
// Property.mapImageUri is stored RELATIVE ('maps/<file>.jpg') and resolved against the
// current cache directory on every read, because iOS can move the app container (new UUID
// in the path) and the OS can purge the cache. Old absolute URIs are re-rooted the same way.

export { toStoredPhotoUri, resolvePhotoUri, restoreMapPhotoCache } from './mapPhotos';

/** The property with a displayable photo URI (file re-created from the database if it was purged). */
async function withPhoto(p: Property): Promise<Property> {
  return p.mapImageUri ? { ...p, mapImageUri: await ensureMapPhotoFile(p.id, p.mapImageUri) } : p;
}

// --- Properties -----------------------------------------------------------

export async function listProperties(): Promise<Property[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ data: string }>('SELECT data FROM properties ORDER BY updated_at DESC');
  const out: Property[] = [];
  for (const r of rows) out.push(await withPhoto(parse<Property>(r.data))); // one at a time: a photo is several MB of text
  return out;
}

export async function getProperty(id: string): Promise<Property | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ data: string }>('SELECT data FROM properties WHERE id = ?', id);
  return row ? withPhoto(parse<Property>(row.data)) : null;
}

/**
 * Saves the property. Its map photo goes into the encrypted database in the same
 * transaction (read from the file on first save; later saves of the same photo skip it);
 * the stored property keeps only the relative path. Returns the property with the photo
 * resolved to a displayable file:// URI.
 */
export async function saveProperty(p: Property): Promise<Property> {
  const db = await getDb();
  const next = { ...p, updatedAt: new Date().toISOString() };
  const storedUri = toStoredPhotoUri(next.mapImageUri);
  const photo = storedUri?.startsWith(MAPS_DIR) ? await photoToStore(db, next.id, storedUri, next.mapImageUri) : null;
  const stored = storedUri !== next.mapImageUri ? { ...next, mapImageUri: storedUri } : next;
  await db.withTransactionAsync(async () => {
    if (photo) await writePhotoRow(db, next.id, photo);
    await db.runAsync('INSERT OR REPLACE INTO properties (id, name, updated_at, data) VALUES (?, ?, ?, ?)', next.id, next.name, next.updatedAt, JSON.stringify(stored));
  });
  return next.mapImageUri ? { ...next, mapImageUri: resolvePhotoUri(next.mapImageUri) } : next;
}

export async function deleteProperty(id: string): Promise<void> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ data: string }>('SELECT data FROM properties WHERE id = ?', id);
  const photoUri = row ? parse<Property>(row.data).mapImageUri : undefined;
  await db.withTransactionAsync(async () => {
    for (const t of ['properties', 'plans', 'hunts', 'sightings', 'pressure_events']) {
      await db.runAsync(`DELETE FROM ${t} WHERE ${t === 'properties' ? 'id' : 'property_id'} = ?`, id);
    }
    await db.runAsync('DELETE FROM map_images WHERE property_id = ?', id);
  });
  await deletePropertyPhoto(db, id, photoUri).catch(() => undefined);
}

// --- Plans ---------------------------------------------------------------

export async function savePlan(plan: Plan, card: PlanCard): Promise<void> {
  const db = await getDb();
  await db.runAsync('INSERT OR REPLACE INTO plans (id, property_id, created_at, data, card) VALUES (?, ?, ?, ?, ?)', plan.id, plan.propertyId, plan.createdAt, JSON.stringify(plan), JSON.stringify(card));
  await db.runAsync('INSERT OR REPLACE INTO weather_snapshots (id, at, data) VALUES (?, ?, ?)', plan.inputs.weather.id, plan.inputs.weather.at, JSON.stringify(plan.inputs.weather));
}

export async function getPlan(id: string): Promise<{ plan: Plan; card: PlanCard } | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ data: string; card: string }>('SELECT data, card FROM plans WHERE id = ?', id);
  return row ? { plan: parse<Plan>(row.data), card: parse<PlanCard>(row.card) } : null;
}

export async function latestPlan(propertyId?: string): Promise<{ plan: Plan; card: PlanCard } | null> {
  const db = await getDb();
  const row = propertyId
    ? await db.getFirstAsync<{ data: string; card: string }>('SELECT data, card FROM plans WHERE property_id = ? ORDER BY created_at DESC LIMIT 1', propertyId)
    : await db.getFirstAsync<{ data: string; card: string }>('SELECT data, card FROM plans ORDER BY created_at DESC LIMIT 1');
  return row ? { plan: parse<Plan>(row.data), card: parse<PlanCard>(row.card) } : null;
}

// --- Hunts, sightings, pressure -----------------------------------------------

export async function saveHunt(h: Hunt): Promise<void> {
  const db = await getDb();
  await db.runAsync('INSERT OR REPLACE INTO hunts (id, property_id, date, data) VALUES (?, ?, ?, ?)', h.id, h.propertyId, h.date, JSON.stringify(h));
}

export async function getHunt(id: string): Promise<Hunt | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ data: string }>('SELECT data FROM hunts WHERE id = ?', id);
  return row ? parse<Hunt>(row.data) : null;
}

export async function listHunts(propertyId: string): Promise<Hunt[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ data: string }>('SELECT data FROM hunts WHERE property_id = ? ORDER BY date DESC', propertyId);
  return rows.map((r) => parse<Hunt>(r.data));
}

export async function saveSighting(s: Sighting): Promise<void> {
  const db = await getDb();
  await db.runAsync('INSERT OR REPLACE INTO sightings (id, property_id, at, data) VALUES (?, ?, ?, ?)', s.id, s.propertyId, s.at, JSON.stringify(s));
}

export async function listSightings(propertyId: string, sinceIso?: string): Promise<Sighting[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ data: string }>('SELECT data FROM sightings WHERE property_id = ? AND at >= ? ORDER BY at DESC', propertyId, sinceIso ?? '0000');
  return rows.map((r) => parse<Sighting>(r.data));
}

export async function savePressure(e: PressureEvent): Promise<void> {
  const db = await getDb();
  await db.runAsync('INSERT OR REPLACE INTO pressure_events (id, property_id, at, data) VALUES (?, ?, ?, ?)', e.id, e.propertyId, e.at, JSON.stringify(e));
}

export async function listPressure(propertyId: string): Promise<PressureEvent[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ data: string }>('SELECT data FROM pressure_events WHERE property_id = ? ORDER BY at DESC', propertyId);
  return rows.map((r) => parse<PressureEvent>(r.data));
}

export async function lastWeather(): Promise<WeatherSnapshot | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ data: string }>('SELECT data FROM weather_snapshots ORDER BY at DESC LIMIT 1');
  return row ? parse<WeatherSnapshot>(row.data) : null;
}

// --- Cache & settings ----------------------------------------------------------

export async function cacheGet<T>(key: string, maxAgeMs: number): Promise<T | undefined> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string; fetched_at: number }>('SELECT value, fetched_at FROM cache WHERE key = ?', key);
  if (!row || Date.now() - row.fetched_at > maxAgeMs) return undefined;
  return parse<T>(row.value);
}

/** `epoch`: the dataEpoch() noted when the lookup started; a write after the data was erased is dropped. */
export async function cacheSet(key: string, value: unknown, epoch?: number): Promise<void> {
  if (epoch !== undefined && epoch !== dataEpoch()) return;
  const db = await getDb();
  await db.runAsync('INSERT OR REPLACE INTO cache (key, fetched_at, value) VALUES (?, ?, ?)', key, Date.now(), JSON.stringify(value));
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
  return row ? parse<T>(row.value) : fallback;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  const db = await getDb();
  await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', key, JSON.stringify(value));
}
