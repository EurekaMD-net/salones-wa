/**
 * Admin UI — /admin/*
 * Protected by ADMIN_TOKEN env var (NOT the per-salon token)
 * All state mutations via POST forms (no JS required)
 *
 * SECURITY NOTE: ADMIN_TOKEN is the sole credential for this panel.
 * It travels in URL query strings — treat it like a password.
 * Never share the admin URL publicly. Rotate after any exposure.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type Database from "better-sqlite3";
import { getAdminToken, safeTokenCompare, createRateLimiter } from "./auth.js";
import {
  getAllSalons,
  getSalonById,
  createSalon,
  updateSalon,
  setSalonActive,
  getServices,
  createService,
  updateService,
  deleteService,
  deleteSalon,
  getSalonDataCounts,
  getSlotsForSalon,
  setSlotsForSalon,
  isValidWorkingHour,
  type Salon,
  type Slot,
  type WorkingHourInput,
} from "../db/models.js";

/** Day labels indexed by day_of_week (0=Sunday … 6=Saturday). */
const DAY_NAMES = [
  "Domingo",
  "Lunes",
  "Martes",
  "Miércoles",
  "Jueves",
  "Viernes",
  "Sábado",
];
/** Render order: business week (Mon first), Sunday last. */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** Escape HTML to prevent XSS from DB strings rendered in templates */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Per-IP brute-force protection (in-memory, resets on restart)
const rateLimiter = createRateLimiter();

/** Validate phone: digits only, 10-15 chars (international format) */
function isValidPhone(phone: string): boolean {
  return /^\d{10,15}$/.test(phone);
}

/** Public base URL for owner-facing links (the dueña's panel). Set
 * PUBLIC_APP_URL (e.g. https://app.gilda.mx) in production so the links are
 * actually shareable; falls back to the local bind address for dev. Trailing
 * slashes are stripped so the join below never doubles up. */
function publicBaseUrl(): string {
  const raw = process.env["PUBLIC_APP_URL"]?.trim();
  if (raw) return raw.replace(/\/+$/, "");
  return `http://localhost:${process.env["PORT"] ?? "8085"}`;
}

/** True when PUBLIC_APP_URL is configured — gates the "replace localhost"
 * hint so it only shows in dev (where the URL really is localhost). */
function hasPublicUrl(): boolean {
  return !!process.env["PUBLIC_APP_URL"]?.trim();
}

/** The dueña's panel URL for a salon token, rooted at the public base. */
function panelUrlFor(token: string): string {
  return `${publicBaseUrl()}/panel/dashboard?token=${token}`;
}

/** Check CSRF: Origin or Referer must match the request Host */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function checkCsrf(c: Context<any, any, any>): boolean {
  const host = c.req.header("host");
  if (!host) return false;
  const origin = c.req.header("origin");
  const referer = c.req.header("referer");
  if (origin) {
    try {
      const originHost = new URL(origin).host;
      return originHost === host;
    } catch {
      return false;
    }
  }
  if (referer) {
    try {
      const refererHost = new URL(referer).host;
      return refererHost === host;
    } catch {
      return false;
    }
  }
  return false;
}

// ─── Shared layout helpers ───────────────────────────────────────────────────

