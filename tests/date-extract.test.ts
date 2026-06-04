import { describe, it, expect } from "vitest";
import { extractDay, findDateHint } from "../src/bot/date-extract.js";
import { parseSpanishDateTime } from "../src/bot/datetime-parser.js";

// Fixed reference: Saturday 2026-01-10, midday (local).
const NOW = new Date(2026, 0, 10, 12, 0, 0);
const NOW_MS = NOW.getTime();

describe("extractDay — relative + weekday parity", () => {
  it("resolves 'mañana' to the next day", () => {
    const d = extractDay("mañana", NOW)!;
    expect(d.getDate()).toBe(11);
    expect(d.getMonth()).toBe(0);
  });

  it("resolves a named weekday to its next occurrence", () => {
    const d = extractDay("viernes", NOW)!;
    expect(d.getDay()).toBe(5);
    expect(d.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("returns null when no day is present", () => {
    expect(extractDay("a las 4pm", NOW)).toBeNull();
    expect(extractDay("quiero una cita porfa", NOW)).toBeNull();
  });
});

describe("extractDay — 'N de <mes>' (the consolidated capability)", () => {
  it("resolves a future month/day in the current year", () => {
    const d = extractDay("15 de marzo", NOW)!;
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(2); // March
    expect(d.getDate()).toBe(15);
  });

  it("rolls a past month/day into next year", () => {
    // NOW is Jan 10; "5 de enero" already passed → Jan 5 2027.
    const d = extractDay("el 5 de enero", NOW)!;
    expect(d.getFullYear()).toBe(2027);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(5);
  });

  it("accepts the 'setiembre' spelling variant", () => {
    const d = extractDay("1 de setiembre", NOW)!;
    expect(d.getMonth()).toBe(8);
    expect(d.getDate()).toBe(1);
  });

  it("returns null for an impossible calendar day", () => {
    expect(extractDay("31 de febrero", NOW)).toBeNull();
  });
});

describe("extractDay — numeric 'DD/MM'", () => {
  it("parses day-first numeric dates", () => {
    const d = extractDay("15/3", NOW)!;
    expect(d.getMonth()).toBe(2); // March
    expect(d.getDate()).toBe(15);
  });

  it("returns null for an out-of-range month", () => {
    expect(extractDay("15/20", NOW)).toBeNull();
  });

  it("does not mistake a clock time for a numeric date", () => {
    // Colon-separated times must not be read as DD/MM.
    expect(extractDay("16:00", NOW)).toBeNull();
  });

  it("does NOT treat a dash pair as a date (time-range guard, C2)", () => {
    // "entre 4-5 de la tarde" is a time range, not May 4. Slash-only numeric
    // dates keep the dash free for ranges.
    expect(extractDay("entre 4-5 de la tarde", NOW)).toBeNull();
    expect(extractDay("tipo 3-4 pm", NOW)).toBeNull();
  });
});

describe("date/time-range collision regressions (C2 / W1)", () => {
  it("'entre 4-5 de la tarde' names no day → null (not May 4)", () => {
    expect(extractDay("entre 4-5 de la tarde", NOW)).toBeNull();
  });

  it("'el viernes entre 4-5 de la tarde' → Friday 16:00 (weekday wins, time survives)", () => {
    const d = parseSpanishDateTime("el viernes entre 4-5 de la tarde", NOW_MS)!;
    expect(d).not.toBeNull();
    expect(d.getDay()).toBe(5);
    expect(d.getHours()).toBe(16);
  });
});

describe("findDateHint — string hint for the book intent", () => {
  it("returns the matched substring for each recognized shape", () => {
    expect(findDateHint("quiero cita mañana")).toBe("mañana");
    expect(findDateHint("el viernes porfa")?.toLowerCase()).toBe("viernes");
    expect(findDateHint("para el 15 de marzo")).toBe("15 de marzo");
    expect(findDateHint("el 15/3 va")).toBe("15/3");
  });

  it("returns undefined when there is no date", () => {
    expect(findDateHint("hola quiero info")).toBeUndefined();
  });
});

describe("parseSpanishDateTime — N-de-mes now parses end-to-end (regression)", () => {
  it("parses '15 de marzo a las 4pm' — previously returned null", () => {
    const d = parseSpanishDateTime("15 de marzo a las 4pm", NOW_MS)!;
    expect(d).not.toBeNull();
    expect(d.getMonth()).toBe(2);
    expect(d.getDate()).toBe(15);
    expect(d.getHours()).toBe(16);
  });

  it("parses numeric '15/3 a las 11am'", () => {
    const d = parseSpanishDateTime("15/3 a las 11am", NOW_MS)!;
    expect(d.getMonth()).toBe(2);
    expect(d.getDate()).toBe(15);
    expect(d.getHours()).toBe(11);
  });

  it("still returns null when a date is named but no time is given", () => {
    expect(parseSpanishDateTime("15 de marzo", NOW_MS)).toBeNull();
  });
});
