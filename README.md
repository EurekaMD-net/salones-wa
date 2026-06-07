# Salones WA — Asistente de Citas por WhatsApp

> Bot de WhatsApp para salones de belleza: agenda citas, reactiva clientas dormidas y reduce cancelaciones.  
> Stack: Baileys · SQLite · Hono · TypeScript · VPS

---

## Estado del proyecto

| Métrica           | Valor                                                            |
| ----------------- | ---------------------------------------------------------------- |
| **Fase**          | **En producción** — Salón Demo en vivo (525640501088)            |
| **Tests**         | **257 / 257 ✅**                                                 |
| **Typecheck**     | 0 errores                                                        |
| **Último commit** | 2026-06-04                                                       |
| **Servicio**      | `salones-wa` (systemd, usuario dedicado, bind `127.0.0.1:8085`)  |
| **URL pública**   | `https://gilda.mx` (landing) · `https://app.gilda.mx` (servicio) |
| **Admin panel**   | `https://app.gilda.mx/admin?token=<ADMIN_TOKEN>`                 |

---

## Los 3 productos del sistema

| #   | Producto                     | Dolor que resuelve                                      | Cuándo se activa                 |
| --- | ---------------------------- | ------------------------------------------------------- | -------------------------------- |
| 🥇  | **Asistente de Citas**       | Dueña cortando → no responde → clienta se va            | Inbound: clienta escribe primero |
| 🥈  | **Reactivación de Dormidas** | Clienta que vino 1-3x y desapareció (>30 días sin cita) | Outbound: cron lunes 10am        |
| 🥉  | **Anti-Cancelación**         | Slot vacío de último minuto, cita olvidada              | Outbound: cron 24h + 2h antes    |

Los tres comparten una sola instancia de Baileys, una BD SQLite, y un panel web. **No son módulos separados — son flujos del mismo bot.**

---

## Arquitectura

```
Clientas (inbound)  ─────► Baileys (Node.js, mismo VPS)
                                  │
                                  ▼
                           Intent Parser (regex — 8 intents)
                                  │
                                  ▼
                           Message Handler
                                  │
                                  ▼
                           SQLite DB (multi-tenant)
                      salons / services / contacts
                      appointments / campaigns
                                  │
                  ┌───────────────┼───────────────┐
                  ▼               ▼               ▼
           Flujo Citas     Cron Anti-Cancel  Cron Reactivación
          (inbound 24/7)   (24h + 2h antes)  (lunes 10am)
                  └───────────────┼───────────────┘
                                  ▼
                           Web Panel (Hono @ :8085)
                     /panel/* — Agenda · Contactos · Campañas
                     /admin/* — Alta/baja salones · Servicios
```

---

## Stack técnico

| Capa          | Tecnología                         | Razón                                         |
| ------------- | ---------------------------------- | --------------------------------------------- |
| WA            | **Baileys**                        | Cero costo, arranque en horas                 |
| HTTP/Panel    | **Hono**                           | Lightweight, mismo patrón que mission-control |
| BD            | **SQLite** (separada de mc.db)     | Multi-tenant simple, sin deps externas        |
| Intent Parser | **Regex** (8 intents, sin LLM)     | Cero latencia, cero costo, determinístico     |
| Crons         | **node-cron**                      | Mismo patrón del VPS                          |
| Puerto panel  | **8085**                           | Ya abierto en UFW, sin cambios de firewall    |
| Runtime       | **tsx** (dev) / **Node.js** (prod) | ESM nativo, TypeScript directo                |

---

## Estructura del proyecto

