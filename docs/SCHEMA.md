# Schema SQLite — Salones WA

**DB path:** `/root/claude/projects/salones-wa/data/salones.db`  
**Patrón:** Multi-tenant — cada salón tiene sus propios registros aislados por `salon_id`

---

## DDL Completo

```sql
-- Salones (tenants)
CREATE TABLE salons (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,       -- número WA del salón (con código de país: 521XXXXXXXXXX)
  timezone TEXT DEFAULT 'America/Mexico_City',
  active INTEGER DEFAULT 1,
  panel_token TEXT UNIQUE NOT NULL, -- UUID para auth del panel web
  created_at INTEGER DEFAULT (unixepoch())
);

-- Servicios por salón
CREATE TABLE services (
  id TEXT PRIMARY KEY,
  salon_id TEXT REFERENCES salons(id),
  name TEXT NOT NULL,               -- "Corte", "Tinte", "Manicure", "Pedicure"
  duration_min INTEGER NOT NULL,    -- 30, 60, 90, 120
  price INTEGER,                    -- en MXN (opcional, referencial)
  active INTEGER DEFAULT 1
);

-- Slots de horario disponible (patrón semanal)
CREATE TABLE slots (
  id TEXT PRIMARY KEY,
  salon_id TEXT REFERENCES salons(id),
  day_of_week INTEGER NOT NULL,     -- 0=Dom, 1=Lun, 2=Mar, 3=Mié, 4=Jue, 5=Vie, 6=Sáb
  start_time TEXT NOT NULL,         -- "09:00" (HH:MM, 24h)
  end_time TEXT NOT NULL,           -- "18:00"
  active INTEGER DEFAULT 1
);

-- Contactos / clientas
CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  salon_id TEXT REFERENCES salons(id),
  phone TEXT NOT NULL,              -- número WA de la clienta
  name TEXT,                        -- nombre extraído de conversación o ingresado manualmente
  visit_count INTEGER DEFAULT 0,    -- total de citas completadas
  last_visit INTEGER,               -- unixepoch de la última cita status='completed'
  dormant INTEGER DEFAULT 0,        -- 1 si last_visit > 30 días Y sin cita futura activa
  opt_out INTEGER DEFAULT 0,        -- 1 si la clienta pidió no recibir mensajes outbound
  created_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(salon_id, phone)
);

-- Citas
CREATE TABLE appointments (
  id TEXT PRIMARY KEY,
  salon_id TEXT REFERENCES salons(id),
  contact_id TEXT REFERENCES contacts(id),
  service_id TEXT REFERENCES services(id),
  starts_at INTEGER NOT NULL,       -- unixepoch
  ends_at INTEGER NOT NULL,         -- starts_at + (service.duration_min * 60)
  status TEXT DEFAULT 'confirmed',  -- confirmed | cancelled | completed | no_show
  reminded_24h INTEGER DEFAULT 0,   -- 1 cuando se envió el recordatorio de 24h
  reminded_2h INTEGER DEFAULT 0,    -- 1 cuando se envió el recordatorio de 2h
  confirmed_by_client INTEGER DEFAULT 0, -- 1 si la clienta respondió "SÍ" al recordatorio
  created_at INTEGER DEFAULT (unixepoch()),
  cancelled_at INTEGER              -- timestamp si status='cancelled'
);

-- Campañas de reactivación
CREATE TABLE campaigns (
  id TEXT PRIMARY KEY,
  salon_id TEXT REFERENCES salons(id),
  contact_id TEXT REFERENCES contacts(id),
  type TEXT DEFAULT 'reactivation', -- reactivation | promo | follow_up
  sent_at INTEGER DEFAULT (unixepoch()),
  responded INTEGER DEFAULT 0,      -- 1 si la clienta respondió
  responded_at INTEGER,
  booked INTEGER DEFAULT 0,         -- 1 si la respuesta generó una cita
  booked_appointment_id TEXT REFERENCES appointments(id)
);

-- Índices para queries frecuentes
CREATE INDEX idx_appointments_salon_starts ON appointments(salon_id, starts_at);
CREATE INDEX idx_appointments_status ON appointments(status);
CREATE INDEX idx_contacts_salon_dormant ON contacts(salon_id, dormant);
CREATE INDEX idx_campaigns_salon_sent ON campaigns(salon_id, sent_at);
```

---

## Convenciones

- **IDs**: UUID v4 (generados en código, no auto-increment para portabilidad)
- **Timestamps**: `unixepoch()` en SQLite = segundos desde epoch UTC
- **Booleanos**: `INTEGER` 0/1 (SQLite no tiene tipo BOOLEAN nativo)
- **Teléfonos**: formato internacional sin `+` → `521XXXXXXXXXX` (México) 
- **Horarios**: `HH:MM` 24h en texto plano; la lógica de timezone vive en código

---

## Queries operacionales clave

### Citas del día para un salón
```sql
SELECT a.*, c.name, c.phone, s.name as service_name
FROM appointments a
JOIN contacts c ON a.contact_id = c.id
JOIN services s ON a.service_id = s.id
WHERE a.salon_id = ? 
  AND a.starts_at >= unixepoch('now', 'start of day')
  AND a.starts_at < unixepoch('now', 'start of day', '+1 day')
  AND a.status = 'confirmed'
ORDER BY a.starts_at;
```

### Contactos dormidos para reactivar (cron semanal)
```sql
SELECT c.*
FROM contacts c
WHERE c.salon_id = ?
  AND c.dormant = 1
  AND c.opt_out = 0
  AND c.visit_count >= 1
  AND NOT EXISTS (
    SELECT 1 FROM campaigns cam
    WHERE cam.contact_id = c.id
      AND cam.type = 'reactivation'
      AND cam.sent_at > unixepoch('now', '-30 days')
  )
LIMIT 20; -- rate limit: máx 20 outbound por ejecución
```

### Citas próximas a recordar (24h)
```sql
SELECT a.*, c.phone, c.name, s.name as service_name
FROM appointments a
JOIN contacts c ON a.contact_id = c.id
JOIN services s ON a.service_id = s.id
WHERE a.salon_id = ?
  AND a.status = 'confirmed'
  AND a.reminded_24h = 0
  AND a.starts_at BETWEEN unixepoch('now', '+23 hours') AND unixepoch('now', '+25 hours');
```

### Citas próximas a recordar (2h)
```sql
SELECT a.*, c.phone, c.name, s.name as service_name
FROM appointments a
JOIN contacts c ON a.contact_id = c.id
JOIN services s ON a.service_id = s.id
WHERE a.salon_id = ?
  AND a.status = 'confirmed'
  AND a.reminded_2h = 0
  AND a.confirmed_by_client = 0
  AND a.starts_at BETWEEN unixepoch('now', '+90 minutes') AND unixepoch('now', '+150 minutes');
```

---

*Schema v1 · 2026-05-23*
