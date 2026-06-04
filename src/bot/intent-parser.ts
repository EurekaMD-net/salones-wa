/**
 * Intent parser — regex-first, no LLM dependency for MVP
 * Classifies inbound WA messages into typed intents.
 */

import { findDateHint } from "./date-extract.js";

export type Intent =
  | { type: "book"; service?: string; date?: string }
  | { type: "cancel" }
  | { type: "reschedule" }
  | { type: "confirm" }
  | { type: "query_appointment" }
  | { type: "opt_out" }
  | { type: "reactivation_yes" }
  | { type: "reactivation_no" }
  | { type: "unknown"; raw: string };

const BOOK_PATTERNS = [
  /\b(quiero|necesito|me gustar[ií]a|quisiera|puedo|puedes)\b.*(cita|agendar|reservar|apartar|atenci[oó]n)/i,
  /\b(agendar|reservar|apartar)\b/i,
  /\bhola\b.*(cita|corte|tinte|manicure|pedicure|depilaci[oó]n|limpieza|trat)/i,
  /\b(cita|corte|tinte|manicure|pedicure)\b.*(para|el|la|este|esta)\b/i,
];

const CANCEL_PATTERNS = [
  /\b(cancelar|cancela|no puedo|no voy|no asistiré|no voy a ir)\b/i,
  /\b(quiero|necesito)\b.*cancelar/i,
];

// RESCHEDULE: distinct from CANCEL. Must classify BEFORE cancel because some
// phrasings ("quiero cambiar mi cita por favor") could otherwise reach CANCEL
// via future loose patterns. Currently no overlap with CANCEL_PATTERNS, but
// order-first is safer hygiene per [[feedback_unbounded_alternation_fp]].
//
// Audit 2026-05-24 C2 — all patterns MUST require an explicit appointment-
// object anchor (cita|hora|día|horario) to prevent false positives like:
//   "voy a reagendar después" (no commit), "puedes cambiar la dirección"
//   (wrong object), "cambiar de opinión sobre la cita" (idiom).
// Bounded `.{0,40}` on cross-token patterns prevents unbounded `.*` matching
// arbitrary distant tokens. Bare `reagendar|reprogramar` is anchored to a
// standalone message-form (^...$) to keep the standalone verb usable.
const RESCHEDULE_PATTERNS = [
  // Verb then object, TIGHT adjacency (article + noun typically ≤15 chars).
  // "cambiar mi cita" (4 chars between) matches; "cambiar de opinión sobre la cita"
  // (21 chars) does NOT — the idiom "cambiar de opinión" was the canonical FP.
  /\b(cambiar|cambia|cambio|mover|reagendar|reprogramar|modificar|recorrer)\b.{0,15}\b(cita|hora|d[ií]a|horario)\b/i,
  // Object then verb — slightly more permissive distance because
  // "mi cita la quiero cambiar" needs ~20 chars
  /\b(cita|hora|horario)\b.{0,25}\b(cambiar|cambia|mover|reagendar|reprogramar|modificar|recorrer)\b/i,
  // Standalone verb (single-token-ish message)
  /^\s*(reagendar|reprogramar)[\s!.?]*$/i,
  // Modal + verb + object, all tight adjacency
  /\b(quiero|necesito|puedo|puedes)\b.{0,10}\b(cambiar|cambia|mover|reagendar|reprogramar|modificar)\b.{0,15}\b(cita|hora|d[ií]a|horario)\b/i,
];

// Negation guard for RESCHEDULE — explicit refusal like "no quiero reagendar"
// or "no voy a cambiar la cita" should NOT classify as reschedule.
const RESCHEDULE_NEGATION_PATTERNS = [
  /\bno\b.{0,20}\b(quiero|necesito|voy a|pienso|gracias)\b.{0,30}\b(reagendar|reprogramar|cambiar|mover|modificar)\b/i,
];

