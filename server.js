// Servidor para Railway: sirve la app, el login, la lectura de fotos y las planillas (Postgres).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const leer = require('./api/leer.js');

// Usuario inicial: se usa para crear el primer administrador cuando la tabla de usuarios está vacía,
// o como único usuario si no hay base de datos conectada. No hay valores por defecto en el código.
const USER = process.env.APP_USER || '';
const PASS = process.env.APP_PASS || '';
let SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex');
const sign = t => crypto.createHmac('sha256', SECRET).update(t).digest('hex');
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const scrypt = (pw, salt) => new Promise((ok, ko) => crypto.scrypt(pw, salt, 64, (e, k) => e ? ko(e) : ok(k)));
async function hashPass(pw) { const salt = crypto.randomBytes(16).toString('hex'); return salt + ':' + (await scrypt(pw, salt)).toString('hex'); }
async function checkPass(pw, stored) { const [salt, h] = String(stored).split(':'); return !!h && same((await scrypt(pw, salt)).toString('hex'), h); }
const vOf = u => crypto.createHash('sha256').update(u.pass_hash).digest('hex').slice(0, 12);   // cambia al cambiar la contraseña
const makeToken = u => {
  const p = Buffer.from(JSON.stringify({ u: u.id, e: Date.now() + 30 * 864e5, v: vOf(u) })).toString('base64url');
  return p + '.' + sign(p);
};
const ENV_USER = { id: 0, nombre: USER, es_admin: true, pass_hash: 'env:' + PASS };
const ENV_CONFIGURADO = !!(USER && PASS);

const E = process.env;
const DB_URL = E.DATABASE_URL || E.DATABASE_PRIVATE_URL || E.DATABASE_PUBLIC_URL ||
  (E.PGHOST && E.PGUSER && E.PGPASSWORD ? `postgres://${encodeURIComponent(E.PGUSER)}:${encodeURIComponent(E.PGPASSWORD)}@${E.PGHOST}:${E.PGPORT || 5432}/${E.PGDATABASE || 'railway'}` : null);
console.log(DB_URL ? 'Base de datos: configurada' : 'Base de datos: NO configurada (falta DATABASE_URL en este servicio)');
const pool = DB_URL ? new Pool({
  connectionString: DB_URL,
  ssl: /railway\.internal|localhost|127\.0\.0\.1/.test(DB_URL) ? false : { rejectUnauthorized: false },
}) : null;
let modo = pool ? 'pendiente' : 'env';   // 'env' = un solo usuario por variables; 'db' = usuarios en la base; 'error'
const dbReady = pool ? (async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS planillas (
    id SERIAL PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{"clients":[]}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS usuarios (
    id SERIAL PRIMARY KEY, nombre TEXT NOT NULL, pass_hash TEXT NOT NULL,
    es_admin BOOLEAN NOT NULL DEFAULT false, creado TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS usuarios_nombre_idx ON usuarios (lower(nombre))');
  await pool.query('CREATE TABLE IF NOT EXISTS config (clave TEXT PRIMARY KEY, valor TEXT NOT NULL)');
  const n = (await pool.query('SELECT count(*)::int AS n FROM usuarios')).rows[0].n;
  if (!n) {
    // primer arranque: administrador de APP_USER/APP_PASS o, si no están definidos, uno con contraseña aleatoria (se muestra una sola vez en el log)
    const nombre = USER || 'admin', clave = PASS || crypto.randomBytes(9).toString('base64url');
    await pool.query('INSERT INTO usuarios (nombre, pass_hash, es_admin) VALUES ($1,$2,true) ON CONFLICT DO NOTHING', [nombre, await hashPass(clave)]);
    if (!PASS) console.log(`Usuario inicial creado: ${nombre} / contraseña temporal: ${clave} (cambiala en Configuración)`);
  }
  await pool.query("INSERT INTO config (clave, valor) VALUES ('secret', $1) ON CONFLICT DO NOTHING", [crypto.randomBytes(32).toString('hex')]);
  if (!process.env.AUTH_SECRET) SECRET = (await pool.query("SELECT valor FROM config WHERE clave='secret'")).rows[0].valor;
  modo = 'db';
})().catch(e => { modo = 'error'; console.error('DB:', e.message); }) : null;

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

const NOMBRE_OK = /^[\p{L}\p{N}._-]{3,30}$/u;
const publico = u => ({ id: u.id, nombre: u.nombre, admin: !!u.es_admin });
async function usuarioPorId(id) {
  if (modo === 'env') return Number(id) === 0 ? ENV_USER : null;
  const r = await pool.query('SELECT id, nombre, es_admin, pass_hash FROM usuarios WHERE id=$1', [id]);
  return r.rows[0] || null;
}
// null = token inválido; lanza error si la base no responde (para no cerrar la sesión por un corte)
async function authUser(h) {
  const [p, sig] = String(h || '').replace(/^Bearer /, '').split('.');
  if (!p || !sig || !same(sig, sign(p))) return null;
  let d; try { d = JSON.parse(Buffer.from(p, 'base64url').toString()); } catch { return null; }
  if (!(d.e > Date.now())) return null;
  const u = await usuarioPorId(d.u);
  return u && d.v === vOf(u) ? u : null;
}
const fallos = new Map();   // intentos fallidos de login: clave -> [horas]
function bloqueado(k) { const t = (fallos.get(k) || []).filter(x => Date.now() - x < 10 * 60 * 1000); fallos.set(k, t); return t.length >= 8; }

async function login(req, res) {
  const b = await body(req, 1e4);
  const nombre = typeof b.user === 'string' ? b.user.trim() : '', pass = typeof b.pass === 'string' ? b.pass : '';
  const key = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '') .split(',')[0].trim() + '|' + nombre.toLowerCase();
  if (bloqueado(key)) return send(res, 429, { error: 'Demasiados intentos. Probá de nuevo en unos minutos.' });
  if (dbReady) await dbReady;
  if (modo === 'error' || modo === 'pendiente') return send(res, 503, { error: 'El servidor no pudo conectarse a la base de datos. Probá de nuevo en un minuto.' });
  let u = null;
  if (modo === 'env') {
    if (!ENV_CONFIGURADO) return send(res, 503, { error: 'El servidor no tiene usuario configurado.' });
    if (nombre && same(nombre, USER) && same(pass, PASS)) u = ENV_USER;
  }
  else {
    const r = await pool.query('SELECT id, nombre, es_admin, pass_hash FROM usuarios WHERE lower(nombre)=lower($1)', [nombre]);
    if (r.rows[0] && await checkPass(pass, r.rows[0].pass_hash)) u = r.rows[0];
  }
  if (!u) { fallos.get(key).push(Date.now()); return send(res, 401, { error: 'Usuario o contraseña incorrectos' }); }
  fallos.delete(key);
  send(res, 200, { token: makeToken(u), user: u.nombre, admin: !!u.es_admin });
}

