# WA Anti-Abuse Mitigation — Phased Scaling Plan

**Created:** 2026-05-24
**Owner:** salones-wa engineering + operator
**Scope:** Preemptive mitigations to keep Baileys-based salones-wa alive as the business scales from pilot (1-5) to multi-vertical (500+).
**Constraint:** WA Business API path is explicitly off the table at low-end pricing (kills unit economics at MXN $500-800/mo per salon).

---

## Why this plan exists

WhatsApp actively detects and degrades automated multi-device sessions on data-center IPs. The Baileys library is a reverse-engineered client; every protocol shift breaks us (Baileys 6→7 upgrade 2026-05-24 was exactly this). At 100+ salones from one IP, the question is not _if_ WA will throttle — it's _when_ and _how fast we recover_.

Anti-abuse signals WA reads:

1. **IP reputation** — data-center ranges are flagged; many sessions from one IP compound it
2. **Device fingerprint** — UA string, app version, link cadence, multi-device topology
3. **Behavioral signature** — response latency, presence patterns, message timing, typing indicators
4. **Account history** — age of WA number, prior reports, conversation patterns
5. **Recipient-side reports** — clienta hits "report spam" → instant account risk

We have meaningful levers on (1), (2), (3), partial control on (5) via product UX, zero control on (4) — it's an onboarding policy.

---

## Phase 0 — Pilot (1-5 salones) · _current state_

**Trigger:** 1-5 salones live. Iteration speed > hardening.

**Status:** ✅ Already done.

**What's in place:**

