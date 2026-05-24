/**
 * Spanish day+time parser.
 *
 * Converts free-form Spanish appointment-request text like:
 *   "viernes 4pm"
 *   "mañana 11am"
 *   "el sábado a las 5"
 *   "pasado mañana a las 3:30 de la tarde"
 *   "este jueves 2pm"
 * into a concrete Date.
 *
 * Returns null when the parse is ambiguous (no recognizable day OR no
 * recognizable time). Callers should treat null as "ask the clienta
 * to rephrase" rather than guess.
 *
 * Heuristic, not exhaustive — covers the common patterns Mexican salon
 * clientas actually type. Future: swap to a proper Spanish NLP library
 * (chrono-node has limited Spanish; date-fns parse needs strict format).
 */

const DAYS_OF_WEEK: Record<string, number> = {
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

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

function extractDay(text: string, now: Date): Date | null {
  // Audit C1 (2026-05-24): strip TIME-QUALIFIER suffixes ("de la mañana /
  // tarde / noche") BEFORE looking for day words. The bare /\bma[nñ]ana\b/
  // check used to match the word "mañana" inside "de la mañana" → every
  // clienta typing "[día] X de la mañana" got pushed to TOMORROW instead
  // of the day she actually named ("viernes 9 de la mañana" → Tuesday 9am).
  // Spanish-morning is the single most common appointment phrasing, so
  // this was a Day-1 production bug.
  const dayCorpus = text.replace(
    /\bde\s+la\s+(ma[nñ]ana|tarde|noche)\b/gi,
    " ",
  );

  // Day-of-week ALWAYS wins over relative-day tokens. If the clienta names
  // a weekday, that's what she meant — relative-day words are fallbacks.
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

  // Relative-day fallbacks. Order matters: longer phrase first so
  // "pasado mañana" doesn't match "mañana".
  if (/\bpasado\s+ma[nñ]ana\b/.test(dayCorpus)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 2);
    return d;
  }
  if (/\bma[nñ]ana\b/.test(dayCorpus)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return d;
  }
  if (/\bhoy\b/.test(dayCorpus)) {
    return new Date(now);
  }

  return null;
}

interface TimeParts {
  hour: number;
  minute: number;
}

function extractTime(text: string): TimeParts | null {
  // Match patterns like:
  //   "4pm", "4 pm", "4:30pm", "4:30 pm"
  //   "11am", "11 a.m.", "11:15 a.m."
  //   "a las 4", "a las 5:30"
  //   "16:00", "16h"
  //   "5 de la tarde", "11 de la mañana"
  const re =
    /(?:a\s+las\s+)?(\d{1,2})(?:[:.h](\d{2}))?\s*(a\.?m\.?|p\.?m\.?|de\s+la\s+ma[nñ]ana|de\s+la\s+tarde|de\s+la\s+noche|h(?:rs?)?)?/i;
  const m = text.match(re);
  if (!m) return null;

  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const suffix = (m[3] ?? "").toLowerCase();

  if (isNaN(hour) || hour < 0 || hour > 23) return null;
  if (minute < 0 || minute >= 60) return null;

  const isPM = /p\.?m\.?|tarde|noche/.test(suffix);
  const isAM = /a\.?m\.?|ma[nñ]ana/.test(suffix);

  if (isPM && hour < 12) hour += 12;
  else if (isAM && hour === 12) hour = 0;
  // Audit W2 (2026-05-24): "12 de la noche" idiomatically means midnight
  // in Mexican Spanish; without this, isPM kept hour=12 → noon. "12 de la
  // mañana" is also midnight (12am). Both collapse to 0.
  else if (/noche|ma[nñ]ana/.test(suffix) && hour === 12) hour = 0;
  else if (!suffix && hour >= 1 && hour <= 7) {
    // Ambiguous bare hour 1-7: salon clientas almost always mean afternoon
    // ("a las 5" = 5pm, not 5am). Hours 8-11 stay morning by default.
    hour += 12;
  }

  return { hour, minute };
}

export function parseSpanishDateTime(text: string, nowMs: number): Date | null {
  const t = normalize(text);
  const day = extractDay(t, new Date(nowMs));
  if (!day) return null;
  const time = extractTime(t);
  if (!time) return null;
  day.setHours(time.hour, time.minute, 0, 0);
  return day;
}
