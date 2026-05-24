/**
 * Baileys connection manager.
 * One Baileys instance per salon — manages reconnection, QR display, session persistence.
 *
 * NOTE: Actual WA connection requires a real phone number.
 * In dev/test mode (SALONES_ENV=test), this module is a no-op stub.
 */

import { mkdirSync } from "fs";
import { join } from "path";
import type Database from "better-sqlite3";
import { getSalonByPhone, upsertContact } from "../db/models.js";
import { handleInboundMessage } from "./message-handler.js";

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
    return instance;
  }

  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
  } = await import("@whiskeysockets/baileys");
  const { Boom } = await import("@hapi/boom");

  const sessionDir = join(options.sessionsDir, salonId);
  mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    // W2 (audit 2026-05-24): false because we render our own QR via qrcode-terminal
    // in the onQR callback AND prefer pairing-code linking. Leaving it true caused
    // a deprecation warning + raced with our own renderer.
    printQRInTerminal: false,
    browser: ["SalonesWA", "Chrome", "1.0"],
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

  // W1 (audit 2026-05-24): pairing-code request must wait for the WA server
  // to finish the noise-protocol handshake before sendNode is safe. The
  // FIRST `qr` emit is the right signal — earlier triggers (e.g.
  // `connection === "connecting"`) fail with "Connection Closed /
  // Precondition Required" because the WS isn't ready for iq nodes.
  // Pin the callback locally (W3) so a later options mutation can't trip
  // the non-null assertion at .then time.
  // The pairing code expires ~60s WA-side; in production observation WA's
  // QR event also fires every ~60s, not the ~20s the Baileys docs suggest.
  // To avoid windowing where a code is already expired by the time the
  // operator reads it, refresh on EVERY QR emit. `pairingRequestInFlight`
  // prevents concurrent requests racing each other (Baileys API + network
  // round-trip is non-zero).
  let pairingRequestInFlight = false;
  const onPairingCodeCb = options.onPairingCode;

  sock.ev.on("connection.update", (update) => {
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
      pairingRequestInFlight = true;
      sock
        .requestPairingCode(salonPhone)
        .then((code) => onPairingCodeCb(salonId, code))
        .catch((err) =>
          console.error(
            `[baileys] [${salonPhone}] pairing-code request failed:`,
            err,
          ),
        )
        .finally(() => {
          pairingRequestInFlight = false;
        });
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as InstanceType<typeof Boom>)
        ?.output?.statusCode;
      const reason = lastDisconnect?.error?.message ?? "unknown";
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        console.log(
          `[baileys] [${salonPhone}] reconnecting (code=${statusCode ?? "?"}, reason=${reason})...`,
        );
        setTimeout(
          () => initBaileysForSalon(options, salonId, salonPhone),
          5000,
        );
      } else {
        console.log(
          `[baileys] [${salonPhone}] logged out — manual re-link required`,
        );
        instances.delete(salonId);
      }
    }

    if (connection === "open") {
      console.log(`[baileys] [${salonPhone}] connected ✅`);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const from = msg.key.remoteJid;
      if (!from) continue;

      const phone = from.replace("@s.whatsapp.net", "").replace("@g.us", "");
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

  instances.set(salonId, instance);
  return instance;
}

export function getInstance(salonId: string): BaileysInstance | undefined {
  return instances.get(salonId);
}

export function getAllInstances(): BaileysInstance[] {
  return [...instances.values()];
}
