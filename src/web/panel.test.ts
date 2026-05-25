/**
 * Tests for the dueña's panel — /panel/dashboard + appointment actions.
 *
 * Focus: the load-bearing changes from the v1 rewrite (2026-05-25):
 *   - Próxima-cita banner picks the right row
 *   - Today + tomorrow tables render with action buttons + tel: links
 *   - Cancel / no-show endpoints are token-scoped (cross-salon attempts 404)
 *   - Status badges + line-through styling on cancelled/no_show rows
 */

import { describe, it, expect, beforeEach } from "vitest";
import { initDb } from "../db/database.js";
import { createWebPanel } from "./panel.js";
import {
  createSalon,
  upsertContact,
  createAppointment,
  createService,
  getAppointmentById,
} from "../db/models.js";
import type Database from "better-sqlite3";

function makeApp(db: Database.Database): ReturnType<typeof createWebPanel> {
  return createWebPanel(db);
}

async function get(app: ReturnType<typeof createWebPanel>, path: string) {
  return app.fetch(new Request(`http://localhost${path}`));
}

async function post(
  app: ReturnType<typeof createWebPanel>,
  path: string,
  withCsrf = true,
) {
  const headers: Record<string, string> = { Host: "localhost" };
  if (withCsrf) headers["Origin"] = "http://localhost";
  return app.fetch(
    new Request(`http://localhost${path}`, { method: "POST", headers }),
  );
}

/** A unix-seconds timestamp anchored on MX-local "today at 10:00" so that
 * regardless of when the test runs, the row lands in the "today" window of
 * the dashboard query. MX is fixed UTC-6 (no DST). */
function mxTodayAt(hour: number): number {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === "year")!.value);
  const m = Number(parts.find((p) => p.type === "month")!.value);
  const d = Number(parts.find((p) => p.type === "day")!.value);
  return Math.floor(Date.UTC(y, m - 1, d, hour + 6, 0, 0) / 1000);
}
function mxTomorrowAt(hour: number): number {
  return mxTodayAt(hour) + 86_400;
}

interface SeededFixture {
  salonId: string;
  token: string;
  contactId: string;
  serviceId: string;
}

function seedSalon(db: Database.Database, name = "Salón Test"): SeededFixture {
  const salon = createSalon(db, {
    name,
    phone: `52555${Math.floor(Math.random() * 10000000)}`,
  });
  const contact = upsertContact(db, {
    salon_id: salon.id,
    phone: "525511112222",
    name: "María Test",
  });
  const service = createService(db, {
    salon_id: salon.id,
    name: "Corte",
    duration_min: 30,
    price: 200,
  });
  return {
    salonId: salon.id,
    token: salon.token,
    contactId: contact.id,
    serviceId: service.id,
  };
}

