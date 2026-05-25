/**
 * SQLite schema for salones-wa — multi-tenant WA bot
 * Applied once at startup via initDb()
 */
export const SCHEMA_SQL = /* sql */ `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- Salones (tenants)
-- phone        = WhatsApp line used WITH CLIENTAS (Baileys binds here)
-- owner_phone  = personal WhatsApp of the dueña, optional, used ONLY for
--                out-of-band service notifications (session disconnects,
--                daily summaries, etc). Never receives client traffic and
--                never gets bound to a Baileys session.
CREATE TABLE IF NOT EXISTS salons (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  phone       TEXT UNIQUE NOT NULL,
  owner_phone TEXT,
  timezone    TEXT NOT NULL DEFAULT 'America/Mexico_City',
  token       TEXT UNIQUE NOT NULL,       -- UUID auth token for web panel
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Servicios por salón
CREATE TABLE IF NOT EXISTS services (
  id           TEXT PRIMARY KEY,
  salon_id     TEXT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  duration_min INTEGER NOT NULL,
  price        INTEGER,
  active       INTEGER NOT NULL DEFAULT 1
);

-- Slots de horario disponible
CREATE TABLE IF NOT EXISTS slots (
  id          TEXT PRIMARY KEY,
  salon_id    TEXT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK(day_of_week BETWEEN 0 AND 6),
  start_time  TEXT NOT NULL,
  end_time    TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1
);

-- Contactos / clientas
CREATE TABLE IF NOT EXISTS contacts (
  id          TEXT PRIMARY KEY,
  salon_id    TEXT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  phone       TEXT NOT NULL,
  name        TEXT,
  visit_count INTEGER NOT NULL DEFAULT 0,
  last_visit  INTEGER,
  dormant     INTEGER NOT NULL DEFAULT 0,
  opt_out     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(salon_id, phone)
);

-- Citas
CREATE TABLE IF NOT EXISTS appointments (
  id           TEXT PRIMARY KEY,
  salon_id     TEXT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  contact_id   TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  service_id   TEXT REFERENCES services(id),
  starts_at    INTEGER NOT NULL,
  ends_at      INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'confirmed'
                 CHECK(status IN ('confirmed','cancelled','completed','no_show')),
  reminded_24h INTEGER NOT NULL DEFAULT 0,
  reminded_2h  INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_appointments_starts ON appointments(starts_at);
CREATE INDEX IF NOT EXISTS idx_appointments_salon_status ON appointments(salon_id, status);

-- Campañas de reactivación
CREATE TABLE IF NOT EXISTS campaigns (
  id         TEXT PRIMARY KEY,
  salon_id   TEXT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  type       TEXT NOT NULL DEFAULT 'reactivation'
               CHECK(type IN ('reactivation','promo','follow_up')),
  sent_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  responded  INTEGER NOT NULL DEFAULT 0,
  booked     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_campaigns_sent ON campaigns(salon_id, sent_at);
`;
