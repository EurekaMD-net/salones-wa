import { randomUUID } from "crypto";
import type Database from "better-sqlite3";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Salon {
  id: string;
  name: string;
  phone: string;
  /** Dueña's personal WA — optional, used for service notifications only.
   * Never bound to a Baileys session; never receives client traffic. */
  owner_phone: string | null;
  timezone: string;
  token: string;
  active: number;
  created_at: number;
}

export interface Service {
  id: string;
  salon_id: string;
  name: string;
  duration_min: number;
  price: number | null;
  active: number;
}

export interface Contact {
  id: string;
  salon_id: string;
  phone: string;
  name: string | null;
  visit_count: number;
  last_visit: number | null;
  dormant: number;
  opt_out: number;
  created_at: number;
}

export interface Appointment {
  id: string;
  salon_id: string;
  contact_id: string;
  service_id: string | null;
  starts_at: number;
  ends_at: number;
  status: "confirmed" | "cancelled" | "completed" | "no_show";
  reminded_24h: number;
  reminded_2h: number;
  created_at: number;
}

export interface Campaign {
  id: string;
  salon_id: string;
  contact_id: string;
  type: "reactivation" | "promo" | "follow_up";
  sent_at: number;
  responded: number;
  booked: number;
}

// ─── Salon ───────────────────────────────────────────────────────────────────

