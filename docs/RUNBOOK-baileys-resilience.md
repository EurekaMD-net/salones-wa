# RUNBOOK — Baileys Resilience

> Operational playbook for keeping salones-wa's WhatsApp connections alive
> despite Baileys' known brittleness (anti-spam, protocol drift, VPS IP
> rep, session corruption). Updated 2026-05-24 based on first-link
> incident.

**Audience**: operator (Fede) for VPS-side ops; salon owners (la dueña)
for salon-side recovery. Each section labels its audience.

**Why this exists**: Baileys is an unofficial WhatsApp library. It works,
but breaks predictably: ~monthly protocol drift, occasional anti-spam
flags, IP-rep issues on data-center VPS, session corruption on bad
shutdowns. The cost of NOT having this runbook is repeating today's
30-minute pairing-code burn loop every time something goes wrong.

---

## Section 1 — Pre-link checklist (first-time salon onboarding)

> Audience: operator. Run this BEFORE asking the salon owner to scan.

Each item is a precondition that, when missed, has caused a real failure.

- [ ] **Salon row exists in DB with `active=1`**
      `bash
sqlite3 /root/claude/projects/salones-wa/data/salones.db \
  "SELECT id, name, phone, active FROM salons WHERE active=1"
`
      Baileys only inits for active salons at startup. Adding via admin
      DOES set active=1 automatically — verify anyway.

- [ ] **Phone column holds the BOT's WA number, NOT the owner's contact**
      The schema's single `phone` field is overloaded. Operator may
      naturally type the dueña's personal phone. Confirm with the dueña
      explicitly: "este es el número que va a recibir los mensajes de
      las clientas, ¿correcto?"
      Format: digits only, modern format (e.g. `525512345678` for a
      Mexican mobile post-2019). Try modern first; if linking fails with
      the same error twice, try legacy with the "1" prefix
      (`5215512345678`).

- [ ] **The phone number is registered to WA on a device the dueña has
      access to right now, as the PRIMARY device** (not a linked
      device). WhatsApp's primary-device architecture means Baileys
      links to an existing account — Baileys cannot create one. If the
      number has never had WA installed, the dueña must register it
      first (WA Business app, SMS OTP, etc.) before any link can work.

- [ ] **The dueña's WA primary device has NOT recently failed linking
      attempts**. WA anti-spam cool-down is account-side, lasts roughly
      24h after 3+ rejected pairing codes. If you tried earlier today
      and it failed, **wait** — retrying now makes the cool-down worse.

- [ ] **The session directory is clean**:
      `bash
ls -la /root/claude/projects/salones-wa/data/sessions/<salon-id>/
`
      If there's a stale `creds.json` from a prior failed attempt, WIPE
      it before restart:
      `bash
sudo rm -rf /root/claude/projects/salones-wa/data/sessions/<salon-id>/
`
      Half-state creds cause Baileys to think it has partial auth → WA
      returns 401 → Baileys flags `loggedOut` and won't reconnect.

- [ ] **Service running, /health 200, journalctl tail open**:
      `bash
systemctl is-active salones-wa
curl -s http://localhost:8085/health | jq
journalctl -u salones-wa -f | grep --line-buffered -E 'Pairing code|connected|reconnecting|error'
`

---

## Section 2 — Link failure triage (decision tree)

> Audience: operator. When linking fails, classify the error BEFORE
> retrying. Different errors need different responses.

```
WA error / journalctl pattern              →  Root cause          →  Action
──────────────────────────────────────────────────────────────────────────────────────────────
"At this moment you can't add new        →  IP-rep block        →  Switch to pairing code
 devices" (during QR scan)                  (data-center IP)       (already implemented).
                                                                   If pairing also fails:
                                                                   24h cool-down.

"Can't link device / No se pudo          →  Most often: WA-side  →  STOP after 3 attempts.
 vincular el dispositivo"                   account block from     Halt burn loop (active=0).
                                            prior failures.        Retry in 24h.
                                            Sometimes: number
                                            format mismatch.

Pairing code never appears in            →  Baileys protocol     →  Last code logged was
 journalctl after restart                   drift OR socket        when? If >5 min ago and
                                            silently dropped       service is still active,
                                            without reconnecting   restart to force reset.
                                            log line.              If still no code on next
                                                                   restart: Baileys upgrade
                                                                   candidate.

"[baileys] [X] logged out — manual       →  Stale half-state     →  Wipe session dir + restart.
 re-link required" right after restart      creds on disk          The "loggedOut" verdict is
                                            (from earlier         from a CORRUPTED session,
                                            corrupted attempt)     not a real logout.

journalctl shows "reconnecting           →  Network instability  →  Watch for the next
 (code=N, reason=...)"                      OR WA-side TCP RST     successful "connected" log.
 repeating every 5s                                                If >5 consecutive
                                                                   reconnects: stop service,
                                                                   investigate IP rep / WA
                                                                   account state.

"connected ✅" but inbound               →  Session linked but   →  Check messages.upsert
 messages not processed                     not receiving msgs     handler error logs. Check
                                            (sync issue)           that the dueña actually
                                                                   sent to the BOT's number,
                                                                   not the owner number.
```

