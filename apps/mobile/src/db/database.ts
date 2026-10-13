import * as SQLite from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system';

/**
 * Encrypted local storage.
 *
 * The database is SQLCipher-encrypted (expo-sqlite built with `useSQLCipher: true`,
 * see app.json); opening refuses to continue on a build without SQLCipher. The 256-bit
 * key is generated on first launch and kept in the iOS Keychain / Android Keystore via
 * expo-secure-store, readable only on this device while unlocked. It never moves to
 * another phone, so a database restored from a backup can't be read: the app explains
 * that and offers to start fresh (resetEncryptedStorage) instead of getting stuck.
 *
 * Map photos are plain image files in the app's private documents folder (maps/), not in
 * the database. Deleting all data removes them too.
 *
 * Nothing in the database leaves the phone unless the hunter explicitly shares a plan
 * card. (Forecast and terrain lookups send coordinates to public services; see Settings.)
 */
const DB_NAME = 'standplanner.db';
const KEY_NAME = 'msp.db.key.v1';
const SCHEMA_VERSION = 1;
/** App-managed map photos, relative to the documents directory. */
export const MAPS_DIR = 'maps/';

/** expo-sqlite's connection; close() releases its cached native handle. */
type Connection = SQLite.SQLiteDatabase & { closeAsync?: () => Promise<void> };

export type StorageErrorKind = 'key_missing' | 'wrong_key' | 'no_cipher' | 'other';

/** Why encrypted storage could not be opened, with a message the hunter can act on. */
export class StorageOpenError extends Error {
  kind: StorageErrorKind;
  /** True when "start fresh" is the only way forward (the data can't be decrypted here). */
  resettable: boolean;
  constructor(kind: StorageErrorKind, message: string) {
    super(message);
    this.name = 'StorageOpenError';
    this.kind = kind;
    this.resettable = kind !== 'no_cipher';
  }
}

const UNREADABLE =
  "This phone has Stand Planner data it can't unlock. That happens after restoring from a backup or moving to a new phone: the encryption key never leaves the phone it was made on, so that copy can't be read here.";

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;
let current: Connection | null = null;
let resetting: Promise<void> | null = null;

const dbDir = () => `${FileSystem.documentDirectory ?? ''}SQLite/`;
const dbFiles = () => ['', '-wal', '-shm', '-journal'].map((s) => `${dbDir()}${DB_NAME}${s}`);

async function dbFileExists(): Promise<boolean> {
  if (!FileSystem.documentDirectory) return false;
  try {
    const info: { exists: boolean } = await FileSystem.getInfoAsync(`${dbDir()}${DB_NAME}`);
    return info.exists;
  } catch {
    return false;
  }
}

