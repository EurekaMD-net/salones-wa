/**
 * Baileys connection manager.
 * One Baileys instance per salon — manages reconnection, QR display, session persistence.
 *
 * NOTE: Actual WA connection requires a real phone number.
 * In dev/test mode (SALONES_ENV=test), this module is a no-op stub.
 */

import { mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import type Database from "better-sqlite3";
import { getSalonByPhone, upsertContact } from "../db/models.js";
import { handleInboundMessage } from "./message-handler.js";
import { recordSalonState } from "./baileys-state.js";
import {
  loadHumanizeConfig,
  humanizedSend,
  humanizedReadReceipt,
} from "./humanize.js";
import {
  loadPresenceConfig,
  decidePresence,
  hourInTz,
  type Presence,
  type PresenceConfig,
} from "./presence.js";
import { loadRateLimitConfig, recordReplyOutbound } from "./rate-limiter.js";

export interface BaileysInstance {
  salonId: string;
  salonPhone: string;
  sendMessage: (toPhone: string, text: string) => Promise<void>;
  disconnect: () => Promise<void>;
  /**
   * Presence check — returns whether the given WA number has an active WhatsApp account.
   * Uses onWhatsApp() — silent, no message sent.
   * Throws if the socket is disconnected or WA returns an error.
   */
  checkWA: (
    waNumber: string,
  ) => Promise<{ exists: boolean; jid: string | null }>;
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

// §1.1 presence cycling: one re-evaluation timer per salon. Started on `open`,
// stopped at every teardown seam; each tick is also generation-fenced so a
// zombie socket's timer self-clears even if a stop is somehow missed.
const presenceTimers = new Map<string, ReturnType<typeof setInterval>>();

/** Stop and forget a salon's presence-cycling timer. Idempotent. */
function stopPresenceCycle(salonId: string): void {
  const handle = presenceTimers.get(salonId);
  if (handle !== undefined) {
    clearInterval(handle);
    presenceTimers.delete(salonId);
  }
}

/**
 * Start the presence-cycling timer for a freshly-connected salon: set the
 * desired global presence immediately, then re-evaluate every `cfg.tickMs`.
 * No-op when disabled. `setPresence` is the caller's real sock closure; presence
 * is best-effort, so a Baileys failure is swallowed (never escalates). `isCurrent`
 * is the socket's generation fence — a superseded socket's tick self-clears.
 */
function startPresenceCycle(
  salonId: string,
  setPresence: (type: Presence) => Promise<void>,
  cfg: PresenceConfig,
  isCurrent: () => boolean,
): void {
  stopPresenceCycle(salonId); // never stack two timers on one salon
  if (!cfg.enabled) return;
  const tick = async (): Promise<void> => {
    if (!isCurrent()) {
      stopPresenceCycle(salonId);
      return;
    }
    const want = decidePresence(hourInTz(new Date(), cfg.timeZone), cfg);
    try {
      await setPresence(want);
    } catch {
      /* presence is decorative — a failure must never escalate */
    }
  };
  void tick(); // set initial presence on connect, don't wait a full interval
  const handle = setInterval(() => void tick(), cfg.tickMs);
  handle.unref?.(); // a cosmetic timer must not keep the process alive
  presenceTimers.set(salonId, handle);
}

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
    checkWA: async (_waNumber: string) => {
      // Stub: always returns false in test environment
      return { exists: false, jid: null };
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
  // §1.1 behavioral mimicry config. Read once per socket init from the
  // environment; loadHumanizeConfig forces it OFF under SALONES_ENV=test and
  // when HUMANIZE_ENABLED is unset (default), so this is a no-op until the
  // operator flips the flag and restarts the service.
  const humanize = loadHumanizeConfig();
  const presence = loadPresenceConfig();
  const rateLimit = loadRateLimitConfig();
  // Log only when ON, so the default-off path stays silent (no behavior change)
  // and the operator gets positive confirmation the flag parsed during smoke —
  // catches a typo'd HUMANIZE_ENABLED (e.g. "TRUE"/"yes") that fails safe to off.
  if (humanize.enabled) {
    console.log(
      `[humanize] [${salonPhone}] ON — read ${humanize.readReceipts ? `${humanize.readMinMs}-${humanize.readMaxMs}ms` : "off"}, ` +
        `type ${humanize.typeMinMs}-${humanize.typeMaxMs}ms +${humanize.typePerCharMs}/char cap ${humanize.typeCapMs}ms`,
    );
  }
  if (presence.enabled) {
    console.log(
      `[presence] [${salonPhone}] cycling ON — online ${presence.startHour}-${presence.endHour}h ${presence.timeZone}, ` +
        `tick ${Math.round(presence.tickMs / 1000)}s, gap ${Math.round(presence.offlineGapChance * 100)}%`,
    );
  }

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
    // §1.1 presence cycling: when ON, don't broadcast `available` the instant we
    // connect — the cycle timer manages presence per business hours. When OFF,
    // keep Baileys' default (true) so behavior is unchanged.
    markOnlineOnConnect: !presence.enabled,
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
      // §1.1: a closed socket must not keep cycling presence (and a reconnect
      // re-arms its own timer on the next `open`).
      stopPresenceCycle(salonId);
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
      // §1.1: begin presence cycling for this (now live) socket. No-op when off.
      startPresenceCycle(
        salonId,
        (type) => sock.sendPresenceUpdate(type),
        presence,
        isCurrentGeneration,
      );
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
        // §1.1: mark the clienta's message read after a human jitter. Fire-and-
        // forget (no await) so it never delays the reply; no-op when disabled.
        void humanizedReadReceipt(() => sock.readMessages([msg.key]), humanize);
        if (result.reply) {
          // Capture into a definite string so the send closure doesn't depend
          // on the (possibly re-narrowed) result.reply field.
          const reply = result.reply;
          // §1.1: show `composing` for a length-scaled window, then send.
          // When humanize is disabled this is an immediate, unchanged send.
          await humanizedSend(
            reply,
            (type) => sock.sendPresenceUpdate(type, from),
            async () => {
              await sock.sendMessage(from, { text: reply });
            },
            humanize,
          );
          // §1.2: count this reply toward the salon's daily total (no-op while
          // RATE_LIMIT_ENABLED is off). Reactive replies are never gated/dropped.
          recordReplyOutbound(options.db, rateLimit, salon.id, salon.timezone);
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
    checkWA: async (waNumber: string) => {
      const results = await sock.onWhatsApp(waNumber);
      const found = results?.[0];
      return {
        exists: found?.exists === true,
        jid: found?.jid ?? null,
      };
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
  stopPresenceCycle(salonId); // §1.1: drop the stale socket's presence timer
  return initBaileysForSalon(options, salonId, salonPhone);
}

/** How long to wait for a graceful logout() before abandoning it during a
 * salon delete. A half-open socket can leave logout() hanging indefinitely, so
 * we never let it block the deletion — the instance is already removed from the
 * map and superseded, so a lingering background logout is harmless. */
const DELETE_LOGOUT_TIMEOUT_MS = 5000;

/**
 * Permanently tear down a salon's Baileys presence when the salon is DELETED.
 * Unlike reinitBaileysForSalon (which preserves creds for a silent re-auth),
 * this DOES log out — the salon is gone, so the WhatsApp linked-device slot and
 * the on-disk session should be released.
 *
 * Best-effort and NON-THROWING by contract: the caller (admin delete route)
 * must still remove the DB row even if WA logout fails, so every step is
 * guarded and logout() is raced against a timeout. Order matters: the instance
 * is dropped from the map and the generation is bumped FIRST, so the bot stops
 * answering immediately and any surviving zombie socket's late events no-op —
 * even if the subsequent logout() hangs or rejects.
 */
export async function removeBaileysForSalon(
  options: BaileysManagerOptions,
  salonId: string,
): Promise<void> {
  // Supersede any in-flight/zombie socket so its handlers go inert (qa-C1).
  socketGenerations.set(salonId, (socketGenerations.get(salonId) ?? 0) + 1);
  stopPresenceCycle(salonId); // §1.1: kill the presence timer for a deleted salon

  const instance = instances.get(salonId);
  instances.delete(salonId); // stop sends/receives immediately, pre-logout
  if (instance) {
    try {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        instance.disconnect(), // sock.logout() — releases the WA device link
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, DELETE_LOGOUT_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
    } catch (err) {
      console.warn(
        `[baileys] [${salonId}] logout during delete failed (ignored): ${(err as Error)?.message ?? String(err)}`,
      );
    }
  }

  // Remove the on-disk session dir so a stale session can't linger or re-auth.
  // force:true → no throw if the dir was never created (never-linked salon).
  try {
    rmSync(join(options.sessionsDir, salonId), {
      recursive: true,
      force: true,
    });
  } catch (err) {
    console.warn(
      `[baileys] [${salonId}] session dir cleanup failed (ignored): ${(err as Error)?.message ?? String(err)}`,
    );
  }
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
