# MVP Plan — Asistente de Citas WA para Salones de Belleza

**Stack:** Baileys · SQLite · Web UI ligera · Node.js/TypeScript  
**Decisiones fijas:** No piloto previo · Arranque desde cero · Web panel (no Sheets) · BD SQLite  
**Creado:** 2026-05-23  
**Versión:** v2 — 3 productos integrados  
**Estado:** PLAN APROBADO — pendiente arranque de desarrollo

---

## Los 3 productos del MVP (un solo sistema)

| # | Producto | Dolor que resuelve | Cuándo se activa |
|---|----------|--------------------|--------------------|
| 🥇 | **Asistente de Citas** | Dueña cortando → no responde → clienta se va | Inbound: clienta escribe primero |
| 🥈 | **Reactivación de Dormidas** | Clienta que vino 1-3x y desapareció (>30 días sin cita) | Outbound: cron semanal |
| 🥉 | **Anti-Cancelación** | Slot vacío de último minuto, cita olvidada | Outbound: cron 24h + 2h antes |

Los tres comparten la misma BD, la misma instancia de Baileys y el mismo panel web. **No son módulos separados — son flujos del mismo bot.**

---

## Visión del producto

Un bot de WhatsApp que vive en el número del salón:
1. **Agenda citas** cuando llegan mensajes inbound
2. **Recuerda citas** 24h y 2h antes → reduce cancelaciones y no-shows
3. **Reactiva clientas** perdidas automáticamente sin que la dueña haga nada

La dueña solo ve el panel web. El bot trabaja 24/7.

---

## Stack técnico definitivo

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
                           Web Panel (Hono)
                        Agenda · Contactos · Campañas
