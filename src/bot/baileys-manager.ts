/**
 * Baileys connection manager.
 * One Baileys instance per salon — manages reconnection, QR display, session persistence.
 *
 * NOTE: Actual WA connection requires a real phone number.
 * In dev/test mode (SALONES_ENV=test), this module is a no-op stub.
 */

import { mkdirSync } from 'fs'
import { join } from 'path'
import type Database from 'better-sqlite3'
import { getSalonByPhone, upsertContact } from '../db/models.js'
import { handleInboundMessage } from './message-handler.js'

export interface BaileysInstance {
  salonId: string
  salonPhone: string
  sendMessage: (toPhone: string, text: string) => Promise<void>
  disconnect: () => Promise<void>
}

export interface BaileysManagerOptions {
  sessionsDir: string
  db: Database.Database
  onQR?: (salonId: string, qr: string) => void
}

const instances = new Map<string, BaileysInstance>()

/** Stub sendMessage for test environment */
function createStubInstance(salonId: string, salonPhone: string): BaileysInstance {
  return {
    salonId,
    salonPhone,
    sendMessage: async (toPhone: string, text: string) => {
      console.log(`[baileys-stub] [${salonPhone}] → ${toPhone}: ${text.slice(0, 80)}`)
    },
    disconnect: async () => {
      instances.delete(salonId)
    },
  }
}

/**
 * Initialize a Baileys connection for a salon.
 * Returns immediately in test mode.
 */
export async function initBaileysForSalon(
  options: BaileysManagerOptions,
  salonId: string,
  salonPhone: string
): Promise<BaileysInstance> {
  if (instances.has(salonId)) return instances.get(salonId)!

  const isTest = process.env['SALONES_ENV'] === 'test'

  if (isTest) {
    const instance = createStubInstance(salonId, salonPhone)
    instances.set(salonId, instance)
    return instance
  }

  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = await import('@whiskeysockets/baileys')
  const { Boom } = await import('@hapi/boom')

  const sessionDir = join(options.sessionsDir, salonId)
  mkdirSync(sessionDir, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    browser: ['SalonesWA', 'Chrome', '1.0'],
    // Minimize logging noise
    logger: {
      level: 'silent',
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: (msg: unknown) => console.warn('[baileys]', msg),
      error: (msg: unknown) => console.error('[baileys]', msg),
      child: () => ({ level: 'silent', trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => ({}) } as never),
    } as never,
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr && options.onQR) {
      options.onQR(salonId, qr)
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error as InstanceType<typeof Boom>)?.output?.statusCode !== DisconnectReason.loggedOut
      if (shouldReconnect) {
        console.log(`[baileys] [${salonPhone}] reconnecting...`)
        setTimeout(() => initBaileysForSalon(options, salonId, salonPhone), 5000)
      } else {
        console.log(`[baileys] [${salonPhone}] logged out — manual QR scan required`)
        instances.delete(salonId)
      }
    }

    if (connection === 'open') {
      console.log(`[baileys] [${salonPhone}] connected ✅`)
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    for (const msg of messages) {
      if (msg.key.fromMe) continue
      const from = msg.key.remoteJid
      if (!from) continue

      const phone = from.replace('@s.whatsapp.net', '').replace('@g.us', '')
      const text = msg.message?.conversation
        ?? msg.message?.extendedTextMessage?.text
        ?? ''
      if (!text) continue

      const salon = getSalonByPhone(options.db, salonPhone)
      if (!salon) continue

      upsertContact(options.db, { salon_id: salon.id, phone })

      try {
        const result = await handleInboundMessage(options.db, salon.id, phone, text)
        if (result.reply) {
          await sock.sendMessage(from, { text: result.reply })
        }
      } catch (err) {
        console.error('[baileys] message handler error', err)
      }
    }
  })

  const instance: BaileysInstance = {
    salonId,
    salonPhone,
    sendMessage: async (toPhone: string, text: string) => {
      await sock.sendMessage(`${toPhone}@s.whatsapp.net`, { text })
    },
    disconnect: async () => {
      await sock.logout()
      instances.delete(salonId)
    },
  }

  instances.set(salonId, instance)
  return instance
}

export function getInstance(salonId: string): BaileysInstance | undefined {
  return instances.get(salonId)
}

export function getAllInstances(): BaileysInstance[] {
  return [...instances.values()]
}
