/**
 * salones-wa — WA automation bot for salones de belleza
 * Entry point: initializes DB, Baileys, crons, web panel
 */

import { serve } from "@hono/node-server";
import fs from "node:fs";
import path from "node:path";
import { getDb } from "./db/database.js";
import { getAllActiveSalons } from "./db/models.js";
import { createWebPanel } from "./web/panel.js";
import { createAdminPanel } from "./web/admin.js";
import { createObservabilityRoutes } from "./web/observability.js";
import { registerCrons } from "./crons/index.js";
import {
  initBaileysForSalon,
  reinitBaileysForSalon,
  isSessionRegistered,
  getInstance,
} from "./bot/baileys-manager.js";
import {
  getAllSalonConnStates,
  getBootTime,
  reconnectStuckMinutes,
  reconnectMaxStrikes,
  planWatchdogTick,
} from "./bot/baileys-state.js";
import qrcodeTerminal from "qrcode-terminal";

const PORT = parseInt(process.env["PORT"] ?? "8085");
const SESSIONS_DIR = process.env["SESSIONS_DIR"] ?? "./data/sessions";
const DB_PATH = process.env["DB_PATH"] ?? "./data/salones.db";

// P0-1: Hard-fail at startup if ADMIN_TOKEN is missing or too short
const ADMIN_TOKEN = process.env["ADMIN_TOKEN"];
if (!ADMIN_TOKEN || ADMIN_TOKEN.length < 16) {
  console.error(
    "[salones-wa] FATAL: ADMIN_TOKEN env var must be set and at least 16 chars long.",
  );
  console.error(
    "[salones-wa] Generate one with: node -e \"console.log(require('crypto').randomBytes(24).toString('hex'))\"",
  );
  process.exit(1);
}

