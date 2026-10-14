const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

const DB = process.env.TEST_DATABASE_URL;   // si no está definida, se omiten las pruebas que necesitan base
const net = require('node:net');
function puertoLibre() {
  return new Promise((ok, ko) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); s.on('error', ko); });
}

async function arrancar(env) {
  const port = await puertoLibre();
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { PATH: process.env.PATH, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; proc.stdout.on('data', d => log += d); proc.stderr.on('data', d => log += d);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  const llamar = async (m, u, b, t, extra = {}) => {
    const r = await fetch(base + u, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}), ...extra }, body: b ? JSON.stringify(b) : undefined });
    let j = {}; try { j = await r.json(); } catch {} return [r.status, j, r];
  };
  return { base, proc, llamar, log: () => log, parar: () => new Promise(ok => { proc.once('exit', ok); proc.kill('SIGTERM'); }) };
}

test('sin base: salud, cabeceras de seguridad y login', async () => {
  const sv = await arrancar({ APP_USER: 'admin', APP_PASS: 'clave-de-prueba' });
  try {
    const [s, , r] = await sv.llamar('GET', '/health');
    assert.equal(s, 200);
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal((await sv.llamar('POST', '/api/login', { user: 'admin', pass: 'mala' }))[0], 401);
    const [ok, j] = await sv.llamar('POST', '/api/login', { user: 'admin', pass: 'clave-de-prueba' });
    assert.equal(ok, 200); assert.ok(j.token);
    assert.equal((await sv.llamar('GET', '/api/planillas'))[0], 401);
    assert.equal((await sv.llamar('GET', '/api/planillas', null, j.token))[0], 503, 'sin base avisa en vez de fallar');
    assert.equal((await sv.llamar('GET', '/logic.js'))[0], 200);
    assert.equal((await sv.llamar('GET', '/server.js'))[0], 404, 'solo se sirven los archivos de la app');
  } finally { await sv.parar(); }
});

test('sin usuario configurado no se puede entrar (no hay contraseña por defecto)', async () => {
  const sv = await arrancar({});
  try {
    assert.equal((await sv.llamar('POST', '/api/login', { user: 'usuario-viejo', pass: 'clave-vieja-1' }))[0], 503);
    assert.equal((await sv.llamar('POST', '/api/login', { user: 'admin', pass: 'admin' }))[0], 503);
  } finally { await sv.parar(); }
});

test('límite de intentos: no se evita inventando X-Forwarded-For', async () => {
  const sv = await arrancar({ APP_USER: 'admin', APP_PASS: 'clave-de-prueba' });
  try {
    let bloqueos = 0;
    for (let i = 0; i < 26; i++) {
      // el proxy real agrega la IP verdadera al final; lo que el cliente inventa va antes
      const [s] = await sv.llamar('POST', '/api/login', { user: 'x' + i, pass: 'mala' }, null, { 'x-forwarded-for': `9.9.9.${i}, 203.0.113.7` });
      if (s === 429) bloqueos++;
    }
    assert.ok(bloqueos >= 5, `bloqueos: ${bloqueos}`);
  } finally { await sv.parar(); }
});

test('si el proxy no muestra la IP real (dirección privada) no se bloquea a todos juntos', async () => {
  const sv = await arrancar({ APP_USER: 'admin', APP_PASS: 'clave-de-prueba' });
  try {
    let bloqueos = 0;
    for (let i = 0; i < 26; i++) { const [s] = await sv.llamar('POST', '/api/login', { user: 'u' + i, pass: 'mala' }); if (s === 429) bloqueos++; }   // llegan desde 127.0.0.1
    assert.equal(bloqueos, 0);
    assert.equal((await sv.llamar('POST', '/api/login', { user: 'admin', pass: 'clave-de-prueba' }))[0], 200, 'el usuario legítimo puede entrar');
  } finally { await sv.parar(); }
});

