// Servidor para Railway: sirve la app, el login, la lectura de fotos y las planillas (Postgres).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const leer = require('./api/leer.js');
const Logic = require('./logic.js');

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
  await pool.query('ALTER TABLE planillas ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1');
  await pool.query('ALTER TABLE planillas ADD COLUMN IF NOT EXISTS usuario_id INTEGER');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS usuarios_nombre_idx ON usuarios (lower(nombre))');
  await pool.query('CREATE TABLE IF NOT EXISTS config (clave TEXT PRIMARY KEY, valor TEXT NOT NULL)');
  const n = (await pool.query('SELECT count(*)::int AS n FROM usuarios')).rows[0].n;
  if (!n) {
    // primer arranque: administrador de APP_USER/APP_PASS o, si no están definidos, uno con contraseña aleatoria (se muestra una sola vez en el log)
    const nombre = USER || 'admin', clave = PASS || crypto.randomBytes(9).toString('base64url');
    await pool.query('INSERT INTO usuarios (nombre, pass_hash, es_admin) VALUES ($1,$2,true) ON CONFLICT DO NOTHING', [nombre, await hashPass(clave)]);
    if (!PASS) console.log(`Usuario inicial creado: ${nombre} / contraseña temporal: ${clave} (cambiala en Configuración)`);
  }
  // las planillas anteriores (de cuando eran compartidas) pasan al administrador, que es el primer usuario
  await pool.query('UPDATE planillas SET usuario_id = (SELECT id FROM usuarios ORDER BY id LIMIT 1) WHERE usuario_id IS NULL');
  await pool.query("INSERT INTO config (clave, valor) VALUES ('secret', $1) ON CONFLICT DO NOTHING", [crypto.randomBytes(32).toString('hex')]);
  if (!process.env.AUTH_SECRET) SECRET = (await pool.query("SELECT valor FROM config WHERE clave='secret'")).rows[0].valor;
  modo = 'db';
})().catch(e => { modo = 'error'; console.error('DB:', e.message); }) : null;

const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const FILES = ['index.html', 'app.js', 'logic.js', 'styles.css', 'manifest.json', 'sw.js', 'icon-192.png', 'icon-512.png', 'icon-maskable.png', 'apple-touch-icon.png'];

// Límite de lectura de fotos: 3 cada 10 minutos por usuario (ventana deslizante).
const FOTOS_MAX = 3, FOTOS_VENTANA = 10 * 60 * 1000;
const fotos = new Map();
function fotosEstado(uid) {
  const ahora = Date.now(), t = (fotos.get(uid) || []).filter(x => ahora - x < FOTOS_VENTANA);
  fotos.set(uid, t);
  return { t, restantes: Math.max(0, FOTOS_MAX - t.length), espera: t.length ? Math.ceil((t[0] + FOTOS_VENTANA - ahora) / 60000) : 0 };
}

// Cabeceras de seguridad en todas las respuestas (la app no carga nada externo).
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
function cabeceras(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=()');
  res.setHeader('Content-Security-Policy', CSP);
  if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=15552000');
}

// IP del cliente. Detrás de un proxy (Railway) se toma la que agregó el proxy, que es la última de X-Forwarded-For;
// las anteriores las puede inventar el cliente. TRUST_PROXY_HOPS=0 ignora la cabecera (conexión directa).
const HOPS = process.env.TRUST_PROXY_HOPS === undefined ? 1 : Number(process.env.TRUST_PROXY_HOPS);
function ipCliente(req) {
  const xs = String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
  return HOPS > 0 && xs.length ? xs[Math.max(0, xs.length - HOPS)] : (req.socket.remoteAddress || '');
}
// Si el proxy no deja ver la IP real (llega una dirección privada), no se limita por IP: así no se bloquea a todos juntos.
const esPrivada = ip => /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd][0-9a-f]{2}:|::ffff:(10\.|127\.|192\.168\.))/i.test(ip) || !ip;
const VENTANA = 10 * 60 * 1000;
const porIp = new Map(), porUsuario = new Map();   // intentos de login fallidos
function recientes(m, k) { const t = (m.get(k) || []).filter(x => Date.now() - x < VENTANA); if (t.length) m.set(k, t); else m.delete(k); return t; }
setInterval(() => { for (const m of [porIp, porUsuario]) for (const k of [...m.keys()]) recientes(m, k); }, 60 * 1000).unref();
const dormir = ms => new Promise(ok => setTimeout(ok, ms));
let hashFalso = null;   // para que "usuario inexistente" tarde lo mismo que "contraseña incorrecta"
hashPass('contraseña-de-relleno').then(h => { hashFalso = h; });

