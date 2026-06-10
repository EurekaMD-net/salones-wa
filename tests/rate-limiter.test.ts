/**
 * Outbound rate limiting (WA Anti-Abuse Plan §1.2). Covers config/gating, the
 * TZ-correct day-key, the pure decision, persisted counters (per-pair vs
 * per-salon-total, replies counted toward the total only), the gate
 * orchestrator (drop vs send, send-before-record), pruning, and drop metrics.
 * Uses a real in-memory SQLite with the production schema.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../src/db/schema.js";
import {
  loadRateLimitConfig,
  dayKey,
  decideUnsolicited,
  pairCount,
  salonDayTotal,
  recordUnsolicited,
  recordReply,
  recordReplyOutbound,
  pruneOldCounters,
  gateUnsolicited,
  recordDrop,
  snapshotDrops,
  resetDrops,
  type RateLimitConfig,
} from "../src/bot/rate-limiter.js";

const cfg = (over: Partial<RateLimitConfig> = {}): RateLimitConfig => ({
  enabled: true,
  perPairPerDay: 5,
  perSalonPerDay: 200,
  defaultTimeZone: "America/Mexico_City",
  ...over,
});

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  db.prepare(
    "INSERT INTO salons (id, name, phone, token) VALUES ('s1','S1','5210000000001','t1')",
  ).run();
  return db;
}

let db: Database.Database;
beforeEach(() => {
  db = freshDb();
  resetDrops();
});
afterEach(() => db.close());

describe("loadRateLimitConfig", () => {
  it("defaults to disabled with plan caps", () => {
    const c = loadRateLimitConfig({});
    expect(c.enabled).toBe(false);
    expect(c.perPairPerDay).toBe(5);
    expect(c.perSalonPerDay).toBe(200);
    expect(c.defaultTimeZone).toBe("America/Mexico_City");
  });
  it("enables on RATE_LIMIT_ENABLED, parses overrides", () => {
    const c = loadRateLimitConfig({
      RATE_LIMIT_ENABLED: "true",
      RATE_LIMIT_PER_PAIR: "3",
      RATE_LIMIT_PER_SALON_DAY: "50",
    });
    expect(c.enabled).toBe(true);
    expect(c.perPairPerDay).toBe(3);
    expect(c.perSalonPerDay).toBe(50);
  });
  it("forces disabled under SALONES_ENV=test", () => {
    expect(
      loadRateLimitConfig({ SALONES_ENV: "test", RATE_LIMIT_ENABLED: "true" })
        .enabled,
    ).toBe(false);
  });
});

describe("dayKey", () => {
  it("is YYYY-MM-DD in the given TZ (MX = UTC-6)", () => {
    expect(
      dayKey(new Date("2026-06-10T05:30:00Z"), "America/Mexico_City"),
    ).toBe(
      "2026-06-09", // 23:30 prev day in MX
    );
    expect(
      dayKey(new Date("2026-06-10T18:00:00Z"), "America/Mexico_City"),
    ).toBe("2026-06-10");
    expect(dayKey(new Date("2026-06-10T05:30:00Z"), "UTC")).toBe("2026-06-10");
  });
});

describe("decideUnsolicited", () => {
  it("allows under both caps", () => {
    expect(decideUnsolicited(4, 199, cfg())).toEqual({ allowed: true });
  });
  it("drops on the pair cap (checked first)", () => {
    expect(decideUnsolicited(5, 0, cfg())).toEqual({
      allowed: false,
      reason: "pair_cap",
    });
  });
  it("drops on the salon cap", () => {
    expect(decideUnsolicited(0, 200, cfg())).toEqual({
      allowed: false,
      reason: "salon_cap",
    });
  });
});

describe("counters", () => {
  it("recordUnsolicited bumps both pair and salon total", () => {
    recordUnsolicited(db, "s1", "p1", "2026-06-10");
    recordUnsolicited(db, "s1", "p1", "2026-06-10");
    recordUnsolicited(db, "s1", "p2", "2026-06-10");
    expect(pairCount(db, "s1", "p1", "2026-06-10")).toBe(2);
    expect(pairCount(db, "s1", "p2", "2026-06-10")).toBe(1);
    expect(salonDayTotal(db, "s1", "2026-06-10")).toBe(3);
  });
  it("recordReply bumps the salon total only (not any pair)", () => {
    recordReply(db, "s1", "2026-06-10");
    expect(salonDayTotal(db, "s1", "2026-06-10")).toBe(1);
    expect(pairCount(db, "s1", "p1", "2026-06-10")).toBe(0);
  });
  it("counters are per-day", () => {
    recordUnsolicited(db, "s1", "p1", "2026-06-10");
    expect(pairCount(db, "s1", "p1", "2026-06-11")).toBe(0);
    expect(salonDayTotal(db, "s1", "2026-06-11")).toBe(0);
  });
});

describe("recordReplyOutbound", () => {
  it("no-ops when disabled (reply hot-path untouched)", () => {
    recordReplyOutbound(
      db,
      cfg({ enabled: false }),
      "s1",
      "America/Mexico_City",
    );
    // nothing recorded for any day
    const total = db
      .prepare("SELECT COALESCE(SUM(total),0) t FROM outbound_salon_daily")
      .get() as { t: number };
    expect(total.t).toBe(0);
  });
  it("records toward the salon total when enabled", () => {
    const now = new Date("2026-06-10T18:00:00Z");
    recordReplyOutbound(db, cfg(), "s1", "America/Mexico_City", now);
    expect(salonDayTotal(db, "s1", "2026-06-10")).toBe(1);
  });
});

describe("gateUnsolicited", () => {
  const key = (over = {}) => ({
    salonId: "s1",
    clientaPhone: "p1",
    kind: "reminder" as const,
    timeZone: "America/Mexico_City",
    now: new Date("2026-06-10T18:00:00Z"),
    ...over,
  });

  it("disabled: always sends, records nothing", async () => {
    let sends = 0;
    const ok = await gateUnsolicited(
      db,
      cfg({ enabled: false }),
      key(),
      async () => void sends++,
    );
    expect(ok).toBe(true);
    expect(sends).toBe(1);
    expect(salonDayTotal(db, "s1", "2026-06-10")).toBe(0);
  });

  it("enabled & under caps: sends then records (send-before-record)", async () => {
    const order: string[] = [];
    const ok = await gateUnsolicited(db, cfg(), key(), async () => {
      // counter must not be bumped yet at send time
      expect(pairCount(db, "s1", "p1", "2026-06-10")).toBe(0);
      order.push("send");
    });
    expect(ok).toBe(true);
    expect(order).toEqual(["send"]);
    expect(pairCount(db, "s1", "p1", "2026-06-10")).toBe(1);
    expect(salonDayTotal(db, "s1", "2026-06-10")).toBe(1);
  });

  it("drops on pair cap without sending, records the drop metric", async () => {
    for (let i = 0; i < 5; i++) recordUnsolicited(db, "s1", "p1", "2026-06-10");
    let sends = 0;
    const reasons: string[] = [];
    const ok = await gateUnsolicited(
      db,
      cfg(),
      key(),
      async () => void sends++,
      (r) => reasons.push(r),
    );
    expect(ok).toBe(false);
    expect(sends).toBe(0);
    expect(reasons).toEqual(["pair_cap"]);
    expect(snapshotDrops()).toContainEqual({
      salonId: "s1",
      kind: "reminder",
      reason: "pair_cap",
      count: 1,
    });
  });

  it("drops on salon cap (total reached via other clientas)", async () => {
    const c = cfg({ perSalonPerDay: 2 });
    recordUnsolicited(db, "s1", "pX", "2026-06-10");
    recordUnsolicited(db, "s1", "pY", "2026-06-10"); // salon total = 2
    let sends = 0;
    const ok = await gateUnsolicited(
      db,
      c,
      key({ clientaPhone: "p1" }),
      async () => void sends++,
    );
    expect(ok).toBe(false);
    expect(sends).toBe(0);
    expect(snapshotDrops()[0]?.reason).toBe("salon_cap");
  });
});

describe("pruneOldCounters", () => {
  it("deletes rows strictly before the cutoff day", () => {
    recordUnsolicited(db, "s1", "p1", "2026-06-01");
    recordUnsolicited(db, "s1", "p1", "2026-06-10");
    const pruned = pruneOldCounters(db, "2026-06-05");
    expect(pruned).toBeGreaterThanOrEqual(2); // counter + salon_daily rows for 06-01
    expect(pairCount(db, "s1", "p1", "2026-06-01")).toBe(0);
    expect(pairCount(db, "s1", "p1", "2026-06-10")).toBe(1);
  });
});

describe("drop metrics", () => {
  it("aggregates by salon+kind+reason", () => {
    recordDrop("s1", "reminder", "pair_cap");
    recordDrop("s1", "reminder", "pair_cap");
    recordDrop("s1", "reactivation", "salon_cap");
    const snap = snapshotDrops();
    expect(snap).toContainEqual({
      salonId: "s1",
      kind: "reminder",
      reason: "pair_cap",
      count: 2,
    });
    expect(snap).toContainEqual({
      salonId: "s1",
      kind: "reactivation",
      reason: "salon_cap",
      count: 1,
    });
  });
});