---

## Section 3 — Cool-down rules (the 3-strike rule applied)

> Audience: operator. From CLAUDE.md global doctrine + today's incident.

WhatsApp's anti-spam treats repeated link failures as an account flag.
Each failure compounds — the 4th failed attempt has a LOWER success rate
than the 1st, not higher. Discipline:

| Attempts                 | Action                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| **1st fails**            | Read error, classify (Section 2), try one alternate (e.g. legacy phone format).                              |
| **2nd fails**            | Confirm operator/dueña is on the correct primary device. Try ONE more code in the current 60s window.        |
| **3rd fails**            | **STOP**. Set `active=0` on the salon to halt the burn loop. Wipe session dir. Wait minimum 6h, ideally 24h. |
| **4th attempt same day** | DON'T. You're not unstuck; you're flagged. Patience is cheaper than escalation.                              |

Code commands for the halt:

```bash
SALON_ID="3e13d856-3c1d-4ab5-919f-aadc39fca8ab"   # replace with target salon

# Halt burn loop
sqlite3 /root/claude/projects/salones-wa/data/salones.db \
  "UPDATE salons SET active=0 WHERE id='${SALON_ID}'"
sudo rm -rf /root/claude/projects/salones-wa/data/sessions/${SALON_ID}/
sudo systemctl restart salones-wa

# Verify journalctl shows "no active salons" or only OTHER salons booting
journalctl -u salones-wa --since '30 sec ago' | tail -5
```

To resume after cool-down:

```bash
sqlite3 /root/claude/projects/salones-wa/data/salones.db \
  "UPDATE salons SET active=1 WHERE id='${SALON_ID}'"
sudo systemctl restart salones-wa
journalctl -u salones-wa -f | grep --line-buffered 'Pairing code'
```

---

## Section 4 — Re-link recovery (when an already-linked session dies)

> Audience: operator. The dueña was working, then "the bot stopped
> responding."

WA can log out a Baileys session at any time. Common triggers:

- WA Business app on the dueña's phone got "Linked Devices → Cerrar
  sesión" tapped (often accidentally by the dueña tidying up)
- The dueña's primary device was offline for >14 days (WA's idle
  timeout)
- WA pushed a protocol update Baileys doesn't yet support (~monthly,
  per `feedback_x_posting_brittle_path`)
- The Baileys session creds got corrupted by an unclean shutdown

### Diagnosis (~30 seconds)

```bash
SALON_ID="..."  # from /admin

# Is the salon active and what's its state?
sqlite3 /root/claude/projects/salones-wa/data/salones.db \
  "SELECT id, name, phone, active FROM salons WHERE id='${SALON_ID}'"

# Did the bot connect on the latest restart?
journalctl -u salones-wa --no-pager --since '1 hour ago' | \
  grep -E "${SALON_ID}|baileys|connected|logged out"

# Are session creds intact?
ls -la /root/claude/projects/salones-wa/data/sessions/${SALON_ID}/
# Expect: creds.json (~1-2 KB) + multiple session-*.json (~few KB each)
# If only creds.json with stale timestamp: never fully linked.
# If empty / missing: session lost.
```

### Decision

| State                                                    | Action                                                                           |
| -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Session files all present, last "connected ✅" within 1h | Just a transient blip. Restart service.                                          |
| "logged out — manual re-link required" in recent logs    | WA kicked us. Need re-link (Section 5).                                          |
| Session files corrupted (truncated JSON, etc.)           | Wipe + re-link (Section 5).                                                      |
| Service itself is down (systemctl inactive)              | `systemctl status salones-wa` for the systemd error. Likely a non-Baileys issue. |

