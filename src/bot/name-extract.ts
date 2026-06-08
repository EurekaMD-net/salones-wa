/**
 * First-name extractor for the post-confirmation "¿cómo te llamas?" reply.
 *
 * Deliberately CONSERVATIVE: a stored name is greeted back at the clienta on
 * every future reminder, so a false capture ("Hola, Sí 😊") is worse than no
 * name at all. When in doubt we return null and the handler simply moves on
 * without storing — never re-nagging.
 *
 * Returns the cleaned, capitalized FIRST name, or null when the reply is not a
 * name (a decline, a yes/no, a greeting, a command, a sentence, digits, or
 * gibberish).
 */

// Optional greeting + the common ways a clienta prefixes her name:
//   "hola, soy María"  ·  "me llamo Ana"  ·  "mi nombre es Sofía"  ·  "habla Lupita"
// The leading greeting is stripped so "buenas, soy Ana" still yields "Ana".
// NB: deliberately NO bare "con"/"es" lead-ins — they'd turn "con gusto" into
// "Gusto" and "es broma" into "Broma" (qa W1). Real intros are covered above.
const NAME_PREFIXES =
  /^(?:(?:hola|buenas?|buenos|qu[eé]\s+tal|qu[eé]\s+onda)[\s,!.]*)?(?:soy|me\s+llamo|mi\s+nombre\s+es|me\s+dicen|me\s+puedes\s+decir|h[aá]bla)\s+/i;

// Single words that are never a first name even though they pass the shape
// checks. Kept lowercase + unaccented-or-accented as users actually type them.
const NON_NAME_WORDS = new Set([
  // affirm / negate / fillers
  "si",
  "sí",
  "no",
  "ok",
  "okay",
  "oki",
  "va",
  "vale",
  "sale",
  "claro",
  "dale",
  "bueno",
  "buena",
  "buenas",
  "buenos",
  "listo",
  "lista",
  "perfecto",
  "perfecta",
  "ajá",
  "aja",
  "ya",
  "pues",
  "este",
  "esta",
  "eh",
  "mmm",
  "aaa",
  "jaja",
  "jeje",
  "nomas",
  "nomás",
  "también",
  "tambien",
  "tampoco",
  // greetings / gratitude (incl. the words that lead "muchas/mil gracias")
  "hola",
  "gracias",
  "grasias",
  "graxias",
  "graciass",
  "muchas",
  "mucho",
  "muchos",
  "mil",
  "muy",
  "adiós",
  "adios",
  "buenas",
  "saludos",
  // pronouns / articles / preps (would otherwise lead a short sentence)
  "yo",
  "tu",
  "tú",
  "usted",
  "ustedes",
  "mi",
  "me",
  "le",
  "la",
  "el",
  "lo",
  "un",
  "una",
  "para",
  "por",
  "con",
  "de",
  "del",
  "su",
  "sus",
  "ella",
  "ello",
  "eso",
  "esa",
  "que",
  "qué",
  "y",
  "o",
  // stray interjections / chat-speak that pass the shape checks
  "uy",
  "uf",
  "ay",
  "xd",
  "xdd",
  // copula / common verbs (e.g. "es broma", "soy de…") — never a name
  "es",
  "son",
  "soy",
  "eres",
  "era",
  "fue",
  "fui",
  // intent words (a command should escape the name step, but guard anyway)
  "confirmo",
  "cita",
  "citas",
  "cancelar",
  "cancela",
  "agendar",
  "reagendar",
  "cambiar",
  "mover",
  "quiero",
  "necesito",
  // time words people might send instead of a name
  "hoy",
  "mañana",
  "manana",
  "ahorita",
  "ahora",
  "luego",
  "después",
  "despues",
  "nadie",
  "nada",
  "ninguno",
  "ninguna",
]);

// A token with no vowel ("ntp", "xd") isn't a name. Accented vowels count.
const HAS_VOWEL = /[aeiouáéíóúü]/i;
// Pure repeated laughter ("jaja", "jajaja", "jeje", "haha") — never a name.
const LAUGHTER = /^(?:[jh][aeiouáéíóú]){2,}$/i;

function capitalize(word: string): string {
  // Title-case each hyphen/apostrophe segment ("ana-maría" -> "Ana-María",
  // "d'angela" -> "D'Angela") so compound names display correctly (qa I3).
  return word
    .split(/([-'’])/)
    .map((seg) =>
      /^[-'’]$/.test(seg)
        ? seg
        : seg.charAt(0).toLocaleUpperCase("es-MX") +
          seg.slice(1).toLocaleLowerCase("es-MX"),
    )
    .join("");
}

export function extractFirstName(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Names never contain digits — this also rejects phone numbers, dates,
  // "soy la de las 5", slot picks ("1"), etc.
  if (/\d/.test(trimmed)) return null;

  const hadPrefix = NAME_PREFIXES.test(trimmed);
  const body = trimmed.replace(NAME_PREFIXES, "").trim();
  if (!body) return null;

  const tokens = body.split(/\s+/);
  // A bare-name reply is short. Without an explicit "soy/me llamo" lead-in,
  // anything past 2 words is almost certainly a sentence, not a name.
  if (!hadPrefix && tokens.length > 2) return null;
  // Even with a lead-in, cap the length so a rant after "soy ..." isn't mined.
  if (tokens.length > 5) return null;

  // First whitespace-delimited token = the first name. Keep letters, combining
  // marks, and the punctuation real names use (apostrophe / hyphen).
  const cleaned = tokens[0].replace(/[^\p{L}\p{M}'’-]/gu, "");
  if (cleaned.length < 2 || cleaned.length > 20) return null;
  if (!/\p{L}/u.test(cleaned)) return null; // must contain an actual letter
  if (!HAS_VOWEL.test(cleaned)) return null; // "ntp"/"xd" aren't names
  if (LAUGHTER.test(cleaned)) return null; // "jaja"/"jajaja"/"haha"
  if (NON_NAME_WORDS.has(cleaned.toLocaleLowerCase("es-MX"))) return null;

  return capitalize(cleaned);
}
