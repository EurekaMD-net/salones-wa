/**
 * Hono web panel — puerto 8085 (already open in UFW)
 * Auth: ?token=<uuid> per salon
 * Designed for mobile browsers (3G-friendly, vanilla HTML, no JS framework)
 */

import { Hono } from "hono";
import type Database from "better-sqlite3";
import {
  getSalonByToken,
  getCampaignStats,
  getAppointmentsForSalonBetween,
  getNextConfirmedAppointmentForSalon,
  getAppointmentById,
  cancelAppointment,
  markNoShow,
  type DashboardAppointment,
} from "../db/models.js";

const MX_TZ = "America/Mexico_City";

/** Escape HTML so DB strings can't break out of attribute / text contexts. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Same-Origin / same-Referer CSRF guard used by the admin panel. The panel
 * shares the host with admin so this works identically. */
import type { Context } from "hono";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function checkPanelCsrf(c: Context<any, any, any>): boolean {
  const host = c.req.header("host");
  if (!host) return false;
  const origin = c.req.header("origin");
  const referer = c.req.header("referer");
  if (origin) {
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  if (referer) {
    try {
      return new URL(referer).host === host;
    } catch {
      return false;
    }
  }
  return false;
}

/** Compute the unix seconds that bound today and tomorrow in MX time. The
 * cron jobs ALL anchor on MX time, so the dueña's "today" must match what
 * the bot calls "today" — otherwise a 23:30 booking shows up in different
 * places depending on whose clock is asked. We use Intl.DateTimeFormat to
 * extract MX-local Y/M/D and then build a UTC timestamp at MX-local 00:00. */
function mxDayBounds(now: Date = new Date()): {
  todayStart: number;
  tomorrowStart: number;
  dayAfterStart: number;
  weekEndStart: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: MX_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === "year")!.value);
  const m = Number(parts.find((p) => p.type === "month")!.value);
  const d = Number(parts.find((p) => p.type === "day")!.value);
  // MX is fixed UTC-6 (no DST since the 2022 abolition). 00:00 MX = 06:00
  // UTC. Known exception: Baja California (America/Tijuana) still observes
  // US DST — if a salon ever runs there, this hardcode breaks. Out of scope
  // for v1 since all current salons are in central MX.
  const todayStartMs = Date.UTC(y, m - 1, d, 6, 0, 0);
  const todayStart = Math.floor(todayStartMs / 1000);
  // weekEndStart = start of day +8 → "Próximas" covers a rolling 6 days
  // beyond tomorrow (days +2..+7). Not a calendar week — it slides daily.
  return {
    todayStart,
    tomorrowStart: todayStart + 86_400,
    dayAfterStart: todayStart + 86_400 * 2,
    weekEndStart: todayStart + 86_400 * 8,
  };
}

/** Short weekday + day for citas 2+ days out. es-MX returns the literal
 * "vie 29 de may" — under the panel's text-transform: capitalize CSS this
 * renders as "Vie 29 De May", and the capitalised "De" looks wrong. We
 * strip the infix " de " here so it renders as "Vie 29 May". */
function fmtWeekdayMx(unixSecs: number): string {
  return new Date(unixSecs * 1000)
    .toLocaleDateString("es-MX", {
      timeZone: MX_TZ,
      weekday: "short",
      day: "numeric",
      month: "short",
    })
    .replace(/\s+de\s+/g, " ");
}