```
salones-wa/
├── src/
│   ├── bot/
│   │   ├── baileys-manager.ts      # Conexión WA + stub para dev/test
│   │   ├── conversation-state.ts   # State machine en memoria, TTL 30min
│   │   ├── intent-parser.ts        # Parser regex — 8 intents
│   │   ├── message-handler.ts      # Handler principal — recibe texto, devuelve reply
│   │   └── messages.ts             # Copy del bot centralizado
│   ├── crons/
│   │   └── index.ts                # 6 jobs: remind-24h, remind-2h, mark-completed,
│   │                               #         update-dormant, reactivation-campaign, state-eviction
│   ├── db/
│   │   ├── database.ts             # Singleton getDb() + initDb(':memory:') para tests
│   │   ├── models.ts               # Queries tipadas — salons, services, contacts, appointments, campaigns
│   │   └── schema.ts               # DDL SQLite — 6 tablas + índices
│   ├── web/
│   │   ├── panel.ts                # /panel/* — dashboard, contactos, campañas (auth: salon token)
│   │   ├── panel.test.ts           # 24 tests
│   │   ├── admin.ts                # /admin/* — CRUD + borrado de salones + servicios (auth: ADMIN_TOKEN)
│   │   └── admin.test.ts           # 51 tests (incluye pins P0-1 + borrado de salón)
│   └── index.ts                    # Entry point + graceful shutdown
├── tests/
│   ├── intent-parser.test.ts       # 39 tests
│   ├── models.test.ts              # 44 tests  (includes P0-2 idempotence pin + deleteSalon cascade)
│   ├── message-handler.test.ts     # 33 tests
│   ├── conversation-state.test.ts  # 6 tests
│   ├── web-panel.test.ts           # 9 tests
│   ├── slot-finder.test.ts         # 22 tests  (working-hours + conflicts + alternatives)
│   ├── datetime-parser.test.ts     # 24 tests  (Spanish day+time parser + audit C1/W2 pins)
│   ├── date-extract.test.ts        # 18 tests
│   ├── baileys-state.test.ts       # 40 tests  (liveness watchdog + conn-state registry)
│   ├── baileys-manager.test.ts     # 2 tests   (removeBaileysForSalon teardown)
│   └── observability.test.ts       # 15 tests  (/health/salons + /metrics)
│                                   # (admin.test.ts + panel.test.ts colocados en src/web/)
├── docs/
│   ├── MVP-PLAN.md                 # Plan completo del MVP
│   ├── SCHEMA.md                   # Schema SQLite documentado
│   └── FLUJOS.md                   # Flujos de conversación
├── data/                           # gitignored — salones.db + sessions/
├── package.json
├── tsconfig.json
└── README.md
```

---

## Intents del parser

| Intent              | Cuándo se activa                                   |
| ------------------- | -------------------------------------------------- |
| `book`              | Quiero cita, agendar, corte, tinte, manicure...    |
| `cancel`            | Cancelar, no puedo, no voy...                      |
| `reschedule`        | Cambiar mi cita, reagendar, mover, modificar...    |
| `confirm`           | Sí, confirmo, dale, ok...                          |
| `query_appointment` | Mi cita, cuándo, a qué hora...                     |
| `opt_out`           | Stop, baja, no me mandes mensajes...               |
| `reactivation_yes`  | Sí, claro, quiero, dale... (contexto reactivación) |
| `reactivation_no`   | No, ahorita no, después... (contexto reactivación) |

El contexto (`'reactivation'`) se pasa cuando la conversación está en estado `reactivation_sent` para que `sí` resuelva como `reactivation_yes` y no como `confirm`.

---

## Flujos de conversación

### Flujo 1 — Agendar cita (inbound)

```
Clienta:  "Hola, quiero cita para corte"
Bot:      "¡Hola! 👋 ¿Para cuándo? Tenemos disponible:
           1️⃣ Sábado 28 de mayo — 10:00am
           2️⃣ Sábado 28 de mayo — 2:00pm
           3️⃣ Lunes 30 de mayo — 9:00am
           Responde 1, 2 o 3 para apartar tu lugar"
Clienta:  "1"
Bot:      "✅ Listo! Tu cita es el sábado 28 a las 10:00am para corte.
           Te recordaré 24h antes. ¿Cambias algo?"
```

### Flujo 2 — Anti-cancelación (outbound, crons)

