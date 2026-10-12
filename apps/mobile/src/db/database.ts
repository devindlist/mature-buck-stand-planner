import * as SQLite from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';

/**
 * Encrypted local storage.
 *
 * The database is SQLCipher-encrypted (expo-sqlite built with `useSQLCipher: true`,
 * see app.json). The 256-bit key is generated on first launch and kept in the
 * iOS Keychain / Android Keystore via expo-secure-store, readable only on this device
 * while unlocked. Nothing in the database ever leaves the phone unless the hunter
 * explicitly shares a plan card.
 */
const DB_NAME = 'standplanner.db';
const KEY_NAME = 'msp.db.key.v1';
const SCHEMA_VERSION = 1;

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function getOrCreateKey(): Promise<string> {
  const existing = await SecureStore.getItemAsync(KEY_NAME);
  if (existing) return existing;
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

async function open(): Promise<SQLite.SQLiteDatabase> {
  const key = await getOrCreateKey();
  const db = await SQLite.openDatabaseAsync(DB_NAME);
  // Raw-key form skips SQLCipher's PBKDF2 (the key is already random).
  await db.execAsync(`PRAGMA key = "x'${key}'";`);
  await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  // Touch the schema: fails fast if the key is wrong.
  await db.getFirstAsync('SELECT count(*) AS n FROM sqlite_master');
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
  return db;
}

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) dbPromise = open().catch((e) => {
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

/** Hunter-initiated wipe (Settings → Delete all data). */
export async function wipeAllData(): Promise<void> {
  const db = await getDb();
  await db.execAsync('DELETE FROM properties; DELETE FROM plans; DELETE FROM hunts; DELETE FROM sightings; DELETE FROM pressure_events; DELETE FROM weather_snapshots; DELETE FROM cache;');
}
