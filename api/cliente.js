// Estudio Bianco · Portal del cliente (Vercel Serverless Function)
//
// GET  /api/cliente?k=<link privado del proyecto>
//   -> { ok, proyecto:{nombre,cliente}, items:[...], respuestas:[...] }
//   Solo los productos de ESE proyecto, sin honorarios, pagos ni notas internas.
//
// POST /api/cliente   { k, itemId, decision, comentario, nombre }
//   decision: 'Aprobado' | 'Cambios solicitados' | 'Rechazado' | '' (solo comentario)
//   -> actualiza "Est. cliente" del producto y deja el registro en la Bitacora del proyecto.
//
// La pagina del cliente nunca recibe llaves de la base de datos: esta funcion usa la llave
// privada SUPABASE_SERVICE_KEY guardada en las variables de entorno de Vercel.

const SB_URL = 'https://iucjhzsnlotojvpyjcfo.supabase.co';
const DECISIONES = ['Aprobado', 'Cambios solicitados', 'Rechazado', 'Por revisar', '']; // 'Por revisar' = deshacer la respuesta
const CAMPOS_ITEM = 'id,cat,item,supplier,qty,unit,space,specs,product_url,image_url,delivery_status,client_status,opt_group,opt_sel,opt_rec,client_note,order_date,est_delivery,order_num,delivery_resp';

