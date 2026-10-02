// Servidor para Railway: sirve la app, el login, la lectura de fotos y las planillas (Postgres).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const leer = require('./api/leer.js');

const USER = process.env.APP_USER || 'kevin';
const PASS = process.env.APP_PASS || 'kevin123';
const SECRET = process.env.AUTH_SECRET || 'reparto-netle-' + PASS;
const sign = t => crypto.createHmac('sha256', SECRET).update(t).digest('hex');
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const makeToken = () => { const exp = Date.now() + 30 * 864e5; return exp + '.' + sign(String(exp)); };
function validToken(h) {
  const [exp, sig] = (h || '').replace(/^Bearer /, '').split('.');
  return !!sig && Number(exp) > Date.now() && same(sig, sign(exp));
}

const E = process.env;
const DB_URL = E.DATABASE_URL || E.DATABASE_PRIVATE_URL || E.DATABASE_PUBLIC_URL ||
  (E.PGHOST && E.PGUSER && E.PGPASSWORD ? `postgres://${encodeURIComponent(E.PGUSER)}:${encodeURIComponent(E.PGPASSWORD)}@${E.PGHOST}:${E.PGPORT || 5432}/${E.PGDATABASE || 'railway'}` : null);
console.log(DB_URL ? 'Base de datos: configurada' : 'Base de datos: NO configurada (falta DATABASE_URL en este servicio)');
const pool = DB_URL ? new Pool({
  connectionString: DB_URL,
  ssl: /railway\.internal|localhost|127\.0\.0\.1/.test(DB_URL) ? false : { rejectUnauthorized: false },
}) : null;
const dbReady = pool ? pool.query(`CREATE TABLE IF NOT EXISTS planillas (
  id SERIAL PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{"clients":[]}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`).catch(e => console.error('DB:', e.message)) : null;

const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.js': 'text/javascript; charset=utf-8' };
const FILES = ['index.html', 'manifest.json', 'icon.svg', 'sw.js', 'icon-192.png', 'icon-512.png', 'icon-maskable.png', 'apple-touch-icon.png'];

// Límite de lectura de fotos: 3 cada 10 minutos (ventana deslizante, común a toda la app).
const FOTOS_MAX = 3, FOTOS_VENTANA = 10 * 60 * 1000;
let fotos = [];
function fotosEstado() {
  const ahora = Date.now();
  fotos = fotos.filter(t => ahora - t < FOTOS_VENTANA);
  return { restantes: Math.max(0, FOTOS_MAX - fotos.length), espera: fotos.length ? Math.ceil((fotos[0] + FOTOS_VENTANA - ahora) / 60000) : 0 };
}

const send = (res, code, obj) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
function body(req, limit = 15e6) {
  return new Promise(ok => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > limit) req.destroy(); });
    req.on('end', () => { try { ok(JSON.parse(raw || '{}')); } catch { ok({}); } });
  });
}

async function planillas(req, res, url) {
  if (!pool) return send(res, 503, { error: 'Base de datos no configurada' });
  await dbReady;
  const m = /^\/api\/planillas(?:\/(\d+|ultima))?$/.exec(url);
  if (!m) return send(res, 404, { error: 'No encontrado' });
  const id = m[1];
  if (!id && req.method === 'GET') {
    const r = await pool.query(`SELECT id, created_at, updated_at,
      jsonb_array_length(data->'clients') AS clientes,
      (SELECT COALESCE(SUM((c->>'total')::numeric),0) FROM jsonb_array_elements(data->'clients') c) AS total
      FROM planillas ORDER BY id DESC LIMIT 60`);
    return send(res, 200, { planillas: r.rows });
  }
  if (!id && req.method === 'POST') {
    const b = await body(req);
    const r = await pool.query('INSERT INTO planillas (data) VALUES ($1) RETURNING id', [JSON.stringify({ clients: Array.isArray(b.clients) ? b.clients : [] })]);
    return send(res, 200, { id: r.rows[0].id });
  }
  if (id === 'ultima' && req.method === 'GET') {
    const r = await pool.query('SELECT id, data FROM planillas ORDER BY id DESC LIMIT 1');
    return send(res, 200, r.rows[0] || {});
  }
  if (id && req.method === 'GET') {
    const r = await pool.query('SELECT id, data FROM planillas WHERE id=$1', [id]);
    return r.rows[0] ? send(res, 200, r.rows[0]) : send(res, 404, { error: 'No existe' });
  }
  if (id && req.method === 'PUT') {
    const b = await body(req);
    if (!Array.isArray(b.clients)) return send(res, 400, { error: 'Datos inválidos' });
    await pool.query('UPDATE planillas SET data=$2, updated_at=now() WHERE id=$1', [id, JSON.stringify({ clients: b.clients })]);
    return send(res, 200, { ok: true });
  }
  if (id && req.method === 'DELETE') {
    await pool.query('DELETE FROM planillas WHERE id=$1', [id]);
    return send(res, 200, { ok: true });
  }
  send(res, 405, { error: 'Método no permitido' });
}

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  try {
    if (url === '/api/login' && req.method === 'POST') {
      const b = await body(req, 1e4);
      const ok = typeof b.user === 'string' && typeof b.pass === 'string' && same(b.user, USER) && same(b.pass, PASS);
      return send(res, ok ? 200 : 401, ok ? { token: makeToken(), user: USER } : { error: 'Usuario o contraseña incorrectos' });
    }
    if (url.startsWith('/api/')) {
      if (!validToken(req.headers.authorization)) return send(res, 401, { error: 'No autorizado' });
      if (url === '/api/leer') {
        req.body = await body(req);
        const est = fotosEstado();
        if (!est.restantes) return send(res, 429, { error: `Límite alcanzado: solo se pueden leer ${FOTOS_MAX} fotos cada 10 minutos. Probá de nuevo en ${est.espera} min.`, restantes: 0 });
        fotos.push(Date.now());
        res.status = c => { res.statusCode = c; return res; };
        res.json = o => send(res, res.statusCode || 200, res.statusCode >= 400 ? o : { ...o, restantes: fotosEstado().restantes });
        await leer(req, res);
        if (res.statusCode >= 400) fotos.pop();   // si falló, no gasta el cupo
        return;
      }
      return await planillas(req, res, url);
    }
    const name = url === '/' ? 'index.html' : url.slice(1);
    if (!FILES.includes(name)) { res.statusCode = 404; return res.end('No encontrado'); }
    res.setHeader('content-type', TYPES[path.extname(name)]);
    if (name === 'sw.js' || name === 'index.html') res.setHeader('cache-control', 'no-cache');
    fs.createReadStream(path.join(__dirname, name)).pipe(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'Error interno' });
  }
}).listen(process.env.PORT || 3000);
