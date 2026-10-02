// Servidor para Railway: sirve la app y la ruta /api/leer. Sin dependencias.
const http = require('http');
const fs = require('fs');
const path = require('path');
const leer = require('./api/leer.js');

const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };
const FILES = ['index.html', 'manifest.json', 'icon.svg'];

http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/api/leer') {
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
