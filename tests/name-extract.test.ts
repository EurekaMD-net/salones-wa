import { describe, it, expect } from "vitest";
import { extractFirstName } from "../src/bot/name-extract.js";

describe("extractFirstName", () => {
  it.each([
    ["María", "María"],
    ["maria", "Maria"],
    ["MARIA", "Maria"],
    ["josé", "José"],
    ["Lupita", "Lupita"],
    ["  Ana  ", "Ana"],
    ["María😊", "María"],
    ["María,", "María"],
  ])("takes a bare name %j -> %j", (input, expected) => {
    expect(extractFirstName(input)).toBe(expected);
  });

  it.each([
    ["soy María", "María"],
    ["Soy Ana", "Ana"],
    ["me llamo Sofía", "Sofía"],
    ["mi nombre es Carmen", "Carmen"],
    ["hola, soy Lupita", "Lupita"],
    ["buenas soy Ana", "Ana"],
    ["habla Rosa", "Rosa"],
    ["me dicen Pau", "Pau"],
  ])("strips a lead-in: %j -> %j", (input, expected) => {
    expect(extractFirstName(input)).toBe(expected);
  });

  it("takes only the FIRST name from a full name", () => {
    expect(extractFirstName("Ana Sofía")).toBe("Ana");
    expect(extractFirstName("me llamo José Luis")).toBe("José");
    // With a "me llamo" lead-in a full name is trusted -> first token wins.
    expect(extractFirstName("me llamo María García López")).toBe("María");
  });

  it("rejects a multi-word reply with NO lead-in (could be a sentence)", () => {
    // Conservative: without "soy/me llamo", >2 words is treated as not-a-name.
    expect(extractFirstName("María García López")).toBeNull();
  });

  it.each([
    "sí",
    "si",
    "no",
    "ok",
    "okay",
    "gracias",
    "muchas gracias",
    "hola",
    "claro",
    "dale",
    "va",
    "perfecto",
    "ya",
    "pues no sé",
    "ninguno",
  ])("rejects non-name reply %j", (input) => {
    expect(extractFirstName(input)).toBeNull();
  });

  it.each([
    "",
    "   ",
    "\n",
    "1",
    "5530331051",
    "el viernes 5",
    "...",
    "-",
    "??",
  ])("rejects blank / digits / punctuation %j", (input) => {
    expect(extractFirstName(input)).toBeNull();
  });

  it("rejects a sentence that isn't a name (no lead-in, >2 words)", () => {
    expect(extractFirstName("no quiero dar mi nombre")).toBeNull();
    expect(extractFirstName("para qué lo necesitas")).toBeNull();
  });

  it("rejects a too-long token", () => {
    expect(extractFirstName("Aaaaaaaaaaaaaaaaaaaaaaaaa")).toBeNull();
  });

  it("rejects a single-letter token", () => {
    expect(extractFirstName("a")).toBeNull();
  });

  it("keeps an accent the clienta typed and title-cases the rest", () => {
    expect(extractFirstName("ROSÍO")).toBe("Rosío");
    expect(extractFirstName("renata")).toBe("Renata");
  });

  // qa W1 — "con"/"es" are NOT name lead-ins; they used to expose the next word.
  it.each(["con gusto", "con permiso", "es broma", "es para hoy"])(
    "does not mine a name out of a 'con/es' phrase: %j",
    (input) => {
      expect(extractFirstName(input)).toBeNull();
    },
  );

  // qa W2 — short function words after a lead-in must not be stored.
  it.each(["soy de Monterrey", "de Ana", "su nombre", "ella", "eso mero"])(
    "rejects a stray function word %j",
    (input) => {
      expect(extractFirstName(input)).toBeNull();
    },
  );

  // qa I2 — chat-speak / laughter / vowel-less gibberish are not names.
  it.each(["xd", "jaja", "jajaja", "haha", "jeje", "ntp", "uy"])(
    "rejects gibberish/laughter %j",
    (input) => {
      expect(extractFirstName(input)).toBeNull();
    },
  );

  // qa I3 — compound names title-case each segment.
  it("title-cases compound names", () => {
    expect(extractFirstName("me llamo ana-maría")).toBe("Ana-María");
    expect(extractFirstName("d'angela")).toBe("D'Angela");
  });
});