function llave() { return process.env.SUPABASE_SERVICE_KEY || ''; }
function H(extra) { const k = llave(); return Object.assign({ apikey: k, Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' }, extra || {}); }

async function sb(path, opt) {
  const r = await fetch(SB_URL + '/rest/v1/' + path, Object.assign({ headers: H() }, opt || {}));
  const t = await r.text();
  if (!r.ok) throw new Error('Supabase ' + r.status + ': ' + t.slice(0, 200));
  return t ? JSON.parse(t) : null;
}

function tokenValido(k) { return typeof k === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(k); }

async function proyectoDe(k) {
  if (!tokenValido(k)) return null;
  const p = await sb('projects?select=id,name,client,status&portal_token=eq.' + encodeURIComponent(k) + '&limit=1');
  return p && p[0] ? p[0] : null;
}

function hoySantiago() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function limpio(s, max) { return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max); }

// Proveedores de los productos del proyecto, con sus datos publicos de contacto (tabla suppliers).
// Calza por nombre sin tildes ni espacios, o por los nombres antiguos de proveedores unidos ("También escrito: X").
function normN(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, ''); }
async function proveedoresDe(items) {
  const nombres = {}; items.forEach(x => { const n = (x.supplier || '').trim(); if (n) nombres[normN(n)] = n; });
  if (!Object.keys(nombres).length) return [];
  const sups = (await sb('suppliers?select=name,phone,email,web,addr,contact,city,category,specialty,notes')) || [];
  const out = [], vistos = {};
  Object.keys(nombres).forEach(k => {
    const s = sups.find(x => normN(x.name) === k) || sups.find(x => (String(x.notes || '').match(/También escrito: [^·]+/g) || []).some(a => normN(a.replace('También escrito: ', '')) === k));
    const nombre = s ? s.name : nombres[k], clave = normN(nombre);
    if (vistos[clave]) return; vistos[clave] = 1;
    const n = items.filter(x => { const kk = normN(x.supplier); return kk === k || (s && kk === normN(s.name)); }).length;
    out.push({ nombre: nombre, rubro: s ? s.category || '' : '', especialidad: s ? s.specialty || '' : '', telefono: s ? s.phone || '' : '', correo: s ? s.email || '' : '', web: s ? s.web || '' : '', direccion: s ? s.addr || '' : '', ciudad: s ? s.city || '' : '', productos: n });
  });
  return out.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

// "Lo compré yo": el cliente registra su compra; queda en los datos de seguimiento del producto
async function compra(p, b, res) {
  const itemId = +b.itemId, fecha = limpio(b.fecha, 10), entrega = limpio(b.entrega, 10), orden = limpio(b.orden, 60), com = limpio(b.comentario, 1000), nombre = limpio(b.nombre, 80) || 'Cliente';
  const esFecha = d => /^\d{4}-\d{2}-\d{2}$/.test(d);
  if (!(itemId > 0) || !esFecha(fecha) || (entrega && !esFecha(entrega))) return res.status(400).json({ ok: false, error: 'Revisa las fechas.' });
  const it = await sb('items?select=id,item,cat,delivery_status,track_note&project_id=eq.' + encodeURIComponent(p.id) + '&id=eq.' + itemId + '&limit=1');
  if (!it || !it[0] || it[0].cat === 'Honorarios') return res.status(404).json({ ok: false, error: 'Producto no encontrado.' });
  const nota = 'Comprado por el cliente (' + nombre + ') el ' + fecha + (orden ? ' · orden ' + orden : '') + (com ? ' · ' + com : '');
  const cambio = { order_date: fecha, delivery_resp: 'Cliente', order_num: orden, track_note: ((it[0].track_note || '') + (it[0].track_note ? '\n' : '') + nota).slice(0, 4000) };
  if (entrega) cambio.est_delivery = entrega;
  if (!it[0].delivery_status || it[0].delivery_status === 'Por pedir') cambio.delivery_status = 'Pedido confirmado';
  await sb('items?project_id=eq.' + encodeURIComponent(p.id) + '&id=eq.' + itemId, { method: 'PATCH', headers: H({ Prefer: 'return=minimal' }), body: JSON.stringify(cambio) });
  await sb('logs', { method: 'POST', headers: H({ Prefer: 'return=minimal' }), body: JSON.stringify({
    id: Date.now() * 10 + Math.floor(Math.random() * 10), project_id: p.id, date: hoySantiago(), type: 'Nota general',
    title: ('Cliente compró: ' + (it[0].item || 'producto')).slice(0, 200), description: nota + (entrega ? ' · entrega aprox. ' + entrega : ''),
    commits: '', responsible: nombre, due_date: '', status: 'Completada', amount: 0, category: 'cliente', item_id: itemId,
    extra: JSON.stringify({ cliente: true, compra: { fecha: fecha, entrega: entrega, orden: orden }, autor: 'cliente', at: new Date().toISOString() })
  }) });
  return res.status(200).json({ ok: true });
}

// Respuesta del cliente a una lámina o render: queda en su status y en un registro de la bitácora
async function respuestaDoc(p, b, res) {
  const docId = +b.docId, decision = DECISIONES.indexOf(b.decision) >= 0 ? b.decision : null;
  const comentario = limpio(b.comentario, 2000), nombre = limpio(b.nombre, 80) || 'Cliente';
  if (!(docId > 0) || decision === null) return res.status(400).json({ ok: false, error: 'Respuesta no válida.' });
  if (!decision && !comentario) return res.status(400).json({ ok: false, error: 'Escribe un comentario.' });
  if (decision === 'Cambios solicitados' && !comentario) return res.status(400).json({ ok: false, error: 'Cuéntanos qué cambio quieres.' });
  const d = await sb('logs?select=id,title,category,extra&project_id=eq.' + encodeURIComponent(p.id) + '&id=eq.' + docId + '&category=in.(lamina,render)&limit=1');
  if (!d || !d[0]) return res.status(404).json({ ok: false, error: 'Documento no encontrado.' });
  let x = {}; try { x = d[0].extra ? JSON.parse(d[0].extra) : {}; } catch (e) {}
  if (x.oculto) return res.status(404).json({ ok: false, error: 'Documento no encontrado.' });
  if (decision) await sb('logs?project_id=eq.' + encodeURIComponent(p.id) + '&id=eq.' + docId, { method: 'PATCH', headers: H({ Prefer: 'return=minimal' }), body: JSON.stringify({ status: decision === 'Por revisar' ? '' : decision }) });
  const titulo = (decision === 'Por revisar' ? 'Cliente deshizo su respuesta' : decision ? 'Cliente: ' + decision : 'Comentario del cliente') + ' · ' + (d[0].title || (d[0].category === 'render' ? 'render' : 'lámina'));
  await sb('logs', { method: 'POST', headers: H({ Prefer: 'return=minimal' }), body: JSON.stringify({
    id: Date.now() * 10 + Math.floor(Math.random() * 10), project_id: p.id, date: hoySantiago(), type: 'Nota general', title: titulo.slice(0, 200),
    description: comentario, commits: '', responsible: nombre, due_date: '', status: 'Completada', amount: 0, category: 'cliente', item_id: null,
    extra: JSON.stringify({ cliente: true, decision: decision, docId: docId, version: (x.versiones || []).length + 1, autor: 'cliente', at: new Date().toISOString() })
  }) });
  return res.status(200).json({ ok: true });
}

// Ingreso al portal: queda constancia (nombre, fecha y hora). Si la misma persona vuelve antes de 30 minutos, no se repite.
async function visita(p, nombre, req, res) {
  if (!nombre) return res.status(400).json({ ok: false, error: 'Escribe tu nombre.' });
  const ult = await sb('logs?select=extra&project_id=eq.' + encodeURIComponent(p.id) + '&category=eq.visita&responsible=eq.' + encodeURIComponent(nombre) + '&order=id.desc&limit=1');
  if (ult && ult[0]) { let x = {}; try { x = JSON.parse(ult[0].extra || '{}'); } catch (e) {} if (x.at && Date.now() - Date.parse(x.at) < 30 * 60 * 1000) return res.status(200).json({ ok: true, repetida: true }); }
  const ua = String((req.headers || {})['user-agent'] || ''), equipo = /iphone|android|mobile/i.test(ua) ? 'celular' : /ipad|tablet/i.test(ua) ? 'tablet' : 'computador';
  await sb('logs', { method: 'POST', headers: H({ Prefer: 'return=minimal' }), body: JSON.stringify({
    id: Date.now() * 10 + Math.floor(Math.random() * 10), project_id: p.id, date: hoySantiago(), type: 'Nota general', title: 'Ingresó al portal', description: '',
    commits: '', responsible: nombre, due_date: '', status: 'Completada', amount: 0, category: 'visita', item_id: null,
    extra: JSON.stringify({ visita: true, equipo: equipo, at: new Date().toISOString() })
  }) });
  return res.status(200).json({ ok: true });
}

// "Terminé de revisar": cuenta las respuestas actuales y deja un registro con el resumen
async function terminar(p, nombre, res) {
  const its = (await sb('items?select=item,client_status,opt_group,opt_sel&project_id=eq.' + encodeURIComponent(p.id) + '&cat=neq.Honorarios')) || [];
  const c = { Aprobado: [], 'Cambios solicitados': [], Rechazado: [], 'Por revisar': [] };
  its.forEach(x => { const s = x.client_status || 'Por revisar'; (c[s] || c['Por revisar']).push(x.item || 'producto'); });
  const resumen = { aprobados: c.Aprobado.length, cambios: c['Cambios solicitados'].length, descartados: c.Rechazado.length, pendientes: c['Por revisar'].length, total: its.length };
  const lista = (t, a) => a.length ? t + ' (' + a.length + '): ' + a.join(', ') : '';
  const desc = [lista('Aprobados', c.Aprobado), lista('Cambios pedidos', c['Cambios solicitados']), lista('Descartados', c.Rechazado), lista('Sin responder', c['Por revisar'])].filter(Boolean).join('\n');
  const fecha = hoySantiago();
  await sb('logs', { method: 'POST', headers: H({ Prefer: 'return=minimal' }), body: JSON.stringify({
    id: Date.now() * 10 + Math.floor(Math.random() * 10), project_id: p.id, date: fecha, type: 'Nota general',
    title: 'Cliente terminó su revisión: ' + resumen.aprobados + ' aprobados, ' + resumen.cambios + ' con cambios, ' + resumen.descartados + ' descartados',
    description: desc.slice(0, 8000), commits: '', responsible: nombre, due_date: '', status: 'Completada', amount: 0, category: 'cliente', item_id: null,
    extra: JSON.stringify({ cliente: true, fin: true, resumen: resumen, autor: 'cliente', at: new Date().toISOString() })
  }) });
  return res.status(200).json({ ok: true, resumen: resumen, fecha: fecha });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  if (!llave()) return res.status(503).json({ ok: false, error: 'El portal aún no está configurado (falta la llave privada en Vercel).' });

  try {
    if (req.method === 'GET') {
      const p = await proyectoDe((req.query || {}).k);
      if (!p) return res.status(404).json({ ok: false, error: 'Este link no es válido o fue desactivado.' });
      const items = (await sb('items?select=' + CAMPOS_ITEM + '&project_id=eq.' + encodeURIComponent(p.id) + '&cat=neq.Honorarios&order=id')) || [];
      const provs = await proveedoresDe(items);
      const docsRaw = (await sb('logs?select=id,date,title,description,status,category,extra&project_id=eq.' + encodeURIComponent(p.id) + '&category=in.(lamina,render)&order=id')) || [];
      const docs = docsRaw.map(d => { let x = {}; try { x = d.extra ? JSON.parse(d.extra) : {}; } catch (e) {} return { d, x }; })
        .filter(o => !o.x.oculto && o.x.url)
        .map(o => ({ id: o.d.id, tipo: o.d.category, titulo: o.d.title || '', nota: o.d.description || '', estado: o.d.status || '', fecha: o.d.date || '', url: o.x.url, pdf: /pdf/i.test(o.x.mime || '') || /\.pdf($|\?)/i.test(o.x.url), espacio: o.x.espacio || '', version: (o.x.versiones || []).length + 1, anteriores: (o.x.versiones || []).map(v => ({ url: v.url, pdf: /pdf/i.test(v.mime || ''), fecha: v.fecha || '' })) }));
      const resp = (await sb('logs?select=id,date,title,description,responsible,item_id,extra&project_id=eq.' + encodeURIComponent(p.id) + '&category=eq.cliente&order=id.desc&limit=200')) || [];
      return res.status(200).json({
        ok: true,
        proyecto: { nombre: p.name || '', cliente: p.client || '' },
        items: items.map(x => ({
          id: x.id, cat: x.cat || '', item: x.item || '', proveedor: x.supplier || '', cant: x.qty || 1, precio: x.unit || 0,
          espacio: x.space || '', specs: x.specs || '', link: x.product_url || '', imagen: x.image_url || '',
          entrega: x.delivery_status || 'Por pedir', estado: x.client_status || '',
          compra: x.order_date ? { fecha: x.order_date, entrega: x.est_delivery || '', orden: x.order_num || '', por: x.delivery_resp === 'Cliente' ? 'cliente' : 'estudio' } : null, grupo: x.opt_group || '', elegida: x.opt_sel === '1', recomendada: x.opt_rec === '1', nota: x.client_note || ''
        })),
        proveedores: provs,
        documentos: docs,
        respuestas: resp.map(l => {
          let ex = {}; try { ex = l.extra ? JSON.parse(l.extra) : {}; } catch (e) {}
          return { id: l.id, fecha: l.date, itemId: l.item_id || 0, docId: ex.docId || 0, decision: ex.decision || '', comentario: l.description || '', nombre: l.responsible || '', autor: ex.autor || 'cliente' };
        })
      });
    }

    if (req.method === 'POST') {
      let b = req.body || {};
      if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
      const p = await proyectoDe(b.k);
      if (!p) return res.status(404).json({ ok: false, error: 'Este link no es válido o fue desactivado.' });
      if (b.accion === 'visita') return await visita(p, limpio(b.nombre, 80), req, res);
      if (b.accion === 'fin') return await terminar(p, limpio(b.nombre, 80) || 'Cliente', res);
      if (b.accion === 'compra') return await compra(p, b, res);
      if (b.docId) return await respuestaDoc(p, b, res);
      const decision = DECISIONES.indexOf(b.decision) >= 0 ? b.decision : null;
      if (decision === null) return res.status(400).json({ ok: false, error: 'Respuesta no válida.' });
      const comentario = limpio(b.comentario, 2000), nombre = limpio(b.nombre, 80) || 'Cliente';
      if (!decision && !comentario) return res.status(400).json({ ok: false, error: 'Escribe un comentario o elige una respuesta.' });
      if (decision === 'Cambios solicitados' && !comentario) return res.status(400).json({ ok: false, error: 'Cuéntanos qué cambio quieres.' });
      const itemId = +b.itemId;
      if (!(itemId > 0)) return res.status(400).json({ ok: false, error: 'Producto no válido.' });
      const it = await sb('items?select=id,item,cat,opt_group&project_id=eq.' + encodeURIComponent(p.id) + '&id=eq.' + itemId + '&limit=1');
      if (!it || !it[0] || it[0].cat === 'Honorarios') return res.status(404).json({ ok: false, error: 'Producto no encontrado.' });
      const prod = it[0], fecha = hoySantiago();

      if (decision) {
        const cambio = { client_status: decision === 'Por revisar' ? '' : decision };
        if (decision === 'Aprobado') { cambio.client_approval_date = fecha; if (prod.opt_group) cambio.opt_sel = '1'; }
        await sb('items?project_id=eq.' + encodeURIComponent(p.id) + '&id=eq.' + itemId, { method: 'PATCH', headers: H({ Prefer: 'return=minimal' }), body: JSON.stringify(cambio) });
        // En un grupo de opciones, aprobar una deja a las demas sin elegir
        if (decision === 'Aprobado' && prod.opt_group) {
          await sb('items?project_id=eq.' + encodeURIComponent(p.id) + '&opt_group=eq.' + encodeURIComponent(prod.opt_group) + '&id=neq.' + itemId, { method: 'PATCH', headers: H({ Prefer: 'return=minimal' }), body: JSON.stringify({ opt_sel: '' }) });
        }
      }
      const titulo = (decision === 'Por revisar' ? 'Cliente deshizo su respuesta' : decision ? 'Cliente: ' + decision : 'Comentario del cliente') + ' · ' + (prod.item || 'producto');
      const log = {
        id: Date.now() * 10 + Math.floor(Math.random() * 10), project_id: p.id, date: fecha, type: 'Nota general',
        title: titulo.slice(0, 200), description: comentario, commits: '', responsible: nombre, due_date: '', status: 'Completada',
        amount: 0, category: 'cliente', item_id: itemId,
        extra: JSON.stringify({ cliente: true, decision: decision, autor: 'cliente', at: new Date().toISOString() })
      };
      await sb('logs', { method: 'POST', headers: H({ Prefer: 'return=minimal' }), body: JSON.stringify(log) });
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'Método no permitido' });
  } catch (e) {
    console.error('[portal cliente]', e && e.message);
    return res.status(500).json({ ok: false, error: 'No se pudo completar. Intenta de nuevo en un momento.' });
  }
};