---

## Section 5 — Re-linking a previously-linked salon

> Audience: operator + dueña (each does part).

Triggered by Section 4 diagnosis. The dueña will need to re-scan
because WA invalidated the prior session.

**Operator (~2 min)**:

```bash
SALON_ID="..."

# 1. Stop the salon's Baileys (clean removal of session)
sqlite3 /root/claude/projects/salones-wa/data/salones.db \
  "UPDATE salons SET active=0 WHERE id='${SALON_ID}'"
sudo rm -rf /root/claude/projects/salones-wa/data/sessions/${SALON_ID}/
sudo systemctl restart salones-wa
sleep 4 && journalctl -u salones-wa --since '15 sec ago' | tail -3
# Expect: "no active salons configured" OR the salon is gone from boot

# 2. Re-arm
sqlite3 /root/claude/projects/salones-wa/data/salones.db \
  "UPDATE salons SET active=1 WHERE id='${SALON_ID}'"
sudo systemctl restart salones-wa
sleep 5 && journalctl -u salones-wa -n 30 --no-pager | grep -E 'Pairing|QR for salon'
```

Send the pairing code to the dueña (WhatsApp, SMS, voice — whatever
they prefer). Format: `XXXX-XXXX` with the hyphen so they can copy-
paste cleanly.

**Dueña (~3 min)** — Spanish steps in Section 6.

**Operator (verify)**:

```bash
# Wait ~30 seconds after dueña enters code, then verify:
journalctl -u salones-wa --since '2 min ago' | grep "${SALON_ID}" | tail -10
# Expect: "[baileys] [<phone>] connected ✅"

# Confirm session creds wrote to disk:
ls -la /root/claude/projects/salones-wa/data/sessions/${SALON_ID}/
# Expect: creds.json + session-*.json files
```

---

## Section 6 — Para la dueña: pasos para re-vincular tu bot

> Audience: salon owner (dueña). Operator copies this section verbatim
> via WhatsApp/SMS when re-link needed.

Hola [nombre], el bot perdió la conexión con tu WhatsApp y necesitamos
re-vincularlo. Te tomará 3 minutos. **Importante**: hazlo en el
teléfono donde tienes WhatsApp con el número de tu salón (no en
cualquier otro teléfono).

1. Abre **WhatsApp** en tu teléfono
2. Toca los **tres puntitos** ⋮ arriba a la derecha
3. Toca **"Dispositivos vinculados"**
4. Toca **"Vincular un dispositivo"**
5. En la pantalla del código QR, **busca abajo** un texto que dice
   "Vincular con número de teléfono" — tócalo
6. WhatsApp te pedirá tu número — escribe los **10 dígitos** sin el
   país (por ejemplo: `5512345678`)
7. WhatsApp te mostrará una pantalla para escribir un **código de 8
   letras y números**. Te lo voy a enviar ahora.

**Código:** `XXXX-XXXX` (te lo envío)

Escribe el código **tal cual** (las letras tal como están, sin
espacios o con guión, da igual). Si te dice "no se pudo vincular",
avísame inmediatamente y te paso un código nuevo — los códigos
expiran en 60 segundos.

Cuando funcione, verás que tu teléfono dice "Dispositivo vinculado"
y aparece un dispositivo nuevo en la lista llamado "SalonesWA" o
similar. Eso significa que el bot está conectado y va a empezar a
responder a tus clientas. ¡Listo!

---

## Section 7 — Active health monitoring

> Audience: operator. Passive detection so failures don't sit
> unnoticed for days.

**What to watch**:

1. **Per-salon connection status** — is Baileys still authed for each
   active salon?
2. **Inbound message lag** — are messages arriving but not being
   processed?
3. **Outbound failure rate** — are reactivation/reminder messages
   actually sending?

**Current state** (since 2026-06-06): per-salon Baileys state is now
exposed at `GET /health/salons?token=<ADMIN_TOKEN>` (JSON) and
`GET /metrics?token=<ADMIN_TOKEN>` (Prometheus). The manual check below
still works as a no-dependency fallback.

