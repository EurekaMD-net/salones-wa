/**
 * Hono web panel — puerto 8085 (already open in UFW)
 * Auth: ?token=<uuid> per salon
 * Designed for mobile browsers (3G-friendly, vanilla HTML, no JS framework)
 */

import { Hono } from 'hono'
import type Database from 'better-sqlite3'
import { getSalonByToken, getCampaignStats } from '../db/models.js'

export function createWebPanel(db: Database.Database): Hono {
  const app = new Hono()

  // ─── Auth middleware ────────────────────────────────────────────────
  app.use('/panel/*', async (c, next) => {
    const token = c.req.query('token')
    if (!token) return c.text('Token requerido', 401)

    const salon = getSalonByToken(db, token)
    if (!salon) return c.text('Token inválido', 401)

    c.set('salon' as never, salon)
    await next()
  })

  // ─── Health check ───────────────────────────────────────────────────
  app.get('/health', c => c.json({ ok: true, service: 'salones-wa', ts: new Date().toISOString() }))

  // ─── Dashboard ──────────────────────────────────────────────────────
  app.get('/panel/dashboard', c => {
    const salon = c.get('salon' as never) as { id: string; name: string }
    const token = c.req.query('token')!

    const today = Math.floor(Date.now() / 1000)
    const dayEnd = today + 86400

    const todayAppointments = db.prepare(`
      SELECT a.*, c.name as contact_name, c.phone as contact_phone, s.name as service_name
      FROM appointments a
      JOIN contacts c ON a.contact_id = c.id
      LEFT JOIN services s ON a.service_id = s.id
      WHERE a.salon_id = ?
        AND a.starts_at BETWEEN ? AND ?
        AND a.status = 'confirmed'
      ORDER BY a.starts_at ASC
    `).all(salon.id, today, dayEnd)

    const stats = getCampaignStats(db, salon.id)
    const contactsTotal = db.prepare('SELECT COUNT(*) as n FROM contacts WHERE salon_id = ?').get(salon.id) as { n: number }
    const dormantTotal = db.prepare('SELECT COUNT(*) as n FROM contacts WHERE salon_id = ? AND dormant = 1').get(salon.id) as { n: number }

    const apptRows = (todayAppointments as Array<{
      starts_at: number
      contact_name: string | null
      contact_phone: string
      service_name: string | null
    }>).map(a => {
      const time = new Date(a.starts_at * 1000).toLocaleTimeString('es-MX', {
        timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit'
      })
      return `<tr>
        <td>${time}</td>
        <td>${a.contact_name ?? a.contact_phone}</td>
        <td>${a.service_name ?? '—'}</td>
      </tr>`
    }).join('')

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${salon.name} — Panel</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f5f5f5; color: #333; }
    header { background: #25D366; color: white; padding: 16px; }
    header h1 { font-size: 1.2rem; }
    header p { font-size: 0.85rem; opacity: 0.9; }
    .cards { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; padding: 16px; }
    .card { background: white; border-radius: 8px; padding: 14px; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
    .card .num { font-size: 2rem; font-weight: bold; color: #25D366; }
    .card .label { font-size: 0.8rem; color: #666; margin-top: 4px; }
    .section { padding: 0 16px 16px; }
    .section h2 { font-size: 1rem; margin-bottom: 8px; color: #444; }
    table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
    th, td { padding: 10px 12px; text-align: left; font-size: 0.9rem; border-bottom: 1px solid #eee; }
    th { background: #f9f9f9; color: #555; font-weight: 600; }
    .empty { padding: 20px; text-align: center; color: #999; }
    .nav { display: flex; gap: 8px; padding: 8px 16px; background: white; border-bottom: 1px solid #eee; }
    .nav a { font-size: 0.85rem; color: #25D366; text-decoration: none; padding: 4px 8px; border-radius: 4px; }
    .nav a:hover { background: #e8f9ef; }
  </style>
</head>
<body>
  <header>
    <h1>💇‍♀️ ${salon.name}</h1>
    <p>${new Date().toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
  </header>
  <nav class="nav">
    <a href="/panel/dashboard?token=${token}">Hoy</a>
    <a href="/panel/contacts?token=${token}">Clientas</a>
    <a href="/panel/campaigns?token=${token}">Reactivaciones</a>
  </nav>
  <div class="cards">
    <div class="card">
      <div class="num">${todayAppointments.length}</div>
      <div class="label">Citas hoy</div>
    </div>
    <div class="card">
      <div class="num">${contactsTotal.n}</div>
      <div class="label">Clientas totales</div>
    </div>
    <div class="card">
      <div class="num">${dormantTotal.n}</div>
      <div class="label">Clientas dormidas</div>
    </div>
    <div class="card">
      <div class="num">${stats.booked}</div>
      <div class="label">Reactivadas (total)</div>
    </div>
  </div>
  <div class="section">
    <h2>Agenda de hoy</h2>
    ${todayAppointments.length === 0
      ? '<div class="empty">No hay citas para hoy</div>'
      : `<table><thead><tr><th>Hora</th><th>Clienta</th><th>Servicio</th></tr></thead><tbody>${apptRows}</tbody></table>`
    }
  </div>
</body>
</html>`

    return c.html(html)
  })

  // ─── Contacts list ──────────────────────────────────────────────────
  app.get('/panel/contacts', c => {
    const salon = c.get('salon' as never) as { id: string; name: string }
    const token = c.req.query('token')!

    const contacts = db.prepare(`
      SELECT c.*, 
        COUNT(a.id) as total_appointments,
        MAX(a.starts_at) as last_appointment
      FROM contacts c
      LEFT JOIN appointments a ON a.contact_id = c.id AND a.status = 'completed'
      WHERE c.salon_id = ?
      GROUP BY c.id
      ORDER BY last_appointment DESC NULLS LAST
    `).all(salon.id) as Array<{
      name: string | null
      phone: string
      visit_count: number
      dormant: number
      last_visit: number | null
      total_appointments: number
    }>

    const rows = contacts.map(c => {
      const lastVisit = c.last_visit
        ? new Date(c.last_visit * 1000).toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City' })
        : 'Nunca'
      const status = c.dormant ? '😴 Dormida' : '✅ Activa'
      return `<tr>
        <td>${c.name ?? c.phone}</td>
        <td>${c.visit_count}</td>
        <td>${lastVisit}</td>
        <td>${status}</td>
      </tr>`
    }).join('')

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
</html>`)
  })

  // ─── Campaigns ──────────────────────────────────────────────────────
  app.get('/panel/campaigns', c => {
    const salon = c.get('salon' as never) as { id: string; name: string }
    const token = c.req.query('token')!

    const stats = getCampaignStats(db, salon.id)
    const recent = db.prepare(`
      SELECT cam.*, con.name, con.phone
      FROM campaigns cam
      JOIN contacts con ON cam.contact_id = con.id
      WHERE cam.salon_id = ?
      ORDER BY cam.sent_at DESC
      LIMIT 50
    `).all(salon.id) as Array<{
      sent_at: number
      name: string | null
      phone: string
      responded: number
      booked: number
      type: string
    }>

    const rows = recent.map(c => {
      const when = new Date(c.sent_at * 1000).toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City' })
      return `<tr>
        <td>${c.name ?? c.phone}</td>
        <td>${when}</td>
        <td>${c.responded ? '✅' : '—'}</td>
        <td>${c.booked ? '✅' : '—'}</td>
      </tr>`
    }).join('')

    const respRate = stats.total > 0 ? Math.round(stats.responded / stats.total * 100) : 0
    const bookRate = stats.total > 0 ? Math.round(stats.booked / stats.total * 100) : 0

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
</html>`)
  })

  // ─── API: stats (JSON) ───────────────────────────────────────────────
  app.get('/panel/api/stats', c => {
    const salon = c.get('salon' as never) as { id: string; name: string }
    const stats = getCampaignStats(db, salon.id)
    const contactsTotal = db.prepare('SELECT COUNT(*) as n FROM contacts WHERE salon_id = ?').get(salon.id) as { n: number }
    const dormantTotal = db.prepare('SELECT COUNT(*) as n FROM contacts WHERE salon_id = ? AND dormant = 1').get(salon.id) as { n: number }

    return c.json({
      salon: salon.name,
      contacts: contactsTotal.n,
      dormant: dormantTotal.n,
      campaigns: stats,
    })
  })

  return app
}
