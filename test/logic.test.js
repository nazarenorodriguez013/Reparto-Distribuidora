const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../logic.js');
const { interpretar } = require('../api/leer.js');

test('num: acepta coma o punto como decimal y punto como miles', () => {
  const casos = [['1500,50', 1500.5], ['1500.50', 1500.5], ['1.500,50', 1500.5], ['1.500', 1500], ['150.000', 150000],
    ['1.234.567', 1234567], ['12.345,67', 12345.67], ['0.5', 0.5], ['1500', 1500], ['1,5', 1.5], ['$ 2.000', 2000],
    ['-1.500,00', -1500], ['(1.500,00)', -1500], ['', 0], ['abc', 0], [null, 0], [undefined, 0], [12.5, 12.5]];
  for (const [entrada, esperado] of casos) assert.ok(Math.abs(L.num(entrada) - esperado) < 1e-9, `${JSON.stringify(entrada)} -> ${L.num(entrada)} (esperado ${esperado})`);
});

test('money / fmtInput: formato argentino con 2 decimales', () => {
  assert.equal(L.money(1500.5), '$ 1.500,50');
  assert.equal(L.money(0.1 + 0.2), '$ 0,30');
  assert.equal(L.money(-1500), '$ -1.500,00');
  assert.equal(L.fmtInput(1500.5), '1500,5');
  assert.equal(L.fmtInput(0), '');
});

test('rechazo: lo rechazado se resta de lo que hay que cobrar', () => {
  const c = { total: 1000, pay: { ef: 600 }, rech: { tipo: 'parcial', monto: 400, motivo: 'x' } };
  assert.equal(L.rechMonto(c), 400);
  assert.equal(L.debe(c), 600);
  assert.equal(L.debe(c) - L.sum(c), 0);
  assert.equal(L.rechMonto({ total: 1000, rech: { tipo: 'parcial', monto: 5000 } }), 1000, 'no puede rechazar más que el pedido');
  assert.equal(L.rechMonto({ total: -500, rech: { tipo: 'total', monto: 500 } }), 0, 'una nota de crédito no admite rechazo');
});

test('sumas con decimales no acumulan error', () => {
  assert.equal(L.sum({ pay: { ef: 0.1, tr: 0.2 } }), 0.3);
});

test('dedupe: mismo nombre e importe se quita; mismo nombre con otro importe se conserva', () => {
  const r = L.dedupe([{ name: 'Kiosco Pérez', total: 1000 }, { name: 'kiosco perez', total: '1.000' }, { name: 'Kiosco Pérez', total: 2500 }], [{ name: 'Sol', total: 5 }]);
  assert.equal(r.rows.length, 2);
  assert.equal(r.dups, 1);
});

test('limpiarClientes: deja solo los campos esperados y descarta lo inválido', () => {
  const r = L.limpiarClientes([{ name: 'A', total: '100', pay: { ef: 100, hack: 5 }, method: 'zzz', extra: 1, rech: { tipo: 'parcial', monto: -5 } }, { total: 1 }, 5, null]);
  assert.equal(r.ok, true);
  assert.equal(r.clients.length, 1);
  assert.deepEqual(Object.keys(r.clients[0]).sort(), ['addr', 'done', 'id', 'method', 'name', 'ord', 'pay', 'rech', 'total']);
  assert.deepEqual(r.clients[0].pay, { ef: 100 });
  assert.equal(r.clients[0].method, null);
  assert.equal(r.clients[0].rech.monto, 0);
  assert.equal(L.limpiarClientes('no').ok, false);
  assert.equal(L.limpiarClientes(new Array(3001).fill({ name: 'x' })).ok, false);
});

test('canon: igual aunque cambie el orden de las claves', () => {
  assert.equal(L.canon({ a: 1, b: [{ y: 2, x: 1 }] }), L.canon({ b: [{ x: 1, y: 2 }], a: 1 }));
});

test('lectura de foto: últimos dos dígitos decimales, signo y dudosos', () => {
  const t = x => interpretar({ name: 'A', importe: x });
  assert.equal(t('152300').total, 1523);
  assert.equal(t('15.230,00').total, 15230);
  assert.equal(t('1523.50').total, 1523.5);
  assert.equal(t('-1.500,00').total, -1500, 'nota de crédito con signo menos');
  assert.equal(t('(1.500,00)').total, -1500, 'nota de crédito entre paréntesis');
  assert.equal(t('1.523').revisar, true);
  assert.equal(t('152300').revisar, false);
});

test('fusionar: combina los cambios de dos celulares por cliente', () => {
  const c = (id, name, total = 1, extra = {}) => ({ id, name, total, ...extra });
  const base = [c('a', 'A'), c('b', 'B'), c('c', 'C')];
  // este celular: agregó D, cambió B, borró C
  const local = [c('a', 'A'), c('b', 'B', 99), c('d', 'D')];
  // el otro celular: agregó E, cambió A
  const remoto = [c('a', 'A', 50), c('b', 'B'), c('c', 'C'), c('e', 'E')];
  const r = L.fusionar(base, local, remoto);
  assert.deepEqual(r.map(x => x.id), ['a', 'b', 'e', 'd'], 'se conserva lo del otro, se aplican los cambios propios y se borra lo borrado');
  assert.equal(r.find(x => x.id === 'a').total, 50, 'lo que cambió el otro y acá no se tocó se conserva');
  assert.equal(r.find(x => x.id === 'b').total, 99, 'lo que se cambió acá gana');
  assert.ok(!r.find(x => x.id === 'c'), 'lo que se borró acá se borra');
});

test('fusionar: si este celular cambió el orden del recorrido, se respeta', () => {
  const c = id => ({ id, name: id, total: 1 });
  const r = L.fusionar([c('a'), c('b'), c('c')], [c('c'), c('a'), c('b')], [c('a'), c('b'), c('c'), c('d')]);
  assert.deepEqual(r.map(x => x.id), ['c', 'a', 'b', 'd']);
});

test('fusionar: sin cambios locales queda igual que el servidor', () => {
  const c = id => ({ id, name: id, total: 1 });
  const base = [c('a'), c('b')];
  assert.deepEqual(L.fusionar(base, base, [c('a'), c('b'), c('z')]).map(x => x.id), ['a', 'b', 'z']);
});