```
[24h antes]
Bot:  "Hola [nombre] 😊 Te recuerdo que mañana tienes cita a las 10:00am
       para Corte. ¿Confirmas que vienes? Responde SÍ o CANCELAR"

[2h antes — solo si no confirmó]
Bot:  "Recordatorio rápido: tu cita es hoy a las 10:00am.
       ¿Sigues viniendo? Cualquier cambio de último minuto, avísanos"
```

### Flujo 3 — Reactivación (outbound, cron lunes 10am)

```
Condición: last_visit > 30 días, sin cita futura, al menos 1 cita completada
Bot:       "Hola [nombre] 👋 Hace un tiempo que no te vemos por el salón.
            ¿Cómo estás? Esta semana tenemos lugares disponibles —
            ¿te agendo algo? Solo dime qué necesitas 💇‍♀️"
Clienta:   "Sí! Quiero tinte"
→ Activa Flujo 1 normalmente
```

---

## Schema SQLite

```sql
salons          -- Tenants (uno por salón), token UUID para panel auth
services        -- Servicios y duración por salón
contacts        -- Clientas: phone, visit_count, last_visit, dormant, opt_out
appointments    -- Citas: status confirmed|cancelled|completed|no_show
                --        reminded_24h, reminded_2h flags
campaigns       -- Reactivaciones: sent_at, responded, booked
```

Ver `docs/SCHEMA.md` para el DDL completo.

---

## Cron Jobs

| Job                     | Schedule                     | Acción                                                                                                                   |
| ----------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `remind-24h`            | `5 * * * *` (cada hora)      | Busca citas en 24-25h → envía recordatorio                                                                               |
| `remind-2h`             | `*/30 * * * *` (cada 30 min) | Busca citas en 2-3h sin confirmación                                                                                     |
| `mark-completed`        | `10 * * * *` (cada hora)     | Marca como `completed` citas pasadas                                                                                     |
| `update-dormant`        | `15 0 * * *` (diario 00:15)  | Actualiza flag `dormant` en contacts                                                                                     |
| `reactivation-campaign` | `0 10 * * 1` (lunes 10am)    | Detecta dormidas → dispara outbound, máx 20 msgs/h                                                                       |
| `state-eviction`        | `*/30 * * * *` (cada 30 min) | Limpia conversation states con TTL expirado                                                                              |
| `disconnect-watch`      | `0 9 * * *` (diario 9am)     | Loggea WARN si un salón lleva su sesión WA caída > umbral (default 24h). NO envía nada — mc-prometheus dispara la alerta |

---

## Panel web (puerto 8085)

Auth por token UUID en URL (`?token=<salon-uuid>`). Sin login, sin OAuth — funciona en 3G.

| Ruta                          | Descripción                                                            |
| ----------------------------- | ---------------------------------------------------------------------- |
| `GET /health`                 | Health check público (liveness, sin detalle)                           |
| `GET /panel/dashboard?token=` | Citas de hoy + estadísticas + contactos dormidos                       |
| `GET /panel/contacts?token=`  | Lista de contactos con filtros                                         |
| `GET /panel/campaigns?token=` | Historial y métricas de campañas de reactivación                       |
| `GET /api/stats?token=`       | JSON con métricas del salón                                            |
| `GET /health/salons?token=`   | Estado Baileys por salón (JSON). **Gated: ADMIN_TOKEN**                |
| `GET /metrics?token=`         | Exposición Prometheus (`salones_wa_baileys_*`). **Gated: ADMIN_TOKEN** |

### Observabilidad (estado de la conexión WhatsApp)

`/health/salons` y `/metrics` exponen el estado Baileys de cada salón activo
(`connected` / `reconnecting` / `logged_out` / `connecting` / `unknown`), cuánto
lleva caído, y la última conexión. Ambos endpoints están **protegidos por
`ADMIN_TOKEN`** (igual que `/admin`) y rate-limited por IP — el panel se sirve
público vía Caddy, así que sin token devuelven 401.

