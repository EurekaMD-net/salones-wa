/**
 * Baileys connection manager.
 * One Baileys instance per salon — manages reconnection, QR display, session persistence.
 *
 * NOTE: Actual WA connection requires a real phone number.
 * In dev/test mode (SALONES_ENV=test), this module is a no-op stub.
 */

import { mkdirSync, readFileSync } from "fs";
import { join } from "path";
import type Database from "better-sqlite3";
import { getSalonByPhone, upsertContact } from "../db/models.js";
import { handleInboundMessage } from "./message-handler.js";
import { recordSalonState } from "./baileys-state.js";

export interface BaileysInstance {
  salonId: string;
  salonPhone: string;
  sendMessage: (toPhone: string, text: string) => Promise<void>;
  disconnect: () => Promise<void>;
}

export interface BaileysManagerOptions {
  sessionsDir: string;
  db: Database.Database;
  onQR?: (salonId: string, qr: string) => void;
  /**
   * Pairing-code linking (preferred over QR for VPS / data-center IPs, which
   * WhatsApp's QR flow increasingly rejects with "you can't add new devices
   * at this time"). Fires once per unregistered session, ~2s after socket
   * init. Coexists with onQR — operator can use whichever WA accepts.
   */
  onPairingCode?: (salonId: string, code: string) => void;
}

const instances = new Map<string, BaileysInstance>();

// Per-salon socket generation (qa-C1). reinitBaileysForSalon drops a stuck
// socket from `instances` but cannot synchronously tear down its WebSocket, so
// the old socket's event handlers survive. Each socket captures its generation
// at init; once a newer socket supersedes it, the stale socket's handlers
// no-op — preventing a zombie's late "close" from deleting the live instance
// (also closes the pre-existing reconnect race, not just the watchdog path).
const socketGenerations = new Map<string, number>();

/** Stub sendMessage for test environment */
function createStubInstance(
  salonId: string,
  salonPhone: string,
): BaileysInstance {
  return {
    salonId,
    salonPhone,
    sendMessage: async (toPhone: string, text: string) => {
      console.log(
        `[baileys-stub] [${salonPhone}] → ${toPhone}: ${text.slice(0, 80)}`,
      );
    },
    disconnect: async () => {
      instances.delete(salonId);
    },
  };
}

/**
 * Initialize a Baileys connection for a salon.
 * Returns immediately in test mode.
 */
