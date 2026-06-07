/**
 * Admin UI tests
 * Covers: auth guard, salon CRUD, service management, toggle
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initDb } from "../db/database.js";
import { createAdminPanel } from "./admin.js";
import {
  createSalon,
  getSalonById,
  getAllSalons,
  getServices,
  getSlotsForSalon,
  setSlotsForSalon,
  isValidWorkingHour,
} from "../db/models.js";
import { findAvailableSlots } from "../bot/slot-finder.js";
import type Database from "better-sqlite3";

const ADMIN_TOKEN = "test-admin-token";

function makeApp(db: Database.Database) {
  process.env["ADMIN_TOKEN"] = ADMIN_TOKEN;
  return createAdminPanel(db);
}

async function get(app: ReturnType<typeof makeApp>, path: string) {
  const req = new Request(`http://localhost${path}`);
  return app.fetch(req);
}

async function post(
  app: ReturnType<typeof makeApp>,
  path: string,
  body?: Record<string, string>,
) {
  const formData = new URLSearchParams(body ?? {});
  const req = new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "http://localhost",
      Host: "localhost", // CSRF check: node Request doesn't auto-add Host
    },
    body: formData.toString(),
  });
  return app.fetch(req);
}

describe("Admin Panel — Auth guard", () => {
  let db: Database.Database;
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    db = initDb(":memory:");
    app = makeApp(db);
  });

  it("returns 401 when no token", async () => {
    const res = await get(app, "/admin");
    expect(res.status).toBe(401);
  });

  it("returns 401 when wrong token", async () => {
    const res = await get(app, "/admin?token=wrongtoken");
    expect(res.status).toBe(401);
  });

  it("returns 200 with correct token", async () => {
    const res = await get(app, `/admin?token=${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Admin Salones");
  });

  it("returns 503 when ADMIN_TOKEN is missing at request time (P0-1 regression pin)", async () => {
    // createAdminPanel is called at module-load time (ADMIN_TOKEN valid then).
    // getAdminToken() is called per-request; if env is unset at that point → 503.
    const orig = process.env["ADMIN_TOKEN"];
    delete process.env["ADMIN_TOKEN"];
    try {
      const res = await get(app, "/admin?token=whatever");
      expect(res.status).toBe(503);
    } finally {
      process.env["ADMIN_TOKEN"] = orig;
    }
  });

  it("returns 503 when ADMIN_TOKEN is under 16 chars at request time (P0-1 regression pin)", async () => {
    const orig = process.env["ADMIN_TOKEN"];
    process.env["ADMIN_TOKEN"] = "short";
    try {
      const res = await get(app, "/admin?token=short");
      expect(res.status).toBe(503);
    } finally {
      process.env["ADMIN_TOKEN"] = orig;
    }
  });
});

describe("Admin Panel — Salon list", () => {
  let db: Database.Database;
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    db = initDb(":memory:");
    app = makeApp(db);
  });

  it("shows empty state when no salons", async () => {
    const res = await get(app, `/admin?token=${ADMIN_TOKEN}`);
    const text = await res.text();
    expect(text).toContain("No hay salones");
  });

  it("shows salon in list after creation", async () => {
    // POST new salon
    const formData = new URLSearchParams({
      name: "Salón Test",
      phone: "525512345678",
    });
    const req = new Request(
      `http://localhost/admin/salones?token=${ADMIN_TOKEN}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "http://localhost",
          Host: "localhost",
        },
        body: formData.toString(),
      },
    );
    const createRes = await app.fetch(req);
    expect(createRes.status).toBe(200);

    const listRes = await get(app, `/admin?token=${ADMIN_TOKEN}`);
    const text = await listRes.text();
    expect(text).toContain("Salón Test");
  });
});

describe("Admin Panel — Create salon", () => {
  let db: Database.Database;
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    db = initDb(":memory:");
    app = makeApp(db);
  });

  it("GET /admin/salones/new returns form", async () => {
    const res = await get(app, `/admin/salones/new?token=${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Nuevo salón");
    expect(text).toContain("svc_name[]");
  });

  it("POST /admin/salones creates salon in DB", async () => {
    const formData = new URLSearchParams({
      name: "Salón Rosita",
      phone: "525512345678",
      "svc_name[]": "Corte",
      "svc_dur[]": "30",
      "svc_price[]": "150",
    });
    const req = new Request(
      `http://localhost/admin/salones?token=${ADMIN_TOKEN}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "http://localhost",
          Host: "localhost",
        },
        body: formData.toString(),
      },
    );
    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("creado exitosamente");
    expect(text).toContain("Salón Rosita");

    const salons = getAllSalons(db);
    expect(salons).toHaveLength(1);
    expect(salons[0]!.name).toBe("Salón Rosita");
    expect(salons[0]!.phone).toBe("525512345678");
  });

  it("POST /admin/salones creates services", async () => {
    const formData = new URLSearchParams();
    formData.append("name", "Salón Pro");
    formData.append("phone", "525599887766");
    formData.append("svc_name[]", "Corte");
    formData.append("svc_dur[]", "30");
    formData.append("svc_price[]", "200");
    formData.append("svc_name[]", "Tinte");
    formData.append("svc_dur[]", "90");
    formData.append("svc_price[]", "500");
    formData.append("svc_name[]", ""); // empty — should be skipped

    const req = new Request(
      `http://localhost/admin/salones?token=${ADMIN_TOKEN}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "http://localhost",
          Host: "localhost",
        },
        body: formData.toString(),
      },
    );
    await app.fetch(req);

    const salons = getAllSalons(db);
    const services = getServices(db, salons[0]!.id);
    expect(services).toHaveLength(2);
    expect(services.map((s) => s.name)).toContain("Corte");
    expect(services.map((s) => s.name)).toContain("Tinte");
  });

  it("returns 400 when name or phone missing", async () => {
    const req = new Request(
      `http://localhost/admin/salones?token=${ADMIN_TOKEN}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "http://localhost",
          Host: "localhost",
        },
        body: "name=&phone=",
      },
    );
    const res = await app.fetch(req);
    expect(res.status).toBe(400);
  });
});

describe("Admin Panel — Salon detail / edit", () => {
  let db: Database.Database;
  let app: ReturnType<typeof makeApp>;
  let salonId: string;

  beforeEach(async () => {
    db = initDb(":memory:");
    app = makeApp(db);
    // Create a salon via DB directly
    const { createSalon } = await import("../db/models.js");
    const salon = createSalon(db, {
      name: "Salón Edit",
      phone: "525511223344",
    });
    salonId = salon.id;
  });

  it("GET /admin/salones/:id returns 200", async () => {
    const res = await get(
      app,
      `/admin/salones/${salonId}?token=${ADMIN_TOKEN}`,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Salón Edit");
  });

  it("returns 404 for unknown salon", async () => {
    const res = await get(
      app,
      `/admin/salones/nonexistent?token=${ADMIN_TOKEN}`,
    );
    expect(res.status).toBe(404);
  });

  it("POST edit updates name", async () => {
    const req = new Request(
      `http://localhost/admin/salones/${salonId}/edit?token=${ADMIN_TOKEN}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "http://localhost",
          Host: "localhost",
        },
        body: "name=Salón+Actualizado&phone=525511223344",
      },
    );
    const res = await app.fetch(req);
    expect(res.status).toBe(302); // redirect

    const updated = getSalonById(db, salonId);
    expect(updated?.name).toBe("Salón Actualizado");
  });
});

describe("Admin Panel — Toggle active", () => {
  let db: Database.Database;
  let app: ReturnType<typeof makeApp>;
  let salonId: string;

  beforeEach(async () => {
    db = initDb(":memory:");
    app = makeApp(db);
    const { createSalon } = await import("../db/models.js");
    const salon = createSalon(db, {
      name: "Salón Toggle",
      phone: "525500001111",
    });
    salonId = salon.id;
  });

  it("toggle deactivates active salon", async () => {
    const before = getSalonById(db, salonId);
    expect(before?.active).toBe(1);

    const req = new Request(
      `http://localhost/admin/salones/${salonId}/toggle?token=${ADMIN_TOKEN}`,
      {
        method: "POST",
        headers: { Origin: "http://localhost", Host: "localhost" },
      },
    );
    const res = await app.fetch(req);
    expect(res.status).toBe(302);

    const after = getSalonById(db, salonId);
    expect(after?.active).toBe(0);
  });

  it("toggle reactivates inactive salon", async () => {
    // First deactivate
    db.prepare("UPDATE salons SET active = 0 WHERE id = ?").run(salonId);

    const req = new Request(
      `http://localhost/admin/salones/${salonId}/toggle?token=${ADMIN_TOKEN}`,
      {
        method: "POST",
        headers: { Origin: "http://localhost", Host: "localhost" },
      },
    );
    await app.fetch(req);

    const after = getSalonById(db, salonId);
    expect(after?.active).toBe(1);
  });
});

describe("Admin Panel — owner_phone (dueña's personal WA)", () => {
  let db: Database.Database;
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    db = initDb(":memory:");
    app = makeApp(db);
  });

  it("create form includes the owner_phone input", async () => {
    const res = await get(app, `/admin/salones/new?token=${ADMIN_TOKEN}`);
    const text = await res.text();
    expect(text).toContain('name="owner_phone"');
    expect(text).toContain("WhatsApp personal de la dueña");
  });

  it("POST create persists owner_phone when provided", async () => {
    const formData = new URLSearchParams({
      name: "Salón Owner",
      phone: "525500000001",
      owner_phone: "525511112222",
    });
    const req = new Request(
      `http://localhost/admin/salones?token=${ADMIN_TOKEN}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "http://localhost",
          Host: "localhost",
        },
        body: formData.toString(),
      },
    );
    const res = await app.fetch(req);
    expect(res.status).toBe(200);

    const salons = getAllSalons(db);
    expect(salons[0]!.owner_phone).toBe("525511112222");
  });

  it("POST create accepts empty owner_phone as null", async () => {
    const formData = new URLSearchParams({
      name: "Salón NoOwner",
      phone: "525500000002",
      owner_phone: "",
    });
    const req = new Request(
      `http://localhost/admin/salones?token=${ADMIN_TOKEN}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "http://localhost",
          Host: "localhost",
        },
        body: formData.toString(),
      },
    );
    const res = await app.fetch(req);
    expect(res.status).toBe(200);

    const salons = getAllSalons(db);
    expect(salons[0]!.owner_phone).toBeNull();
  });

  it("POST create rejects owner_phone with invalid format", async () => {
    const formData = new URLSearchParams({
      name: "Salón Bad",
      phone: "525500000003",
      owner_phone: "not-a-number",
    });
    const req = new Request(
      `http://localhost/admin/salones?token=${ADMIN_TOKEN}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "http://localhost",
          Host: "localhost",
        },
        body: formData.toString(),
      },
    );
    const res = await app.fetch(req);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("WhatsApp de la dueña inválido");
  });

  it("POST create rejects owner_phone equal to salon phone", async () => {
    const formData = new URLSearchParams({
      name: "Salón Same",
      phone: "525500000004",
      owner_phone: "525500000004",
    });
    const req = new Request(
      `http://localhost/admin/salones?token=${ADMIN_TOKEN}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "http://localhost",
          Host: "localhost",
        },
        body: formData.toString(),
      },
    );
    const res = await app.fetch(req);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("debe ser DIFERENTE");
  });

  it("POST edit sets owner_phone from null to a value", async () => {
    const { createSalon } = await import("../db/models.js");
    const salon = createSalon(db, { name: "Salón Set", phone: "525500000010" });
    expect(salon.owner_phone).toBeNull();

    const req = new Request(
      `http://localhost/admin/salones/${salon.id}/edit?token=${ADMIN_TOKEN}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "http://localhost",
          Host: "localhost",
        },
        body: "name=Salón+Set&phone=525500000010&owner_phone=525511113333",
      },
    );
    const res = await app.fetch(req);
    expect(res.status).toBe(302);

    const updated = getSalonById(db, salon.id);
    expect(updated?.owner_phone).toBe("525511113333");
  });

  it("POST edit CLEARS owner_phone when field is present but empty", async () => {
    const { createSalon } = await import("../db/models.js");
    const salon = createSalon(db, {
      name: "Salón Clear",
      phone: "525500000011",
      owner_phone: "525511114444",
    });
    expect(salon.owner_phone).toBe("525511114444");

    const req = new Request(
      `http://localhost/admin/salones/${salon.id}/edit?token=${ADMIN_TOKEN}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "http://localhost",
          Host: "localhost",
        },
        body: "name=Salón+Clear&phone=525500000011&owner_phone=",
      },
    );
    const res = await app.fetch(req);
    expect(res.status).toBe(302);

    const updated = getSalonById(db, salon.id);
    expect(updated?.owner_phone).toBeNull();
  });

  it("POST edit LEAVES owner_phone untouched when field is missing", async () => {
    const { createSalon } = await import("../db/models.js");
    const salon = createSalon(db, {
      name: "Salón Keep",
      phone: "525500000012",
      owner_phone: "525511115555",
    });

    const req = new Request(
      `http://localhost/admin/salones/${salon.id}/edit?token=${ADMIN_TOKEN}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "http://localhost",
          Host: "localhost",
        },
        // owner_phone deliberately omitted
        body: "name=Salón+Keep+Renamed&phone=525500000012",
      },
    );
    const res = await app.fetch(req);
    expect(res.status).toBe(302);

    const updated = getSalonById(db, salon.id);
    expect(updated?.name).toBe("Salón Keep Renamed");
    expect(updated?.owner_phone).toBe("525511115555");
  });

  it("POST edit rejects owner_phone equal to salon phone", async () => {
    const { createSalon } = await import("../db/models.js");
    const salon = createSalon(db, {
      name: "Salón Same",
      phone: "525500000013",
    });

    const req = new Request(
      `http://localhost/admin/salones/${salon.id}/edit?token=${ADMIN_TOKEN}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "http://localhost",
          Host: "localhost",
        },
        body: "name=Salón+Same&phone=525500000013&owner_phone=525500000013",
      },
    );
    const res = await app.fetch(req);
    expect(res.status).toBe(400);
  });

  // C1 audit-fold regression pin: the previous code used `pattern="\\d{10,15}"`
  // inside a JS template literal which renders as `pattern="d{10,15}"` —
  // browsers then refused any well-formed digit string. Tests bypass the
  // browser so the bug was silent. Pin the literal `[0-9]{10,15}` form here.
  it("edit form renders the phone pattern attribute correctly (no \\d escape bug)", async () => {
    const { createSalon } = await import("../db/models.js");
    const salon = createSalon(db, {
      name: "Salón Pattern",
      phone: "525500000020",
    });
    const res = await get(
      app,
      `/admin/salones/${salon.id}?token=${ADMIN_TOKEN}`,
    );
    const text = await res.text();
    // pattern must be a literal digit class, not the string "d{10,15}".
    expect(text).toContain('pattern="[0-9]{10,15}"');
    expect(text).not.toContain('pattern="d{10,15}"');
  });

  it("edit form pre-fills the existing owner_phone", async () => {
    const { createSalon } = await import("../db/models.js");
    const salon = createSalon(db, {
      name: "Salón Pre",
      phone: "525500000014",
      owner_phone: "525511116666",
    });

    const res = await get(
      app,
      `/admin/salones/${salon.id}?token=${ADMIN_TOKEN}`,
    );
    const text = await res.text();
    expect(text).toContain('value="525511116666"');
  });
});

describe("Admin Panel — Service management", () => {
  let db: Database.Database;
  let app: ReturnType<typeof makeApp>;
  let salonId: string;

  beforeEach(async () => {
    db = initDb(":memory:");
    app = makeApp(db);
    const { createSalon } = await import("../db/models.js");
    const salon = createSalon(db, { name: "Salón Svc", phone: "525522334455" });
    salonId = salon.id;
  });

  it("POST /services adds a service", async () => {
    const req = new Request(
      `http://localhost/admin/salones/${salonId}/services?token=${ADMIN_TOKEN}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "http://localhost",
          Host: "localhost",
        },
        body: "name=Manicure&duration_min=45&price=120",
      },
    );
    const res = await app.fetch(req);
    expect(res.status).toBe(302);

    const services = getServices(db, salonId);
    expect(services).toHaveLength(1);
    expect(services[0]!.name).toBe("Manicure");
    expect(services[0]!.duration_min).toBe(45);
    expect(services[0]!.price).toBe(120);
  });

  it("POST /services/:id/delete removes service", async () => {
    const { createService } = await import("../db/models.js");
    const svc = createService(db, {
      salon_id: salonId,
      name: "Depilación",
      duration_min: 30,
    });

    const req = new Request(
      `http://localhost/admin/salones/${salonId}/services/${svc.id}/delete?token=${ADMIN_TOKEN}`,
      {
        method: "POST",
        headers: { Origin: "http://localhost", Host: "localhost" },
      },
    );
    const res = await app.fetch(req);
    expect(res.status).toBe(302);

    const services = getServices(db, salonId);
    expect(services).toHaveLength(0);
  });
});

describe("Working hours — model (getSlots/setSlots/isValid)", () => {
  let db: Database.Database;
  let salonId: string;

  beforeEach(async () => {
    db = initDb(":memory:");
    const { createSalon } = await import("../db/models.js");
    salonId = createSalon(db, {
      name: "Salón Horas",
      phone: "525500000100",
    }).id;
  });

  it("isValidWorkingHour accepts a well-formed window", () => {
    expect(
      isValidWorkingHour({
        day_of_week: 2,
        start_time: "09:00",
        end_time: "19:00",
      }),
    ).toBe(true);
  });

  it("isValidWorkingHour rejects bad weekday, bad HH:MM, and start>=end", () => {
    expect(
      isValidWorkingHour({
        day_of_week: 7,
        start_time: "09:00",
        end_time: "10:00",
      }),
    ).toBe(false); // weekday out of range
    expect(
      isValidWorkingHour({
        day_of_week: 1,
        start_time: "9:00",
        end_time: "10:00",
      }),
    ).toBe(false); // not zero-padded
    expect(
      isValidWorkingHour({
        day_of_week: 1,
        start_time: "25:00",
        end_time: "26:00",
      }),
    ).toBe(false); // hour > 23
    expect(
      isValidWorkingHour({
        day_of_week: 1,
        start_time: "10:00",
        end_time: "10:00",
      }),
    ).toBe(false); // zero-length
    expect(
      isValidWorkingHour({
        day_of_week: 1,
        start_time: "19:00",
        end_time: "09:00",
      }),
    ).toBe(false); // inverted
  });

  it("setSlotsForSalon + getSlotsForSalon round-trip, ordered Mon→Sun", () => {
    setSlotsForSalon(db, salonId, [
      { day_of_week: 0, start_time: "10:00", end_time: "14:00" }, // Sunday
      { day_of_week: 1, start_time: "09:00", end_time: "19:00" }, // Monday
      { day_of_week: 6, start_time: "08:00", end_time: "13:00" }, // Saturday
    ]);
    const rows = getSlotsForSalon(db, salonId);
    expect(rows.map((r) => r.day_of_week)).toEqual([1, 6, 0]); // Mon, Sat, Sun
    expect(rows.every((r) => r.active === 1)).toBe(true);
  });

  it("setSlotsForSalon is replace-all (re-saving wipes the previous set)", () => {
    setSlotsForSalon(db, salonId, [
      { day_of_week: 1, start_time: "09:00", end_time: "19:00" },
      { day_of_week: 2, start_time: "09:00", end_time: "19:00" },
    ]);
    expect(getSlotsForSalon(db, salonId)).toHaveLength(2);
    setSlotsForSalon(db, salonId, [
      { day_of_week: 3, start_time: "11:00", end_time: "15:00" },
    ]);
    const rows = getSlotsForSalon(db, salonId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.day_of_week).toBe(3);
  });

  it("setSlotsForSalon([]) clears all windows", () => {
    setSlotsForSalon(db, salonId, [
      { day_of_week: 1, start_time: "09:00", end_time: "19:00" },
    ]);
    setSlotsForSalon(db, salonId, []);
    expect(getSlotsForSalon(db, salonId)).toHaveLength(0);
  });

  it("setSlotsForSalon throws on invalid window and does NOT delete existing rows", () => {
    setSlotsForSalon(db, salonId, [
      { day_of_week: 1, start_time: "09:00", end_time: "19:00" },
    ]);
    expect(() =>
      setSlotsForSalon(db, salonId, [
        { day_of_week: 2, start_time: "bad", end_time: "19:00" },
      ]),
    ).toThrow(/invalid working hour/);
    // Validation runs BEFORE the delete → the prior schedule survives.
    expect(getSlotsForSalon(db, salonId)).toHaveLength(1);
  });

  it("slot-finder honors operator-set hours end-to-end (only the open weekday is offered)", () => {
    // Only Wednesday (day_of_week 3), 10:00–14:00.
    setSlotsForSalon(db, salonId, [
      { day_of_week: 3, start_time: "10:00", end_time: "14:00" },
    ]);
    const nowMs = new Date("2026-01-05T12:00:00Z").getTime(); // a Monday
    const offered = findAvailableSlots(db, salonId, 60, {
      count: 5,
      daysToScan: 14,
      minHoursAhead: 1,
      nowMs,
    });
    expect(offered.length).toBeGreaterThan(0);
    // Same process TZ for finder + assertion → consistent local weekday/hour.
    for (const s of offered) {
      const d = new Date(s.starts_at * 1000);
      expect(d.getDay()).toBe(3); // Wednesday only
      expect(d.getHours()).toBeGreaterThanOrEqual(10);
      expect(d.getHours()).toBeLessThan(14);
    }
  });
});

describe("Admin Panel — Working hours UI", () => {
  let db: Database.Database;
  let app: ReturnType<typeof makeApp>;
  let salonId: string;

  beforeEach(async () => {
    db = initDb(":memory:");
    app = makeApp(db);
    const { createSalon } = await import("../db/models.js");
    salonId = createSalon(db, { name: "Salón UI", phone: "525500000200" }).id;
  });

  it("detail page shows the hours card + default-hours notice when none configured", async () => {
    const res = await get(
      app,
      `/admin/salones/${salonId}?token=${ADMIN_TOKEN}`,
    );
    const text = await res.text();
    expect(text).toContain("Horario de atención");
    expect(text).toContain("horario por defecto");
    expect(text).toContain('name="open_1"'); // Monday checkbox present
  });

  it("detail page pre-checks configured days and hides the default notice", async () => {
    setSlotsForSalon(db, salonId, [
      { day_of_week: 1, start_time: "08:30", end_time: "17:30" },
    ]);
    const res = await get(
      app,
      `/admin/salones/${salonId}?token=${ADMIN_TOKEN}`,
    );
    const text = await res.text();
    expect(text).not.toContain("horario por defecto");
    expect(text).toContain('name="open_1" value="1" checked');
    expect(text).toContain('value="08:30"');
  });

  it("POST hours persists the marked days and redirects", async () => {
    const res = await post(
      app,
      `/admin/salones/${salonId}/hours?token=${ADMIN_TOKEN}`,
      {
        open_1: "1",
        start_1: "09:00",
        end_1: "18:00",
        open_3: "1",
        start_3: "10:00",
        end_3: "14:00",
        // Tuesday left unmarked → closed
        start_2: "09:00",
        end_2: "19:00",
      },
    );
    expect(res.status).toBe(302);
    const rows = getSlotsForSalon(db, salonId);
    expect(rows.map((r) => r.day_of_week)).toEqual([1, 3]);
    expect(rows.find((r) => r.day_of_week === 3)!.end_time).toBe("14:00");
  });

  it("POST hours with nothing marked clears the schedule (reverts to default)", async () => {
    setSlotsForSalon(db, salonId, [
      { day_of_week: 1, start_time: "09:00", end_time: "19:00" },
    ]);
    const res = await post(
      app,
      `/admin/salones/${salonId}/hours?token=${ADMIN_TOKEN}`,
      {},
    );
    expect(res.status).toBe(302);
    expect(getSlotsForSalon(db, salonId)).toHaveLength(0);
  });

  it("POST hours rejects an invalid time with 400 and leaves the schedule untouched", async () => {
    setSlotsForSalon(db, salonId, [
      { day_of_week: 1, start_time: "09:00", end_time: "19:00" },
    ]);
    const res = await post(
      app,
      `/admin/salones/${salonId}/hours?token=${ADMIN_TOKEN}`,
      {
        open_2: "1",
        start_2: "19:00",
        end_2: "09:00", // inverted
      },
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Martes");
    expect(getSlotsForSalon(db, salonId)).toHaveLength(1); // prior survives
  });

  it("POST hours returns 404 for an unknown salon", async () => {
    const res = await post(
      app,
      `/admin/salones/nope/hours?token=${ADMIN_TOKEN}`,
      {
        open_1: "1",
        start_1: "09:00",
        end_1: "18:00",
      },
    );
    expect(res.status).toBe(404);
  });

  it("POST hours without a matching Origin is rejected by CSRF (403)", async () => {
    const req = new Request(
      `http://localhost/admin/salones/${salonId}/hours?token=${ADMIN_TOKEN}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Host: "localhost",
          // No Origin / Referer → CSRF check fails.
        },
        body: "open_1=1&start_1=09:00&end_1=18:00",
      },
    );
    const res = await app.fetch(req);
    expect(res.status).toBe(403);
  });
});

describe("Admin Panel — WhatsApp linking advisory (#5)", () => {
  let db: Database.Database;
  let app: ReturnType<typeof makeApp>;
  let salonId: string;
  let salonPhone: string;

  beforeEach(async () => {
    db = initDb(":memory:");
    app = makeApp(db);
    const { createSalon } = await import("../db/models.js");
    salonPhone = "525500000300";
    salonId = createSalon(db, { name: "Salón Link", phone: salonPhone }).id;
  });

  it("detail page shows the linking instructions + 24h cool-down advisory", async () => {
    const res = await get(
      app,
      `/admin/salones/${salonId}?token=${ADMIN_TOKEN}`,
    );
    const text = await res.text();
    expect(text).toContain("Vincular WhatsApp");
    expect(text).toContain("Dispositivos vinculados");
    expect(text).toContain("24 h"); // cool-down advisory
    expect(text).toContain(salonPhone); // names the salon's own line
  });
});

describe("Admin Panel — Delete salon", () => {
  let db: Database.Database;
  let onSalonDeleted: ReturnType<typeof vi.fn>;
  let app: ReturnType<typeof createAdminPanel>;

  beforeEach(() => {
    db = initDb(":memory:");
    process.env["ADMIN_TOKEN"] = ADMIN_TOKEN;
    onSalonDeleted = vi.fn(async (_id: string) => {});
    app = createAdminPanel(db, { onSalonDeleted });
  });

  function makeSalon() {
    return createSalon(db, { name: "Salón Borrar", phone: "5255000001" });
  }

  it("GET confirm page shows the warning, the name and a typed-name field", async () => {
    const salon = makeSalon();
    const res = await get(
      app,
      `/admin/salones/${salon.id}/delete?token=${ADMIN_TOKEN}`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Eliminar");
    expect(html).toContain("Salón Borrar");
    expect(html).toContain('name="confirm_name"');
  });

  it("GET confirm page returns 404 for an unknown salon", async () => {
    const res = await get(
      app,
      `/admin/salones/nope/delete?token=${ADMIN_TOKEN}`,
    );
    expect(res.status).toBe(404);
  });

  it("POST with a non-matching name does NOT delete and does NOT tear down", async () => {
    const salon = makeSalon();
    const res = await post(
      app,
      `/admin/salones/${salon.id}/delete?token=${ADMIN_TOKEN}`,
      { confirm_name: "Nombre Equivocado" },
    );
    expect(res.status).toBe(400);
    expect(getSalonById(db, salon.id)).not.toBeNull(); // still present
    expect(onSalonDeleted).not.toHaveBeenCalled();
  });

  it("POST with the exact name deletes the salon and tears down Baileys", async () => {
    const salon = makeSalon();
    const res = await post(
      app,
      `/admin/salones/${salon.id}/delete?token=${ADMIN_TOKEN}`,
      { confirm_name: "Salón Borrar" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("deleted=1");
    expect(getSalonById(db, salon.id)).toBeNull();
    expect(onSalonDeleted).toHaveBeenCalledWith(salon.id);
  });

  it("still deletes the row even if teardown rejects (best-effort)", async () => {
    const salon = makeSalon();
    onSalonDeleted.mockRejectedValueOnce(new Error("logout hung"));
    const res = await post(
      app,
      `/admin/salones/${salon.id}/delete?token=${ADMIN_TOKEN}`,
      { confirm_name: "Salón Borrar" },
    );
    expect(res.status).toBe(302);
    expect(getSalonById(db, salon.id)).toBeNull();
  });

  it("escapes a malicious salon name in the page title (no XSS break-out)", async () => {
    const salon = createSalon(db, {
      name: "</title><script>alert(1)</script>",
      phone: "5255000002",
    });
    const res = await get(
      app,
      `/admin/salones/${salon.id}/delete?token=${ADMIN_TOKEN}`,
    );
    const html = await res.text();
    // The raw break-out sequence must NOT appear; it must be entity-encoded.
    expect(html).not.toContain("</title><script>");
    expect(html).toContain("&lt;/title&gt;");
  });

  it("rejects a cross-site POST (no Origin/Referer) with 403 and keeps the salon", async () => {
    const salon = makeSalon();
    const req = new Request(
      `http://localhost/admin/salones/${salon.id}/delete?token=${ADMIN_TOKEN}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Host: "localhost", // no Origin/Referer → CSRF guard must reject
        },
        body: new URLSearchParams({ confirm_name: "Salón Borrar" }).toString(),
      },
    );
    const res = await app.fetch(req);
    expect(res.status).toBe(403);
    expect(getSalonById(db, salon.id)).not.toBeNull();
    expect(onSalonDeleted).not.toHaveBeenCalled();
  });
});

describe("Admin Panel — PUBLIC_APP_URL in owner-panel links", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createAdminPanel>;
  const prev = process.env["PUBLIC_APP_URL"];

  beforeEach(() => {
    db = initDb(":memory:");
    process.env["ADMIN_TOKEN"] = ADMIN_TOKEN;
    app = createAdminPanel(db);
  });

  afterEach(() => {
    if (prev === undefined) delete process.env["PUBLIC_APP_URL"];
    else process.env["PUBLIC_APP_URL"] = prev;
  });

  it("uses PUBLIC_APP_URL for the panel link and drops the localhost hint", async () => {
    process.env["PUBLIC_APP_URL"] = "https://app.gilda.mx";
    const salon = createSalon(db, { name: "Salón URL", phone: "5255000010" });
    const res = await get(
      app,
      `/admin/salones/${salon.id}?token=${ADMIN_TOKEN}`,
    );
    const html = await res.text();
    expect(html).toContain(
      `https://app.gilda.mx/panel/dashboard?token=${salon.token}`,
    );
    expect(html).not.toContain("localhost:8085");
    expect(html).not.toContain("Reemplaza");
  });

  it("falls back to localhost + shows the hint when PUBLIC_APP_URL is unset", async () => {
    delete process.env["PUBLIC_APP_URL"];
    const salon = createSalon(db, { name: "Salón Local", phone: "5255000011" });
    const res = await get(
      app,
      `/admin/salones/${salon.id}?token=${ADMIN_TOKEN}`,
    );
    const html = await res.text();
    expect(html).toContain("http://localhost:8085/panel/dashboard");
    expect(html).toContain("Reemplaza");
  });

  it("strips a trailing slash on PUBLIC_APP_URL so the join doesn't double up", async () => {
    process.env["PUBLIC_APP_URL"] = "https://app.gilda.mx/";
    const salon = createSalon(db, { name: "Salón Slash", phone: "5255000012" });
    const res = await get(
      app,
      `/admin/salones/${salon.id}?token=${ADMIN_TOKEN}`,
    );
    const html = await res.text();
    expect(html).toContain("https://app.gilda.mx/panel/dashboard");
    expect(html).not.toContain("app.gilda.mx//panel");
  });
});
