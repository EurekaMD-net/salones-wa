/**
 * Cron job registry.
 * All scheduled tasks for the salones-wa system.
 */

import cron from 'node-cron'
import type Database from 'better-sqlite3'
import {
  getUpcomingAppointmentsFor24h,
  getUpcomingAppointmentsFor2h,
  markReminded24h,
  markReminded2h,
  completePassedAppointments,
  updateDormantFlags,
  getDormantContacts,
  createCampaign,
  hasRecentCampaign,
  getServices,
} from '../db/models.js'
import { conversationState } from '../bot/conversation-state.js'

export type SendMessageFn = (salonPhone: string, toPhone: string, text: string) => Promise<void>

export interface RegisteredJob {
  name: string
  schedule: string
}

/**
 * Register all cron jobs.
 * @param db SQLite database instance
 * @param sendMessage Async function that sends a WA message
 * @returns List of registered job descriptors
 */
export function registerCrons(db: Database.Database, sendMessage: SendMessageFn): RegisteredJob[] {
  const jobs: RegisteredJob[] = []

  // ─── remind-24h: every hour at :05 ───────────────────────────────────
  cron.schedule('5 * * * *', async () => {
    const appointments = getUpcomingAppointmentsFor24h(db)
    for (const appt of appointments) {
      try {
        const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(appt.contact_id) as {
          id: string; phone: string; name: string | null; opt_out: number; salon_id: string;
          visit_count: number; dormant: number; last_visit: number | null; created_at: number
        }
        if (!contact || contact.opt_out) continue

        const salon = db.prepare('SELECT * FROM salons WHERE id = ?').get(appt.salon_id) as { phone: string } | undefined
        if (!salon) continue

        const services = getServices(db, appt.salon_id)
        const service = appt.service_id ? services.find(s => s.id === appt.service_id) : undefined

        const { Messages } = await import('../bot/messages.js')
        const text = Messages.reminder24h(contact, appt, service)

        await sendMessage(salon.phone, contact.phone, text)
        markReminded24h(db, appt.id)
      } catch (err) {
        console.error('[remind-24h] error for appt', appt.id, err)
      }
    }
  })
  jobs.push({ name: 'remind-24h', schedule: '5 * * * *' })

  // ─── remind-2h: every 30 min ──────────────────────────────────────────
  cron.schedule('*/30 * * * *', async () => {
    const appointments = getUpcomingAppointmentsFor2h(db)
    for (const appt of appointments) {
      try {
        const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(appt.contact_id) as {
          id: string; phone: string; name: string | null; opt_out: number; salon_id: string;
          visit_count: number; dormant: number; last_visit: number | null; created_at: number
        }
        if (!contact || contact.opt_out) continue

        const salon = db.prepare('SELECT * FROM salons WHERE id = ?').get(appt.salon_id) as { phone: string } | undefined
        if (!salon) continue

        const services = getServices(db, appt.salon_id)
        const service = appt.service_id ? services.find(s => s.id === appt.service_id) : undefined

        const { Messages } = await import('../bot/messages.js')
        const text = Messages.reminder2h(contact, appt, service)

        await sendMessage(salon.phone, contact.phone, text)
        markReminded2h(db, appt.id)
      } catch (err) {
        console.error('[remind-2h] error for appt', appt.id, err)
      }
    }
  })
  jobs.push({ name: 'remind-2h', schedule: '*/30 * * * *' })

  // ─── mark-completed: every hour at :10 ───────────────────────────────
  cron.schedule('10 * * * *', () => {
    try {
      const count = completePassedAppointments(db)
      if (count > 0) console.log(`[mark-completed] ${count} appointments completed`)
    } catch (err) {
      console.error('[mark-completed] error', err)
    }
  })
  jobs.push({ name: 'mark-completed', schedule: '10 * * * *' })

  // ─── update-dormant: daily at 00:15 ──────────────────────────────────
  cron.schedule('15 0 * * *', () => {
    try {
      const count = updateDormantFlags(db)
      console.log(`[update-dormant] ${count} contacts updated`)
    } catch (err) {
      console.error('[update-dormant] error', err)
    }
  })
  jobs.push({ name: 'update-dormant', schedule: '15 0 * * *' })

  // ─── reactivation-campaign: Mondays at 10:00 ─────────────────────────
  cron.schedule('0 10 * * 1', async () => {
    try {
      const salons = db.prepare('SELECT * FROM salons WHERE active = 1').all() as Array<{ id: string; phone: string }>
      const RATE_LIMIT = 20
      let sent = 0

      for (const salon of salons) {
        const dormants = getDormantContacts(db, salon.id)

        for (const contact of dormants) {
          if (sent >= RATE_LIMIT) {
            console.log('[reactivation] rate limit reached, stopping for this run')
            break
          }

          if (hasRecentCampaign(db, contact.id, 30)) continue

          const campaign = createCampaign(db, {
            salon_id: salon.id,
            contact_id: contact.id,
            type: 'reactivation',
          })

          const { Messages } = await import('../bot/messages.js')
          const text = Messages.reactivationOutbound(contact)

          await sendMessage(salon.phone, contact.phone, text)

          // Set conversation state so inbound reply is handled correctly
          conversationState.set({
            step: 'reactivation_sent',
            salon_id: salon.id,
            contact_id: contact.id,
            campaign_id: campaign.id,
            updated_at: Date.now(),
          }, contact.phone)

          sent++
          // Small delay between messages (anti-ban)
          await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000))
        }
      }
      console.log(`[reactivation-campaign] sent ${sent} messages`)
    } catch (err) {
      console.error('[reactivation-campaign] error', err)
    }
  })
  jobs.push({ name: 'reactivation-campaign', schedule: '0 10 * * 1' })

  // ─── state-eviction: every 30 min ────────────────────────────────────
  cron.schedule('*/30 * * * *', () => {
    const evicted = conversationState.evictExpired()
    if (evicted > 0) console.log(`[state-eviction] evicted ${evicted} stale conversation states`)
  })
  jobs.push({ name: 'state-eviction', schedule: '*/30 * * * *' })

  return jobs
}
