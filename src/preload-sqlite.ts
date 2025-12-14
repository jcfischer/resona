/**
 * Preload script for sqlite-vec tests
 *
 * This file must be loaded BEFORE any Database is opened.
 * Use with: bun test --preload ./src/preload-sqlite.ts
 *
 * Or add to bunfig.toml:
 * [test]
 * preload = ["./src/preload-sqlite.ts"]
 */

import { Database } from "bun:sqlite";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // Ignore if already set
  }
}
