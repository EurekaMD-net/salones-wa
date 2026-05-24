/**
 * Core message handler — receives inbound WA messages,
 * runs intent parser, manages conversation state, produces reply text.
 *
 * Decoupled from Baileys transport: takes plain strings, returns strings.
 * This makes it fully unit-testable without WA connection.
 */

import type Database from "better-sqlite3";
import { parseIntent } from "./intent-parser.js";
import { conversationState } from "./conversation-state.js";
import { Messages } from "./messages.js";
import {
  upsertContact,
  getServices,
  createAppointment,
  cancelAppointment,
  getNextAppointmentForContact,
  getAppointmentById,
  markContactOptOut,
  markCampaignResponded,
  markCampaignBooked,
} from "../db/models.js";
import { findAvailableSlots } from "./slot-finder.js";

const DEFAULT_SLOT_DURATION_MIN = 60;

export interface HandleResult {
  reply: string | null; // null = no reply needed
}

export async function handleInboundMessage(
  db: Database.Database,
  salon_id: string,
  fromPhone: string,
  text: string,
): Promise<HandleResult> {
  const contact = upsertContact(db, { salon_id, phone: fromPhone });

  // Skip opted-out contacts
  if (contact.opt_out) return { reply: null };

  // Get current conversation state
  const state = conversationState.get(salon_id, fromPhone);
  const context =
    state?.step === "reactivation_sent" ? "reactivation" : undefined;

  const intent = parseIntent(text, context);

  // ─── Opt-out ────────────────────────────────────────────────────────────
  if (intent.type === "opt_out") {
    markContactOptOut(db, contact.id);
    conversationState.clear(salon_id, fromPhone);
    return { reply: Messages.optOutConfirmed() };
  }

  // ─── Pending cancel confirm ───────────────────────────────────────────
  if (state?.step === "awaiting_cancel_confirm") {
    if (intent.type === "confirm") {
      cancelAppointment(db, state.pending_cancel_id!);
      conversationState.clear(salon_id, fromPhone);
      return { reply: Messages.appointmentCancelled() };
    } else {
      conversationState.clear(salon_id, fromPhone);
      return { reply: Messages.fallback() };
    }
  }

  // Detect user abandonment during a slot-selection state. Audit W3 — the
  // previous "responde con un número" loop kept the user stuck for 30 min
  // when they replied with a non-number like "mejor lo dejo así".
  // Considers cancel intent OR text containing common abandonment phrasings.
  const isSlotState =
    state?.step === "awaiting_slot_selection" ||
    state?.step === "awaiting_reschedule_slot_selection";
  if (isSlotState) {
    const lower = text.trim().toLowerCase();
    const abandonmentHints =
      /\b(no gracias|olvidalo|olvídalo|olvidar|dejalo|déjalo|d[eé]jalo|lo dejo|mejor no|mejor lo dejo|cancela|cancelar|cambio de opinion|cambio de opini[oó]n)\b/i;
    if (intent.type === "cancel" || abandonmentHints.test(lower)) {
      conversationState.clear(salon_id, fromPhone);
      return { reply: Messages.flowAbandoned() };
    }
  }

  // ─── Pending slot selection ───────────────────────────────────────────
  if (state?.step === "awaiting_slot_selection") {
    const slotNumber = parseInt(text.trim());
    const slots = state.pending_slots ?? [];

    if (!isNaN(slotNumber) && slotNumber >= 1 && slotNumber <= slots.length) {
      const slot = slots[slotNumber - 1];
      const appt = createAppointment(db, {
        salon_id,
        contact_id: contact.id,
        service_id: state.pending_service_id,
        starts_at: slot.starts_at,
        ends_at: slot.ends_at,
      });

      const services = getServices(db, salon_id);
      const service = services.find((s) => s.id === state.pending_service_id);

      // If came from reactivation, mark it booked
      if (state.campaign_id) {
        markCampaignBooked(db, state.campaign_id);
      }

      conversationState.clear(salon_id, fromPhone);
      return { reply: Messages.appointmentConfirmed(appt, service) };
    } else {
      return { reply: Messages.askSlotNumber(slots.length) };
    }
  }

  // ─── Pending reschedule slot selection ────────────────────────────────
  // Same shape as awaiting_slot_selection, but on confirm we ALSO cancel
  // the prior appointment. Wrapped in a db.transaction (audit C1) so a
  // failure in cancel doesn't leave the user with two active appointments.
  if (state?.step === "awaiting_reschedule_slot_selection") {
    const slotNumber = parseInt(text.trim());
    const slots = state.pending_slots ?? [];
    const oldId = state.pending_reschedule_old_id;

    if (
      !isNaN(slotNumber) &&
      slotNumber >= 1 &&
      slotNumber <= slots.length &&
      oldId
    ) {
      const slot = slots[slotNumber - 1];
      // Fetch old appointment by id (audit W1) — not by getNextAppointmentForContact,
      // which is racy if the user booked another appointment between offer and pick.
      // W2: guard against null (e.g. cancelled out-of-band between offer and pick).
      const old = getAppointmentById(db, oldId);

      // Atomic cancel-old + create-new (audit C1). If either fails the
      // transaction rolls back; user ends up unchanged rather than with two
      // active appointments (silent double-booking) or zero (recoverable).
      const tx = db.transaction(() => {
        cancelAppointment(db, oldId);
        return createAppointment(db, {
          salon_id,
          contact_id: contact.id,
          // W4: preserve NULL service_id from original — don't silently bind to
          // services[0] which would "rewrite history" by claiming a service the
          // user never picked.
          service_id: state.pending_service_id,
          starts_at: slot.starts_at,
          ends_at: slot.ends_at,
        });
      });
      const appt = tx();

      const services = getServices(db, salon_id);
      const service = state.pending_service_id
        ? services.find((s) => s.id === state.pending_service_id)
        : undefined;

      conversationState.clear(salon_id, fromPhone);
      return {
        reply: Messages.appointmentRescheduled(
          appt,
          old?.starts_at ?? null,
          service,
        ),
      };
    } else {
      return { reply: Messages.askSlotNumber(slots.length) };
    }
  }

  // ─── Reactivation yes/no ──────────────────────────────────────────────
  if (state?.step === "reactivation_sent") {
    if (intent.type === "reactivation_yes" || intent.type === "book") {
      if (state.campaign_id) {
        markCampaignResponded(db, state.campaign_id);
      }
      // Fall through to booking flow below
    } else if (intent.type === "reactivation_no") {
      conversationState.clear(salon_id, fromPhone);
      return { reply: Messages.reactivationNo() };
    }
  }

  // ─── Cancel ───────────────────────────────────────────────────────────
  if (intent.type === "cancel") {
    const next = getNextAppointmentForContact(db, contact.id);
    if (!next) {
      return { reply: Messages.noAppointmentToCancel() };
    }
    const services = getServices(db, salon_id);
    const service = next.service_id
      ? services.find((s) => s.id === next.service_id)
      : undefined;
    conversationState.set(
      {
        step: "awaiting_cancel_confirm",
        salon_id,
        contact_id: contact.id,
        pending_cancel_id: next.id,
        updated_at: Date.now(),
      },
      fromPhone,
    );
    return { reply: Messages.askConfirmCancel(next, service) };
  }

  // ─── Reschedule ───────────────────────────────────────────────────────
  // Looks up the contact's next active appointment, offers fresh slots,
  // stores the old appointment id so the slot-selection branch can
  // atomically cancel-and-recreate when the user picks a new time.
  // Preserves the same service from the original appointment (MVP scope).
  if (intent.type === "reschedule") {
    const next = getNextAppointmentForContact(db, contact.id);
    if (!next) {
      return { reply: Messages.noUpcomingAppointment() };
    }
    const services = getServices(db, salon_id);
    const service = next.service_id
      ? services.find((s) => s.id === next.service_id)
      : undefined;
    // Slot duration inherits from the original appointment's service when
    // present; falls back to the default if the appointment had no service
    // (legacy / orphaned rows). Reschedule preserves the original
    // service_id (audit W4) so the new appointment doesn't silently shift
    // to a different service.
    const durationMin = service?.duration_min ?? DEFAULT_SLOT_DURATION_MIN;
    const slots = findAvailableSlots(db, salon_id, durationMin);
    if (slots.length === 0) {
      return {
        reply: Messages.offerReschedule(next, [], service),
      };
    }
    conversationState.set(
      {
        step: "awaiting_reschedule_slot_selection",
        salon_id,
        contact_id: contact.id,
        pending_service_id: next.service_id ?? undefined,
        pending_slots: slots,
        pending_reschedule_old_id: next.id,
        updated_at: Date.now(),
      },
      fromPhone,
    );
    return {
      reply: Messages.offerReschedule(
        next,
        slots.map((s: { label: string }) => s.label),
        service,
      ),
    };
  }

  // ─── Confirm (standalone, e.g. after reminder) ───────────────────────
  if (intent.type === "confirm") {
    conversationState.clear(salon_id, fromPhone);
    return { reply: Messages.appointmentConfirmedByClient() };
  }

  // ─── Query ────────────────────────────────────────────────────────────
  if (intent.type === "query_appointment") {
    const next = getNextAppointmentForContact(db, contact.id);
    if (!next) {
      return { reply: Messages.noUpcomingAppointment() };
    }
    const services = getServices(db, salon_id);
    const service = next.service_id
      ? services.find((s) => s.id === next.service_id)
      : undefined;
    return { reply: Messages.nextAppointment(next, service) };
  }

  // ─── Book ─────────────────────────────────────────────────────────────
  if (intent.type === "book" || intent.type === "reactivation_yes") {
    const services = getServices(db, salon_id);
    // MVP picks the first service (services[0]); service_id-specific picking
    // is a follow-up. Slot duration uses that service's duration.
    const pickedService = services[0];
    const durationMin =
      pickedService?.duration_min ?? DEFAULT_SLOT_DURATION_MIN;
    const slots = findAvailableSlots(db, salon_id, durationMin);

    if (slots.length === 0) {
      return { reply: Messages.offerSlots([]) };
    }

    conversationState.set(
      {
        step: "awaiting_slot_selection",
        salon_id,
        contact_id: contact.id,
        pending_service_id: pickedService?.id,
        pending_slots: slots,
        campaign_id: state?.campaign_id,
        updated_at: Date.now(),
      },
      fromPhone,
    );

    return {
      reply: Messages.offerSlots(slots.map((s: { label: string }) => s.label)),
    };
  }

  // ─── Unknown ──────────────────────────────────────────────────────────
  return { reply: Messages.fallback() };
}
