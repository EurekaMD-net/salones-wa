/**
 * Presence cycling (WA Anti-Abuse Plan §1.1) — pure schedule logic.
 * Covers config parsing/gating, the online-window check, the desired-presence
 * decision (incl. random offline gaps), and TZ-correct hour extraction. No
 * sockets or real timers — the lifecycle wiring lives in baileys-manager and is
 * exercised by its tests + the QA audit.
 */
import { describe, it, expect } from "vitest";
import {
  loadPresenceConfig,
  isWithinHours,
  decidePresence,
  hourInTz,
  type PresenceConfig,
} from "../src/bot/presence.js";

const cfg = (over: Partial<PresenceConfig> = {}): PresenceConfig => ({
  enabled: true,
  startHour: 9,
  endHour: 21,
  tickMs: 300000,
  offlineGapChance: 0.15,
  timeZone: "America/Mexico_City",
  ...over,
});

describe("loadPresenceConfig", () => {
  it("defaults to disabled with plan-§1.1 window when env is empty", () => {
    const c = loadPresenceConfig({});
    expect(c.enabled).toBe(false);
    expect(c.startHour).toBe(9);
    expect(c.endHour).toBe(21);
    expect(c.tickMs).toBe(5 * 60 * 1000);
    expect(c.offlineGapChance).toBe(0.15);
    expect(c.timeZone).toBe("America/Mexico_City");
  });

  it("enables when the master flag is on and the sub-flag defaults on", () => {
    expect(loadPresenceConfig({ HUMANIZE_ENABLED: "true" }).enabled).toBe(true);
  });

  it("respects the HUMANIZE_PRESENCE_CYCLING sub-flag independently", () => {
    expect(
      loadPresenceConfig({
        HUMANIZE_ENABLED: "true",
        HUMANIZE_PRESENCE_CYCLING: "false",
      }).enabled,
    ).toBe(false);
  });

  it("forces disabled under SALONES_ENV=test even with both flags on", () => {
    expect(
      loadPresenceConfig({
        SALONES_ENV: "test",
        HUMANIZE_ENABLED: "true",
        HUMANIZE_PRESENCE_CYCLING: "true",
      }).enabled,
    ).toBe(false);
  });

  it("clamps hours to [0,23] and gap chance to [0,1]; honors a custom TZ", () => {
    const c = loadPresenceConfig({
      HUMANIZE_ONLINE_START_HOUR: "30",
      HUMANIZE_ONLINE_END_HOUR: "10",
      HUMANIZE_OFFLINE_GAP_CHANCE: "5",
      HUMANIZE_PRESENCE_TZ: "UTC",
    });
    expect(c.startHour).toBe(23);
    expect(c.endHour).toBe(10);
    expect(c.offlineGapChance).toBe(1);
    expect(c.timeZone).toBe("UTC");
  });
});

describe("isWithinHours", () => {
  it("treats the window as [start, end)", () => {
    expect(isWithinHours(9, 9, 21)).toBe(true); // start inclusive
    expect(isWithinHours(20, 9, 21)).toBe(true);
    expect(isWithinHours(21, 9, 21)).toBe(false); // end exclusive
    expect(isWithinHours(8, 9, 21)).toBe(false);
    expect(isWithinHours(0, 9, 21)).toBe(false);
  });

  it("an empty/inverted window (end <= start) is never open", () => {
    expect(isWithinHours(12, 21, 9)).toBe(false);
    expect(isWithinHours(15, 15, 15)).toBe(false);
  });
});

describe("decidePresence", () => {
  it("is unavailable outside business hours regardless of rng", () => {
    expect(decidePresence(8, cfg(), () => 0)).toBe("unavailable");
    expect(decidePresence(21, cfg(), () => 0.99)).toBe("unavailable");
  });

  it("inside hours: offline for the gap fraction, else available", () => {
    const c = cfg({ offlineGapChance: 0.15 });
    expect(decidePresence(12, c, () => 0.1)).toBe("unavailable"); // 0.10 < 0.15
    expect(decidePresence(12, c, () => 0.5)).toBe("available"); // 0.50 ≥ 0.15
  });

  it("gap chance 0 ⇒ always available inside hours", () => {
    expect(decidePresence(12, cfg({ offlineGapChance: 0 }), () => 0)).toBe(
      "available",
    );
  });
});

describe("hourInTz", () => {
  // America/Mexico_City is UTC-6 year-round (no DST since 2022).
  it("resolves the local hour in America/Mexico_City", () => {
    expect(
      hourInTz(new Date("2026-06-10T18:00:00Z"), "America/Mexico_City"),
    ).toBe(12);
    expect(
      hourInTz(new Date("2026-06-10T03:00:00Z"), "America/Mexico_City"),
    ).toBe(21);
    expect(
      hourInTz(new Date("2026-06-10T06:00:00Z"), "America/Mexico_City"),
    ).toBe(0);
  });

  it("respects a different TZ", () => {
    expect(hourInTz(new Date("2026-06-10T18:00:00Z"), "UTC")).toBe(18);
  });
});
