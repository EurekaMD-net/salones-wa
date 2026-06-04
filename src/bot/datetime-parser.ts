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
 *
 * The day extractor lives in ./date-extract.ts so the intent classifier and
 * this parser share ONE definition of "what day did she name" — see that
 * module's header for the sibling-divergence bug this consolidation fixed.
 */

import { extractDay, stripCalendarDateSpans } from "./date-extract.js";

function normalize(text: string): string {
  return text.trim().toLowerCase();
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
  // Strip the calendar-date span first so the day-of-month number in
  // "15 de marzo" / "15/3" isn't misread by extractTime as the clock hour.
  const time = extractTime(stripCalendarDateSpans(t));
  if (!time) return null;
  day.setHours(time.hour, time.minute, 0, 0);
  return day;
}