async function createKey(): Promise<string> {
  const bytes = await Crypto.getRandomBytesAsync(32);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  await SecureStore.setItemAsync(KEY_NAME, hex, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  return hex;
}

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE IF NOT EXISTS properties (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY NOT NULL, property_id TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL, card TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS plans_property ON plans(property_id, created_at);
    CREATE TABLE IF NOT EXISTS hunts (id TEXT PRIMARY KEY NOT NULL, property_id TEXT NOT NULL, date TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS hunts_property ON hunts(property_id, date);
    CREATE TABLE IF NOT EXISTS sightings (id TEXT PRIMARY KEY NOT NULL, property_id TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS sightings_property ON sightings(property_id, at);
    CREATE TABLE IF NOT EXISTS pressure_events (id TEXT PRIMARY KEY NOT NULL, property_id TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS weather_snapshots (id TEXT PRIMARY KEY NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY NOT NULL, fetched_at INTEGER NOT NULL, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
  `,
};

const isNotADatabase = (e: unknown) => /not a database|SQLITE_NOTADB|code\W*26\b/i.test(e instanceof Error ? e.message : String(e));

async function closeQuietly(db: Connection | null): Promise<void> {
  if (!db) return;
  try {
    await db.closeAsync?.();
  } catch {
    /* already closed */
  }
}

async function open(): Promise<SQLite.SQLiteDatabase> {
  const existingKey = await SecureStore.getItemAsync(KEY_NAME);
  if (!existingKey && (await dbFileExists())) {
    // Never mint a new key over existing data: that would only hide the problem.
    throw new StorageOpenError('key_missing', UNREADABLE);
  }
  const key = existingKey ?? (await createKey());
  const db: Connection = await SQLite.openDatabaseAsync(DB_NAME);
  try {
    // Raw-key form skips SQLCipher's PBKDF2 (the key is already random).
    await db.execAsync(`PRAGMA key = "x'${key}'";`);
    // A plain-SQLite build silently ignores PRAGMA key and would store everything in the
    // clear: refuse before anything is read or written.
    const cipher = await db.getFirstAsync<{ cipher_version?: string }>('PRAGMA cipher_version');
    if (!cipher?.cipher_version) {
      throw new StorageOpenError('no_cipher', "This build of the app doesn't include encrypted storage, so it won't save your data. Install the official release.");
    }
    // Touch the schema: fails fast if the key is wrong.
    await db.getFirstAsync('SELECT count(*) AS n FROM sqlite_master');
    await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    let version = row?.user_version ?? 0;
    while (version < SCHEMA_VERSION) {
      const next = version + 1;
      await db.withTransactionAsync(async () => {
        await db.execAsync(MIGRATIONS[next]);
        await db.execAsync(`PRAGMA user_version = ${next}`);
      });
      version = next;
    }
  } catch (e) {
    await closeQuietly(db);
    if (e instanceof StorageOpenError) throw e;
    if (isNotADatabase(e)) throw new StorageOpenError('wrong_key', UNREADABLE);
    throw new StorageOpenError('other', `Could not open encrypted storage: ${e instanceof Error ? e.message : String(e)}`);
  }
  current = db;
  return db;
}

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  // Never open the old file while a reset is deleting it.
  if (resetting) return resetting.then(getDb, getDb);
  if (!dbPromise) dbPromise = open().catch((e) => {
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

/** Deletes the app's map photos (documents/maps/). */
export async function deleteMapPhotos(): Promise<void> {
  if (!FileSystem.documentDirectory) return;
  await FileSystem.deleteAsync(`${FileSystem.documentDirectory}${MAPS_DIR}`, { idempotent: true });
}

/**
 * Start fresh: closes the database, deletes its files and the map photos, and throws the
 * key away (so any copy left in a backup can never be decrypted), then opens a new,
 * empty encrypted database with a new key.
 */
export async function resetEncryptedStorage(): Promise<void> {
  if (!resetting) {
    resetting = (async () => {
      const pending = dbPromise;
      dbPromise = null;
      if (pending) await pending.catch(() => undefined);
      await closeQuietly(current);
      current = null;
      if (FileSystem.documentDirectory) {
        for (const f of dbFiles()) await FileSystem.deleteAsync(f, { idempotent: true });
      }
      await deleteMapPhotos().catch(() => undefined);
      await SecureStore.deleteItemAsync(KEY_NAME);
    })();
  }
  try {
    await resetting;
  } finally {
    resetting = null;
  }
  await getDb();
}

/**
 * Hunter-initiated wipe (Settings → Delete all data): every table including settings and
 * the emergency contact, plus the map photos. The database file is replaced and the key
 * rotated, so deleted rows can't be recovered from free pages or old backups. Callers
 * also cancel alarms and offline map packs (services/dataReset.ts).
 */
export async function wipeAllData(): Promise<void> {
  try {
    await resetEncryptedStorage();
  } catch {
    // Fall back to emptying the tables in place.
    const db = await getDb();
    await db.execAsync(
      'DELETE FROM properties; DELETE FROM plans; DELETE FROM hunts; DELETE FROM sightings; DELETE FROM pressure_events; DELETE FROM weather_snapshots; DELETE FROM cache; DELETE FROM settings;',
    );
    await db.execAsync('VACUUM;');
    await deleteMapPhotos();
  }
}
