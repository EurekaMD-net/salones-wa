/**
 * Slot finder — computes available appointment slots for a salon.
 *
 * Replaces the prior `generateDemoSlots` which offered citas in the past,
 * outside business hours, and without conflict detection.
 *
 * Algorithm:
 *  1. Read the salon's working hours from the `slots` table.
 *     If empty (operator hasn't configured): fall back to Mon-Sat 9am-7pm
 *     (a sensible default for small Mexican salons; configurable later via
 *     admin UI when that feature ships).
 *  2. Read existing non-cancelled appointments for the salon within the
 *     scan window (next 14 days starting from `minHoursAhead` from now).
 *  3. Walk day-by-day from `minHoursAhead` (default 24h) up to
 *     `daysToScan` (default 14):
 *       - skip closed days
 *       - within each open window, step in `service_duration_min` chunks
 *       - take the first non-conflicting candidate as the offered slot
 *         for that day (one slot per day for variety)
 *  4. Return up to `count` slots, each on a different day of the week
 *     where possible.
 *
 * All datetime math runs in the server's local TZ (TZ=America/Mexico_City
 * per systemd unit), so day boundaries match the salon owner's calendar.
 */

import type Database from "better-sqlite3";

interface WorkingHourWindow {
  day_of_week: number; // 0=Sunday, 6=Saturday
  start_time: string; // "HH:MM"
  end_time: string; // "HH:MM"
}

interface AppointmentRange {
  starts_at: number; // unix seconds
  ends_at: number;
}

export interface OfferedSlot {
  starts_at: number; // unix seconds
  ends_at: number;
  label: string; // human-readable Spanish, MX timezone
}

const DEFAULT_WORKING_HOURS: WorkingHourWindow[] = [
  // Mon-Sat 9am-7pm, closed Sunday. Common for CDMX salones piloto.
  { day_of_week: 1, start_time: "09:00", end_time: "19:00" },
  { day_of_week: 2, start_time: "09:00", end_time: "19:00" },
  { day_of_week: 3, start_time: "09:00", end_time: "19:00" },
  { day_of_week: 4, start_time: "09:00", end_time: "19:00" },
  { day_of_week: 5, start_time: "09:00", end_time: "19:00" },
  { day_of_week: 6, start_time: "09:00", end_time: "19:00" },
];

function parseHHMM(hhmm: string): { h: number; m: number } {
  const [hStr, mStr] = hhmm.split(":");
  return { h: parseInt(hStr ?? "0", 10), m: parseInt(mStr ?? "0", 10) };
}