- **mc-prometheus** raspa `/metrics` y dispara la alerta de "salón caído > 24h"
  vía su cláusula `for:` (sobrevive a reinicios de este servicio). Ver la guía de
  wiring en `docs/RUNBOOK-baileys-resilience.md` §7.
- El cron `disconnect-watch` (diario 9am MX) sólo deja un WARN en journalctl — la
  alerta real la dispara mc, no este servicio.
- Umbral configurable con `SALON_DISCONNECT_ALERT_HOURS` (default 24).

---

## Variables de entorno

```bash
PORT=8085              # Puerto del panel web (default: 8085)
DB_PATH=./data/salones.db  # Ruta SQLite (default: ./data/salones.db)
SESSIONS_DIR=./data/sessions  # Sesiones Baileys (default: ./data/sessions)
ADMIN_TOKEN=...        # Requerido, ≥16 chars. Protege /admin, /metrics, /health/salons
PUBLIC_APP_URL=https://app.gilda.mx  # Base pública para los links del panel de la dueña
                       # (default: http://localhost:<PORT>). Sin esto, el admin muestra
                       # "localhost" y un aviso para reemplazarlo antes de compartir.
SALON_DISCONNECT_ALERT_HOURS=24  # Umbral "salón caído" para disconnect-watch + /metrics (default 24, mín 1)
# Liveness watchdog (auto-reconecta sockets Baileys atorados):
BAILEYS_WATCHDOG_ENABLED=true        # Kill switch (default on; "false" lo apaga)
BAILEYS_RECONNECT_STUCK_MINUTES=5    # Min no-conectado antes de forzar reconexión (default 5)
BAILEYS_RECONNECT_MAX_STRIKES=5      # Reintentos antes de rendirse por salón (default 5, regla 3-strike)
```

---

## Modelo de valor para el cliente

```
Asistente de Citas:        Citas agendadas mientras duermes → no pierdes clientas
Anti-cancelación:          -20% no-shows → 2-4 slots recuperados/semana → $400-800 MXN/sem
Reactivación de dormidas:  1 clienta reactivada/semana → $200-400 MXN extra
─────────────────────────────────────────────────────────────────────────────────────────
Total valor generado:      ~$600-1,200 MXN/semana por salón
Precio del servicio:       $500-800/mes
ROI para la dueña:         5x-10x en valor recuperado vs precio
```

---

## Riesgos y mitigaciones

| Riesgo                                              | Mitigación                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| WhatsApp banea número                               | Delays aleatorios (2-5s), número secundario para dev, rate limit 20 msgs/h                       |
| WhatsApp rechaza vínculo desde VPS (data-center IP) | **Pairing code** preferido sobre QR — ver "Vincular número WA" abajo. QR funciona como fallback. |
| Dueña no sabe escanear QR ni código                 | Pairing code = 8 dígitos, copia-pega en WA. Video tutorial 60s.                                  |
| Clienta molesta por outbound                        | Solo contactar con historial real, máx 1x/mes por contacto, opt-out inmediato                    |
| Pérdida de sesión WA                                | Auto-reconexión en `baileys-manager.ts` (3 intentos), log de desconexión                         |

---

## Mercado objetivo

| Métrica         | Dato                             |
| --------------- | -------------------------------- |
| Salones en CDMX | **23,337** (SCIAN 812110, DENUE) |
| Alcaldía líder  | Iztapalapa — 5,224 (22.4%)       |
| Target piloto   | Iztapalapa (densidad + acceso)   |
| Precio          | $500–$800/mes por salón          |
| TAM CDMX @ 1%   | ~$116,685/mes                    |

### Expansión potencial (giros afines)

| Giro                  | Unidades CDMX | TAM @ 1%       |
| --------------------- | ------------- | -------------- |
| Consultorios dentales | 7,257         | $43,542/mes    |
| Talleres mecánicos    | 5,565         | $33,390/mes    |
| Lavanderías           | 5,261         | $31,566/mes    |
| **Total 6 giros**     | **49,079**    | **~$294K/mes** |

