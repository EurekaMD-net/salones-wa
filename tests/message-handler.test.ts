import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initDb, resetDbSingleton } from "../src/db/database.js";
import {
  createSalon,
  addService,
  upsertContact,
  createAppointment,
} from "../src/db/models.js";
import { handleInboundMessage } from "../src/bot/message-handler.js";
import { conversationState } from "../src/bot/conversation-state.js";
import type Database from "better-sqlite3";

let db: Database.Database;
let salonId: string;

function now() {
  return Math.floor(Date.now() / 1000);
}
function hoursFromNow(h: number) {
  return now() + h * 3600;
}

beforeEach(() => {
  db = initDb(":memory:");
  const salon = createSalon(db, { name: "Test Salon", phone: "+5255000001" });
  salonId = salon.id;
  addService(db, {
    salon_id: salonId,
    name: "Corte",
    duration_min: 45,
    price: 150,
  });
});

afterEach(() => {
  resetDbSingleton();
  vi.restoreAllMocks();
});

const PHONE = "+5255100001";

async function send(text: string) {
  return handleInboundMessage(db, salonId, PHONE, text);
}

describe("handleInboundMessage", () => {
  describe("booking flow", () => {
    it("replies with slot offer on booking intent", async () => {
      const result = await send("quiero cita para corte");
      expect(result.reply).not.toBeNull();
      expect(result.reply).toContain("1️⃣");
    });

    it("books appointment on slot selection", async () => {
      await send("quiero cita");
      const result = await send("1");
      expect(result.reply).toContain("✅");
    });

    it("rejects invalid slot number", async () => {
      await send("quiero cita");
      const result = await send("9");
      expect(result.reply).toContain("número del 1 al");
    });

    it("creates contact in DB on first message", async () => {
      await send("quiero cita");
      const contact = db
        .prepare("SELECT * FROM contacts WHERE phone = ?")
        .get(PHONE);
      expect(contact).toBeTruthy();
    });
  });

  describe("cancel flow", () => {
    async function bookAppointment() {
      const contact = upsertContact(db, { salon_id: salonId, phone: PHONE });
      return createAppointment(db, {
        salon_id: salonId,
        contact_id: contact.id,
        starts_at: hoursFromNow(48),
        ends_at: hoursFromNow(49),
      });
    }

    it("asks confirm when user cancels and has appointment", async () => {
      await bookAppointment();
      const result = await send("quiero cancelar mi cita");
      expect(result.reply).toContain("Confirmas la cancelación");
    });

    it("confirms cancellation on SÍ", async () => {
      await bookAppointment();
      await send("cancelar");
      const result = await send("sí");
      expect(result.reply).toContain("Cancelada");
    });

    it("returns no-appointment message when no upcoming cita", async () => {
      const result = await send("quiero cancelar");
      expect(result.reply).toContain("No encontré");
    });
  });

  describe("reschedule flow", () => {
    async function bookAppointment() {
      const contact = upsertContact(db, { salon_id: salonId, phone: PHONE });
      return createAppointment(db, {
        salon_id: salonId,
        contact_id: contact.id,
        starts_at: hoursFromNow(48),
        ends_at: hoursFromNow(49),
      });
    }

    it("offers slots when user wants to reschedule existing cita", async () => {
      await bookAppointment();
      const result = await send("quiero cambiar mi cita");
      expect(result.reply).toContain("Tu cita actual es");
      expect(result.reply).toContain("1️⃣");
    });

    it("returns no-cita message when nothing to reschedule", async () => {
      const result = await send("reagendar");
      expect(result.reply).toContain("No tienes citas próximas");
    });

    it("cancels old + creates new appointment on slot pick", async () => {
      const old = await bookAppointment();
      await send("quiero cambiar mi cita");
      const result = await send("1");
      expect(result.reply).toContain("quedó el");
      expect(result.reply).toContain("anterior");

      // Old appointment cancelled
      const oldRow = db
        .prepare("SELECT status FROM appointments WHERE id = ?")
        .get(old.id) as { status: string };
      expect(oldRow.status).toBe("cancelled");

      // Exactly one active future appointment now
      const active = db
        .prepare(
          "SELECT COUNT(*) as n FROM appointments WHERE contact_id = (SELECT id FROM contacts WHERE phone = ?) AND status != 'cancelled'",
        )
        .get(PHONE) as { n: number };
      expect(active.n).toBe(1);
    });

    it("rejects invalid slot number during reschedule", async () => {
      await bookAppointment();
      await send("reagendar");
      const result = await send("99");
      expect(result.reply).toContain("número del 1 al");
    });

    // Audit W3 fold — abandonment detection
    it("releases state when user abandons mid-reschedule", async () => {
      await bookAppointment();
      await send("quiero cambiar mi cita");
      const result = await send("mejor lo dejo así");
      expect(result.reply).toContain("dejamos tu cita como estaba");

      // State cleared — next BOOK should start fresh, not be treated as
      // a stuck slot-selection.
      const followup = await send("quiero cita para corte");
      expect(followup.reply).toContain("1️⃣");
    });

    // Audit W3 fold — same abandonment path on BOOK flow (grep-sweep rule)
    it("releases state when user abandons mid-book", async () => {
      await send("quiero cita");
      const result = await send("olvidalo");
      expect(result.reply).toContain("dejamos tu cita como estaba");
    });
  });

  describe("service selection", () => {
    beforeEach(() => {
      // Add more services so we can verify matching beyond services[0]
      addService(db, {
        salon_id: salonId,
        name: "Tinte",
        duration_min: 90,
        price: 500,
      });
      addService(db, {
        salon_id: salonId,
        name: "Manicure",
        duration_min: 60,
        price: 200,
      });
    });

    it("matches explicit service hint from BOOK message", async () => {
      const r = await send("quiero cita para tinte");
      // Should offer slots for Tinte (which appears in preamble)
      expect(r.reply).toMatch(/Tinte/i);
    });

    it("asks which service when no hint", async () => {
      const r = await send("quiero cita");
      expect(r.reply).toMatch(/qué servicio/i);
      // List should include all 3 services
      expect(r.reply).toMatch(/Corte/);
      expect(r.reply).toMatch(/Tinte/);
      expect(r.reply).toMatch(/Manicure/);
    });

    it("picks service by number after asking", async () => {
      await send("quiero cita"); // no hint → asks
      const r = await send("2"); // pick 2nd service (Tinte)
      expect(r.reply).toMatch(/Tinte/i);
    });

    it("picks service by name (case-insensitive)", async () => {
      await send("quiero cita");
      const r = await send("manicure");
      expect(r.reply).toMatch(/Manicure/i);
    });

    it("re-asks on invalid service input", async () => {
      await send("quiero cita");
      const r = await send("99");
      expect(r.reply).toMatch(/qué servicio/i);
    });

    it("books selected service end-to-end (not defaulting to Corte)", async () => {
      await send("quiero cita para tinte");
      const offer = await send("1");
      expect(offer.reply).toMatch(/Tinte/i);

      const row = db
        .prepare(
          "SELECT s.name FROM appointments a JOIN services s ON s.id = a.service_id WHERE a.contact_id = (SELECT id FROM contacts WHERE phone = ?) ORDER BY a.created_at DESC LIMIT 1",
        )
        .get(PHONE) as { name: string };
      expect(row.name).toBe("Tinte");
    });
  });

  describe("custom-time flow (4th option)", () => {
    it("offer includes the custom-time 4th option label", async () => {
      const r = await send("quiero cita para corte");
      // Slots have 3 options + 1 custom — must show 4th
      expect(r.reply).toContain("Otra fecha");
    });

    it("picking 4 transitions to awaiting_custom_time + asks the clienta", async () => {
      await send("quiero cita");
      const r = await send("4");
      expect(r.reply).toContain("día y hora");
    });

    it("unparseable custom-time response asks for rephrase", async () => {
      await send("quiero cita");
      await send("4");
      const r = await send("blablabla");
      expect(r.reply).toContain("No pude entender");
    });

    it("custom time accepted → asks SÍ confirm → books on SÍ", async () => {
      await send("quiero cita");
      await send("4");
      // "viernes 4pm" — both future enough and within Mon-Sat 9-19
      const ask = await send("viernes 4pm");
      expect(ask.reply).toContain("¿Confirmas?");

      const confirm = await send("sí");
      expect(confirm.reply).toContain("Listo");
      // Appointment row created
      const n = db
        .prepare(
          "SELECT COUNT(*) as n FROM appointments WHERE status='confirmed' AND contact_id = (SELECT id FROM contacts WHERE phone = ?)",
        )
        .get(PHONE) as { n: number };
      expect(n.n).toBe(1);
    });

    it("custom time in the past rejects with explicit reason", async () => {
      await send("quiero cita");
      await send("4");
      // "hoy 9am" is within 24h
      const r = await send("hoy 9am");
      expect(r.reply ?? "").toMatch(/24 horas|pasó|anticipación/i);
    });
  });

  describe("query flow", () => {
    it("returns next appointment when exists", async () => {
      const contact = upsertContact(db, { salon_id: salonId, phone: PHONE });
      createAppointment(db, {
        salon_id: salonId,
        contact_id: contact.id,
        starts_at: hoursFromNow(48),
        ends_at: hoursFromNow(49),
      });
      const result = await send("cuándo es mi cita");
      expect(result.reply).toContain("próxima cita");
    });

    it("returns no upcoming message when no cita", async () => {
      const result = await send("cuándo tengo mi cita");
      expect(result.reply).toContain("No tienes citas próximas");
    });
  });

  describe("confirm flow", () => {
    it("replies confirmation received", async () => {
      const result = await send("confirmo");
      expect(result.reply).toContain("ahí te esperamos");
    });
  });

  describe("opt-out", () => {
    it("marks contact as opt_out and confirms", async () => {
      const result = await send("no me mandes más mensajes");
      expect(result.reply).toContain("damos de baja");
    });

    it("returns null reply for opted-out contact on subsequent message", async () => {
      await send("STOP");
      const result = await send("hola quiero cita");
      expect(result.reply).toBeNull();
    });
  });

  describe("fallback", () => {
    it("returns fallback for unknown messages", async () => {
      const result = await send("jaja que onda");
      expect(result.reply).toContain("Agendar");
    });
  });

  describe("reactivation context", () => {
    it("offers slots on reactivation_yes response", async () => {
      const contact = upsertContact(db, { salon_id: salonId, phone: PHONE });
      // Set up reactivation state
      conversationState.set(
        {
          step: "reactivation_sent",
          salon_id: salonId,
          contact_id: contact.id,
          campaign_id: "fake-campaign-id",
          updated_at: Date.now(),
        },
        PHONE,
      );

      const result = await send("sí quiero");
      expect(result.reply).toContain("1️⃣");
    });

    it("says goodbye on reactivation_no", async () => {
      const contact = upsertContact(db, { salon_id: salonId, phone: PHONE });
      conversationState.set(
        {
          step: "reactivation_sent",
          salon_id: salonId,
          contact_id: contact.id,
          updated_at: Date.now(),
        },
        PHONE,
      );

      const result = await send("no gracias");
      expect(result.reply).toContain("cuando gustes");
    });
  });
});