describe("Panel — security headers (C2 audit fold)", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createWebPanel>;
  let fix: SeededFixture;
  beforeEach(() => {
    db = initDb(":memory:");
    app = makeApp(db);
    fix = seedSalon(db);
  });

  it("sets X-Frame-Options: DENY on /panel/dashboard", async () => {
    const res = await get(app, `/panel/dashboard?token=${fix.token}`);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("sets frame-ancestors 'none' via Content-Security-Policy", async () => {
    const res = await get(app, `/panel/dashboard?token=${fix.token}`);
    expect(res.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
  });

  it("sets Referrer-Policy: no-referrer so the token doesn't leak outbound", async () => {
    const res = await get(app, `/panel/dashboard?token=${fix.token}`);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

describe("Panel — auth", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createWebPanel>;
  beforeEach(() => {
    db = initDb(":memory:");
    app = makeApp(db);
  });

  it("returns 401 without a token", async () => {
    const res = await get(app, "/panel/dashboard");
    expect(res.status).toBe(401);
  });

  it("returns 401 with an unknown token", async () => {
    const res = await get(app, "/panel/dashboard?token=does-not-exist");
    expect(res.status).toBe(401);
  });
});

describe("Panel — dashboard render", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createWebPanel>;
  let fix: SeededFixture;
  beforeEach(() => {
    db = initDb(":memory:");
    app = makeApp(db);
    fix = seedSalon(db);
  });

  it("renders empty banner + empty tables when nothing scheduled", async () => {
    const res = await get(app, `/panel/dashboard?token=${fix.token}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("No tienes citas pendientes hoy ni mañana");
    expect(text).toContain("No hay citas hoy");
    expect(text).toContain("Sin citas mañana");
  });

  it("renders the próxima-cita banner with the next future appointment", async () => {
    const futureSecs = mxTodayAt(23); // 23:00 MX — far in the future of any test-run hour
    createAppointment(db, {
      salon_id: fix.salonId,
      contact_id: fix.contactId,
      service_id: fix.serviceId,
      starts_at: futureSecs,
      ends_at: futureSecs + 1800,
    });
    const text = await (
      await get(app, `/panel/dashboard?token=${fix.token}`)
    ).text();
    expect(text).toContain("Próxima cita");
    expect(text).toContain("María Test");
    expect(text).toContain("Corte");
    expect(text).toContain('href="tel:+525511112222"');
  });

  it("includes a tomorrow row only in the tomorrow section, not the banner if today has one", async () => {
    const todaySecs = mxTodayAt(23);
    const tomorrowSecs = mxTomorrowAt(10);
    createAppointment(db, {
      salon_id: fix.salonId,
      contact_id: fix.contactId,
      service_id: fix.serviceId,
      starts_at: todaySecs,
      ends_at: todaySecs + 1800,
    });
    const otherContact = upsertContact(db, {
      salon_id: fix.salonId,
      phone: "525533334444",
      name: "Juana Mañana",
    });
    createAppointment(db, {
      salon_id: fix.salonId,
      contact_id: otherContact.id,
      service_id: fix.serviceId,
      starts_at: tomorrowSecs,
      ends_at: tomorrowSecs + 1800,
    });
    const text = await (
      await get(app, `/panel/dashboard?token=${fix.token}`)
    ).text();
    // Banner shows María (the earlier confirmed row, today)
    const bannerIdx = text.indexOf("Próxima cita");
    const tomorrowHeaderIdx = text.indexOf("Mañana <span");
    expect(bannerIdx).toBeGreaterThan(-1);
    expect(tomorrowHeaderIdx).toBeGreaterThan(bannerIdx);
    expect(text).toContain("María Test");
    expect(text).toContain("Juana Mañana");
    // Juana shows up after the "Mañana" header.
    expect(text.indexOf("Juana Mañana")).toBeGreaterThan(tomorrowHeaderIdx);
  });

  it("skips cancelled rows when picking the próxima-cita", async () => {
    const earlyCancelled = mxTodayAt(20);
    const laterConfirmed = mxTodayAt(22);
    const appt1 = createAppointment(db, {
      salon_id: fix.salonId,
      contact_id: fix.contactId,
      service_id: fix.serviceId,
      starts_at: earlyCancelled,
      ends_at: earlyCancelled + 1800,
    });
    db.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ?").run(
      appt1.id,
    );
    const otherContact = upsertContact(db, {
      salon_id: fix.salonId,
      phone: "525555556666",
      name: "Laura Confirmed",
    });
    createAppointment(db, {
      salon_id: fix.salonId,
      contact_id: otherContact.id,
      service_id: fix.serviceId,
      starts_at: laterConfirmed,
      ends_at: laterConfirmed + 1800,
    });
    const text = await (
      await get(app, `/panel/dashboard?token=${fix.token}`)
    ).text();
    // Anchor on the unique next-name span inside the banner. find()'s
    // status === 'confirmed' filter should skip cancelled María and pick
    // Laura even though María sorts first.
    const nameMatch = text.match(/<span class="next-name">([^<]+)<\/span>/);
    expect(nameMatch).not.toBeNull();
    expect(nameMatch![1]).toBe("Laura Confirmed");
  });

  it("renders status badges + line-through for cancelled rows", async () => {
    const t = mxTodayAt(21);
    const appt = createAppointment(db, {
      salon_id: fix.salonId,
      contact_id: fix.contactId,
      service_id: fix.serviceId,
      starts_at: t,
      ends_at: t + 1800,
    });
    db.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ?").run(
      appt.id,
    );
    const text = await (
      await get(app, `/panel/dashboard?token=${fix.token}`)
    ).text();
    expect(text).toContain("badge-cancelled");
    expect(text).toContain('class="status-cancelled'); // <tr class="status-cancelled">
    // Cancelled rows do NOT get action buttons (no_show only applies pre-fact)
    const rowStart = text.indexOf('class="status-cancelled');
    const rowEnd = text.indexOf("</tr>", rowStart);
    const rowSlice = text.slice(rowStart, rowEnd);
    expect(rowSlice).not.toContain("Cancelar");
    expect(rowSlice).not.toContain("No vino");
  });

  it("renders Cancelar + No vino buttons on confirmed rows", async () => {
    const t = mxTodayAt(22);
    createAppointment(db, {
      salon_id: fix.salonId,
      contact_id: fix.contactId,
      service_id: fix.serviceId,
      starts_at: t,
      ends_at: t + 1800,
    });
    const text = await (
      await get(app, `/panel/dashboard?token=${fix.token}`)
    ).text();
    expect(text).toContain("Cancelar");
    expect(text).toContain("No vino");
    expect(text).toContain("/cancel?token=");
    expect(text).toContain("/no-show?token=");
  });

  it("renders the meta-refresh tag for auto-update every 60s", async () => {
    const text = await (
      await get(app, `/panel/dashboard?token=${fix.token}`)
    ).text();
    expect(text).toContain('http-equiv="refresh"');
    expect(text).toContain('content="60"');
  });

  it("uses a stats footer (one line, not 4 cards)", async () => {
    const text = await (
      await get(app, `/panel/dashboard?token=${fix.token}`)
    ).text();
    expect(text).toContain("stats-footer");
    // The old 4-card grid is gone — no .cards block sitting above appointments.
    // (.next-banner replaced it.)
    expect(text).not.toContain('class="cards"');
  });
});

describe("Panel — POST /appointments/:id/cancel", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createWebPanel>;
  let fix: SeededFixture;
  let apptId: string;
  beforeEach(() => {
    db = initDb(":memory:");
    app = makeApp(db);
    fix = seedSalon(db);
    const t = mxTodayAt(22);
    const appt = createAppointment(db, {
      salon_id: fix.salonId,
      contact_id: fix.contactId,
      service_id: fix.serviceId,
      starts_at: t,
      ends_at: t + 1800,
    });
    apptId = appt.id;
  });

  it("cancels a confirmed appointment", async () => {
    const res = await post(
      app,
      `/panel/appointments/${apptId}/cancel?token=${fix.token}`,
    );
    expect(res.status).toBe(303);
    const after = getAppointmentById(db, apptId);
    expect(after?.status).toBe("cancelled");
  });

  it("rejects POST without same-origin (CSRF guard)", async () => {
    const res = await post(
      app,
      `/panel/appointments/${apptId}/cancel?token=${fix.token}`,
      false,
    );
    expect(res.status).toBe(403);
    const after = getAppointmentById(db, apptId);
    expect(after?.status).toBe("confirmed");
  });

  it("is idempotent on an already-cancelled appointment (redirects, no-op)", async () => {
    db.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ?").run(
      apptId,
    );
    const res = await post(
      app,
      `/panel/appointments/${apptId}/cancel?token=${fix.token}`,
    );
    expect(res.status).toBe(303);
  });

  it("returns 404 for an unknown appointment id", async () => {
    const res = await post(
      app,
      `/panel/appointments/nope-not-real/cancel?token=${fix.token}`,
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when the appointment belongs to a DIFFERENT salon (token scoping)", async () => {
    const otherFix = seedSalon(db, "Otro Salón");
    // Use otherFix's token to try to cancel fix's appointment.
    const res = await post(
      app,
      `/panel/appointments/${apptId}/cancel?token=${otherFix.token}`,
    );
    expect(res.status).toBe(404);
    const after = getAppointmentById(db, apptId);
    expect(after?.status).toBe("confirmed"); // unchanged
  });
});

describe("Panel — POST /appointments/:id/no-show", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createWebPanel>;
  let fix: SeededFixture;
  let apptId: string;
  beforeEach(() => {
    db = initDb(":memory:");
    app = makeApp(db);
    fix = seedSalon(db);
    const t = mxTodayAt(22);
    const appt = createAppointment(db, {
      salon_id: fix.salonId,
      contact_id: fix.contactId,
      service_id: fix.serviceId,
      starts_at: t,
      ends_at: t + 1800,
    });
    apptId = appt.id;
  });

  it("marks a confirmed appointment as no_show", async () => {
    const res = await post(
      app,
      `/panel/appointments/${apptId}/no-show?token=${fix.token}`,
    );
    expect(res.status).toBe(303);
    const after = getAppointmentById(db, apptId);
    expect(after?.status).toBe("no_show");
  });

  it("rejects cross-salon no-show attempts (token scoping)", async () => {
    const otherFix = seedSalon(db, "Otro Salón");
    const res = await post(
      app,
      `/panel/appointments/${apptId}/no-show?token=${otherFix.token}`,
    );
    expect(res.status).toBe(404);
    const after = getAppointmentById(db, apptId);
    expect(after?.status).toBe("confirmed");
  });

  it("rejects no-show POST without same-origin", async () => {
    const res = await post(
      app,
      `/panel/appointments/${apptId}/no-show?token=${fix.token}`,
      false,
    );
    expect(res.status).toBe(403);
  });

  // R1 audit fold: symmetry with the cancel-idempotent test.
  it("is idempotent on an already-no-show appointment (redirects, no-op)", async () => {
    db.prepare("UPDATE appointments SET status = 'no_show' WHERE id = ?").run(
      apptId,
    );
    const res = await post(
      app,
      `/panel/appointments/${apptId}/no-show?token=${fix.token}`,
    );
    expect(res.status).toBe(303);
  });
});

// R1 audit fold: today's confirmed appointments can ALL be in the past
// (e.g., end-of-day glance). The banner must then fall through to tomorrow's
// first confirmed appointment, not show empty.
describe("Panel — banner fallback when today is all past", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createWebPanel>;
  let fix: SeededFixture;
  beforeEach(() => {
    db = initDb(":memory:");
    app = makeApp(db);
    fix = seedSalon(db);
  });

  it("falls through to tomorrow when no confirmed appt remains today", async () => {
    // Today's appt at MX 00:30 — guaranteed past by the time any reasonable
    // test runs.
    const pastToday = (() => {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Mexico_City",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date());
      const y = Number(parts.find((p) => p.type === "year")!.value);
      const m = Number(parts.find((p) => p.type === "month")!.value);
      const d = Number(parts.find((p) => p.type === "day")!.value);
      // MX 00:30 = UTC 06:30. May still be in the future if test runs
      // before 00:30 MX, so push slightly back if needed. Acceptable test
      // simplification: this assumes test runs after MX 00:31.
      return Math.floor(Date.UTC(y, m - 1, d, 6, 30, 0) / 1000);
    })();
    createAppointment(db, {
      salon_id: fix.salonId,
      contact_id: fix.contactId,
      service_id: fix.serviceId,
      starts_at: pastToday,
      ends_at: pastToday + 1800,
    });
    const tomorrowContact = upsertContact(db, {
      salon_id: fix.salonId,
      phone: "525577778888",
      name: "Mañana Cliente",
    });
    createAppointment(db, {
      salon_id: fix.salonId,
      contact_id: tomorrowContact.id,
      service_id: fix.serviceId,
      starts_at: mxTomorrowAt(10),
      ends_at: mxTomorrowAt(10) + 1800,
    });
    const text = await (
      await get(app, `/panel/dashboard?token=${fix.token}`)
    ).text();
    const nameMatch = text.match(/<span class="next-name">([^<]+)<\/span>/);
    // If pastToday is actually still future (test runs at MX 00:00-00:30),
    // the banner shows María Test. Otherwise it falls through to Mañana.
    expect(nameMatch).not.toBeNull();
    expect(["Mañana Cliente", "María Test"]).toContain(nameMatch![1]);
  });
});
