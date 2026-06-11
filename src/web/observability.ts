/**
 * Operational observability surface for mc-prometheus / uptime tooling.
 *
 *   GET /health/salons  → JSON, per-salon Baileys connection health
 *   GET /metrics        → Prometheus text exposition
 *
 * Both are gated by ADMIN_TOKEN (?token=). The panel is fronted publicly by
 * Caddy, so an UNgated /metrics would leak salon ids + phone state to the
 * internet. mc-prometheus scrapes 127.0.0.1:8085 and presents the token via
 * its scrape config (`params: { token: [...] }`). Plain GET /health (no
 * salon detail) stays public for liveness checks — it lives in panel.ts.
 *
 * The actual ">24h disconnected" ALERT is owned by mc-prometheus (a `for: 24h`
 * clause over the scraped gauge), per the chosen design. This service only
 * EXPOSES instantaneous state; it does not page anyone.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type Database from "better-sqlite3";
import { getAllActiveSalons } from "../db/models.js";
import {
  BAILEYS_STATES,
  disconnectAlertHours,
  evaluateSalonHealth,
  getAllSalonConnStates,
  getBootTime,
  snapshotDisconnects,
  type SalonHealth,
} from "../bot/baileys-state.js";
import { clientIp, createRateLimiter, verifyAdminTokenQuery } from "./auth.js";
import { snapshotDrops } from "../bot/rate-limiter.js";

/** Snapshot the health of every ACTIVE salon (joins DB roster + live registry). */
export function computeSalonHealths(
  db: Database.Database,
  nowMs: number = Date.now(),
): SalonHealth[] {
  const salons = getAllActiveSalons(db);
  const records = new Map(getAllSalonConnStates().map((r) => [r.salonId, r]));
  const thresholdMs = disconnectAlertHours() * 3_600_000;
  const bootMs = getBootTime();
  return salons.map((s) =>
    evaluateSalonHealth(s, records.get(s.id), { nowMs, thresholdMs, bootMs }),
  );
}

/** Escape a Prometheus label value per the text exposition spec. */
function escapeLabel(v: string): string {
  return v
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

/** Mask a phone to its last 4 digits for the gated JSON (PII reduction). */
function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 4) return "••••";
  return "••••" + digits.slice(-4);
}

/** Render the salon-health snapshot as Prometheus text (format 0.0.4). */
export function renderMetrics(healths: SalonHealth[]): string {
  const lines: string[] = [];

  lines.push(
    "# HELP salones_wa_baileys_state Current Baileys connection state per salon (1 = current state).",
    "# TYPE salones_wa_baileys_state gauge",
  );
  for (const h of healths) {
    const id = escapeLabel(h.salonId);
    for (const s of BAILEYS_STATES) {
      lines.push(
        `salones_wa_baileys_state{salon_id="${id}",state="${s}"} ${h.state === s ? 1 : 0}`,
      );
    }
  }

  lines.push(
    "# HELP salones_wa_baileys_connected Whether the salon is currently connected (1/0).",
    "# TYPE salones_wa_baileys_connected gauge",
  );
  for (const h of healths) {
    lines.push(
      `salones_wa_baileys_connected{salon_id="${escapeLabel(h.salonId)}"} ${h.state === "connected" ? 1 : 0}`,
    );
  }

  lines.push(
    "# HELP salones_wa_baileys_down_seconds Seconds since last successful connection (0 while connected).",
    "# TYPE salones_wa_baileys_down_seconds gauge",
  );
  for (const h of healths) {
    lines.push(
      `salones_wa_baileys_down_seconds{salon_id="${escapeLabel(h.salonId)}"} ${h.downForSeconds ?? 0}`,
    );
  }

  lines.push(
    "# HELP salones_wa_baileys_last_connected_timestamp_seconds Unix time of last successful connection (omitted if never connected).",
    "# TYPE salones_wa_baileys_last_connected_timestamp_seconds gauge",
  );
  for (const h of healths) {
    if (h.lastConnectedAt != null) {
      lines.push(
        `salones_wa_baileys_last_connected_timestamp_seconds{salon_id="${escapeLabel(h.salonId)}"} ${Math.floor(h.lastConnectedAt / 1000)}`,
      );
    }
  }

  lines.push(
    "# HELP salones_wa_salons_active Number of active salons configured.",
    "# TYPE salones_wa_salons_active gauge",
    `salones_wa_salons_active ${healths.filter((h) => h.active).length}`,
    "# HELP salones_wa_salons_stale Number of active salons disconnected past the alert threshold.",
    "# TYPE salones_wa_salons_stale gauge",
    `salones_wa_salons_stale ${healths.filter((h) => h.active && h.stale).length}`,
  );

  return lines.join("\n") + "\n";
}

