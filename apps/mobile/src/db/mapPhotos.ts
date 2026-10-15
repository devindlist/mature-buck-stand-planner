import * as FileSystem from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';
import { getDb, MAPS_DIR } from './database';

/**
 * Map photos.
 *
 * The aerial photo shows where the stands and bedding are, so it is stored like the rest of
 * the hunter's data: INSIDE the SQLCipher database (table map_images, base64 text, one row
 * per property). The database is the source of truth for the bytes.
 *
 * Screens need a file:// URI, so a plain JPEG is kept as a regenerable CACHE under the
 * cache directory (`<cache>/maps/<file>.jpg`): not included in iCloud or Android backups,
 * and free for the OS to purge. `Property.mapImageUri` stays the relative path
 * ('maps/<file>.jpg'); repos re-root it on read, and `ensureMapPhotoFile` re-creates the
 * file from the database whenever it is missing (purged cache, new app container path).
 *
 * Photos saved by version 1 as plain files in documents/maps/ are moved into the database
 * (and the plain file deleted) the first time they are read.
 */

const slash = (d: string) => (d.endsWith('/') ? d : `${d}/`);
const dirOf = (uri: string) => uri.slice(0, uri.lastIndexOf('/') + 1);
const BASE64 = { encoding: 'base64' as const };

/** A photo in the app's maps folder under ANY container path (iOS Documents/Caches, Android files/cache). */
const APP_MAPS_PHOTO = /^file:\/\/.*\/(?:Documents|files|Caches|cache)\/maps\/([^/]+)$/;

/** The directory the cached photo files live under (cache; documents only where there is no cache directory). */
export function photoRoot(): string | null {
  const dir = FileSystem.cacheDirectory ?? FileSystem.documentDirectory;
  return dir ? slash(dir) : null;
}

const defaultRoots = (): Array<string | null | undefined> => [FileSystem.cacheDirectory, FileSystem.documentDirectory];

/** 'maps/<file>' for a photo in the app's maps folder (current or old container path), else the URI unchanged. */
export function toStoredPhotoUri(uri: string | undefined, roots: ReadonlyArray<string | null | undefined> = defaultRoots()): string | undefined {
  if (!uri || uri.startsWith(MAPS_DIR)) return uri;
  for (const r of roots) {
    if (!r) continue;
    const root = slash(r);
    if (uri.startsWith(`${root}${MAPS_DIR}`)) return uri.slice(root.length);
  }
  const m = APP_MAPS_PHOTO.exec(uri);
  return m ? `${MAPS_DIR}${m[1]}` : uri;
}

/** Absolute file:// URI under the CURRENT cache directory for a stored photo path (anything else is returned as is). */
export function resolvePhotoUri(uri: string | undefined, root: string | null | undefined = photoRoot()): string | undefined {
  const stored = toStoredPhotoUri(uri, defaultRoots());
  if (!stored || !root || !stored.startsWith(MAPS_DIR)) return uri;
  return `${slash(root)}${stored}`;
}

/** Where version 1 kept the file: documents/maps/<file>. */
function legacyUri(stored: string): string | null {
  const docs = FileSystem.documentDirectory;
  return docs ? `${slash(docs)}${stored}` : null;
}

async function fileOk(uri: string): Promise<boolean> {
  try {
    const i: { exists: boolean; isDirectory?: boolean; size?: number } = await FileSystem.getInfoAsync(uri);
    return !!i.exists && !i.isDirectory && (i.size ?? 1) > 0;
  } catch {
    return false;
  }
}

/** Writes the cache file in one step (temp file, then move), so a kill mid-write never leaves a half image. */
async function writeCacheFile(dest: string, b64: string): Promise<void> {
  await FileSystem.makeDirectoryAsync(dirOf(dest), { intermediates: true }).catch(() => undefined);
  const tmp = `${dest}.part`;
  await FileSystem.writeAsStringAsync(tmp, b64, BASE64);
  await FileSystem.deleteAsync(dest, { idempotent: true });
  await FileSystem.moveAsync({ from: tmp, to: dest });
}

/** Stores the photo bytes in the encrypted database (replacing the property's photo). */
async function putPhotoRow(db: SQLiteDatabase, propertyId: string, fileName: string, b64: string): Promise<void> {
  await db.runAsync('INSERT OR REPLACE INTO map_images (property_id, file_name, data_b64, updated_at) VALUES (?, ?, ?, ?)', propertyId, fileName, b64, new Date().toISOString());
}

const fileNameOf = (stored: string) => stored.slice(MAPS_DIR.length);
const inflight = new Map<string, Promise<string>>();

/**
 * Makes sure the displayable file for a property's photo exists, re-creating it from the
 * encrypted database when it is missing, and returns the URI to display. URIs that are not
 * app-managed photos are returned unchanged. Never throws: if nothing can be restored the
 * normal cache URI comes back (the image simply will not load).
 */
