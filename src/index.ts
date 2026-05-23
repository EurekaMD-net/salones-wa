/**
 * salones-wa — WA automation bot for salones de belleza
 * Entry point: initializes DB, Baileys, crons, web panel
 */

import { serve } from '@hono/node-server'
import { getDb } from './db/database.js'
import { getAllActiveSalons } from './db/models.js'
import { createWebPanel } from './web/panel.js'
import { registerCrons } from './crons/index.js'
import { initBaileysForSalon, getInstance } from './bot/baileys-manager.js'

const PORT = parseInt(process.env['PORT'] ?? '8085')
const SESSIONS_DIR = process.env['SESSIONS_DIR'] ?? './data/sessions'
const DB_PATH = process.env['DB_PATH'] ?? './data/salones.db'

async function main() {
  console.log('[salones-wa] starting...')

  // ─── Database ────────────────────────────────────────────────────────
  const db = getDb(DB_PATH)
  console.log('[salones-wa] DB ready')

  // ─── Web panel (Hono) ────────────────────────────────────────────────
  const app = createWebPanel(db)
  serve({ fetch: app.fetch, port: PORT }, () => {
    console.log(`[salones-wa] web panel listening on :${PORT}`)
  })

  // ─── Crons ───────────────────────────────────────────────────────────
  const sendMessageAdapter = async (salonPhone: string, toPhone: string, text: string) => {
    // Find salon by phone and get its instance
    const salon = db.prepare('SELECT * FROM salons WHERE phone = ? AND active = 1').get(salonPhone) as { id: string } | undefined
    if (!salon) return

    const instance = getInstance(salon.id)
    if (!instance) {
      console.warn(`[salones-wa] no Baileys instance for salon ${salon.id}`)
      return
    }
    await instance.sendMessage(toPhone, text)
  }

  const jobs = registerCrons(db, sendMessageAdapter)
  console.log(`[salones-wa] ${jobs.length} cron jobs registered: ${jobs.map(j => j.name).join(', ')}`)

  // ─── Baileys instances (one per active salon) ────────────────────────
  const salons = getAllActiveSalons(db)
  if (salons.length === 0) {
    console.log('[salones-wa] no active salons configured. Add one via onboarding script.')
  }

  for (const salon of salons) {
    await initBaileysForSalon(
      {
        sessionsDir: SESSIONS_DIR,
        db,
        onQR: (salonId, qr) => {
          console.log(`[salones-wa] QR for salon ${salonId} — scan with WA`)
          // qrcode-terminal would render here in production
        },
      },
      salon.id,
      salon.phone
    )
  }

  console.log('[salones-wa] ready ✅')

  // ─── Graceful shutdown ───────────────────────────────────────────────
  process.on('SIGTERM', () => {
    console.log('[salones-wa] shutting down...')
    db.close()
    process.exit(0)
  })
}

main().catch(err => {
  console.error('[salones-wa] fatal startup error:', err)
  process.exit(1)
})
