/**
 * Admin UI — /admin/*
 * Protected by ADMIN_TOKEN env var (NOT the per-salon token)
 * All state mutations via POST forms (no JS required)
 */

import { Hono } from 'hono'
import type Database from 'better-sqlite3'
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
} from '../db/models.js'

function getAdminToken(): string {
  return process.env['ADMIN_TOKEN'] ?? 'changeme'
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
`

function layout(title: string, body: string, adminToken: string): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — Admin Salones</title>
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
</html>`
}

// ─── Router factory ──────────────────────────────────────────────────────────

export function createAdminPanel(db: Database.Database): Hono {
  const app = new Hono()

  // Auth guard — all /admin routes
  app.use('/admin/*', async (c, next) => {
    const token = c.req.query('token')
    if (!token || token !== getAdminToken()) {
      return c.text('Token de administrador requerido o inválido\n\nUsa: /admin?token=TU_ADMIN_TOKEN', 401)
    }
    await next()
  })

  // ─── GET /admin — lista de salones ──────────────────────────────────
  app.get('/admin', c => {
    const adminToken = c.req.query('token')!
    const salons = getAllSalons(db)

    const rows = salons.map(s => {
      const created = new Date(s.created_at * 1000).toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City' })
      const statusBadge = s.active
        ? '<span class="badge-active">Activo</span>'
        : '<span class="badge-inactive">Inactivo</span>'
      return `<tr>
        <td><strong>${s.name}</strong></td>
        <td style="font-family:monospace;font-size:0.85rem">${s.phone}</td>
        <td>${statusBadge}</td>
        <td>${created}</td>
        <td class="actions">
          <a href="/admin/salones/${s.id}?token=${adminToken}" class="btn btn-secondary btn-sm">Editar</a>
          <form method="POST" action="/admin/salones/${s.id}/toggle?token=${adminToken}" style="display:inline">
            <button type="submit" class="btn btn-sm ${s.active ? 'btn-danger' : 'btn-primary'}">
              ${s.active ? 'Desactivar' : 'Activar'}
            </button>
          </form>
        </td>
      </tr>`
    }).join('')

    const body = `
      <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;padding:0">
        <h2 style="font-size:1.1rem">Salones registrados (${salons.length})</h2>
        <a href="/admin/salones/new?token=${adminToken}" class="btn btn-primary">+ Nuevo salón</a>
      </div>
      <div class="card">
        <div class="card-body" style="padding:0">
          ${salons.length === 0
            ? '<div class="empty">No hay salones registrados aún.<br><a href="/admin/salones/new?token=' + adminToken + '">Crea el primero →</a></div>'
            : `<table>
                <thead><tr><th>Nombre</th><th>Teléfono WA</th><th>Estado</th><th>Alta</th><th>Acciones</th></tr></thead>
                <tbody>${rows}</tbody>
               </table>`
          }
        </div>
      </div>`

    return c.html(layout('Salones', body, adminToken))
  })

  // ─── GET /admin/salones/new — formulario crear ────────────────────────
  app.get('/admin/salones/new', c => {
    const adminToken = c.req.query('token')!

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
              <label>Número de WhatsApp *</label>
              <input class="form-control" name="phone" required placeholder="521XXXXXXXXXX" />
              <div class="form-hint">Incluye código de país sin +. Ejemplo: 521 para MX celular → 5215512345678</div>
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
      </div>`

    return c.html(layout('Nuevo salón', body, adminToken))
  })

  // ─── POST /admin/salones — crear ─────────────────────────────────────
  app.post('/admin/salones', async c => {
    const adminToken = c.req.query('token')!
    const form = await c.req.formData()

    const name = (form.get('name') as string | null)?.trim() ?? ''
    const phone = (form.get('phone') as string | null)?.trim() ?? ''

    if (!name || !phone) {
      return c.html(layout('Error', '<div class="alert" style="background:#fee;border:1px solid #fcc;color:#c0392b">Nombre y teléfono son requeridos.</div><a href="/admin/salones/new?token=' + adminToken + '" class="btn btn-secondary">← Volver</a>', adminToken), 400)
    }

    const salon = createSalon(db, { name, phone })

    // Create services (array fields)
    const svcNames = form.getAll('svc_name[]') as string[]
    const svcDurs = form.getAll('svc_dur[]') as string[]
    const svcPrices = form.getAll('svc_price[]') as string[]

    for (let i = 0; i < svcNames.length; i++) {
      const svcName = svcNames[i]?.trim()
      if (!svcName) continue
      const dur = parseInt(svcDurs[i] ?? '30', 10) || 30
      const price = parseFloat(svcPrices[i] ?? '') || undefined
      createService(db, { salon_id: salon.id, name: svcName, duration_min: dur, price })
    }

    const panelUrl = `http://localhost:8085/panel/dashboard?token=${salon.token}`
    const body = `
      <div class="alert alert-success">✅ Salón <strong>${salon.name}</strong> creado exitosamente.</div>
      <div class="card">
        <div class="card-header"><h2>URL del panel para la dueña</h2></div>
        <div class="card-body">
          <p style="margin-bottom:12px;font-size:0.9rem;color:#555">Comparte esta URL con la dueña del salón. Es su acceso al panel de citas:</p>
          <div class="panel-url">${panelUrl}</div>
          <p style="margin-top:8px;font-size:0.8rem;color:#999">⚠️ Cambia <code>localhost</code> por la IP o dominio del servidor antes de compartir.</p>
          <div style="margin-top:16px;display:flex;gap:8px">
            <a href="/admin/salones/${salon.id}?token=${adminToken}" class="btn btn-secondary">Editar servicios</a>
            <a href="/admin?token=${adminToken}" class="btn btn-primary">← Volver a lista</a>
          </div>
        </div>
      </div>`

    return c.html(layout('Salón creado', body, adminToken))
  })

  // ─── GET /admin/salones/:id — detalle/edición ─────────────────────────
  app.get('/admin/salones/:id', c => {
    const adminToken = c.req.query('token')!
    const salon = getSalonById(db, c.req.param('id'))
    if (!salon) return c.text('Salón no encontrado', 404)

    const services = getServices(db, salon.id)
    const panelUrl = `http://localhost:8085/panel/dashboard?token=${salon.token}`

    const serviceRows = services.map(s => `
      <div class="service-row">
        <span class="svc-name">${s.name}</span>
        <span class="svc-meta">${s.duration_min} min · ${s.price != null ? '$' + s.price : 'Sin precio'}</span>
        <form method="POST" action="/admin/salones/${salon.id}/services/${s.id}/delete?token=${adminToken}" style="display:inline">
          <button type="submit" class="btn btn-danger btn-sm">Eliminar</button>
        </form>
      </div>`).join('')

    const body = `
      <div style="margin-bottom:16px">
        <a href="/admin?token=${adminToken}" class="btn btn-secondary btn-sm">← Volver a lista</a>
      </div>

      <!-- Datos del salón -->
      <div class="card" style="margin-bottom:16px">
        <div class="card-header">
          <h2>${salon.name}</h2>
          <span class="${salon.active ? 'badge-active' : 'badge-inactive'}">${salon.active ? 'Activo' : 'Inactivo'}</span>
        </div>
        <div class="card-body">
          <form method="POST" action="/admin/salones/${salon.id}/edit?token=${adminToken}">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
              <div class="form-group">
                <label>Nombre del salón</label>
                <input class="form-control" name="name" value="${salon.name}" required />
              </div>
              <div class="form-group">
                <label>Número WhatsApp</label>
                <input class="form-control" name="phone" value="${salon.phone}" required />
              </div>
            </div>
            <button type="submit" class="btn btn-primary">Guardar cambios</button>
          </form>
        </div>
      </div>

      <!-- URL del panel -->
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><h2>URL del panel (dueña)</h2></div>
        <div class="card-body">
          <div class="panel-url">${panelUrl}</div>
          <p style="margin-top:8px;font-size:0.8rem;color:#999">Reemplaza <code>localhost</code> por la IP o dominio del servidor.</p>
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

      <!-- Zona de peligro -->
      <div class="card">
        <div class="card-header"><h2>Acciones</h2></div>
        <div class="card-body">
          <form method="POST" action="/admin/salones/${salon.id}/toggle?token=${adminToken}">
            <button type="submit" class="btn ${salon.active ? 'btn-danger' : 'btn-primary'}">
              ${salon.active ? '⏸ Desactivar salón' : '▶ Activar salón'}
            </button>
          </form>
          <p style="margin-top:8px;font-size:0.8rem;color:#999">
            ${salon.active ? 'Desactivar detiene el bot WA para este salón.' : 'Activar permite al bot responder mensajes de este salón.'}
          </p>
        </div>
      </div>`

    return c.html(layout(salon.name, body, adminToken))
  })

  // ─── POST /admin/salones/:id/edit — guardar edición ──────────────────
  app.post('/admin/salones/:id/edit', async c => {
    const adminToken = c.req.query('token')!
    const salon = getSalonById(db, c.req.param('id'))
    if (!salon) return c.text('Salón no encontrado', 404)

    const form = await c.req.formData()
    const name = (form.get('name') as string | null)?.trim()
    const phone = (form.get('phone') as string | null)?.trim()

    updateSalon(db, salon.id, {
      ...(name ? { name } : {}),
      ...(phone ? { phone } : {}),
    })

    return c.redirect(`/admin/salones/${salon.id}?token=${adminToken}&saved=1`)
  })

  // ─── POST /admin/salones/:id/toggle — activar/desactivar ─────────────
  app.post('/admin/salones/:id/toggle', c => {
    const adminToken = c.req.query('token')!
    const salon = getSalonById(db, c.req.param('id'))
    if (!salon) return c.text('Salón no encontrado', 404)

    setSalonActive(db, salon.id, !salon.active)
    return c.redirect(`/admin?token=${adminToken}`)
  })

  // ─── POST /admin/salones/:id/services — agregar servicio ─────────────
  app.post('/admin/salones/:id/services', async c => {
    const adminToken = c.req.query('token')!
    const salon = getSalonById(db, c.req.param('id'))
    if (!salon) return c.text('Salón no encontrado', 404)

    const form = await c.req.formData()
    const name = (form.get('name') as string | null)?.trim() ?? ''
    const duration_min = parseInt(form.get('duration_min') as string ?? '30', 10) || 30
    const priceRaw = form.get('price') as string | null
    const price = priceRaw ? (parseFloat(priceRaw) || undefined) : undefined

    if (name) {
      createService(db, { salon_id: salon.id, name, duration_min, price })
    }

    return c.redirect(`/admin/salones/${salon.id}?token=${adminToken}`)
  })

  // ─── POST /admin/salones/:id/services/:svcId/delete ──────────────────
  app.post('/admin/salones/:id/services/:svcId/delete', c => {
    const adminToken = c.req.query('token')!
    const salon = getSalonById(db, c.req.param('id'))
    if (!salon) return c.text('Salón no encontrado', 404)

    deleteService(db, c.req.param('svcId'))
    return c.redirect(`/admin/salones/${salon.id}?token=${adminToken}`)
  })

  return app
}