export async function initBaileysForSalon(
  options: BaileysManagerOptions,
  salonId: string,
  salonPhone: string,
): Promise<BaileysInstance> {
  if (instances.has(salonId)) return instances.get(salonId)!;

  const isTest = process.env["SALONES_ENV"] === "test";

  if (isTest) {
    const instance = createStubInstance(salonId, salonPhone);
    instances.set(salonId, instance);
    // Stubs are functionally "connected" (they can send) — surface that in
    // the observability registry so a dev/test run shows green.
    recordSalonState(salonId, salonPhone, "connected");
    return instance;
  }

  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
  } = await import("@whiskeysockets/baileys");
  const { Boom } = await import("@hapi/boom");

  const sessionDir = join(options.sessionsDir, salonId);
  mkdirSync(sessionDir, { recursive: true });

  // Observability: this salon is now attempting to connect. Overwritten by the
  // connection.update handler below once the socket opens / closes / logs out.
  recordSalonState(salonId, salonPhone, "connecting");

  // qa-C1: claim a generation. If a later reinit/reconnect supersedes this
  // socket, the guards below make its handlers inert (a stuck zombie can't
  // delete the live instance or flip its state on a late "close").
  const myGeneration = (socketGenerations.get(salonId) ?? 0) + 1;
  socketGenerations.set(salonId, myGeneration);
  const isCurrentGeneration = () =>
    socketGenerations.get(salonId) === myGeneration;

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    // W2 (audit 2026-05-24): false because we render our own QR via qrcode-terminal
    // in the onQR callback AND prefer pairing-code linking. Leaving it true caused
    // a deprecation warning + raced with our own renderer.
    printQRInTerminal: false,
    // 2026-05-24: switched from custom ['SalonesWA','Chrome','1.0'] to the
    // recognized WA Web signature. Custom browser strings are sometimes
    // treated as anti-spam-suspicious by WA's pairing-code endpoint;
    // Browsers.ubuntu('Chrome') mimics a real Ubuntu+Chrome WA Web client
    // that WA's backend recognizes. Common Baileys community fix when
    // pairing-code linking fails from VPS / data-center IPs.
    browser: Browsers.ubuntu("Chrome"),
    // Minimize logging noise
    logger: {
      level: "silent",
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: (msg: unknown) => console.warn("[baileys]", msg),
      error: (msg: unknown) => console.error("[baileys]", msg),
      child: () =>
        ({
          level: "silent",
          trace: () => {},
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
          child: () => ({}),
        }) as never,
    } as never,
  });

  sock.ev.on("creds.update", saveCreds);

  // Pairing-code request flow:
  // 1. Must wait for the WA server to finish the noise-protocol handshake
  //    before sendNode is safe (W1 audit 2026-05-24). The FIRST `qr` emit
  //    is the right signal — earlier triggers (e.g. `connection ===
  //    "connecting"`) fail with "Connection Closed / Precondition Required"
  //    because the WS isn't ready for iq nodes.
  // 2. Pin the callback locally (W3) so a later options mutation can't trip
  //    the non-null assertion at .then time.
  // 3. THROTTLE regen to once per ~50s. Each call to requestPairingCode
  //    INVALIDATES the previous code on WA's backend — Baileys' QR cycle
  //    fires every ~20s in practice, but WA codes expire ~60s. Without
  //    throttling, by the time the operator types code X, we've already
  //    issued code X+1 and WA marks X dead. Symptom: "No se pudo vincular
  //    el dispositivo" on every attempt despite codes appearing fresh.
  //    Time-based throttle keeps each code valid for ~50s of WA-side
  //    expiry minus a small safety margin.
  const PAIRING_REGEN_INTERVAL_MS = 50_000;
  let pairingRequestInFlight = false;
  let lastPairingRequestAt = 0;
  const onPairingCodeCb = options.onPairingCode;

  sock.ev.on("connection.update", (update) => {
    // qa-C1: a superseded (stale) socket must not act on its events.
    if (!isCurrentGeneration()) return;
    const { connection, lastDisconnect, qr } = update;

    if (qr && options.onQR) {
      options.onQR(salonId, qr);
    }

    if (
      qr &&
      !pairingRequestInFlight &&
      !state.creds.registered &&
      onPairingCodeCb
    ) {
      const now = Date.now();
      if (now - lastPairingRequestAt >= PAIRING_REGEN_INTERVAL_MS) {
        lastPairingRequestAt = now;
        pairingRequestInFlight = true;
        sock
          .requestPairingCode(salonPhone)
          .then((code) => onPairingCodeCb(salonId, code))
          .catch((err) => {
            // Reset both gates so a future qr event can retry
            lastPairingRequestAt = 0;
            console.error(
              `[baileys] [${salonPhone}] pairing-code request failed:`,
              err,
            );
          })
          .finally(() => {
            pairingRequestInFlight = false;
          });
      }
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as InstanceType<typeof Boom>)
        ?.output?.statusCode;
      const reason = lastDisconnect?.error?.message ?? "unknown";
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        recordSalonState(salonId, salonPhone, "reconnecting");
        console.log(
          `[baileys] [${salonPhone}] reconnecting (code=${statusCode ?? "?"}, reason=${reason})...`,
        );
        // 2026-05-24: must delete the zombie instance from the map BEFORE
        // the setTimeout fires, otherwise initBaileysForSalon's early-return
        // at instances.has(salonId) returns the now-dead instance. This was
        // load-bearing for code 515 (restartRequired): WA auths the device,
        // emits 515, our reconnect needed to actually re-init Baileys with
        // the persisted (registered) creds — without this delete, Baileys
        // stays disconnected forever after a successful link.
        instances.delete(salonId);
        setTimeout(
          () => initBaileysForSalon(options, salonId, salonPhone),
          5000,
        );
      } else {
        recordSalonState(salonId, salonPhone, "logged_out");
        console.log(
          `[baileys] [${salonPhone}] logged out — manual re-link required`,
        );
        instances.delete(salonId);
      }
    }

    if (connection === "open") {
      recordSalonState(salonId, salonPhone, "connected");
      console.log(`[baileys] [${salonPhone}] connected ✅`);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    // qa-C1: ignore inbound on a superseded socket (avoid double-processing).
    if (!isCurrentGeneration()) return;
    if (type !== "notify") return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const from = msg.key.remoteJid;
      if (!from) continue;

      // 2026-05-24: WA's multi-device protocol uses opaque @lid identifiers
      // for many senders instead of phone-format JIDs. Baileys 7 surfaces
      // the phone-format JID (when available) on key.remoteJidAlt. Prefer
      // it for contact identification — otherwise we store an unusable LID
      // string in contacts.phone, breaking reminders/reactivation crons
      // that need real phone numbers to fan out outbound messages.
      // The original `from` (full JID) is kept for sendMessage replies
      // because Baileys routes both LID and phone JIDs correctly.
      const altJid = msg.key.remoteJidAlt;
      const idJid =
        altJid && altJid.endsWith("@s.whatsapp.net") ? altJid : from;
      const phone = idJid
        .replace("@s.whatsapp.net", "")
        .replace("@g.us", "")
        .replace("@lid", "");
      const text =
        msg.message?.conversation ??
        msg.message?.extendedTextMessage?.text ??
        "";
      if (!text) continue;

      const salon = getSalonByPhone(options.db, salonPhone);
      if (!salon) continue;

      upsertContact(options.db, { salon_id: salon.id, phone });

      try {
        const result = await handleInboundMessage(
          options.db,
          salon.id,
          phone,
          text,
        );
        if (result.reply) {
          await sock.sendMessage(from, { text: result.reply });
        }
      } catch (err) {
        const statusCode = (err as InstanceType<typeof Boom>)?.output
          ?.statusCode;
        const reason = (err as Error)?.message ?? "unknown";
        console.error(
          `[baileys] [${salonPhone}] message handler error (code=${statusCode ?? "?"}, reason=${reason})`,
          err,
        );
      }
    }
  });

  const instance: BaileysInstance = {
    salonId,
    salonPhone,
    sendMessage: async (toPhone: string, text: string) => {
      await sock.sendMessage(`${toPhone}@s.whatsapp.net`, { text });
    },
    disconnect: async () => {
      await sock.logout();
      instances.delete(salonId);
    },
  };

  // qa-W-A: only publish this socket to the map if it's still the current
  // generation. A concurrent init/reinit (e.g. the close-handler's 5s
  // setTimeout racing a watchdog reinit) could otherwise leave the map holding
  // an older socket (used by sendMessage) while the newer socket owns inbound —
  // receive-on-one, reply-on-dead. Gating here keeps the map and the active
  // handler generation in lockstep; a superseded socket becomes fully inert.
  if (isCurrentGeneration()) instances.set(salonId, instance);
  return instance;
}

