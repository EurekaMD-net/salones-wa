/**
 * Centralized message templates.
 * All bot copy lives here — makes localization and A/B testing easy.
 */

import type { Appointment, Contact, Service } from "../db/models.js";

function formatDatetime(unixTs: number): string {
  return new Date(unixTs * 1000).toLocaleString("es-MX", {
    timeZone: "America/Mexico_City",
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const Messages = {
  // ─── Greeting / booking flow ───────────────────────────────────────────────
  greeting(): string {
    return "¡Hola! 👋 Soy el asistente del salón. ¿En qué te puedo ayudar?";
  },

  askService(services: Service[]): string {
    if (services.length === 0) {
      return "¿Para qué servicio quieres agendar tu cita? Escríbeme lo que necesitas 😊";
    }
    const list = services.map((s, i) => `${i + 1}️⃣ ${s.name}`).join("\n");
    return `¿Qué servicio necesitas?\n${list}\n\nResponde con el número o el nombre del servicio.`;
  },

  askDate(): string {
    return "¿Para cuándo te gustaría la cita? Dime el día que prefieres 📅";
  },

  offerSlots(slots: string[]): string {
    if (slots.length === 0) {
      return "En este momento no tenemos lugares disponibles para esa fecha. ¿Te parece si te busco para otra fecha?";
    }
    const list = slots.map((s, i) => `${i + 1}️⃣ ${s}`).join("\n");
    return `Tenemos disponible:\n${list}\n\nResponde con el número para apartar tu lugar ✅`;
  },

  appointmentConfirmed(appt: Appointment, service?: Service): string {
    const when = formatDatetime(appt.starts_at);
    const svc = service ? ` para ${service.name}` : "";
    return `✅ ¡Listo! Tu cita es el ${when}${svc}.\nTe recordaré 24h antes. ¡Hasta entonces! 💇‍♀️`;
  },

  // ─── Reminder / anti-cancel ────────────────────────────────────────────────
  reminder24h(contact: Contact, appt: Appointment, service?: Service): string {
    const name = contact.name ? ` ${contact.name}` : "";
    const when = formatDatetime(appt.starts_at);
    const svc = service ? ` para ${service.name}` : "";
    return `Hola${name} 😊 Te recuerdo que mañana tienes cita a las ${when}${svc}.\n¿Confirmas que vienes? Responde *SÍ* o *CANCELAR*`;
  },

  reminder2h(contact: Contact, appt: Appointment, service?: Service): string {
    const name = contact.name ? ` ${contact.name}` : "";
    const when = formatDatetime(appt.starts_at);
    const svc = service ? ` para ${service.name}` : "";
    return `Recordatorio rápido${name} ⏰: tu cita es hoy${svc} a las ${when}.\n¿Sigues viniendo? Cualquier cambio de último minuto, avísanos 🙏`;
  },

  // ─── Confirmation response ─────────────────────────────────────────────────
  appointmentConfirmedByClient(): string {
    return "Perfecto, ahí te esperamos 💕";
  },

  // ─── Cancel flow ──────────────────────────────────────────────────────────
  askConfirmCancel(appt: Appointment, service?: Service): string {
    const when = formatDatetime(appt.starts_at);
    const svc = service ? ` (${service.name})` : "";
    return `Tienes agendado: ${when}${svc}.\n¿Confirmas la cancelación? Responde *SÍ* para cancelar.`;
  },

  appointmentCancelled(): string {
    return "✅ Cancelada. ¡Cuando quieras agendar de nuevo, escríbenos! 😊";
  },

  noAppointmentToCancel(): string {
    return "No encontré una cita activa tuya. ¿Quieres agendar una? 😊";
  },

  // ─── Reschedule flow ──────────────────────────────────────────────────────
  offerReschedule(
    oldAppt: Appointment,
    slots: string[],
    service?: Service,
  ): string {
    const oldWhen = formatDatetime(oldAppt.starts_at);
    const svc = service ? ` (${service.name})` : "";
    if (slots.length === 0) {
      return `Tu cita actual es el ${oldWhen}${svc}. En este momento no tenemos otros lugares disponibles. ¿La dejamos como está?`;
    }
    const list = slots.map((s, i) => `${i + 1}️⃣ ${s}`).join("\n");
    return `Tu cita actual es el ${oldWhen}${svc}.\n¿Para cuándo la quieres mover?\n${list}\n\nResponde con el número. La cita anterior queda cancelada al confirmar la nueva.`;
  },

  appointmentRescheduled(
    newAppt: Appointment,
    oldStartsAt: number | null,
    service?: Service,
  ): string {
    const newWhen = formatDatetime(newAppt.starts_at);
    const svc = service ? ` (${service.name})` : "";
    // Audit W2: skip the dated "anterior (...)" clause when the old appt
    // is missing (cancelled out-of-band). Previously null fell through to
    // formatDatetime(0) and rendered the Unix epoch in MX time.
    const oldClause = oldStartsAt
      ? `\nLa anterior (${formatDatetime(oldStartsAt)}) queda cancelada.`
      : "\nLa anterior queda cancelada.";
    return `✅ Listo! Tu cita${svc} quedó el ${newWhen}.${oldClause} Te recordaré 24h antes 💇‍♀️`;
  },

  // ─── Query ────────────────────────────────────────────────────────────────
  nextAppointment(appt: Appointment, service?: Service): string {
    const when = formatDatetime(appt.starts_at);
    const svc = service ? ` (${service.name})` : "";
    return `Tu próxima cita es el ${when}${svc}. ¿Necesitas cambiarla?`;
  },

  noUpcomingAppointment(): string {
    return "No tienes citas próximas agendadas. ¿Quieres apartar una? 💇‍♀️";
  },

  // ─── Reactivation outbound ────────────────────────────────────────────────
  reactivationOutbound(contact: Contact): string {
    const name = contact.name ? ` ${contact.name}` : "";
    return `Hola${name} 👋 Hace un tiempo que no te vemos por el salón. ¿Cómo estás?\nEsta semana tenemos lugares disponibles — ¿te agendo algo? Solo dime qué necesitas 💇‍♀️`;
  },

  reactivationNo(): string {
    return "¡Perfecto, cuando gustes! Aquí estaremos 😊";
  },

  // ─── Opt-out ──────────────────────────────────────────────────────────────
  optOutConfirmed(): string {
    return "Listo, te damos de baja de los recordatorios. ¡Cuando quieras reagendarte, escríbenos! 👍";
  },

  // ─── Fallback ─────────────────────────────────────────────────────────────
  fallback(): string {
    return "¿En qué te puedo ayudar? Puedo:\n✅ Agendar una cita\n📋 Decirte cuándo es tu próxima cita\n🔄 Cambiar tu cita\n❌ Cancelar tu cita";
  },

  // ─── Slot prompt (shared by BOOK and RESCHEDULE) — audit S1 fold ─────────
  askSlotNumber(max: number): string {
    return `Por favor responde con un número del 1 al ${max}.`;
  },

  // ─── Abandonment during slot selection — audit W3 fold ───────────────────
  flowAbandoned(): string {
    return "Está bien, dejamos tu cita como estaba 👍. Cuando quieras, escríbeme.";
  },
};