const css = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #f0f2f5; color: #1a1a1a; }
  header { background: #1a1a2e; color: white; padding: 16px 24px; display: flex; align-items: center; gap: 12px; }
  header h1 { font-size: 1.1rem; font-weight: 600; }
  header .badge { font-size: 0.7rem; background: #25D366; padding: 2px 8px; border-radius: 12px; }
  .nav { background: white; border-bottom: 1px solid #e0e0e0; padding: 0 24px; display: flex; gap: 4px; }
  .nav a { display: inline-block; padding: 12px 16px; font-size: 0.9rem; color: #555; text-decoration: none; border-bottom: 2px solid transparent; }
  .nav a:hover, .nav a.active { color: #1a1a2e; border-color: #25D366; }
  .container { max-width: 960px; margin: 0 auto; padding: 24px; }
  .card { background: white; border-radius: 10px; box-shadow: 0 1px 4px rgba(0,0,0,.08); margin-bottom: 16px; }
  .card-header { padding: 16px 20px; border-bottom: 1px solid #f0f0f0; display: flex; align-items: center; justify-content: space-between; }
  .card-header h2 { font-size: 1rem; font-weight: 600; }
  .card-body { padding: 20px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 0.8rem; color: #888; font-weight: 600; text-transform: uppercase; letter-spacing: .5px; padding: 8px 12px; border-bottom: 1px solid #eee; }
  td { padding: 12px; font-size: 0.9rem; border-bottom: 1px solid #f5f5f5; vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  .badge-active { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 0.75rem; font-weight: 600; background: #e8f9ef; color: #1a7a4a; }
  .badge-inactive { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 0.75rem; font-weight: 600; background: #f5f5f5; color: #888; }
  .btn { display: inline-block; padding: 8px 16px; border-radius: 6px; border: none; cursor: pointer; font-size: 0.85rem; font-weight: 500; text-decoration: none; }
  .btn-primary { background: #25D366; color: white; }
  .btn-primary:hover { background: #20b857; }
  .btn-secondary { background: #f0f0f0; color: #333; }
  .btn-secondary:hover { background: #e0e0e0; }
  .btn-danger { background: #fee; color: #c0392b; border: 1px solid #fcc; }
  .btn-danger:hover { background: #fdd; }
  .btn-sm { padding: 5px 12px; font-size: 0.8rem; }
  .form-group { margin-bottom: 16px; }
  .form-group label { display: block; font-size: 0.85rem; font-weight: 500; margin-bottom: 6px; color: #444; }
  .form-control { width: 100%; padding: 9px 12px; border: 1px solid #ddd; border-radius: 6px; font-size: 0.9rem; background: white; }
  .form-control:focus { outline: none; border-color: #25D366; box-shadow: 0 0 0 3px rgba(37,211,102,.15); }
  .form-hint { font-size: 0.78rem; color: #999; margin-top: 4px; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .alert { padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 0.9rem; }
  .alert-info { background: #e8f4fd; color: #1a6fa0; border: 1px solid #b8dcf5; }
  .alert-success { background: #e8f9ef; color: #1a7a4a; border: 1px solid #a3e6b9; }
  .panel-url { font-family: monospace; font-size: 0.8rem; background: #f5f5f5; padding: 8px 12px; border-radius: 6px; word-break: break-all; border: 1px solid #e0e0e0; }
  .services-grid { display: grid; gap: 8px; }
  .service-row { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: #f9f9f9; border-radius: 6px; }
  .service-row .svc-name { flex: 1; font-weight: 500; font-size: 0.9rem; }
  .service-row .svc-meta { font-size: 0.8rem; color: #888; }
  .empty { padding: 40px; text-align: center; color: #aaa; }
  hr { border: none; border-top: 1px solid #eee; margin: 20px 0; }
  h3 { font-size: 0.95rem; font-weight: 600; margin-bottom: 12px; color: #333; }
`;

function layout(title: string, body: string, adminToken: string): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} — Admin Salones</title>
  <style>${css}</style>
</head>
<body>
  <header>
    <h1>⚙️ Admin Salones WA</h1>
    <span class="badge">ADMIN</span>
  </header>
  <nav class="nav">
    <a href="/admin?token=${adminToken}" class="active">Salones</a>
  </nav>
  <div class="container">
    ${body}
  </div>
</body>
</html>`;
}

/** Body for the irreversible-delete confirmation screen. Shared by the GET
 * confirm route and the POST handler's typed-name-mismatch re-render, so both
 * present an identical screen (DRY — one source of the warning copy + counts).
 * `error` renders a red banner when the typed name didn't match. */
function deleteConfirmBody(
  salon: Salon,
  counts: {
    services: number;
    slots: number;
    contacts: number;
    appointments: number;
    campaigns: number;
  },
  adminToken: string,
  error?: string,
): string {
  return `
    <div style="margin-bottom:16px">
      <a href="/admin/salones/${salon.id}?token=${adminToken}" class="btn btn-secondary btn-sm">← Cancelar</a>
    </div>
    <div class="card">
      <div class="card-header"><h2 style="color:#c0392b">⚠️ Eliminar “${escapeHtml(salon.name)}”</h2></div>
      <div class="card-body">
        ${error ? `<div class="alert" style="background:#fdecea;color:#c0392b;border:1px solid #f5c6cb">${escapeHtml(error)}</div>` : ""}
        <p style="margin-bottom:12px">Esta acción <strong>elimina permanentemente</strong> el salón y todos sus datos. <strong>No se puede deshacer.</strong> Para solo pausar el bot, usa <em>Desactivar</em>.</p>
        <p style="font-size:0.85rem;color:#444;margin-bottom:6px">Se eliminarán:</p>
        <ul style="margin:0 0 16px 20px;font-size:0.9rem;color:#444;line-height:1.7">
          <li><strong>${counts.appointments}</strong> cita(s)</li>
          <li><strong>${counts.contacts}</strong> contacto(s)</li>
          <li><strong>${counts.services}</strong> servicio(s)</li>
          <li><strong>${counts.campaigns}</strong> campaña(s)</li>
          <li><strong>${counts.slots}</strong> horario(s) personalizado(s)</li>
        </ul>
        <p style="font-size:0.85rem;color:#666;margin-bottom:16px">Su WhatsApp (<strong style="font-family:monospace">${escapeHtml(salon.phone)}</strong>) se desconectará y la sesión se borrará del servidor.</p>
        <form method="POST" action="/admin/salones/${salon.id}/delete?token=${adminToken}">
          <div class="form-group">
            <label>Para confirmar, escribe el nombre del salón: <strong>${escapeHtml(salon.name)}</strong></label>
            <input class="form-control" name="confirm_name" autocomplete="off" placeholder="${escapeHtml(salon.name)}" required />
          </div>
          <button type="submit" class="btn btn-danger">Sí, eliminar permanentemente</button>
          <a href="/admin/salones/${salon.id}?token=${adminToken}" class="btn btn-secondary" style="margin-left:8px">Cancelar</a>
        </form>
      </div>
    </div>`;
}

// ─── Router factory ──────────────────────────────────────────────────────────

/** Options for the admin panel. onSalonDeleted lets the host wire side-effects
 * (e.g. tearing down a deleted salon's live Baileys socket + session) without
 * coupling this HTTP layer to the bot internals. Optional so tests and any
 * web-only host can omit it. */
export interface AdminPanelOptions {
  onSalonDeleted?: (salonId: string) => Promise<void> | void;
}

export function createAdminPanel(
  db: Database.Database,
  opts: AdminPanelOptions = {},
): Hono {
  const app = new Hono();

  // W7: Body size limit on all admin routes (DoS protection)
  app.use("/admin/*", bodyLimit({ maxSize: 32 * 1024 })); // 32 KB

  // Auth guard — all /admin routes
  app.use("/admin/*", async (c, next) => {
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

    if (!rateLimiter.check(ip)) {
      return c.text("Demasiados intentos. Espera 1 minuto.", 429);
    }

    const token = c.req.query("token") ?? "";
    let adminToken: string;
    try {
      adminToken = getAdminToken();
    } catch {
      return c.text(
        "Configuración del servidor incompleta. Contacta al administrador.",
        503,
      );
    }

    if (!safeTokenCompare(token, adminToken)) {
      rateLimiter.recordFailure(ip);
      return c.text(
        "Token de administrador requerido o inválido\n\nUsa: /admin?token=TU_ADMIN_TOKEN",
        401,
      );
    }
    await next();
  });

  // ─── GET /admin — lista de salones ──────────────────────────────────
  app.get("/admin", (c) => {
    const adminToken = c.req.query("token")!;
    const salons = getAllSalons(db);

    const rows = salons
      .map((s) => {
        const created = new Date(s.created_at * 1000).toLocaleDateString(
          "es-MX",
          { timeZone: "America/Mexico_City" },
        );
        const statusBadge = s.active
          ? '<span class="badge-active">Activo</span>'
          : '<span class="badge-inactive">Inactivo</span>';
        return `<tr>
        <td><strong>${escapeHtml(s.name)}</strong></td>
        <td style="font-family:monospace;font-size:0.85rem">${escapeHtml(s.phone)}</td>
        <td>${statusBadge}</td>
        <td>${created}</td>
        <td class="actions">
          <a href="/admin/salones/${s.id}?token=${adminToken}" class="btn btn-secondary btn-sm">Editar</a>
          <form method="POST" action="/admin/salones/${s.id}/toggle?token=${adminToken}" style="display:inline">
            <button type="submit" class="btn btn-sm ${s.active ? "btn-danger" : "btn-primary"}">
              ${s.active ? "Desactivar" : "Activar"}
            </button>
          </form>
        </td>
      </tr>`;
      })
      .join("");

    const deletedBanner =
      c.req.query("deleted") === "1"
        ? '<div class="alert alert-success">Salón eliminado permanentemente.</div>'
        : "";

    const body = `
      ${deletedBanner}
      <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;padding:0">
        <h2 style="font-size:1.1rem">Salones registrados (${salons.length})</h2>
        <a href="/admin/salones/new?token=${adminToken}" class="btn btn-primary">+ Nuevo salón</a>
      </div>
      <div class="card">
        <div class="card-body" style="padding:0">
          ${
            salons.length === 0
              ? '<div class="empty">No hay salones registrados aún.<br><a href="/admin/salones/new?token=' +
                adminToken +
                '">Crea el primero →</a></div>'
              : `<table>
                <thead><tr><th>Nombre</th><th>WhatsApp del salón</th><th>Estado</th><th>Alta</th><th>Acciones</th></tr></thead>
                <tbody>${rows}</tbody>
               </table>`
          }
        </div>
      </div>`;

    return c.html(layout("Salones", body, adminToken));
  });

  // ─── GET /admin/salones/new — formulario crear ────────────────────────
  app.get("/admin/salones/new", (c) => {
    const adminToken = c.req.query("token")!;

    const body = `
      <div style="margin-bottom:16px">
        <a href="/admin?token=${adminToken}" class="btn btn-secondary btn-sm">← Volver</a>
      </div>
      <div class="card">
        <div class="card-header"><h2>Nuevo salón</h2></div>
        <div class="card-body">
          <form method="POST" action="/admin/salones?token=${adminToken}">
            <div class="form-group">
              <label>Nombre del salón *</label>
              <input class="form-control" name="name" required placeholder="Ej: Salón Rosita" />
            </div>
            <div class="form-group">
              <label>WhatsApp del salón * <small style="font-weight:normal;color:#666">(la línea que ya usan las clientas)</small></label>
              <input class="form-control" name="phone" required placeholder="525555555555" />
              <div class="form-hint">El número de WhatsApp que la dueña ya tiene activo y que sus clientas conocen. La dueña lo va a "vincular" como dispositivo desde su teléfono — Baileys se conecta ahí, no es un número aparte. Solo dígitos sin +. Ejemplo MX celular: 525555555555 (12 dígitos).</div>
            </div>
            <div class="form-group">
              <label>WhatsApp personal de la dueña <small style="font-weight:normal;color:#666">(opcional, para avisos de servicio)</small></label>
              <input class="form-control" name="owner_phone" placeholder="525555555555" />
              <div class="form-hint">Número PERSONAL de la dueña, distinto al del salón. Aquí le mandamos avisos operativos (sesión desconectada, resumen del día, etc.). Nunca recibe mensajes de clientas. Déjalo vacío si la dueña no quiere notificaciones personales.</div>
            </div>
            <hr>
            <h3>Servicios iniciales</h3>
            <div class="alert alert-info">Agrega los servicios que ofrece el salón. Puedes agregar más después.</div>
            <div id="services">
              <div class="service-row" style="background:white;border:1px solid #e0e0e0;margin-bottom:8px">
                <input class="form-control" name="svc_name[]" placeholder="Nombre (ej: Corte)" style="flex:2" />
                <input class="form-control" name="svc_dur[]" type="number" placeholder="Minutos" style="flex:1" value="30" min="5" />
                <input class="form-control" name="svc_price[]" type="number" placeholder="Precio $" style="flex:1" />
              </div>
              <div class="service-row" style="background:white;border:1px solid #e0e0e0;margin-bottom:8px">
                <input class="form-control" name="svc_name[]" placeholder="Nombre (ej: Tinte)" style="flex:2" />
                <input class="form-control" name="svc_dur[]" type="number" placeholder="Minutos" style="flex:1" value="90" min="5" />
                <input class="form-control" name="svc_price[]" type="number" placeholder="Precio $" style="flex:1" />
              </div>
              <div class="service-row" style="background:white;border:1px solid #e0e0e0;margin-bottom:8px">
                <input class="form-control" name="svc_name[]" placeholder="Nombre (ej: Peinado)" style="flex:2" />
                <input class="form-control" name="svc_dur[]" type="number" placeholder="Minutos" style="flex:1" value="45" min="5" />
                <input class="form-control" name="svc_price[]" type="number" placeholder="Precio $" style="flex:1" />
              </div>
            </div>
            <div style="margin-top:16px;display:flex;gap:8px">
              <button type="submit" class="btn btn-primary">Crear salón</button>
              <a href="/admin?token=${adminToken}" class="btn btn-secondary">Cancelar</a>
            </div>
          </form>
        </div>
      </div>`;

    return c.html(layout("Nuevo salón", body, adminToken));
  });

  // ─── POST /admin/salones — crear ─────────────────────────────────────
  app.post("/admin/salones", async (c) => {
    if (!checkCsrf(c)) return c.text("Solicitud inválida", 403);
    const adminToken = c.req.query("token")!;
    const form = await c.req.formData();

    const name = (form.get("name") as string | null)?.trim() ?? "";
    const phone = (form.get("phone") as string | null)?.trim() ?? "";
    const ownerPhoneRaw =
      (form.get("owner_phone") as string | null)?.trim() ?? "";
    // Empty string → null at the boundary so it doesn't violate the
    // "undefined leaves untouched / null clears" contract in updateSalon.
    const owner_phone = ownerPhoneRaw === "" ? null : ownerPhoneRaw;

    if (!name || !phone) {
      return c.html(
        layout(
          "Error",
          '<div class="alert" style="background:#fee;border:1px solid #fcc;color:#c0392b">Nombre y teléfono son requeridos.</div><a href="/admin/salones/new?token=' +
            adminToken +
            '" class="btn btn-secondary">← Volver</a>',
          adminToken,
        ),
        400,
      );
    }

    if (!isValidPhone(phone)) {
      return c.html(
        layout(
          "Error",
          '<div class="alert" style="background:#fee;border:1px solid #fcc;color:#c0392b">Teléfono del salón inválido. Usa solo dígitos, formato 52XXXXXXXXXX (10-15 dígitos).</div><a href="/admin/salones/new?token=' +
            adminToken +
            '" class="btn btn-secondary">← Volver</a>',
          adminToken,
        ),
        400,
      );
    }

    if (owner_phone !== null && !isValidPhone(owner_phone)) {
      return c.html(
        layout(
          "Error",
          '<div class="alert" style="background:#fee;border:1px solid #fcc;color:#c0392b">WhatsApp de la dueña inválido. Solo dígitos, 10-15 caracteres. Déjalo vacío si no aplica.</div><a href="/admin/salones/new?token=' +
            adminToken +
            '" class="btn btn-secondary">← Volver</a>',
          adminToken,
        ),
        400,
      );
    }

    if (owner_phone !== null && owner_phone === phone) {
      return c.html(
        layout(
          "Error",
          '<div class="alert" style="background:#fee;border:1px solid #fcc;color:#c0392b">El WhatsApp personal de la dueña debe ser DIFERENTE al del salón. Si son el mismo número, déjalo vacío.</div><a href="/admin/salones/new?token=' +
            adminToken +
            '" class="btn btn-secondary">← Volver</a>',
          adminToken,
        ),
        400,
      );
    }
    // TODO(audit-W3, follow-up): when the owner-notification sender lands,
    // also check that owner_phone doesn't collide with ANOTHER salon's
    // `phone` (a Baileys-bound client line) via getSalonByPhone(owner_phone).
    // Sending to that JID would land in a clientas inbox. Cross-salon owner
    // sharing is otherwise allowed (one dueña, multiple salones).

    const salon = createSalon(db, { name, phone, owner_phone });

    // Create services (array fields)
    const svcNames = form.getAll("svc_name[]") as string[];
    const svcDurs = form.getAll("svc_dur[]") as string[];
    const svcPrices = form.getAll("svc_price[]") as string[];

    for (let i = 0; i < svcNames.length; i++) {
      const svcName = svcNames[i]?.trim();
      if (!svcName) continue;
      const dur = parseInt(svcDurs[i] ?? "30", 10) || 30;
      const price = parseFloat(svcPrices[i] ?? "") || undefined;
      createService(db, {
        salon_id: salon.id,
        name: svcName,
        duration_min: dur,
        price,
      });
    }

    const panelUrl = panelUrlFor(salon.token);
    const body = `
      <div class="alert alert-success">✅ Salón <strong>${escapeHtml(salon.name)}</strong> creado exitosamente.</div>
      <div class="card">
        <div class="card-header"><h2>URL del panel para la dueña</h2></div>
        <div class="card-body">
          <p style="margin-bottom:12px;font-size:0.9rem;color:#555">Comparte esta URL con la dueña del salón. Es su acceso al panel de citas:</p>
          <div class="panel-url">${escapeHtml(panelUrl)}</div>
          ${hasPublicUrl() ? "" : '<p style="margin-top:8px;font-size:0.8rem;color:#999">⚠️ Cambia <code>localhost</code> por la IP o dominio del servidor antes de compartir.</p>'}
          <div style="margin-top:16px;display:flex;gap:8px">
            <a href="/admin/salones/${salon.id}?token=${adminToken}" class="btn btn-secondary">Editar servicios</a>
            <a href="/admin?token=${adminToken}" class="btn btn-primary">← Volver a lista</a>
          </div>
        </div>
      </div>`;

    return c.html(layout("Salón creado", body, adminToken));
  });

  // ─── GET /admin/salones/:id — detalle/edición ─────────────────────────
  app.get("/admin/salones/:id", (c) => {
    const adminToken = c.req.query("token")!;
    const salon = getSalonById(db, c.req.param("id"));
    if (!salon) return c.text("Salón no encontrado", 404);

    const services = getServices(db, salon.id);
    const panelUrl = panelUrlFor(salon.token);

    const serviceRows = services
      .map(
        (s) => `
      <div class="service-row">
        <span class="svc-name">${escapeHtml(s.name)}</span>
        <span class="svc-meta">${s.duration_min} min · ${s.price != null ? "$" + s.price : "Sin precio"}</span>
        <form method="POST" action="/admin/salones/${salon.id}/services/${s.id}/delete?token=${adminToken}" style="display:inline">
          <button type="submit" class="btn btn-danger btn-sm">Desactivar servicio</button>
        </form>
      </div>`,
      )
      .join("");

    // Working hours: one editable window per weekday. If the salon has 0
    // configured rows, the bot uses the default Mon–Sat 9–19 (slot-finder
    // fallback), so the form pre-fills with that default but leaves every day
    // UNchecked — saving with nothing checked keeps the default.
    const slots = getSlotsForSalon(db, salon.id);
    const slotByDay = new Map<number, Slot>();
    for (const s of slots) {
      if (!slotByDay.has(s.day_of_week)) slotByDay.set(s.day_of_week, s);
    }
    const hoursRows = DAY_ORDER.map((d) => {
      const slot = slotByDay.get(d);
      const open = slot != null;
      const start = slot?.start_time ?? "09:00";
      const end = slot?.end_time ?? "19:00";
      return `<div style="display:flex;align-items:center;gap:10px">
          <label style="display:flex;align-items:center;gap:6px;width:120px;margin:0;font-weight:500">
            <input type="checkbox" name="open_${d}" value="1" ${open ? "checked" : ""} />
            ${DAY_NAMES[d]}
          </label>
          <input class="form-control" type="time" name="start_${d}" value="${start}" style="width:auto" />
          <span style="color:#888">a</span>
          <input class="form-control" type="time" name="end_${d}" value="${end}" style="width:auto" />
        </div>`;
    }).join("");

    const body = `
      <div style="margin-bottom:16px">
        <a href="/admin?token=${adminToken}" class="btn btn-secondary btn-sm">← Volver a lista</a>
      </div>

      <!-- Datos del salón -->
      <div class="card" style="margin-bottom:16px">
        <div class="card-header">
          <h2>${escapeHtml(salon.name)}</h2>
          <span class="${salon.active ? "badge-active" : "badge-inactive"}">${salon.active ? "Activo" : "Inactivo"}</span>
        </div>
        <div class="card-body">
          <form method="POST" action="/admin/salones/${salon.id}/edit?token=${adminToken}">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
              <div class="form-group">
                <label>Nombre del salón</label>
                <input class="form-control" name="name" value="${escapeHtml(salon.name)}" required />
              </div>
              <div class="form-group">
                <label>WhatsApp del salón <small style="font-weight:normal;color:#666">(la línea de las clientas, solo dígitos sin +)</small></label>
                <input class="form-control" name="phone" value="${escapeHtml(salon.phone)}" required pattern="[0-9]{10,15}" title="Solo dígitos, 10-15 caracteres" />
              </div>
            </div>
            <div class="form-group">
              <label>WhatsApp personal de la dueña <small style="font-weight:normal;color:#666">(opcional, para avisos de servicio)</small></label>
              <input class="form-control" name="owner_phone" value="${escapeHtml(salon.owner_phone ?? "")}" pattern="[0-9]{10,15}" title="Solo dígitos, 10-15 caracteres" placeholder="Déjalo vacío si la dueña no quiere notificaciones personales" />
              <div class="form-hint">Distinto al WhatsApp del salón. Solo recibe avisos operativos (sesión desconectada, resumen del día). Nunca mensajes de clientas.</div>
            </div>
            <button type="submit" class="btn btn-primary">Guardar cambios</button>
          </form>
        </div>
      </div>

      <!-- URL del panel -->
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><h2>URL del panel (dueña)</h2></div>
        <div class="card-body">
          <div class="panel-url">${escapeHtml(panelUrl)}</div>
          ${hasPublicUrl() ? "" : '<p style="margin-top:8px;font-size:0.8rem;color:#999">Reemplaza <code>localhost</code> por la IP o dominio del servidor.</p>'}
        </div>
      </div>

      <!-- Servicios -->
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><h2>Servicios (${services.length})</h2></div>
        <div class="card-body">
          <div class="services-grid" style="margin-bottom:16px">
            ${services.length === 0 ? '<div class="empty">Sin servicios. Agrega uno:</div>' : serviceRows}
          </div>
          <hr>
          <h3>Agregar servicio</h3>
          <form method="POST" action="/admin/salones/${salon.id}/services?token=${adminToken}">
            <div style="display:flex;gap:8px;align-items:flex-end">
              <div class="form-group" style="flex:2;margin:0">
                <label>Nombre</label>
                <input class="form-control" name="name" placeholder="Ej: Mechas" required />
              </div>
              <div class="form-group" style="flex:1;margin:0">
                <label>Duración (min)</label>
                <input class="form-control" name="duration_min" type="number" value="60" min="5" required />
              </div>
              <div class="form-group" style="flex:1;margin:0">
                <label>Precio ($)</label>
                <input class="form-control" name="price" type="number" placeholder="Opcional" />
              </div>
              <button type="submit" class="btn btn-primary" style="height:38px">Agregar</button>
            </div>
          </form>
        </div>
      </div>

      <!-- Horario de atención -->
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><h2>Horario de atención</h2></div>
        <div class="card-body">
          ${
            slots.length === 0
              ? '<div class="alert alert-info">Usando el horario por defecto: <strong>Lunes a Sábado, 9:00–19:00</strong>. Marca los días y ajusta las horas para personalizar. Si no marcas ningún día, se mantiene el horario por defecto.</div>'
              : ""
          }
          <form method="POST" action="/admin/salones/${salon.id}/hours?token=${adminToken}">
            <div style="display:grid;gap:8px;max-width:440px">
              ${hoursRows}
            </div>
            <div style="margin-top:16px"><button type="submit" class="btn btn-primary">Guardar horario</button></div>
            <p class="form-hint" style="margin-top:8px">Los días sin marcar se consideran cerrados. Un turno continuo por día. El bot solo ofrece citas dentro de estas horas.</p>
          </form>
        </div>
      </div>

      <!-- Vinculación de WhatsApp -->
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><h2>Vincular WhatsApp</h2></div>
        <div class="card-body">
          <p style="font-size:0.9rem;color:#555;margin-bottom:10px">
            Desde el teléfono con el número del salón
            (<strong style="font-family:monospace">${escapeHtml(salon.phone)}</strong>):
            WhatsApp → ⋮ → <em>Dispositivos vinculados</em> → <em>Vincular un dispositivo</em>
            → <em>Vincular con número de teléfono</em>, y escribe el código de 8 dígitos
            que aparece en <code>journalctl -u salones-wa</code> al reiniciar el servicio.
          </p>
          <div class="alert alert-info" style="margin:0">
            ⏳ <strong>Si la vinculación falla varias veces seguidas, espera ~24 h antes
            de reintentar.</strong> Pedir códigos repetidamente hace que WhatsApp marque la
            IP del servidor como sospechosa y rechace cada código nuevo; una pausa de un día
            casi siempre la libera. Cada código vive ~50 s — vincula apenas aparezca.
          </div>
        </div>
      </div>

      <!-- Zona de peligro -->
      <div class="card">
        <div class="card-header"><h2>Acciones</h2></div>
        <div class="card-body">
          <form method="POST" action="/admin/salones/${salon.id}/toggle?token=${adminToken}">
            <button type="submit" class="btn ${salon.active ? "btn-danger" : "btn-primary"}">
              ${salon.active ? "⏸ Desactivar salón" : "▶ Activar salón"}
            </button>
          </form>
          <p style="margin-top:8px;font-size:0.8rem;color:#999">
            ${salon.active ? "Desactivar detiene el bot WA para este salón (reversible)." : "Activar permite al bot responder mensajes de este salón."}
          </p>

          <hr>

          <h3 style="color:#c0392b">Eliminar salón</h3>
          <p style="margin:4px 0 12px;font-size:0.85rem;color:#666">
            Borra el salón y <strong>todos</strong> sus datos (citas, contactos,
            servicios, campañas) de forma permanente, y desconecta su WhatsApp.
            <strong>No se puede deshacer.</strong> Si solo quieres pausar el bot,
            usa <em>Desactivar</em>.
          </p>
          <a href="/admin/salones/${salon.id}/delete?token=${adminToken}" class="btn btn-danger">
            🗑 Eliminar permanentemente…
          </a>
        </div>
      </div>`;

    return c.html(layout(salon.name, body, adminToken));
  });

  // ─── POST /admin/salones/:id/edit — guardar edición ──────────────────
  app.post("/admin/salones/:id/edit", async (c) => {
    if (!checkCsrf(c)) return c.text("Solicitud inválida", 403);
    const adminToken = c.req.query("token")!;
    const salon = getSalonById(db, c.req.param("id"));
    if (!salon) return c.text("Salón no encontrado", 404);

    const form = await c.req.formData();
    const name = (form.get("name") as string | null)?.trim();
    const phone = (form.get("phone") as string | null)?.trim();
    // owner_phone is intentionally tri-state on edit:
    //   missing field        -> undefined (leave untouched)
    //   present + empty      -> null (CLEAR the existing value)
    //   present + non-empty  -> validate + set
    const ownerPhoneField = form.get("owner_phone");
    let owner_phone: string | null | undefined = undefined;
    if (ownerPhoneField !== null) {
      const trimmed = (ownerPhoneField as string).trim();
      owner_phone = trimmed === "" ? null : trimmed;
    }

    if (phone && !isValidPhone(phone)) {
      return c.text(
        "Teléfono del salón inválido. Solo dígitos, 10-15 caracteres.",
        400,
      );
    }
    if (
      typeof owner_phone === "string" &&
      owner_phone !== "" &&
      !isValidPhone(owner_phone)
    ) {
      return c.text(
        "WhatsApp de la dueña inválido. Solo dígitos, 10-15 caracteres, o déjalo vacío.",
        400,
      );
    }
    // The DB has a UNIQUE constraint on `phone` but NOT on `owner_phone`
    // (multiple salons could plausibly share an owner). We only block the
    // same-as-salon collision because it would defeat the purpose of the
    // separate notification channel.
    const effectivePhone = phone ?? salon.phone;
    if (typeof owner_phone === "string" && owner_phone === effectivePhone) {
      return c.text(
        "El WhatsApp de la dueña debe ser distinto al del salón. Si son el mismo número, déjalo vacío.",
        400,
      );
    }

    updateSalon(db, salon.id, {
      ...(name ? { name } : {}),
      ...(phone ? { phone } : {}),
      ...(owner_phone !== undefined ? { owner_phone } : {}),
    });

    return c.redirect(`/admin/salones/${salon.id}?token=${adminToken}&saved=1`);
  });

  // ─── POST /admin/salones/:id/toggle — activar/desactivar ─────────────
  app.post("/admin/salones/:id/toggle", (c) => {
    if (!checkCsrf(c)) return c.text("Solicitud inválida", 403);
    const adminToken = c.req.query("token")!;
    const salon = getSalonById(db, c.req.param("id"));
    if (!salon) return c.text("Salón no encontrado", 404);

    setSalonActive(db, salon.id, !salon.active);
    return c.redirect(`/admin?token=${adminToken}`);
  });

  // ─── POST /admin/salones/:id/hours — guardar horario de atención ─────
  app.post("/admin/salones/:id/hours", async (c) => {
    if (!checkCsrf(c)) return c.text("Solicitud inválida", 403);
    const adminToken = c.req.query("token")!;
    const salon = getSalonById(db, c.req.param("id"));
    if (!salon) return c.text("Salón no encontrado", 404);

    const form = await c.req.formData();
    const hours: WorkingHourInput[] = [];
    for (const d of DAY_ORDER) {
      // Day not marked "abierto" → closed → no row.
      if (form.get(`open_${d}`) == null) continue;
      const start = (form.get(`start_${d}`) as string | null)?.trim() ?? "";
      const end = (form.get(`end_${d}`) as string | null)?.trim() ?? "";
      const window: WorkingHourInput = {
        day_of_week: d,
        start_time: start,
        end_time: end,
      };
      if (!isValidWorkingHour(window)) {
        return c.text(
          `Horario inválido para ${DAY_NAMES[d]}: usa HH:MM con la hora de apertura antes de la de cierre.`,
          400,
        );
      }
      hours.push(window);
    }

    // Replace-all (empty array clears → salon reverts to default hours).
    setSlotsForSalon(db, salon.id, hours);
    return c.redirect(`/admin/salones/${salon.id}?token=${adminToken}&saved=1`);
  });

  // ─── POST /admin/salones/:id/services — agregar servicio ─────────────
  app.post("/admin/salones/:id/services", async (c) => {
    if (!checkCsrf(c)) return c.text("Solicitud inválida", 403);
    const adminToken = c.req.query("token")!;
    const salon = getSalonById(db, c.req.param("id"));
    if (!salon) return c.text("Salón no encontrado", 404);

    const form = await c.req.formData();
    const name = (form.get("name") as string | null)?.trim() ?? "";
    const duration_min =
      parseInt((form.get("duration_min") as string) ?? "30", 10) || 30;
    const priceRaw = form.get("price") as string | null;
    const price = priceRaw ? parseFloat(priceRaw) || undefined : undefined;

    if (name) {
      createService(db, { salon_id: salon.id, name, duration_min, price });
    }

    return c.redirect(`/admin/salones/${salon.id}?token=${adminToken}`);
  });

  // ─── POST /admin/salones/:id/services/:svcId/delete ──────────────────
  app.post("/admin/salones/:id/services/:svcId/delete", (c) => {
    if (!checkCsrf(c)) return c.text("Solicitud inválida", 403);
    const adminToken = c.req.query("token")!;
    const salon = getSalonById(db, c.req.param("id"));
    if (!salon) return c.text("Salón no encontrado", 404);

    // W10: enforce salon scoping — only delete services belonging to this salon
    deleteService(db, c.req.param("svcId"), salon.id);
    return c.redirect(`/admin/salones/${salon.id}?token=${adminToken}`);
  });

  // ─── GET /admin/salones/:id/delete — pantalla de confirmación ────────
  app.get("/admin/salones/:id/delete", (c) => {
    const adminToken = c.req.query("token")!;
    const salon = getSalonById(db, c.req.param("id"));
    if (!salon) return c.text("Salón no encontrado", 404);

    const counts = getSalonDataCounts(db, salon.id);
    return c.html(
      layout(
        `Eliminar ${salon.name}`,
        deleteConfirmBody(salon, counts, adminToken),
        adminToken,
      ),
    );
  });

  // ─── POST /admin/salones/:id/delete — eliminar permanentemente ───────
  app.post("/admin/salones/:id/delete", async (c) => {
    if (!checkCsrf(c)) return c.text("Solicitud inválida", 403);
    const adminToken = c.req.query("token")!;
    const salon = getSalonById(db, c.req.param("id"));
    if (!salon) return c.text("Salón no encontrado", 404);

    const form = await c.req.formData();
    const confirmName = (
      (form.get("confirm_name") as string | null) ?? ""
    ).trim();

    // Typed-name poka-yoke: require the exact salon name before an irreversible
    // delete. Blocks an accidental wipe from a misclick or a stale/confused tab.
    // On mismatch, re-render the SAME confirm screen with an error (no delete).
    if (confirmName !== salon.name) {
      const counts = getSalonDataCounts(db, salon.id);
      return c.html(
        layout(
          `Eliminar ${salon.name}`,
          deleteConfirmBody(
            salon,
            counts,
            adminToken,
            "El nombre no coincide. Escríbelo exactamente como aparece para confirmar.",
          ),
          adminToken,
        ),
        400,
      );
    }

    // Tear down the live Baileys socket + on-disk session FIRST so the bot stops
    // answering and the WA device is released — but best-effort: a logout that
    // fails must NOT block removing the row, so swallow and proceed. The DB
    // delete cascades to every child table (services/slots/contacts/
    // appointments/campaigns) via ON DELETE CASCADE.
    try {
      await opts.onSalonDeleted?.(salon.id);
    } catch (err) {
      console.error(
        `[admin] onSalonDeleted failed for salon ${salon.id} (continuing with DB delete):`,
        err,
      );
    }
    deleteSalon(db, salon.id);
    return c.redirect(`/admin?token=${adminToken}&deleted=1`);
  });

  return app;
}
