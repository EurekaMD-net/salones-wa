# Salones WA — Asistente de Citas por WhatsApp

> Bot de WhatsApp para salones de belleza: agenda citas, reactiva clientas dormidas y reduce cancelaciones.  
> Stack: Baileys · SQLite · Hono · TypeScript · VPS

---

## Los 3 productos del sistema

| # | Producto | Dolor que resuelve | Cuándo se activa |
|---|----------|--------------------|--------------------|
| 🥇 | **Asistente de Citas** | Dueña cortando → no responde → clienta se va | Inbound: clienta escribe primero |
| 🥈 | **Reactivación de Dormidas** | Clienta que vino 1-3x y desapareció (>30 días sin cita) | Outbound: cron semanal |
| 🥉 | **Anti-Cancelación** | Slot vacío de último minuto, cita olvidada | Outbound: cron 24h + 2h antes |

Los tres comparten una sola instancia de Baileys, una BD SQLite, y un panel web. **No son módulos separados — son flujos del mismo bot.**

---

## Arquitectura

```
Clientas (inbound)  ─────► Baileys (Node.js, mismo VPS)
                                  │
                                  ▼
                           Intent Parser (LLM Haiku + regex fallback)
                                  │
                                  ▼
                           SQLite DB (multi-tenant)
                      /salons / appointments / contacts
                      /slots / services / campaigns
                                  │
                  ┌───────────────┼───────────────┐
                  ▼               ▼               ▼
           Flujo Citas     Cron Anti-Cancel  Cron Reactivación
          (inbound 24/7)   (24h + 2h antes)  (semanal, dormidas)
                  └───────────────┼───────────────┘
                                  ▼
                           Web Panel (Hono @ :8085)
                        Agenda · Contactos · Campañas
```

---

## Stack técnico

| Capa | Tecnología | Razón |
|------|-----------|-------|
| WA | **Baileys** | Cero costo, arranque en horas |
| HTTP/Panel | **Hono** | Lightweight, mismo patrón que mission-control |
| BD | **SQLite** (separada de mc.db) | Multi-tenant simple, sin deps externas |
| LLM intents | **Claude Haiku** | ~$0.001/mensaje, con regex fallback |
| Crons | **node-cron** | Mismo patrón del VPS |
| Despliegue | **systemd** | Mismo patrón que mission-control |
| Puerto panel | **8085** | Ya abierto en UFW, sin cambios de firewall |

---

## Estructura del proyecto

```
salones-wa/
├── src/
│   ├── bot/           # Baileys connection + message handler
│   ├── intents/       # Intent parser (LLM + regex)
│   ├── db/            # SQLite schema + queries
│   ├── crons/         # remind-24h, remind-2h, reactivation, mark-completed
│   ├── panel/         # Hono web panel (agenda, contactos, campañas)
│   └── index.ts       # Entry point
├── data/
│   ├── salones.db     # SQLite DB (gitignored)
│   └── sessions/      # Baileys session files (gitignored)
├── docs/
│   ├── MVP-PLAN.md    # Plan completo del MVP
│   ├── SCHEMA.md      # Schema SQLite documentado
│   └── FLUJOS.md      # Flujos de conversación
├── package.json
├── tsconfig.json
└── README.md
```

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

### Flujo 2 — Reactivación (outbound, cron lunes 10am)
```
Condición: last_visit > 30 días, sin cita futura, al menos 1 cita completada
Bot:       "Hola [nombre] 👋 Hace un tiempo que no te vemos por el salón.
            ¿Cómo estás? Esta semana tenemos lugares disponibles —
            ¿te agendo algo? Solo dime qué necesitas 💇‍♀️"
Clienta:   "Sí! Quiero tinte"
→ Activa Flujo 1 normalmente
```

