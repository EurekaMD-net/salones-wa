/**
 * validate-wa-numbers.mjs
 *
 * Verifica si los números del sheet de prospectos son cuentas WA válidas.
 * Usa el endpoint interno /internal/check-wa del bot salones-wa (que ya tiene
 * el socket Baileys activo) — cadencia controlada, sin crear un segundo socket.
 *
 * Cadencia: 1.5s base + jitter aleatorio de 0-500ms entre queries (~35-40/min).
 * 405 números ≈ 12-15 minutos total.
 *
 * Resultado:
 *   - Escribe columna "WA_VALIDO" (SI/NO) + "WA_JID" en el sheet fuente.
 *   - Con --export-valid: copia las filas válidas a un nuevo sheet destino.
 *
 * Uso:
 *   node scripts/validate-wa-numbers.mjs
 *   node scripts/validate-wa-numbers.mjs --dry-run           # solo imprime, no escribe
 *   node scripts/validate-wa-numbers.mjs --limit=10          # solo los primeros N
 *   node scripts/validate-wa-numbers.mjs --export-valid      # copia válidos al sheet destino
 */

import { google } from "googleapis";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ────────────────────────────────────────────────────────────────

// Sheet fuente: DENUE prospectos Iztapalapa
const SHEET_ID = "1v0SZe3xqdAX2j4gpECDDuJamoSov0394WYobD7kzrx4";
const SHEET_NAME = "Sheet1";

// Sheet destino: Gilda — Prospectos WA Válidos
const VALID_EXPORT_SHEET_ID = "1o3jjUyGIlpvlB1waINnUs7nFeBR3k3fworPH_xF550Y";
const VALID_EXPORT_SHEET_NAME = "Sheet1";

// Bot interno — endpoint de presencia WA (loopback, sin auth)
const BOT_BASE_URL = "http://127.0.0.1:8085";

// Delay entre queries (ms). Base + jitter aleatorio.
const BASE_DELAY_MS = 1500;
const JITTER_MS = 500;

// Args
const DRY_RUN = process.argv.includes("--dry-run");
const EXPORT_VALID = process.argv.includes("--export-valid");
const LIMIT_ARG = process.argv.find(a => a.startsWith("--limit="));
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split("=")[1]) : null;

// ─── Google Sheets auth (OAuth2 con credenciales de mission-control) ──────

async function getSheetsClient() {
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

  let waValidColIdx = headers.findIndex(h => /wa_valido|wa_valid|whatsapp_valido/i.test(h));
  let waJidColIdx = headers.findIndex(h => /wa_jid|whatsapp_jid/i.test(h));

  console.log(`📋 Sheet: ${rows.length - 1} prospectos`);
  console.log(`📞 Columna teléfono: [${phoneColIdx}] "${headers[phoneColIdx]}"`);
  console.log(`✅ Columna WA_VALIDO: ${waValidColIdx >= 0 ? `[${waValidColIdx}] "${headers[waValidColIdx]}"` : "nueva (se creará)"}`);

  const prospects = rows.slice(1).map((row, i) => ({
    rowIndex: i + 2,
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
    headers,
    allRows: rows,
  };
}

// ─── Normalizar número a formato WA ────────────────────────────────────────

function normalizeToWA(phone) {
  let clean = phone.replace(/[\s\-\(\)\+]/g, "");

  if (/^52\d{10}$/.test(clean)) return clean;
  if (/^521\d{10}$/.test(clean)) return clean;

  if (/^\d{10}$/.test(clean)) {
    return "52" + clean;
  }

  return null;
}

// ─── Check WA via endpoint interno del bot ─────────────────────────────────

async function checkWAviaBotEndpoint(waNumber) {
  const res = await fetch(`${BOT_BASE_URL}/internal/check-wa`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ numbers: [waNumber] }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bot endpoint error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const result = data.results?.[0];
  if (!result) throw new Error("Bot returned empty results");
  if (result.error) throw new Error(result.error);

  return { exists: result.exists, jid: result.jid ?? null };
}

// ─── Verificar que el bot está activo ─────────────────────────────────────

async function verifyBotHealth() {
  const res = await fetch(`${BOT_BASE_URL}/health`).catch(err => {
    throw new Error(`No se pudo conectar al bot en ${BOT_BASE_URL}: ${err.message}`);
  });
  if (!res.ok) throw new Error(`Bot /health devolvió ${res.status}`);
  console.log("🟢 Bot salones-wa activo");
}

// ─── Delay con jitter ──────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomDelay() {
  return BASE_DELAY_MS + Math.floor(Math.random() * JITTER_MS);
}

// ─── Escribir resultado al sheet ───────────────────────────────────────────

const toColLetter = (idx) => {
  let result = "";
  let n = idx;
  while (n >= 0) {
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26) - 1;
  }
  return result;
};

