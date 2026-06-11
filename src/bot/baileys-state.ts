/**
 * Per-salon Baileys connection-state registry.
 *
 * The baileys-manager `instances` Map is deleted on every disconnect/logout —
 * so a DOWN salon vanishes from it. For observability we need the opposite:
 * a record that PERSISTS the last-known state (incl. logged_out) and the last
 * time the salon was actually connected. This module is that registry, plus
 * the pure functions that turn it into a health verdict (used by both the
 * /health/salons + /metrics endpoints and the disconnect-watch cron).
 *
 * In-memory by design: the durable ">24h disconnected" alert is owned by
 * mc-prometheus (it scrapes /metrics and applies a `for: 24h` clause, which
 * survives this process restarting). `lastConnectedAt` here resets on restart;
 * that's fine because the registry is only the instantaneous signal.
 */

export type BaileysConnState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "logged_out";

/** Canonical ordering for the Prometheus enum gauge (one series per state). */
export const BAILEYS_STATES: readonly BaileysConnState[] = [
  "connecting",
  "connected",
  "reconnecting",
  "logged_out",
] as const;

export interface SalonConnState {
  salonId: string;
  salonPhone: string;
  state: BaileysConnState;
  /** Epoch ms the CURRENT state was entered (stable across repeats). */
  since: number;
  /** Epoch ms of the last time state became "connected" (null if never). */
  lastConnectedAt: number | null;
  /** Epoch ms of the last record write. */
  updatedAt: number;
}

const registry = new Map<string, SalonConnState>();

/** Process boot time — the reference for a salon that has NEVER connected. */
const BOOT_TIME_MS = Date.now();

/** Boot reference, for callers that need it (cron / endpoints). */
export function getBootTime(): number {
  return BOOT_TIME_MS;
}

/**
 * Record a connection-state transition for a salon. Idempotent on the state
 * value: re-recording the same state preserves `since` (so a flapping
 * reconnect doesn't keep resetting the "in state X since" clock), while
 * `lastConnectedAt` only advances when the state is "connected".
 */
export function recordSalonState(
  salonId: string,
  salonPhone: string,
  state: BaileysConnState,
  nowMs: number = Date.now(),
): void {
  const prev = registry.get(salonId);
  registry.set(salonId, {
    salonId,
    salonPhone,
    state,
    since: prev && prev.state === state ? prev.since : nowMs,
    lastConnectedAt:
      state === "connected" ? nowMs : (prev?.lastConnectedAt ?? null),
    updatedAt: nowMs,
  });
}

export function getSalonConnState(salonId: string): SalonConnState | undefined {
  return registry.get(salonId);
}

export function getAllSalonConnStates(): SalonConnState[] {
  return [...registry.values()];
}

/** Test helper — clear the registry between cases. */
export function resetSalonConnStates(): void {
  registry.clear();
}

// ─── Disconnect counter (§1.5) ──────────────────────────────────────────────

/**
 * In-memory disconnect tally for /metrics, mirroring the §1.2 outbound-drop
 * counter. Every `connection: "close"` the LIVE socket sees is counted, labeled
 * by the Baileys DisconnectReason status code + its symbolic name — so the
 * operator can tell benign churn (515 restartRequired right after a link) from a
 * real incident (401 loggedOut, 403 forbidden = WA blocked the number/IP).
 * In-memory by design: like the rest of this registry, mc-prometheus owns
 * durability via scrape and this resets on process restart.
 */
const disconnectCounts = new Map<string, number>();

/**
 * Symbolic name for a Baileys DisconnectReason status code. Hardcoded — the enum
 * is a stable protocol-level set — so the metrics layer needn't import the heavy
 * Baileys bundle. This BOUNDS the `reason` label's cardinality: an unmapped or
 * absent code collapses to "unknown" rather than leaking the free-text error
 * message (which would blow up Prometheus label cardinality). Note Baileys
 * aliases 408 to BOTH connectionLost and timedOut; we canonicalize it to
 * connectionLost.
 */
const DISCONNECT_REASON_NAMES: Readonly<Record<number, string>> = {
  401: "loggedOut",
  403: "forbidden",
  408: "connectionLost", // Baileys: 408 = connectionLost = timedOut (aliased)
  411: "multideviceMismatch",
  428: "connectionClosed",
  440: "connectionReplaced",
  500: "badSession",
  503: "unavailableService",
  515: "restartRequired",
};

/** Map a DisconnectReason status code to its symbolic name (unmapped/absent ⇒ "unknown"). */
export function disconnectReasonName(code: number | undefined): string {
  if (code === undefined) return "unknown";
  return DISCONNECT_REASON_NAMES[code] ?? "unknown";
}

/**
 * Tally one socket disconnect by its DisconnectReason status code. A missing
 * code (the error carried no Boom status) is bucketed under code="none". The
 * symbolic reason is derived here so the label set stays bounded; the raw error
 * message is intentionally NOT used as a label.
 */
export function recordDisconnect(
  salonId: string,
  code: number | undefined,
): void {
  const codeLabel = code === undefined ? "none" : String(code);
  const key = JSON.stringify([salonId, codeLabel, disconnectReasonName(code)]);
  disconnectCounts.set(key, (disconnectCounts.get(key) ?? 0) + 1);
}