function formatLabel(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString("es-MX", {
    timeZone: "America/Mexico_City",
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export interface FindSlotsOptions {
  count?: number;
  daysToScan?: number;
  minHoursAhead?: number;
  /** Optional: seed time for tests; defaults to Date.now(). */
  nowMs?: number;
  /**
   * Max non-conflicting slots to take per open day. Default 1 — variety
   * beats density for a 3-option offer. findAlternativesAround raises this so
   * same-day-different-hour alternatives can surface around a requested time.
   */
  slotsPerDay?: number;
}

export function findAvailableSlots(
  db: Database.Database,
  salon_id: string,
  service_duration_min: number,
  options: FindSlotsOptions = {},
): OfferedSlot[] {
  const count = options.count ?? 3;
  const daysToScan = options.daysToScan ?? 14;
  const minHoursAhead = options.minHoursAhead ?? 24;
  const nowMs = options.nowMs ?? Date.now();
  const slotsPerDay = Math.max(1, options.slotsPerDay ?? 1);

  // 1. Working hours: from DB if present, otherwise defaults.
  const dbHours = db
    .prepare(
      "SELECT day_of_week, start_time, end_time FROM slots WHERE salon_id = ? AND active = 1",
    )
    .all(salon_id) as WorkingHourWindow[];
  const workingHours = dbHours.length > 0 ? dbHours : DEFAULT_WORKING_HOURS;

  // Index by day_of_week for fast lookup.
  const hoursByDay = new Map<number, WorkingHourWindow[]>();
  for (const wh of workingHours) {
    const list = hoursByDay.get(wh.day_of_week) ?? [];
    list.push(wh);
    hoursByDay.set(wh.day_of_week, list);
  }

  // 2. Existing appointments to conflict-check.
  // Filter to anything that could overlap our scan window.
  const earliestSec = Math.floor(nowMs / 1000) + minHoursAhead * 3600;
  const latestSec = earliestSec + daysToScan * 86400;
  const existing = db
    .prepare(
      "SELECT starts_at, ends_at FROM appointments " +
        "WHERE salon_id = ? AND status = 'confirmed' " +
        "AND starts_at < ? AND ends_at > ?",
    )
    .all(salon_id, latestSec, earliestSec) as AppointmentRange[];

  // 3. Walk day-by-day from "earliest" through "scan window".
  const slots: OfferedSlot[] = [];
  const earliestDate = new Date(earliestSec * 1000);
  const slotMs = service_duration_min * 60 * 1000;

  for (let dayOffset = 0; dayOffset < daysToScan; dayOffset++) {
    if (slots.length >= count) break;

    const day = new Date(earliestDate);
    day.setDate(day.getDate() + dayOffset);
    const dow = day.getDay();
    const windows = hoursByDay.get(dow);
    if (!windows) continue;

    // Per-day budget: default 1 (one slot per day — variety beats density
    // for a 3-option offer). findAlternativesAround raises it to surface
    // same-day-different-hour options near a requested time.
    let perDayCount = 0;

    for (const wh of windows) {
      if (slots.length >= count || perDayCount >= slotsPerDay) break;

      const { h: startH, m: startM } = parseHHMM(wh.start_time);
      const { h: endH, m: endM } = parseHHMM(wh.end_time);

      const candidate = new Date(day);
      candidate.setHours(startH, startM, 0, 0);
      const closesAt = new Date(day);
      closesAt.setHours(endH, endM, 0, 0);

      while (candidate.getTime() + slotMs <= closesAt.getTime()) {
        if (slots.length >= count || perDayCount >= slotsPerDay) break;

        const startSec = Math.floor(candidate.getTime() / 1000);
        const endSec = startSec + service_duration_min * 60;

        // Must respect 24h lookahead.
        if (startSec < earliestSec) {
          candidate.setTime(candidate.getTime() + slotMs);
          continue;
        }

        // Conflict check: any existing appointment overlap?
        const conflict = existing.some(
          (a) => startSec < a.ends_at && endSec > a.starts_at,
        );
        if (!conflict) {
          slots.push({
            starts_at: startSec,
            ends_at: endSec,
            label: formatLabel(startSec),
          });
          perDayCount++;
        }

        candidate.setTime(candidate.getTime() + slotMs);
      }
    }
  }

  return slots;
}

/** Why a requested custom time was rejected — useful for tailored replies. */
export type CustomTimeRejection =
  | "in_past" // before now + minHoursAhead
  | "outside_hours" // outside the salon's working hours for that day
  | "conflict"; // collides with an existing confirmed appointment

export interface CustomTimeCheckResult {
  available: boolean;
  reason?: CustomTimeRejection;
}

/**
 * Is the salon available for a service of `duration_min` starting at
 * `requestedStartSec`? Applies the same rules as `findAvailableSlots`:
 * 24h lookahead, working hours, no overlap with confirmed appointments.
 */
export function checkCustomTime(
  db: Database.Database,
  salon_id: string,
  service_duration_min: number,
  requestedStartSec: number,
  options: { nowMs?: number; minHoursAhead?: number } = {},
): CustomTimeCheckResult {
  const nowMs = options.nowMs ?? Date.now();
  const minHoursAhead = options.minHoursAhead ?? 24;
  const earliestSec = Math.floor(nowMs / 1000) + minHoursAhead * 3600;

  if (requestedStartSec < earliestSec) {
    return { available: false, reason: "in_past" };
  }

  const endSec = requestedStartSec + service_duration_min * 60;

  // Working hours check
  const dbHours = db
    .prepare(
      "SELECT day_of_week, start_time, end_time FROM slots WHERE salon_id = ? AND active = 1",
    )
    .all(salon_id) as WorkingHourWindow[];
  const workingHours = dbHours.length > 0 ? dbHours : DEFAULT_WORKING_HOURS;

  const start = new Date(requestedStartSec * 1000);
  const dow = start.getDay();
  const windows = workingHours.filter((wh) => wh.day_of_week === dow);
  if (windows.length === 0) {
    return { available: false, reason: "outside_hours" };
  }
  const inHours = windows.some((wh) => {
    const { h: oh, m: om } = parseHHMM(wh.start_time);
    const { h: ch, m: cm } = parseHHMM(wh.end_time);
    const dayStart = new Date(start);
    dayStart.setHours(oh, om, 0, 0);
    const dayEnd = new Date(start);
    dayEnd.setHours(ch, cm, 0, 0);
    return (
      start.getTime() >= dayStart.getTime() &&
      start.getTime() + service_duration_min * 60_000 <= dayEnd.getTime()
    );
  });
  if (!inHours) {
    return { available: false, reason: "outside_hours" };
  }

  // Conflict check
  const conflict = db
    .prepare(
      "SELECT 1 FROM appointments WHERE salon_id = ? AND status = 'confirmed' " +
        "AND starts_at < ? AND ends_at > ?",
    )
    .get(salon_id, endSec, requestedStartSec) as { 1: number } | undefined;
  if (conflict) {
    return { available: false, reason: "conflict" };
  }

  return { available: true };
}

/**
 * Find alternative slots near `anchorSec` for when the clienta's requested
 * custom time isn't available. Pulls a wider pool from `findAvailableSlots`
 * with `slotsPerDay > 1` — so same-day-different-hour options DO surface —
 * then sorts by absolute time distance from `anchorSec` and takes the top N.
 *
 * 2026-06-04: raised slotsPerDay (was effectively 1, the old one-slot-per-day
 * rule that the audit-W4 note flagged). A clienta who asks for "viernes 3pm"
 * when 3pm is taken now gets offered 2pm / 4pm on the SAME Friday, not just
 * the same hour on other days — which is what "near the requested time" should
 * mean. The real-clock 24h lookahead floor is still enforced by
 * findAvailableSlots.
 */
export function findAlternativesAround(
  db: Database.Database,
  salon_id: string,
  service_duration_min: number,
  anchorSec: number,
  options: FindSlotsOptions & { count?: number } = {},
): OfferedSlot[] {
  const count = options.count ?? 3;
  const candidates = findAvailableSlots(db, salon_id, service_duration_min, {
    nowMs: options.nowMs,
    minHoursAhead: options.minHoursAhead,
    count: 18, // wider pool so the distance sort has same-day options to pick
    daysToScan: 7,
    slotsPerDay: 4, // surface a few hours per day, incl. the anchor's own day
  });

  // Sort by absolute distance from anchor; take top N
  candidates.sort(
    (a, b) =>
      Math.abs(a.starts_at - anchorSec) - Math.abs(b.starts_at - anchorSec),
  );
  // Don't return the anchor itself if it happens to be in candidates
  // (it shouldn't, since we only call this when anchor was unavailable).
  return candidates.filter((c) => c.starts_at !== anchorSec).slice(0, count);
}