async function writeResult(sheets, rowIndex, waValidColIdx, waJidColIdx, isValid, jid) {
  const validColLetter = toColLetter(waValidColIdx);
  const jidColLetter = toColLetter(waJidColIdx);

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

async function exportValidProspects(sheets, headers, allRows, waValidColIdx) {
  console.log(`\n📤 Exportando prospectos WA válidos a nuevo sheet...`);

  const validRows = allRows.slice(1).filter(row =>
    (row[waValidColIdx] ?? "").toString().trim().toUpperCase() === "SI"
  );

  console.log(`   Filas válidas encontradas: ${validRows.length}`);

  if (validRows.length === 0) {
    console.log("   ⚠️  No hay prospectos válidos para exportar todavía");
    return;
  }

  const exportData = [headers, ...validRows];
  await sheets.spreadsheets.values.update({
    spreadsheetId: VALID_EXPORT_SHEET_ID,
    range: `${VALID_EXPORT_SHEET_NAME}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: exportData },
  });

  console.log(`   ✅ ${validRows.length} prospectos exportados`);
  console.log(`   📋 https://docs.google.com/spreadsheets/d/${VALID_EXPORT_SHEET_ID}/edit`);
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔍 Validador WA — Gilda.mx Prospects`);
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no escribe al sheet)" : "LIVE"}`);
  if (LIMIT) console.log(`Limit: primeros ${LIMIT} números`);
  if (EXPORT_VALID) console.log(`Export: válidos → Gilda — Prospectos WA Válidos`);
  console.log("");

  // 1. Verificar bot activo
  await verifyBotHealth();

  // 2. Sheets client
  const sheets = await getSheetsClient();

  // 3. Leer prospectos
  let { prospects, phoneColIdx, waValidColIdx, waJidColIdx, totalCols, headers, allRows } =
    await readProspects(sheets);

  // Si no hay columna WA_VALIDO, la creamos
  if (!DRY_RUN && waValidColIdx < 0) {
    const newColIdx = totalCols;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!${toColLetter(newColIdx)}1`,
      valueInputOption: "RAW",
      requestBody: { values: [["WA_VALIDO"]] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!${toColLetter(newColIdx + 1)}1`,
      valueInputOption: "RAW",
      requestBody: { values: [["WA_JID"]] },
    });
    waValidColIdx = newColIdx;
    waJidColIdx = newColIdx + 1;
    totalCols += 2;
    headers.push("WA_VALIDO", "WA_JID");
    console.log(`📝 Columnas WA_VALIDO y WA_JID creadas`);
  }

  // Filtrar los que ya fueron validados
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
    if (EXPORT_VALID && !DRY_RUN) {
      // Re-leer el sheet para tener los datos actualizados
      const fresh = await readProspects(sheets);
      await exportValidProspects(sheets, fresh.headers, fresh.allRows, fresh.waValidColIdx);
    }
    return;
  }

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
      const { exists, jid } = await checkWAviaBotEndpoint(waNum);

      console.log(
        `[${i + 1}/${toProcess.length}] Row ${rowIndex}: ${phone} → ${waNum} → ${exists ? "✅ WA" : "❌ NO WA"}${jid ? ` (${jid})` : ""}`
      );

      if (exists) valid++; else invalid++;

      if (!DRY_RUN) {
        await writeResult(sheets, rowIndex, waValidColIdx, waJidColIdx, exists, jid);
      }
    } catch (err) {
      console.error(`[${i + 1}/${toProcess.length}] ❌ Error Row ${rowIndex} (${phone}): ${err.message}`);
      errors++;
    }

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

  // 6. Exportar válidos al sheet destino
  if (EXPORT_VALID && !DRY_RUN) {
    // Re-leer para tener los datos más frescos incluyendo esta sesión
    const fresh = await readProspects(sheets);
    await exportValidProspects(sheets, fresh.headers, fresh.allRows, fresh.waValidColIdx);
  }

  process.exit(0);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