export function snapshotDisconnects(): Array<{
  salonId: string;
  code: string;
  reason: string;
  count: number;
}> {
  const out: Array<{
    salonId: string;
    code: string;
    reason: string;
    count: number;
  }> = [];
  for (const [key, count] of disconnectCounts) {
    const [salonId, code, reason] = JSON.parse(key) as [string, string, string];
    out.push({ salonId, code, reason, count });
  }
  return out;
}

/** Test helper — clear the disconnect tally between cases. */
export function resetDisconnects(): void {
  disconnectCounts.clear();
}

// ─── Health evaluation (pure) ──────────────────────────────────────────────

export interface SalonHealth {
  salonId: string;
  name: string;
  phone: string;
  active: boolean;
  /** "unknown" = active salon with no registry record yet (e.g. just booted). */
  state: BaileysConnState | "unknown";
  /** Epoch ms current state entered (null if unknown). */
  since: number | null;
  lastConnectedAt: number | null;
  /** Seconds since last connection (null while connected). */
  downForSeconds: number | null;
  /** True if not connected AND down longer than the alert threshold. */
  stale: boolean;
}

interface HealthOpts {
  nowMs: number;
  thresholdMs: number;
  bootMs: number;
}

/**
 * Combine a salon row with its (possibly absent) connection record into a
 * health verdict. "Down for" is measured from the last successful connection,
 * or from process boot if it has never connected since this process started.
 */
export function evaluateSalonHealth(
  salon: { id: string; name: string; phone: string; active: number | boolean },
  record: SalonConnState | undefined,
  opts: HealthOpts,
): SalonHealth {
  const state: BaileysConnState | "unknown" = record?.state ?? "unknown";
  const lastConnectedAt = record?.lastConnectedAt ?? null;
  const connected = state === "connected";
  const referenceMs = lastConnectedAt ?? opts.bootMs;
  const downForMs = connected ? 0 : Math.max(0, opts.nowMs - referenceMs);
  return {
    salonId: salon.id,
    name: salon.name,
    phone: salon.phone,
    active: Boolean(salon.active),
    state,
    since: record?.since ?? null,
    lastConnectedAt,
    downForSeconds: connected ? null : Math.floor(downForMs / 1000),
    stale: !connected && downForMs > opts.thresholdMs,
  };
}

/** Active salons that are stale (disconnected past the threshold). */
export function findStaleSalons(healths: SalonHealth[]): SalonHealth[] {
  return healths.filter((h) => h.active && h.stale);
}

const DEFAULT_ALERT_HOURS = 24;

/**
 * Disconnect-alert threshold in hours. Env-overridable via
 * SALON_DISCONNECT_ALERT_HOURS. An unset or non-numeric value uses the 24h
 * default; a numeric value is floored to a whole hour and clamped to a 1h
 * minimum (so `0.5`/`0` → 1h, not the 24h default). Single source of truth
 * shared by the /health/salons + /metrics endpoints and the disconnect-watch
 * cron.
 */
export function disconnectAlertHours(): number {
  const raw = Number(process.env["SALON_DISCONNECT_ALERT_HOURS"]);
  if (!Number.isFinite(raw)) return DEFAULT_ALERT_HOURS;
  return Math.max(1, Math.floor(raw));
}

// ─── Liveness watchdog (self-heal stuck sockets) ────────────────────────────

const DEFAULT_STUCK_MINUTES = 5;

/**
 * Minutes a salon may sit non-`connected` before the liveness watchdog
 * force-reconnects it. Env-overridable via BAILEYS_RECONNECT_STUCK_MINUTES,
 * floored at 1, default 5. Much shorter than `disconnectAlertHours` (which is
 * the human-alert horizon) — the watchdog RECOVERS in minutes; the cron/mc
 * alert only fires if recovery keeps failing for ~a day.
 */
export function reconnectStuckMinutes(): number {
  const raw = Number(process.env["BAILEYS_RECONNECT_STUCK_MINUTES"]);
  if (!Number.isFinite(raw)) return DEFAULT_STUCK_MINUTES;
  return Math.max(1, Math.floor(raw));
}

const DEFAULT_MAX_STRIKES = 5;

/**
 * Max consecutive watchdog reinits of one salon before giving up until it
 * recovers (qa-W2, RUNBOOK §3 3-strike rule): a salon that can never reconnect
 * — e.g. WA blocking the data-center IP — must NOT be hammered forever
 * (~288 handshakes/day → account ban). Env BAILEYS_RECONNECT_MAX_STRIKES,
 * floored at 1, default 5. The strike count resets when the salon reaches
 * `connected`; the disconnect-watch cron / mc alert escalates a salon that
 * exhausts its strikes to a human.
 */
export function reconnectMaxStrikes(): number {
  const raw = Number(process.env["BAILEYS_RECONNECT_MAX_STRIKES"]);
  if (!Number.isFinite(raw)) return DEFAULT_MAX_STRIKES;
  return Math.max(1, Math.floor(raw));
}

