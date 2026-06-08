# Flujos de Conversación — Salones WA

> Especificación de todos los flujos del bot. El intent parser mapea cada mensaje entrante a uno de estos flujos. Si no hay match, activa el flujo de fallback.

---

## Intent Categories

| Intent       | Trigger                                                     | Flujo              |
| ------------ | ----------------------------------------------------------- | ------------------ |
| `BOOK`       | "quiero cita", "agendar", "apartar", "corte", "tinte"       | Flujo 1            |
| `CONFIRM`    | "SÍ", "si", "confirmo", "voy" (en respuesta a recordatorio) | Flujo 3a           |
| `CANCEL`     | "cancelar", "no puedo", "CANCELAR"                          | Flujo 4            |
| `RESCHEDULE` | "cambiar mi cita", "reagendar", "mover", "modificar"        | Flujo 4b           |
| `QUERY`      | "mi cita", "cuándo", "a qué hora"                           | Flujo 5            |
| `OPT_OUT`    | "no me mandes mensajes", "baja", "stop"                     | Flujo 6            |
| `NONE`       | cualquier otro texto                                        | Flujo 7 (fallback) |

---

## Flujo 1 — Agendar Cita (inbound)

**Trigger:** Clienta escribe primero con intent `BOOK`

```
Estado 1 — Captura de servicio (si el salón tiene varios)
─────────────────────────────────────────────────────────
Clienta:  "Hola, quiero cita para corte"   ← hint "corte" → match Corte
Bot:      "Para Corte tenemos disponible:
           1️⃣ Sábado 28 de mayo — 10:00am
           2️⃣ Lunes 30 de mayo — 10:00am
           3️⃣ Martes 31 de mayo — 10:00am
           4️⃣ Otra fecha — dime cuándo te queda
           Responde con el número ✅"

[Si la clienta NO mencionó servicio y el salón tiene varios]
Clienta:  "Quiero cita"
Bot:      "¿Qué servicio necesitas?
           1️⃣ Corte
           2️⃣ Tinte
           3️⃣ Peinado
           Responde con el número o el nombre del servicio."
Clienta:  "Tinte"  o  "2"   ← match por nombre o índice
→ Continúa al estado 2 con Tinte como servicio

[Si el salón solo tiene 1 servicio]
→ Auto-selección, salta al estado 2 directamente

Estado 2 — Selección de slot
──────────────────────────────
Clienta:  "1"
Bot:      "✅ ¡Listo! Quedas agendada:
           📅 Sábado 28 de mayo a las 10:00am
           💇‍♀️ Servicio: Corte
           Te recordaré 24h antes. ¡Hasta entonces! 💇‍♀️

           Por cierto, ¿cómo te llamas? Así te atiendo mejor 😊"

Estado 3 — Captura de nombre (solo si aún no lo tenemos)
──────────────────────────────
Clienta:  "Soy María"
Bot:      "¡Mucho gusto, María! 💕 Aquí estaré para lo que necesites."
→ Se guarda en contacts.name; la saluda por su nombre en adelante.
```

**Reglas:**

- Tras confirmar, si `contacts.name` está vacío, el bot pide el nombre **una
  vez** (estado `awaiting_client_name`). Lo guarda y la saluda por su nombre en
  confirmaciones/recordatorios/reactivaciones; nunca lo vuelve a preguntar.
  Borra el nombre al darse de baja (`opt_out`). Si responde con algo que no es
  un nombre (un "sí", "gracias", un comando, o cambia de tema), no guarda nada
  y no insiste. Extractor conservador: prefiere no guardar a guardar mal.
- Mostrar 3 slots + 1 opción "Otra fecha" (Flujo 1c)
- Un slot = franja de `service.duration_min` minutos dentro del horario del salón
- Los slots respetan: ≥24h desde ahora, horario configurado del salón (default Mon-Sat 9-19), sin solapamientos con citas confirmadas
- Cada slot ofrecido en un día distinto (variedad sobre densidad)
- Si no hay disponibilidad en 14 días → "En este momento no tenemos lugares disponibles..."
- Si la clienta abandona ("mejor lo dejo así", "olvidalo") → bot libera el estado y cierra cordialmente

---

## Flujo 1c — Propuesta de horario por la clienta

**Trigger:** Clienta responde con `4` (la opción "Otra fecha") al ver los slots ofrecidos.

