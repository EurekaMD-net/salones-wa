# Gilda Outreach Sender — Spec (pilot, one fresh number)

> Status: **DRAFT for approval** · Author: Claude · 2026-06-07
> Scope: the _send-side_ of the Gilda cold-outreach pilot. Validation (the 277
> WA-valid prospects) is already done. This is what turns that list into a
> tracked, ban-safe, reply-aware campaign run from **one fresh WhatsApp Business
> number** — never the personal (`5530331051`) or product/bot (`5640501088`) line.

---

## 1. Goal & non-goals

**Goal:** message ~277 validated salon owners in Iztapalapa, slowly and
human-like, from a dedicated number; capture every reply; never double-message;
hand interested leads to a human; measure the funnel; and stop instantly if the
number looks like it's being flagged.

**Non-goals (pilot):**

- No bot auto-pitch to cold leads — a reply means a **human** (Fede) takes over.
  The product bot is for _booked clients_, not for closing cold prospects.
- Two SIMs in hand (brand + outreach — see §2); no >2-number rotation yet
  (schema's `number_id` is ready for it).
- No official WhatsApp Business **API** yet — a fresh SIM on the **Business app**
  is the right pilot tool. Migrate to the API only if the pilot proves conversion.

---

## 2. Architecture decision — separate service

> **Update 2026-06-07 — operator has TWO SIMs.** Assignment:
>
> - **SIM #1 → Brand** (`number_id='brand'`): the stable, protected, long-term
>   face. Goes on the landing CTA (off your personal `5530331051`), handles
>   inbound from the landing + lead hand-offs, kept low-volume and clean.
> - **SIM #2 → Outreach** (`number_id='outreach'`): the cold-send, ban-prone,
>   semi-disposable number. Does the cold DMs; if it cools/bans you lose only it.
>
> Continuity note: a cold reply lands on the **outreach** number — for the pilot
> Fede takes over there; if that number looks at-risk, migrate hot leads to the
> brand number. The schema's `number_id` already carries this split, so the
> sender targets `outreach` while the brand session just listens + handles the CTA.

Build a new service **`gilda-outreach`**, isolated from `salones-wa`:

- **Why separate:** this number is the most ban-prone thing in the whole stack.
  It must NOT share a process with the product bot — a flag/logout/ban-handling
  on the outreach socket can never be allowed to touch the booking bot's event
  loop, `instances` map, or restart lifecycle. Different number = different
  Baileys session, so there's no dual-socket conflict (unlike the validation
  step, which had to reuse the bot's socket).
- **What it reuses (lift, don't reinvent):** the hardened salones-wa patterns —
  `bot/baileys-manager.ts` (pairing-code link, generation guard, liveness
  watchdog), `web/auth.ts` (timing-safe token + per-IP rate limiter),
  `web/observability.ts` (`/health` + `/metrics`). Copy for the pilot; extract a
  shared lib later if a 2nd consumer appears.

| Param    | Value                                                                  |
| -------- | ---------------------------------------------------------------------- |
| Runtime  | TypeScript, `tsx` live, systemd unit `gilda-outreach.service`          |
| Port     | **8087** (localhost; verified free 2026-06-07)                         |
| DB       | `data/outreach.db` (SQLite, WAL) — separate from `salones.db`          |
| Sessions | `data/sessions/<numberId>/` (Baileys creds)                            |
| Env      | `TZ=America/Mexico_City`, `OUTREACH_ENABLED=false` (default OFF)       |
| Repo     | new `EurekaMD-net/gilda-outreach` (or a `gilda-outreach/` sibling dir) |

---

## 3. Data model (SQLite)

```sql
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- One row per prospect (imported from the validated Google Sheet).
CREATE TABLE prospects (
  id           TEXT PRIMARY KEY,         -- uuid
  name         TEXT,                     -- nombre del negocio / dueña
  colonia      TEXT,
  phone_raw    TEXT NOT NULL,            -- as in the sheet
  wa_jid       TEXT NOT NULL,            -- canonical JID from onWhatsApp()
  source       TEXT DEFAULT 'denue-iztapalapa-2026-06',
  number_id    TEXT,                     -- which outreach number handled it (rotation-ready)
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK(status IN ('pending','queued','sent','replied',
                                  'interested','not_interested','opted_out',
                                  'failed','invalid','converted')),
  template_variant TEXT,                 -- which copy variant was sent
  contacted_at INTEGER,                  -- first outbound send (unixepoch)
  last_out_at  INTEGER,
  first_reply_at INTEGER,
  reply_count  INTEGER NOT NULL DEFAULT 0,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  imported_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(wa_jid)                         -- dedupe: never two rows for one number
);
CREATE INDEX idx_prospects_status ON prospects(status);

-- Full conversation log (audit + conversion analysis + reply UI feed).
CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  prospect_id TEXT NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  direction   TEXT NOT NULL CHECK(direction IN ('out','in')),
  body        TEXT,
  wa_msg_id   TEXT,                      -- Baileys message id (for receipts)
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_messages_prospect ON messages(prospect_id, created_at);

-- Daily send counter — enforces ramp + cap, survives restart.
CREATE TABLE daily_sends (
  day         TEXT PRIMARY KEY,          -- 'YYYY-MM-DD' in MX time
  sent_count  INTEGER NOT NULL DEFAULT 0
);
```

State machine:

```
pending → queued → sent → replied → { interested | not_interested | opted_out | converted }
                     │
                     └─(send error)→ failed (retry next day, capped attempts)
ANY inbound message  → status jumps to 'replied', prospect REMOVED from send queue
opt-out phrase       → status 'opted_out', permanent suppression
```

---

## 4. The receiver — build this FIRST

> Never run the sender before reply-capture exists, or you blast 277 people and
> can't see who answered.

Same Baileys session listens for inbound:

- Match inbound JID → prospect. Log to `messages(direction='in')`,
  `reply_count++`, set `first_reply_at` if first.
- **First reply ⇒ status `replied` and DROP from the send queue** — a person
  mid-conversation must never get another cold template.
- **Opt-out detection** — reuse salones-wa `OPT_OUT_PATTERNS` + extend for
  outreach ("no me interesa", "no gracias", "quién eres", "cómo conseguiste mi
  número", "stop", "baja"). → status `opted_out`, permanent suppress.
- **Interested signal** (light heuristic: a question / "cuánto" / "cómo
  funciona" / "sí me interesa") → status `interested` + **push an operator
  alert** (see §7). Do NOT auto-reply with a pitch.
- Everything else stays `replied` and shows in the "needs attention" feed.

---

## 5. The sender — rate-limited, warming, ban-safe

A cron (`node-cron`, every minute) that, when due, sends **one** message:

**Gates (all must pass before any send):**

1. `OUTREACH_ENABLED === 'true'` (global kill switch; default OFF).
2. Inside send window: **Mon–Fri, 10:00–18:00 MX** (no nights/weekends — off-hours bulk = bot signal).
3. `daily_sends[today] < todaysCap` (ramp, below).
4. Baileys session `state === 'connected'` (else pause + alert — see §6).
5. Jitter elapsed since last send (see below).

**Warming ramp (configurable array, index = days since campaign start):**

```
[0, 0, 10, 15, 20, 25, 30]   // days 1–2 warm manually; then ramp to a 30/day cap
```

A brand-new number that immediately blasts 30/day is the #1 ban trigger.

**Cadence:** between sends, sleep a **random 90–240s** (NOT fixed). ~30 sends
across an 8h window ≈ one every ~16 min — indistinguishable from a person.

**Selection:** oldest `pending` prospect not opted-out, FIFO. Mark `queued` →
send → on success `sent` + `contacted_at` + `daily_sends++` + log
`messages(direction='out')`; on error `failed` + `last_error`, `attempts++`
(retry next day, give up after N=3).

**Message copy:** 2–3 personalized variants, rotated per prospect. Template
fields `{nombre}`, `{colonia}`. Always include an **opt-out line** (cuts reports,
gives a clean signal, good-faith compliance). Example:

> "Hola {nombre} 👋 Soy Fede. Vi que tienes un salón en {colonia}. Armé una
> herramienta que llena la agenda y baja los no-shows por WhatsApp, sin que
> tengas que estar al pendiente. ¿Te late que te cuente en 2 min? Si no te
> interesa, dime y no te escribo más 🙏"

---

## 6. Ban-safety & observability

- **Default OFF.** `OUTREACH_ENABLED=false` until you explicitly flip it.
- **Auto-pause on danger signals** → set `OUTREACH_ENABLED=false` in memory + alert:
  - Session emits `logged_out` / connection 401 → **probable ban**. Do NOT
    auto-reconnect-and-retry (worsens it). Halt, alert loudly.
  - ≥3 consecutive send failures → halt + alert.
- **`/health`** (liveness) + **`/metrics`** (Prometheus): `outreach_sent_total`,
  `outreach_replies_total`, `outreach_opted_out_total`, `outreach_failed_total`,
  `outreach_session_up`, `outreach_daily_sent`. Token-gated like salones-wa.
  Wire an mc-prometheus scrape job + an alert rule (`outreach_session_up == 0`).
- **Liveness watchdog** (lifted from salones-wa) — but for outreach, a stuck/
  logged-out session should ALERT, not aggressively reconnect.

---

## 7. Operator surface

- **Token-gated status page** (localhost:8087, optionally `outreach.gilda.mx`
  via Caddy, ADMIN_TOKEN-gated): funnel counters (pending / sent / replied /
  reply-rate / interested / opted-out / remaining), today's sent vs cap, a
  **"replies needing attention" feed** (the conversation log per prospect), and
  a kill-switch toggle.
- **Daily summary push** to the operator (reuse the mc Prometheus alert-poller /
  `sendBriefingToOwner` path → WhatsApp/Telegram): "Hoy: 22 enviados, 4
  respuestas, 1 interesado, 0 bajas. Interesado: <name> <jid>."
- **Interested-lead alert** in near-real-time so Fede can jump in while warm.

> ⚠️ The reply/summary alerts must go to a channel that is NOT the outreach
> number itself — the existing mc operator channels (your personal WhatsApp via
> the bot, or Telegram) are correct.

---

## 8. Compliance posture (Mexico / WhatsApp)

- Cold outreach to DENUE-sourced numbers is unsolicited — a fresh number
  _contains_ the risk, it doesn't make it compliant. Keep volume low,
  personalized, business-hours, with an opt-out line, and honor opt-outs
  permanently. (LFPDPPP applies to using census contacts for marketing.)
- Treat the outreach number as **semi-disposable**: expect to rotate it
  eventually. Schema already carries `number_id` so a 2nd number drops in later.

---

## 9. Build phases (approve/ship incrementally)

| Phase  | Deliverable                                                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| **P0** | Scaffold service + DB schema + import the 277 from the validated sheet (reuse the googleapis read). Dedupe on `wa_jid`.              |
| **P1** | Baileys session for the fresh number + pairing-code link flow + `/health` + session state in `/metrics`. (Link the SIM here.)        |
| **P2** | **Receiver**: inbound log, opt-out detection, interested flag, drop-from-queue, operator alert. _(Before any sending.)_              |
| **P3** | **Sender**: cron + ramp + daily cap + jitter + window + kill switch + template variants + pre-send guards + per-result state writes. |
| **P4** | Status page + daily summary push + mc-prometheus scrape/alert + auto-pause-on-danger.                                                |
| **P5** | End-to-end **dry-run** (sends to 2–3 of your own numbers), then **warm the SIM 3–5 days**, then ramp live.                           |

---

## 10. Defaults (change on approval)

```
OUTREACH_ENABLED=false           # explicit opt-in
DAILY_CAP=30
RAMP=[0,0,10,15,20,25,30]
SEND_WINDOW=Mon–Fri 10:00–18:00 America/Mexico_City
JITTER=90–240s between sends
TEMPLATE_VARIANTS=3 (with opt-out line)
MAX_ATTEMPTS=3
PORT=8087 (localhost)
ALERTS → existing mc operator channel (NOT the outreach number)
```

---

## 11. Open questions (answer when you're back)

1. **New number's WhatsApp profile name** — "Gilda" / "Gilda — Agenda WhatsApp" / your name? (Shown to every prospect.)
2. **Landing CTA** — move it off your personal `5530331051` to this new number, or keep the CTA on a separate protected number? (Recommend: the fresh number doubles as brand+outreach for the pilot, so the CTA points to it.)
3. **Reply alerts channel** — your personal WhatsApp (via the product bot) or Telegram?
4. **Where it lives** — its own repo `gilda-outreach`, or a module folder. (Recommend its own repo for isolation.)

When you're back with the SIM: confirm the profile name + alert channel, and I'll start at **P0 → P2** (everything safe, no sends) so it's ready to link the number and warm it.
