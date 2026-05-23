/**
 * Intent parser — regex-first, no LLM dependency for MVP
 * Classifies inbound WA messages into typed intents.
 */

export type Intent =
  | { type: 'book'; service?: string; date?: string }
  | { type: 'cancel' }
  | { type: 'confirm' }
  | { type: 'query_appointment' }
  | { type: 'opt_out' }
  | { type: 'reactivation_yes' }
  | { type: 'reactivation_no' }
  | { type: 'unknown'; raw: string }

const BOOK_PATTERNS = [
  /\b(quiero|necesito|me gustar[ií]a|quisiera|puedo|puedes)\b.*(cita|agendar|reservar|apartar|atenci[oó]n)/i,
  /\b(agendar|reservar|apartar)\b/i,
  /\bhola\b.*(cita|corte|tinte|manicure|pedicure|depilaci[oó]n|limpieza|trat)/i,
  /\b(cita|corte|tinte|manicure|pedicure)\b.*(para|el|la|este|esta)\b/i,
]

const CANCEL_PATTERNS = [
  /\b(cancelar|cancela|no puedo|no voy|no asistiré|no voy a ir)\b/i,
  /\b(quiero|necesito)\b.*cancelar/i,
]

const CONFIRM_PATTERNS = [
  /^\s*s[ií]\s*$/i,
  /^\s*(confirmo|confirmar|ah[ií] voy|voy|si voy|ok|okay|dale|claro|por supuesto)\s*$/i,
  /\bconfirmo\b/i,
]

const QUERY_APPOINTMENT_PATTERNS = [
  /\b(mi cita|mis citas|cu[aá]ndo|a qu[eé] hora|d[oó]nde|cuando tengo)\b/i,
  /\bcita (es|est[aá]|queda)\b/i,
]

const OPT_OUT_PATTERNS = [
  // W1: Removed bare 'quitar' — too common in cancel requests ("quitar mi cita").
  // Require it only in unambiguous unsubscribe phrasing.
  /\b(no me mandes|no me env[ií]es|stop|baja|darme de baja|no quiero mensajes|quitar de la lista|quitarme los mensajes)\b/i,
]

// W2: Check NO patterns BEFORE YES, and anchor YES to avoid false positives like "no quiero".
// "quiero" alone is too broad — anchored phrases are required for YES.
const REACTIVATION_YES_PATTERNS = [
  /^\s*s[ií]\s*$/i,
  /^\s*(claro|dale|por favor|sí quiero|si quiero|quisiera agendar|quiero cita|agendar cita)\s*$/i,
]

const REACTIVATION_NO_PATTERNS = [
  /^\s*(no|no gracias|ahorita no|luego|despu[eé]s|no quiero|no me interesa|no gracias|cancel)\s*$/i,
  /\bno quiero\b/i,
]

function matchAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(text))
}

/** Extract service hint from booking message */
function extractService(text: string): string | undefined {
  const services = [
    'corte',
    'tinte',
    'manicure',
    'pedicure',
    'depilación',
    'depilacion',
    'limpieza facial',
    'tratamiento',
    'barba',
    'cejas',
  ]
  const lower = text.toLowerCase()
  return services.find(s => lower.includes(s))
}

/** Very light date extraction — returns raw string hint if found */
function extractDate(text: string): string | undefined {
  const patterns = [
    /\b(hoy|mañana|ma[nñ]ana)\b/i,
    /\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/i,
    /\b\d{1,2}\s*de\s*(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/i,
    /\b\d{1,2}[\/\-]\d{1,2}\b/,
  ]
  for (const p of patterns) {
    const m = text.match(p)
    if (m) return m[0]
  }
  return undefined
}

/**
 * Parse inbound message into a typed Intent.
 * @param text Raw WA message text
 * @param context Optional: 'reactivation' when message arrives after reactivation outbound
 */
export function parseIntent(text: string, context?: 'reactivation'): Intent {
  const trimmed = text.trim()

  if (matchAny(trimmed, OPT_OUT_PATTERNS)) {
    return { type: 'opt_out' }
  }

  if (matchAny(trimmed, CANCEL_PATTERNS)) {
    return { type: 'cancel' }
  }

  // Check reactivation context BEFORE generic confirm — reactivation yes/no takes priority.
  // W2: Check NO BEFORE YES to prevent "no quiero" matching the unanchored YES pattern.
  if (context === 'reactivation') {
    if (matchAny(trimmed, REACTIVATION_NO_PATTERNS)) {
      return { type: 'reactivation_no' }
    }
    if (matchAny(trimmed, REACTIVATION_YES_PATTERNS)) {
      return { type: 'reactivation_yes' }
    }
  }

  if (matchAny(trimmed, CONFIRM_PATTERNS)) {
    return { type: 'confirm' }
  }

  if (matchAny(trimmed, BOOK_PATTERNS)) {
    return {
      type: 'book',
      service: extractService(trimmed),
      date: extractDate(trimmed),
    }
  }

  if (matchAny(trimmed, QUERY_APPOINTMENT_PATTERNS)) {
    return { type: 'query_appointment' }
  }

  return { type: 'unknown', raw: trimmed }
}