async function main() {
  console.log("[salones-wa] starting...");

  // ─── Database ────────────────────────────────────────────────────────
  const db = getDb(DB_PATH);
  console.log("[salones-wa] DB ready");

  // ─── W3: harden file permissions at startup (idempotent) ─────────────
  const sessionsDir = path.resolve(SESSIONS_DIR);
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.chmodSync(sessionsDir, 0o700);
  const dbFile = path.resolve(DB_PATH);
  if (fs.existsSync(dbFile)) fs.chmodSync(dbFile, 0o600);
  const dbWal = dbFile + "-wal";
  if (fs.existsSync(dbWal)) fs.chmodSync(dbWal, 0o600);
  const dbShm = dbFile + "-shm";
  if (fs.existsSync(dbShm)) fs.chmodSync(dbShm, 0o600);

  // ─── Web panel + Admin (Hono) ────────────────────────────────────────
  // Binds to 127.0.0.1 by default. Front with Caddy for public access.
  // To override (NOT recommended for production): set BIND_HOST=0.0.0.0 in .env
  const app = createWebPanel(db);
  const adminApp = createAdminPanel(db);
  app.route("/", adminApp);
  // Observability surface (/health/salons + /metrics), ADMIN_TOKEN-gated.
  app.route("/", createObservabilityRoutes(db));
  const bindHost = process.env["BIND_HOST"] ?? "127.0.0.1";
  serve({ fetch: app.fetch, port: PORT, hostname: bindHost }, () => {
    console.log(`[salones-wa] web panel listening on ${bindHost}:${PORT}`);
    // R3: Never log the token value — just confirm it's set
    console.log(
      `[salones-wa] admin panel at /admin?token=<set, ${ADMIN_TOKEN!.length} chars>`,
    );
  });

  // ─── Crons ───────────────────────────────────────────────────────────
  const sendMessageAdapter = async (
    salonPhone: string,
    toPhone: string,
    text: string,
  ) => {
    // Find salon by phone and get its instance
    const salon = db
      .prepare("SELECT * FROM salons WHERE phone = ? AND active = 1")
      .get(salonPhone) as { id: string } | undefined;
    if (!salon) return;

    const instance = getInstance(salon.id);
    if (!instance) {
      throw new Error(
        `[salones-wa] no Baileys instance for salon ${salon.id} — send aborted`,
      );
    }
    await instance.sendMessage(toPhone, text);
  };

  const jobs = registerCrons(db, sendMessageAdapter);
  console.log(
    `[salones-wa] ${jobs.length} cron jobs registered: ${jobs.map((j) => j.name).join(", ")}`,
  );

  // ─── Baileys instances (one per active salon) ────────────────────────
  const salons = getAllActiveSalons(db);
  if (salons.length === 0) {
    console.log(
      "[salones-wa] no active salons configured. Add one via onboarding script.",
    );
  }

  // Shared so both the initial boot loop and the liveness watchdog re-init
  // with the SAME callbacks (QR / pairing render).
  const baileysOptions = {
    sessionsDir: SESSIONS_DIR,
    db,
    onQR: (salonId: string, qr: string) => {
      console.log(`[salones-wa] QR for salon ${salonId} — scan with WhatsApp:`);
      // W8: Actually render the QR code in the terminal
      qrcodeTerminal.generate(qr, { small: true });
    },
    onPairingCode: (salonId: string, code: string) => {
      // Pairing-code link is preferred over QR for VPS / data-center IPs
      // (WA's QR flow tends to reject these). Operator enters this 8-digit
      // code in WhatsApp → Linked Devices → "Vincular con número de teléfono".
      console.log(`[salones-wa] Pairing code for salon ${salonId}: ${code}`);
    },
  };

  for (const salon of salons) {
    await initBaileysForSalon(baileysOptions, salon.id, salon.phone);
  }

  console.log("[salones-wa] ready ✅");

  // ─── Liveness watchdog: self-heal stuck Baileys sockets ──────────────
  // The reconnect logic in baileys-manager is driven by the socket's "close"
  // event. A 428 can leave a socket stuck half-open that never fires "close",
  // so nothing retries it — it sat dead ~53h in the 2026-06-06 incident. This
  // watchdog force-reconnects any active salon stuck non-`connected` past the
  // threshold (skipping logged_out, which needs a manual re-link). Kill switch:
  // BAILEYS_WATCHDOG_ENABLED=false.
  let watchdog: NodeJS.Timeout | undefined;
  if (process.env["BAILEYS_WATCHDOG_ENABLED"] !== "false") {
    const WATCHDOG_INTERVAL_MS = 60_000;
    const lastHealAt = new Map<string, number>(); // salonId → last reinit ms
    const strikes = new Map<string, number>(); // consecutive reinits, reset on connect
    watchdog = setInterval(() => {
      try {
        const active = getAllActiveSalons(db);
        const records = new Map(
          getAllSalonConnStates().map((r) => [r.salonId, r]),
        );
        const maxStrikes = reconnectMaxStrikes();
        // cooldownMs === stuckMs: at most one reinit per stuck-window per salon.
        // The strike cap (maxStrikes) is what ultimately bounds a salon that can
        // never recover — tuning stuckMs down shortens BOTH the detect time and
        // the retry gap, but maxStrikes still stops the burn.
        const stuckMs = reconnectStuckMinutes() * 60_000;
        const { reinit, gaveUp } = planWatchdogTick(active, records, {
          nowMs: Date.now(),
          stuckMs,
          cooldownMs: stuckMs,
          bootMs: getBootTime(),
          maxStrikes,
          strikes,
          lastHealAt,
          // qa-W4: skip salons mid-onboarding (no registered creds yet).
          isRegistered: (id) => isSessionRegistered(SESSIONS_DIR, id),
        });
        for (const salonId of reinit) {
          const salon = active.find((s) => s.id === salonId);
          if (!salon) continue;
          const n = strikes.get(salonId) ?? 0;
          if (gaveUp.includes(salonId)) {
            console.warn(
              `[watchdog] salon "${salon.name}" (${salon.phone}) reinit ${n}/${maxStrikes} — GIVING UP until it recovers (manual re-link likely needed)`,
            );
          } else {
            console.warn(
              `[watchdog] salon "${salon.name}" (${salon.phone}) stuck non-connected — forcing reconnect (${n}/${maxStrikes})`,
            );
          }
          void reinitBaileysForSalon(
            baileysOptions,
            salon.id,
            salon.phone,
          ).catch((err) =>
            console.error(`[watchdog] reinit failed for ${salon.id}:`, err),
          );
        }
      } catch (err) {
        console.error("[watchdog] error", err);
      }
    }, WATCHDOG_INTERVAL_MS);
    watchdog.unref(); // don't keep the process alive on its own
    console.log(
      `[salones-wa] Baileys liveness watchdog active (every ${WATCHDOG_INTERVAL_MS / 1000}s, stuck>${reconnectStuckMinutes()}min, max ${reconnectMaxStrikes()} strikes)`,
    );
  }

  // ─── Graceful shutdown ───────────────────────────────────────────────
  process.on("SIGTERM", () => {
    console.log("[salones-wa] shutting down...");
    if (watchdog) clearInterval(watchdog);
    db.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[salones-wa] fatal startup error:", err);
  process.exit(1);
});