const CONFIRM_PATTERNS = [
  /^\s*s[ií]\s*$/i,
  /^\s*(confirmo|confirmar|ah[ií] voy|voy|si voy|ok|okay|dale|claro|por supuesto)\s*$/i,
  /\bconfirmo\b/i,
];

const QUERY_APPOINTMENT_PATTERNS = [
  /\b(mi cita|mis citas|cu[aá]ndo|a qu[eé] hora|d[oó]nde|cuando tengo)\b/i,
  /\bcita (es|est[aá]|queda)\b/i,
];

const OPT_OUT_PATTERNS = [
  // W1: Removed bare 'quitar' — too common in cancel requests ("quitar mi cita").
  // Require it only in unambiguous unsubscribe phrasing.
  /\b(no me mandes|no me env[ií]es|stop|baja|darme de baja|no quiero mensajes|quitar de la lista|quitarme los mensajes)\b/i,
];

// W2: Check NO patterns BEFORE YES, and anchor YES to avoid false positives like "no quiero".
// "quiero" alone is too broad — anchored phrases are required for YES.
const REACTIVATION_YES_PATTERNS = [
  /^\s*s[ií]\s*$/i,
  /^\s*(claro|dale|por favor|sí quiero|si quiero|quisiera agendar|quiero cita|agendar cita)\s*$/i,
];

const REACTIVATION_NO_PATTERNS = [
  /^\s*(no|no gracias|ahorita no|luego|despu[eé]s|no quiero|no me interesa|no gracias|cancel)\s*$/i,
  /\bno quiero\b/i,
];

function matchAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

/** Extract service hint from booking message */
function extractService(text: string): string | undefined {
  const services = [
    "corte",
    "tinte",
    "manicure",
    "pedicure",
    "depilación",
    "depilacion",
    "limpieza facial",
    "tratamiento",
    "barba",
    "cejas",
  ];
  const lower = text.toLowerCase();
  return services.find((s) => lower.includes(s));
}

/**
 * Parse inbound message into a typed Intent.
 * @param text Raw WA message text
 * @param context Optional: 'reactivation' when message arrives after reactivation outbound
 */
export function parseIntent(text: string, context?: "reactivation"): Intent {
  const trimmed = text.trim();

  if (matchAny(trimmed, OPT_OUT_PATTERNS)) {
    return { type: "opt_out" };
  }

  // RESCHEDULE before CANCEL: "cambiar" is more specific than "cancelar",
  // and a reschedule intent shouldn't fall into the cancel flow.
  // Negation guard runs first so "no quiero reagendar" doesn't false-trigger.
  if (
    matchAny(trimmed, RESCHEDULE_PATTERNS) &&
    !matchAny(trimmed, RESCHEDULE_NEGATION_PATTERNS)
  ) {
    return { type: "reschedule" };
  }

  if (matchAny(trimmed, CANCEL_PATTERNS)) {
    return { type: "cancel" };
  }

  // Check reactivation context BEFORE generic confirm — reactivation yes/no takes priority.
  // W2: Check NO BEFORE YES to prevent "no quiero" matching the unanchored YES pattern.
  if (context === "reactivation") {
    if (matchAny(trimmed, REACTIVATION_NO_PATTERNS)) {
      return { type: "reactivation_no" };
    }
    if (matchAny(trimmed, REACTIVATION_YES_PATTERNS)) {
      return { type: "reactivation_yes" };
    }
  }

  if (matchAny(trimmed, CONFIRM_PATTERNS)) {
    return { type: "confirm" };
  }

  if (matchAny(trimmed, BOOK_PATTERNS)) {
    return {
      type: "book",
      service: extractService(trimmed),
      date: findDateHint(trimmed),
    };
  }

  if (matchAny(trimmed, QUERY_APPOINTMENT_PATTERNS)) {
    return { type: "query_appointment" };
  }

  return { type: "unknown", raw: trimmed };
}
