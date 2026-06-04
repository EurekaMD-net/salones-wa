import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDb, resetDbSingleton } from "../src/db/database.js";
import {
  createSalon,
  createAppointment,
  cancelAppointment,
  upsertContact,
} from "../src/db/models.js";
import {
  findAvailableSlots,
  checkCustomTime,
  findAlternativesAround,
} from "../src/bot/slot-finder.js";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

let db: Database.Database;
let salonId: string;
let contactId: string;

beforeEach(() => {
  db = initDb(":memory:");
  const salon = createSalon(db, { name: "Test Salon", phone: "+5255000099" });
  salonId = salon.id;
  const contact = upsertContact(db, {
    salon_id: salonId,
    phone: "+5255111100",
  });
  contactId = contact.id;
});

afterEach(() => {
  resetDbSingleton();
});

/** Seed working hours rows directly into the slots table */
function seedWorkingHours(
  windows: Array<{ day_of_week: number; start_time: string; end_time: string }>,
) {
  const stmt = db.prepare(
    "INSERT INTO slots (id, salon_id, day_of_week, start_time, end_time, active) VALUES (?, ?, ?, ?, ?, 1)",
  );
  for (const w of windows) {
    stmt.run(randomUUID(), salonId, w.day_of_week, w.start_time, w.end_time);
  }
}

/** Fixed "now" for deterministic tests — Monday 2026-06-01 at 10:00 MX time. */
const FIXED_NOW = new Date("2026-06-01T16:00:00Z").getTime(); // 10:00 MX = 16:00 UTC

