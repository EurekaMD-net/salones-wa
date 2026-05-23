import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initDb, resetDbSingleton } from '../src/db/database.js'
import { createSalon, addService, upsertContact, createAppointment } from '../src/db/models.js'
import { handleInboundMessage } from '../src/bot/message-handler.js'
import { conversationState } from '../src/bot/conversation-state.js'
import type Database from 'better-sqlite3'

let db: Database.Database
let salonId: string

function now() { return Math.floor(Date.now() / 1000) }
function hoursFromNow(h: number) { return now() + h * 3600 }

beforeEach(() => {
  db = initDb(':memory:')
  const salon = createSalon(db, { name: 'Test Salon', phone: '+5255000001' })
  salonId = salon.id
  addService(db, { salon_id: salonId, name: 'Corte', duration_min: 45, price: 150 })
})

afterEach(() => {
  resetDbSingleton()
  vi.restoreAllMocks()
})

const PHONE = '+5255100001'

async function send(text: string) {
  return handleInboundMessage(db, salonId, PHONE, text)
}

describe('handleInboundMessage', () => {
  describe('booking flow', () => {
    it('replies with slot offer on booking intent', async () => {
      const result = await send('quiero cita para corte')
      expect(result.reply).not.toBeNull()
      expect(result.reply).toContain('1️⃣')
    })

    it('books appointment on slot selection', async () => {
      await send('quiero cita')
      const result = await send('1')
      expect(result.reply).toContain('✅')
    })

    it('rejects invalid slot number', async () => {
      await send('quiero cita')
      const result = await send('9')
      expect(result.reply).toContain('número del 1 al')
    })

    it('creates contact in DB on first message', async () => {
      await send('quiero cita')
      const contact = db.prepare('SELECT * FROM contacts WHERE phone = ?').get(PHONE)
      expect(contact).toBeTruthy()
    })
  })

  describe('cancel flow', () => {
    async function bookAppointment() {
      const contact = upsertContact(db, { salon_id: salonId, phone: PHONE })
      return createAppointment(db, {
        salon_id: salonId,
        contact_id: contact.id,
        starts_at: hoursFromNow(48),
        ends_at: hoursFromNow(49),
      })
    }

    it('asks confirm when user cancels and has appointment', async () => {
      await bookAppointment()
      const result = await send('quiero cancelar mi cita')
      expect(result.reply).toContain('Confirmas la cancelación')
    })

    it('confirms cancellation on SÍ', async () => {
      await bookAppointment()
      await send('cancelar')
      const result = await send('sí')
      expect(result.reply).toContain('Cancelada')
    })

    it('returns no-appointment message when no upcoming cita', async () => {
      const result = await send('quiero cancelar')
      expect(result.reply).toContain('No encontré')
    })
  })

  describe('query flow', () => {
    it('returns next appointment when exists', async () => {
      const contact = upsertContact(db, { salon_id: salonId, phone: PHONE })
      createAppointment(db, {
        salon_id: salonId,
        contact_id: contact.id,
        starts_at: hoursFromNow(48),
        ends_at: hoursFromNow(49),
      })
      const result = await send('cuándo es mi cita')
      expect(result.reply).toContain('próxima cita')
    })

    it('returns no upcoming message when no cita', async () => {
      const result = await send('cuándo tengo mi cita')
      expect(result.reply).toContain('No tienes citas próximas')
    })
  })

  describe('confirm flow', () => {
    it('replies confirmation received', async () => {
      const result = await send('confirmo')
      expect(result.reply).toContain('ahí te esperamos')
    })
  })

  describe('opt-out', () => {
    it('marks contact as opt_out and confirms', async () => {
      const result = await send('no me mandes más mensajes')
      expect(result.reply).toContain('damos de baja')
    })

    it('returns null reply for opted-out contact on subsequent message', async () => {
      await send('STOP')
      const result = await send('hola quiero cita')
      expect(result.reply).toBeNull()
    })
  })

  describe('fallback', () => {
    it('returns fallback for unknown messages', async () => {
      const result = await send('jaja que onda')
      expect(result.reply).toContain('Agendar')
    })
  })

  describe('reactivation context', () => {
    it('offers slots on reactivation_yes response', async () => {
      const contact = upsertContact(db, { salon_id: salonId, phone: PHONE })
      // Set up reactivation state
      conversationState.set({
        step: 'reactivation_sent',
        salon_id: salonId,
        contact_id: contact.id,
        campaign_id: 'fake-campaign-id',
        updated_at: Date.now(),
      }, PHONE)

      const result = await send('sí quiero')
      expect(result.reply).toContain('1️⃣')
    })

    it('says goodbye on reactivation_no', async () => {
      const contact = upsertContact(db, { salon_id: salonId, phone: PHONE })
      conversationState.set({
        step: 'reactivation_sent',
        salon_id: salonId,
        contact_id: contact.id,
        updated_at: Date.now(),
      }, PHONE)

      const result = await send('no gracias')
      expect(result.reply).toContain('cuando gustes')
    })
  })
})