test('con base de datos', { skip: !DB && 'definí TEST_DATABASE_URL para correr estas pruebas' }, async (t) => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DB });
  await pool.query('DROP TABLE IF EXISTS planillas, usuarios, config');
  const mock = http.createServer((req, res) => {   // API de Anthropic simulada
    let raw = ''; req.on('data', c => raw += c); req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.headers['x-api-key'] === 'mala') { res.statusCode = 401; return res.end(JSON.stringify({ error: { message: 'DETALLE-INTERNO-SECRETO' } })); }
      res.end(JSON.stringify({ content: [{ text: '[{"name":"Uno","addr":"","importe":"-1.500,00"},{"name":"Dos","addr":"","importe":"150000"}]' }] }));
    });
  });
  await new Promise(ok => mock.listen(0, '127.0.0.1', ok));
  const env = { DATABASE_URL: DB, APP_USER: 'admin', APP_PASS: 'clave-de-prueba', AUTH_SECRET: 'x'.repeat(40), ANTHROPIC_API_KEY: 'buena', ANTHROPIC_API_URL: `http://127.0.0.1:${mock.address().port}/v1/messages` };
  const sv = await arrancar(env);
  try {
    const [, login] = await sv.llamar('POST', '/api/login', { user: 'admin', pass: 'clave-de-prueba' });
    const tk = login.token; assert.ok(tk); assert.equal(login.admin, true);

    await t.test('usuarios: alta, validaciones y permisos', async () => {
      assert.equal((await sv.llamar('POST', '/api/usuarios', { nombre: 'ana', pass: 'ana12345' }, tk))[0], 200);
      assert.equal((await sv.llamar('POST', '/api/usuarios', { nombre: 'ANA', pass: 'otra12345' }, tk))[0], 409);
      assert.equal((await sv.llamar('POST', '/api/usuarios', { nombre: 'a b', pass: 'ana12345' }, tk))[0], 400);
      assert.equal((await sv.llamar('POST', '/api/usuarios', { nombre: 'luis', pass: '1234567' }, tk))[0], 400, 'mínimo 8 caracteres');
      const [, ana] = await sv.llamar('POST', '/api/login', { user: 'ana', pass: 'ana12345' });
      assert.equal(ana.admin, false);
      assert.equal((await sv.llamar('GET', '/api/usuarios', null, ana.token))[0], 403);
      const [c, nueva] = await sv.llamar('PUT', '/api/yo', { passActual: 'ana12345', passNueva: 'nueva-clave-1' }, ana.token);
      assert.equal(c, 200);
      assert.equal((await sv.llamar('GET', '/api/planillas', null, ana.token))[0], 401, 'cambiar la clave cierra las otras sesiones');
      assert.equal((await sv.llamar('GET', '/api/planillas', null, nueva.token))[0], 200);
    });

    await t.test('el tiempo de login no revela si el usuario existe', async () => {
      for (let i = 0; i < 4; i++) await sv.llamar('POST', '/api/usuarios', { nombre: 'tiempo' + i, pass: 'clave-larga-' + i }, tk);
      const medir = async (u) => { const t0 = process.hrtime.bigint(); await sv.llamar('POST', '/api/login', { user: u, pass: 'mala-clave' }); return Number(process.hrtime.bigint() - t0) / 1e6; };
      await medir('fantasma-calentamiento');
      let existe = 0, noExiste = 0;
      for (let i = 0; i < 4; i++) { existe += await medir('tiempo' + i); noExiste += await medir('fantasma' + i); }   // un intento por usuario: sin demoras acumuladas
      assert.ok(noExiste > existe * 0.5, `existe ${existe.toFixed(0)} ms, no existe ${noExiste.toFixed(0)} ms`);
    });

    await t.test('planillas: validación, versión y conflictos', async () => {
      const [, a] = await sv.llamar('POST', '/api/planillas', { clients: [{ name: 'A', total: 100, hack: 'x', pay: { ef: 100, zz: 9 } }] }, tk);
      assert.equal(a.version, 1);
      assert.equal((await sv.llamar('POST', '/api/planillas', { clients: 'no' }, tk))[0], 400);
      assert.equal((await sv.llamar('PUT', `/api/planillas/${a.id}`, { clients: {} }, tk))[0], 400);
      const [, leida] = await sv.llamar('GET', `/api/planillas/${a.id}`, null, tk);
      assert.equal(leida.data.clients[0].hack, undefined, 'los campos desconocidos se descartan');
      assert.deepEqual(leida.data.clients[0].pay, { ef: 100 });
      const [s1, v2] = await sv.llamar('PUT', `/api/planillas/${a.id}`, { clients: [{ name: 'A', total: 200 }], version: 1 }, tk);
      assert.equal(s1, 200); assert.equal(v2.version, 2);
      const [s2, c] = await sv.llamar('PUT', `/api/planillas/${a.id}`, { clients: [{ name: 'B', total: 1 }], version: 1 }, tk);
      assert.equal(s2, 409, 'otro celular ya guardó: no se pisa'); assert.equal(c.version, 2);
      assert.equal((await sv.llamar('PUT', `/api/planillas/${a.id}`, { clients: [{ name: 'C', total: 5 }] }, tk))[0], 200, 'sin versión guarda directo');
      assert.equal((await sv.llamar('PUT', '/api/planillas/999999', { clients: [], version: 1 }, tk))[0], 404);
      assert.equal((await sv.llamar('DELETE', `/api/planillas/${a.id}`, null, tk))[0], 200);
    });

    await t.test('planillas por usuario: cada uno ve solo las suyas; el administrador ve todas', async () => {
      const [, ana] = await sv.llamar('POST', '/api/login', { user: 'ana', pass: 'nueva-clave-1' });
      const [, deAdmin] = await sv.llamar('POST', '/api/planillas', { clients: [{ name: 'Del admin', total: 1 }] }, tk);
      const [, deAna] = await sv.llamar('POST', '/api/planillas', { clients: [{ name: 'De Ana', total: 2 }] }, ana.token);
      assert.equal((await sv.llamar('GET', `/api/planillas/${deAdmin.id}`, null, ana.token))[0], 404, 'Ana no puede leer la del admin');
      assert.equal((await sv.llamar('PUT', `/api/planillas/${deAdmin.id}`, { clients: [{ name: 'x', total: 1 }] }, ana.token))[0], 404, 'ni modificarla');
      assert.equal((await sv.llamar('DELETE', `/api/planillas/${deAdmin.id}`, null, ana.token))[0], 404, 'ni borrarla');
      const [, listaAna] = await sv.llamar('GET', '/api/planillas', null, ana.token);
      assert.ok(listaAna.planillas.every(p => p.id !== deAdmin.id) && listaAna.planillas.some(p => p.id === deAna.id));
      assert.ok(listaAna.planillas.every(p => p.usuario === undefined), 'no se muestran nombres de dueños a usuarios comunes');
      const [, ultimaAna] = await sv.llamar('GET', '/api/planillas/ultima', null, ana.token);
      assert.equal(ultimaAna.id, deAna.id, 'la última es la propia, no la de otro');
      const [, listaAdmin] = await sv.llamar('GET', '/api/planillas', null, tk);
      assert.ok([deAdmin.id, deAna.id].every(i => listaAdmin.planillas.some(p => p.id === i)), 'el administrador ve todas');
      assert.equal(listaAdmin.planillas.find(p => p.id === deAna.id).usuario, 'ana');
      assert.equal((await sv.llamar('GET', `/api/planillas/${deAna.id}`, null, tk))[0], 200, 'y puede abrir las de otros');
    });

    await t.test('fotos: negativos, límite por usuario y sin filtrar errores internos', async () => {
      const img = 'data:image/png;base64,iVBORw0KGgo=';
      const [s, j] = await sv.llamar('POST', '/api/leer', { image: img }, tk);
      assert.equal(s, 200);
      assert.equal(j.clients[0].total, -1500); assert.equal(j.clients[1].total, 1500);
      await sv.llamar('POST', '/api/leer', { image: img }, tk); await sv.llamar('POST', '/api/leer', { image: img }, tk);
      assert.equal((await sv.llamar('POST', '/api/leer', { image: img }, tk))[0], 429);
      const [, ana2] = await sv.llamar('POST', '/api/login', { user: 'ana', pass: 'nueva-clave-1' });
      assert.equal((await sv.llamar('POST', '/api/leer', { image: img }, ana2.token))[0], 200, 'cada usuario tiene su cupo');
      assert.equal((await sv.llamar('POST', '/api/leer', { image: 'data:text/html;base64,AAAA' }, ana2.token))[0], 400, 'solo imágenes');
    });

    await t.test('un corte de la base no tira el servidor', async () => {
      await pool.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND datname = current_database()");
      await new Promise(r => setTimeout(r, 800));
      assert.equal((await sv.llamar('GET', '/health'))[0], 200, 'sigue vivo');
      let ok = 0; for (let i = 0; i < 4 && !ok; i++) { ok = (await sv.llamar('GET', '/api/planillas', null, tk))[0] === 200 ? 1 : 0; if (!ok) await new Promise(r => setTimeout(r, 500)); }
      assert.ok(ok, 'y se reconecta solo');
    });
  } finally { await sv.parar(); mock.close(); await pool.end(); }
});

