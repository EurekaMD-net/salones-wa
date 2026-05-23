# Flujos de Conversación — Salones WA

> Especificación de todos los flujos del bot. El intent parser mapea cada mensaje entrante a uno de estos flujos. Si no hay match, activa el flujo de fallback.

---

## Intent Categories

| Intent | Trigger | Flujo |
|--------|---------|-------|
| `BOOK` | "quiero cita", "agendar", "apartar", "corte", "tinte" | Flujo 1 |
| `CONFIRM` | "SÍ", "si", "confirmo", "voy" (en respuesta a recordatorio) | Flujo 3a |
| `CANCEL` | "cancelar", "no puedo", "CANCELAR" | Flujo 4 |
| `QUERY` | "mi cita", "cuándo", "a qué hora" | Flujo 5 |
| `OPT_OUT` | "no me mandes mensajes", "baja", "stop" | Flujo 6 |
| `NONE` | cualquier otro texto | Flujo 7 (fallback) |

---

## Flujo 1 — Agendar Cita (inbound)

**Trigger:** Clienta escribe primero con intent `BOOK`

```
Estado 1 — Captura de servicio
──────────────────────────────
Clienta:  "Hola, quiero cita para corte"
Bot:      "¡Hola! 👋 ¿Para cuándo? Tenemos disponible:
           1️⃣ Sábado 28 de mayo — 10:00am
           2️⃣ Sábado 28 de mayo — 2:00pm
           3️⃣ Lunes 30 de mayo — 9:00am
           Responde 1, 2 o 3 para apartar tu lugar"

Estado 2 — Selección de slot
──────────────────────────────
Clienta:  "1"
Bot:      "✅ Listo! Quedas agendada:
           📅 Sábado 28 de mayo a las 10:00am
           💇‍♀️ Servicio: Corte
           Te recordaré mañana para confirmar. ¿Cambias algo?"

[Si el nombre no está registrado]
Bot:      "✅ Quedas agendada! ¿Cómo te llamas para anotarte? 😊"
Clienta:  "Carmen"
Bot:      "Listo Carmen 💕 Tu cita es el sábado 28 a las 10:00am para corte.
           Te recordaré 24h antes."
```

**Reglas:**
- Mostrar máximo 3 slots disponibles más próximos
- Un slot = franja de `service.duration_min` minutos dentro del horario del salón
- Si no hay slots en los próximos 7 días → "No tenemos disponibilidad esta semana, ¿te aviso cuando haya lugar?"
- Si la clienta ya tiene una cita confirmada → preguntar si quiere cancelar la anterior

---

## Flujo 2 — Reactivación de Dormidas (outbound)

**Trigger:** Cron semanal — lunes 10:00am  
**Condición:** `dormant = 1` AND `opt_out = 0` AND `visit_count >= 1` AND no reactivación en últimos 30 días

```
Bot → Clienta:
"Hola [nombre] 👋 Hace un tiempo que no te vemos por el salón.
 ¿Cómo estás? Esta semana tenemos lugares disponibles —
 ¿te agendo algo? Solo dime qué necesitas 💇‍♀️"

Clienta responde "Sí, quiero tinte":
→ Se activa Flujo 1 desde el estado inicial

Clienta responde "Ahorita no":
Bot: "Sin problema, cuando quieras estamos aquí 😊"
→ No se reintenta ese mes

Clienta no responde en 7 días:
→ No reintentar ese mes, marcar `responded = 0`
```

**Rate limits:**
- Máximo 20 mensajes outbound por hora (anti-ban Baileys)
- Máximo 1 mensaje de reactivación por contacto por mes
- Solo contactar si `visit_count >= 1` (nunca a alguien sin historial)

---

## Flujo 3 — Anti-Cancelación (outbound)

**Trigger:** Crons de recordatorio