---

## Fases de desarrollo

| Semana  | Focus                                         | Estado                                                                                        |
| ------- | --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **1-2** | Bot core + anti-cancel + reactivación         | ✅ **COMPLETO** — 88 tests                                                                    |
| **2b**  | Admin UI — alta/baja salones, servicios       | ✅ **COMPLETO** — 109 tests                                                                   |
| **2c**  | Hardening seguridad + systemd + deploy en VPS | ✅ **COMPLETO** — en producción 2026-05-23                                                    |
| **3**   | Piloto real: conectar número WA, primer salón | 🔜 **SIGUIENTE** — admin panel listo                                                          |
| **4**   | Panel web refinado (feedback de uso real)     | 🟡 En progreso — horario por salón, parser de fechas robusto, anti-doble-reserva (2026-06-04) |
| **5**   | Multi-tenant (2+ salones en paralelo)         | ⏳ Pendiente                                                                                  |
| **6+**  | Cold outreach Iztapalapa, primer pago         | ⏳ Pendiente                                                                                  |

---

## Admin Panel — Alta de salones

El panel de administración vive en `/admin` (mismo puerto 8085). Autenticado por `ADMIN_TOKEN` env var.

```bash
# Variables de entorno requeridas
ADMIN_TOKEN=tu-token-secreto   # protege /admin
PORT=8085                       # ya abierto en UFW
DB_PATH=./data/salones.db
SESSIONS_DIR=./data/sessions
```

### Flujo de alta de un salón

1. **Navegar a** `http://<vps-ip>:8085/admin?token=TU_ADMIN_TOKEN`
2. Click en **"+ Nuevo salón"**
3. Llenar nombre, **WhatsApp del salón** (la línea que la dueña ya usa con sus clientas — ej: `525555555555`) y servicios iniciales. NO es un número aparte del bot: el bot se conecta como dispositivo vinculado a este WhatsApp existente del salón.
4. Al crear → el sistema muestra la **URL del panel para la dueña**
5. Compartir esa URL con la dueña (se accede desde cualquier celular, sin app)
6. **Reiniciar el servicio** (`systemctl restart salones-wa`) para que Baileys cargue el nuevo salón
7. Vincular el número WA — ver "Vincular número WA" abajo

### Vincular número WA — pairing code (preferido) o QR

El servicio emite **dos métodos** de vínculo al iniciar para cada salón sin sesión:

- **Pairing code (recomendado para VPS / data-center)**: 8 dígitos que se ingresan directamente en WhatsApp. WhatsApp's QR-link flow rechaza cada vez más conexiones desde IPs de data center (`"At this moment you can't add new devices"`). El pairing code usa otro backend y suele pasar.
- **QR** como fallback, por si el pairing code falla en algún número.

```bash
# 1. Capturar el código en journalctl tras restart o creación de salón
journalctl -u salones-wa -f | grep -E "Pairing code|QR for salon"
# → [salones-wa] Pairing code for salon <id>: ABCD-EFGH

# 2. En el teléfono con el número WA del salón:
#    WhatsApp → ⋮ → Dispositivos vinculados →
#    "Vincular un dispositivo" → "Vincular con número de teléfono"
#    → ingresar el código de 8 dígitos
```

El código expira en ~60s. Si expira, el servicio emite uno nuevo automáticamente.

Una vez vinculado: `[baileys] [<phone>] connected ✅` en journalctl y archivos de sesión en `data/sessions/<salonId>/`.

### Rutas del admin

