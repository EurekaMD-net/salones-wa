/**
 * Admin UI tests
 * Covers: auth guard, salon CRUD, service management, toggle
 */

import { describe, it, expect, beforeEach } from "vitest";
import { initDb } from "../db/database.js";
import { createAdminPanel } from "./admin.js";
import { getSalonById, getAllSalons, getServices } from "../db/models.js";
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
