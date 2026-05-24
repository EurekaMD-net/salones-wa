import { describe, it, expect } from "vitest";
import { parseIntent } from "../src/bot/intent-parser.js";

describe("parseIntent", () => {
  describe("book", () => {
    it('recognizes "quiero cita para corte"', () => {
      const r = parseIntent("quiero cita para corte");
      expect(r.type).toBe("book");
    });
    it("extracts service from message", () => {
      const r = parseIntent("quiero agendar una cita para manicure");
      expect(r.type).toBe("book");
      if (r.type === "book") expect(r.service).toBe("manicure");
    });
    it('recognizes "hola quiero cita"', () => {
      const r = parseIntent("hola quiero cita");
      expect(r.type).toBe("book");
    });
    it('recognizes "necesito reservar"', () => {
      const r = parseIntent("necesito reservar un lugar");
      expect(r.type).toBe("book");
    });
    it("extracts day hint from date", () => {
      const r = parseIntent("quiero cita para el sábado");
      expect(r.type).toBe("book");
      if (r.type === "book") expect(r.date?.toLowerCase()).toContain("sábado");
    });
    it('extracts "mañana" as date', () => {
      const r = parseIntent("Hola quisiera cita para mañana");
      expect(r.type).toBe("book");
      if (r.type === "book") expect(r.date?.toLowerCase()).toBe("mañana");
    });
  });

  describe("cancel", () => {
    it('recognizes "cancelar mi cita"', () => {
      const r = parseIntent("quiero cancelar mi cita");
      expect(r.type).toBe("cancel");
    });
    it('recognizes "no puedo ir"', () => {
      const r = parseIntent("no puedo ir mañana");
      expect(r.type).toBe("cancel");
    });
    it('recognizes "cancelar" standalone', () => {
      const r = parseIntent("cancelar");
      expect(r.type).toBe("cancel");
    });
    it('recognizes "CANCELAR" (uppercase)', () => {
      const r = parseIntent("CANCELAR");
      expect(r.type).toBe("cancel");
    });
  });

  describe("reschedule", () => {
    it('recognizes "quiero cambiar mi cita"', () => {
      const r = parseIntent("quiero cambiar mi cita");
      expect(r.type).toBe("reschedule");
    });
    it('recognizes "reagendar" standalone', () => {
      const r = parseIntent("reagendar");
      expect(r.type).toBe("reschedule");
    });
    it('recognizes "puedo mover mi cita"', () => {
      const r = parseIntent("puedo mover mi cita?");
      expect(r.type).toBe("reschedule");
    });
    it('recognizes "necesito modificar la cita"', () => {
      const r = parseIntent("necesito modificar la cita");
      expect(r.type).toBe("reschedule");
    });
    it('recognizes "cita la quiero cambiar"', () => {
      const r = parseIntent("mi cita la quiero cambiar");
      expect(r.type).toBe("reschedule");
    });
    it('does NOT misclassify "cancelar" as reschedule', () => {
      const r = parseIntent("quiero cancelar mi cita");
      expect(r.type).toBe("cancel");
    });
    it('does NOT misclassify "puedes quitar mi cita?" as reschedule (still cancel-adjacent / fallback)', () => {
      // W1 from prior audit: "quitar" should NOT be OPT_OUT in this phrasing.
      // RESCHEDULE patterns don't include "quitar", so this stays cancel-or-fallback.
      const r = parseIntent("puedes quitar mi cita?");
      expect(r.type).not.toBe("reschedule");
      expect(r.type).not.toBe("opt_out");
    });

    // Audit C2 R1 — false-positive class confirmed empirically. These all
    // failed under the original unbounded patterns; fixed by adding
    // cita/hora/día/horario anchor, bounding `.*` to `.{0,40}`, anchoring
    // bare-verb form to start/end, and adding a negation guard.
    it('does NOT classify "voy a reagendar después con calma" as reschedule', () => {
      const r = parseIntent("voy a reagendar después con calma");
      expect(r.type).not.toBe("reschedule");
    });
    it('does NOT classify "no quiero reagendar nada" as reschedule (negation guard)', () => {
      const r = parseIntent("no quiero reagendar nada");
      expect(r.type).not.toBe("reschedule");
    });
    it('does NOT classify "puedo cambiar de opinión sobre la cita" as reschedule', () => {
      const r = parseIntent("puedo cambiar de opinión sobre la cita");
      expect(r.type).not.toBe("reschedule");
    });
    it('does NOT classify "puedes cambiar la dirección por favor" as reschedule (no cita/hora anchor)', () => {
      const r = parseIntent("puedes cambiar la dirección por favor");
      expect(r.type).not.toBe("reschedule");
    });
  });

  describe("confirm", () => {
    it('recognizes "sí"', () => {
      const r = parseIntent("sí");
      expect(r.type).toBe("confirm");
    });
    it('recognizes "si" (without accent)', () => {
      const r = parseIntent("si");
      expect(r.type).toBe("confirm");
    });
    it('recognizes "confirmo"', () => {
      const r = parseIntent("confirmo");
      expect(r.type).toBe("confirm");
    });
    it('recognizes "dale"', () => {
      const r = parseIntent("dale");
      expect(r.type).toBe("confirm");
    });
    it('recognizes "ok"', () => {
      const r = parseIntent("ok");
      expect(r.type).toBe("confirm");
    });
  });

  describe("opt_out", () => {
    it('recognizes "no me mandes mensajes"', () => {
      const r = parseIntent("no me mandes mensajes");
      expect(r.type).toBe("opt_out");
    });
    it('recognizes "STOP"', () => {
      const r = parseIntent("STOP");
      expect(r.type).toBe("opt_out");
    });
    it('recognizes "darme de baja"', () => {
      const r = parseIntent("quiero darme de baja");
      expect(r.type).toBe("opt_out");
    });
  });

  describe("query_appointment", () => {
    it('recognizes "cuándo tengo mi cita"', () => {
      const r = parseIntent("cuándo tengo mi cita?");
      expect(r.type).toBe("query_appointment");
    });
    it('recognizes "a qué hora es mi cita"', () => {
      const r = parseIntent("a qué hora es mi cita");
      expect(r.type).toBe("query_appointment");
    });
  });

  describe("reactivation context", () => {
    it('maps "sí" to reactivation_yes in reactivation context', () => {
      const r = parseIntent("sí", "reactivation");
      expect(r.type).toBe("reactivation_yes");
    });
    it('maps "no gracias" to reactivation_no', () => {
      const r = parseIntent("no gracias", "reactivation");
      expect(r.type).toBe("reactivation_no");
    });
    it('maps "no" to reactivation_no', () => {
      const r = parseIntent("no", "reactivation");
      expect(r.type).toBe("reactivation_no");
    });
    it('maps "quiero tinte" to unknown (W2: broad quiero no longer matches YES)', () => {
      const r = parseIntent("quiero tinte", "reactivation");
      expect(r.type).toBe("unknown");
    });

    it('maps "si quiero" to reactivation_yes (anchored YES phrase)', () => {
      const r = parseIntent("si quiero", "reactivation");
      expect(r.type).toBe("reactivation_yes");
    });

    it('maps "no quiero" to reactivation_no (W2: NO checked before YES)', () => {
      const r = parseIntent("no quiero", "reactivation");
      expect(r.type).toBe("reactivation_no");
    });
  });

  describe("unknown", () => {
    it("returns unknown for unrecognized text", () => {
      const r = parseIntent("jajajaja qué onda");
      expect(r.type).toBe("unknown");
    });
    it("includes raw text in unknown intent", () => {
      const r = parseIntent("algo raro");
      if (r.type === "unknown") expect(r.raw).toBe("algo raro");
    });
  });
});