### Flujo 3 — Anti-cancelación (outbound)
```
[24h antes]
Bot:  "Hola [nombre] 😊 Te recuerdo que mañana tienes cita a las 10:00am
       para Corte. ¿Confirmas que vienes? Responde SÍ o CANCELAR"

[2h antes — solo si no confirmó]
Bot:  "Recordatorio rápido: tu cita es hoy a las 10:00am.
       ¿Sigues viniendo? Cualquier cambio de último minuto, avísanos"
```

---

## Schema SQLite

```sql
salons          -- Tenants (uno por salón)
services        -- Servicios y duración por salón
slots           -- Horario disponible por día de semana
contacts        -- Clientas: phone, last_visit, dormant flag
appointments    -- Citas: status confirmed|cancelled|completed|no_show
campaigns       -- Reactivaciones: sent_at, responded, booked
```

Ver `docs/SCHEMA.md` para el DDL completo.

---

## Cron Jobs

| Job | Schedule | Acción |
|-----|----------|--------|
| `remind-24h` | Cada hora | Busca citas en 24-25h → envía recordatorio |
| `remind-2h` | Cada 30 min | Busca citas en 2-3h sin confirmación |
| `mark-completed` | Cada hora | Marca como `completed` citas pasadas |
| `update-dormant` | Diario 00:00 | Actualiza flag `dormant` en contacts |
| `reactivation-campaign` | Lunes 10:00am | Detecta dormidas → dispara outbound |

---

## Modelo de valor para el cliente

```
Asistente de Citas:        Citas agendadas mientras duermes → no pierdes clientas
Anti-cancelación:          -20% no-shows → 2-4 slots recuperados/semana → $400-800 MXN/sem
Reactivación de dormidas:  1 clienta reactivada/semana → $200-400 MXN extra
─────────────────────────────────────────────────────────────────────────────────
Total valor generado:      ~$1,200-2,000 MXN/semana por salón
Precio del servicio:       $500-800/mes
ROI para la dueña:         5x-10x en valor recuperado
```

---

## Fases de desarrollo

| Semana | Focus | Verificación |
|--------|-------|-------------|
| **1-2** | Bot core + anti-cancel | Cita agendada por WA + 2 recordatorios enviados |
| **2** | Reactivación (paralelo) | Cron corre, al menos 1 respuesta genera cita |
| **3** | Panel web | Dueña ve agenda desde su celular |
| **4** | Multi-tenant | 2 salones en paralelo sin interferencia |
| **5+** | Ventas | Cold outreach Iztapalapa, primer pago |

---

## Riesgos principales

| Riesgo | Mitigación |
|--------|-----------|
| WhatsApp banea número | Delays humanos, número secundario para dev, rate limit 20 msgs/h |
| Dueña no sabe escanear QR | Video tutorial 60s, soporte onboarding |
| Clienta molesta por outbound | Solo contactar con historial real, máx 1x/mes, opt-out inmediato |
| Pérdida de sesión WA | Auto-reconexión, alerta admin si falla 3 veces |

---

## Mercado objetivo

| Métrica | Dato |
|---------|------|
| Salones en CDMX | **23,337** (SCIAN 812110, DENUE) |
| Alcaldía líder | Iztapalapa — 5,224 (22.4%) |
| Target piloto | Iztapalapa (densidad + acceso) |
| Precio | $500–$800/mes por salón |
| TAM CDMX @ 1% | ~$116,685/mes |

### Expansión potencial (giros afines)
| Giro | Unidades CDMX | TAM @ 1% |
|------|--------------|----------|
| Consultorios dentales | 7,257 | $43,542/mes |
| Talleres mecánicos | 5,565 | $33,390/mes |
| Lavanderías | 5,261 | $31,566/mes |
| **Total 6 giros** | **49,079** | **~$294K/mes** |

---

## Estado actual

- **Fase:** Pre-desarrollo — plan aprobado
- **Decisiones tomadas:** Baileys · SQLite · Web panel · mismo VPS
- **Próximo paso:** `npm init` + conexión Baileys + schema inicial

---

*Proyecto: Negocios Auto-Gestionados · Vertical: Salones de Belleza*  
*Iniciado: 2026-05-23*
