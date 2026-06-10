/**
 * Behavioral mimicry (WA Anti-Abuse Plan §1.1) — humanize module.
 * Covers jitter bounds, config parsing, and the send/read orchestration
 * (call order, once-only send, best-effort presence). Orchestration tests use
 * zero-delay configs so they run instantly and deterministically.
 */
import { describe, it, expect } from "vitest";
import {
  loadHumanizeConfig,
  readReceiptDelayMs,
  typingDelayMs,
  humanizedSend,
  humanizedReadReceipt,
  type HumanizeConfig,
} from "../src/bot/humanize.js";

const cfg = (over: Partial<HumanizeConfig> = {}): HumanizeConfig => ({
  enabled: true,
  readReceipts: true,
  readMinMs: 0,
  readMaxMs: 0,
  typeMinMs: 0,
  typeMaxMs: 0,
  typePerCharMs: 0,
  typeCapMs: 0,
  ...over,
});

describe("loadHumanizeConfig", () => {
  it("defaults to disabled with plan-§1.1 bounds when env is empty", () => {
    const c = loadHumanizeConfig({});
    expect(c.enabled).toBe(false);
    expect(c.readReceipts).toBe(true);
    expect(c.readMinMs).toBe(1000);
    expect(c.readMaxMs).toBe(8000);
    expect(c.typeMinMs).toBe(800);
    expect(c.typeMaxMs).toBe(2500);
    expect(c.typePerCharMs).toBe(35);
    expect(c.typeCapMs).toBe(6000);
  });

  it("enables when HUMANIZE_ENABLED=true", () => {
    expect(loadHumanizeConfig({ HUMANIZE_ENABLED: "true" }).enabled).toBe(true);
    expect(loadHumanizeConfig({ HUMANIZE_ENABLED: "1" }).enabled).toBe(true);
  });

  it("forces disabled under SALONES_ENV=test even if HUMANIZE_ENABLED=true", () => {
    const c = loadHumanizeConfig({
      SALONES_ENV: "test",
      HUMANIZE_ENABLED: "true",
    });
    expect(c.enabled).toBe(false);
  });

  it("parses numeric overrides and falls back on garbage", () => {
    const c = loadHumanizeConfig({
      HUMANIZE_READ_MIN_MS: "500",
      HUMANIZE_TYPE_CAP_MS: "9000",
      HUMANIZE_TYPE_PER_CHAR_MS: "not-a-number",
      HUMANIZE_READ_RECEIPTS: "false",
    });
    expect(c.readMinMs).toBe(500);
    expect(c.typeCapMs).toBe(9000);
    expect(c.typePerCharMs).toBe(35); // garbage → default
    expect(c.readReceipts).toBe(false);
  });
});

describe("readReceiptDelayMs", () => {
  it("returns the min at rng=0 and the max at rng→1", () => {
    const c = cfg({ readMinMs: 1000, readMaxMs: 8000 });
    expect(readReceiptDelayMs(c, () => 0)).toBe(1000);
    expect(readReceiptDelayMs(c, () => 0.999999)).toBe(8000);
  });

  it("stays within [min, max] across many samples", () => {
    const c = cfg({ readMinMs: 1000, readMaxMs: 8000 });
    let seed = 0.123;
    const rng = () => (seed = (seed * 9301 + 49297) % 1) || 0.5;
    for (let i = 0; i < 1000; i++) {
      const v = readReceiptDelayMs(c, rng);
      expect(v).toBeGreaterThanOrEqual(1000);
      expect(v).toBeLessThanOrEqual(8000);
    }
  });
});

describe("typingDelayMs", () => {
  it("returns the base min for a zero-length reply at rng=0", () => {
    const c = cfg({
      typeMinMs: 800,
      typeMaxMs: 2500,
      typePerCharMs: 35,
      typeCapMs: 6000,
    });
    expect(typingDelayMs(0, c, () => 0)).toBe(800);
  });

  it("scales up with reply length (per-char term)", () => {
    const c = cfg({
      typeMinMs: 800,
      typeMaxMs: 800,
      typePerCharMs: 35,
      typeCapMs: 60000,
    });
    expect(typingDelayMs(0, c, () => 0)).toBe(800);
    expect(typingDelayMs(10, c, () => 0)).toBe(800 + 350);
  });

  it("never exceeds the hard cap", () => {
    const c = cfg({
      typeMinMs: 800,
      typeMaxMs: 2500,
      typePerCharMs: 35,
      typeCapMs: 6000,
    });
    expect(typingDelayMs(1000, c, () => 0.999999)).toBe(6000);
  });
});

describe("humanizedSend", () => {
  it("when disabled: sends once and never touches presence", async () => {
    const calls: string[] = [];
    await humanizedSend(
      "hola",
      async (t) => void calls.push(`presence:${t}`),
      async () => void calls.push("send"),
      cfg({ enabled: false }),
    );
    expect(calls).toEqual(["send"]);
  });

  it("when enabled: composing → paused → send, in order, send once", async () => {
    const calls: string[] = [];
    await humanizedSend(
      "hola",
      async (t) => void calls.push(`presence:${t}`),
      async () => void calls.push("send"),
      cfg(), // all delays 0
    );
    expect(calls).toEqual(["presence:composing", "presence:paused", "send"]);
  });

  it("still sends exactly once if a presence call throws", async () => {
    let sends = 0;
    await humanizedSend(
      "hola",
      async () => {
        throw new Error("presence failed");
      },
      async () => void sends++,
      cfg(),
    );
    expect(sends).toBe(1);
  });
});

describe("humanizedReadReceipt", () => {
  it("does not mark read when disabled", async () => {
    let reads = 0;
    await humanizedReadReceipt(
      async () => void reads++,
      cfg({ enabled: false }),
    );
    expect(reads).toBe(0);
  });

  it("does not mark read when readReceipts is off", async () => {
    let reads = 0;
    await humanizedReadReceipt(
      async () => void reads++,
      cfg({ readReceipts: false }),
    );
    expect(reads).toBe(0);
  });

  it("marks read once when enabled", async () => {
    let reads = 0;
    await humanizedReadReceipt(async () => void reads++, cfg());
    expect(reads).toBe(1);
  });

  it("swallows a markRead failure (best-effort)", async () => {
    await expect(
      humanizedReadReceipt(async () => {
        throw new Error("read failed");
      }, cfg()),
    ).resolves.toBeUndefined();
  });
});
