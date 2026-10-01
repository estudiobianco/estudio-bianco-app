// Estudio Bianco · Lector de productos (Vercel Serverless Function)
//
// GET /api/producto?url=<link del producto>
//   -> { ok, name, price, currency, image, site, url }
//   Lee la pagina de la tienda y saca nombre, precio e imagen desde los datos
//   estructurados que publican las tiendas (JSON-LD de schema.org y etiquetas Open Graph).
//   No adivina: si un dato no esta publicado, lo devuelve vacio.
//
// GET /api/producto?img=<link de la imagen>
//   -> los bytes de la imagen (para que la app la guarde en Supabase Storage).
//
// Solo lee paginas publicas http/https. No guarda nada.

const MAX_HTML = 4 * 1024 * 1024;   // 4 MB de HTML
const MAX_IMG = 8 * 1024 * 1024;    // 8 MB de imagen
const TIMEOUT_MS = 9000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

function urlSegura(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (e) { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const h = u.hostname.toLowerCase();
  // No permitir direcciones internas
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h === '0.0.0.0' ||
      /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.includes(':') || h.startsWith('[')) return null;
  return u;
}

async function traer(url, accept) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, 'Accept': accept, 'Accept-Language': 'es-CL,es;q=0.9,en;q=0.6' }
    });
  } finally { clearTimeout(t); }
}

// ── Lectura del HTML (funcion pura, sin dependencias) ──
function decodificar(s) {
  if (s == null) return '';
  const nombres = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', uuml: 'ü', deg: '°', reg: '®', trade: '™', copy: '©', ordm: 'º', ordf: 'ª', middot: '·', ndash: '–', mdash: '—' };
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+);/gi, (m, n) => (n in nombres ? nombres[n] : m))
    .replace(/\s+/g, ' ').trim();
}

function metas(html) {
  const out = {};
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const key = (/(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i.exec(tag) || [])[1];
    const val = (/content\s*=\s*"([^"]*)"/i.exec(tag) || /content\s*=\s*'([^']*)'/i.exec(tag) || [])[1];
    if (key && val != null && !(key.toLowerCase() in out)) out[key.toLowerCase()] = decodificar(val);
  }
  return out;
}

function productosLD(html) {
  const out = [];
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  function visitar(n) {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(visitar); return; }
    const t = [].concat(n['@type'] || []).map(String);
    if (t.some(x => /^(Product|ProductGroup|IndividualProduct)$/i.test(x))) out.push(n);
    if (n['@graph']) visitar(n['@graph']);
    if (n.mainEntity) visitar(n.mainEntity);
    if (n.itemListElement) visitar(n.itemListElement);
    if (n.item) visitar(n.item);
  }
  while ((m = re.exec(html))) {
    try { visitar(JSON.parse(m[1].trim())); } catch (e) { /* JSON-LD mal formado: se ignora */ }
  }
  return out;
}

function primeraImagen(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return primeraImagen(v[0]);
  return v.url || v.contentUrl || v['@id'] || '';
}

// "1.299.990" / "1299990" / "1299990.00" / 1299990 -> 1299990 (pesos enteros)
function precioNumero(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) && v > 0 ? Math.round(v) : null;
  let s = String(v).replace(/[^\d.,]/g, '');
  if (!s) return null;
  if (/^\d+([.,]\d{1,2})?$/.test(s)) s = s.replace(',', '.');      // 1299990.00 o 1299990,5
  else s = s.replace(/[.,](?=\d{3}(\D|$))/g, '').replace(',', '.'); // 1.299.990 o 1,299,990
  const n = parseFloat(s);
  return isFinite(n) && n > 0 ? Math.round(n) : null;
}

// Precio de la oferta principal (la primera publicada). No se elige el mas bajo,
// porque suele ser un precio exclusivo con tarjeta de la tienda.
function precioOferta(offers) {
  const lista = [].concat(offers || []);
  for (const o of lista) {
    if (!o || typeof o !== 'object') continue;
    const ps = [].concat(o.priceSpecification || [])[0] || {};
    const p = precioNumero(o.price != null ? o.price : (o.lowPrice != null ? o.lowPrice : ps.price));
    if (p != null) return { price: p, currency: o.priceCurrency || ps.priceCurrency || '' };
    if (o.offers) { const sub = precioOferta(o.offers); if (sub) return sub; }
  }
  return null;
}

