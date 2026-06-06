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