async function cuentas(req, res, url, yo) {
  const sinDb = () => send(res, 503, { error: 'Disponible cuando la base de datos esté conectada.' });
  if (url === '/api/yo' && req.method === 'GET') return send(res, 200, { ...publico(yo), gestion: modo === 'db' });
  if (modo !== 'db') return sinDb();
  const dup = e => e.code === '23505' ? send(res, 409, { error: 'Ya existe un usuario con ese nombre.' }) : Promise.reject(e);
  if (url === '/api/yo' && req.method === 'PUT') {
    const b = await body(req, 1e4);
    let nombre = yo.nombre, hash = yo.pass_hash;
    if (typeof b.nombre === 'string' && b.nombre.trim() !== yo.nombre) {
      if (!NOMBRE_OK.test(b.nombre.trim())) return send(res, 400, { error: 'El nombre debe tener entre 3 y 30 caracteres: letras, números, punto, guion o guion bajo, sin espacios.' });
      nombre = b.nombre.trim();
    }
    if (b.passNueva) {
      if (typeof b.passNueva !== 'string' || b.passNueva.length < 6) return send(res, 400, { error: 'La contraseña nueva debe tener al menos 6 caracteres.' });
      if (!(await checkPass(String(b.passActual || ''), yo.pass_hash))) return send(res, 400, { error: 'La contraseña actual no es correcta.' });
      hash = await hashPass(b.passNueva);
    }
    try { await pool.query('UPDATE usuarios SET nombre=$2, pass_hash=$3 WHERE id=$1', [yo.id, nombre, hash]); } catch (e) { return dup(e); }
    const u = { ...yo, nombre, pass_hash: hash };
    return send(res, 200, { user: publico(u), token: makeToken(u) });
  }
  if (!yo.es_admin) return send(res, 403, { error: 'Solo el administrador puede gestionar usuarios.' });
  if (url === '/api/usuarios' && req.method === 'GET') {
    const r = await pool.query('SELECT id, nombre, es_admin FROM usuarios ORDER BY id');
    return send(res, 200, { usuarios: r.rows.map(x => ({ id: x.id, nombre: x.nombre, admin: x.es_admin })) });
  }
  if (url === '/api/usuarios' && req.method === 'POST') {
    const b = await body(req, 1e4);
    const nombre = String(b.nombre || '').trim();
    if (!NOMBRE_OK.test(nombre)) return send(res, 400, { error: 'El nombre debe tener entre 3 y 30 caracteres: letras, números, punto, guion o guion bajo, sin espacios.' });
    if (typeof b.pass !== 'string' || b.pass.length < 6) return send(res, 400, { error: 'La contraseña debe tener al menos 6 caracteres.' });
    try { await pool.query('INSERT INTO usuarios (nombre, pass_hash, es_admin) VALUES ($1,$2,false)', [nombre, await hashPass(b.pass)]); } catch (e) { return dup(e); }
    return send(res, 200, { ok: true });
  }
  const m = /^\/api\/usuarios\/(\d+)(\/pass)?$/.exec(url);
  if (m && m[2] && req.method === 'PUT') {
    const b = await body(req, 1e4);
    if (typeof b.pass !== 'string' || b.pass.length < 6) return send(res, 400, { error: 'La contraseña debe tener al menos 6 caracteres.' });
    const r = await pool.query('UPDATE usuarios SET pass_hash=$2 WHERE id=$1', [m[1], await hashPass(b.pass)]);
    return r.rowCount ? send(res, 200, { ok: true }) : send(res, 404, { error: 'No existe ese usuario.' });
  }
  if (m && !m[2] && req.method === 'DELETE') {
    if (Number(m[1]) === yo.id) return send(res, 400, { error: 'No podés borrar tu propio usuario.' });
    const r = await pool.query('DELETE FROM usuarios WHERE id=$1', [m[1]]);
    return r.rowCount ? send(res, 200, { ok: true }) : send(res, 404, { error: 'No existe ese usuario.' });
  }
  return send(res, 404, { error: 'No encontrado' });
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
      return await login(req, res);
    }
    if (url.startsWith('/api/')) {
      if (dbReady) await dbReady;
      let yo;
      try { yo = await authUser(req.headers.authorization); }
      catch (e) { console.error(e); return send(res, 503, { error: 'Sin conexión con la base de datos.' }); }
      if (!yo) return send(res, 401, { error: 'No autorizado' });
      if (url === '/api/yo' || url.startsWith('/api/usuarios')) return await cuentas(req, res, url, yo);
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