test('migración: las planillas de antes (sin dueño) pasan al administrador', { skip: !DB && 'definí TEST_DATABASE_URL para correr estas pruebas' }, async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DB });
  await pool.query('DROP TABLE IF EXISTS planillas, usuarios, config');
  await pool.query(`CREATE TABLE planillas (id SERIAL PRIMARY KEY, data JSONB NOT NULL DEFAULT '{"clients":[]}', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);   // esquema de la versión anterior
  await pool.query(`INSERT INTO planillas (data) VALUES ('{"clients":[{"id":"a","name":"Vieja","total":5,"pay":{},"done":false}]}')`);
  const sv = await arrancar({ DATABASE_URL: DB, APP_USER: 'admin', APP_PASS: 'clave-de-prueba', AUTH_SECRET: 'x'.repeat(40) });
  try {
    const [, l] = await sv.llamar('POST', '/api/login', { user: 'admin', pass: 'clave-de-prueba' });
    const [s, lista] = await sv.llamar('GET', '/api/planillas', null, l.token);
    assert.equal(s, 200); assert.equal(lista.planillas.length, 1);
    const [, u] = await sv.llamar('GET', '/api/planillas/ultima', null, l.token);
    assert.equal(u.data.clients[0].name, 'Vieja'); assert.equal(u.version, 1);
  } finally { await sv.parar(); await pool.end(); }
});

test('sin clave de Anthropic se avisa y no se filtran detalles de la API', { skip: !DB && 'definí TEST_DATABASE_URL para correr estas pruebas' }, async () => {
  const mock = http.createServer((req, res) => { res.statusCode = 401; res.end(JSON.stringify({ error: { message: 'DETALLE-INTERNO-SECRETO' } })); });
  await new Promise(ok => mock.listen(0, '127.0.0.1', ok));
  const base = { DATABASE_URL: DB, APP_USER: 'admin', APP_PASS: 'clave-de-prueba', AUTH_SECRET: 'x'.repeat(40) };
  const img = 'data:image/png;base64,iVBORw0KGgo=';
  let sv = await arrancar(base);
  try {
    const [, l] = await sv.llamar('POST', '/api/login', { user: 'admin', pass: 'clave-de-prueba' });
    assert.equal((await sv.llamar('POST', '/api/leer', { image: img }, l.token))[0], 503);
  } finally { await sv.parar(); }
  sv = await arrancar({ ...base, ANTHROPIC_API_KEY: 'mala', ANTHROPIC_API_URL: `http://127.0.0.1:${mock.address().port}/x` });
  try {
    const [, l] = await sv.llamar('POST', '/api/login', { user: 'admin', pass: 'clave-de-prueba' });
    const [s, j] = await sv.llamar('POST', '/api/leer', { image: img }, l.token);
    assert.equal(s, 502); assert.ok(!JSON.stringify(j).includes('SECRETO'));
  } finally { await sv.parar(); mock.close(); }
});