```

**Por qué este stack:**
- Baileys = cero costo por mensaje, arranque en horas no semanas
- SQLite = multi-tenant simple, el mismo patrón del VPS actual
- Web panel = diferenciador comercial $600-$800/mes
- Mismo VPS mission-control = $0 de infra adicional

---

## Fases del MVP

### Fase 1 — Core Bot (Semana 1-2)

**Objetivo:** Bot conectado, flujo de citas completo, recordatorios funcionando

Entregables:
- [ ] Baileys conectado al número de prueba (QR scan)
- [ ] Sesión persistente en `/data/sessions/{salon_id}/`
- [ ] Intent parser: agendar / cancelar / consultar / sin match
- [ ] DB SQLite con schema multi-tenant
- [ ] **Flujo 1: Agendar** (inbound completo)
- [ ] **Flujo 3 (Anti-Cancel): recordatorio 24h y 2h** vía cron

Verificación: 1 cita agendada por WA + 2 recordatorios enviados sin intervención manual.

---

### Fase 2 — Reactivación de Dormidas (Semana 2, paralelo)

**Objetivo:** Primer outbound automatizado — el bot le escribe a clientas perdidas

Entregables:
- [ ] Campo `last_visit` en tabla `contacts` (se actualiza en cada cita `completed`)
- [ ] Cron semanal: detecta contactos con `last_visit > 30 días` y sin cita futura
- [ ] **Flujo 2 (Reactivación):** mensaje personalizado con oferta para volver
- [ ] Rate limiting: máximo 20 mensajes/hora outbound (evitar ban Baileys)
- [ ] Log de campaña: `campaigns` table (quién recibió, quién respondió, quién agendó)
- [ ] Panel web: sección "Reactivaciones" muestra métricas

Verificación: Cron corre, envía mensajes, al menos 1 respuesta genera cita nueva.

---

### Fase 3 — Panel Web (Semana 3)

**Objetivo:** Dueña ve todo desde su celular

Entregables:
- [ ] Agenda del día / semana (vista calendario simple)
- [ ] Lista de contactos + última visita + estado (activa / dormida)
- [ ] Sección campañas: reactivaciones enviadas, tasa de respuesta, citas generadas
- [ ] Botón manual: "Enviar reactivación ahora" (para salones que quieren controlar cuándo)
- [ ] Auth: token UUID por salón en URL

---

### Fase 4 — Multi-tenant + Onboarding (Semana 4)

**Objetivo:** Sistema listo para 2 salones simultáneos

Entregables:
- [ ] Onboarding script: crea salón + servicios + slots en 5 min
- [ ] Cada salón = su propia instancia Baileys + carpeta de sesión
- [ ] Process manager: si una instancia cae, se reinicia sola
- [ ] Dashboard admin (solo para Fede): todos los salones, status, métricas

---

## Cron Jobs

| Job | Schedule | Acción |
|-----|----------|--------|
| `remind-24h` | Cada hora | Busca citas que arrancan en 24-25h, envía recordatorio |
| `remind-2h` | Cada 30 min | Busca citas que arrancan en 2-3h sin confirmación |
| `mark-completed` | Cada hora | Marca como `completed` las citas que ya pasaron |
| `update-dormant` | Diario 00:00 | Actualiza flag `dormant` en contacts |
| `reactivation-campaign` | Lunes 10:00am | Detecta dormidas y dispara mensajes outbound |

---

## Decisiones de arquitectura

| Decisión | Elección | Razón |
|----------|----------|-------|
| WA stack | **Baileys** | Cero costo, arranque rápido |
| Sesión Baileys | Auth data en `/data/sessions/{salon_id}/` | Persistencia entre reinicios |
| LLM para intents | **Claude Haiku** (via mission-control infer) | ~$0.001/mensaje |
| Fallback sin LLM | Keyword matching regex | Si Haiku falla, el bot no muere |
| Panel web | **Hono + vanilla HTML** | Zero bundle, carga rápido en 3G |
| Auth del panel | Token por salón (UUID en URL) | Sin email, sin OAuth |
| Puerto web panel | 8085 (ya abierto en UFW) | No requiere cambios de firewall |
| DB | **SQLite** separada de mc.db | `/data/salones.db` |
| Cron | node-cron (mismo que MC) | Ya conocemos el patrón |
| Outbound rate limit | 20 msgs/hora | Anti-ban Baileys |
| Despliegue | systemd unit `salones-wa.service` | Mismo patrón que mission-control |

---

## Riesgos y mitigaciones

| Riesgo | Probabilidad | Mitigación |
|--------|-------------|------------|
| WhatsApp banea número | Media | Comportamiento humano (delays), número secundario para dev, rate limit outbound |
| Clientas molesta por outbound | Baja-media | Solo contactar si hay historial real, máx 1x/mes, opt-out en respuesta |
| Dueña no sabe escanear QR | Alta | Video tutorial 60s, soporte de onboarding |
| Múltiples Baileys instances | Baja | Un proceso por salón, process manager |
| Pérdida de sesión WA | Media | Auto-reconexión, alerta admin si falla 3 veces |

---

## Cronograma estimado

| Semana | Focus | Entregable |
|--------|-------|------------|
| **1** | Setup + Baileys + DB | Bot conecta, lee mensajes, persiste sesión |
| **2** | Flujos 1+3 + Crons | Agendamiento completo + anti-cancelación + reactivación |
| **3** | Panel web | Agenda · Contactos · Métricas de campañas |
| **4** | Multi-tenant + onboarding | 2 salones en paralelo |
| **5+** | Ventas | Cold outreach Iztapalapa, primer pago |

---

## Métricas de éxito del MVP

- **Técnico:** 1 salón funcionando 7 días sin caídas
- **Anti-cancel:** tasa de no-show < 15% (vs ~30-40% sin bot)
- **Reactivación:** ≥ 1 cita generada de clientas dormidas en primer mes
- **Comercial:** 1 salón pagando $300-$500/mes

---

## Modelo de valor por producto

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

## Próximo paso inmediato

```bash
cd /root/claude/projects/salones-wa
npm init -y
npm install @whiskeysockets/baileys @hono/node-server hono better-sqlite3 node-cron
npm install -D typescript @types/node tsx
npx tsc --init
```

---

*Plan v2 · 2026-05-23 · Autor: Jarvis*
