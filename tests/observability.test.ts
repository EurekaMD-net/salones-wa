/**
 * Observability surface: /health/salons + /metrics.
 * Covers the ADMIN_TOKEN gate, JSON shape, Prometheus exposition + escaping.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { initDb } from "../src/db/database.js";
import { createSalon } from "../src/db/models.js";
import {
  createObservabilityRoutes,
  renderMetrics,
  renderOutboundDropMetrics,
} from "../src/web/observability.js";
import {
  recordDrop,
  snapshotDrops,
  resetDrops,
} from "../src/bot/rate-limiter.js";
import {
  recordSalonState,
  resetSalonConnStates,
  type SalonHealth,
} from "../src/bot/baileys-state.js";
import type Database from "better-sqlite3";

const ADMIN_TOKEN = "test-admin-token-1234";

function makeApp(db: Database.Database) {
  process.env["ADMIN_TOKEN"] = ADMIN_TOKEN;
  return createObservabilityRoutes(db);
}

function get(app: ReturnType<typeof makeApp>, path: string) {
  return app.fetch(new Request(`http://localhost${path}`));
}

describe("Observability — auth gate", () => {
  let db: Database.Database;
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    resetSalonConnStates();
    db = initDb(":memory:");
    app = makeApp(db);
  });

  it("/health/salons → 401 without token", async () => {
    expect((await get(app, "/health/salons")).status).toBe(401);
  });

  it("/health/salons → 401 with wrong token", async () => {
    expect((await get(app, "/health/salons?token=nope")).status).toBe(401);
  });

  it("/metrics → 401 without token", async () => {
    expect((await get(app, "/metrics")).status).toBe(401);
  });

  it("/metrics → 401 with wrong token", async () => {
    expect((await get(app, "/metrics?token=nope")).status).toBe(401);
  });

  it("treats an empty ?token= as unauthorized (not a match)", async () => {
    expect((await get(app, "/health/salons?token=")).status).toBe(401);
    expect((await get(app, "/metrics?token=")).status).toBe(401);
  });

  it("rate-limits repeated wrong-token attempts to 429", async () => {
    // 5 failures are allowed (each 401); the 6th trips the per-IP limiter.
    for (let i = 0; i < 5; i++) {
      expect((await get(app, "/metrics?token=wrong")).status).toBe(401);
    }
    expect((await get(app, "/metrics?token=wrong")).status).toBe(429);
  });
});

describe("Observability — /health/salons", () => {
  let db: Database.Database;
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    resetSalonConnStates();
    db = initDb(":memory:");
    app = makeApp(db);
  });

  it("returns the health envelope for active salons", async () => {
    const s = createSalon(db, { name: "Salón Demo", phone: "525640501088" });
    recordSalonState(s.id, s.phone, "connected");

    const res = await get(app, `/health/salons?token=${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      thresholdHours: number;
      salons: Array<Record<string, unknown>>;
    };
    expect(body.ok).toBe(true);
    expect(body.thresholdHours).toBe(24);
    expect(body.salons).toHaveLength(1);
    const row = body.salons[0]!;
    expect(row).toMatchObject({
      salonId: s.id,
      name: "Salón Demo",
      phone: "••••1088", // masked to last 4 (PII reduction)
      active: true,
      state: "connected",
      stale: false,
    });
    expect(row["lastConnectedAt"]).not.toBeNull();
    expect(row["downForSeconds"]).toBeNull(); // connected
  });

  it("shows state 'unknown' for an active salon with no registry record", async () => {
    createSalon(db, { name: "Sin Sesión", phone: "525500000000" });
    const res = await get(app, `/health/salons?token=${ADMIN_TOKEN}`);
    const body = (await res.json()) as {
      salons: Array<Record<string, unknown>>;
    };
    expect(body.salons[0]!["state"]).toBe("unknown");
    expect(body.salons[0]!["lastConnectedAt"]).toBeNull();
  });

  it("reflects a logged_out salon", async () => {
    const s = createSalon(db, { name: "Caído", phone: "525511111111" });
    recordSalonState(s.id, s.phone, "logged_out");
    const res = await get(app, `/health/salons?token=${ADMIN_TOKEN}`);
    const body = (await res.json()) as {
      salons: Array<Record<string, unknown>>;
    };
    expect(body.salons[0]!["state"]).toBe("logged_out");
  });
});

describe("Observability — /metrics", () => {
  let db: Database.Database;
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    resetSalonConnStates();
    db = initDb(":memory:");
    app = makeApp(db);
  });

  it("serves Prometheus text with the enum gauge", async () => {
    const s = createSalon(db, { name: "Salón Demo", phone: "525640501088" });
    recordSalonState(s.id, s.phone, "connected");

    const res = await get(app, `/metrics?token=${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("content-type")).toContain("version=0.0.4");
    const text = await res.text();
    expect(text).toContain("# TYPE salones_wa_baileys_state gauge");
    expect(text).toContain(
      `salones_wa_baileys_state{salon_id="${s.id}",state="connected"} 1`,
    );
    expect(text).toContain(
      `salones_wa_baileys_state{salon_id="${s.id}",state="logged_out"} 0`,
    );
    expect(text).toContain(
      `salones_wa_baileys_connected{salon_id="${s.id}"} 1`,
    );
    expect(text).toContain("salones_wa_salons_active 1");
    expect(text).toContain("salones_wa_salons_stale 0");
  });
});

describe("renderMetrics (pure)", () => {
  function health(overrides: Partial<SalonHealth>): SalonHealth {
    return {
      salonId: "id1",
      name: "N",
      phone: "1",
      active: true,
      state: "connected",
      since: null,
      lastConnectedAt: 1_700_000_000_000,
      downForSeconds: null,
      stale: false,
      ...overrides,
    };
  }

  it("emits one series per state, 1 for current and 0 for the rest", () => {
    const out = renderMetrics([health({ state: "reconnecting" })]);
    expect(out).toContain(
      `salones_wa_baileys_state{salon_id="id1",state="reconnecting"} 1`,
    );
    expect(out).toContain(
      `salones_wa_baileys_state{salon_id="id1",state="connected"} 0`,
    );
    expect(out).toContain(
      `salones_wa_baileys_state{salon_id="id1",state="logged_out"} 0`,
    );
  });

  it("emits last_connected_timestamp in SECONDS when known, omits when null", () => {
    const withTs = renderMetrics([
      health({ lastConnectedAt: 1_700_000_000_000 }),
    ]);
    expect(withTs).toContain(
      `salones_wa_baileys_last_connected_timestamp_seconds{salon_id="id1"} 1700000000`,
    );
    const noTs = renderMetrics([health({ lastConnectedAt: null })]);
    expect(noTs).not.toContain(
      'last_connected_timestamp_seconds{salon_id="id1"}',
    );
  });

  it("reports down_seconds (0 while connected)", () => {
    expect(
      renderMetrics([health({ state: "connected", downForSeconds: null })]),
    ).toContain(`salones_wa_baileys_down_seconds{salon_id="id1"} 0`);
    expect(
      renderMetrics([health({ state: "logged_out", downForSeconds: 90000 })]),
    ).toContain(`salones_wa_baileys_down_seconds{salon_id="id1"} 90000`);
  });

  it("escapes special characters in label values (backslash, quote, CR, LF)", () => {
    const out = renderMetrics([health({ salonId: 'a"b\\c\r\nd' })]);
    expect(out).toContain(`salon_id="a\\"b\\\\c\\r\\nd"`);
  });

  it("counts active and stale salons", () => {
    const out = renderMetrics([
      health({ salonId: "a", active: true, stale: true, state: "logged_out" }),
      health({ salonId: "b", active: true, stale: false, state: "connected" }),
    ]);
    expect(out).toContain("salones_wa_salons_active 2");
    expect(out).toContain("salones_wa_salons_stale 1");
  });
});

describe("renderOutboundDropMetrics (§1.2)", () => {
  beforeEach(() => resetDrops());

  it("renders HELP/TYPE header with zero series when no drops", () => {
    const out = renderOutboundDropMetrics(snapshotDrops());
    expect(out).toContain("# TYPE salones_wa_outbound_dropped_total counter");
    expect(out).not.toContain("salones_wa_outbound_dropped_total{");
  });

  it("renders a labeled counter line per salon/kind/reason", () => {
    recordDrop("s1", "reminder", "pair_cap");
    recordDrop("s1", "reminder", "pair_cap");
    recordDrop("s2", "reactivation", "salon_cap");
    const out = renderOutboundDropMetrics(snapshotDrops());
    expect(out).toContain(
      'salones_wa_outbound_dropped_total{salon_id="s1",kind="reminder",reason="pair_cap"} 2',
    );
    expect(out).toContain(
      'salones_wa_outbound_dropped_total{salon_id="s2",kind="reactivation",reason="salon_cap"} 1',
    );
  });
});
