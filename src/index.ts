/**
 * salones-wa — WA automation bot for salones de belleza
 * Entry point: initializes DB, Baileys, crons, web panel
 */

import { serve } from '@hono/node-server'
import { getDb } from './db/database.js'
import { getAllActiveSalons } from './db/models.js'
import { createWebPanel } from './web/panel.js'
import { createAdminPanel } from './web/admin.js'
import { registerCrons } from './crons/index.js'
import { initBaileysForSalon, getInstance } from './bot/baileys-manager.js'
import qrcodeTerminal from 'qrcode-terminal'

const PORT = parseInt(process.env['PORT'] ?? '8085')
const SESSIONS_DIR = process.env['SESSIONS_DIR'] ?? './data/sessions'
const DB_PATH = process.env['DB_PATH'] ?? './data/salones.db'

// P0-1: Hard-fail at startup if ADMIN_TOKEN is missing or too short
const ADMIN_TOKEN = process.env['ADMIN_TOKEN']
if (!ADMIN_TOKEN || ADMIN_TOKEN.length < 16) {
  console.error('[salones-wa] FATAL: ADMIN_TOKEN env var must be set and at least 16 chars long.')
  console.error('[salones-wa] Generate one with: node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'hex\'))"')
  process.exit(1)
}

async function main() {
  console.log('[salones-wa] starting...')

  // ─── Database ────────────────────────────────────────────────────────
  const db = getDb(DB_PATH)
  console.log('[salones-wa] DB ready')

  // ─── Web panel + Admin (Hono) ────────────────────────────────────────
  // Bind: 0.0.0.0 for direct public access during pre-production testing.
  // TODO (C1): switch to '127.0.0.1' + Caddy reverse-proxy before go-live.
  const app = createWebPanel(db)
  const adminApp = createAdminPanel(db)
  app.route('/', adminApp)
  const bindHost = process.env['BIND_HOST'] ?? '0.0.0.0'
  serve({ fetch: app.fetch, port: PORT, hostname: bindHost }, () => {
    console.log(`[salones-wa] web panel listening on ${bindHost}:${PORT}`)
    // R3: Never log the token value — just confirm it's set
    console.log(`[salones-wa] admin panel at /admin?token=<set, ${ADMIN_TOKEN!.length} chars>`)
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
          console.log(`[salones-wa] QR for salon ${salonId} — scan with WhatsApp:`)
          // W8: Actually render the QR code in the terminal
          qrcodeTerminal.generate(qr, { small: true })
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