const send = (res, code, obj) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(obj)); };
function body(req, limit = 15e6) {
  return new Promise(ok => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > limit) req.destroy(); });
    req.on('end', () => { try { ok(JSON.parse(raw || '{}')); } catch { ok({}); } });
  });
}

// Ajuste del administrador: por defecto las planillas son compartidas (todos ven las mismas, como siempre);
// si se desactiva, cada usuario ve solo las suyas.
async function planillasCompartidas() {
  const r = await pool.query("SELECT valor FROM config WHERE clave='compartidas'");
  return !r.rows[0] || r.rows[0].valor !== '0';
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
  const ip = ipCliente(req), clave = nombre.toLowerCase();
  if (!esPrivada(ip) && recientes(porIp, ip).length >= 20) return send(res, 429, { error: 'Demasiados intentos. Probá de nuevo en unos minutos.' });
  const previos = recientes(porUsuario, clave).length;
  if (previos > 3) await dormir(Math.min(5000, (previos - 3) * 500));   // frena la fuerza bruta sin dejar a nadie afuera
  if (dbReady) await dbReady;
  if (modo === 'error' || modo === 'pendiente') return send(res, 503, { error: 'El servidor no pudo conectarse a la base de datos. Probá de nuevo en un minuto.' });
  if (modo === 'env' && !ENV_CONFIGURADO) return send(res, 503, { error: 'El servidor no tiene usuario configurado.' });
  let u = null, hash = hashFalso || 'x:x';
  if (modo === 'env') { if (nombre && same(nombre, USER)) hash = null; }
  else {
    const r = await pool.query('SELECT id, nombre, es_admin, pass_hash FROM usuarios WHERE lower(nombre)=lower($1)', [nombre]);
    if (r.rows[0]) { u = r.rows[0]; hash = u.pass_hash; }
  }
  let ok = false;
  if (modo === 'env') { ok = hash === null && same(pass, PASS); await checkPass(pass, hashFalso || 'x:x'); if (ok) u = ENV_USER; }
  else ok = await checkPass(pass, hash) && !!u;   // siempre se calcula el hash: el tiempo no revela si el usuario existe
  if (!ok) {
    for (const [m, k] of [[porIp, ip], [porUsuario, clave]]) { if (m === porIp && esPrivada(ip)) continue; const t = m.get(k) || []; t.push(Date.now()); m.set(k, t); }
    return send(res, 401, { error: 'Usuario o contraseña incorrectos' });
  }
  porUsuario.delete(clave);
  send(res, 200, { token: makeToken(u), user: u.nombre, admin: !!u.es_admin });
}

