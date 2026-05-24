import { describe, it, expect } from "vitest";
import { parseSpanishDateTime } from "../src/bot/datetime-parser.js";

// Fixed "now": Monday 2026-06-01 at 10:00 MX (TZ=America/Mexico_City).
// Server runs in MX TZ so local Date(...) is MX time.
const NOW_MS = new Date("2026-06-01T16:00:00Z").getTime();

describe("parseSpanishDateTime", () => {
  describe("day extraction", () => {
    it("hoy → today", () => {
      const d = parseSpanishDateTime("hoy 4pm", NOW_MS)!;
      expect(d.getDay()).toBe(1); // Monday
    });

    it("mañana → tomorrow", () => {
      const d = parseSpanishDateTime("mañana 11am", NOW_MS)!;
      expect(d.getDay()).toBe(2); // Tuesday
    });

    it("pasado mañana → +2 days", () => {
      const d = parseSpanishDateTime("pasado mañana a las 3pm", NOW_MS)!;
      expect(d.getDay()).toBe(3); // Wednesday
    });

    it("day name → next occurrence", () => {
      const d = parseSpanishDateTime("viernes 4pm", NOW_MS)!;
      expect(d.getDay()).toBe(5); // Friday
    });

    it("day name accented vs unaccented both match", () => {
      const d1 = parseSpanishDateTime("sábado 5pm", NOW_MS)!;
      const d2 = parseSpanishDateTime("sabado 5pm", NOW_MS)!;
      expect(d1.getDay()).toBe(6);
      expect(d2.getDay()).toBe(6);
    });

    it('"próximo viernes" skips this week', () => {
      const d = parseSpanishDateTime("próximo viernes 4pm", NOW_MS)!;
      const diffDays = Math.round((d.getTime() - NOW_MS) / (24 * 3600 * 1000));
      expect(diffDays).toBeGreaterThanOrEqual(10); // 4 to this Friday + 7 next
    });

    it("returns null without a recognizable day", () => {
      const r = parseSpanishDateTime("4pm", NOW_MS);
      expect(r).toBeNull();
    });
  });

  describe("time extraction", () => {
    it("4pm → 16:00", () => {
      const d = parseSpanishDateTime("viernes 4pm", NOW_MS)!;
      expect(d.getHours()).toBe(16);
      expect(d.getMinutes()).toBe(0);
    });

    it("4:30pm → 16:30", () => {
      const d = parseSpanishDateTime("viernes 4:30pm", NOW_MS)!;
      expect(d.getHours()).toBe(16);
      expect(d.getMinutes()).toBe(30);
    });

    it("11am → 11:00", () => {
      const d = parseSpanishDateTime("mañana 11am", NOW_MS)!;
      expect(d.getHours()).toBe(11);
    });

    it("16:00 → 16:00 (24h format)", () => {
      const d = parseSpanishDateTime("viernes 16:00", NOW_MS)!;
      expect(d.getHours()).toBe(16);
    });

    it('"a las 5" → 5pm (ambiguous-hour heuristic)', () => {
      const d = parseSpanishDateTime("viernes a las 5", NOW_MS)!;
      expect(d.getHours()).toBe(17);
    });

    it('"a las 10" stays 10am (8-11 default morning)', () => {
      const d = parseSpanishDateTime("viernes a las 10", NOW_MS)!;
      expect(d.getHours()).toBe(10);
    });

    it('"5 de la tarde" → 17:00', () => {
      const d = parseSpanishDateTime("viernes 5 de la tarde", NOW_MS)!;
      expect(d.getHours()).toBe(17);
    });

    it('"11 de la mañana" → 11:00', () => {
      const d = parseSpanishDateTime("viernes 11 de la mañana", NOW_MS)!;
      expect(d.getHours()).toBe(11);
    });

    it("returns null without a recognizable time", () => {
      const r = parseSpanishDateTime("viernes", NOW_MS);
      expect(r).toBeNull();
    });
  });

  describe("composed inputs", () => {
    it('"el sábado a las 5 de la tarde" → Saturday 17:00', () => {
      const d = parseSpanishDateTime("el sábado a las 5 de la tarde", NOW_MS)!;
      expect(d.getDay()).toBe(6);
      expect(d.getHours()).toBe(17);
    });

    it('"pasado mañana 9:30am" → Wednesday 09:30', () => {
      const d = parseSpanishDateTime("pasado mañana 9:30am", NOW_MS)!;
      expect(d.getDay()).toBe(3);
      expect(d.getHours()).toBe(9);
      expect(d.getMinutes()).toBe(30);
    });
  });

  // Audit C1 + W2 + W3 (2026-05-24): pin the regression. Each of these
  // failed under the original parser; the new extractDay strips
  // "de la (mañana|tarde|noche)" before searching for day words, and
  // "12 de la noche / mañana" collapses to 0.
  describe("audit folds — day×time-qualifier", () => {
    it('"viernes 9 de la mañana" → FRIDAY 09:00 (not Tuesday)', () => {
      const d = parseSpanishDateTime("viernes 9 de la mañana", NOW_MS)!;
      expect(d.getDay()).toBe(5);
      expect(d.getHours()).toBe(9);
    });

    it('"sábado 11 de la mañana" → SATURDAY 11:00', () => {
      const d = parseSpanishDateTime("sabado 11 de la mañana", NOW_MS)!;
      expect(d.getDay()).toBe(6);
      expect(d.getHours()).toBe(11);
    });

    it('"lunes 8 de la mañana" → next MONDAY 08:00 (not tomorrow)', () => {
      const d = parseSpanishDateTime("lunes 8 de la mañana", NOW_MS)!;
      expect(d.getDay()).toBe(1);
      expect(d.getHours()).toBe(8);
    });

    it('"el viernes a las 9 de la mañana" → FRIDAY 09:00', () => {
      const d = parseSpanishDateTime(
        "el viernes a las 9 de la mañana",
        NOW_MS,
      )!;
      expect(d.getDay()).toBe(5);
      expect(d.getHours()).toBe(9);
    });

    it('"viernes a las 12 de la noche" → FRIDAY 00:00 (midnight, not noon)', () => {
      const d = parseSpanishDateTime("viernes a las 12 de la noche", NOW_MS)!;
      expect(d.getDay()).toBe(5);
      expect(d.getHours()).toBe(0);
    });

    it('"viernes a las 12 de la mañana" → FRIDAY 00:00 (midnight idiom)', () => {
      const d = parseSpanishDateTime("viernes a las 12 de la mañana", NOW_MS)!;
      expect(d.getDay()).toBe(5);
      expect(d.getHours()).toBe(0);
    });
  });
});
