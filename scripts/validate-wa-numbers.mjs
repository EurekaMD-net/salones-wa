/**
 * validate-wa-numbers.mjs
 *
 * Verifica si los números del sheet de prospectos son cuentas WA válidas.
 * Usa onWhatsApp() de Baileys — consulta de presencia silenciosa (sin enviar mensajes).
 *
 * Cadencia: 1.5s base + jitter aleatorio de 0-500ms entre queries (~35-40/min).
 * 405 números ≈ 12-15 minutos total.
 *
 * Resultado: escribe columna "WA_VALIDO" (SI/NO) + "WA_JID" en el sheet.
 * Con --export-valid: copia las filas válidas a un nuevo sheet de destino.
 *
 * Uso:
 *   node scripts/validate-wa-numbers.mjs
 *   node scripts/validate-wa-numbers.mjs --dry-run           # solo imprime, no escribe al sheet
 *   node scripts/validate-wa-numbers.mjs --limit=10          # solo los primeros N números
 *   node scripts/validate-wa-numbers.mjs --export-valid      # copia válidos a sheet destino
 */

import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } from "@whiskeysockets/baileys";
import { google } from "googleapis";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ────────────────────────────────────────────────────────────────

const SESSIONS_DIR = path.join(__dirname, "../data/sessions");
const SESSION_ID = "54444db3-bef2-407c-8fe1-954189d75923"; // sesión activa

const SHEET_ID = "1v0SZe3xqdAX2j4gpECDDuJamoSov0394WYobD7kzrx4";
const SHEET_NAME = "Sheet1";

// Delay entre queries (ms). Base + jitter aleatorio.
const BASE_DELAY_MS = 1500;
const JITTER_MS = 500;

// Nuevo sheet para exportar los válidos (Gilda — Prospectos WA Válidos)
const VALID_EXPORT_SHEET_ID = "1o3jjUyGIlpvlB1waINnUs7nFeBR3k3fworPH_xF550Y";
const VALID_EXPORT_SHEET_NAME = "Sheet1";

// Args
const DRY_RUN = process.argv.includes("--dry-run");
const EXPORT_VALID = process.argv.includes("--export-valid");
const LIMIT_ARG = process.argv.find(a => a.startsWith("--limit="));
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split("=")[1]) : null;

// ─── Google Sheets auth (OAuth2 con credenciales de mission-control) ──────

async function getSheetsClient() {
  // Carga credenciales desde el .env de mission-control o variables de entorno
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Faltan credenciales Google. Ejecuta con:\n" +
      "  env $(grep -E 'GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|GOOGLE_REFRESH_TOKEN' /root/claude/mission-control/.env | xargs) node scripts/validate-wa-numbers.mjs"
    );
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return google.sheets({ version: "v4", auth });
}

// ─── Leer el sheet ─────────────────────────────────────────────────────────