export function createSalon(
  db: Database.Database,
  data: {
    name: string;
    phone: string;
    owner_phone?: string | null;
    timezone?: string;
  },
): Salon {
  const id = randomUUID();
  const token = randomUUID();
  db.prepare(
    `
    INSERT INTO salons (id, name, phone, owner_phone, timezone, token)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    id,
    data.name,
    data.phone,
    data.owner_phone ?? null,
    data.timezone ?? "America/Mexico_City",
    token,
  );
  return db.prepare("SELECT * FROM salons WHERE id = ?").get(id) as Salon;
}

export function getSalonByPhone(
  db: Database.Database,
  phone: string,
): Salon | null {
  return (
    (db
      .prepare("SELECT * FROM salons WHERE phone = ? AND active = 1")
      .get(phone) as Salon) ?? null
  );
}

export function getSalonByToken(
  db: Database.Database,
  token: string,
): Salon | null {
  return (
    (db
      .prepare("SELECT * FROM salons WHERE token = ? AND active = 1")
      .get(token) as Salon) ?? null
  );
}

export function getAllActiveSalons(db: Database.Database): Salon[] {
  return db.prepare("SELECT * FROM salons WHERE active = 1").all() as Salon[];
}

export function getAllSalons(db: Database.Database): Salon[] {
  return db
    .prepare("SELECT * FROM salons ORDER BY created_at DESC")
    .all() as Salon[];
}

export function getSalonById(db: Database.Database, id: string): Salon | null {
  return (
    (db.prepare("SELECT * FROM salons WHERE id = ?").get(id) as Salon) ?? null
  );
}

export function updateSalon(
  db: Database.Database,
  id: string,
  data: { name?: string; phone?: string; owner_phone?: string | null },
): Salon | null {
  if (data.name !== undefined) {
    db.prepare("UPDATE salons SET name = ? WHERE id = ?").run(data.name, id);
  }
  if (data.phone !== undefined) {
    db.prepare("UPDATE salons SET phone = ? WHERE id = ?").run(data.phone, id);
  }
  // owner_phone is explicitly nullable — passing null clears it, undefined
  // leaves it untouched. The form sends empty-string → caller maps to null
  // before getting here.
  if (data.owner_phone !== undefined) {
    db.prepare("UPDATE salons SET owner_phone = ? WHERE id = ?").run(
      data.owner_phone,
      id,
    );
  }
  return getSalonById(db, id);
}

export function setSalonActive(
  db: Database.Database,
  id: string,
  active: boolean,
): void {
  db.prepare("UPDATE salons SET active = ? WHERE id = ?").run(
    active ? 1 : 0,
    id,
  );
}

export function createService(
  db: Database.Database,
  data: {
    salon_id: string;
    name: string;
    duration_min: number;
    price?: number;
  },
): Service {
  return addService(db, data);
}

export function updateService(
  db: Database.Database,
  id: string,
  data: { name?: string; duration_min?: number; price?: number | null },
): Service | null {
  if (data.name !== undefined)
    db.prepare("UPDATE services SET name = ? WHERE id = ?").run(data.name, id);
  if (data.duration_min !== undefined)
    db.prepare("UPDATE services SET duration_min = ? WHERE id = ?").run(
      data.duration_min,
      id,
    );
  if (data.price !== undefined)
    db.prepare("UPDATE services SET price = ? WHERE id = ?").run(
      data.price,
      id,
    );
  return (
    (db.prepare("SELECT * FROM services WHERE id = ?").get(id) as Service) ??
    null
  );
}

export function deleteService(
  db: Database.Database,
  id: string,
  salon_id: string,
): void {
  db.prepare(
    "UPDATE services SET active = 0 WHERE id = ? AND salon_id = ?",
  ).run(id, salon_id);
}

// ─── Services ────────────────────────────────────────────────────────────────

export function addService(
  db: Database.Database,
  data: {
    salon_id: string;
    name: string;
    duration_min: number;
    price?: number;
  },
): Service {
  const id = randomUUID();
  db.prepare(
    `
    INSERT INTO services (id, salon_id, name, duration_min, price)
    VALUES (?, ?, ?, ?, ?)
  `,
  ).run(id, data.salon_id, data.name, data.duration_min, data.price ?? null);
  return db.prepare("SELECT * FROM services WHERE id = ?").get(id) as Service;
}

export function getServices(
  db: Database.Database,
  salon_id: string,
): Service[] {
  return db
    .prepare("SELECT * FROM services WHERE salon_id = ? AND active = 1")
    .all(salon_id) as Service[];
}

// ─── Contacts ────────────────────────────────────────────────────────────────

export function upsertContact(
  db: Database.Database,
  data: { salon_id: string; phone: string; name?: string },
): Contact {
  const existing = db
    .prepare("SELECT * FROM contacts WHERE salon_id = ? AND phone = ?")
    .get(data.salon_id, data.phone) as Contact | undefined;

  if (existing) {
    if (data.name && !existing.name) {
      db.prepare("UPDATE contacts SET name = ? WHERE id = ?").run(
        data.name,
        existing.id,
      );
    }
    return db
      .prepare("SELECT * FROM contacts WHERE id = ?")
      .get(existing.id) as Contact;
  }

  const id = randomUUID();
  db.prepare(
    `
    INSERT INTO contacts (id, salon_id, phone, name)
    VALUES (?, ?, ?, ?)
  `,
  ).run(id, data.salon_id, data.phone, data.name ?? null);
  return db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as Contact;
}

export function getDormantContacts(
  db: Database.Database,
  salon_id: string,
): Contact[] {
  const cutoff = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
  return db
    .prepare(
      `
    SELECT c.*
    FROM contacts c
    WHERE c.salon_id = ?
      AND c.opt_out = 0
      AND c.visit_count >= 1
      AND (c.last_visit IS NULL OR c.last_visit < ?)
      AND NOT EXISTS (
        SELECT 1 FROM appointments a
        WHERE a.contact_id = c.id
          AND a.status = 'confirmed'
          AND a.starts_at > unixepoch()
      )
  `,
    )
    .all(salon_id, cutoff) as Contact[];
}

export function markContactOptOut(
  db: Database.Database,
  contact_id: string,
): void {
  db.prepare("UPDATE contacts SET opt_out = 1 WHERE id = ?").run(contact_id);
}

export function updateDormantFlags(db: Database.Database): number {
  const cutoff = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
  const result = db
    .prepare(
      `
    UPDATE contacts
    SET dormant = CASE
      WHEN (last_visit IS NULL OR last_visit < ?) AND NOT EXISTS (
        SELECT 1 FROM appointments a
        WHERE a.contact_id = contacts.id
          AND a.status = 'confirmed'
          AND a.starts_at > unixepoch()
      ) THEN 1
      ELSE 0
    END
  `,
    )
    .run(cutoff);
  return result.changes;
}

// ─── Appointments ─────────────────────────────────────────────────────────────

export function createAppointment(
  db: Database.Database,
  data: {
    salon_id: string;
    contact_id: string;
    service_id?: string;
    starts_at: number;
    ends_at: number;
  },
): Appointment {
  const id = randomUUID();
  db.prepare(
    `
    INSERT INTO appointments (id, salon_id, contact_id, service_id, starts_at, ends_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    id,
    data.salon_id,
    data.contact_id,
    data.service_id ?? null,
    data.starts_at,
    data.ends_at,
  );
  return db
    .prepare("SELECT * FROM appointments WHERE id = ?")
    .get(id) as Appointment;
}

export function getUpcomingAppointmentsFor24h(
  db: Database.Database,
): Appointment[] {
  const now = Math.floor(Date.now() / 1000);
  const window_start = now + 23 * 3600;
  const window_end = now + 25 * 3600;
  return db
    .prepare(
      `
    SELECT * FROM appointments
    WHERE status = 'confirmed'
      AND reminded_24h = 0
      AND starts_at BETWEEN ? AND ?
  `,
    )
    .all(window_start, window_end) as Appointment[];
}

export function getUpcomingAppointmentsFor2h(
  db: Database.Database,
): Appointment[] {
  const now = Math.floor(Date.now() / 1000);
  const window_start = now + 1.5 * 3600;
  const window_end = now + 3 * 3600;
  return db
    .prepare(
      `
    SELECT * FROM appointments
    WHERE status = 'confirmed'
      AND reminded_2h = 0
      AND starts_at BETWEEN ? AND ?
  `,
    )
    .all(window_start, window_end) as Appointment[];
}

export function markReminded24h(
  db: Database.Database,
  appointment_id: string,
): void {
  db.prepare("UPDATE appointments SET reminded_24h = 1 WHERE id = ?").run(
    appointment_id,
  );
}

export function markReminded2h(
  db: Database.Database,
  appointment_id: string,
): void {
  db.prepare("UPDATE appointments SET reminded_2h = 1 WHERE id = ?").run(
    appointment_id,
  );
}

export function cancelAppointment(
  db: Database.Database,
  appointment_id: string,
): void {
  db.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ?").run(
    appointment_id,
  );
}