/**
 * Force a fresh Baileys connection for a salon, dropping any existing
 * (possibly zombie/stuck) instance WITHOUT logging out — creds stay on disk so
 * the new socket re-auths silently. Mirrors the close-handler reconnect
 * (`instances.delete` + init); the liveness watchdog calls this for a salon
 * stuck non-`connected`, where no "close" event ever fired to trigger the
 * normal reconnect. Deliberately does NOT call `disconnect()`/`logout()` —
 * that would invalidate the session and force a manual re-link.
 */
export async function reinitBaileysForSalon(
  options: BaileysManagerOptions,
  salonId: string,
  salonPhone: string,
): Promise<BaileysInstance> {
  instances.delete(salonId);
  return initBaileysForSalon(options, salonId, salonPhone);
}

/**
 * Whether a salon's session has completed pairing (creds.registered === true).
 * qa-W4: the liveness watchdog uses this to NEVER force-reconnect a salon that
 * is mid-onboarding (no registered creds yet) — doing so would invalidate the
 * operator's in-flight pairing code and burn WA's account-side cool-down.
 * A never-linked salon legitimately sits in "connecting" while awaiting a scan.
 */
export function isSessionRegistered(
  sessionsDir: string,
  salonId: string,
): boolean {
  try {
    const raw = readFileSync(join(sessionsDir, salonId, "creds.json"), "utf8");
    return JSON.parse(raw)?.registered === true;
  } catch {
    return false; // no creds / unreadable → treat as not-yet-linked
  }
}

export function getInstance(salonId: string): BaileysInstance | undefined {
  return instances.get(salonId);
}

export function getAllInstances(): BaileysInstance[] {
  return [...instances.values()];
}
