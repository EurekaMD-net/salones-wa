/**
 * Shared Spanish date extraction — the single source of truth for "what day
 * did the clienta name?", used by BOTH the intent classifier (as a light
 * string hint) and the datetime parser (as a concrete Date).
 *
 * Why this module exists (sibling-divergence fix, 2026-06-04):
 * intent-parser used to recognize four date shapes — relative ("mañana"),
 * weekday ("viernes"), "N de <mes>" ("15 de marzo"), and numeric "DD/MM"
 * ("15/3") — but datetime-parser's extractDay only understood the first two.
 * So a clienta who wrote "quiero cita el 15 de marzo a las 4pm" got a `book`
 * intent (the bot "understood" her), then the booking flow called
 * parseSpanishDateTime, which returned null because extractDay couldn't parse
 * "15 de marzo" → "no entendí la fecha, ¿puedes repetir?". The bot understood
 * the intent but couldn't parse the very reply it elicited. Consolidating both
 * paths onto ONE extractor closes that gap: anything the intent layer flags as
 * a date, the datetime layer can now actually resolve.
 */

/** Weekday name → day_of_week (0=Sunday … 6=Saturday). Accented + bare. */
export const DAYS_OF_WEEK: Record<string, number> = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miércoles: 3,
  miercoles: 3,
  jueves: 4,
  viernes: 5,
  sábado: 6,
  sabado: 6,
};

/** Month name → JS month index (0=enero … 11=diciembre). Accent-free here;
 * the corpus is lower-cased and Spanish month names carry no accents. */
export const MONTHS: Record<string, number> = {
  enero: 0,
  febrero: 1,
  marzo: 2,
  abril: 3,
  mayo: 4,
  junio: 5,
  julio: 6,
  agosto: 7,
  septiembre: 8,
  setiembre: 8, // accepted variant spelling
  octubre: 9,
  noviembre: 10,
  diciembre: 11,
};

const MONTH_ALT = Object.keys(MONTHS).join("|");

/** "15 de marzo", "1 de enero" — explicit calendar date. */
export const DAY_OF_MONTH_RE = new RegExp(
  `\\b(\\d{1,2})\\s+de\\s+(${MONTH_ALT})\\b`,
  "i",
);

/** "15/3", "15-3" — numeric date, Mexican DD/MM convention (day first). */
export const NUMERIC_DATE_RE = /\b(\d{1,2})[/-](\d{1,2})\b/;

/**
 * Build a Date at local midnight, rejecting non-existent calendar days.
 * JS `new Date(y, 1, 30)` silently rolls Feb 30 into March — detect that
 * roll-over and return null so "31 de febrero" is treated as unparseable
 * rather than quietly becoming March 2/3.
 */
function makeValidDate(year: number, month: number, day: number): Date | null {
  const d = new Date(year, month, day, 0, 0, 0, 0);
  if (
    d.getFullYear() !== year ||
    d.getMonth() !== month ||
    d.getDate() !== day
  ) {
    return null;
  }
  return d;
}

/**
 * Resolve a bare (month, day) to the next FUTURE occurrence at-or-after
 * today's date (a salon clienta naming "15 de marzo" means the upcoming one,
 * not one in the past). Scans this year forward up to +2 years so a Feb-29
 * request still lands on the next leap year. Returns null for an impossible
 * date (bad month index, or a day that doesn't exist in any nearby year).
 */
function resolveCalendarDate(
  now: Date,
  month: number,
  day: number,
): Date | null {
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const baseYear = now.getFullYear();
  for (let y = baseYear; y <= baseYear + 2; y++) {
    const cand = makeValidDate(y, month, day);
    if (cand && cand.getTime() >= today.getTime()) return cand;
  }
  return null;
}

/**
 * Extract the day the clienta named as a concrete Date at local midnight,
 * or null when no day is recognizable. Resolution order (most specific
 * first): named weekday → "pasado mañana" → "mañana" → "hoy" → "N de <mes>"
 * → numeric "DD/MM". Weekdays ALWAYS win over relative-day tokens.
 *
 * `text` should be lower-cased+trimmed; this also lower-cases defensively so
 * the module is safe to call directly. `now` is the reference instant.
 */