async function cuentas(req, res, url, yo) {
  const sinDb = () => send(res, 503, { error: 'Disponible cuando la base de datos esté conectada.' });
  if (url === '/api/yo' && req.method === 'GET') return send(res, 200, { ...publico(yo), gestion: modo === 'db', compartidas: modo === 'db' ? await planillasCompartidas() : true });
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
      if (typeof b.passNueva !== 'string' || b.passNueva.length < 8) return send(res, 400, { error: 'La contraseña nueva debe tener al menos 8 caracteres.' });
      if (!(await checkPass(String(b.passActual || ''), yo.pass_hash))) return send(res, 400, { error: 'La contraseña actual no es correcta.' });
      hash = await hashPass(b.passNueva);
    }
    try { await pool.query('UPDATE usuarios SET nombre=$2, pass_hash=$3 WHERE id=$1', [yo.id, nombre, hash]); } catch (e) { return dup(e); }
    const u = { ...yo, nombre, pass_hash: hash };
    return send(res, 200, { user: publico(u), token: makeToken(u) });
  }
  if (!yo.es_admin) return send(res, 403, { error: 'Solo el administrador puede gestionar usuarios.' });
  if (url === '/api/ajustes' && req.method === 'PUT') {
    const b = await body(req, 1e3);
    if (typeof b.compartidas !== 'boolean') return send(res, 400, { error: 'Dato inválido.' });
    await pool.query("INSERT INTO config (clave, valor) VALUES ('compartidas', $1) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor", [b.compartidas ? '1' : '0']);
    return send(res, 200, { compartidas: b.compartidas });
  }
  if (url === '/api/usuarios' && req.method === 'GET') {
    const r = await pool.query('SELECT id, nombre, es_admin FROM usuarios ORDER BY id');
    return send(res, 200, { usuarios: r.rows.map(x => ({ id: x.id, nombre: x.nombre, admin: x.es_admin })) });
  }
  if (url === '/api/usuarios' && req.method === 'POST') {
    const b = await body(req, 1e4);
    const nombre = String(b.nombre || '').trim();
    if (!NOMBRE_OK.test(nombre)) return send(res, 400, { error: 'El nombre debe tener entre 3 y 30 caracteres: letras, números, punto, guion o guion bajo, sin espacios.' });
    if (typeof b.pass !== 'string' || b.pass.length < 8) return send(res, 400, { error: 'La contraseña debe tener al menos 8 caracteres.' });
    try { await pool.query('INSERT INTO usuarios (nombre, pass_hash, es_admin) VALUES ($1,$2,false)', [nombre, await hashPass(b.pass)]); } catch (e) { return dup(e); }
    return send(res, 200, { ok: true });
  }
  const m = /^\/api\/usuarios\/(\d+)(\/pass)?$/.exec(url);
  if (m && m[2] && req.method === 'PUT') {
    const b = await body(req, 1e4);
    if (typeof b.pass !== 'string' || b.pass.length < 8) return send(res, 400, { error: 'La contraseña debe tener al menos 8 caracteres.' });
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

// Cada usuario ve y edita solo sus planillas; el administrador puede ver y abrir todas.
async function planillas(req, res, url, yo) {
  if (!pool) return send(res, 503, { error: 'Base de datos no configurada' });
  await dbReady;
  const m = /^\/api\/planillas(?:\/(\d+|ultima))?$/.exec(url);
  if (!m) return send(res, 404, { error: 'No encontrado' });
  const id = m[1];
  const admin = !!yo.es_admin;
  const compartidas = await planillasCompartidas();
  // $1 = id del usuario. Compartidas: todos ven todo. Por usuario: cada uno ve las suyas y el administrador todas.
  const acceso = (compartidas || admin) ? '$1::int IS NOT NULL' : 'p.usuario_id = $1';
  if (!id && req.method === 'GET') {
    const r = await pool.query(`SELECT p.id, p.created_at, p.updated_at, u.nombre AS usuario,
      jsonb_array_length(p.data->'clients') AS clientes,
      (SELECT COALESCE(SUM((c->>'total')::numeric),0) FROM jsonb_array_elements(p.data->'clients') c) AS total
      FROM planillas p LEFT JOIN usuarios u ON u.id = p.usuario_id
      WHERE ${acceso} ORDER BY p.id DESC LIMIT 60`, [yo.id]);
    return send(res, 200, { planillas: r.rows.map(x => admin ? x : { ...x, usuario: undefined }), todas: admin });
  }
  if (!id && req.method === 'POST') {
    const b = await body(req, 2e6);
    const v = Logic.limpiarClientes(b.clients === undefined ? [] : b.clients);
    if (!v.ok) return send(res, 400, { error: v.error });
    const r = await pool.query('INSERT INTO planillas (data, usuario_id) VALUES ($1, $2) RETURNING id, version', [JSON.stringify({ clients: v.clients }), yo.id]);
    return send(res, 200, { id: r.rows[0].id, version: r.rows[0].version });
  }
  if (id === 'ultima' && req.method === 'GET') {
    // la última planilla con clientes (si todas están vacías, la más reciente); en modo por usuario, solo entre las propias
    const r = await pool.query(`SELECT p.id, p.data, p.version FROM planillas p WHERE ${compartidas ? '$1::int IS NOT NULL' : 'p.usuario_id = $1'} ORDER BY (jsonb_array_length(p.data->'clients') > 0) DESC, p.id DESC LIMIT 1`, [yo.id]);
    return send(res, 200, r.rows[0] || {});
  }
  if (id && req.method === 'GET') {
    const r = await pool.query(`SELECT p.id, p.data, p.version FROM planillas p WHERE p.id=$2 AND (${acceso})`, [yo.id, id]);
    return r.rows[0] ? send(res, 200, r.rows[0]) : send(res, 404, { error: 'No existe' });
  }
  if (id && req.method === 'PUT') {
    const b = await body(req, 2e6);
    const v = Logic.limpiarClientes(b.clients);
    if (!v.ok) return send(res, 400, { error: v.error });
    const ver = Number.isInteger(b.version) ? b.version : null;   // si viene, solo guarda si nadie cambió la planilla desde entonces
    const r = await pool.query(`UPDATE planillas p SET data=$3, updated_at=now(), version=p.version+1 WHERE p.id=$2 AND (${acceso}) AND ($4::int IS NULL OR p.version=$4) RETURNING p.version`, [yo.id, id, JSON.stringify({ clients: v.clients }), ver]);
    if (r.rowCount) return send(res, 200, { ok: true, version: r.rows[0].version });
    const existe = await pool.query(`SELECT p.version FROM planillas p WHERE p.id=$2 AND (${acceso})`, [yo.id, id]);
    return existe.rows[0] ? send(res, 409, { error: 'La planilla fue modificada desde otro lugar.', version: existe.rows[0].version }) : send(res, 404, { error: 'No existe' });
  }
  if (id && req.method === 'DELETE') {
    const r = await pool.query(`DELETE FROM planillas p WHERE p.id=$2 AND (${acceso})`, [yo.id, id]);
    return r.rowCount ? send(res, 200, { ok: true }) : send(res, 404, { error: 'No existe' });
  }
  send(res, 405, { error: 'Método no permitido' });
}

const servidor = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  cabeceras(req, res);
  try {
    if (url === '/health') return send(res, 200, { ok: true });
    if (url === '/api/login' && req.method === 'POST') {
      return await login(req, res);
    }
    if (url.startsWith('/api/')) {
      if (dbReady) await dbReady;
      let yo;
      try { yo = await authUser(req.headers.authorization); }
      catch (e) { console.error(e); return send(res, 503, { error: 'Sin conexión con la base de datos.' }); }
      if (!yo) return send(res, 401, { error: 'No autorizado' });
      if (url === '/api/yo' || url === '/api/ajustes' || url.startsWith('/api/usuarios')) return await cuentas(req, res, url, yo);
      if (url === '/api/leer') {
        req.body = await body(req);
        const est = fotosEstado(yo.id);
        if (!est.restantes) return send(res, 429, { error: `Límite alcanzado: solo se pueden leer ${FOTOS_MAX} fotos cada 10 minutos. Probá de nuevo en ${est.espera} min.`, restantes: 0 });
        est.t.push(Date.now());
        res.status = c => { res.statusCode = c; return res; };
        res.json = o => send(res, res.statusCode || 200, res.statusCode >= 400 ? o : { ...o, restantes: fotosEstado(yo.id).restantes });
        await leer(req, res);
        if (res.statusCode >= 400) est.t.pop();   // si falló, no gasta el cupo
        return;
      }
      return await planillas(req, res, url, yo);
    }
    const name = url === '/' ? 'index.html' : url.slice(1);
    if (!FILES.includes(name)) { res.statusCode = 404; return res.end('No encontrado'); }
    res.setHeader('content-type', TYPES[path.extname(name)]);
    if (name === 'sw.js' || name.endsWith('.html') || name.endsWith('.js') || name.endsWith('.css')) res.setHeader('cache-control', 'no-cache');   // siempre se revalida: la app se actualiza sola
    const lectura = fs.createReadStream(path.join(__dirname, name));
    lectura.on('error', () => { if (!res.headersSent) res.statusCode = 500; res.end(); });
    lectura.pipe(res);
  } catch (e) {
    console.error(e);
    const sinBase = e && /^(ECONN|ETIMEDOUT|ENOTFOUND|57P|08)/.test(String(e.code));
    if (!res.headersSent) send(res, sinBase ? 503 : 500, { error: sinBase ? 'Sin conexión con la base de datos.' : 'Error interno' });
  }
});
servidor.listen(process.env.PORT || 3000);

// Un corte de la base no debe tirar el servidor: se registra y se sigue (las consultas siguientes se reconectan solas).
if (pool) pool.on('error', e => console.error('DB (conexión inactiva):', e.message));
process.on('unhandledRejection', e => console.error('Promesa sin manejar:', e));
process.on('uncaughtException', e => { console.error('Error fatal:', e); process.exit(1); });
process.on('SIGTERM', () => {
  servidor.close(() => (pool ? pool.end() : Promise.resolve()).finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 8000).unref();
});
