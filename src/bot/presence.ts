/**
 * Presence cycling — WA Anti-Abuse Plan §1.1 ("don't be `available` 24/7").
 * A bot socket that advertises `available` around the clock is a behavioral
 * fingerprint; real salon staff are online during business hours with sporadic
 * gaps. This module decides the desired GLOBAL presence for a salon at a given
 * moment:
 *   - outside the online window → `unavailable`
 *   - inside the window         → `available`, with random short offline gaps
 *
 * Gated by HUMANIZE_ENABLED (it shares the §1.1 master switch) plus its own
 * HUMANIZE_PRESENCE_CYCLING sub-flag. Disabled — or SALONES_ENV=test — means no
 * cycling and the socket keeps Baileys' default presence behavior.
 *
 * The schedule decision is pure and injectable (clock hour + rng) so it is
 * unit-tested without sockets or real time. The TIMER lifecycle (start on
 * connect, stop on every teardown, generation-fence) lives in baileys-manager.
 *
 * v1 uses one configurable online window (default 9–21) resolved in a fixed TZ
 * (default America/Mexico_City, matching the rest of the codebase's explicit-TZ
 * pattern). Per-salon `salons.timezone` / working-hours are a documented
 * refinement, not wired here.
 */

export type Presence = "available" | "unavailable";

export interface PresenceConfig {
  enabled: boolean;
  /** Local hour [0–23] the salon "opens" (becomes reachable). Default 9. */
  startHour: number;
  /** Local hour [0–23] the salon "closes". Window is [start, end). Default 21. */
  endHour: number;
  /** How often to re-evaluate desired presence. Default 5 min. */
  tickMs: number;
  /** P(go briefly offline) on an in-hours tick — models human gaps. Default 0.15. */
  offlineGapChance: number;
  /** IANA TZ the hours are resolved in. Default America/Mexico_City. */
  timeZone: string;
}

const num = (v: string | undefined, def: number): number => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
};

const bool = (v: string | undefined, def: boolean): boolean =>
  v === undefined ? def : v === "true" || v === "1";

const clampHour = (h: number): number =>
  Math.min(23, Math.max(0, Math.floor(h)));
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/**
 * Build config from the environment. Shares the §1.1 master switch
 * (HUMANIZE_ENABLED) and adds HUMANIZE_PRESENCE_CYCLING (default on when the
 * master is on). Forced OFF under SALONES_ENV=test.
 */
export function loadPresenceConfig(
  env: NodeJS.ProcessEnv = process.env,
): PresenceConfig {
  const isTest = env["SALONES_ENV"] === "test";
  const master = !isTest && bool(env["HUMANIZE_ENABLED"], false);
  return {
    enabled: master && bool(env["HUMANIZE_PRESENCE_CYCLING"], true),
    startHour: clampHour(num(env["HUMANIZE_ONLINE_START_HOUR"], 9)),
    endHour: clampHour(num(env["HUMANIZE_ONLINE_END_HOUR"], 21)),
    tickMs: num(env["HUMANIZE_PRESENCE_TICK_MS"], 5 * 60 * 1000),
    offlineGapChance: clamp01(num(env["HUMANIZE_OFFLINE_GAP_CHANCE"], 0.15)),
    timeZone: env["HUMANIZE_PRESENCE_TZ"] ?? "America/Mexico_City",
  };
}

/** The local clock hour [0–23] for a given instant in a given IANA TZ. */
export function hourInTz(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const h = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  // hour12:false can render midnight as "24" in some runtimes — normalize.
  return Number.isFinite(h) ? h % 24 : 0;
}

/** Window is [start, end). A non-positive/empty window (end <= start) is never open. */
export function isWithinHours(
  hour: number,
  startHour: number,
  endHour: number,
): boolean {
  return hour >= startHour && hour < endHour;
}

/**
 * Desired presence at a given local hour: `unavailable` outside business hours;
 * inside, `available` except for a random `offlineGapChance` fraction of ticks
 * (a short human-like "stepped away" gap).
 */
export function decidePresence(
  hour: number,
  cfg: PresenceConfig,
  rng: () => number = Math.random,
): Presence {
  if (!isWithinHours(hour, cfg.startHour, cfg.endHour)) return "unavailable";
  return rng() < cfg.offlineGapChance ? "unavailable" : "available";
}