**Quick check via the endpoint** (replace `<ADMIN_TOKEN>`):

```bash
curl -s "http://127.0.0.1:8085/health/salons?token=<ADMIN_TOKEN>" | jq '.salons[] | {name, state, downForSeconds, stale}'
```

`state` is one of `connected` / `reconnecting` / `logged_out` /
`connecting` / `unknown`; `stale: true` means down past the alert
threshold (`SALON_DISCONNECT_ALERT_HOURS`, default 24h).

**Manual check** (fallback, no token needed):

```bash
# Per-salon: is there a creds.json AND a recent "connected" log?
for SALON in $(sqlite3 /root/claude/projects/salones-wa/data/salones.db \
  "SELECT id FROM salons WHERE active=1"); do
  echo "=== ${SALON} ==="
  ls /root/claude/projects/salones-wa/data/sessions/${SALON}/creds.json 2>&1 | head -1
  journalctl -u salones-wa --since '24 hours ago' --no-pager | \
    grep -E "${SALON}.*(connected|logged out|reconnecting)" | tail -3
done
```

Expected per salon:

- `creds.json` exists
- Most recent log line for that salon is "connected ✅" within the
  last few hours (not "reconnecting" or "logged out")

**Backlog status** (shipped 2026-06-06):

- ✅ `/health/salons` endpoint exposing per-salon Baileys state
- ✅ Prometheus gauge `salones_wa_baileys_state{salon_id, state}` (+
  `salones_wa_baileys_connected`, `_down_seconds`,
  `_last_connected_timestamp_seconds`, `salones_wa_salons_{active,stale}`)
- ✅ `disconnect-watch` cron (daily 9am MX) — logs a WARN per stale salon.
  It does NOT email/message anyone: alerting is owned by mc-prometheus
  (see §7 below), which survives this service restarting.

---

### 7.1 — Wiring mc-prometheus (operator, one-time)

> Audience: operator. salones-wa only EXPOSES `/metrics`; mc-prometheus
> scrapes it and fires the actual alert. This step needs the `ADMIN_TOKEN`
> (a secret), so it can't be committed — apply it by hand.

**1. Add the scrape job** to `mission-control/monitoring/prometheus.yml`
(replace `<ADMIN_TOKEN>` with the real value from
`/root/claude/projects/salones-wa/.env`):

```yaml
- job_name: "salones-wa"
  static_configs:
    - targets: ["host.docker.internal:8085"]
  metrics_path: /metrics
  params:
    token: ["<ADMIN_TOKEN>"]
```

> ⚠️ **Binding caveat**: salones-wa binds `127.0.0.1:8085`. If
> mc-prometheus (a container) can't reach `host.docker.internal:8085`,
> either confirm the docker host-gateway can hit host loopback, or scrape
> the public Caddy URL instead (`https://salones.187.77.25.101.nip.io`,
> same `metrics_path` + `params`). Verify with:
> `docker exec mc-prometheus wget -qO- "http://host.docker.internal:8085/metrics?token=<ADMIN_TOKEN>" | head`

**2. Add the alert rules** to `mission-control/monitoring/alerts.yml`
(no secret — safe to commit to mission-control):

```yaml
- name: salones-wa
  rules:
    - alert: SalonWhatsAppDisconnected
      expr: salones_wa_baileys_state{state="connected"} == 0
      for: 24h
      labels: { severity: warning }
      annotations:
        summary: "Salón {{ $labels.salon_id }} WhatsApp down >24h"
        description: "Baileys not connected. Re-link via pairing code (§5)."
    - alert: SalonWhatsAppLoggedOut
      expr: salones_wa_baileys_state{state="logged_out"} == 1
      for: 1h
      labels: { severity: critical }
      annotations:
        summary: "Salón {{ $labels.salon_id }} WhatsApp LOGGED OUT"
        description: "Session invalidated — needs manual re-link (§5)."
    - alert: SalonesWaScrapeDown
      expr: up{job="salones-wa"} == 0
      for: 10m
      labels: { severity: warning }
      annotations:
        summary: "salones-wa /metrics unreachable"
        description: "Token wrong, service down, or binding issue (see §7 caveat)."
```

The `for: 24h` clause is the durable signal: it's owned by Prometheus,
so it keeps counting across salones-wa restarts (a brief scrape gap is
within tolerance). A salon that reconnects resets the `connected` series
to 1 and clears the pending alert.