- `Browsers.ubuntu("Chrome")` UA fingerprint (recognized WA Web client)
- Baileys 7.0.0-rc13 (current upstream, fixes post-link sync)
- Pairing-code linking (no QR — dueña enters 8-char code from `/admin`)
- LID resolution via `remoteJidAlt` (handles WA's multi-device contact format)
- 50s throttle on pairing-code regen (prevents stale-code race)
- `useMultiFileAuthState` per-salon session dir (`data/sessions/<salon_id>/`)
- 515-reconnect zombie-instance fix (delete before re-init)
- OPT_OUT flow + state-machine compliance (no cold outbound)
- Per-channel `withTimeout` + try/catch in messaging init (one dead session ≠ all down)
- Process: single multi-tenant Node, `tsx` live runtime

**Costs:** ~$0/mo incremental (VPS already paid)

**What we accept:**

- Data-center IP risk (Hetzner — known but not yet flagged for our load)
- No behavioral mimicry (bot replies in <500ms; reads instantly)
- No outbound rate limits (volume so low it doesn't matter)
- Manual re-link if a session dies (operator responds same-day)

**Exit criteria → Phase 1:** 5+ paying salones OR ≥1 month of zero protocol incidents OR first sign of WA throttle (repeated 408/401 on link).

---

## Phase 1 — Beachhead (5-25 salones) · _behavioral hygiene_

**Trigger:** First paying customer + 4 more in pipeline. Reputation now matters because losing the WA line = losing the customer.

**Theme:** Free wins — behavioral mimicry + outbound discipline. **No infrastructure cost.**

### 1.1 Behavioral mimicry (bot acts human)

**Owner:** salones-wa engineering · **Effort:** 2 days · **Cost:** $0

- `sendPresenceUpdate('composing')` 800-2500ms before each reply, then `'paused'` immediately before send. Variance based on reply length (long replies → longer typing).
- Read-receipt delay: jitter `readMessages` 1-8s after delivery. Don't mark instantly.
- Response delay: randomize 500-3000ms total wait. Long messages get longer wait. Use `setTimeout` in the send path, not blocking sleeps.
- Presence cycling: don't be `available` 24/7. Match salon hours (default 9-21 with random offline gaps of 5-30 min).
- Per-conversation cadence: never send 2 messages within 500ms — chunk if needed, but space them.

**Where to wire:** `src/bot/baileys-manager.ts` outbound send path + new `src/bot/humanize.ts` module for jitter/delay helpers.

**Test:** unit tests on jitter bounds; manual smoke that delays don't break confirmation flows (state machine timeouts must accommodate).

**🟢 ACTIVATED IN PROD 2026-06-10 15:06 MX** — `HUMANIZE_ENABLED=true` set in
salones-wa's systemd `.env` + restarted (MainPID 3253607→498250, 0 failures).
Both behaviors (humanize replies + presence cycling, sub-flag default on) live for
the 1 active salon (`525640501088` "Salón Demo"); logs confirm `[humanize] ON` +
`[presence] cycling ON` + `connected ✅`, `/health` 200. Revert = set the flag
`false` + restart. **Live functional smoke PASSED 2026-06-10** (operator sent a
real inbound; reply path OK, zero server-side errors). §1.1 fully verified
end-to-end. After a reply-timing retune to a random 1–2s (`c57e3dd`, deployed
MainPID 609391), **§1.1 is CLOSED** — humanize replies + presence cycling live.
The presence gap-duration NIT is consciously deferred (optional polish, not part
of §1.1 closure). Next: §1.2 outbound rate limits.

**As-built (2026-06-10) — ✅ shipped, flag-gated.** New module
`src/bot/humanize.ts` wired into the reply path in `src/bot/baileys-manager.ts`
(the `messages.upsert` handler). Implements: jittered read receipt (fire-and-
forget, never delays the reply), `composing` typing indicator for a randomized
window → `paused` → send (the typing window _is_ the response delay).
Presence is best-effort — a Baileys presence/read failure can never drop the
real reply. 17 unit tests on jitter bounds + orchestration; full suite 449/449
green. The double-book "typing-time window" race (message-handler.ts Audit C2)
is unaffected: it is guarded by an in-transaction availability re-check, so the
added latency only widens an already-handled window.

**Reply-timing retune (2026-06-10, operator-directed):** clienta friction from
multi-second delays is **not acceptable** — the original "0.8–2.5s + 35ms/char
capped at 6s, longer-for-longer" model could push a long booking confirmation to
~6s. Superseded: the reply now lands a **randomized 1–2s** after the inbound,
**independent of reply length** (`HUMANIZE_TYPE_PER_CHAR_MS` default 0), and the
read receipt fires at 0.4–1s so the message is marked read just before the reply.

**Presence cycling — ✅ shipped 2026-06-10 (`c24ad8f`), DORMANT.** New module
`src/bot/presence.ts` + socket-lifecycle wiring in `baileys-manager.ts`:
`markOnlineOnConnect: false` when ON, plus a per-salon timer (started on `open`,
stopped at every teardown seam, generation-fenced) that sets global presence
`unavailable` outside business hours and `available` with random offline gaps
inside (default window 9-21 `America/Mexico_City`). The timer Map is keyed by
`salonId` ⇒ at most one timer per salon (no leak/stack). `sendPresenceUpdate` is
best-effort and global presence is decoupled from inbound delivery — the bot
still answers 24/7; only the _advertised_ presence changes. Shares the
`HUMANIZE_ENABLED` master switch + a `HUMANIZE_PRESENCE_CYCLING` sub-flag. 12
unit tests; suite 448/448; **qa-auditor SHIP** (timer-leak risk closed, verified
vs Baileys 7 source). _Deferred NIT:_ model gap **duration** (5-30 min dwell via
an `offlineUntil` timestamp) instead of the current per-tick re-roll (gaps are
currently exactly one tick ≈ 5 min).

_Still deferred:_ per-conversation **chunk spacing** (only relevant once replies
are split into multiple messages — they aren't today, so N/A for now).

**Default OFF.** `HUMANIZE_ENABLED` unset → instant send, zero behavior change;
`SALONES_ENV=test` also forces it off (suite stays deterministic). Operator
enables by adding env to salones-wa's systemd `.env` and restarting:

| Env var                       | Default               | Meaning                                                   |
| ----------------------------- | --------------------- | --------------------------------------------------------- |
| `HUMANIZE_ENABLED`            | `false`               | Master switch. `true`/`1` to enable.                      |
| `HUMANIZE_READ_RECEIPTS`      | `true`                | Send jittered blue ticks (visible UX).                    |
| `HUMANIZE_READ_MIN_MS`        | `400`                 | Read-receipt jitter floor.                                |
| `HUMANIZE_READ_MAX_MS`        | `1000`                | Read-receipt ceiling (≤ reply floor ⇒ read before reply). |
| `HUMANIZE_TYPE_MIN_MS`        | `1000`                | Reply delay floor (inbound → reply).                      |
| `HUMANIZE_TYPE_MAX_MS`        | `2000`                | Reply delay ceiling — reply lands a random 1–2s.          |
| `HUMANIZE_TYPE_PER_CHAR_MS`   | `0`                   | Per-char term (default 0 = length-independent timing).    |
| `HUMANIZE_TYPE_CAP_MS`        | `2000`                | Hard ceiling on the typing window.                        |
| `HUMANIZE_PRESENCE_CYCLING`   | `true`                | Presence-cycling sub-flag (needs master on).              |
| `HUMANIZE_ONLINE_START_HOUR`  | `9`                   | Local hour the bot goes `available`.                      |
| `HUMANIZE_ONLINE_END_HOUR`    | `21`                  | Local hour it goes `unavailable`; window `[start,end)`.   |
| `HUMANIZE_PRESENCE_TICK_MS`   | `300000`              | Presence re-evaluation interval (5 min).                  |
| `HUMANIZE_OFFLINE_GAP_CHANCE` | `0.15`                | P(brief offline gap) per in-hours tick.                   |
| `HUMANIZE_PRESENCE_TZ`        | `America/Mexico_City` | TZ the hours resolve in.                                  |

**Operator smoke (before broad enable):** set `HUMANIZE_ENABLED=true` for one
test salon (or a staging number), restart, send a few inbounds, and confirm:
(1) the "escribiendo…" indicator shows then the reply lands a snappy **1–2s**
later (same speed for a long booking confirmation as a short "sí");
(2) blue ticks appear ~0.4–1s after delivery (just before the reply), not instantly;
(3) a full booking confirmation flow ("¿Confirmas?" → "Sí") still completes — no
state-machine timeout breakage. Heads-up: the typing indicator **and** blue
ticks are visible to real clientas; set `HUMANIZE_READ_RECEIPTS=false` to keep
read receipts off if the salon prefers no blue ticks.

### 1.2 Outbound rate limits

**Owner:** salones-wa engineering · **Effort:** 1 day · **Cost:** $0

- Hard cap per (salon, clienta) pair: **max 5 outbound messages/day** unsolicited. Reactive replies to inbound = unlimited.
- Hard cap per salon: **max 200 outbound/day** global (covers reminders + replies).
- Reminders count against the cap. If a salon needs more, scale via second number, not by raising the cap.
- Persist counters in SQLite (`outbound_counter` table: `salon_id, clienta_phone, day, count`).
- On cap hit: silently drop, log warning, never error to user.

**Where to wire:** new `src/bot/rate-limiter.ts` between `messageHandler.reply()` and `baileys.send()`.

**As-built (2026-06-10) — ✅ shipped, DORMANT behind a flag.** New
`src/bot/rate-limiter.ts` (pure `decideUnsolicited` + SQLite counters +
`gateUnsolicited` orchestrator). Two operator decisions shaped it:

- **Reactive replies are NEVER dropped.** Only the 3 unsolicited crons
  (`remind-24h`, `remind-2h`, `reactivation`) are gated. A reply only
  _increments_ the per-salon daily total (so the 200 cap reflects true volume);
  it is never blocked. The reply hot-path calls `recordReplyOutbound`, a no-op
  while disabled.
- **Two caps, per salon-LOCAL day:** `RATE_LIMIT_PER_PAIR` (5) unsolicited per
  (salon, clienta); `RATE_LIMIT_PER_SALON_DAY` (200) total per salon. Counters:
  `outbound_counter(salon_id, clienta_phone, day, count)` (per-pair unsolicited)
  - `outbound_salon_daily(salon_id, day, total)` (all outbound). `recordUnsolicited`
    bumps both; `recordReply` bumps the total only. Decision: pair<5 AND total<200.
- **Send-before-record** (W6): a dropped reminder is not marked reminded (stays
  retry-eligible); a dropped reactivation skips campaign/state. A salon-cap drop
  ends that salon's reactivation run; a pair-cap drop skips the one contact.
- **Silent drop is never invisible:** `/metrics` exposes
  `salones_wa_outbound_dropped_total{salon_id,kind,reason}` + a `console.warn`.
- The reactivation cron's existing in-run `RATE_LIMIT_PER_SALON=20` (batch
  fairness) is kept — it's orthogonal to the new persisted daily caps.
- Counters pruned >7 days by the daily `update-dormant` cron.

**Default OFF.** `RATE_LIMIT_ENABLED` unset ⇒ `gateUnsolicited` always sends and
records nothing (crons unchanged); `SALONES_ENV=test` forces off. 18 unit tests
(+2 metrics) on a real in-memory SQLite; full suite 469/469; **qa-auditor SHIP**
(replies-never-dropped + dormant-inert + send-before-record verified). Tables are
created at the next restart (`CREATE TABLE IF NOT EXISTS`); to enable: set
`RATE_LIMIT_ENABLED=true` (+ caps) in the systemd `.env` and restart.

| Env var                    | Default               | Meaning                                           |
| -------------------------- | --------------------- | ------------------------------------------------- |
| `RATE_LIMIT_ENABLED`       | `false`               | Master switch. `true`/`1` to enable.              |
| `RATE_LIMIT_PER_PAIR`      | `5`                   | Max unsolicited/day per (salon, clienta).         |
| `RATE_LIMIT_PER_SALON_DAY` | `200`                 | Max total outbound/day per salon (incl. replies). |
| `RATE_LIMIT_TZ`            | `America/Mexico_City` | TZ for the per-day counter boundary.              |

_Note:_ scope deviates intentionally from the plan's "wire between reply and
send" — replies are reactive/unlimited, so the gate lives on the cron paths, not
the reply path. At the current 1-salon scale the caps never fire; this is
preventive, for onboarding salones 2–5.

### 1.3 Opt-out audit + hardening

**Owner:** salones-wa engineering · **Effort:** 0.5 day · **Cost:** $0

- Verify OPT_OUT intent → `salon_clienta_optouts` table → bot will not send to that phone ever again from that salon. Currently exists; **audit the path end-to-end** to confirm no race lets a follow-up squeeze through.
- Add `optout_check` as a hard gate in the send pipeline (not just at intent dispatch).
- Reply once to opt-out confirmation, then never again. Even "ok te quito" should be the LAST message ever sent.

**As-built (2026-06-10) — ✅ shipped, ACTIVE (not flag-gated — compliance).**
The opt-out store is the `contacts.opt_out` column (the plan's
`salon_clienta_optouts` table never existed — trust the code). End-to-end audit
found the path mostly solid: detect (`intent-parser` `OPT_OUT_PATTERNS` →
`opt_out` intent) → record (`markContactOptOut` sets `opt_out=1, name=NULL`) →
reply path goes **silent** for an opted-out inbound (`message-handler.ts:142` →
`reply:null`) and sends exactly **one** confirmation (`:152` → `optOutConfirmed()`)
→ reminders skip per-iteration → `getDormantContacts` filters `opt_out=0`.

**Gap closed:** the **reactivation** cron queried dormant contacts once then sent
over minutes with no per-send re-check — a clienta who said BAJA mid-run still
got messaged. Fix: a **send-time opt-out hard gate** (`isContactOptedOut`) as the
FIRST check in `gateUnsolicited`, ABOVE the rate-limit flag — so it's enforced on
every unsolicited send even when §1.2 rate limiting is OFF. An opt-out drop
records `salones_wa_outbound_dropped_total{reason="opt_out"}`, never sends, never
counts, and (send-before-record) never marks the reminder / creates the campaign.
The reactive reply + the one-time confirmation are NOT on this chokepoint, so
they're untouched. Indexed via `UNIQUE(salon_id, phone)`. 4 unit tests (+ existing
message-handler opt-out coverage); suite 473/473; **qa-auditor SHIP**. _Also
cleaned a stray NUL byte in the §1.2 drop-counter key (now `JSON.stringify`)._

### 1.4 Onboarding policy: "WA must be aged"

**Owner:** Operator (product policy) · **Effort:** Documentation · **Cost:** $0

- New onboarding rule: salon's WA number must have been **active for 90+ days** before linking. Fresh SIMs are flagged by WA on day 1; we will not link them.
- Add to sales contract + onboarding checklist + `/admin` form helper text.
- Document in `docs/ONBOARDING.md` (create if not exists).

### 1.5 Disconnect-code metrics

**Owner:** salones-wa engineering · **Effort:** 0.5 day · **Cost:** $0

- Log every Baileys disconnect with `{salon_id, code, reason, timestamp}` to a `disconnects` table.
- Expose `/metrics` endpoint with Prometheus counters: `salones_wa_disconnects_total{salon_id, code}`.
- This is the early-warning system for §2.1 (proxies). When disconnect rate per salon climbs, escalate.
- Parallels `mission-control` task #230 — same code pattern, different service.

**As-built (2026-06-11) — ✅ shipped, ACTIVE (always-on observability, no flag).**
New counter `salones_wa_disconnect_total{salon_id, code, reason}` on the existing
**ADMIN_TOKEN-gated** `/metrics`, instrumented from the `connection:"close"` branch
of `baileys-manager.ts` (generation-fenced — a superseded zombie socket's late
close is never counted). `code` is the Baileys `DisconnectReason` status (or
`"none"` when the error carries no Boom status); `reason` is its **bounded**
symbolic name via `disconnectReasonName` (515→`restartRequired`, 401→`loggedOut`,
403→`forbidden`, …; unmapped/absent ⇒ `"unknown"`). 408 is canonicalized to
`connectionLost` (Baileys aliases 408 = connectionLost = timedOut).

**Two deliberate divergences from the spec, both justified:**

1. **No `disconnects` table.** Counters are **in-memory** (a `Map`, mirroring the
   §1.2 drop counter + the conn-state registry), resetting on restart. Durability
   is owned by **mc-prometheus** (it scrapes `/metrics` and applies `for:` /
   `increase()` over time) — a SQLite table would duplicate that and add write
   load on the hot disconnect path. The free-text error message is logged (not a
   label) so the forensic detail still lands in `journalctl`.
2. **`reason` label added + cardinality bounded.** The spec's free-text `reason`
   is NOT used as a label (that would blow up Prometheus cardinality); only the
   9-value symbolic enum reaches the label. Counter name is singular
   (`…_disconnect_total`) to match the existing `salones_wa_baileys_*` family.

13 unit tests (8 in `baileys-state.test.ts`: reason-map + counter; 5 in
`observability.test.ts`: render + a `/metrics` integration assertion); suite
486/486; **qa-auditor SHIP** (all 4 adversarial claims — cardinality,
generation-fence, 408-alias, reset semantics — verified against source).
**On disk, NOT yet deployed** — salones-wa is tsx-live, so the counter goes live
on the next service restart (no separate build step). Wire mc-prometheus's
disconnect-rate alert (§2.1 trigger: >2% sustained 24h) once scraped.

### Phase 1 cost summary

| Item                | Cost      |
| ------------------- | --------- |
| Engineering         | ~4 days   |
| Infra               | $0/mo     |
| **Total recurring** | **$0/mo** |

### Exit criteria → Phase 2

- 5+ behavioral-hygiene features shipped
- All Phase 1 metrics dashboards live
- 25+ paying salones OR first WA throttle event observed (>2% disconnect rate sustained 24h)

---

## Phase 2 — Local scale (25-100 salones) · _IP diversification_

**Trigger:** 25+ paying salones. Data-center IP risk compounds at this scale; one IP-level WA flag kills the entire portfolio in one event.

**Theme:** Buy time with residential proxies. First real infra cost.

### 2.1 Residential proxies per Baileys session

**Owner:** salones-wa engineering + operator (provider procurement) · **Effort:** 3-5 days · **Cost:** $300-500/mo at 100 salones

**Why:** Each salon's Baileys WS connects through a different residential IP. WA sees the traffic as 100 different homes/cafes, not one data-center.

**Provider shortlist:**

- **Webshare** (~$3-6/static residential IP/mo) — best price/perf for our use case
- **IPRoyal** (~$5-8/IP/mo) — strong rotation pool
- **Smartproxy** (~$5-10/IP/mo) — solid reputation
- **BrightData** (~$10-15/IP/mo) — premium, overkill for us
- Avoid datacenter proxies — they don't solve the problem

**Wire-in:**

- Add `WA_PROXY_URL` per-salon in `salons` table (nullable; null = direct).
- In `baileys-manager.ts`, when `makeWASocket` is constructed, pass `agent: new HttpsProxyAgent(proxyUrl)` if set.
- Provider SDK: `https-proxy-agent` or `socks-proxy-agent` (both standard npm).
- Test path: link a salon through proxy, verify message round-trip, confirm `creds.json` persists.

**Operational:**

- Maintain a proxy pool spreadsheet: `salon_id → proxy_endpoint → last_health_check`.
- Rotation policy: don't rotate during a healthy session (rotation = new IP = re-fingerprint risk). Only rotate on proxy failure or proven WA flag.
- Health check: ping each proxy 1x/hr, alert if down.

**Mid-scale shortcut (25-50 salones):** instead of per-salon residential, use 2-3 residential proxies and shard salones across them. Saves money, still meaningfully reduces blast radius vs 1 IP. Upgrade to per-salon at 50+.

### 2.2 Per-VPS sharding (complement, not replacement)

**Owner:** Operator (infra) · **Effort:** 1 day per new VPS · **Cost:** ~$10-20/VPS/mo

- 100 salones spread across 2-4 VPSs ≠ 100 salones on 1 VPS. Different data-center IPs even before proxies.
- Use this as belt-and-suspenders WITH proxies, not instead of.
- Each VPS runs its own salones-wa instance with a subset of salones (assign by `salon_id % N` or by region).
- Shared SQLite is a problem — use Supabase or a small Postgres for cross-VPS state if you go this route.

**Decision gate:** only shard if proxy strategy is insufficient (rare). Default: 1 VPS + proxies.

### 2.3 App-version pinning + quarterly bumps

**Owner:** salones-wa engineering · **Effort:** 0.5 day setup, 1hr/qtr · **Cost:** $0

- Pin `makeWASocket({version: [2, 3000, X]})` to current real WA Web version.
- Bump quarterly when WA Web updates (track via `npm view @whiskeysockets/baileys` for hints, or watch [WhatsApp Web JS](https://github.com/pedroslopez/whatsapp-web.js) for version refs).
- Document the pin + bump cadence in `docs/RUNBOOK-baileys-resilience.md`.

### 2.4 Session-longevity instrumentation

**Owner:** salones-wa engineering · **Effort:** 1 day · **Cost:** $0

- Track per-salon session age: `session_age_days = now() - linked_at`.
- Expose as Prometheus gauge: `salones_wa_session_age_days{salon_id}`.
- Alert if avg session age across portfolio drops below 14 days (signals high re-link rate = WA pressure).
- Target: 30+ day session lifetime as the healthy baseline.

### 2.5 Spam-report defense in product UX

**Owner:** salones-wa engineering + product · **Effort:** 2 days · **Cost:** $0

The single fastest account-killer is clientas reporting the bot as spam. Product defenses:

- First-message disclaimer: every new conversation starts with "Hola, soy el asistente automatizado de [Salón]. Respondo 24/7. Escribe STOP para dejar de recibir mensajes."
- STOP/OPT_OUT works in any language: stop, baja, no, alto, cancel, desuscribir, etc.
- Never send promotional content unless explicitly opted in.
- Confirmation cadence: confirm bookings once, remind once 24h before, once 2h before. Never more.
- No "did you get my message?" follow-ups. If clienta doesn't reply, conversation ends silently.

### Phase 2 cost summary

| Item                               | Cost                           |
| ---------------------------------- | ------------------------------ |
| Engineering                        | ~7 days total                  |
| Residential proxies (100 salones)  | ~$300-500/mo                   |
| Extra VPSs (optional, 0-3)         | $0-60/mo                       |
| **Total recurring at 100 salones** | **~$300-560/mo (~$3-6/salon)** |

### Exit criteria → Phase 3

- All Phase 2 features shipped
- Proxy infrastructure stable for 30 days
- Disconnect rate <2% sustained
- 100+ paying salones OR signs of WA pushback even with proxies (sustained 401 cycles, link failures from multiple salones in one week)

---

## Phase 3 — Regional scale (100-500 salones) · _adversarial hardening_

**Trigger:** 100+ salones. WA's anti-abuse heuristics are smarter than per-IP at this scale; they correlate device fingerprints, behavioral signatures, and account graphs. Phase 2 mitigations remain necessary but become insufficient.

**Theme:** Treat WA as adversarial. Invest in resilience, observability, and a hybrid stack option.

### 3.1 Per-salon process isolation (selective)

**Owner:** salones-wa engineering · **Effort:** 1 week · **Cost:** RAM (negligible at this scale)

- Currently: 1 Node process for all salones. One bad message in Baileys can crash the router. Per-channel try/catch helps but doesn't isolate at the process level.
- Move to: 1 Node process per N=10 salones (configurable). Process supervisor (systemd template units or PM2) restarts on crash.
- Trade-off: ~80 MB per process × 10 processes = ~800 MB. Acceptable at this scale (4-8 GB VPS).
- Benefits: blast radius shrinks 10×; crash recovery is per-process; can rolling-restart for upgrades without downtime.

**Wire-in:**

- `systemd` template unit: `salones-wa@<shard_id>.service` reads `SHARD_ID` env, processes salones where `salon_id % N = SHARD_ID`.
- Shared SQLite via WAL mode (already default) — multi-process readers/writers OK with proper transactions.

### 3.2 Mobile proxies for high-value salones

**Owner:** Operator (selective procurement) · **Effort:** 0 (provider SDK same as Phase 2) · **Cost:** $30-100/IP/mo

- Mobile carrier IPs (4G/5G) have the best reputation with WA (real consumer devices).
- Use for top-tier salones (high revenue, high WA volume) where downtime is most expensive.
- Don't use for whole portfolio — cost-prohibitive. Mix: 80% static residential ($5/IP) + 20% mobile ($50/IP).
- Providers: Soax, IPRoyal Mobile, ProxyEmpire.

### 3.3 Multi-region VPS deployment

**Owner:** Operator (infra) · **Effort:** 2-3 days per new region · **Cost:** $20-40/VPS/mo per region

- 500 salones on one VPS in one data center is a single point of failure (DC outage, IP-block, regulatory).
- Distribute across 3+ regions (Hetzner DE + DE + US, or DO MX + US + EU).
- Region assignment by salon: prefer geographic proximity (latency to WA's nearest server).
- Cross-region state via Supabase (already running at `db.mycommit.net`) instead of per-VPS SQLite.

### 3.4 Real-time anti-abuse alerting

**Owner:** salones-wa engineering · **Effort:** 2 days · **Cost:** $0

Build on Phase 1.5 disconnect metrics:

- Alert (Telegram → operator) when:
  - Portfolio-wide disconnect rate >5% in 1hr
  - Single salon flaps >3× in 24hr
  - Link failure rate >20% on new pairings in 24hr
  - Pairing-code generation spike (signal of mass re-link demand)
- Auto-circuit-breaker per salon: 5 disconnects in 1hr → quarantine that salon's outbound for 1hr (don't send anything; let WA's flag cool).

### 3.5 Hybrid stack option: WA Business API for high-volume tier

**Owner:** Operator (commercial) + engineering · **Effort:** 1-2 weeks integration · **Cost:** ~$5-30/salon/mo + per-conv fees

- For salones generating >5,000 conversations/mo (high-volume), WA Business API pays off vs the operational overhead of Baileys.
- Tier the product: "Standard" ($500/mo Baileys-backed) vs "Pro" ($1500/mo WA Business API backed).
- Pro tier: official, no protocol risk, can broadcast templates, no anti-abuse worry.
- Build a stack-agnostic message layer in salones-wa so per-salon choice is config, not code.

**Note:** This contradicts the original "no WA Business API" constraint — but at 500+ scale and for the **top 10% of salones**, the math works. Standard salones stay on Baileys.

### Phase 3 cost summary

| Item                                       | Cost                                |
| ------------------------------------------ | ----------------------------------- |
| Engineering                                | ~3 weeks total                      |
| Standard residential proxies (400 salones) | ~$1,200-2,000/mo                    |
| Mobile proxies (100 high-value)            | ~$3,000-5,000/mo                    |
| Multi-region VPS (3 regions)               | ~$60-120/mo                         |
| WA Business API (~50 Pro-tier salones)     | ~$250-1,500/mo                      |
| **Total recurring at 500 salones**         | **~$4,500-8,600/mo (~$9-17/salon)** |
| Revenue at 500 salones ($500-800/mo avg)   | $250,000-400,000/mo                 |
| Infra as % of revenue                      | **<3%**                             |

### Exit criteria → Phase 4

- All Phase 3 features shipped, multi-region stable for 90 days
- Hybrid Baileys + Business API stack proven
- 500+ paying salones OR business pivots to multi-vertical (lavanderías, talleres, dentistas)

---

## Phase 4 — Multi-vertical (500+) · _insurance + diversification_

**Trigger:** 500+ salones OR expansion to second vertical (lavandería, taller, etc per `README.md` plan).

**Theme:** WA channel is no longer a single point of failure. The business expands to channels and verticals that route around WA dependency entirely.

### 4.1 Channel diversification

**Owner:** Engineering + product · **Effort:** 4-6 weeks per channel · **Cost:** varies

- Add Instagram DM bot (same product, different channel) via Meta's official Instagram Messaging API.
- Add Telegram bot for tech-comfortable salones (free, no anti-abuse).
- Add SMS fallback (Twilio MX, ~$0.04/sms) for critical notifications (reminders).
- Customers pick channels; product is channel-agnostic at the conversation layer.

### 4.2 Multi-vertical product fork

**Owner:** Product · **Effort:** quarterly · **Cost:** per-vertical engineering

- Per `README.md`: Lavanderías, Talleres, Dentistas, etc.
- Each vertical = different `services` schema, different conversation flows, but same underlying state machine + Baileys + proxy + behavioral hygiene stack.
- Code: per-vertical packages in monorepo, shared `bot-core` lib.

### 4.3 Compliance + legal hardening

**Owner:** Operator (legal) · **Effort:** consult lawyer · **Cost:** ~$1,500 one-time + ~$300/mo retainer

- ToS that limits liability if WA bans a salon's number (your fault, not ours, but we'll re-link).
- Data residency policy (clientas' personal data + conversation logs).
- Mexican LFPDPPP compliance audit.
- Insurance: business continuity policy that covers a mass WA-side event.

### 4.4 Long-term: own the protocol

**Owner:** Strategic · **Effort:** 6-12 months · **Cost:** significant engineering

- At 1000+ salones, the cost of being beholden to WA is existential. Investigate:
  - Pivot to multi-channel-first product where WA is one channel of many (Instagram, Telegram, SMS, web chat).
  - Build a salon's own branded chat (web widget + mobile app), use WA only for last-mile reminders.
- Endgame: WA is a notification channel, not the product surface.

### Phase 4 cost summary

Highly variable based on which strategic bets. Plan range: 5-15% of revenue.

---

## Cross-phase rules of engagement

### Always-on (every phase)

1. **No cold outbound.** Bot only replies to inbound or sends opt-in reminders. Period.
2. **OPT_OUT is sacred.** Once a clienta opts out, never send to that phone from that salon again. Programmatic gate at every send path.
3. **One message per logical reply.** Chunking is OK with >500ms spacing; bursts are spam to WA's eye.
4. **No promotional broadcasts.** Booking confirmations + reminders only. If a salon wants promo, it's an upsell that uses Business API.
5. **Pre-link aging.** Salon's WA must be 90+ days active. Onboarding hard requirement.
6. **Session preservation > convenience.** Never re-pair to "reset state." Investigate before nuking creds.
7. **Operator transparency.** Every WA-side incident gets a postmortem to operator within 24hr. They sell trust; we keep it.

### Escalation triggers (jump to next phase early)

Don't wait for the salon-count threshold if any of these fire:

- Sustained disconnect rate >2% for 7 days → Phase 2 (proxies)
- Single WA-side event takes down 10+ salones → Phase 3 (process isolation + multi-region)
- WA Web protocol breaks Baileys (next "doom bomb") → emergency Phase 2/3 rollout
- 2+ spam reports per month per salon (avg) → Phase 1 audit + product UX hardening

### Decision log

Maintain a doc at `docs/WA-INCIDENTS.md` in the `salones-wa` repo:

- Every WA-side incident: date, scope (salones affected), root cause, mitigation, time-to-recover.
- Quarterly review: are the right phase mitigations deployed for current scale?

---

## Open questions / decisions deferred

1. **Proxy provider commit:** lock in Webshare for Phase 2 or shop alternatives? → Decide at 20-salon mark.
2. **Multi-tenant vs sharded process:** stay multi-tenant until 100 salones, or shard earlier? → Depends on first crash blast-radius event.
3. **Pro-tier pricing model:** is $1,500/mo the right Business API price point for MX? → Validate with first 5 prospects asking for guarantees.
4. **Cross-region state:** Supabase vs per-VPS SQLite + sync? → Decide at Phase 3 trigger.
5. **Instagram DM integration timing:** start in Phase 3 or wait for Phase 4? → Customer demand-driven.

---

## Related docs

- `salones-wa/docs/RUNBOOK-baileys-resilience.md` — operational runbook for Baileys session resilience
- `salones-wa/docs/FLUJOS.md` — conversation flows (Flujo 1c custom-time, etc)
- `salones-wa/docs/SCHEMA.md` — DB schema
- `salones-wa/docs/MVP-PLAN.md` — original MVP plan
- `negocios-auto-gestionados/verticales/salones-belleza/README.md` — business plan + TAM
- `negocios-auto-gestionados/verticales/salones-belleza/MVP-PLAN.md` — vertical-specific MVP

---

_Last updated: 2026-05-24. Next review: at 20-salon mark, or on first WA-side incident._
