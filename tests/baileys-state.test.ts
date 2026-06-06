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
  BAILEYS_STATES,
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
