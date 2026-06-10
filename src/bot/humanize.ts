/**
 * Behavioral mimicry for outbound replies — WA Anti-Abuse Plan §1.1
 * ("the bot acts human"). WhatsApp's anti-abuse heuristics read a behavioral
 * signature: a bot that marks messages read instantly and replies in <500ms
 * with no typing indicator is a textbook automation fingerprint. This module
 * makes each reply look human-paced:
 *
 *   - jittered READ RECEIPT — mark the clienta's message read 1–8s later, not
 *     instantly (fire-and-forget so it never delays the reply itself)
 *   - TYPING indicator (`composing`) shown for a length-scaled window, then
 *     `paused` just before the send — the window doubles as the response delay
 *     (no instant robotic reply)
 *
 * Master switch: HUMANIZE_ENABLED (default OFF). Disabled — or SALONES_ENV=test —
 * means zero added latency and an immediate send, so existing behavior and the
 * full test suite are untouched until the operator flips it on.
 *
 * Hard rule: humanization is best-effort and MUST NEVER drop a real reply on
 * its own failure. Every presence/read call is wrapped (`safe`) so a Baileys
 * error in the cosmetic path can't swallow the actual message. The decoupled
 * callback API (no Baileys types in this module) keeps it trivially testable.
 */

export interface HumanizeConfig {
  enabled: boolean;
  /** Send jittered read receipts (blue ticks). Visible to the clienta. */
  readReceipts: boolean;
  readMinMs: number;
  readMaxMs: number;
  typeMinMs: number;
  typeMaxMs: number;
  /** Extra typing ms per reply char (longer replies "take longer to type"). */
  typePerCharMs: number;
  /** Hard ceiling on the typing window so a long reply can't stall absurdly. */
  typeCapMs: number;
}

const num = (v: string | undefined, def: number): number => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
};

const bool = (v: string | undefined, def: boolean): boolean =>
  v === undefined ? def : v === "true" || v === "1";

/**
 * Build config from the process environment. Defaults match plan §1.1
 * (read 1–8s, type 0.8–2.5s + 35ms/char capped at 6s). Forced OFF under
 * SALONES_ENV=test so the suite stays instant and deterministic.
 */
export function loadHumanizeConfig(
  env: NodeJS.ProcessEnv = process.env,
): HumanizeConfig {
  const isTest = env["SALONES_ENV"] === "test";
  return {
    enabled: !isTest && bool(env["HUMANIZE_ENABLED"], false),
    readReceipts: bool(env["HUMANIZE_READ_RECEIPTS"], true),
    readMinMs: num(env["HUMANIZE_READ_MIN_MS"], 1000),
    readMaxMs: num(env["HUMANIZE_READ_MAX_MS"], 8000),
    typeMinMs: num(env["HUMANIZE_TYPE_MIN_MS"], 800),
    typeMaxMs: num(env["HUMANIZE_TYPE_MAX_MS"], 2500),
    typePerCharMs: num(env["HUMANIZE_TYPE_PER_CHAR_MS"], 35),
    typeCapMs: num(env["HUMANIZE_TYPE_CAP_MS"], 6000),
  };
}

export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Uniform int in [min, max]. rng() ∈ [0,1). Tolerates inverted bounds. */
function uniform(min: number, max: number, rng: () => number): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.round(lo + (hi - lo) * rng());
}

/** Read-receipt delay (ms) — uniform in [readMin, readMax]. */
export function readReceiptDelayMs(
  cfg: HumanizeConfig,
  rng: () => number = Math.random,
): number {
  return uniform(cfg.readMinMs, cfg.readMaxMs, rng);
}

/**
 * Typing-window / response delay (ms): base uniform jitter plus a per-char
 * term (longer replies take longer to "type"), hard-capped at typeCapMs.
 */
export function typingDelayMs(
  replyLength: number,
  cfg: HumanizeConfig,
  rng: () => number = Math.random,
): number {
  const base = uniform(cfg.typeMinMs, cfg.typeMaxMs, rng);
  const scaled = base + Math.max(0, replyLength) * cfg.typePerCharMs;
  return Math.min(scaled, cfg.typeCapMs);
}

/** Run a best-effort cosmetic call; never let its failure escape. */
async function safe(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch {
    /* presence/read is decorative — swallow so the real reply survives */
  }
}

/**
 * Mark an inbound message read after a human-like jitter. Designed to be called
 * WITHOUT `await` (fire-and-forget) so it adds no latency to the reply path.
 * `markRead` is the caller's real read closure (e.g. `() => sock.readMessages([key])`).
 */
export async function humanizedReadReceipt(
  markRead: () => Promise<void>,
  cfg: HumanizeConfig,
  rng: () => number = Math.random,
): Promise<void> {
  if (!cfg.enabled || !cfg.readReceipts) return;
  await delay(readReceiptDelayMs(cfg, rng));
  await safe(markRead);
}

/**
 * Send a reply with human pacing: show `composing` for a length-scaled window,
 * flip to `paused`, then invoke `send`. When disabled, sends immediately with
 * no presence calls (zero behavior change). `send` is the caller's real
 * sendMessage closure and is always invoked exactly once, even if a presence
 * call throws.
 */
export async function humanizedSend(
  replyText: string,
  setPresence: (type: "composing" | "paused") => Promise<void>,
  send: () => Promise<void>,
  cfg: HumanizeConfig,
  rng: () => number = Math.random,
): Promise<void> {
  if (!cfg.enabled) {
    await send();
    return;
  }
  await safe(() => setPresence("composing"));
  await delay(typingDelayMs(replyText.length, cfg, rng));
  await safe(() => setPresence("paused"));
  await send();
}