| Ruta                                             | Descripción                                                                                                       |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `GET /admin`                                     | Lista todos los salones                                                                                           |
| `GET /admin/salones/new`                         | Formulario crear salón                                                                                            |
| `POST /admin/salones`                            | Crear salón + servicios                                                                                           |
| `GET /admin/salones/:id`                         | Editar nombre, teléfono, servicios, horario                                                                       |
| `POST /admin/salones/:id/edit`                   | Guardar cambios                                                                                                   |
| `POST /admin/salones/:id/hours`                  | Guardar horario de atención (un turno por día; sin días marcados = horario por defecto Lun-Sáb 9-19)              |
| `POST /admin/salones/:id/toggle`                 | Activar / desactivar (reversible)                                                                                 |
| `GET /admin/salones/:id/delete`                  | Pantalla de confirmación de borrado permanente (muestra qué se eliminará)                                         |
| `POST /admin/salones/:id/delete`                 | Eliminar salón **permanentemente** — requiere escribir el nombre; cascada a todos sus datos + desconecta WhatsApp |
| `POST /admin/salones/:id/services`               | Agregar servicio                                                                                                  |
| `POST /admin/salones/:id/services/:svcId/delete` | Eliminar servicio                                                                                                 |

---

## Quick start (desarrollo)

```bash
# Instalar deps
npm install

# Ejecutar tests
npm test            # 327/327 ✅

# Typecheck
npm run typecheck   # 0 errores

# Levantar en dev (bind a 0.0.0.0 para acceso local directo)
ADMIN_TOKEN=admin123 BIND_HOST=0.0.0.0 npm run dev

# Admin panel en: http://localhost:8085/admin?token=admin123
# Crear primer salón desde el panel → obtener URL para dueña
# Vincular WA: pairing code (preferido) o QR — ver sección "Vincular número WA"
```

## Deployment (producción)

### Estado actual — **EN PRODUCCIÓN** (2026-05-23)

El servicio está instalado como systemd unit y corriendo en el VPS:

```bash
systemctl status salones-wa   # → active (running)
curl https://app.gilda.mx/health  # → {"ok":true}
```

| Recurso      | URL                                              |
| ------------ | ------------------------------------------------ |
| Health check | `https://app.gilda.mx/health`                    |
| Admin panel  | `https://app.gilda.mx/admin?token=<ADMIN_TOKEN>` |

**Próximo paso:** crear primer salón en el admin panel → reiniciar servicio → vincular número WA con pairing code (ver sección "Vincular número WA").

---

El servicio se enlaza a `127.0.0.1:8085` por default. Expuesto públicamente vía Caddy con nip.io (wildcard TLS automático, sin configurar DNS propio).

### Exponer vía Caddy (dominio propio)

**Prerequisito:** DNS `salones.mycommit.net` apuntando a la IP del VPS.

```
# Agregar al Caddyfile:
salones.mycommit.net {
    reverse_proxy localhost:8085
}
```

Para acceso temporal sin DNS: `BIND_HOST=0.0.0.0` en `.env` (NO recomendado para producción permanente).

### Systemd unit (ya instalado en `/etc/systemd/system/salones-wa.service`)

```ini
[Unit]
Description=Salones WA — Asistente de citas WhatsApp
After=network.target

[Service]
Type=simple
WorkingDirectory=/root/claude/projects/salones-wa
EnvironmentFile=/root/claude/projects/salones-wa/.env
ExecStart=/root/claude/projects/salones-wa/node_modules/.bin/tsx src/index.ts
Restart=always
RestartSec=5
UMask=0077
StandardOutput=journal
StandardError=journal
SyslogIdentifier=salones-wa
User=salones-wa
Group=salones-wa

[Install]
WantedBy=multi-user.target
```

### C4 — Usuario dedicado (ya ejecutado en 2026-05-23)

```bash
# Completado — usuario salones-wa (uid=997) existe
# data/ ownership: salones-wa:salones-wa
# Permisos: DB→600, sessions/→700, .env→600

# Para reinstalar desde cero en otro VPS:
useradd -r -s /bin/false -d /root/claude/projects/salones-wa salones-wa
chown -R salones-wa:salones-wa /root/claude/projects/salones-wa/data/
cp salones-wa.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now salones-wa
```

---

_Proyecto: Negocios Auto-Gestionados · Vertical: Salones de Belleza_  
_Iniciado: 2026-05-23 · MVP construido: 2026-05-23_