async function readProspects(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:Z`,
  });

  const rows = res.data.values ?? [];
  if (rows.length < 2) throw new Error("Sheet vacío o sin datos");

  const headers = rows[0];
  const phoneColIdx = headers.findIndex(h =>
    /tel[eé]fono|phone|celular|móvil|movil|cel\b/i.test(h)
  );

  if (phoneColIdx === -1) {
    console.log("Headers encontrados:", headers);
    throw new Error("No se encontró columna de teléfono. Headers: " + headers.join(", "));
  }

  // Detectar o crear columna WA_VALIDO
  let waValidColIdx = headers.findIndex(h => /wa_valido|wa_valid|whatsapp_valido/i.test(h));
  let waJidColIdx = headers.findIndex(h => /wa_jid|whatsapp_jid/i.test(h));

  console.log(`📋 Sheet: ${rows.length - 1} prospectos`);
  console.log(`📞 Columna teléfono: [${phoneColIdx}] "${headers[phoneColIdx]}"`);
  console.log(`✅ Columna WA_VALIDO: ${waValidColIdx >= 0 ? `[${waValidColIdx}] "${headers[waValidColIdx]}"` : "nueva (se creará)"}`);

  const prospects = rows.slice(1).map((row, i) => ({
    rowIndex: i + 2, // 1-based, +1 para header
    phone: (row[phoneColIdx] ?? "").toString().trim(),
    currentWaValid: waValidColIdx >= 0 ? row[waValidColIdx] : "",
    allCols: row,
  })).filter(p => p.phone.length >= 8);

  return {
    prospects,
    phoneColIdx,
    waValidColIdx,
    waJidColIdx,
    totalCols: headers.length,
  };
}

// ─── Normalizar número a formato WA ────────────────────────────────────────

function normalizeToWA(phone) {
  // Limpiar: quitar espacios, guiones, paréntesis
  let clean = phone.replace(/[\s\-\(\)\+]/g, "");

  // Si empieza con 52 y tiene 12 dígitos → ya tiene lada país
  if (/^52\d{10}$/.test(clean)) return clean;

  // Si empieza con 521 y tiene 13 dígitos → ya está en formato móvil
  if (/^521\d{10}$/.test(clean)) return clean;

  // 10 dígitos locales → agregar 52 (para fijos/móviles de CDMX)
  // Nota: los números que empiezan con 55/56 son CDMX
  if (/^\d{10}$/.test(clean)) {
    // Para móviles de CDMX (55, 56), WhatsApp usa 521XXXXXXXXXX
    // Para fijos no aplica WA — los filtramos más abajo
    return "52" + clean;
  }

  // 8 dígitos: probablemente fijo sin lada → no es móvil WA
  return null;
}

// ─── Baileys socket (solo lectura, comparte sesión) ────────────────────────

async function createWASocket() {
  const sessionDir = path.join(SESSIONS_DIR, SESSION_ID);
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.ubuntu("Chrome"),
    // Logger mínimo — no queremos ruido en la consola
    logger: {
      level: "silent",
      trace: () => {}, debug: () => {}, info: () => {},
      warn: () => {}, error: () => {},
      child: () => ({ level: "silent", trace: () => {}, debug: () => {},
        info: () => {}, warn: () => {}, error: () => {}, child: () => ({}) }),
    },
    // No cargar mensajes históricos — esto es solo para onWhatsApp()
    getMessage: async () => undefined,
  });

  sock.ev.on("creds.update", saveCreds);

  // Esperar a que el socket esté conectado
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout conectando a WA (30s)")), 30000);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === "open") {
        clearTimeout(timeout);
        console.log("🟢 Conectado a WhatsApp");
        resolve(sock);
      } else if (connection === "close") {
        clearTimeout(timeout);
        const reason = lastDisconnect?.error?.message ?? "unknown";
        reject(new Error(`Conexión cerrada: ${reason}`));
      }
    });
  });

  return sock;
}

// ─── Delay con jitter ──────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomDelay() {
  return BASE_DELAY_MS + Math.floor(Math.random() * JITTER_MS);
}

// ─── Escribir resultado al sheet ───────────────────────────────────────────

async function writeResult(sheets, rowIndex, waValidColIdx, waJidColIdx, totalCols, isValid, jid) {
  // Convertir índice a letra de columna (0=A, 1=B, ...)
  const toColLetter = (idx) => {
    let result = "";
    let n = idx;
    while (n >= 0) {
      result = String.fromCharCode(65 + (n % 26)) + result;
      n = Math.floor(n / 26) - 1;
    }
    return result;
  };

  // Si aún no hay columna WA_VALIDO, la crearemos al final del sheet
  const validColLetter = toColLetter(waValidColIdx);
  const jidColLetter = waJidColIdx >= 0 ? toColLetter(waJidColIdx) : toColLetter(totalCols);

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      valueInputOption: "RAW",
      data: [
        {
          range: `${SHEET_NAME}!${validColLetter}${rowIndex}`,
          values: [[isValid ? "SI" : "NO"]],
        },
        {
          range: `${SHEET_NAME}!${jidColLetter}${rowIndex}`,
          values: [[jid ?? ""]],
        },
      ],
    },
  });
}

// ─── Exportar válidos a nuevo sheet ────────────────────────────────────────

async function exportValidProspects(sheets, sourceSheetId, sourceSheetName) {
  console.log(`\n📤 Exportando prospectos WA válidos a nuevo sheet...`);

  // Leer toda la hoja fuente
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sourceSheetId,
    range: `${sourceSheetName}!A:Z`,
  });

  const rows = res.data.values ?? [];
  if (rows.length < 2) throw new Error("Sheet fuente vacío");

  const headers = rows[0];
  const waValidColIdx = headers.findIndex(h => /wa_valido|wa_valid/i.test(h));
  if (waValidColIdx === -1) throw new Error("No se encontró columna WA_VALIDO en el sheet fuente — ejecuta la validación primero");

  // Filtrar filas con WA_VALIDO = SI
  const validRows = rows.slice(1).filter(row => (row[waValidColIdx] ?? "").toString().trim().toUpperCase() === "SI");

  console.log(`   Filas válidas encontradas: ${validRows.length}`);

  if (validRows.length === 0) {
    console.log("   ⚠️  No hay prospectos válidos para exportar (¿ya se validaron?)");
    return;
  }

  // Escribir headers + filas válidas al sheet destino
  const exportData = [headers, ...validRows];
  await sheets.spreadsheets.values.update({
    spreadsheetId: VALID_EXPORT_SHEET_ID,
    range: `${VALID_EXPORT_SHEET_NAME}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: exportData },
  });

  console.log(`   ✅ ${validRows.length} prospectos exportados`);
  console.log(`   📋 Sheet: https://docs.google.com/spreadsheets/d/${VALID_EXPORT_SHEET_ID}/edit`);
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔍 Validador WA — Gilda.mx Prospects`);
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no escribe al sheet)" : "LIVE"}`);
  if (LIMIT) console.log(`Limit: primeros ${LIMIT} números`);
  console.log("");

  // 1. Sheets client
  const sheets = await getSheetsClient();

  // 2. Leer prospectos
  let { prospects, phoneColIdx, waValidColIdx, waJidColIdx, totalCols } = await readProspects(sheets);

  // Si no hay columna WA_VALIDO, la creamos con header
  if (!DRY_RUN && waValidColIdx < 0) {
    const newColIdx = totalCols;
    const toColLetter = (idx) => {
      let result = "", n = idx;
      while (n >= 0) { result = String.fromCharCode(65 + (n % 26)) + result; n = Math.floor(n / 26) - 1; }
      return result;
    };
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!${toColLetter(newColIdx)}1`,
      valueInputOption: "RAW",
      requestBody: { values: [["WA_VALIDO"]] },
    });
    waValidColIdx = newColIdx;
    // WA_JID en columna siguiente
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!${toColLetter(newColIdx + 1)}1`,
      valueInputOption: "RAW",
      requestBody: { values: [["WA_JID"]] },
    });
    waJidColIdx = newColIdx + 1;
    totalCols += 2;
    console.log(`📝 Columnas WA_VALIDO y WA_JID creadas`);
  }

  // Filtrar los que ya fueron validados (para poder reanudar)
  const pending = prospects.filter(p => {
    const already = (p.currentWaValid ?? "").toString().trim();
    return already !== "SI" && already !== "NO";
  });

  console.log(`📊 Total: ${prospects.length} | Ya validados: ${prospects.length - pending.length} | Pendientes: ${pending.length}`);

  const toProcess = LIMIT ? pending.slice(0, LIMIT) : pending;
  const estimatedMin = Math.ceil((toProcess.length * (BASE_DELAY_MS + JITTER_MS / 2)) / 60000);
  console.log(`⏱  Tiempo estimado: ~${estimatedMin} min\n`);

  if (toProcess.length === 0) {
    console.log("✅ Todos los números ya están validados.");
    return;
  }

  // 3. Conectar Baileys
  const sock = await createWASocket();

  // 4. Validar
  let valid = 0, invalid = 0, skipped = 0, errors = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const { rowIndex, phone } = toProcess[i];
    const waNum = normalizeToWA(phone);

    if (!waNum) {
      console.log(`[${i + 1}/${toProcess.length}] ⚠️  Row ${rowIndex}: "${phone}" → formato no válido, skip`);
      skipped++;
      continue;
    }

    try {
      const [result] = await sock.onWhatsApp(waNum);
      const isValid = result?.exists === true;
      const jid = result?.jid ?? null;

      console.log(
        `[${i + 1}/${toProcess.length}] Row ${rowIndex}: ${phone} → ${waNum} → ${isValid ? "✅ WA" : "❌ NO WA"}${jid ? ` (${jid})` : ""}`
      );

      if (isValid) valid++; else invalid++;

      if (!DRY_RUN) {
        await writeResult(sheets, rowIndex, waValidColIdx, waJidColIdx, totalCols, isValid, jid);
      }
    } catch (err) {
      console.error(`[${i + 1}/${toProcess.length}] ❌ Error Row ${rowIndex} (${phone}): ${err.message}`);
      errors++;
    }

    // Delay entre queries (excepto en el último)
    if (i < toProcess.length - 1) {
      await sleep(randomDelay());
    }
  }

  // 5. Resumen
  console.log(`\n${"─".repeat(50)}`);
  console.log(`📊 RESUMEN`);
  console.log(`   ✅ Con WA:     ${valid}`);
  console.log(`   ❌ Sin WA:     ${invalid}`);
  console.log(`   ⚠️  Formato inválido: ${skipped}`);
  console.log(`   💥 Errores:   ${errors}`);
  console.log(`   Total procesados: ${toProcess.length}`);
  if (DRY_RUN) console.log(`\n   (DRY RUN — nada se escribió al sheet)`);

  // 6. Exportar válidos al sheet destino (si se pidió)
  if (EXPORT_VALID && !DRY_RUN) {
    await exportValidProspects(sheets, SHEET_ID, SHEET_NAME);
  }

  await sock.end();
  process.exit(0);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