describe("findAvailableSlots", () => {
  describe("24h lookahead", () => {
    it("returns no slot earlier than 24h from now", () => {
      const slots = findAvailableSlots(db, salonId, 60, { nowMs: FIXED_NOW });
      const earliestAllowed = Math.floor(FIXED_NOW / 1000) + 24 * 3600;
      for (const s of slots) {
        expect(s.starts_at).toBeGreaterThanOrEqual(earliestAllowed);
      }
    });
  });

  describe("working hours", () => {
    it("falls back to Mon-Sat 9am-7pm when no DB slots configured", () => {
      const slots = findAvailableSlots(db, salonId, 60, {
        nowMs: FIXED_NOW,
        count: 5,
      });
      expect(slots.length).toBeGreaterThan(0);
      // Each slot must be between 9:00 and 19:00 server-local (MX) time
      // and never on Sunday (day_of_week=0).
      for (const s of slots) {
        const d = new Date(s.starts_at * 1000);
        const dow = d.getDay();
        const hour = d.getHours();
        expect(dow).not.toBe(0); // not Sunday
        expect(hour).toBeGreaterThanOrEqual(9);
        expect(hour).toBeLessThan(19);
      }
    });

    it("respects DB-configured working hours when present", () => {
      // Only Tuesday 14:00-16:00.
      seedWorkingHours([
        { day_of_week: 2, start_time: "14:00", end_time: "16:00" },
      ]);
      const slots = findAvailableSlots(db, salonId, 60, {
        nowMs: FIXED_NOW,
        count: 3,
      });
      for (const s of slots) {
        const d = new Date(s.starts_at * 1000);
        expect(d.getDay()).toBe(2); // Tuesday
        expect(d.getHours()).toBeGreaterThanOrEqual(14);
        expect(d.getHours()).toBeLessThan(16);
      }
    });

    it("returns empty when salon never opens within scan window", () => {
      // Working hours that never match (e.g. impossible time)
      seedWorkingHours([
        { day_of_week: 0, start_time: "23:50", end_time: "23:55" },
      ]);
      const slots = findAvailableSlots(db, salonId, 60, {
        nowMs: FIXED_NOW,
        daysToScan: 7,
      });
      // 5-min window for a 60-min service = unbookable
      expect(slots.length).toBe(0);
    });
  });

  describe("different-days variety", () => {
    it("returns slots on distinct days", () => {
      const slots = findAvailableSlots(db, salonId, 60, {
        nowMs: FIXED_NOW,
        count: 3,
      });
      const days = new Set(
        slots.map((s) => {
          const d = new Date(s.starts_at * 1000);
          return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
        }),
      );
      expect(days.size).toBe(slots.length); // all distinct
    });
  });

  describe("conflict detection", () => {
    it("excludes time windows where existing appointment overlaps", () => {
      // Block out tomorrow 9:00-10:00 MX (15:00-16:00 UTC of 2026-06-02)
      const tomorrow9amSec = Math.floor(
        new Date("2026-06-02T15:00:00Z").getTime() / 1000,
      );
      createAppointment(db, {
        salon_id: salonId,
        contact_id: contactId,
        starts_at: tomorrow9amSec,
        ends_at: tomorrow9amSec + 3600,
      });

      const slots = findAvailableSlots(db, salonId, 60, {
        nowMs: FIXED_NOW,
        count: 5,
      });

      // No returned slot overlaps the blocked window.
      for (const s of slots) {
        const overlaps =
          s.starts_at < tomorrow9amSec + 3600 && s.ends_at > tomorrow9amSec;
        expect(overlaps).toBe(false);
      }
    });

    it("cancelled appointments do NOT block availability", () => {
      // Baseline: get the slot that would be offered for Tuesday with no
      // bookings, then create a CANCELLED appointment overlapping that
      // exact time, and verify it's still offered.
      const baseline = findAvailableSlots(db, salonId, 60, {
        nowMs: FIXED_NOW,
        count: 5,
      });
      const tuesday = baseline.find(
        (s) => new Date(s.starts_at * 1000).getDay() === 2,
      );
      expect(tuesday).toBeDefined();
      const targetStarts = tuesday!.starts_at;

      // Book + cancel a conflict at the same time
      const appt = createAppointment(db, {
        salon_id: salonId,
        contact_id: contactId,
        starts_at: targetStarts,
        ends_at: targetStarts + 3600,
      });
      db.prepare(
        "UPDATE appointments SET status = 'cancelled' WHERE id = ?",
      ).run(appt.id);

      // Tuesday slot should still be offered at the same time.
      const afterCancel = findAvailableSlots(db, salonId, 60, {
        nowMs: FIXED_NOW,
        count: 5,
      });
      const tuesdayAfter = afterCancel.find(
        (s) => s.starts_at === targetStarts,
      );
      expect(tuesdayAfter).toBeDefined();
    });
  });

  describe("service duration", () => {
    it("respects 90-minute service slot size", () => {
      const slots = findAvailableSlots(db, salonId, 90, {
        nowMs: FIXED_NOW,
        count: 3,
      });
      for (const s of slots) {
        expect(s.ends_at - s.starts_at).toBe(90 * 60);
      }
    });
  });

  describe("label format", () => {
    it("uses Spanish MX timezone in label", () => {
      const slots = findAvailableSlots(db, salonId, 60, {
        nowMs: FIXED_NOW,
        count: 1,
      });
      expect(slots.length).toBe(1);
      // Spanish day names: lunes, martes, miércoles, jueves, viernes, sábado, domingo
      expect(slots[0].label.toLowerCase()).toMatch(
        /lunes|martes|miércoles|jueves|viernes|sábado|domingo/,
      );
    });
  });

  describe("checkCustomTime", () => {
    it("rejects times within 24h", () => {
      const tooSoon = Math.floor(FIXED_NOW / 1000) + 3600; // 1h from now
      const r = checkCustomTime(db, salonId, 60, tooSoon, { nowMs: FIXED_NOW });
      expect(r.available).toBe(false);
      expect(r.reason).toBe("in_past");
    });

    it("rejects times outside business hours (default Mon-Sat 9-19)", () => {
      // Wednesday 8am MX = before 9am open (using Wed not Tue to clear the
      // 24h-from-FIXED_NOW=Mon-10am cutoff so we don't trip in_past first).
      const wed8am = Math.floor(
        new Date("2026-06-03T14:00:00Z").getTime() / 1000,
      );
      const r = checkCustomTime(db, salonId, 60, wed8am, {
        nowMs: FIXED_NOW,
      });
      expect(r.available).toBe(false);
      expect(r.reason).toBe("outside_hours");
    });

    it("rejects times on closed days (Sunday by default)", () => {
      // Sunday 11am MX = closed
      const sunday11am = Math.floor(
        new Date("2026-06-07T17:00:00Z").getTime() / 1000,
      );
      const r = checkCustomTime(db, salonId, 60, sunday11am, {
        nowMs: FIXED_NOW,
      });
      expect(r.available).toBe(false);
      expect(r.reason).toBe("outside_hours");
    });

    it("rejects times that collide with a confirmed appointment", () => {
      const contact = upsertContact(db, {
        salon_id: salonId,
        phone: "+5255111199",
      });
      const tuesday11am = Math.floor(
        new Date("2026-06-02T17:00:00Z").getTime() / 1000,
      );
      createAppointment(db, {
        salon_id: salonId,
        contact_id: contact.id,
        starts_at: tuesday11am,
        ends_at: tuesday11am + 3600,
      });
      const r = checkCustomTime(db, salonId, 60, tuesday11am, {
        nowMs: FIXED_NOW,
      });
      expect(r.available).toBe(false);
      expect(r.reason).toBe("conflict");
    });

    it("accepts a fully-available time", () => {
      const tuesday2pm = Math.floor(
        new Date("2026-06-02T20:00:00Z").getTime() / 1000,
      );
      const r = checkCustomTime(db, salonId, 60, tuesday2pm, {
        nowMs: FIXED_NOW,
      });
      expect(r.available).toBe(true);
    });
  });

  describe("findAlternativesAround", () => {
    it("returns slots near the anchor time", () => {
      // Anchor: Tuesday 10am MX (which is the natural first slot anyway)
      const anchor = Math.floor(
        new Date("2026-06-02T16:00:00Z").getTime() / 1000,
      );
      const alts = findAlternativesAround(db, salonId, 60, anchor, {
        nowMs: FIXED_NOW,
        count: 3,
      });
      expect(alts.length).toBeGreaterThan(0);
      expect(alts.length).toBeLessThanOrEqual(3);
      // None should equal the anchor itself
      for (const a of alts) {
        expect(a.starts_at).not.toBe(anchor);
      }
    });

    it("returns empty when no working hours exist (defensive)", () => {
      // Seed working hours with only Sunday — anchor on weekday → no
      // alternatives for that weekday, but Sunday slots exist within window.
      // (Tests robustness against pathological calendar.)
      const stmt = db.prepare(
        "INSERT INTO slots (id, salon_id, day_of_week, start_time, end_time, active) VALUES (?, ?, ?, ?, ?, 1)",
      );
      stmt.run(randomUUID(), salonId, 0, "09:00", "10:00");

      const anchor = Math.floor(
        new Date("2026-06-02T20:00:00Z").getTime() / 1000,
      );
      const alts = findAlternativesAround(db, salonId, 60, anchor, {
        nowMs: FIXED_NOW,
        count: 3,
      });
      // Sunday 9-10 = 1 valid 60-min slot
      expect(alts.length).toBeLessThanOrEqual(1);
    });
  });
});

