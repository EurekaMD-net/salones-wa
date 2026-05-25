import Database from "better-sqlite3";
import { SCHEMA_SQL } from "./schema.js";
import { mkdirSync } from "fs";
import { dirname } from "path";

let _db: Database.Database | null = null;

export function getDb(path: string = "./data/salones.db"): Database.Database {
  if (_db) return _db;
  mkdirSync(dirname(path), { recursive: true });
  _db = new Database(path);
  _db.exec(SCHEMA_SQL);
  applyAdditiveMigrations(_db);
  return _db;
}

/**
 * Idempotent column-adds for existing DBs. SCHEMA_SQL uses CREATE TABLE IF
 * NOT EXISTS, so columns added to a CREATE TABLE statement do NOT reach a
 * pre-existing table — they need an explicit ALTER. SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, so we check PRAGMA table_info first.
 */
function applyAdditiveMigrations(db: Database.Database): void {
  const salonCols = db.prepare("PRAGMA table_info(salons)").all() as Array<{
    name: string;
  }>;
  if (!salonCols.some((c) => c.name === "owner_phone")) {
    db.exec("ALTER TABLE salons ADD COLUMN owner_phone TEXT");
    // R3 audit fold: log the migration so prod operators can confirm it ran
    // (no observable side effect otherwise — the field is null on old rows).
    console.log("[salones-wa] migration: added salons.owner_phone column");
  }
}

/** For tests — pass :memory: */
export function initDb(path: string): Database.Database {
  _db = null;
  return getDb(path);
}

export function resetDbSingleton(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