function fmtTimeMx(unixSecs: number): string {
  return new Date(unixSecs * 1000).toLocaleTimeString("es-MX", {
    timeZone: MX_TZ,
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusBadge(status: DashboardAppointment["status"]): string {
  if (status === "cancelled")
    return '<span class="badge badge-cancelled">cancelada</span>';
  if (status === "no_show")
    return '<span class="badge badge-noshow">no vino</span>';
  return "";
}

function renderApptRow(
  a: DashboardAppointment,
  token: string,
  showActions: boolean,
  withDate = false,
): string {
  const name = a.contact_name ?? a.contact_phone;
  const phoneDigits = a.contact_phone.replace(/[^0-9]/g, "");
  const time = fmtTimeMx(a.starts_at);
  const isActionable = a.status === "confirmed" && showActions;
  const actions = isActionable
    ? `<td class="actions">
        <form method="POST" action="/panel/appointments/${esc(a.id)}/cancel?token=${esc(token)}" onsubmit="return confirm('¿Cancelar la cita de ${esc(name)}?')">
          <button type="submit" class="btn-tiny btn-cancel">Cancelar</button>
        </form>
        <form method="POST" action="/panel/appointments/${esc(a.id)}/no-show?token=${esc(token)}" onsubmit="return confirm('¿Marcar que ${esc(name)} no vino?')">
          <button type="submit" class="btn-tiny btn-noshow">No vino</button>
        </form>
      </td>`
    : "<td></td>";
  const dateCell = withDate
    ? `<td class="date-cell">${esc(fmtWeekdayMx(a.starts_at))}</td>`
    : "";
  return `<tr class="status-${a.status}">
    ${dateCell}<td class="time">${time}</td>
    <td class="who">
      <div class="name">${esc(name)} ${statusBadge(a.status)}</div>
      <a href="tel:+${esc(phoneDigits)}" class="phone">📞 ${esc(a.contact_phone)}</a>
    </td>
    <td class="svc">${esc(a.service_name ?? "—")}</td>
    ${actions}
  </tr>`;
}

export function createWebPanel(db: Database.Database): Hono {
  const app = new Hono();

  // ─── Security headers (C2 audit fold) ────────────────────────────────
  // The panel's auth credential is the token in the URL. Without these,
  // a malicious site could (a) iframe the panel and show its contents to
  // the attacker via overlay tricks, and (b) read the token from the
  // Referer if the dueña ever clicks an http(s) link from inside the
  // panel. DENY iframe embedding outright + strip Referer outbound.
  app.use("/panel/*", async (c, next) => {
    await next();
    c.header("X-Frame-Options", "DENY");
    c.header("Content-Security-Policy", "frame-ancestors 'none'");
    c.header("Referrer-Policy", "no-referrer");
  });

  // ─── Auth middleware ────────────────────────────────────────────────
  app.use("/panel/*", async (c, next) => {
    const token = c.req.query("token");
    if (!token) return c.text("Token requerido", 401);

    const salon = getSalonByToken(db, token);
    if (!salon) return c.text("Token inválido", 401);

    c.set("salon" as never, salon);
    await next();
  });

  // ─── Health check ───────────────────────────────────────────────────
  app.get("/health", (c) =>
    c.json({ ok: true, service: "salones-wa", ts: new Date().toISOString() }),
  );

  // ─── Dashboard ──────────────────────────────────────────────────────
  app.get("/panel/dashboard", (c) => {
    const salon = c.get("salon" as never) as { id: string; name: string };
    const token = c.req.query("token")!;
    const nowSecs = Math.floor(Date.now() / 1000);

    const { todayStart, tomorrowStart, dayAfterStart, weekEndStart } =
      mxDayBounds();
    const todayAppts = getAppointmentsForSalonBetween(
      db,
      salon.id,
      todayStart,
      tomorrowStart,
    );
    const tomorrowAppts = getAppointmentsForSalonBetween(
      db,
      salon.id,
      tomorrowStart,
      dayAfterStart,
    );
    const upcomingAppts = getAppointmentsForSalonBetween(
      db,
      salon.id,
      dayAfterStart,
      weekEndStart,
    );

    // Próxima cita = next confirmed cita, UNBOUNDED forward. The previous
    // implementation searched only today + tomorrow, which hid any cita
    // booked 2+ days out — including ones the dueña had just confirmed
    // through WhatsApp. The banner now answers "what's my next cita?"
    // honestly, no matter how far out it is.
    const next = getNextConfirmedAppointmentForSalon(db, salon.id, nowSecs);

    const todayConfirmed = todayAppts.filter(
      (a) => a.status === "confirmed",
    ).length;
    const stats = getCampaignStats(db, salon.id);
    const contactsTotal = db
      .prepare("SELECT COUNT(*) as n FROM contacts WHERE salon_id = ?")
      .get(salon.id) as { n: number };
    const dormantTotal = db
      .prepare(
        "SELECT COUNT(*) as n FROM contacts WHERE salon_id = ? AND dormant = 1",
      )
      .get(salon.id) as { n: number };

    const nextBanner = next
      ? (() => {
          const name = next.contact_name ?? next.contact_phone;
          const phoneDigits = next.contact_phone.replace(/[^0-9]/g, "");
          // Three-way label: Hoy / Mañana / weekday-date. Anything ≥ +2 days
          // out gets a weekday label so the dueña sees "Vie 29 may" instead
          // of being told it's "Mañana" when it's really four days away.
          let whenLabel: string;
          if (next.starts_at < tomorrowStart) whenLabel = "Hoy";
          else if (next.starts_at < dayAfterStart) whenLabel = "Mañana";
          else whenLabel = fmtWeekdayMx(next.starts_at);
          const time = fmtTimeMx(next.starts_at);
          return `<div class="next-banner">
            <div class="next-label">Próxima cita</div>
            <div class="next-main">
              <span class="next-when">${esc(whenLabel)} · ${time}</span>
              <span class="next-name">${esc(name)}</span>
            </div>
            <div class="next-sub">
              <span>${esc(next.service_name ?? "—")}</span>
              <a href="tel:+${esc(phoneDigits)}" class="phone">📞 ${esc(next.contact_phone)}</a>
            </div>
          </div>`;
        })()
      : `<div class="next-banner next-banner-empty">No tienes citas pendientes</div>`;

    const todayRows = todayAppts
      .map((a) => renderApptRow(a, token, true))
      .join("");
    const tomorrowRows = tomorrowAppts
      .map((a) => renderApptRow(a, token, true))
      .join("");
    const upcomingRows = upcomingAppts
      .map((a) => renderApptRow(a, token, true, true))
      .join("");
    const todaySection =
      todayAppts.length === 0
        ? '<div class="empty">No hay citas hoy</div>'
        : `<table><thead><tr><th>Hora</th><th>Clienta</th><th>Servicio</th><th></th></tr></thead><tbody>${todayRows}</tbody></table>`;
    const tomorrowSection =
      tomorrowAppts.length === 0
        ? '<div class="empty">Sin citas mañana</div>'
        : `<table><thead><tr><th>Hora</th><th>Clienta</th><th>Servicio</th><th></th></tr></thead><tbody>${tomorrowRows}</tbody></table>`;
    const upcomingSection =
      upcomingAppts.length === 0
        ? '<div class="empty">Sin citas en los próximos días</div>'
        : `<table><thead><tr><th>Día</th><th>Hora</th><th>Clienta</th><th>Servicio</th><th></th></tr></thead><tbody>${upcomingRows}</tbody></table>`;

    const todayLabel = new Date(todayStart * 1000).toLocaleDateString("es-MX", {
      timeZone: MX_TZ,
      weekday: "long",
      day: "numeric",
      month: "long",
    });
    const tomorrowLabel = new Date(tomorrowStart * 1000).toLocaleDateString(
      "es-MX",
      {
        timeZone: MX_TZ,
        weekday: "long",
        day: "numeric",
        month: "long",
      },
    );

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="60">
  <title>${esc(salon.name)} — Panel</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f5f5f5; color: #222; padding-bottom: 40px; }
    header { background: #25D366; color: white; padding: 14px 16px; }
    header h1 { font-size: 1.1rem; font-weight: 600; }
    header p { font-size: 0.78rem; opacity: 0.9; }
    .nav { display: flex; gap: 4px; padding: 6px 16px; background: white; border-bottom: 1px solid #eee; }
    .nav a { font-size: 0.85rem; color: #25D366; text-decoration: none; padding: 6px 10px; border-radius: 4px; }
    .nav a.active { background: #e8f9ef; font-weight: 600; }
    .nav a:hover { background: #e8f9ef; }

    .next-banner { background: #fff; margin: 12px 16px 16px; padding: 14px 16px; border-radius: 10px; border-left: 4px solid #25D366; box-shadow: 0 2px 6px rgba(0,0,0,.06); }
    .next-banner-empty { color: #888; font-size: 0.9rem; text-align: center; border-left: 4px solid #ccc; }
    .next-label { font-size: 0.72rem; text-transform: uppercase; color: #888; letter-spacing: 0.5px; margin-bottom: 4px; }
    .next-main { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
    .next-when { font-size: 1.05rem; font-weight: 700; color: #25D366; }
    .next-name { font-size: 1.05rem; font-weight: 600; color: #222; }
    .next-sub { display: flex; justify-content: space-between; align-items: center; margin-top: 6px; font-size: 0.85rem; color: #555; }
    .next-sub .phone { color: #25D366; text-decoration: none; font-weight: 500; }

    .section { padding: 0 16px 16px; }
    .section h2 { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.5px; color: #888; margin-bottom: 6px; font-weight: 600; }
    .section .date { font-size: 0.75rem; color: #aaa; margin-left: 6px; text-transform: none; letter-spacing: 0; font-weight: normal; }

    table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    th, td { padding: 10px 8px; text-align: left; font-size: 0.85rem; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
    th { background: #fafafa; color: #888; font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
    tr:last-child td { border-bottom: none; }
    td.date-cell { font-weight: 500; color: #555; white-space: nowrap; text-transform: capitalize; }
    td.time { font-weight: 600; color: #25D366; white-space: nowrap; }
    td.who .name { font-weight: 500; }
    td.who .phone { display: inline-block; font-size: 0.78rem; color: #25D366; text-decoration: none; margin-top: 2px; }
    td.svc { color: #555; }
    td.actions { display: flex; gap: 4px; flex-direction: column; align-items: flex-end; }
    .btn-tiny { padding: 3px 8px; font-size: 0.72rem; border-radius: 4px; border: none; cursor: pointer; font-weight: 500; min-width: 60px; }
    .btn-cancel { background: #fee; color: #c0392b; border: 1px solid #fcc; }
    .btn-noshow { background: #fff5e0; color: #b8740b; border: 1px solid #fce6b3; }
    .btn-tiny:hover { opacity: 0.85; }

    tr.status-cancelled td.time, tr.status-cancelled td.svc, tr.status-cancelled td.who .name { text-decoration: line-through; color: #aaa; }
    tr.status-no_show td.time, tr.status-no_show td.svc, tr.status-no_show td.who .name { color: #b8740b; }
    .badge { display: inline-block; font-size: 0.65rem; padding: 1px 6px; border-radius: 3px; margin-left: 4px; vertical-align: middle; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; }
    .badge-cancelled { background: #fee; color: #c0392b; }
    .badge-noshow { background: #fff5e0; color: #b8740b; }

    .empty { padding: 16px; text-align: center; color: #aaa; background: white; border-radius: 8px; font-size: 0.85rem; }

    .stats-footer { font-size: 0.75rem; color: #999; text-align: center; padding: 8px 16px 16px; }
    .stats-footer strong { color: #555; }
  </style>
</head>
<body>
  <header>
    <h1>💇‍♀️ ${esc(salon.name)}</h1>
    <p>${todayLabel}</p>
  </header>
  <nav class="nav">
    <a href="/panel/dashboard?token=${esc(token)}" class="active">Hoy</a>
    <a href="/panel/contacts?token=${esc(token)}">Clientas</a>
    <a href="/panel/campaigns?token=${esc(token)}">Reactivaciones</a>
  </nav>

  ${nextBanner}

  <div class="section">
    <h2>Hoy <span class="date">${todayLabel}</span></h2>
    ${todaySection}
  </div>

  <div class="section">
    <h2>Mañana <span class="date">${tomorrowLabel}</span></h2>
    ${tomorrowSection}
  </div>

  <div class="section upcoming">
    <h2>Próximas <span class="date">esta semana</span></h2>
    ${upcomingSection}
  </div>

  <div class="stats-footer">
    <strong>${todayConfirmed}</strong> cita${todayConfirmed === 1 ? "" : "s"} hoy ·
    <strong>${contactsTotal.n}</strong> clienta${contactsTotal.n === 1 ? "" : "s"} ·
    <strong>${dormantTotal.n}</strong> dormida${dormantTotal.n === 1 ? "" : "s"} ·
    <strong>${stats.booked}</strong> reactivada${stats.booked === 1 ? "" : "s"}
  </div>
</body>
</html>`;

    return c.html(html);
  });

  // ─── Appointment actions (cancel / no-show) ──────────────────────────
  // Token-scoped: the appointment must belong to the salon the token unlocks.
  // Otherwise a leaked token could mutate another salon's rows by ID guess.
  // C1 audit fold: encodeURIComponent the token before interpolating into
  // the Location header — defense-in-depth even though tokens that survive
  // auth are validated UUIDs. R3 fold: 303 See Other is the correct POST-
  // redirect-GET status.
  app.post("/panel/appointments/:id/cancel", async (c) => {
    if (!checkPanelCsrf(c)) return c.text("Solicitud inválida", 403);
    const salon = c.get("salon" as never) as { id: string };
    const token = encodeURIComponent(c.req.query("token")!);
    const appt = getAppointmentById(db, c.req.param("id"));
    if (!appt) return c.text("Cita no encontrada", 404);
    if (appt.salon_id !== salon.id) return c.text("Cita no encontrada", 404);
    if (appt.status !== "confirmed") {
      // Idempotent — already cancelled / no_show / completed. Redirect anyway
      // so a refresh of the panel after a double-click is harmless.
      return c.redirect(`/panel/dashboard?token=${token}`, 303);
    }
    cancelAppointment(db, appt.id);
    return c.redirect(`/panel/dashboard?token=${token}`, 303);
  });

  app.post("/panel/appointments/:id/no-show", async (c) => {
    if (!checkPanelCsrf(c)) return c.text("Solicitud inválida", 403);
    const salon = c.get("salon" as never) as { id: string };
    const token = encodeURIComponent(c.req.query("token")!);
    const appt = getAppointmentById(db, c.req.param("id"));
    if (!appt) return c.text("Cita no encontrada", 404);
    if (appt.salon_id !== salon.id) return c.text("Cita no encontrada", 404);
    if (appt.status !== "confirmed") {
      return c.redirect(`/panel/dashboard?token=${token}`, 303);
    }
    markNoShow(db, appt.id);
    return c.redirect(`/panel/dashboard?token=${token}`, 303);
  });

  // ─── Contacts list ──────────────────────────────────────────────────
  app.get("/panel/contacts", (c) => {
    const salon = c.get("salon" as never) as { id: string; name: string };
    const token = c.req.query("token")!;

    const contacts = db
      .prepare(
        `
      SELECT c.*, 
        COUNT(a.id) as total_appointments,
        MAX(a.starts_at) as last_appointment
      FROM contacts c
      LEFT JOIN appointments a ON a.contact_id = c.id AND a.status = 'completed'
      WHERE c.salon_id = ?
      GROUP BY c.id
      ORDER BY last_appointment DESC NULLS LAST
    `,
      )
      .all(salon.id) as Array<{
      name: string | null;
      phone: string;
      visit_count: number;
      dormant: number;
      last_visit: number | null;
      total_appointments: number;
    }>;

    const rows = contacts
      .map((c) => {
        const lastVisit = c.last_visit
          ? new Date(c.last_visit * 1000).toLocaleDateString("es-MX", {
              timeZone: "America/Mexico_City",
            })
          : "Nunca";
        const status = c.dormant ? "😴 Dormida" : "✅ Activa";
        return `<tr>
        <td>${c.name ?? c.phone}</td>
        <td>${c.visit_count}</td>
        <td>${lastVisit}</td>
        <td>${status}</td>
      </tr>`;
      })
      .join("");

    return c.html(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Clientas — ${salon.name}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f5f5f5; }
    header { background: #25D366; color: white; padding: 16px; }
    header h1 { font-size: 1.2rem; }
    .nav { display: flex; gap: 8px; padding: 8px 16px; background: white; border-bottom: 1px solid #eee; }
    .nav a { font-size: 0.85rem; color: #25D366; text-decoration: none; padding: 4px 8px; border-radius: 4px; }
    .section { padding: 16px; }
    table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
    th, td { padding: 10px 12px; text-align: left; font-size: 0.85rem; border-bottom: 1px solid #eee; }
    th { background: #f9f9f9; font-weight: 600; }
  </style>
</head>
<body>
  <header><h1>Clientas — ${salon.name}</h1></header>
  <nav class="nav">
    <a href="/panel/dashboard?token=${token}">← Hoy</a>
    <a href="/panel/campaigns?token=${token}">Reactivaciones</a>
  </nav>
  <div class="section">
    <table>
      <thead><tr><th>Nombre</th><th>Visitas</th><th>Última visita</th><th>Estado</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" style="text-align:center;color:#999;padding:20px">Sin clientas aún</td></tr>'}</tbody>
    </table>
  </div>
</body>
</html>`);
  });

  // ─── Campaigns ──────────────────────────────────────────────────────
  app.get("/panel/campaigns", (c) => {
    const salon = c.get("salon" as never) as { id: string; name: string };
    const token = c.req.query("token")!;

    const stats = getCampaignStats(db, salon.id);
    const recent = db
      .prepare(
        `
      SELECT cam.*, con.name, con.phone
      FROM campaigns cam
      JOIN contacts con ON cam.contact_id = con.id
      WHERE cam.salon_id = ?
      ORDER BY cam.sent_at DESC
      LIMIT 50
    `,
      )
      .all(salon.id) as Array<{
      sent_at: number;
      name: string | null;
      phone: string;
      responded: number;
      booked: number;
      type: string;
    }>;

    const rows = recent
      .map((c) => {
        const when = new Date(c.sent_at * 1000).toLocaleDateString("es-MX", {
          timeZone: "America/Mexico_City",
        });
        return `<tr>
        <td>${c.name ?? c.phone}</td>
        <td>${when}</td>
        <td>${c.responded ? "✅" : "—"}</td>
        <td>${c.booked ? "✅" : "—"}</td>
      </tr>`;
      })
      .join("");

    const respRate =
      stats.total > 0 ? Math.round((stats.responded / stats.total) * 100) : 0;
    const bookRate =
      stats.total > 0 ? Math.round((stats.booked / stats.total) * 100) : 0;

    return c.html(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reactivaciones — ${salon.name}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f5f5f5; }
    header { background: #25D366; color: white; padding: 16px; }
    header h1 { font-size: 1.2rem; }
    .nav { display: flex; gap: 8px; padding: 8px 16px; background: white; border-bottom: 1px solid #eee; }
    .nav a { font-size: 0.85rem; color: #25D366; text-decoration: none; padding: 4px 8px; border-radius: 4px; }
    .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; padding: 16px; }
    .card { background: white; border-radius: 8px; padding: 14px; box-shadow: 0 1px 3px rgba(0,0,0,.1); text-align: center; }
    .card .num { font-size: 1.8rem; font-weight: bold; color: #25D366; }
    .card .label { font-size: 0.75rem; color: #666; }
    .section { padding: 0 16px 16px; }
    table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
    th, td { padding: 10px 12px; text-align: left; font-size: 0.85rem; border-bottom: 1px solid #eee; }
    th { background: #f9f9f9; font-weight: 600; }
  </style>
</head>
<body>
  <header><h1>Reactivaciones — ${salon.name}</h1></header>
  <nav class="nav">
    <a href="/panel/dashboard?token=${token}">← Hoy</a>
    <a href="/panel/contacts?token=${token}">Clientas</a>
  </nav>
  <div class="cards">
    <div class="card"><div class="num">${stats.total}</div><div class="label">Enviadas</div></div>
    <div class="card"><div class="num">${respRate}%</div><div class="label">Respondieron</div></div>
    <div class="card"><div class="num">${bookRate}%</div><div class="label">Agendaron</div></div>
  </div>
  <div class="section">
    <h2 style="font-size:1rem;margin-bottom:8px;color:#444">Recientes</h2>
    <table>
      <thead><tr><th>Clienta</th><th>Fecha</th><th>Respondió</th><th>Agendó</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" style="text-align:center;color:#999;padding:20px">Sin campañas aún</td></tr>'}</tbody>
    </table>
  </div>
</body>
</html>`);
  });

  // ─── API: stats (JSON) ───────────────────────────────────────────────
  app.get("/panel/api/stats", (c) => {
    const salon = c.get("salon" as never) as { id: string; name: string };
    const stats = getCampaignStats(db, salon.id);
    const contactsTotal = db
      .prepare("SELECT COUNT(*) as n FROM contacts WHERE salon_id = ?")
      .get(salon.id) as { n: number };
    const dormantTotal = db
      .prepare(
        "SELECT COUNT(*) as n FROM contacts WHERE salon_id = ? AND dormant = 1",
      )
      .get(salon.id) as { n: number };

    return c.json({
      salon: salon.name,
      contacts: contactsTotal.n,
      dormant: dormantTotal.n,
      campaigns: stats,
    });
  });

  return app;
}