// ── Especificaciones basicas: medidas, color, material (no todo) ──
function quitarTags(s) { return decodificar(String(s || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')); }
var SPEC_CLAVES = [
  ['Medidas', /^(medidas?|dimensi[oó]n(es)?|tama[nñ]o)(\s|$|\()/i],
  ['Ancho', /^ancho/i],
  ['Alto', /^(alto|altura)/i],
  ['Largo', /^largo/i],
  ['Profundidad', /^(profundidad|fondo)/i],
  ['Diámetro', /^di[aá]metro/i],
  ['Color', /^colou?r(es)?(\s|$|\()/i],
  ['Material', /^materia(l|les)(\s|$|\()/i],
  ['Terminación', /^(terminaci[oó]n|acabado)/i],
  ['Tela', /^(tela|tapiz|tapicer[ií]a|tejido)/i],
  ['Estructura', /^estructura/i]
];
var SPEC_FUERA = /empaque|embalaje|caja|garant|env[ií]o|despacho|sku|c[oó]digo|modelo|marca|peso|cantidad|origen|instalaci|armado|ampolleta|bater/i;
function leerSpecs(html, ld) {
  var pares = [];
  function add(k, v) {
    k = quitarTags(k).replace(/[:：]\s*$/, '').trim();
    v = quitarTags(v).replace(/^[:：]\s*/, '').trim();
    if (!k || !v || k.length > 40 || v.length > 80 || SPEC_FUERA.test(k)) return;
    for (var i = 0; i < SPEC_CLAVES.length; i++) { if (SPEC_CLAVES[i][1].test(k)) { pares.push([k, v, i]); return; } }
  }
  var m, re;
  if (ld) {
    if (ld.color) add('Color', [].concat(ld.color).join(', '));
    if (ld.material) add('Material', [].concat(ld.material).join(', '));
    ['width', 'height', 'depth'].forEach(function (p, i) {
      var q = ld[p];
      if (q) { var v = typeof q === 'object' ? ((q.value != null ? q.value : '') + ' ' + (q.unitText || q.unitCode || '')) : q; add(['Ancho', 'Alto', 'Profundidad'][i], String(v).replace(/\bCMT\b/, 'cm').replace(/\bMMT\b/, 'mm')); }
    });
    [].concat(ld.additionalProperty || []).forEach(function (p) { if (p && p.name) add(p.name, [].concat(p.value != null ? p.value : '').join(', ')); });
  }
  // Algunas tiendas guardan la ficha como HTML escapado dentro de un JSON (ej. Amoble)
  if (/<\\\//.test(html)) html = html + ' ' + html.replace(/\\\//g, '/').replace(/\\"/g, '"');
  // "<strong>Largo:</strong> 240 cm"
  re = /<(strong|b)[^>]*>\s*([^<]{2,40}?)\s*:?\s*<\/\1>\s*:?\s*([^<]{1,80})/gi; while ((m = re.exec(html))) add(m[2], m[3]);
  re = /<tr[^>]*>\s*<t[hd][^>]*>([\s\S]{1,200}?)<\/t[hd]>\s*<td[^>]*>([\s\S]{1,300}?)<\/td>/gi; while ((m = re.exec(html))) add(m[1], m[2]);
  re = /<dt[^>]*>([\s\S]{1,200}?)<\/dt>\s*<dd[^>]*>([\s\S]{1,300}?)<\/dd>/gi; while ((m = re.exec(html))) add(m[1], m[2]);
  re = /"name"\s*:\s*"([^"]{2,40})"\s*,\s*"values?"\s*:\s*\[?\s*"([^"]{1,80})"/gi; while ((m = re.exec(html))) add(m[1], m[2]);
  var textos = [];
  re = /<li[^>]*>([\s\S]{1,300}?)<\/li>/gi; while ((m = re.exec(html))) textos.push(quitarTags(m[1]));
  if (ld && ld.description) textos = textos.concat(quitarTags(String(ld.description).replace(/<br\s*\/?>|<\/p>|<\/li>|\r?\n/gi, ' • ')).split(/•|·|;|\s-\s/));
  textos.forEach(function (t) { var mm = /^\s*([A-Za-zÁÉÍÓÚáéíóúÑñ ()]{3,30})\s*[:：]\s*(.{1,80})$/.exec(String(t).trim()); if (mm) add(mm[1], mm[2]); });
  var vistos = {}, out = [];
  pares.sort(function (a, b) { return a[2] - b[2]; }).forEach(function (p) {
    var c = SPEC_CLAVES[p[2]][0]; if (vistos[c]) return; vistos[c] = 1;
    var k = p[0], v = p[1];
    var u = /\((cm|mm|mts?|m)\)/i.exec(k);
    if (u && /^[\d.,\s]+$/.test(v)) v = v.trim() + ' ' + u[1].toLowerCase();
    k = k.replace(/\s*\([^)]*\)\s*$/, '').trim();
    k = k.charAt(0).toUpperCase() + k.slice(1).toLowerCase();
    out.push(k + ': ' + v);
  });
  return out.slice(0, 7).join(' · ');
}

function leerProducto(html, urlFinal) {
  const meta = metas(html);
  const lds = productosLD(html);
  const ld = lds[0] || {};
  let name = decodificar(ld.name || meta['og:title'] || meta['twitter:title'] || ((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1]) || '');
  const site = decodificar(meta['og:site_name'] || '');
  // Quitar " | Tienda" o " - Tienda" al final del titulo
  if (name && site) name = name.replace(new RegExp('\\s*[|\\-–—]\\s*' + site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '.*$', 'i'), '').trim();
  name = name.replace(/\s*[|]\s*[^|]{2,40}$/, '').trim();

  let precio = null;
  for (const p of lds) { const o = precioOferta(p.offers); if (o) { precio = o; break; } }
  if (!precio) {
    const p = precioNumero(meta['product:price:amount'] || meta['og:price:amount'] || meta['price']);
    if (p != null) precio = { price: p, currency: meta['product:price:currency'] || meta['og:price:currency'] || meta['pricecurrency'] || '' };
  }

  let image = primeraImagen(ld.image) || meta['og:image'] || meta['og:image:secure_url'] || meta['twitter:image'] || meta['image'] || '';
  if (image) { try { image = new URL(decodificar(image), urlFinal).href; } catch (e) { image = ''; } }

  return {
    name: name.slice(0, 200),
    price: precio ? precio.price : null,
    currency: precio ? (String(precio.currency || '').toUpperCase() || 'CLP') : '',
    image,
    site,
    specs: leerSpecs(html, lds[0] || null)
  };
}

module.exports = async function handler(req, res) {
  const q = req.query || {};
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Modo imagen: devolver los bytes para guardarla en Storage
  if (q.img) {
    const u = urlSegura(q.img);
    if (!u) return res.status(400).json({ ok: false, error: 'Link de imagen no valido' });
    try {
      const r = await traer(u.href, 'image/avif,image/webp,image/*,*/*;q=0.8');
      const tipo = (r.headers.get('content-type') || '').split(';')[0];
      if (!r.ok || !/^image\//.test(tipo)) return res.status(502).json({ ok: false, error: 'La tienda no entrego la imagen' });
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_IMG) return res.status(413).json({ ok: false, error: 'Imagen muy pesada' });
      res.setHeader('Content-Type', tipo);
      res.setHeader('Cache-Control', 's-maxage=86400');
      return res.status(200).send(buf);
    } catch (e) {
      return res.status(504).json({ ok: false, error: 'La tienda demoro demasiado en responder' });
    }
  }

  // Modo producto
  const u = urlSegura(q.url);
  if (!u) return res.status(400).json({ ok: false, error: 'Link no valido' });
  try {
    const r = await traer(u.href, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8');
    if (!r.ok) return res.status(200).json({ ok: false, error: 'La tienda respondio con error ' + r.status + ' (puede estar bloqueando lecturas automaticas)' });
    let html = await r.text();
    if (html.length > MAX_HTML) html = html.slice(0, MAX_HTML);
    const datos = leerProducto(html, r.url || u.href);
    res.setHeader('Cache-Control', 's-maxage=3600');
    return res.status(200).json(Object.assign({ ok: !!(datos.name || datos.price || datos.image), url: r.url || u.href }, datos));
  } catch (e) {
    return res.status(200).json({ ok: false, error: 'No se pudo abrir la pagina (la tienda demoro o la bloqueo)' });
  }
};

module.exports.leerProducto = leerProducto;