/**
 * Render the in-memory outbound-drop counter (§1.2 rate limiter) as Prometheus
 * text. Zero series while the limiter is dormant — just the HELP/TYPE header.
 */
export function renderOutboundDropMetrics(
  drops: ReturnType<typeof snapshotDrops>,
): string {
  const lines: string[] = [
    "# HELP salones_wa_outbound_dropped_total Unsolicited messages dropped by the rate limiter (§1.2).",
    "# TYPE salones_wa_outbound_dropped_total counter",
  ];
  for (const d of drops) {
    lines.push(
      `salones_wa_outbound_dropped_total{salon_id="${escapeLabel(d.salonId)}",kind="${escapeLabel(d.kind)}",reason="${escapeLabel(d.reason)}"} ${d.count}`,
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * Render the in-memory disconnect counter (§1.5) as Prometheus text. Zero series
 * until the first socket close — just the HELP/TYPE header — so the scrape shape
 * is stable from boot. `code` is the DisconnectReason status (or "none"); `reason`
 * is its bounded symbolic name (see disconnectReasonName).
 */
export function renderDisconnectMetrics(
  disconnects: ReturnType<typeof snapshotDisconnects>,
): string {
  const lines: string[] = [
    "# HELP salones_wa_disconnect_total Baileys socket disconnects by DisconnectReason (§1.5).",
    "# TYPE salones_wa_disconnect_total counter",
  ];
  for (const d of disconnects) {
    lines.push(
      `salones_wa_disconnect_total{salon_id="${escapeLabel(d.salonId)}",code="${escapeLabel(d.code)}",reason="${escapeLabel(d.reason)}"} ${d.count}`,
    );
  }
  return lines.join("\n") + "\n";
}

/** Routes mounted at the app root alongside panel + admin. */
export function createObservabilityRoutes(db: Database.Database): Hono {
  const app = new Hono();

  // Per-IP brute-force limiter for these internet-reachable (Caddy-proxied),
  // token-gated routes — its own budget, independent of the admin panel's.
  const rateLimiter = createRateLimiter();

  /**
   * Gate: rate-limit by IP, then constant-time token check. Returns a 429/401
   * Response on failure (and records the failure), or null to proceed.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gate = (c: Context<any, any, any>): Response | null => {
    const ip = clientIp(c);
    if (!rateLimiter.check(ip))
      return c.text("Demasiados intentos. Espera 1 minuto.", 429);
    if (!verifyAdminTokenQuery(c)) {
      rateLimiter.recordFailure(ip);
      return c.text("Token de administrador requerido o inválido", 401);
    }
    return null;
  };

  // ─── Per-salon Baileys health (JSON) ────────────────────────────────
  app.get("/health/salons", (c) => {
    const denied = gate(c);
    if (denied) return denied;

    const healths = computeSalonHealths(db);
    return c.json({
      ok: true,
      ts: new Date().toISOString(),
      thresholdHours: disconnectAlertHours(),
      salons: healths.map((h) => ({
        salonId: h.salonId,
        name: h.name,
        phone: maskPhone(h.phone),
        active: h.active,
        state: h.state,
        since: h.since != null ? new Date(h.since).toISOString() : null,
        lastConnectedAt:
          h.lastConnectedAt != null
            ? new Date(h.lastConnectedAt).toISOString()
            : null,
        downForSeconds: h.downForSeconds,
        stale: h.stale,
      })),
    });
  });

  // ─── Prometheus metrics ─────────────────────────────────────────────
  app.get("/metrics", (c) => {
    const denied = gate(c);
    if (denied) return denied;

    const body =
      renderMetrics(computeSalonHealths(db)) +
      renderOutboundDropMetrics(snapshotDrops()) +
      renderDisconnectMetrics(snapshotDisconnects());
    return c.body(body, 200, {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    });
  });

  return app;
}
