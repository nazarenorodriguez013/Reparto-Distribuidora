// Lógica pura (sin pantalla ni red): la usan la app (navegador) y el servidor, y se prueba con `npm test`.
(function (root) {
  const KEYS = ['ef', 'tr', 'ch', 'ec', 'cc', 'fi'];
  const METODOS = [null, 'ef', 'tr', 'ch', 'ec', 'cc', 'fi', 'mix', 'rech'];
  const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

  // Número escrito por una persona. Acepta "1500,50", "1500.50", "1.500,50", "1.500", "-1.500,00", "(1.500,00)".
  // Con un solo punto: si detrás hay exactamente 3 dígitos es separador de miles (1.500); si no, es decimal (1500.5).
  function num(v) {
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    let s = String(v == null ? '' : v).trim().replace(/\s/g, '').replace(/[−–]/g, '-').replace(/^\$/, '');
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    if (s.startsWith('-')) { neg = true; s = s.slice(1); }
    if (s.endsWith('-')) { neg = true; s = s.slice(0, -1); }
    s = s.replace(/^\$/, '').replace(/[^0-9.,]/g, '');
    if (!s) return 0;
    const lc = s.lastIndexOf(','), ld = s.lastIndexOf('.');
    let dec = -1;
    if (lc >= 0 && ld >= 0) dec = Math.max(lc, ld);                       // los dos: el último es el decimal
    else if (lc >= 0) dec = s.indexOf(',') === lc ? lc : -1;              // una sola coma = decimal; varias = miles
    else if (ld >= 0) dec = (s.split('.').length - 1 === 1 && s.length - ld - 1 !== 3) ? ld : -1;
    const ent = (dec >= 0 ? s.slice(0, dec) : s).replace(/[.,]/g, '');
    const frac = (dec >= 0 ? s.slice(dec + 1) : '').replace(/[.,]/g, '');
    const n = parseFloat((ent || '0') + (frac ? '.' + frac : ''));
    return isNaN(n) ? 0 : (neg ? -n : n);
  }

  const money = n => '$ ' + r2(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtInput = n => n ? String(r2(n)).replace('.', ',') : '';

  // Importes de un cliente. Lo rechazado se resta de lo que hay que cobrar; el importe del pedido no cambia.
  // Un total negativo es una nota de crédito: no admite rechazo ni cobro.
  const sum = c => r2(KEYS.reduce((a, k) => a + (Number(c.pay && c.pay[k]) || 0), 0));
  const rechMonto = c => (c.rech && c.total > 0) ? r2(Math.min(c.total, Math.max(0, Number(c.rech.monto) || 0))) : 0;
  const debe = c => r2(c.total - rechMonto(c));

  const norm = t => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const sameKey = (n, t) => norm(n) + '|' + Math.round((typeof t === 'number' ? t : num(t)) * 100);
  // Quita filas con mismo nombre Y mismo importe (mismo nombre con otro importe se conserva).
  function dedupe(rows, existing = []) {
    const seen = new Set(existing.map(c => sameKey(c.name, c.total)));
    const out = []; let dups = 0;
    rows.forEach(r => { const k = sameKey(r.name, r.total); if (seen.has(k)) dups++; else { seen.add(k); out.push(r); } });
    return { rows: out, dups };
  }

  // JSON con las claves ordenadas: la base devuelve los objetos con otro orden de claves.
  const canon = o => Array.isArray(o) ? '[' + o.map(canon).join(',') + ']'
    : (o && typeof o === 'object') ? '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}'
    : JSON.stringify(o);
  const sinOrd = arr => (arr || []).map(({ ord, ...resto }) => resto);
  const porPlanilla = arr => [...arr].sort((a, b) => (a.ord || 0) - (b.ord || 0));
  const idNuevo = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // Deja cada cliente con los campos y tipos esperados (lo demás se descarta).
  const texto = (v, max) => String(v == null ? '' : v).slice(0, max);
  const monto = v => { const n = Number(v); return isFinite(n) && Math.abs(n) < 1e12 ? r2(n) : 0; };
  function limpiarCliente(c) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
    const pay = {};
    if (c.pay && typeof c.pay === 'object') KEYS.forEach(k => { const n = monto(c.pay[k]); if (n) pay[k] = n; });
    const o = {
      id: texto(c.id, 40) || idNuevo(),
      ord: Number.isInteger(c.ord) && c.ord > 0 && c.ord < 1e7 ? c.ord : 0,
      name: texto(c.name, 200).trim(),
      addr: texto(c.addr, 300).trim(),
      total: monto(c.total),
      pay,
      done: !!c.done,
      method: METODOS.includes(c.method) ? c.method : null,
    };
    if (c.rech && typeof c.rech === 'object' && (c.rech.tipo === 'parcial' || c.rech.tipo === 'total')) {
      o.rech = { tipo: c.rech.tipo, monto: Math.max(0, monto(c.rech.monto)), motivo: texto(c.rech.motivo, 200) };
    } else o.rech = null;
    return o;
  }
  const MAX_CLIENTES = 3000;
  function limpiarClientes(arr) {
    if (!Array.isArray(arr)) return { ok: false, error: 'La planilla debe ser una lista de clientes.', clients: [] };
    if (arr.length > MAX_CLIENTES) return { ok: false, error: `Demasiados clientes (máximo ${MAX_CLIENTES}).`, clients: [] };
    const clients = arr.map(limpiarCliente).filter(c => c && c.name);
    return { ok: true, clients };
  }

  // Combina los cambios de este celular (local, respecto de lo último sincronizado: base) con lo que hay hoy en el servidor (remoto).
  // Se trabaja por cliente (id): lo que este celular agregó o modificó pisa al servidor, lo que borró se borra, y lo que
  // cambió otro celular y acá no se tocó se conserva.
  function fusionar(base, local, remoto) {
    const mapa = arr => new Map((arr || []).map(c => [c.id, c]));
    const B = mapa(base), L = mapa(local), R = mapa(remoto);
    const out = new Map(R);
    for (const [id, c] of L) { const b = B.get(id); if (!b || canon(b) !== canon(c)) out.set(id, c); }
    for (const id of B.keys()) if (!L.has(id)) out.delete(id);
    const idsBase = (base || []).filter(c => L.has(c.id)).map(c => c.id);
    const idsLocal = (local || []).filter(c => B.has(c.id)).map(c => c.id);
    const reordenado = canon(idsBase) !== canon(idsLocal);
    let ids;
    if (reordenado) ids = [...(local || []).map(c => c.id).filter(id => out.has(id)), ...(remoto || []).map(c => c.id).filter(id => out.has(id) && !L.has(id))];
    else ids = [...(remoto || []).map(c => c.id).filter(id => out.has(id)), ...(local || []).map(c => c.id).filter(id => out.has(id) && !R.has(id))];
    return ids.filter((id, i) => ids.indexOf(id) === i).map(id => out.get(id));
  }

  const api = { fusionar, KEYS, r2, num, money, fmtInput, sum, rechMonto, debe, norm, sameKey, dedupe, canon, sinOrd, porPlanilla, idNuevo, limpiarClientes, MAX_CLIENTES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Logic = api;
})(typeof self !== 'undefined' ? self : this);