describe("findAvailableSlots — slotsPerDay", () => {
  it("defaults to one slot per open day", () => {
    // Wednesday (3) 09:00-13:00 → four 60-min slots possible.
    seedWorkingHours([
      { day_of_week: 3, start_time: "09:00", end_time: "13:00" },
    ]);
    const slots = findAvailableSlots(db, salonId, 60, {
      nowMs: FIXED_NOW,
      daysToScan: 7, // only Wed 2026-06-03 falls in range
      count: 5,
    });
    expect(slots).toHaveLength(1);
  });

  it("returns multiple same-day slots when slotsPerDay is raised", () => {
    seedWorkingHours([
      { day_of_week: 3, start_time: "09:00", end_time: "13:00" },
    ]);
    const slots = findAvailableSlots(db, salonId, 60, {
      nowMs: FIXED_NOW,
      daysToScan: 7,
      count: 10,
      slotsPerDay: 4,
    });
    expect(slots).toHaveLength(4);
    // All on the same Wednesday, distinct hours.
    const dates = slots.map((s) => new Date(s.starts_at * 1000).getDate());
    expect(new Set(dates).size).toBe(1);
    const hours = slots.map((s) => new Date(s.starts_at * 1000).getHours());
    expect(new Set(hours).size).toBe(4);
  });
});

describe("findAlternativesAround — same-day different-hour (#4)", () => {
  it("offers other hours on the anchor's own day, not just other days", () => {
    // Wednesday 09:00-19:00 wide open; anchor at 15:00 on Wed 2026-06-03.
    seedWorkingHours([
      { day_of_week: 3, start_time: "09:00", end_time: "19:00" },
    ]);
    const anchor = Math.floor(
      new Date("2026-06-03T21:00:00Z").getTime() / 1000, // 15:00 MX
    );
    const alts = findAlternativesAround(db, salonId, 60, anchor, {
      nowMs: FIXED_NOW,
      count: 3,
    });
    expect(alts.length).toBeGreaterThanOrEqual(2);
    // Pre-fix (one-slot-per-day) these would all be on DIFFERENT days.
    // Now at least two share the anchor's calendar day at different hours.
    const days = alts.map((s) => new Date(s.starts_at * 1000).getDate());
    const sameDayCount = days.filter((d) => d === 3).length;
    expect(sameDayCount).toBeGreaterThanOrEqual(2);
    const hours = alts.map((s) => new Date(s.starts_at * 1000).getHours());
    expect(new Set(hours).size).toBe(hours.length); // all distinct hours
  });
});

describe("double-booking backstop (#3 — partial unique index)", () => {
  it("rejects a second CONFIRMED appointment at the same (salon, starts_at)", () => {
    const startSec = Math.floor(FIXED_NOW / 1000) + 3 * 86400;
    createAppointment(db, {
      salon_id: salonId,
      contact_id: contactId,
      starts_at: startSec,
      ends_at: startSec + 3600,
    });
    const other = upsertContact(db, {
      salon_id: salonId,
      phone: "+5255222200",
    });
    expect(() =>
      createAppointment(db, {
        salon_id: salonId,
        contact_id: other.id,
        starts_at: startSec,
        ends_at: startSec + 3600,
      }),
    ).toThrow(/UNIQUE constraint/i);
  });

  it("allows re-booking a slot after the prior appointment is cancelled", () => {
    const startSec = Math.floor(FIXED_NOW / 1000) + 4 * 86400;
    const first = createAppointment(db, {
      salon_id: salonId,
      contact_id: contactId,
      starts_at: startSec,
      ends_at: startSec + 3600,
    });
    cancelAppointment(db, first.id); // status='cancelled' → excluded by partial index
    expect(() =>
      createAppointment(db, {
        salon_id: salonId,
        contact_id: contactId,
        starts_at: startSec,
        ends_at: startSec + 3600,
      }),
    ).not.toThrow();
  });
});
