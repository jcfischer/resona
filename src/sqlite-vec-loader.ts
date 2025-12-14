/**
 * SQLite-Vec Loader
 *
 * Helper module for loading sqlite-vec extension.
 * On macOS, this requires using Homebrew's SQLite which supports extensions.
 *
 * IMPORTANT: This module must be imported BEFORE any Database is opened
 * to properly configure the custom SQLite library.
 */

import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";

// Flag to track if we've attempted to set the custom SQLite
let customSqliteSet = false;

/**
 * Configure the custom SQLite library for extension support.
 * Must be called BEFORE any Database is opened.
 *
 * On macOS, uses Homebrew's SQLite.
 * On Linux, uses system SQLite (usually supports extensions).
 */
export function configureCustomSqlite(): void {
  if (customSqliteSet) return;

  if (process.platform === "darwin") {
    const SQLITE_PATH = "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib";
    try {
      Database.setCustomSQLite(SQLITE_PATH);
    } catch {
      // Already loaded or other error - ignore
      console.warn(
        "Warning: Could not set custom SQLite. Extensions may not work."
      );
    }
  }

  customSqliteSet = true;
}

/**
 * Create a database with sqlite-vec loaded.
 * Automatically configures custom SQLite if needed.
 */
export function createVecDatabase(path: string = ":memory:"): Database {
  configureCustomSqlite();

  const db = new Database(path);
  sqliteVec.load(db);

  return db;
}

/**
 * Load sqlite-vec into an existing database.
 * Must call configureCustomSqlite() before opening the database.
 */
export function loadVecExtension(db: Database): void {
  sqliteVec.load(db);
}

/**
 * Check if sqlite-vec is available
 */
export function isSqliteVecAvailable(): boolean {
  try {
    configureCustomSqlite();
    const db = new Database(":memory:");
    sqliteVec.load(db);
    const result = db.query("SELECT vec_version()").get() as Record<
      string,
      string
    >;
    db.close();
    return !!result;
  } catch {
    return false;
  }
}

/**
 * Get sqlite-vec version
 */
export function getSqliteVecVersion(): string | null {
  try {
    configureCustomSqlite();
    const db = new Database(":memory:");
    sqliteVec.load(db);
    const result = db.query("SELECT vec_version() as version").get() as {
      version: string;
    };
    db.close();
    return result?.version || null;
  } catch {
    return null;
  }
}