export function extractDay(text: string, now: Date): Date | null {
  const lowered = text.toLowerCase();

  // Strip TIME-QUALIFIER suffixes ("de la mañana / tarde / noche") BEFORE
  // looking for day words, so the word "mañana" inside "de la mañana" can't
  // be mistaken for the relative-day "mañana" (the canonical 2026-05-24 bug:
  // "viernes 9 de la mañana" → Tuesday instead of the named Friday).
  const dayCorpus = lowered.replace(
    /\bde\s+la\s+(ma[nñ]ana|tarde|noche)\b/gi,
    " ",
  );

  // Named weekday wins. "próximo/siguiente" pushes to the week after.
  const wantsNextWeek = /\b(pr[oó]ximo|pr[oó]xima|siguiente|que viene)\b/.test(
    dayCorpus,
  );
  for (const [name, dow] of Object.entries(DAYS_OF_WEEK)) {
    const re = new RegExp(`\\b${name}\\b`, "i");
    if (re.test(dayCorpus)) {
      const d = new Date(now);
      const currentDow = d.getDay();
      let diff = dow - currentDow;
      if (diff <= 0) diff += 7;
      if (wantsNextWeek && diff < 7) diff += 7;
      d.setDate(d.getDate() + diff);
      return d;
    }
  }

  // Relative-day fallbacks. Longer phrase first so "pasado mañana" wins.
  if (/\bpasado\s+ma[nñ]ana\b/i.test(dayCorpus)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 2);
    return d;
  }
  if (/\bma[nñ]ana\b/i.test(dayCorpus)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return d;
  }
  if (/\bhoy\b/i.test(dayCorpus)) {
    return new Date(now);
  }

  // Explicit calendar date: "15 de marzo".
  const dm = dayCorpus.match(DAY_OF_MONTH_RE);
  if (dm) {
    const day = parseInt(dm[1]!, 10);
    const month = MONTHS[dm[2]!.toLowerCase()];
    if (month !== undefined) {
      const resolved = resolveCalendarDate(now, month, day);
      if (resolved) return resolved;
    }
  }

  // Numeric date "15/3" (DD/MM, day first — Mexican convention).
  const nd = dayCorpus.match(NUMERIC_DATE_RE);
  if (nd) {
    const day = parseInt(nd[1]!, 10);
    const month = parseInt(nd[2]!, 10) - 1; // 1-indexed → JS 0-indexed
    const resolved = resolveCalendarDate(now, month, day);
    if (resolved) return resolved;
  }

  return null;
}

/**
 * Remove explicit calendar-date spans ("15 de marzo", "15/3") from text so a
 * downstream time parser doesn't mistake the day-of-month number for a clock
 * hour (e.g. read "15" in "15 de marzo a las 4pm" as 15:00 instead of 16:00).
 * Weekday and relative-day tokens carry no digits, so they're left untouched
 * and don't need stripping.
 */
export function stripCalendarDateSpans(text: string): string {
  return text.replace(DAY_OF_MONTH_RE, " ").replace(NUMERIC_DATE_RE, " ");
}

/** Patterns for the light string hint, in priority order. Kept aligned with
 * the shapes extractDay can resolve so the intent layer never advertises a
 * date the datetime layer can't parse. */
const HINT_PATTERNS: RegExp[] = [
  /\b(hoy|mañana|ma[nñ]ana)\b/i,
  /\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/i,
  DAY_OF_MONTH_RE,
  /\b\d{1,2}[/-]\d{1,2}\b/,
];

/**
 * Return the raw substring that looks like a date, or undefined. This is a
 * display/logging hint for the `book` intent — NOT a parse. It recognizes
 * exactly the shapes extractDay() can resolve.
 */
export function findDateHint(text: string): string | undefined {
  for (const p of HINT_PATTERNS) {
    const m = text.match(p);
    if (m) return m[0];
  }
  return undefined;
}