export function ensureMapPhotoFile(propertyId: string, uri: string): Promise<string> {
  const stored = toStoredPhotoUri(uri);
  const dest = stored?.startsWith(MAPS_DIR) ? resolvePhotoUri(stored) : undefined;
  if (!stored || !dest) return Promise.resolve(uri);
  const key = `${propertyId}|${stored}`;
  let p = inflight.get(key);
  if (!p) {
    p = materialize(propertyId, stored, dest).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

async function materialize(propertyId: string, stored: string, dest: string): Promise<string> {
  try {
    if (await fileOk(dest)) return dest;
    const db = await getDb();
    const legacy = legacyUri(stored);
    const row = await db.getFirstAsync<{ data_b64: string }>('SELECT data_b64 FROM map_images WHERE property_id = ?', propertyId);
    if (row?.data_b64) {
      await writeCacheFile(dest, row.data_b64);
      if (legacy) await FileSystem.deleteAsync(legacy, { idempotent: true }).catch(() => undefined);
      return dest;
    }
    // Saved by an earlier version as a plain file: move it into the encrypted database first.
    if (legacy && (await fileOk(legacy))) {
      const b64 = await FileSystem.readAsStringAsync(legacy, BASE64);
      if (!b64) return dest;
      await putPhotoRow(db, propertyId, fileNameOf(stored), b64);
      try {
        await writeCacheFile(dest, b64);
      } catch {
        return legacy; // still displayable; the next read finishes the move from the database
      }
      await FileSystem.deleteAsync(legacy, { idempotent: true }).catch(() => undefined);
    }
    return dest;
  } catch {
    const legacy = legacyUri(stored);
    return legacy && (await fileOk(legacy)) ? legacy : dest;
  }
}

/** Re-creates any purged cache file for these properties (call when the app returns to the foreground). */
export async function restoreMapPhotoCache(properties: ReadonlyArray<{ id: string; mapImageUri?: string }>): Promise<void> {
  for (const p of properties) if (p.mapImageUri) await ensureMapPhotoFile(p.id, p.mapImageUri);
}

/**
 * What saving a property must write for its photo: null when the database already holds
 * this exact photo (the common case: every edit of a saved map), otherwise the bytes read
 * from the file. Throws when a NEW property's photo cannot be read: a map that would lose
 * its photo must not be saved. An existing property whose photo is already gone is saved
 * anyway so the hunter can still edit it.
 */
export async function photoToStore(db: SQLiteDatabase, propertyId: string, storedUri: string, sourceUri: string | undefined): Promise<{ fileName: string; data: string } | null> {
  const fileName = fileNameOf(storedUri);
  const row = await db.getFirstAsync<{ file_name: string }>('SELECT file_name FROM map_images WHERE property_id = ?', propertyId);
  if (row?.file_name === fileName) return null;
  const sources = [sourceUri?.startsWith('file://') ? sourceUri : undefined, resolvePhotoUri(storedUri), legacyUri(storedUri) ?? undefined].filter((u): u is string => !!u);
  for (const src of sources) {
    try {
      const data = await FileSystem.readAsStringAsync(src, BASE64);
      if (data) return { fileName, data };
    } catch {
      /* try the next place it could be */
    }
  }
  const existing = await db.getFirstAsync<{ id: string }>('SELECT id FROM properties WHERE id = ?', propertyId);
  if (!row && existing) return null;
  throw new Error('Could not read the map photo to save it. Pick the photo again.');
}

/** Writes the photo row (inside the caller's transaction). */
export async function writePhotoRow(db: SQLiteDatabase, propertyId: string, photo: { fileName: string; data: string }): Promise<void> {
  await putPhotoRow(db, propertyId, photo.fileName, photo.data);
}

/** Removes a property's photo: the database row and every file copy. Best effort on the files. */
export async function deletePropertyPhoto(db: SQLiteDatabase, propertyId: string, storedUri: string | undefined): Promise<void> {
  await db.runAsync('DELETE FROM map_images WHERE property_id = ?', propertyId);
  const stored = toStoredPhotoUri(storedUri);
  if (!stored?.startsWith(MAPS_DIR)) return;
  const files = [resolvePhotoUri(stored), legacyUri(stored)].filter((u): u is string => !!u);
  for (const f of files) await FileSystem.deleteAsync(f, { idempotent: true }).catch(() => undefined);
}

/**
 * Moves a freshly picked/photographed image into the maps cache folder under `fileName`
 * and returns its file:// URI. The picker's own temporary copy is moved (so it no longer
 * lingers in the cache); anything outside the cache directory (never the hunter's original
 * in their gallery) is copied.
 */
export async function adoptPickedPhoto(sourceUri: string, fileName: string): Promise<string> {
  const root = photoRoot();
  if (!root) throw new Error('App storage is not available, so the map photo cannot be saved.');
  const dir = `${root}${MAPS_DIR}`;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => undefined);
  const dest = `${dir}${fileName}`;
  const cache = FileSystem.cacheDirectory;
  if (cache && sourceUri.startsWith(slash(cache))) {
    try {
      await FileSystem.moveAsync({ from: sourceUri, to: dest });
      return dest;
    } catch {
      /* fall through to a copy; the picker's temporary file is swept by deleteTemporaryPhotoCopies */
    }
  }
  await FileSystem.copyAsync({ from: sourceUri, to: dest });
  return dest;
}

/** Deletes a photo file that was picked but never saved with a property (never touches saved photos' database rows). */
export async function discardUnsavedPhoto(uri: string | undefined): Promise<void> {
  const stored = toStoredPhotoUri(uri);
  if (!stored?.startsWith(MAPS_DIR)) return;
  const file = resolvePhotoUri(stored);
  if (file) await FileSystem.deleteAsync(file, { idempotent: true }).catch(() => undefined);
}
