/**
 * Baileys manager — removeBaileysForSalon teardown (exercised via the
 * SALONES_ENV=test stub path + a real temp session dir).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb, resetDbSingleton } from "../src/db/database.js";
import {
  initBaileysForSalon,
  removeBaileysForSalon,
  getInstance,
  type BaileysManagerOptions,
} from "../src/bot/baileys-manager.js";

let tmp: string;
let options: BaileysManagerOptions;

beforeEach(() => {
  process.env["SALONES_ENV"] = "test";
  tmp = mkdtempSync(join(tmpdir(), "salones-sessions-"));
  options = { sessionsDir: tmp, db: initDb(":memory:") };
});

afterEach(() => {
  resetDbSingleton();
  rmSync(tmp, { recursive: true, force: true });
});

describe("removeBaileysForSalon", () => {
  it("drops the live instance and deletes the on-disk session dir", async () => {
    const salonId = "salon-del-1";
    await initBaileysForSalon(options, salonId, "5255000001");
    expect(getInstance(salonId)).toBeDefined();

    // Simulate persisted creds on disk.
    const sessionDir = join(tmp, salonId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "creds.json"), "{}");
    expect(existsSync(sessionDir)).toBe(true);

    await removeBaileysForSalon(options, salonId);

    expect(getInstance(salonId)).toBeUndefined();
    expect(existsSync(sessionDir)).toBe(false);
  });

  it("is a non-throwing no-op for a salon with no instance and no session dir", async () => {
    await expect(
      removeBaileysForSalon(options, "never-existed"),
    ).resolves.toBeUndefined();
  });
});
