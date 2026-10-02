// Servidor para Railway: sirve la app y la ruta /api/leer. Sin dependencias.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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

const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };
const FILES = ['index.html', 'manifest.json', 'icon.svg'];

http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/api/login' && req.method === 'POST') {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e4) req.destroy(); });
    req.on('end', () => {
      let b = {}; try { b = JSON.parse(raw); } catch {}
      res.setHeader('content-type', 'application/json');
      const ok = typeof b.user === 'string' && typeof b.pass === 'string' && same(b.user, USER) && same(b.pass, PASS);
      res.statusCode = ok ? 200 : 401;
      res.end(JSON.stringify(ok ? { token: makeToken() } : { error: 'Usuario o contraseña incorrectos' }));
    });
    return;
  }
  if (url === '/api/leer') {
    if (!validToken(req.headers.authorization)) { res.statusCode = 401; res.setHeader('content-type', 'application/json'); return res.end('{"error":"No autorizado"}'); }
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 15e6) req.destroy(); });
    req.on('end', async () => {
      try { req.body = JSON.parse(raw || '{}'); } catch { req.body = {}; }
      res.status = c => { res.statusCode = c; return res; };
      res.json = o => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
      try { await leer(req, res); } catch (e) { res.status(500).json({ error: 'Error interno' }); }
    });
    return;
  }
  const name = url === '/' ? 'index.html' : url.slice(1);
  if (!FILES.includes(name)) { res.statusCode = 404; return res.end('No encontrado'); }
  res.setHeader('content-type', TYPES[path.extname(name)]);
  fs.createReadStream(path.join(__dirname, name)).pipe(res);
}).listen(process.env.PORT || 3000);