```
Clienta:  "4"
Bot:      "¿Qué día y hora te queda mejor? 📅
           Por ejemplo: viernes 4pm, mañana 11am, sábado a las 5"
# Formatos de fecha que el parser entiende: día de la semana (viernes),
# relativos (hoy / mañana / pasado mañana), "N de <mes>" (15 de marzo) y
# numérico DD/MM con DIAGONAL (15/3). El guion se reserva para rangos de
# hora ("entre 4-5 de la tarde") — no se interpreta como fecha.

Clienta:  "viernes 4pm"

[Caso 1 — disponible]
Bot:      "Te puedo agendar el viernes 30 de mayo, 04:00 p.m. para Corte. ¿Confirmas? Responde SÍ"
Clienta:  "sí"
Bot:      "✅ ¡Listo! Tu cita es el viernes 30 de mayo a las 04:00 p.m. para Corte."

[Caso 2 — ocupado, hay alternativas]
# Desde 2026-06-04 las alternativas incluyen OTRAS HORAS del mismo día
# (no sólo otros días). El mismo caso aplica cuando dos clientas eligen el
# mismo slot ofrecido: la segunda recibe este re-ofrecimiento, nunca silencio.
Bot:      "Esa hora ya está apartada 🙈. Te puedo ofrecer:
           1️⃣ Viernes 30 — 3:00pm
           2️⃣ Viernes 30 — 5:00pm
           3️⃣ Sábado 31 — 4:00pm
           Responde con el número o dime otra fecha."

[Caso 3 — muy próxima (<24h)]
Bot:      "Esa fecha ya pasó o es muy próxima. Necesito al menos 24 horas de anticipación."

[Caso 4 — fuera de horario]
Bot:      "Ese día/hora estamos cerrados 🏪. Nuestro horario es lunes a sábado de 9am a 7pm."

[Caso 5 — no se entiende la fecha]
Bot:      "No pude entender bien la fecha 😅. Intenta así:
           • viernes 4pm
           • mañana 11am
           • el sábado a las 5"
```

**Reglas:**

- Parser soporta: `hoy / mañana / pasado mañana`, días de la semana (`lunes`–`domingo`), `próximo viernes`, formatos de hora `4pm / 4:30pm / 16:00 / a las 5 / 5 de la tarde / 11 de la mañana`
- Día y hora SIEMPRE se interpretan en zona horaria del salón (default `America/Mexico_City`)
- "12 de la noche" → 00:00 (no 12:00). "12 de la mañana" → 00:00 (idiom mexicano de medianoche)
- Hora ambigua (1–7 sin am/pm) → asume PM (clientas suelen pedir por la tarde)
- Re-validación de disponibilidad ANTES de confirmar (anti-race contra otras clientas reservando el mismo slot)
- Si tras "¿Confirmas?" la clienta responde algo que NO es SÍ → vuelve a estado de captura de fecha
- Mismo flujo se activa desde Flujo 4b (reagendar) — si la propuesta colisiona y la clienta elige una alternativa, se preserva el reschedule (cancela la anterior + crea la nueva)

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

## Flujo 4b — Reagendar Cita (inbound)

**Trigger:** Clienta escribe con intent `RESCHEDULE` (e.g. "quiero cambiar mi cita", "reagendar", "mover mi cita")

```
Clienta:  "Quiero cambiar mi cita"
Bot:      "Tu cita actual es el sábado 28 mayo a las 10:00am (Corte).
           ¿Para cuándo la quieres mover?
           1️⃣ Lunes 30 mayo — 10:00am
           2️⃣ Lunes 30 mayo — 2:00pm
           3️⃣ Martes 31 mayo — 9:00am
           Responde con el número. La cita anterior queda cancelada al confirmar la nueva."

Clienta:  "1"
Bot:      "✅ Listo! Tu cita (Corte) quedó el lunes 30 mayo a las 10:00am.
           La anterior (sábado 28 mayo a las 10:00am) queda cancelada. Te recordaré 24h antes 💇‍♀️"
→ appointment NEW row created (status=confirmed)
→ appointment OLD row status=cancelled, cancelled_at = now
→ service_id inherited from the original appointment (MVP scope: no service swap)

[Si no tiene cita activa para mover]
Bot:      "No tienes citas próximas agendadas. ¿Quieres apartar una? 💇‍♀️"
```

**Reglas:**

- El service del nuevo appointment se hereda del original (la dueña no puede cambiar de servicio en el reschedule MVP — para cambio de servicio, cancela + agenda nuevo).
- Si la clienta tiene múltiples citas futuras, se reagenda la _próxima_ (la más cercana cronológicamente).
- Atomicidad: el nuevo appointment se crea ANTES de cancelar el anterior. En caso improbable de fallo de la cancelación, la clienta tendría dos citas (recoverable) en vez de cero (peor experiencia).

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

_Especificación v1 · 2026-05-23_