**3. Reload mc-prometheus**: `docker restart mc-prometheus` (or
`curl -X POST http://127.0.0.1:9090/-/reload` if lifecycle is enabled).
Confirm the target is `UP` at `http://127.0.0.1:9090/targets`.

---

## Section 8 — Escalation triggers

> Audience: operator. When to call in heavier interventions.

| Symptom                                                       | Threshold                           | Escalation                                                                                                                       |
| ------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Same salon needs re-link                                      | >2× per month                       | Investigate dueña-side: is she accidentally hitting "Cerrar sesión"? Is her phone going offline for long periods?                |
| Multiple salones disconnect within 24h                        | >3 within a day                     | Likely a WA protocol update broke Baileys. Check `npm view @whiskeysockets/baileys version` for newer release. Consider upgrade. |
| Linking fails for a NEW salon after full cool-down            | After 24h cool-down + fresh attempt | Account-side block on that specific number. Try with a different bot number.                                                     |
| `requestPairingCode` consistently throws errors in journalctl | Across >2 salones, persistent       | Baileys 6.7.x's pairing-code protocol may be broken. Evaluate Baileys 7.0.0-rc.                                                  |
| Service can't restart, systemd reports failure                | Any                                 | `systemctl status salones-wa` + `journalctl -xeu salones-wa` for systemd-level errors. Not a Baileys issue.                      |
| Caddy reverse-proxy returns 502/503                           | Any                                 | `systemctl status caddy` + `/var/log/caddy/`. Service may be up locally but Caddy can't reach it.                                |

**Last-resort escalations** (each is a multi-day project, not a
runbook step):

1. **Migrate to Baileys 7.0.0-rc13** — newer protocol, may fix
   pairing-code drift. Risk: RC version, no LTS, may break
   sendMessage paths.
2. **Add residential-proxy fronting for Baileys WS** — bypasses
   data-center IP rep issues. Cost: ~$10–30/mo per proxy provider.
3. **Migrate that salon to WhatsApp Cloud API** — official, no anti-
   spam, predictable. Cost: ~$5–15/mo per salon in conversation fees,
   requires Meta Business verification per salon (5–15 business days).
   Documented in the WA Business evaluation memo
   (`~/.claude/projects/-root-claude/memory/...` — pending).

---

## Section 9 — Known good versions / pinned references

> Audience: operator. Verified-working snapshot to roll back to.

As of **2026-05-24**:

- `@whiskeysockets/baileys`: `6.7.23` (`legacy` tag — latest stable
  pre-7.0)
- Pairing-code linking: works on first attempt for accounts NOT
  flagged by WA anti-spam (today's failure was anti-spam, not Baileys)
- QR linking: fails reliably from data-center IPs (this VPS),
  works from residential IPs

**Baileys upstream changes to watch**:

- 7.0.0 stable release — currently `rc13`. Once stable, evaluate
  upgrade.
- WhatsApp protocol drift: subscribe to
  https://github.com/WhiskeySockets/Baileys/issues for spike alerts
- Monthly health check: `npm view @whiskeysockets/baileys time` to
  see release cadence

**Last verified clean**:

- 2026-05-24: salones-wa systemd unit boots cleanly, no salones
  active (Paradise Life paused for cool-down). Pairing-code emission
  verified, linking blocked WA-side.

---

## Cross-references

- Code: `src/bot/baileys-manager.ts` (pairing-code logic, reconnect
  policy, session persistence)
- Schema: `docs/SCHEMA.md` (salons.phone is overloaded — see Section 1)
- Onboarding flow: `README.md` "Vincular número WA" section
- Today's incident post-mortem:
  `~/.claude/projects/-root-claude/memory/feedback_salones_wa_pairing_code_arc_2026_05_24.md`
- Pre-deploy audit:
  `~/claude/jarvis-kb/projects/negocios-auto-gestionados/verticales/salones-belleza/AUDIT-2026-05-23-PRE-DEPLOY.md`
- WA Business API evaluation (Cloud API tradeoff vs Baileys): see
  conversation 2026-05-24, segment-by-segment recommendation
  (Tier 1 = Baileys, Tier 2 = Cloud API + RFC bundle, Tier 3 = Cloud
  API).
