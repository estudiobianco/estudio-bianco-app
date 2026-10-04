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
const DECISIONES = ['Aprobado', 'Cambios solicitados', 'Rechazado', ''];
const CAMPOS_ITEM = 'id,cat,item,supplier,qty,unit,space,specs,product_url,image_url,delivery_status,client_status,opt_group,opt_sel';

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

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  if (!llave()) return res.status(503).json({ ok: false, error: 'El portal aún no está configurado (falta la llave privada en Vercel).' });

  try {
    if (req.method === 'GET') {
      const p = await proyectoDe((req.query || {}).k);
      if (!p) return res.status(404).json({ ok: false, error: 'Este link no es válido o fue desactivado.' });
      const items = (await sb('items?select=' + CAMPOS_ITEM + '&project_id=eq.' + encodeURIComponent(p.id) + '&cat=neq.Honorarios&order=id')) || [];
      const resp = (await sb('logs?select=id,date,title,description,responsible,item_id,extra&project_id=eq.' + encodeURIComponent(p.id) + '&category=eq.cliente&order=id.desc&limit=200')) || [];
      return res.status(200).json({
        ok: true,
        proyecto: { nombre: p.name || '', cliente: p.client || '' },
        items: items.map(x => ({
          id: x.id, cat: x.cat || '', item: x.item || '', proveedor: x.supplier || '', cant: x.qty || 1, precio: x.unit || 0,
          espacio: x.space || '', specs: x.specs || '', link: x.product_url || '', imagen: x.image_url || '',
          entrega: x.delivery_status || 'Por pedir', estado: x.client_status || '', grupo: x.opt_group || '', elegida: x.opt_sel === '1'
        })),
        respuestas: resp.map(l => {
          let ex = {}; try { ex = l.extra ? JSON.parse(l.extra) : {}; } catch (e) {}
          return { id: l.id, fecha: l.date, itemId: l.item_id || 0, decision: ex.decision || '', comentario: l.description || '', nombre: l.responsible || '', autor: ex.autor || 'cliente' };
        })
      });
    }

    if (req.method === 'POST') {
      let b = req.body || {};
      if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
      const p = await proyectoDe(b.k);
      if (!p) return res.status(404).json({ ok: false, error: 'Este link no es válido o fue desactivado.' });
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
        const cambio = { client_status: decision };
        if (decision === 'Aprobado') { cambio.client_approval_date = fecha; if (prod.opt_group) cambio.opt_sel = '1'; }
        await sb('items?project_id=eq.' + encodeURIComponent(p.id) + '&id=eq.' + itemId, { method: 'PATCH', headers: H({ Prefer: 'return=minimal' }), body: JSON.stringify(cambio) });
        // En un grupo de opciones, aprobar una deja a las demas sin elegir
        if (decision === 'Aprobado' && prod.opt_group) {
          await sb('items?project_id=eq.' + encodeURIComponent(p.id) + '&opt_group=eq.' + encodeURIComponent(prod.opt_group) + '&id=neq.' + itemId, { method: 'PATCH', headers: H({ Prefer: 'return=minimal' }), body: JSON.stringify({ opt_sel: '' }) });
        }
      }
      const titulo = (decision ? 'Cliente: ' + decision : 'Comentario del cliente') + ' · ' + (prod.item || 'producto');
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