/** Mark an appointment as no-show. Used by the dueña's panel when a clienta
 * doesn't arrive — feeds the dormancy detector. completePassedAppointments()
 * skips no-show rows so `visit_count` doesn't inflate from a missed visit. */
export function markNoShow(
  db: Database.Database,
  appointment_id: string,
): void {
  db.prepare("UPDATE appointments SET status = 'no_show' WHERE id = ?").run(
    appointment_id,
  );
}

/** A dashboard row: appointment joined with contact + service display fields.
 * Used by the dueña's panel to render today/tomorrow without N+1 queries.
 * Includes all non-terminal statuses (confirmed/cancelled/no_show) so the
 * dueña can see what happened to a cancelled clienta. `completed` rows are
 * excluded — past+confirmed flips to completed via completePassedAppointments. */
export interface DashboardAppointment {
  id: string;
  starts_at: number;
  ends_at: number;
  status: Appointment["status"];
  contact_name: string | null;
  contact_phone: string;
  service_name: string | null;
}

export function getAppointmentsForSalonBetween(
  db: Database.Database,
  salon_id: string,
  from_unix: number,
  to_unix: number,
): DashboardAppointment[] {
  return db
    .prepare(
      `SELECT a.id, a.starts_at, a.ends_at, a.status,
              c.name AS contact_name, c.phone AS contact_phone,
              s.name AS service_name
         FROM appointments a
         JOIN contacts c ON a.contact_id = c.id
         LEFT JOIN services s ON a.service_id = s.id
        WHERE a.salon_id = ?
          AND a.starts_at >= ?
          AND a.starts_at < ?
          AND a.status IN ('confirmed', 'cancelled', 'no_show')
        ORDER BY a.starts_at ASC`,
    )
    .all(salon_id, from_unix, to_unix) as DashboardAppointment[];
}

