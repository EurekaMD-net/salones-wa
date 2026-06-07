import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDb, resetDbSingleton } from "../src/db/database.js";
import {
  createSalon,
  addService,
  upsertContact,
  createAppointment,
  cancelAppointment,
  completePassedAppointments,
  getNextAppointmentForContact,
  getNextConfirmedAppointmentForSalon,
  getUpcomingAppointmentsFor24h,
  getUpcomingAppointmentsFor2h,
  markReminded24h,
  markReminded2h,
  getDormantContacts,
  updateDormantFlags,
  createCampaign,
  hasRecentCampaign,
  getCampaignStats,
  getSalonByToken,
  getSalonByPhone,
  getSalonById,
  deleteSalon,
  getSalonDataCounts,
  setSlotsForSalon,
} from "../src/db/models.js";
import type Database from "better-sqlite3";

let db: Database.Database;

beforeEach(() => {
  db = initDb(":memory:");
});

afterEach(() => {
  resetDbSingleton();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function now() {
  return Math.floor(Date.now() / 1000);
}
function hoursFromNow(h: number) {
  return now() + h * 3600;
}

function makeSalon(phone = "+5255000001") {
  return createSalon(db, { name: "Salón Test", phone });
}

function makeContact(salon_id: string, phone = "+5255100001") {
  return upsertContact(db, { salon_id, phone, name: "Clienta Test" });
}

function makeAppointment(
  salon_id: string,
  contact_id: string,
  startOffset = 25,
) {
  const starts_at = hoursFromNow(startOffset);
  const ends_at = starts_at + 3600;
  return createAppointment(db, { salon_id, contact_id, starts_at, ends_at });
}

// ─── Salons ───────────────────────────────────────────────────────────────────

describe("deleteSalon", () => {
  function countRows(salon_id: string) {
    const n = (sql: string) =>
      (db.prepare(sql).get(salon_id) as { n: number }).n;
    return {
      salons: n("SELECT COUNT(*) AS n FROM salons WHERE id = ?"),
      services: n("SELECT COUNT(*) AS n FROM services WHERE salon_id = ?"),
      slots: n("SELECT COUNT(*) AS n FROM slots WHERE salon_id = ?"),
      contacts: n("SELECT COUNT(*) AS n FROM contacts WHERE salon_id = ?"),
      appointments: n(
        "SELECT COUNT(*) AS n FROM appointments WHERE salon_id = ?",
      ),
      campaigns: n("SELECT COUNT(*) AS n FROM campaigns WHERE salon_id = ?"),
    };
  }

  function seedSalonWithData(phone: string) {
    const salon = makeSalon(phone);
    addService(db, {
      salon_id: salon.id,
      name: "Corte",
      duration_min: 30,
      price: 200,
    });
    setSlotsForSalon(db, salon.id, [
      { day_of_week: 1, start_time: "09:00", end_time: "18:00" },
    ]);
    const contact = makeContact(salon.id, phone + "9");
    makeAppointment(salon.id, contact.id);
    createCampaign(db, { salon_id: salon.id, contact_id: contact.id });
    return salon;
  }

  it("removes the salon row and returns 1", () => {
    const salon = makeSalon();
    expect(deleteSalon(db, salon.id)).toBe(1);
    expect(getSalonById(db, salon.id)).toBeNull();
  });

  it("returns 0 for an unknown id (no-op)", () => {
    expect(deleteSalon(db, "does-not-exist")).toBe(0);
  });

  it("cascades to EVERY child table (services/slots/contacts/appointments/campaigns)", () => {
    const salon = seedSalonWithData("+5255000111");
    // Pre-condition: the salon really has data in each table.
    const before = countRows(salon.id);
    expect(before).toEqual({
      salons: 1,
      services: 1,
      slots: 1,
      contacts: 1,
      appointments: 1,
      campaigns: 1,
    });

    deleteSalon(db, salon.id);

    // Cascade must leave zero orphans in every child table.
    expect(countRows(salon.id)).toEqual({
      salons: 0,
      services: 0,
      slots: 0,
      contacts: 0,
      appointments: 0,
      campaigns: 0,
    });
  });

  it("only deletes the target salon — a sibling's data is untouched", () => {
    const victim = seedSalonWithData("+5255000222");
    const keep = seedSalonWithData("+5255000333");

    deleteSalon(db, victim.id);

    expect(countRows(victim.id).salons).toBe(0);
    // The other tenant is fully intact.
    expect(countRows(keep.id)).toEqual({
      salons: 1,
      services: 1,
      slots: 1,
      contacts: 1,
      appointments: 1,
      campaigns: 1,
    });
  });
});

describe("getSalonDataCounts", () => {
  it("reports per-table counts for the salon", () => {
    const salon = makeSalon("+5255000444");
    addService(db, {
      salon_id: salon.id,
      name: "Tinte",
      duration_min: 60,
      price: 500,
    });
    addService(db, {
      salon_id: salon.id,
      name: "Peinado",
      duration_min: 45,
    });
    setSlotsForSalon(db, salon.id, [
      { day_of_week: 2, start_time: "10:00", end_time: "19:00" },
    ]);
    const contact = makeContact(salon.id, "+5255000445");
    makeAppointment(salon.id, contact.id);
    createCampaign(db, { salon_id: salon.id, contact_id: contact.id });

    expect(getSalonDataCounts(db, salon.id)).toEqual({
      services: 2,
      slots: 1,
      contacts: 1,
      appointments: 1,
      campaigns: 1,
    });
  });

  it("is all-zeros for a salon with no data", () => {
    const salon = makeSalon("+5255000446");
    expect(getSalonDataCounts(db, salon.id)).toEqual({
      services: 0,
      slots: 0,
      contacts: 0,
      appointments: 0,
      campaigns: 0,
    });
  });
});

describe("createSalon", () => {
  it("creates a salon with a token", () => {
    const s = makeSalon();
    expect(s.id).toBeTruthy();
    expect(s.token).toBeTruthy();
    expect(s.name).toBe("Salón Test");
    expect(s.active).toBe(1);
  });

  it("token is a uuid-like string", () => {
    const s = makeSalon();
    expect(s.token).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("throws on duplicate phone", () => {
    makeSalon("+5255000001");
    expect(() => makeSalon("+5255000001")).toThrow();
  });
});

describe("getSalonByToken", () => {
  it("returns salon by valid token", () => {
    const s = makeSalon();
    const found = getSalonByToken(db, s.token);
    expect(found?.id).toBe(s.id);
  });

  it("returns null for invalid token", () => {
    expect(getSalonByToken(db, "bad-token")).toBeNull();
  });
});

describe("getSalonByPhone", () => {
  it("returns salon by phone", () => {
    const s = makeSalon();
    const found = getSalonByPhone(db, s.phone);
    expect(found?.id).toBe(s.id);
  });
});

// ─── Services ────────────────────────────────────────────────────────────────

describe("addService", () => {
  it("creates service for a salon", () => {
    const salon = makeSalon();
    const svc = addService(db, {
      salon_id: salon.id,
      name: "Corte",
      duration_min: 45,
      price: 150,
    });
    expect(svc.name).toBe("Corte");
    expect(svc.duration_min).toBe(45);
    expect(svc.price).toBe(150);
  });
});

// ─── Contacts ────────────────────────────────────────────────────────────────

describe("upsertContact", () => {
  it("creates a new contact", () => {
    const salon = makeSalon();
    const c = upsertContact(db, {
      salon_id: salon.id,
      phone: "+5255100001",
      name: "Ana",
    });
    expect(c.name).toBe("Ana");
    expect(c.visit_count).toBe(0);
  });

  it("returns existing contact on duplicate", () => {
    const salon = makeSalon();
    const c1 = upsertContact(db, { salon_id: salon.id, phone: "+5255100001" });
    const c2 = upsertContact(db, { salon_id: salon.id, phone: "+5255100001" });
    expect(c1.id).toBe(c2.id);
  });

  it("updates name if not set on existing contact", () => {
    const salon = makeSalon();
    upsertContact(db, { salon_id: salon.id, phone: "+5255100001" });
    const c2 = upsertContact(db, {
      salon_id: salon.id,
      phone: "+5255100001",
      name: "María",
    });
    expect(c2.name).toBe("María");
  });

  it("same phone on different salons are distinct contacts", () => {
    const s1 = makeSalon("+5255000001");
    const s2 = makeSalon("+5255000002");
    const c1 = upsertContact(db, { salon_id: s1.id, phone: "+5255100001" });
    const c2 = upsertContact(db, { salon_id: s2.id, phone: "+5255100001" });
    expect(c1.id).not.toBe(c2.id);
  });
});

// ─── Appointments ─────────────────────────────────────────────────────────────

describe("createAppointment", () => {
  it("creates an appointment with confirmed status", () => {
    const salon = makeSalon();
    const contact = makeContact(salon.id);
    const appt = makeAppointment(salon.id, contact.id, 25);
    expect(appt.status).toBe("confirmed");
    expect(appt.reminded_24h).toBe(0);
    expect(appt.reminded_2h).toBe(0);
  });
});

describe("cancelAppointment", () => {
  it("marks appointment as cancelled", () => {
    const salon = makeSalon();
    const contact = makeContact(salon.id);
    const appt = makeAppointment(salon.id, contact.id);
    cancelAppointment(db, appt.id);
    const updated = db
      .prepare("SELECT * FROM appointments WHERE id = ?")
      .get(appt.id) as { status: string };
    expect(updated.status).toBe("cancelled");
  });
});

describe("getNextConfirmedAppointmentForSalon", () => {
  it("returns the next confirmed cita, unbounded forward", () => {
    const salon = makeSalon();
    const contact = makeContact(salon.id);
    // +5 days out (well past the old 2-day window)
    makeAppointment(salon.id, contact.id, 24 * 5);
    const next = getNextConfirmedAppointmentForSalon(db, salon.id, now());
    expect(next).not.toBeNull();
    expect(next!.status).toBe("confirmed");
    expect(next!.contact_phone).toBe("+5255100001");
  });

  it("picks the earliest of multiple confirmed citas", () => {
    const salon = makeSalon();
    const a = makeContact(salon.id, "+5255100001");
    const b = upsertContact(db, {
      salon_id: salon.id,
      phone: "+5255100002",
      name: "Más cerca",
    });
    makeAppointment(salon.id, a.id, 96); // +4 days
    makeAppointment(salon.id, b.id, 48); // +2 days — earlier
    const next = getNextConfirmedAppointmentForSalon(db, salon.id, now());
    expect(next!.contact_phone).toBe("+5255100002");
  });

  it("skips cancelled and no_show rows", () => {
    const salon = makeSalon();
    const a = makeContact(salon.id, "+5255100001");
    const b = upsertContact(db, {
      salon_id: salon.id,
      phone: "+5255100002",
      name: "Confirmada",
    });
    const cancelled = makeAppointment(salon.id, a.id, 24); // +1 day, will cancel
    cancelAppointment(db, cancelled.id);
    makeAppointment(salon.id, b.id, 96); // +4 days
    const next = getNextConfirmedAppointmentForSalon(db, salon.id, now());
    expect(next!.contact_phone).toBe("+5255100002");
  });

  it("returns null when no confirmed citas remain", () => {
    const salon = makeSalon();
    const contact = makeContact(salon.id);
    const appt = makeAppointment(salon.id, contact.id, 48);
    cancelAppointment(db, appt.id);
    expect(getNextConfirmedAppointmentForSalon(db, salon.id, now())).toBeNull();
  });

  it("excludes citas from other salons (salon_id scoping)", () => {
    const a = makeSalon("+5255000001");
    const b = makeSalon("+5255000002");
    const contactInB = makeContact(b.id, "+5255100009");
    makeAppointment(b.id, contactInB.id, 24);
    expect(getNextConfirmedAppointmentForSalon(db, a.id, now())).toBeNull();
  });
});

describe("getNextAppointmentForContact", () => {
  it("returns next confirmed appointment", () => {
    const salon = makeSalon();
    const contact = makeContact(salon.id);
    const appt = makeAppointment(salon.id, contact.id, 48);
    const next = getNextAppointmentForContact(db, contact.id);
    expect(next?.id).toBe(appt.id);
  });

  it("returns null if no upcoming appointments", () => {
    const salon = makeSalon();
    const contact = makeContact(salon.id);
    expect(getNextAppointmentForContact(db, contact.id)).toBeNull();
  });

  it("ignores cancelled appointments", () => {
    const salon = makeSalon();
    const contact = makeContact(salon.id);
    const appt = makeAppointment(salon.id, contact.id, 48);
    cancelAppointment(db, appt.id);
    expect(getNextAppointmentForContact(db, contact.id)).toBeNull();
  });
});

describe("getUpcomingAppointmentsFor24h", () => {
  it("returns appointments in 23-25h window", () => {
    const salon = makeSalon();
    const contact = makeContact(salon.id);
    // appointment in 24h window
    makeAppointment(salon.id, contact.id, 24);
    const results = getUpcomingAppointmentsFor24h(db);
    expect(results.length).toBeGreaterThan(0);
  });

  it("does not return already-reminded appointments", () => {
    const salon = makeSalon();
    const contact = makeContact(salon.id);
    const appt = makeAppointment(salon.id, contact.id, 24);
    markReminded24h(db, appt.id);
    const results = getUpcomingAppointmentsFor24h(db);
    expect(
      results.find((a: { id: string }) => a.id === appt.id),
    ).toBeUndefined();
  });

  it("does not return appointments outside window (e.g. 1h away)", () => {
    const salon = makeSalon();
    const contact = makeContact(salon.id);
    makeAppointment(salon.id, contact.id, 1); // 1h from now — outside 23-25h window
    const results = getUpcomingAppointmentsFor24h(db);
    expect(results.length).toBe(0);
  });
});

describe("getUpcomingAppointmentsFor2h", () => {
  it("returns appointments in 1.5-3h window", () => {
    const salon = makeSalon();
    const contact = makeContact(salon.id);
    makeAppointment(salon.id, contact.id, 2);
    const results = getUpcomingAppointmentsFor2h(db);
    expect(results.length).toBeGreaterThan(0);
  });

  it("does not return already-reminded appointments", () => {
    const salon = makeSalon();
    const contact = makeContact(salon.id);
    const appt = makeAppointment(salon.id, contact.id, 2);
    markReminded2h(db, appt.id);
    const results = getUpcomingAppointmentsFor2h(db);
    expect(
      results.find((a: { id: string }) => a.id === appt.id),
    ).toBeUndefined();
  });
});

describe("completePassedAppointments", () => {
  it("marks past confirmed appointments as completed", () => {
    const salon = makeSalon();
    const contact = makeContact(salon.id);
    // Appointment in the past
    const starts_at = now() - 7200;
    const ends_at = now() - 3600;
    const appt = createAppointment(db, {
      salon_id: salon.id,
      contact_id: contact.id,
      starts_at,
      ends_at,
    });

    const count = completePassedAppointments(db);
    expect(count).toBeGreaterThan(0);

    const updated = db
      .prepare("SELECT * FROM appointments WHERE id = ?")
      .get(appt.id) as { status: string };
    expect(updated.status).toBe("completed");
  });

  it("does not touch future appointments", () => {
    const salon = makeSalon();
    const contact = makeContact(salon.id);
    const appt = makeAppointment(salon.id, contact.id, 48); // future
    completePassedAppointments(db);
    const updated = db
      .prepare("SELECT * FROM appointments WHERE id = ?")
      .get(appt.id) as { status: string };
    expect(updated.status).toBe("confirmed");
  });

  it("is idempotent across multiple cron runs (P0-2 regression pin)", () => {
    // Seed 3 contacts each with one past confirmed appointment
    const salon = makeSalon();
    const contacts = Array.from({ length: 3 }, (_, i) => {
      const c = upsertContact(db, {
        salon_id: salon.id,
        phone: `+525510000${i + 10}`,
      });
      db.prepare(
        `INSERT INTO appointments (id, salon_id, contact_id, starts_at, ends_at, status)
         VALUES (?, ?, ?, ?, ?, 'confirmed')`,
      ).run(
        `apt-idem-${i}`,
        salon.id,
        c.id,
        now() - 7200 - i,
        now() - 3600 - i,
      );
      return c;
    });

    // First run — transitions all 3 to 'completed' and bumps visit_count to 1
    expect(completePassedAppointments(db)).toBe(3);
    const lastVisitsAfterFirst = contacts.map(
      (c) =>
        db
          .prepare("SELECT visit_count, last_visit FROM contacts WHERE id = ?")
          .get(c.id) as { visit_count: number; last_visit: number },
    );
    for (const v of lastVisitsAfterFirst) expect(v.visit_count).toBe(1);

    // Subsequent 4 runs — should be no-ops
    for (let i = 0; i < 4; i++) expect(completePassedAppointments(db)).toBe(0);

    // visit_count and last_visit must be unchanged after runs 2-5
    for (let i = 0; i < contacts.length; i++) {
      const after = db
        .prepare("SELECT visit_count, last_visit FROM contacts WHERE id = ?")
        .get(contacts[i].id) as { visit_count: number; last_visit: number };
      expect(after.visit_count).toBe(1);
      expect(after.last_visit).toBe(lastVisitsAfterFirst[i].last_visit);
    }
  });
});

// ─── Dormant contacts ─────────────────────────────────────────────────────────

describe("getDormantContacts", () => {
  it("returns contacts with visit_count >= 1 and last_visit > 30 days ago", () => {
    const salon = makeSalon();
    const contact = upsertContact(db, {
      salon_id: salon.id,
      phone: "+5255100001",
    });
    // Set visit_count=1 and last_visit = 40 days ago
    const fortyDaysAgo = now() - 40 * 86400;
    db.prepare(
      "UPDATE contacts SET visit_count = 1, last_visit = ? WHERE id = ?",
    ).run(fortyDaysAgo, contact.id);

    const dormants = getDormantContacts(db, salon.id);
    expect(dormants.find((c) => c.id === contact.id)).toBeTruthy();
  });

  it("excludes contacts with visit_count = 0", () => {
    const salon = makeSalon();
    upsertContact(db, { salon_id: salon.id, phone: "+5255100002" });
    // visit_count defaults to 0
    const dormants = getDormantContacts(db, salon.id);
    expect(dormants.length).toBe(0);
  });

  it("excludes contacts with active upcoming appointment", () => {
    const salon = makeSalon();
    const contact = upsertContact(db, {
      salon_id: salon.id,
      phone: "+5255100003",
    });
    const fortyDaysAgo = now() - 40 * 86400;
    db.prepare(
      "UPDATE contacts SET visit_count = 1, last_visit = ? WHERE id = ?",
    ).run(fortyDaysAgo, contact.id);
    makeAppointment(salon.id, contact.id, 48); // has future appointment
    const dormants = getDormantContacts(db, salon.id);
    expect(dormants.find((c) => c.id === contact.id)).toBeUndefined();
  });

  it("excludes opted-out contacts", () => {
    const salon = makeSalon();
    const contact = upsertContact(db, {
      salon_id: salon.id,
      phone: "+5255100004",
    });
    const fortyDaysAgo = now() - 40 * 86400;
    db.prepare(
      "UPDATE contacts SET visit_count = 1, last_visit = ?, opt_out = 1 WHERE id = ?",
    ).run(fortyDaysAgo, contact.id);
    const dormants = getDormantContacts(db, salon.id);
    expect(dormants.find((c) => c.id === contact.id)).toBeUndefined();
  });
});

describe("updateDormantFlags", () => {
  it("updates dormant flag for qualifying contacts", () => {
    const salon = makeSalon();
    const contact = upsertContact(db, {
      salon_id: salon.id,
      phone: "+5255100001",
    });
    const fortyDaysAgo = now() - 40 * 86400;
    db.prepare(
      "UPDATE contacts SET visit_count = 1, last_visit = ? WHERE id = ?",
    ).run(fortyDaysAgo, contact.id);

    const changes = updateDormantFlags(db);
    expect(changes).toBeGreaterThan(0);

    const updated = db
      .prepare("SELECT dormant FROM contacts WHERE id = ?")
      .get(contact.id) as { dormant: number };
    expect(updated.dormant).toBe(1);
  });
});

// ─── Campaigns ────────────────────────────────────────────────────────────────

describe("createCampaign / hasRecentCampaign", () => {
  it("creates a campaign", () => {
    const salon = makeSalon();
    const contact = makeContact(salon.id);
    const cam = createCampaign(db, {
      salon_id: salon.id,
      contact_id: contact.id,
    });
    expect(cam.type).toBe("reactivation");
    expect(cam.responded).toBe(0);
    expect(cam.booked).toBe(0);
  });

  it("hasRecentCampaign returns true after sending", () => {
    const salon = makeSalon();
    const contact = makeContact(salon.id);
    createCampaign(db, { salon_id: salon.id, contact_id: contact.id });
    expect(hasRecentCampaign(db, contact.id, 30)).toBe(true);
  });

  it("hasRecentCampaign returns false if no campaign", () => {
    const salon = makeSalon();
    const contact = makeContact(salon.id);
    expect(hasRecentCampaign(db, contact.id, 30)).toBe(false);
  });
});

describe("getCampaignStats", () => {
  it("returns totals, responded, booked", () => {
    const salon = makeSalon();
    const c1 = makeContact(salon.id, "+5255100001");
    const c2 = upsertContact(db, { salon_id: salon.id, phone: "+5255100002" });
    const cam1 = createCampaign(db, { salon_id: salon.id, contact_id: c1.id });
    const cam2 = createCampaign(db, { salon_id: salon.id, contact_id: c2.id });
    db.prepare(
      "UPDATE campaigns SET responded = 1, booked = 1 WHERE id = ?",
    ).run(cam1.id);
    db.prepare("UPDATE campaigns SET responded = 1 WHERE id = ?").run(cam2.id);

    const stats = getCampaignStats(db, salon.id);
    expect(stats.total).toBe(2);
    expect(stats.responded).toBe(2);
    expect(stats.booked).toBe(1);
  });
});