### 3a — 24 horas antes
```
Bot → Clienta (24h antes):
"Hola [nombre] 😊 Te recuerdo que mañana tienes cita:
 📅 [día] a las [hora]
 💇‍♀️ [servicio]
 ¿Confirmas que vienes? Responde SÍ o CANCELAR"

Clienta: "SÍ"
Bot: "Perfecto, ahí te esperamos 💕"
→ appointments.confirmed_by_client = 1, reminded_24h = 1

Clienta: "CANCELAR"
→ Activa Flujo 4

Clienta no responde en 2h:
→ reminded_24h = 1 (para no reenviar)
→ Se enviará recordatorio de 2h si aplica
```

### 3b — 2 horas antes (solo si no confirmó)
```
Condición: reminded_2h = 0 AND confirmed_by_client = 0

Bot → Clienta (2h antes):
"Recordatorio rápido 💬 Tu cita es hoy a las [hora] para [servicio].
 ¿Sigues viniendo? Cualquier cambio de último minuto, avísanos 😊"

→ reminded_2h = 1 independientemente de la respuesta
```

---

## Flujo 4 — Cancelación (inbound o en respuesta a recordatorio)

```
Clienta:  "Necesito cancelar mi cita"
Bot:      "Entendido. Tienes agendado:
           📅 Sábado 28 mayo a las 10:00am (Corte)
           ¿Confirmas cancelación? Responde SÍ para cancelar."

Clienta:  "sí"
Bot:      "✅ Cancelada. ¡Cuando quieras agendar de nuevo, escríbenos! 💕"
→ appointments.status = 'cancelled', cancelled_at = now

[Si no tiene cita activa]
Bot:      "No encontré citas activas para ti. ¿Querías agendar algo? 😊"
```

---

## Flujo 5 — Consultar Cita

```
Clienta:  "¿cuándo tengo mi cita?"
Bot:      "Tu próxima cita es:
           📅 Sábado 28 mayo a las 10:00am
           💇‍♀️ Corte
           ¿Necesitas cambiarla?"

[Si no tiene cita activa]
Bot:      "No tienes citas agendadas. ¿Quieres agendar una? 😊"
```

---

## Flujo 6 — Opt-Out

```
Clienta:  "No me mandes mensajes" / "stop" / "baja"
Bot:      "Entendido, no te enviaremos más mensajes automáticos.
           Si en algún momento quieres agendar, solo escríbenos aquí 😊"
→ contacts.opt_out = 1
```

---

## Flujo 7 — Fallback

```
Clienta:  [mensaje que no matchea ningún intent]
Bot:      "Hola 👋 Para agendar una cita, solo dime cuándo quieres venir
           y qué servicio necesitas (corte, tinte, manicure, etc.) 💇‍♀️"
```

---

## Lógica de intent parsing

```
Prioridad de matching:
1. Si mensaje es respuesta a un recordatorio activo → Flujo 3a/3b override
2. Si mensaje es "SÍ"/"CANCELAR" y hay cita confirmada pendiente → Flujo 3a/4
3. LLM Haiku: clasifica el intent del mensaje libre
4. Regex fallback si LLM falla:
   - /cita|agendar|quiero|cort|tint|manic|pedi/i → BOOK
   - /cancel|no puedo|no voy/i → CANCEL
   - /mi cita|cuándo|a qué hora/i → QUERY
   - /stop|baja|no me mandes/i → OPT_OUT
5. Sin match → NONE → Flujo 7
```

---

## Estados de conversación

El bot mantiene estado por número de teléfono + salón para flujos multi-paso:

```
ConversationState {
  salon_id: string
  phone: string
  flow: 'BOOK' | 'CANCEL' | 'NONE'
  step: number           // paso dentro del flujo
  pending_service?: string
  pending_slots?: SlotOption[]
  expires_at: number     // unixepoch + 300s (5 min de inactividad → reset)
}
```

Estado almacenado en memoria (Map) — no se persiste en SQLite para mantener simplicidad.

---

*Especificación v1 · 2026-05-23*
