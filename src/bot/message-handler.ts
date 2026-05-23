/**
 * Core message handler — receives inbound WA messages,
 * runs intent parser, manages conversation state, produces reply text.
 *
 * Decoupled from Baileys transport: takes plain strings, returns strings.
 * This makes it fully unit-testable without WA connection.
 */

import type Database from 'better-sqlite3'
import { parseIntent } from './intent-parser.js'
import { conversationState } from './conversation-state.js'
import { Messages } from './messages.js'
import {
  upsertContact,
  getServices,
  createAppointment,
  cancelAppointment,
  getNextAppointmentForContact,
  markContactOptOut,
  markCampaignResponded,
  markCampaignBooked,
} from '../db/models.js'

/** Available slot generation — naive impl for MVP (real salons configure real slots) */
function generateDemoSlots(count = 3): Array<{ starts_at: number; ends_at: number; label: string }> {
  const slots = []
  const now = new Date()
  // Round up to next full hour
  const base = new Date(now)
  base.setMinutes(0, 0, 0)
  base.setHours(base.getHours() + 2) // start from 2h from now

  for (let i = 0; i < count; i++) {
    const start = new Date(base)
    start.setDate(start.getDate() + Math.floor(i / 2))
    start.setHours(i % 2 === 0 ? 10 : 14)
    const end = new Date(start)
    end.setHours(end.getHours() + 1)

    const label = start.toLocaleString('es-MX', {
      timeZone: 'America/Mexico_City',
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    })

    slots.push({
      starts_at: Math.floor(start.getTime() / 1000),
      ends_at: Math.floor(end.getTime() / 1000),
      label,
    })
  }
  return slots
}

export interface HandleResult {
  reply: string | null  // null = no reply needed
}

export async function handleInboundMessage(
  db: Database.Database,
  salon_id: string,
  fromPhone: string,
  text: string
): Promise<HandleResult> {
  const contact = upsertContact(db, { salon_id, phone: fromPhone })

  // Skip opted-out contacts
  if (contact.opt_out) return { reply: null }

  // Get current conversation state
  const state = conversationState.get(salon_id, fromPhone)
  const context = state?.step === 'reactivation_sent' ? 'reactivation' : undefined

  const intent = parseIntent(text, context)

  // ─── Opt-out ────────────────────────────────────────────────────────────
  if (intent.type === 'opt_out') {
    markContactOptOut(db, contact.id)
    conversationState.clear(salon_id, fromPhone)
    return { reply: Messages.optOutConfirmed() }
  }

  // ─── Pending cancel confirm ───────────────────────────────────────────
  if (state?.step === 'awaiting_cancel_confirm') {
    if (intent.type === 'confirm') {
      cancelAppointment(db, state.pending_cancel_id!)
      conversationState.clear(salon_id, fromPhone)
      return { reply: Messages.appointmentCancelled() }
    } else {
      conversationState.clear(salon_id, fromPhone)
      return { reply: Messages.fallback() }
    }
  }

  // ─── Pending slot selection ───────────────────────────────────────────
  if (state?.step === 'awaiting_slot_selection') {
    const slotNumber = parseInt(text.trim())
    const slots = state.pending_slots ?? []

    if (!isNaN(slotNumber) && slotNumber >= 1 && slotNumber <= slots.length) {
      const slot = slots[slotNumber - 1]
      const appt = createAppointment(db, {
        salon_id,
        contact_id: contact.id,
        service_id: state.pending_service_id,
        starts_at: slot.starts_at,
        ends_at: slot.ends_at,
      })

      const services = getServices(db, salon_id)
      const service = services.find(s => s.id === state.pending_service_id)

      // If came from reactivation, mark it booked
      if (state.campaign_id) {
        markCampaignBooked(db, state.campaign_id)
      }

      conversationState.clear(salon_id, fromPhone)
      return { reply: Messages.appointmentConfirmed(appt, service) }
    } else {
      return { reply: `Por favor responde con un número del 1 al ${slots.length}.` }
    }
  }

  // ─── Reactivation yes/no ──────────────────────────────────────────────
  if (state?.step === 'reactivation_sent') {
    if (intent.type === 'reactivation_yes' || intent.type === 'book') {
      if (state.campaign_id) {
        markCampaignResponded(db, state.campaign_id)
      }
      // Fall through to booking flow below
    } else if (intent.type === 'reactivation_no') {
      conversationState.clear(salon_id, fromPhone)
      return { reply: Messages.reactivationNo() }
    }
  }

  // ─── Cancel ───────────────────────────────────────────────────────────
  if (intent.type === 'cancel') {
    const next = getNextAppointmentForContact(db, contact.id)
    if (!next) {
      return { reply: Messages.noAppointmentToCancel() }
    }
    const services = getServices(db, salon_id)
    const service = next.service_id ? services.find(s => s.id === next.service_id) : undefined
    conversationState.set({
      step: 'awaiting_cancel_confirm',
      salon_id,
      contact_id: contact.id,
      pending_cancel_id: next.id,
      updated_at: Date.now(),
    }, fromPhone)
    return { reply: Messages.askConfirmCancel(next, service) }
  }

  // ─── Confirm (standalone, e.g. after reminder) ───────────────────────
  if (intent.type === 'confirm') {
    conversationState.clear(salon_id, fromPhone)
    return { reply: Messages.appointmentConfirmedByClient() }
  }

  // ─── Query ────────────────────────────────────────────────────────────
  if (intent.type === 'query_appointment') {
    const next = getNextAppointmentForContact(db, contact.id)
    if (!next) {
      return { reply: Messages.noUpcomingAppointment() }
    }
    const services = getServices(db, salon_id)
    const service = next.service_id ? services.find(s => s.id === next.service_id) : undefined
    return { reply: Messages.nextAppointment(next, service) }
  }

  // ─── Book ─────────────────────────────────────────────────────────────
  if (intent.type === 'book' || intent.type === 'reactivation_yes') {
    const services = getServices(db, salon_id)
    const slots = generateDemoSlots(3)

    conversationState.set({
      step: 'awaiting_slot_selection',
      salon_id,
      contact_id: contact.id,
      pending_service_id: services[0]?.id,
      pending_slots: slots,
      campaign_id: state?.campaign_id,
      updated_at: Date.now(),
    }, fromPhone)

    return { reply: Messages.offerSlots(slots.map(s => s.label)) }
  }

  // ─── Unknown ──────────────────────────────────────────────────────────
  return { reply: Messages.fallback() }
}