export function getAppointmentById(
  db: Database.Database,
  appointment_id: string,
): Appointment | null {
  return (
    (db
      .prepare("SELECT * FROM appointments WHERE id = ?")
      .get(appointment_id) as Appointment) ?? null
  );
}

export function completePassedAppointments(db: Database.Database): number {
  const now = Math.floor(Date.now() / 1000);

  // RETURNING captures only the rows just transitioned (not ALL past completed).
  // This prevents visit_count from inflating every time the cron runs.
  const justCompleted = db
    .prepare(
      `
    UPDATE appointments SET status = 'completed'
    WHERE status IN ('confirmed', 'pending') AND ends_at < ?
    RETURNING contact_id
  `,
    )
    .all(now) as Array<{ contact_id: string }>;

  if (justCompleted.length > 0) {
    const placeholders = justCompleted.map(() => "?").join(",");
    const contactIds = justCompleted.map((r) => r.contact_id);
    db.prepare(
      `
      UPDATE contacts
      SET visit_count = visit_count + 1,
          last_visit = unixepoch()
      WHERE id IN (${placeholders})
    `,
    ).run(...contactIds);
  }

  return justCompleted.length;
}

export function getNextAppointmentForContact(
  db: Database.Database,
  contact_id: string,
): Appointment | null {
  return (
    (db
      .prepare(
        `
    SELECT * FROM appointments
    WHERE contact_id = ?
      AND status = 'confirmed'
      AND starts_at > unixepoch()
    ORDER BY starts_at ASC
    LIMIT 1
  `,
      )
      .get(contact_id) as Appointment) ?? null
  );
}

// ─── Campaigns ────────────────────────────────────────────────────────────────

export function createCampaign(
  db: Database.Database,
  data: {
    salon_id: string;
    contact_id: string;
    type?: "reactivation" | "promo" | "follow_up";
  },
): Campaign {
  const id = randomUUID();
  db.prepare(
    `
    INSERT INTO campaigns (id, salon_id, contact_id, type)
    VALUES (?, ?, ?, ?)
  `,
  ).run(id, data.salon_id, data.contact_id, data.type ?? "reactivation");
  return db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id) as Campaign;
}

export function hasRecentCampaign(
  db: Database.Database,
  contact_id: string,
  days: number = 30,
): boolean {
  const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
  const row = db
    .prepare(
      `
    SELECT 1 FROM campaigns
    WHERE contact_id = ? AND sent_at > ?
    LIMIT 1
  `,
    )
    .get(contact_id, cutoff);
  return !!row;
}

export function markCampaignResponded(
  db: Database.Database,
  campaign_id: string,
): void {
  db.prepare("UPDATE campaigns SET responded = 1 WHERE id = ?").run(
    campaign_id,
  );
}

export function markCampaignBooked(
  db: Database.Database,
  campaign_id: string,
): void {
  db.prepare("UPDATE campaigns SET responded = 1, booked = 1 WHERE id = ?").run(
    campaign_id,
  );
}

export function getCampaignStats(
  db: Database.Database,
  salon_id: string,
): {
  total: number;
  responded: number;
  booked: number;
} {
  // IFNULL(SUM(...), 0): SQLite SUM over zero rows returns NULL, which
  // violates the declared `number` return type and rendered as the literal
  // string "null" in the dueña-panel v1 stats footer ("null reactivadas").
  const row = db
    .prepare(
      `
    SELECT
      COUNT(*) as total,
      IFNULL(SUM(responded), 0) as responded,
      IFNULL(SUM(booked), 0) as booked
    FROM campaigns
    WHERE salon_id = ?
  `,
    )
    .get(salon_id) as { total: number; responded: number; booked: number };
  return row;
}
