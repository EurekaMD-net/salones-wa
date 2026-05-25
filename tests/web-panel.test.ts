import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDb, resetDbSingleton } from "../src/db/database.js";
import { createSalon } from "../src/db/models.js";
import { createWebPanel } from "../src/web/panel.js";
import type Database from "better-sqlite3";

let db: Database.Database;

beforeEach(() => {
  db = initDb(":memory:");
});

afterEach(() => {
  resetDbSingleton();
});

describe("Web Panel", () => {
  describe("GET /health", () => {
    it("returns 200 with ok:true", async () => {
      const app = createWebPanel(db);
      const req = new Request("http://localhost/health");
      const res = await app.fetch(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.service).toBe("salones-wa");
    });
  });

  describe("GET /panel/dashboard", () => {
    it("returns 401 without token", async () => {
      const app = createWebPanel(db);
      const req = new Request("http://localhost/panel/dashboard");
      const res = await app.fetch(req);
      expect(res.status).toBe(401);
    });

    it("returns 401 with invalid token", async () => {
      const app = createWebPanel(db);
      const req = new Request(
        "http://localhost/panel/dashboard?token=bad-token",
      );
      const res = await app.fetch(req);
      expect(res.status).toBe(401);
    });

    it("returns 200 with valid token", async () => {
      const salon = createSalon(db, { name: "Mi Salón", phone: "+5255000001" });
      const app = createWebPanel(db);
      const req = new Request(
        `http://localhost/panel/dashboard?token=${salon.token}`,
      );
      const res = await app.fetch(req);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Mi Salón");
    });

    it("shows the próxima-cita banner and stats footer (v1 dashboard)", async () => {
      // 2026-05-25 dashboard v1 rewrite: the old 4-card grid was replaced
      // by a próxima-cita banner above today/tomorrow tables, with stats
      // demoted to a one-line footer at the bottom.
      const salon = createSalon(db, { name: "Salón X", phone: "+5255000001" });
      const app = createWebPanel(db);
      const req = new Request(
        `http://localhost/panel/dashboard?token=${salon.token}`,
      );
      const res = await app.fetch(req);
      const html = await res.text();
      // With no appointments, the banner shows the empty state instead of
      // "Próxima cita" — check for the banner element itself and the new
      // stats-footer, both load-bearing markers of the v1 layout.
      expect(html).toContain("next-banner");
      expect(html).toContain("stats-footer");
      expect(html).toContain("citas hoy");
    });
  });

  describe("GET /panel/api/stats", () => {
    it("returns JSON stats for valid token", async () => {
      const salon = createSalon(db, {
        name: "Salón Stats",
        phone: "+5255000001",
      });
      const app = createWebPanel(db);
      const req = new Request(
        `http://localhost/panel/api/stats?token=${salon.token}`,
      );
      const res = await app.fetch(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.salon).toBe("Salón Stats");
      expect(body.contacts).toBe(0);
      expect(body.dormant).toBe(0);
    });

    it("returns 401 without token", async () => {
      const app = createWebPanel(db);
      const req = new Request("http://localhost/panel/api/stats");
      const res = await app.fetch(req);
      expect(res.status).toBe(401);
    });
  });

  describe("GET /panel/contacts", () => {
    it("returns 200 with contacts table", async () => {
      const salon = createSalon(db, { name: "Mi Salón", phone: "+5255000001" });
      const app = createWebPanel(db);
      const req = new Request(
        `http://localhost/panel/contacts?token=${salon.token}`,
      );
      const res = await app.fetch(req);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Clientas");
    });
  });

  describe("GET /panel/campaigns", () => {
    it("returns 200 with campaigns view", async () => {
      const salon = createSalon(db, { name: "Mi Salón", phone: "+5255000001" });
      const app = createWebPanel(db);
      const req = new Request(
        `http://localhost/panel/campaigns?token=${salon.token}`,
      );
      const res = await app.fetch(req);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Reactivaciones");
    });
  });
});
