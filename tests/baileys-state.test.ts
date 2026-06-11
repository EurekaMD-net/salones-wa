/**
 * Connection-state registry + health-evaluation logic.
 * Pure/deterministic: clocks are injected, no real timers.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  recordSalonState,
  getSalonConnState,
  getAllSalonConnStates,
  resetSalonConnStates,
  evaluateSalonHealth,
  findStaleSalons,
  disconnectAlertHours,
  reconnectStuckMinutes,
  selectSalonsToReinit,
  planWatchdogTick,
  BAILEYS_STATES,
  disconnectReasonName,
  recordDisconnect,
  snapshotDisconnects,
  resetDisconnects,
  type SalonConnState,
} from "../src/bot/baileys-state.js";

const HOUR = 3_600_000;

function salon(id: string, active: number | boolean = 1) {
  return { id, name: `Salón ${id}`, phone: `5255${id}`, active };
}

describe("recordSalonState", () => {
  beforeEach(() => resetSalonConnStates());

  it("records an initial state with since=now and no lastConnectedAt", () => {
    recordSalonState("a", "5255a", "connecting", 1000);
    const r = getSalonConnState("a")!;
    expect(r.state).toBe("connecting");
    expect(r.since).toBe(1000);
    expect(r.lastConnectedAt).toBeNull();
    expect(r.updatedAt).toBe(1000);
  });

  it("sets lastConnectedAt only when state becomes connected", () => {
    recordSalonState("a", "5255a", "connecting", 1000);
    recordSalonState("a", "5255a", "connected", 2000);
    expect(getSalonConnState("a")!.lastConnectedAt).toBe(2000);
  });

  it("preserves `since` when the same state repeats (flap guard)", () => {
    recordSalonState("a", "5255a", "reconnecting", 1000);
    recordSalonState("a", "5255a", "reconnecting", 5000);
    const r = getSalonConnState("a")!;
    expect(r.since).toBe(1000); // unchanged
    expect(r.updatedAt).toBe(5000); // advanced
  });

  it("resets `since` when the state changes", () => {
    recordSalonState("a", "5255a", "connected", 1000);
    recordSalonState("a", "5255a", "reconnecting", 4000);
    expect(getSalonConnState("a")!.since).toBe(4000);
  });

  it("retains lastConnectedAt across a later disconnect", () => {
    recordSalonState("a", "5255a", "connected", 2000);
    recordSalonState("a", "5255a", "reconnecting", 3000);
    recordSalonState("a", "5255a", "logged_out", 4000);
    const r = getSalonConnState("a")!;
    expect(r.state).toBe("logged_out");
    expect(r.lastConnectedAt).toBe(2000); // still the last connect
  });

  it("tracks multiple salons independently", () => {
    recordSalonState("a", "5255a", "connected", 1000);
    recordSalonState("b", "5255b", "logged_out", 1000);
    expect(getAllSalonConnStates()).toHaveLength(2);
    expect(getSalonConnState("a")!.state).toBe("connected");
    expect(getSalonConnState("b")!.state).toBe("logged_out");
  });

  it("BAILEYS_STATES enumerates the four states", () => {
    expect([...BAILEYS_STATES]).toEqual([
      "connecting",
      "connected",
      "reconnecting",
      "logged_out",
    ]);
  });
});

describe("evaluateSalonHealth", () => {
  const opts = (
    overrides?: Partial<{ nowMs: number; thresholdMs: number; bootMs: number }>,
  ) => ({
    nowMs: 100 * HOUR,
    thresholdMs: 24 * HOUR,
    bootMs: 0,
    ...overrides,
  });

  function rec(
    state: SalonConnState["state"],
    lastConnectedAt: number | null,
  ): SalonConnState {
    return {
      salonId: "a",
      salonPhone: "5255a",
      state,
      since: 0,
      lastConnectedAt,
      updatedAt: 0,
    };
  }

  it("connected → not stale, downForSeconds null", () => {
    const h = evaluateSalonHealth(
      salon("a"),
      rec("connected", 99 * HOUR),
      opts(),
    );
    expect(h.state).toBe("connected");
    expect(h.stale).toBe(false);
    expect(h.downForSeconds).toBeNull();
  });

  it("no record → state unknown, measured from boot", () => {
    // boot at 0, now at 100h, threshold 24h → down 100h → stale
    const h = evaluateSalonHealth(salon("a"), undefined, opts());
    expect(h.state).toBe("unknown");
    expect(h.stale).toBe(true);
    expect(h.downForSeconds).toBe((100 * HOUR) / 1000);
  });

  it("no record but boot recent → unknown, not yet stale", () => {
    const h = evaluateSalonHealth(
      salon("a"),
      undefined,
      opts({ bootMs: 99 * HOUR }),
    );
    expect(h.state).toBe("unknown");
    expect(h.stale).toBe(false); // down only 1h
  });

  it("reconnecting within threshold → not stale", () => {
    const h = evaluateSalonHealth(
      salon("a"),
      rec("reconnecting", 99 * HOUR),
      opts(),
    );
    expect(h.stale).toBe(false);
    expect(h.downForSeconds).toBe((1 * HOUR) / 1000);
  });

  it("logged_out past threshold → stale, down measured from last connect", () => {
    const h = evaluateSalonHealth(
      salon("a"),
      rec("logged_out", 50 * HOUR),
      opts(),
    );
    expect(h.state).toBe("logged_out");
    expect(h.stale).toBe(true);
    expect(h.downForSeconds).toBe((50 * HOUR) / 1000); // 100h - 50h
  });

  it("exactly at threshold is NOT stale (strict >)", () => {
    const h = evaluateSalonHealth(
      salon("a"),
      rec("logged_out", 76 * HOUR),
      opts(),
    );
    expect(h.downForSeconds).toBe((24 * HOUR) / 1000);
    expect(h.stale).toBe(false); // 24h is not > 24h
  });

  it("carries the active flag through (number or boolean)", () => {
    expect(evaluateSalonHealth(salon("a", 0), undefined, opts()).active).toBe(
      false,
    );
    expect(evaluateSalonHealth(salon("a", 1), undefined, opts()).active).toBe(
      true,
    );
    expect(
      evaluateSalonHealth(salon("a", true), undefined, opts()).active,
    ).toBe(true);
  });
});

describe("findStaleSalons", () => {
  const base = {
    since: null,
    lastConnectedAt: null,
    downForSeconds: 999999,
  };

  it("returns only active AND stale salons", () => {
    const healths = [
      {
        salonId: "a",
        name: "A",
        phone: "1",
        active: true,
        state: "logged_out" as const,
        stale: true,
        ...base,
      },
      {
        salonId: "b",
        name: "B",
        phone: "2",
        active: true,
        state: "connected" as const,
        stale: false,
        ...base,
      },
      {
        salonId: "c",
        name: "C",
        phone: "3",
        active: false,
        state: "logged_out" as const,
        stale: true,
        ...base,
      }, // inactive
    ];
    const stale = findStaleSalons(healths);
    expect(stale.map((h) => h.salonId)).toEqual(["a"]);
  });
});

describe("disconnectAlertHours", () => {
  const KEY = "SALON_DISCONNECT_ALERT_HOURS";
  beforeEach(() => delete process.env[KEY]);

  it("defaults to 24", () => {
    expect(disconnectAlertHours()).toBe(24);
  });

  it("honors a valid override", () => {
    process.env[KEY] = "6";
    expect(disconnectAlertHours()).toBe(6);
  });

  it("clamps numeric values below 1h up to 1 (not the 24 default)", () => {
    process.env[KEY] = "0";
    expect(disconnectAlertHours()).toBe(1);
    process.env[KEY] = "0.5";
    expect(disconnectAlertHours()).toBe(1);
    process.env[KEY] = "-5";
    expect(disconnectAlertHours()).toBe(1);
  });

  it("falls back to the 24 default only for non-numeric / unset", () => {
    process.env[KEY] = "abc";
    expect(disconnectAlertHours()).toBe(24);
    delete process.env[KEY];
    expect(disconnectAlertHours()).toBe(24);
  });

  it("truncates fractional hours", () => {
    process.env[KEY] = "12.9";
    expect(disconnectAlertHours()).toBe(12);
  });
});

describe("reconnectStuckMinutes", () => {
  const KEY = "BAILEYS_RECONNECT_STUCK_MINUTES";
  beforeEach(() => delete process.env[KEY]);

  it("defaults to 5", () => {
    expect(reconnectStuckMinutes()).toBe(5);
  });

  it("honors a valid override and clamps below 1 to 1", () => {
    process.env[KEY] = "2";
    expect(reconnectStuckMinutes()).toBe(2);
    process.env[KEY] = "0";
    expect(reconnectStuckMinutes()).toBe(1);
  });

  it("falls back to default for non-numeric", () => {
    process.env[KEY] = "soon";
    expect(reconnectStuckMinutes()).toBe(5);
  });
});

describe("selectSalonsToReinit", () => {
  const MIN = 60_000;
  const NOW = 1000 * MIN;

  function salon(id: string) {
    return { id, phone: `5255${id}` };
  }
  function rec(
    id: string,
    state: SalonConnState["state"],
    since: number,
  ): SalonConnState {
    return {
      salonId: id,
      salonPhone: `5255${id}`,
      state,
      since,
      lastConnectedAt: state === "connected" ? since : null,
      updatedAt: since,
    };
  }
  const opts = (
    over?: Partial<{
      cooldownMs: number;
      lastHealAt: Map<string, number>;
      strikes: Map<string, number>;
      maxStrikes: number;
    }>,
  ) => ({
    nowMs: NOW,
    stuckMs: 5 * MIN,
    cooldownMs: 5 * MIN,
    bootMs: 0,
    lastHealAt: new Map<string, number>(),
    strikes: new Map<string, number>(),
    maxStrikes: 5,
    ...over,
  });

  it("heals a salon stuck connecting past the threshold", () => {
    const recs = new Map([["a", rec("a", "connecting", NOW - 6 * MIN)]]);
    expect(selectSalonsToReinit([salon("a")], recs, opts())).toEqual(["a"]);
  });

  it("heals a salon stuck reconnecting past the threshold", () => {
    const recs = new Map([["a", rec("a", "reconnecting", NOW - 10 * MIN)]]);
    expect(selectSalonsToReinit([salon("a")], recs, opts())).toEqual(["a"]);
  });

  it("does NOT heal a connected salon", () => {
    const recs = new Map([["a", rec("a", "connected", NOW - 99 * MIN)]]);
    expect(selectSalonsToReinit([salon("a")], recs, opts())).toEqual([]);
  });

  it("does NOT heal a logged_out salon (manual re-link — no burn loop)", () => {
    const recs = new Map([["a", rec("a", "logged_out", NOW - 99 * MIN)]]);
    expect(selectSalonsToReinit([salon("a")], recs, opts())).toEqual([]);
  });

  it("does NOT heal a recently-transitioned (not-yet-stuck) salon", () => {
    const recs = new Map([["a", rec("a", "reconnecting", NOW - 1 * MIN)]]);
    expect(selectSalonsToReinit([salon("a")], recs, opts())).toEqual([]);
  });

  it("uses strict > threshold (exactly stuckMs is not yet stuck)", () => {
    const recs = new Map([["a", rec("a", "connecting", NOW - 5 * MIN)]]);
    expect(selectSalonsToReinit([salon("a")], recs, opts())).toEqual([]);
  });

  it("heals an active salon with NO record once boot is older than threshold", () => {
    expect(
      selectSalonsToReinit([salon("a")], new Map(), opts()), // bootMs=0, now=1000min
    ).toEqual(["a"]);
  });

  it("does NOT heal a no-record salon when boot is recent", () => {
    expect(
      selectSalonsToReinit([salon("a")], new Map(), {
        nowMs: NOW,
        stuckMs: 5 * MIN,
        cooldownMs: 5 * MIN,
        bootMs: NOW - 1 * MIN, // booted 1 min ago, < 5 min threshold
        lastHealAt: new Map<string, number>(),
        strikes: new Map<string, number>(),
        maxStrikes: 5,
      }),
    ).toEqual([]);
  });

  it("respects the cooldown — skips a stuck salon healed recently", () => {
    const recs = new Map([["a", rec("a", "connecting", NOW - 30 * MIN)]]);
    const lastHealAt = new Map([["a", NOW - 2 * MIN]]); // healed 2 min ago, cooldown 5
    expect(
      selectSalonsToReinit([salon("a")], recs, opts({ lastHealAt })),
    ).toEqual([]);
  });

  it("heals again once the cooldown has elapsed", () => {
    const recs = new Map([["a", rec("a", "connecting", NOW - 30 * MIN)]]);
    const lastHealAt = new Map([["a", NOW - 6 * MIN]]); // cooldown 5 min elapsed
    expect(
      selectSalonsToReinit([salon("a")], recs, opts({ lastHealAt })),
    ).toEqual(["a"]);
  });

  it("stops healing a salon that has reached maxStrikes (3-strike give-up)", () => {
    const recs = new Map([["a", rec("a", "connecting", NOW - 30 * MIN)]]);
    const strikes = new Map([["a", 5]]); // already gave up
    expect(selectSalonsToReinit([salon("a")], recs, opts({ strikes }))).toEqual(
      [],
    );
  });

  it("still heals a salon with strikes below the cap", () => {
    const recs = new Map([["a", rec("a", "connecting", NOW - 30 * MIN)]]);
    const strikes = new Map([["a", 4]]); // one strike left
    expect(selectSalonsToReinit([salon("a")], recs, opts({ strikes }))).toEqual(
      ["a"],
    );
  });

  it("selects the correct subset across a mixed roster", () => {
    const recs = new Map([
      ["a", rec("a", "connected", NOW - 99 * MIN)], // healthy
      ["b", rec("b", "connecting", NOW - 9 * MIN)], // stuck → heal
      ["c", rec("c", "logged_out", NOW - 99 * MIN)], // manual → skip
      ["d", rec("d", "reconnecting", NOW - 2 * MIN)], // not yet stuck
    ]);
    const roster = [salon("a"), salon("b"), salon("c"), salon("d")];
    expect(selectSalonsToReinit(roster, recs, opts())).toEqual(["b"]);
  });
});

describe("planWatchdogTick", () => {
  const MIN = 60_000;
  const NOW = 1000 * MIN;

  function salon(id: string) {
    return { id, phone: `5255${id}`, name: `Salón ${id}` };
  }
  function rec(
    id: string,
    state: SalonConnState["state"],
    since: number,
  ): SalonConnState {
    return {
      salonId: id,
      salonPhone: `5255${id}`,
      state,
      since,
      lastConnectedAt: state === "connected" ? since : null,
      updatedAt: since,
    };
  }
  const base = (over?: Partial<Parameters<typeof planWatchdogTick>[2]>) => ({
    nowMs: NOW,
    stuckMs: 5 * MIN,
    cooldownMs: 5 * MIN,
    bootMs: 0,
    maxStrikes: 3,
    strikes: new Map<string, number>(),
    lastHealAt: new Map<string, number>(),
    isRegistered: () => true,
    ...over,
  });

  it("increments the strike + records lastHealAt on a heal", () => {
    const recs = new Map([["a", rec("a", "connecting", NOW - 9 * MIN)]]);
    const opts = base();
    const res = planWatchdogTick([salon("a")], recs, opts);
    expect(res.reinit).toEqual(["a"]);
    expect(res.gaveUp).toEqual([]);
    expect(opts.strikes.get("a")).toBe(1);
    expect(opts.lastHealAt.get("a")).toBe(NOW);
  });

  it("reports gaveUp when the strike reaches the cap, then stops next tick", () => {
    const recs = new Map([["a", rec("a", "connecting", NOW - 9 * MIN)]]);
    const strikes = new Map([["a", 2]]); // one short of cap=3
    const opts = base({ strikes, cooldownMs: 0 }); // ignore cooldown for clarity
    const r1 = planWatchdogTick([salon("a")], recs, opts);
    expect(r1.reinit).toEqual(["a"]);
    expect(r1.gaveUp).toEqual(["a"]); // 3rd strike = cap
    expect(opts.strikes.get("a")).toBe(3);
    // next tick: at the cap → selector excludes it
    const r2 = planWatchdogTick([salon("a")], recs, opts);
    expect(r2.reinit).toEqual([]);
  });

  it("resets strikes + cooldown when a salon is observed connected (clean slate)", () => {
    const strikes = new Map([["a", 3]]);
    const lastHealAt = new Map([["a", NOW - 1 * MIN]]);
    const recs = new Map([["a", rec("a", "connected", NOW)]]);
    const opts = base({ strikes, lastHealAt });
    planWatchdogTick([salon("a")], recs, opts);
    expect(opts.strikes.has("a")).toBe(false);
    expect(opts.lastHealAt.has("a")).toBe(false);
  });

  it("never heals an unregistered (onboarding) salon and does not accrue strikes", () => {
    const recs = new Map([["a", rec("a", "connecting", NOW - 9 * MIN)]]);
    const opts = base({ isRegistered: () => false });
    const res = planWatchdogTick([salon("a")], recs, opts);
    expect(res.reinit).toEqual([]);
    expect(opts.strikes.has("a")).toBe(false);
  });
});

describe("disconnectReasonName (§1.5)", () => {
  it("maps known DisconnectReason codes to symbolic names", () => {
    expect(disconnectReasonName(401)).toBe("loggedOut");
    expect(disconnectReasonName(403)).toBe("forbidden");
    expect(disconnectReasonName(428)).toBe("connectionClosed");
    expect(disconnectReasonName(440)).toBe("connectionReplaced");
    expect(disconnectReasonName(515)).toBe("restartRequired");
  });
  it("canonicalizes Baileys' aliased 408 to connectionLost", () => {
    expect(disconnectReasonName(408)).toBe("connectionLost");
  });
  it("returns 'unknown' for an unmapped or absent code", () => {
    expect(disconnectReasonName(418)).toBe("unknown");
    expect(disconnectReasonName(undefined)).toBe("unknown");
  });
});

describe("disconnect counter (§1.5)", () => {
  beforeEach(() => resetDisconnects());

  it("starts empty", () => {
    expect(snapshotDisconnects()).toEqual([]);
  });

  it("tallies by salon + code + derived reason", () => {
    recordDisconnect("s1", 515);
    recordDisconnect("s1", 515);
    recordDisconnect("s2", 401);
    const snap = snapshotDisconnects();
    expect(snap).toContainEqual({
      salonId: "s1",
      code: "515",
      reason: "restartRequired",
      count: 2,
    });
    expect(snap).toContainEqual({
      salonId: "s2",
      code: "401",
      reason: "loggedOut",
      count: 1,
    });
  });

  it("buckets a missing code under code='none', reason='unknown'", () => {
    recordDisconnect("s1", undefined);
    expect(snapshotDisconnects()).toContainEqual({
      salonId: "s1",
      code: "none",
      reason: "unknown",
      count: 1,
    });
  });

  it("keeps an unmapped numeric code as the label but reason='unknown'", () => {
    recordDisconnect("s1", 418);
    expect(snapshotDisconnects()).toContainEqual({
      salonId: "s1",
      code: "418",
      reason: "unknown",
      count: 1,
    });
  });

  it("resetDisconnects clears the tally", () => {
    recordDisconnect("s1", 515);
    resetDisconnects();
    expect(snapshotDisconnects()).toEqual([]);
  });
});