export interface ReinitSelectOpts {
  nowMs: number;
  /** Non-connected longer than this (ms) → reconnect candidate. */
  stuckMs: number;
  /** Min gap (ms) between self-heals of the same salon (burn-loop guard). */
  cooldownMs: number;
  /** Process boot, for an active salon that has NO record yet. */
  bootMs: number;
  /** salonId → epoch ms of last watchdog reinit. */
  lastHealAt: Map<string, number>;
  /** salonId → consecutive reinit count since last `connected` (3-strike). */
  strikes: Map<string, number>;
  /** Stop reiniting a salon once it has this many consecutive strikes. */
  maxStrikes: number;
}

/**
 * Pure: which active salons should the watchdog force-reconnect right now?
 *
 * A salon is a candidate when it has been non-`connected` longer than
 * `stuckMs` AND is not within its post-heal cooldown. Two states are NEVER
 * healed: `connected` (healthy) and `logged_out` (session invalidated — a
 * reinit would just spin up a socket that logs out again, the exact burn loop
 * the RUNBOOK 3-strike rule forbids; that needs a manual re-link). A salon
 * with no record at all is treated as stuck-since-boot.
 *
 * Normal flapping (close → reconnecting → connected in seconds) never trips
 * this: each transition resets `since`, so `now - since` stays small. Only a
 * frozen-stuck socket (no events firing, `since` not advancing) crosses the
 * threshold — which is precisely the zombie case the close-event-driven
 * reconnect cannot recover on its own.
 */
export function selectSalonsToReinit(
  activeSalons: { id: string; phone: string }[],
  records: Map<string, SalonConnState>,
  opts: ReinitSelectOpts,
): string[] {
  const out: string[] = [];
  for (const s of activeSalons) {
    if ((opts.strikes.get(s.id) ?? 0) >= opts.maxStrikes) continue; // gave up
    const lastHeal = opts.lastHealAt.get(s.id) ?? 0;
    if (opts.nowMs - lastHeal < opts.cooldownMs) continue; // cooling down
    const r = records.get(s.id);
    if (!r) {
      if (opts.nowMs - opts.bootMs > opts.stuckMs) out.push(s.id);
      continue;
    }
    if (r.state === "connected") continue;
    if (r.state === "logged_out") continue; // manual re-link; never burn-loop
    if (opts.nowMs - r.since > opts.stuckMs) out.push(s.id);
  }
  return out;
}

export interface WatchdogTickOpts {
  nowMs: number;
  stuckMs: number;
  cooldownMs: number;
  bootMs: number;
  maxStrikes: number;
  /** Persistent state, MUTATED in place: salonId → consecutive reinit count. */
  strikes: Map<string, number>;
  /** Persistent state, MUTATED in place: salonId → last reinit epoch ms. */
  lastHealAt: Map<string, number>;
  /** Injected predicate (qa-W4): has this salon completed pairing? */
  isRegistered: (salonId: string) => boolean;
}

export interface WatchdogTickResult {
  /** salonIds to force-reconnect this tick. */
  reinit: string[];
  /** Subset of `reinit` that just hit the strike cap (log "giving up"). */
  gaveUp: string[];
}

/**
 * Decide one watchdog tick. Pure except for the injected `isRegistered`
 * predicate and the in-place mutation of the persistent `strikes`/`lastHealAt`
 * maps — the actual reinit + logging side effects stay in index.ts. Extracted
 * so the 3-strike / reset-on-recovery / onboarding-skip logic is unit-testable
 * (qa-W-B), mirroring the pure `selectSalonsToReinit`.
 */
export function planWatchdogTick(
  activeSalons: { id: string; phone: string }[],
  records: Map<string, SalonConnState>,
  opts: WatchdogTickOpts,
): WatchdogTickResult {
  // Recovered salons get a clean slate (qa-W2): a future incident gets a fresh
  // strike allowance, and the cooldown clears so a later stall heals promptly.
  for (const r of records.values()) {
    if (r.state === "connected") {
      opts.strikes.delete(r.salonId);
      opts.lastHealAt.delete(r.salonId);
    }
  }

  const candidates = selectSalonsToReinit(activeSalons, records, {
    nowMs: opts.nowMs,
    stuckMs: opts.stuckMs,
    cooldownMs: opts.cooldownMs,
    bootMs: opts.bootMs,
    lastHealAt: opts.lastHealAt,
    strikes: opts.strikes,
    maxStrikes: opts.maxStrikes,
  });

  const reinit: string[] = [];
  const gaveUp: string[] = [];
  for (const id of candidates) {
    // qa-W4: never reinit an onboarding (unregistered) salon — it would burn
    // the operator's in-flight pairing code. Such a salon is re-selected and
    // skipped every tick and never accrues strikes; the registered-gate (not
    // the strike cap) is what bounds it. That is intended.
    if (!opts.isRegistered(id)) continue;
    const n = (opts.strikes.get(id) ?? 0) + 1;
    opts.strikes.set(id, n);
    opts.lastHealAt.set(id, opts.nowMs);
    reinit.push(id);
    if (n >= opts.maxStrikes) gaveUp.push(id);
  }
  return { reinit, gaveUp };
}
