const { fusionar, KEYS, r2, num, money, fmtInput, sum, rechMonto, debe, norm, sameKey, dedupe, canon, sinOrd, porPlanilla, limpiarClientes } = Logic;
const METHODS = [
  ['ef','Efectivo'],['tr','Transferencia'],['ch','Cheque'],
  ['ec','E-Cheq'],['cc','Cuenta corriente'],['fi','Firmado'],['mix','Pago mixto']
];
const LABEL = Object.fromEntries(METHODS);
const KEY = 'reparto-v1';          // versiones anteriores guardaban la planilla acá: se sube una vez y se borra
const OUT = 'reparto-pendiente';   // cambios que el servidor todavía no confirmó (se borra apenas los confirma)

let S = {photo:null, clients:[], tab:'planilla', pid:null, ver:null};
try{ S.tab = localStorage.getItem('reparto-tab') || 'planilla'; S.pid = Number(localStorage.getItem('reparto-pid')) || null; }catch(e){}
const LEGACY = (()=>{ try{ return JSON.parse(localStorage.getItem(KEY)); }catch(e){ return null; } })();
let listo = false;       // ya hay una planilla cargada (del servidor, o la última del celular si no hay conexión)
let conectado = false;   // el servidor respondió: recién ahí se envían los cambios
let ordering = null;      // modo "ordenar tocando": array de ids ya tocados
let TOKEN = null;
try{ TOKEN = localStorage.getItem('reparto-token'); }catch(e){}
let loginErr = '', loginUser = '';
let USERNAME = '';
try{ USERNAME = localStorage.getItem('reparto-user') || ''; }catch(e){}
let editId = null;        // cliente abierto para editar en Planilla
// Pago mixto: el último medio elegido se completa solo con lo que falta (se puede editar)
let mixSel = {}, mixManual = {};
function mixRecalc(c){
  const sel = mixSel[c.id]; if(!sel || !sel.length || mixManual[c.id]) return;
  const last = sel[sel.length-1];
  const otros = sel.slice(0,-1).reduce((a,k)=>a+(c.pay[k]||0),0);
  c.pay[last] = Math.max(0, r2(debe(c) - otros));
}
let rechOpen = null;      // cliente con el panel de rechazo abierto
let sel = null;           // cliente abierto en 'Siguientes'
let mixOpen = null;       // id de cliente con panel mixto abierto
let dupMsg = '';
let manual = {name:'',addr:'',total:''};   // formulario de carga manual
let photoRows = [];               // clientes leídos de la foto, por revisar
let pedi = null;                  // fila de la foto abierta para editar
// Lo que todavía no se agregó a la lista (leído de la foto, o escrito en el formulario) se conserva si el celular recarga la página,
// por ejemplo al volver de la cámara o la galería. No es la planilla: se borra apenas se agrega.
const DRAFT = 'reparto-borrador';
try{
  const d = JSON.parse(localStorage.getItem(DRAFT) || 'null');
  if(d && Array.isArray(d.photoRows)) photoRows = d.photoRows.slice(0,100).map(r=>({name:String(r.name||''), addr:String(r.addr||''), total:String(r.total||''), warn:!!r.warn}));
  if(d && d.manual) manual = {name:String(d.manual.name||''), addr:String(d.manual.addr||''), total:String(d.manual.total||'')};
}catch(e){}
function borradorGuardar(){
  try{
    if(photoRows.length || manual.name || manual.addr || manual.total) localStorage.setItem(DRAFT, JSON.stringify({photoRows, manual}));
    else localStorage.removeItem(DRAFT);
  }catch(e){}
}
let leyendo = '';

function save(){
  try{ localStorage.setItem('reparto-tab', S.tab); if(S.pid) localStorage.setItem('reparto-pid', S.pid); else localStorage.removeItem('reparto-pid'); }catch(e){}
  scheduleSync();
}

/* ---------- Servidor (base de datos): es la única copia de las planillas ---------- */
let conflictoHasta = 0, conflictoMsg = '';
let syncTimer = null, syncing = false, syncAgain = false, hist = null, enviado = '', sinEnviar = false, cargando = false, cargaTimer = null;
const instantanea = () => JSON.stringify([S.pid, S.clients]);
let base = [];   // clientes tal como estaban en la última sincronización (sirve para combinar con los cambios de otro celular)
const clonar = x => JSON.parse(JSON.stringify(x));
function marcarEnviado(){ enviado = instantanea(); base = clonar(S.clients); }
function setSync(msg, rojo){ const el=$('#syncmsg'); el.textContent=msg; el.style.display=msg?'':'none'; el.style.background=rojo?'#fee2e2':''; el.style.color=rojo?'#7f1d1d':''; }
function outboxGet(){ try{ return JSON.parse(localStorage.getItem(OUT)); }catch(e){ return null; } }
function outboxClear(){ try{ localStorage.removeItem(OUT); }catch(e){} }
// Cada cambio se anota un instante en el celular y se envía enseguida; se borra apenas el servidor lo confirma.
function scheduleSync(){
  if(!TOKEN || !listo || instantanea()===enviado) return;
  sinEnviar = true;
  try{ localStorage.setItem(OUT, JSON.stringify({pid:S.pid, ver:S.ver, base, clients:S.clients})); }catch(e){}
  if(!conectado) return;
  clearTimeout(syncTimer); syncTimer = setTimeout(syncSave, 300);
}
async function api(method, url, data){
  const r = await fetch(url,{method,headers:{'content-type':'application/json',authorization:'Bearer '+TOKEN},body:data?JSON.stringify(data):undefined});
  if(r.status===401){ logout(); throw Object.assign(new Error('401'),{status:401}); }
  const d = await r.json();
  if(!r.ok) throw Object.assign(new Error(d.error||'error'),{status:r.status});
  return d;
}
const MSG_SIN_SENAL = '⚠ Sin conexión: los últimos cambios todavía NO están en el servidor. Se envían solos cuando vuelva la señal.';
const MSG_CONFLICTO = 'Otro celular modificó esta planilla al mismo tiempo. Tus cambios se guardaron como una planilla nueva; la otra versión está en el Historial.';
const MSG_FUSION = 'Otro celular cambió esta planilla al mismo tiempo: se combinaron los cambios de los dos.';
async function fusionarConServidor(pid, baseArr, localArr){
  for(let i=0;i<3;i++){
    const rem = await api('GET','/api/planillas/'+pid);          // 404 si la borraron: lo decide quien llama
    const remoto = limpiarClientes(rem.data.clients).clients;
    const fusion = fusionar(baseArr, localArr, remoto);
    try{ const r = await api('PUT','/api/planillas/'+pid,{clients:fusion, version:rem.version}); return {clients:fusion, version:r.version}; }
    catch(e){ if(e.status!==409) throw e; }
  }
  throw Object.assign(new Error('conflicto'),{status:409});
}
const MSG_SIN_BASE = '⚠ La base de datos no está conectada: los cambios NO se están guardando en el servidor.';
async function syncSave(){
  clearTimeout(syncTimer); syncTimer = null;
  if(!TOKEN || !listo || !conectado || cargando) return;
  if(syncing){ syncAgain = true; return; }
  syncing = true; let ok = false, conflicto = '', pendiente = false;
  try{
    if(!S.pid){ if(S.clients.length){ const r = await api('POST','/api/planillas',{clients:S.clients}); S.pid = r.id; S.ver = r.version; } }
    else {
      try{ const r = await api('PUT','/api/planillas/'+S.pid,{clients:S.clients, version:S.ver}); S.ver = r.version; }
      catch(e){
        if(e.status!==409) throw e;   // otro celular guardó antes: se combinan los cambios de los dos
        const antes = JSON.stringify(S.clients), local = JSON.parse(antes);
        let fus = null;
        try{ fus = await fusionarConServidor(S.pid, base, local); }
        catch(e2){ if(e2.status!==404 && e2.status!==409) throw e2; }
        if(fus){
          S.ver = fus.version; conflicto = 'fusion';
          if(JSON.stringify(S.clients)===antes) S.clients = fus.clients;
          else { S.clients = fusionar(local, S.clients, fus.clients); pendiente = true; }   // lo que se editó mientras tanto se vuelve a enviar
          base = clonar(fus.clients);
        } else {   // no se pudo combinar: nada se pierde, los cambios quedan en una planilla nueva
          const r = await api('POST','/api/planillas',{clients:S.clients}); S.pid = r.id; S.ver = r.version; conflicto = 'copia';
        }
      }
    }
    if(pendiente) enviado = ''; else marcarEnviado();
    ok = true; save();
    if(conflicto){ conflictoMsg = conflicto==='fusion' ? MSG_FUSION : MSG_CONFLICTO; conflictoHasta = Date.now()+20000; setSync(conflictoMsg); setTimeout(()=>{ if(Date.now()>=conflictoHasta) setSync(''); }, 20200); render(); }
  }catch(e){
    if(e.status!==401){ setSync(e.status===503 ? MSG_SIN_BASE : MSG_SIN_SENAL, true); syncTimer = setTimeout(syncSave, e.status===503 ? 30000 : 5000); }
  }
  syncing = false;
  if(ok){
    if(syncAgain){ syncAgain = false; syncSave(); }
    else if(!syncTimer){
      if(instantanea()===enviado){ sinEnviar = false; outboxClear(); setSync(Date.now()<conflictoHasta ? conflictoMsg : ''); } else scheduleSync();
    }
  } else syncAgain = false;
}
async function asegurarEnviado(){ if(sinEnviar) await syncSave(); return !sinEnviar; }

// Sube lo que quedó sin enviar y los datos que versiones anteriores guardaron en el navegador.
async function subirPendientes(){
  const o = outboxGet();
  if(o && ((o.clients||[]).length || o.pid)){
    const lista = limpiarClientes(o.clients).clients;
    const nueva = async()=>{ const r = await api('POST','/api/planillas',{clients:lista}); S.pid = r.id; S.ver = r.version; };
    if(o.pid){
      try{ const r = await api('PUT','/api/planillas/'+o.pid,{clients:lista, version:o.ver}); S.pid = o.pid; S.ver = r.version; }
      catch(e){
        if(e.status!==404 && e.status!==409) throw e;
        let fus = null;
        if(e.status===409 && Array.isArray(o.base)){ try{ fus = await fusionarConServidor(o.pid, limpiarClientes(o.base).clients, lista); }catch(e2){ if(e2.status!==404 && e2.status!==409) throw e2; } }
        if(fus){ S.pid = o.pid; S.ver = fus.version; conflictoMsg = MSG_FUSION; conflictoHasta = Date.now()+20000; }
        else if(lista.length) await nueva();
      }
    }
    else if(lista.length) await nueva();
  }
  outboxClear();
  if(LEGACY && Array.isArray(LEGACY.clients) && LEGACY.clients.length){
    let subir = true;
    if(LEGACY.pid){ try{ const d = await api('GET','/api/planillas/'+LEGACY.pid); const igual = x => canon(sinOrd(limpiarClientes(x).clients));   // se compara ya normalizado: el servidor completa y ordena campos
      subir = igual(d.data.clients) !== igual(LEGACY.clients); if(!subir && !S.pid){ S.pid = LEGACY.pid; S.ver = d.version; } }catch(e){ if(e.status!==404) throw e; } }
    if(subir){ const r = await api('POST','/api/planillas',{clients:limpiarClientes(LEGACY.clients).clients}); if(!S.pid || !LEGACY.pid){ S.pid = r.id; S.ver = r.version; } }
    try{ localStorage.removeItem(KEY); }catch(e){}
  }
}
async function cargarServidor(){
  if(!TOKEN || cargando) return;
  cargando = true; clearTimeout(cargaTimer);
  const antes = JSON.stringify(S.clients);
  try{
    await subirPendientes();
    let d = null;
    if(S.pid){ try{ d = await api('GET','/api/planillas/'+S.pid); }catch(e){ if(e.status!==404) throw e; S.pid = null; } }
    if(!d) d = await api('GET','/api/planillas/ultima');
    if(listo && JSON.stringify(S.clients)!==antes){ enviado = ''; }          // se editó durante la carga: no se pisa
    else if(d && d.id){ S.pid = d.id; S.ver = d.version; S.clients = limpiarClientes(d.data.clients).clients; marcarEnviado(); }
    else { S.pid = null; S.ver = null; S.clients = []; marcarEnviado(); }
    conectado = true; listo = true; sinEnviar = false; setSync('');
    normalizarOrden();
    if(enviado==='') scheduleSync();
  }catch(e){
    if(e.status!==401){
      if(!listo){
        const o = outboxGet() || LEGACY;
        if(o && Array.isArray(o.clients)){ S.clients = limpiarClientes(o.clients).clients; S.pid = o.pid || S.pid; S.ver = o.ver || null; listo = true; }
        else if(e.status===503){ listo = true; }   // sin base de datos: se puede trabajar, pero avisa que no se guarda en el servidor
      }
      setSync(e.status===503 ? MSG_SIN_BASE : (listo ? MSG_SIN_SENAL : 'Sin conexión con el servidor. Reintentando…'), true);
      cargaTimer = setTimeout(cargarServidor, 8000);
    }
  }
  cargando = false;
  render();
}
async function loadHist(){
  hist = null; render();
  try{ hist = (await api('GET','/api/planillas')).planillas; }
  catch(e){ hist = e.status===503 ? 'off' : 'error'; }
  render();
}
const fechaLarga = iso => new Date(iso).toLocaleString('es-AR',{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
const COLORS = ['#1d4ed8','#dc2626','#16a34a','#ea580c','#7c3aed','#0891b2','#db2777','#334155'];
let COLOR = null;
try{ COLOR = localStorage.getItem('reparto-color'); }catch(e){}
function applyColor(c){
  if(!c) return;
  COLOR = c; document.documentElement.style.setProperty('--pri', c);
  const m = document.querySelector('meta[name=theme-color]'); if(m) m.content = c;
  try{ localStorage.setItem('reparto-color', c); }catch(e){}
}
applyColor(COLOR);
/* ---------- Cuenta y usuarios (Configuración) ---------- */
let cfg = {yo:null, usuarios:null, msg:'', err:''};
async function loadCfg(){
  cfg.msg = ''; cfg.err = '';
  try{
    cfg.yo = await api('GET','/api/yo');
    cfg.usuarios = (cfg.yo.admin && cfg.yo.gestion) ? (await api('GET','/api/usuarios')).usuarios : null;
  }catch(e){ if(e.status!==401) cfg.err = 'No se pudo cargar la cuenta.'; }
  if(S.tab==='config') render();
}
async function loadCfgLista(){ cfg.usuarios = (await api('GET','/api/usuarios')).usuarios; }
function setSesion(token, nombre){
  TOKEN = token; USERNAME = nombre;
  try{ localStorage.setItem('reparto-token', TOKEN); localStorage.setItem('reparto-user', USERNAME); }catch(e){}
}
async function cfgRun(fn, ok){
  cfg.msg = ''; cfg.err = '';
  try{ await fn(); cfg.msg = ok; }catch(e){ if(e.status===401) return; cfg.err = e.message || 'Error'; }
  if(S.tab==='config') render();
}
function cfgCuentas(){
  const aviso = (cfg.msg?`<div class="hint" style="background:#dcfce7;color:#14532d">${esc(cfg.msg)}</div>`:'') + (cfg.err?`<div class="hint" style="background:#fee2e2;color:#7f1d1d">${esc(cfg.err)}</div>`:'');
  if(!cfg.yo) return `<div class="card">${aviso||'Cargando cuenta…'}</div>`;
  if(!cfg.yo.gestion) return `<div class="card"><h2>Mi cuenta</h2><div class="mut">Cambiar el nombre de usuario y la contraseña, y agregar usuarios, estará disponible cuando la base de datos esté conectada.</div></div>`;
  return `<div class="card"><h2>Mi cuenta</h2>${aviso}
    <label class="mut">Nombre de usuario</label>
    <div class="row"><input id="c_nombre" autocapitalize="none" value="${esc(cfg.yo.nombre)}"><button class="btn fit" data-a="cfg-nombre">Guardar</button></div>
    <h2 style="margin-top:16px">Cambiar contraseña</h2>
    <input id="c_pa" type="password" autocomplete="current-password" placeholder="Contraseña actual">
    <input id="c_pn" type="password" autocomplete="new-password" placeholder="Contraseña nueva (mínimo 8)" style="margin-top:8px">
    <input id="c_pn2" type="password" autocomplete="new-password" placeholder="Repetir contraseña nueva" style="margin-top:8px">
    <div class="row" style="margin-top:10px"><button class="btn" data-a="cfg-pass">Cambiar contraseña</button></div>
  </div>
  ${cfg.yo.admin ? `<div class="card"><h2>Planillas</h2>
    <div class="mut" style="margin-bottom:10px">${cfg.yo.compartidas ? 'Todos los usuarios ven y editan las mismas planillas.' : 'Cada usuario ve solo sus planillas. El administrador ve todas.'}</div>
    <button class="btn sec" style="width:100%" data-a="cfg-compartidas">${cfg.yo.compartidas ? 'Separar: que cada usuario vea las suyas' : 'Compartir: que todos vean las mismas'}</button>
  </div>` : ''}
  ${cfg.yo.admin && cfg.usuarios ? `<div class="card"><h2>Usuarios (${cfg.usuarios.length})</h2>
    ${cfg.usuarios.map(u=>`<div class="item" style="flex-wrap:wrap"><div class="nm"><b>${esc(u.nombre)}</b></div>${u.admin?'<span class="tag ok">Admin</span>':''}
      <button class="btn sec sm" style="padding:0 10px" data-a="cfg-reset" data-id="${u.id}" data-n="${esc(u.nombre)}">Contraseña</button>
      ${u.id===cfg.yo.id?'':`<button class="btn sec sm" data-a="cfg-del" data-id="${u.id}" data-n="${esc(u.nombre)}">✕</button>`}</div>`).join('')}
    <h2 style="margin-top:16px">Agregar usuario</h2>
    <input id="c_un" autocapitalize="none" placeholder="Nombre de usuario">
    <input id="c_up" type="password" autocomplete="new-password" placeholder="Contraseña (mínimo 8)" style="margin-top:8px">
    <div class="row" style="margin-top:10px"><button class="btn" data-a="cfg-add">Agregar usuario</button></div>
  </div>`:''}`;
}
function vConfig(){
  const cur = (COLOR||COLORS[0]).toLowerCase();
  return `<div class="card"><h2>Color de la app</h2>
    <div class="sw">${COLORS.map(c=>`<button style="background:${c}" class="${c===cur?'on':''}" data-a="color" data-c="${c}"></button>`).join('')}</div>
    <h2>Otro color</h2>
    <input type="color" id="colorpick" value="${cur}" style="height:56px;padding:4px">
    <div class="row" style="margin-top:14px"><button class="btn sec" data-a="color" data-c="${COLORS[0]}">Volver al original</button></div>
  </div>${cfgCuentas()}`;
}
function vHistorial(){
  if(hist===null) return '<div class="card">Cargando…</div>';
  if(hist==='off') return '<div class="card">La base de datos no está configurada en el servidor.</div>';
  if(hist==='error') return '<div class="card">No se pudo cargar el historial.</div>';
  if(!hist.length) return '<div class="card">Todavía no hay planillas guardadas.</div>';
  return `<div class="card"><h2>Historial de planillas</h2>${hist.map(h=>`<div class="item" style="flex-wrap:wrap">
    <div class="nm"><b>${fechaLarga(h.created_at)}</b><span class="mut">${h.clientes} clientes · ${money(Number(h.total))}${h.usuario?' · '+esc(h.usuario):''}</span>${h.id===S.pid?' <span class="tag ok">Actual</span>':''}</div>
    <button class="btn sec" data-a="hist-open" data-id="${h.id}">Abrir</button>
    <button class="btn sec sm" data-a="hist-del" data-id="${h.id}">✕</button></div>`).join('')}</div>`;
}
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const MOTIVOS = ['Cerrado','No estaba','Producto dañado','Error de pedido','No lo pidió','Sin plata','Vencido'];
$('#motivos').innerHTML = MOTIVOS.map(m=>`<option value="${m}">`).join('');
const uid = () => Date.now().toString(36)+Math.random().toString(36).slice(2,6);
const get = id => S.clients.find(c=>c.id===id);

// ord = lugar en la planilla original (el orden en que se cargó). El orden del recorrido se puede cambiar; este no.
function addClient(name, total, addr){
  const ord = S.clients.reduce((m,c)=>Math.max(m,c.ord||0),0) + 1;
  S.clients.push({id:uid(), ord, name:name.trim(), addr:(addr||'').trim(), total:total||0, pay:{}, done:false});
}
// Planillas anteriores sin ord: se numera según el orden que tengan ahora y desde ahí queda fijo.
function normalizarOrden(){
  let max = S.clients.reduce((m,c)=>Math.max(m,c.ord||0),0), cambio = false;
  S.clients.forEach(c=>{ if(!c.ord){ c.ord = ++max; cambio = true; } });
  if(cambio) scheduleSync();
}

/* ---------- Render ---------- */
function render(){
  const logged = !!TOKEN;
  document.querySelector('nav').style.display = $('#navfoto').style.display = document.querySelector('header').style.display = logged ? '' : 'none';
  $('#menu').classList.remove('open');
  document.body.classList.toggle('login', !logged);
  $('#whoami').textContent = USERNAME ? 'Usuario: ' + USERNAME.charAt(0).toUpperCase() + USERNAME.slice(1) : '';
  if(!logged){ $('#app').innerHTML = vLogin(); return; }
  document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('on', b.dataset.t===S.tab));
  if(!listo){ $('#app').innerHTML = '<div class="card">Cargando planilla…</div>'; return; }
  $('#app').innerHTML = S.tab==='planilla' ? vPlanilla() : S.tab==='recorrido' ? vRecorrido() : S.tab==='historial' ? vHistorial() : S.tab==='config' ? vConfig() : vResumen();
  save();
  borradorGuardar();
}

function vLogin(){
  return `<div class="lg">
    <div class="logo">🚚</div>
    <h1>Reparto Nestlé</h1><p>Ingresá para continuar</p>
    <div class="box">
      <label for="l_user">Usuario</label>
      <input id="l_user" autocapitalize="none" autocomplete="username" value="${esc(loginUser)}" style="margin-bottom:14px">
      <label for="l_pass">Contraseña</label>
      <div class="pw"><input id="l_pass" type="password" autocomplete="current-password"><button type="button" data-a="showpass">Ver</button></div>
      ${loginErr?`<div class="hint" style="margin:12px 0 0;background:#fee2e2;color:#7f1d1d">${esc(loginErr)}</div>`:''}
      <button class="btn" style="margin-top:18px" data-a="login">Ingresar</button>
    </div></div>`;
}
function logout(){
  TOKEN=null; listo=false; conectado=false; cargando=false; clearTimeout(syncTimer); clearTimeout(cargaTimer); syncTimer=null;
  S.clients=[]; S.pid=null; S.ver=null; enviado=''; base=[]; setSync('');   // lo que quedó sin enviar sigue anotado y se sube al volver a entrar
  try{ localStorage.removeItem('reparto-token'); }catch(e){} loginErr=''; render();
}
async function doLogin(){
  loginUser = $('#l_user').value.trim();
  try{
    const r = await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({user:$('#l_user').value.trim(),pass:$('#l_pass').value})});
    const d = await r.json();
    if(!r.ok) throw new Error(d.error||'error');
    TOKEN = d.token; loginErr=''; USERNAME = d.user || loginUser;
    try{ localStorage.setItem('reparto-user', USERNAME); }catch(e){}
    try{ localStorage.setItem('reparto-token', TOKEN); }catch(e){}
    cargarServidor();
  }catch(err){ loginErr = err.message==='Failed to fetch' ? 'Sin conexión' : err.message; }
  render();
}

function vPlanilla(){
  const c = S.clients;
  return `
  <div class="card">
    <h2>Cargar cliente</h2>
    ${leyendo?`<div class="hint">${esc(leyendo)}</div>`:''}
    ${dupMsg?`<div class="hint">${esc(dupMsg)}</div>`:''}
    ${lastRestantes!==null?`<div class="mut" style="margin-bottom:6px">Fotos disponibles ahora: ${lastRestantes} de 3 (se renuevan cada 10 min)</div>`:''}
    <input data-f="mname" value="${esc(manual.name)}" placeholder="Cliente">
    <input data-f="maddr" value="${esc(manual.addr)}" placeholder="Dirección (opcional)" style="margin-top:8px">
    <div class="row" style="margin-top:8px">
      <input data-f="mtot" inputmode="decimal" value="${manual.total||''}" placeholder="Monto $" style="text-align:right">
      <button class="btn" data-a="madd">Agregar a la lista</button>
    </div>
  </div>
  ${photoRows.length?`<div class="card">
    <h2>Leídos de la foto (${photoRows.length})</h2>
    ${photoRows.some(d=>d.warn)?'<div class="hint">⚠ Revisá los importes marcados: no quedó claro dónde van los decimales.</div>':''}
    ${photoRows.map((d,i)=>pedi===i?
      `<div class="card cur" style="margin:8px 0">
        <input data-f="prname" data-i="${i}" value="${esc(d.name)}" placeholder="Cliente">
        <input data-f="praddr" data-i="${i}" value="${esc(d.addr||'')}" placeholder="Dirección" style="margin-top:8px">
        <input data-f="prtot" data-i="${i}" inputmode="decimal" value="${d.total||''}" placeholder="Monto $" style="margin-top:8px;text-align:right">
        <div class="row" style="margin-top:10px"><button class="btn bad" data-a="pr-del" data-i="${i}">Quitar</button><button class="btn" data-a="pr-edit" data-i="${i}">Listo ✔</button></div></div>`
      :`<div class="item" data-a="pr-edit" data-i="${i}"><div class="nm"><b>${esc(d.name)||'(sin nombre)'}</b></div><b>${d.warn?'⚠ ':''}${money(num(d.total))}</b></div>`).join('')}
    <div class="row" style="margin-top:12px"><button class="btn" data-a="padd">Agregar a la lista</button></div>
  </div>`:''}
  <div class="card">
    <h2>Clientes en recorrido (${c.length})</h2>
    ${c.length?[...c].sort((x,y)=>x.name.localeCompare(y.name,'es')).map(x=>editId===x.id?
      `<div class="card cur" style="margin:8px 0">
        <h2>Editar cliente</h2>
        <input data-f="cname" data-id="${x.id}" value="${esc(x.name)}" placeholder="Cliente">
        <input data-f="caddr" data-id="${x.id}" value="${esc(x.addr||'')}" placeholder="Dirección" style="margin-top:8px">
        <input data-f="total" data-id="${x.id}" inputmode="decimal" value="${fmtInput(x.total)}" placeholder="Monto $" style="margin-top:8px;text-align:right">
        <div class="row" style="margin-top:10px"><button class="btn bad" data-a="del" data-id="${x.id}">Borrar</button><button class="btn" data-a="pedit" data-id="${x.id}">Listo ✔</button></div></div>`
      :`<div class="item" data-a="pedit" data-id="${x.id}">
        <div class="nm"><b>${esc(x.name)}</b></div>
        <b>${money(x.total)}</b>
        <button class="btn sec sm" data-a="del" data-id="${x.id}" aria-label="Borrar cliente" style="color:var(--bad)">✕</button></div>`).join(''):'<div class="mut">Todavía no hay clientes.</div>'}
    ${c.length?`<div class="row" style="margin-top:10px"><button class="btn" data-a="go">Empezar recorrido →</button></div>`:''}
  </div>`;
}

function payButtons(c){
  const m = c.method, rz = c.rech && rechMonto(c)>0;
  return `<div class="pays">${METHODS.filter(x=>x[0]!=='mix').map(([k,l])=>`<button class="${m===k?'on':''}" data-a="pay" data-k="${k}" data-id="${c.id}">${l}</button>`).join('')}
    <button class="${m==='mix'?'on':''}" data-a="pay" data-k="mix" data-id="${c.id}">Pago mixto</button>
    <button class="${rz||rechOpen===c.id?'bad-on':''}" data-a="rechopen" data-id="${c.id}">Rechazado</button>
    <button data-a="nopay" data-id="${c.id}" class="${c.done&&!sum(c)&&!c.method&&!rz?'on':''}" style="grid-column:1/3">No pagó / no estaba</button></div>
  ${mixOpen===c.id?mixPanel(c):''}${rechOpen===c.id?rechPanel(c):''}`;
}
function mixPanel(c){
  const sel = mixSel[c.id] || (mixSel[c.id] = KEYS.filter(k=>(c.pay[k]||0)>0));
  const last = sel[sel.length-1], auto = !mixManual[c.id];
  return `<div class="mut" style="margin:10px 0 4px">Elegí cómo paga${c.rech&&rechMonto(c)>0?' lo que queda ('+money(debe(c))+')':''}</div>
    <div class="chips">${KEYS.map(k=>`<button class="chip ${sel.includes(k)?'on':''}" data-a="mixtog" data-k="${k}" data-id="${c.id}">${LABEL[k]}</button>`).join('')}</div>
    ${sel.length?sel.map(k=>`<div class="mixrow"><label>${LABEL[k]}${k===last&&auto&&sel.length>1?' · resto automático':''}</label><input data-f="mix" data-k="${k}" data-id="${c.id}" inputmode="decimal" value="${fmtInput(c.pay[k])}" placeholder="0"></div>`).join(''):'<div class="mut">Tocá los medios de pago que usa.</div>'}
    <div class="mut" id="mixrest-${c.id}">${restTxt(debe(c)-sum(c))}</div>`;
}
function rechPanel(c){
  const r = c.rech || {tipo:'parcial',monto:0,motivo:''};
  return `<div class="mut" style="margin:10px 0 4px">Pedido rechazado</div>
    <div class="seg">${[['parcial','Parcial'],['total','Total']].map(([k,l])=>
      `<button class="${r.tipo===k?'on':''}" data-a="rech" data-k="${k}" data-id="${c.id}">${l}</button>`).join('')}</div>
    ${r.tipo==='parcial'?`<div class="mixrow"><label>Monto rechazado</label><input data-f="rmonto" data-id="${c.id}" inputmode="decimal" value="${fmtInput(r.monto)}" placeholder="0" style="text-align:right"></div>
    <div class="mixrow"><label>Resto a cobrar · se calcula solo, podés editarlo</label><input data-f="rresto" data-id="${c.id}" inputmode="decimal" value="${fmtInput(r2(c.total-(r.monto||0)))}" placeholder="0" style="text-align:right"></div>`:''}
    <input data-f="rmotivo" data-id="${c.id}" list="motivos" value="${esc(r.motivo||'')}" placeholder="Motivo (ej: cerrado, producto dañado)" style="margin-top:8px">
    <div class="mut" style="margin-top:8px">${r.tipo==='total'?'Se rechaza todo el pedido: no hay nada para cobrar.':'Después elegí arriba cómo paga lo que queda (Efectivo, Transferencia, Pago mixto…).'}</div>
    <div class="row" style="margin-top:10px"><button class="btn sec" data-a="rech" data-k="ninguno" data-id="${c.id}">Quitar rechazo</button><button class="btn" data-a="rechok" data-id="${c.id}">Listo ✔</button></div>`;
}
const restTxt = r => Math.abs(r)<0.005?'Completo ✔': r>0?`Falta asignar ${money(r)}`:`Te pasaste ${money(-r)}`;

function statusTag(c){
  if(c.total<0) return '<span class="tag warn">Nota de crédito</span>';
  if(!c.done) return '<span class="tag">Sin visitar</span>';
  const r = c.rech, rt = r && r.tipo==='total', rp = r && r.tipo==='parcial' && rechMonto(c)>0;
  if(rt) return '<span class="tag bad">Rechazado total</span>';
  const rest = debe(c) - sum(c), cc = c.pay.cc||0;
  let t;
  if(rest>0.005) t = `<span class="tag bad">Pendiente ${money(rest)}</span>`;
  else if(cc>0) t = `<span class="tag warn">Cta cte ${money(cc)}</span>`;
  else if((c.pay.fi||0)>0) t = `<span class="tag warn">Firmado ${money(c.pay.fi)}</span>`;
  else t = `<span class="tag ok">Cobrado · ${c.method && c.method!=='mix' ? LABEL[c.method] : 'Mixto'}</span>`;
  return t + (rp ? ` <span class="tag bad">Rechazado ${money(rechMonto(c))}</span>` : '');
}

function vRecorrido(){
  const c = S.clients;
  if(!c.length) return '<div class="card">Cargá clientes en la pestaña Planilla.</div>';
  const todo = c.filter(x=>!x.done), done = c.filter(x=>x.done);
  if(ordering) return `<div class="card"><h2>Ordenar recorrido</h2>
    <div class="hint">Tocá los clientes en el orden en que los vas a visitar. Van quedando numerados.</div>
    ${todo.map(x=>{ const pos=ordering.indexOf(x.id)+1; return `<div class="item" data-a="pick" data-id="${x.id}">
      <span class="n ${pos?'':'off'}">${pos||'·'}</span><div class="nm"><b>${esc(x.name)}</b><span class="mut">${esc(x.addr)}</span></div><b>${money(x.total)}</b></div>`; }).join('')}
    <div class="row" style="margin-top:12px"><button class="btn sec" data-a="ordreset">Borrar selección</button><button class="btn" data-a="ordend">Listo ✔</button></div></div>`;
  let h = '';
  if(!todo.length) h += `<div class="card"><div class="big">Recorrido terminado 🎉</div><div class="row" style="margin-top:10px"><button class="btn" data-a="tosum">Ver resumen</button></div></div>`;
  h += `<div class="card"><h2>Recorrido (${done.length} de ${c.length})</h2>
    <div class="mut" style="margin-bottom:6px">Tocá un cliente para cobrarle o cambiar el pago. Mantené apretado un pendiente para ordenar.</div>
    ${todo.length>1?'<button class="btn sec" style="width:100%;margin-bottom:6px" data-a="ordenar">Ordenar recorrido</button>':''}
    ${c.map((x,k)=>{
      if(sel===x.id) return `<div class="card cur" style="margin:8px 0"><div class="big">${esc(x.name)}</div><div class="mut">${esc(x.addr)}</div>
        <div class="big" style="color:var(--pri)">${money(x.total)}</div>${x.total<0?`<div class="hint">Nota de crédito: es un importe a favor del cliente, no hay nada para cobrar.</div><div class="row"><button class="btn" data-a="ncok" data-id="${x.id}">Marcar como visitado</button></div>`:payButtons(x)}
        <div class="row"><button class="btn sec" data-a="sel" data-id="${x.id}">Cerrar</button><button class="btn sec" style="color:var(--bad)" data-a="del" data-id="${x.id}">Borrar cliente</button>${mixOpen===x.id?`<button class="btn" data-a="mixok" data-id="${x.id}">Listo ✔</button>`:''}</div></div>`;
      if(x.done) return `<div class="item done" data-a="sel" data-id="${x.id}"><span class="n ok">✓</span><div class="nm"><b>${esc(x.name)}</b>${statusTag(x)}</div><b>${money(x.total)}</b><button class="btn sec sm pen" data-a="sel" data-id="${x.id}" aria-label="Editar">✎</button></div>`;
      return `<div class="item" data-a="sel" data-id="${x.id}" data-lp="1"><span class="n off">${k+1}</span><div class="nm"><b>${esc(x.name)}</b></div><b>${money(x.total)}</b>
        <button class="btn sec sm" data-a="up" data-id="${x.id}">↑</button><button class="btn sec sm" data-a="down" data-id="${x.id}">↓</button></div>`;
    }).join('')}</div>`;
  return h;
}

function totals(){
  const t = {ef:0,tr:0,ch:0,ec:0,cc:0,fi:0,sin:0,total:0,rechT:0,rechP:0,nc:0};
  S.clients.forEach(c=>{
    t.total += c.total;
    if(c.total<0){ t.nc += c.total; return; }   // nota de crédito: reduce lo que hay que cobrar, no se cobra
    KEYS.forEach(k=>t[k]+=c.pay[k]||0);
    t.sin += Math.max(0, debe(c) - sum(c));
    if(c.rech && c.rech.tipo==='total') t.rechT += rechMonto(c); else t.rechP += rechMonto(c);
  });
  Object.keys(t).forEach(k=>{ t[k] = r2(t[k]); });
  return t;
}
function pendientesHTML(){
  const c = porPlanilla(S.clients);
  // pendientes separados por tipo; un cliente puede estar en más de un grupo (cada uno con su monto)
  const g = {fi:[],cc:[],sin:[],nv:[]};
  c.forEach(x=>{
    const rest = Math.max(0, debe(x) - sum(x));
    const rz = rechMonto(x)>0 ? `Pedido ${money(x.total)} · rechazado ${money(rechMonto(x))}` : '';
    if(!x.done){ if(debe(x)>0.005) g.nv.push({x, monto:debe(x), det:rz||'No se visitó'}); return; }
    if((x.pay.fi||0)>0) g.fi.push({x, monto:x.pay.fi, det:rz});
    if((x.pay.cc||0)>0) g.cc.push({x, monto:x.pay.cc, det:rz});
    if(rest>0.005) g.sin.push({x, monto:rest, det:rz||'Visitado, no pagó'});
  });
  const totPend = [...g.fi,...g.cc,...g.sin,...g.nv].reduce((a,o)=>a+o.monto,0);
  const grupo = (titulo, arr) => `<h3>${titulo} (${arr.length})</h3>` + (arr.length ?
    `<table class="pend"><tr><th>Cliente</th><th>Dirección</th><th>Detalle</th><th class="r">A cobrar</th></tr>
    ${arr.map(o=>`<tr><td>${esc(o.x.name)}</td><td>${esc(o.x.addr||'')}</td><td>${esc(o.det||'')}</td><td class="r">${money(o.monto)}</td></tr>`).join('')}
    <tr class="tot"><td colspan="3">Subtotal</td><td class="r">${money(arr.reduce((a,o)=>a+o.monto,0))}</td></tr></table>` : '<div>—</div>');
  return `<h2>Pendientes a cobrar</h2>
  ${grupo('Firmado',g.fi)}${grupo('Cuenta corriente',g.cc)}${grupo('Visitados que no pagaron / sin cobrar',g.sin)}${grupo('Sin visitar',g.nv)}
  <table><tr class="tot"><td>Total pendiente a cobrar</td><td class="r">${money(totPend)}</td></tr></table>`;
}
function buildPendientes(){
  const hoy = new Date().toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit',year:'numeric'});
  return `<h1>Reparto Nestlé</h1>
  <div>Pendientes a cobrar · Fecha: ${hoy}${USERNAME?' · Usuario: '+esc(USERNAME):''} · Visitados ${S.clients.filter(x=>x.done).length} de ${S.clients.length}</div>
  ${pendientesHTML()}`;
}
function imprimir(html, nombre){
  $('#reporte').innerHTML = html;
  const prev = document.title;
  document.title = nombre + ' ' + new Date().toISOString().slice(0,10);   // nombre sugerido del archivo
  window.addEventListener('afterprint', ()=>{ document.title = prev; }, {once:true});
  window.print();
}
function exportarPendientes(){ imprimir(buildPendientes(), 'Reparto Nestlé pendientes'); }
function buildReporte(){
  const t = totals(), c = porPlanilla(S.clients);
  const cobrado = t.ef+t.tr+t.ch+t.ec;
  const hoy = new Date().toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit',year:'numeric'});
  const medios = x => KEYS.filter(k=>(x.pay[k]||0)>0).map(k=>`${LABEL[k]} ${money(x.pay[k])}`).join(' · ');
  const estado = x => {
    if(x.total<0) return 'Nota de crédito';
    if(!x.done) return 'Sin visitar';
    const rest = debe(x) - sum(x);
    const m = medios(x);
    const rz = x.rech && rechMonto(x)>0 ? `Rechazado ${x.rech.tipo==='total'?'total':'parcial'} ${money(rechMonto(x))}${x.rech.motivo?' ('+x.rech.motivo+')':''}` : '';
    return [m, rz, rest>0.005 ? `Sin cobrar ${money(rest)}` : '', !m && !rz && rest<=0.005 ? '—' : ''].filter(Boolean).join(' · ') || 'No pagó';
  };
  const rechazados = c.filter(x=>x.rech && rechMonto(x)>0);
  const fila = (a,b) => `<tr><td>${a}</td><td class="r">${money(b)}</td></tr>`;
  const pendHTML = pendientesHTML();
  return `<h1>Reparto Nestlé</h1>
  <div>Fecha: ${hoy}${USERNAME?' · Usuario: '+esc(USERNAME):''} · Visitados ${c.filter(x=>x.done).length} de ${c.length}</div>
  <h2>Pedidos</h2>
  <table><tr class="tot"><td>Total de todos los pedidos</td><td class="r">${money(t.total)}</td></tr>
    ${fila('Rechazado total (−)',t.rechT)}${fila('Rechazado parcial (−)',t.rechP)}
    <tr class="tot"><td>Total a cobrar</td><td class="r">${money(t.total-t.rechT-t.rechP)}</td></tr></table>
  <h2>Lo que tiene que haber</h2>
  <table>${fila('Efectivo',t.ef)}${fila('Transferencia',t.tr)}${fila('Cheque',t.ch)}${fila('E-Cheq',t.ec)}
    <tr class="tot"><td>Total cobrado</td><td class="r">${money(cobrado)}</td></tr>
    ${fila('Cuenta corriente',t.cc)}${fila('Firmado',t.fi)}${fila('Sin cobrar / sin marcar',t.sin)}${t.nc?fila('Notas de crédito',t.nc):''}</table>
  <h2>Detalle por cliente</h2>
  <table><tr><th>#</th><th>Cliente</th><th>Dirección</th><th class="r">Importe</th><th>Pago</th></tr>
    ${c.map((x,i)=>`<tr><td>${i+1}</td><td>${esc(x.name)}</td><td>${esc(x.addr||'')}</td><td class="r">${money(x.total)}</td><td>${esc(estado(x))}</td></tr>`).join('')}
    <tr class="tot"><td colspan="3">Total</td><td class="r">${money(t.total)}</td><td></td></tr></table>
  ${rechazados.length?`<h2>Pedidos rechazados (${rechazados.length})</h2>
  <table><tr><th>Cliente</th><th>Tipo y motivo</th><th class="r">Monto</th></tr>
    ${rechazados.map(x=>`<tr><td>${esc(x.name)}</td><td>${x.rech.tipo==='total'?'Total':'Parcial'}${x.rech.motivo?' · '+esc(x.rech.motivo):''}</td><td class="r">${money(rechMonto(x))}</td></tr>`).join('')}
    <tr class="tot"><td colspan="2">Total rechazado</td><td class="r">${money(t.rechT+t.rechP)}</td></tr></table>`:''}
  ${pendHTML}`;
}
function exportarPDF(){ imprimir(buildReporte(), 'Reparto Nestlé'); }
function vResumen(){
  if(!S.clients.length) return '<div class="card">No hay datos todavía.</div>';
  const t = totals();
  const cobrado = t.ef+t.tr+t.ch+t.ec;
  const pend = S.clients.filter(c=>debe(c) - sum(c) > 0.005 || (c.pay.cc||0)>0 || (c.pay.fi||0)>0);
  const rechazados = S.clients.filter(c=>c.rech && rechMonto(c)>0);
  return `
  <div class="card"><button class="btn" style="width:100%;margin-bottom:12px" data-a="pdf">Exportar a PDF</button>
    <button class="btn sec" style="width:100%;margin-bottom:12px" data-a="pdfpend">Descargar solo los pendientes (PDF)</button>
    <h2>Pedidos</h2>
    <table class="tbl">
      <tr><td><b>Total de todos los pedidos</b></td><td>${money(t.total)}</td></tr>
      <tr><td>🚫 Rechazado total</td><td style="color:var(--bad)">− ${money(t.rechT)}</td></tr>
      <tr><td>🚫 Rechazado parcial</td><td style="color:var(--bad)">− ${money(t.rechP)}</td></tr>
      <tr><td><b>Total a cobrar</b></td><td>${money(t.total - t.rechT - t.rechP)}</td></tr>
    </table>
    <h2 style="margin-top:14px">Lo que tiene que haber</h2>
    <table class="tbl">
      <tr><td>💵 Efectivo</td><td>${money(t.ef)}</td></tr>
      <tr><td>🏦 Transferencia</td><td>${money(t.tr)}</td></tr>
      <tr><td>📄 Cheque</td><td>${money(t.ch)}</td></tr>
      <tr><td>📱 E-Cheq</td><td>${money(t.ec)}</td></tr>
      <tr><td><b>Total cobrado</b></td><td style="color:var(--ok)">${money(cobrado)}</td></tr>
      <tr><td>📒 Cuenta corriente</td><td>${money(t.cc)}</td></tr>
      <tr><td>✍️ Firmado</td><td>${money(t.fi)}</td></tr>
      <tr><td>⏳ Sin cobrar / sin marcar</td><td style="color:var(--bad)">${money(t.sin)}</td></tr>
      ${t.nc?`<tr><td>↩️ Notas de crédito</td><td>${money(t.nc)}</td></tr>`:''}
    </table>
    <div class="mut" style="margin-top:6px">Visitados ${S.clients.filter(c=>c.done).length} de ${S.clients.length}</div>
  </div>
  ${rechazados.length?`<div class="card"><h2>Pedidos rechazados (${rechazados.length})</h2>
    ${rechazados.map(c=>`<div class="item"><div class="nm"><b>${esc(c.name)}</b><span class="mut show">${c.rech.tipo==='total'?'Total':'Parcial'}${c.rech.motivo?' · '+esc(c.rech.motivo):''}</span></div><b>${money(rechMonto(c))}</b></div>`).join('')}
    <div class="row" style="margin-top:8px"><b>Total rechazado</b><b style="text-align:right">${money(t.rechT+t.rechP)}</b></div></div>`:''}
  <div class="card"><h2>Clientes pendientes a cobrar (${pend.length})</h2>
    ${pend.length?pend.map(c=>{
      const rest = Math.max(0, debe(c) - sum(c)), cc = c.pay.cc||0, fi = c.pay.fi||0;
      const det = [!c.done?'Sin visitar':'', cc>0?'Cta cte '+money(cc):'', fi>0?'Firmado '+money(fi):'', rest>0.005?'Sin cobrar '+money(rest):''].filter(Boolean).join(' · ');
      return `<div class="item"><div class="nm"><b>${esc(c.name)}</b><span class="mut show">${det}</span></div>
      <b>${money(cc+fi+rest)}</b></div>`;}).join('')
      :'<div class="mut">Nada pendiente ✔</div>'}
    ${pend.length?`<div class="row" style="margin-top:8px"><b>Total pendiente</b><b style="text-align:right">${money(t.cc+t.fi+t.sin)}</b></div>`:''}
  </div>`;
}

/* ---------- Acciones ---------- */
// si ya tenía un único medio de pago, lo ajusta a lo que realmente hay que cobrar
function resync(c){ if(c.method && c.method!=='mix' && c.method!=='rech' && c.pay[c.method]!==undefined) c.pay={[c.method]:debe(c)}; }
function setPay(c, k){
  if(k==='mix'){ c.method='mix'; c.done=true; mixOpen=c.id; rechOpen=null; delete mixSel[c.id]; mixManual[c.id]=false; return; }
  c.method=k; c.done=true; c.pay={[k]:debe(c)}; mixOpen=null; rechOpen=null; delete mixSel[c.id];
}

document.addEventListener('click', e=>{
  if(lpFired){ lpFired=false; return; }
  if(e.target.id==='menubtn'){ $('#menu').classList.toggle('open'); return; }
  if(!e.target.closest('#menu')) $('#menu').classList.remove('open'); else if(e.target.id!=='reset') $('#menu').classList.remove('open');
  if(e.target.id==='logout') return logout();
  if(e.target.closest('#navfoto')){ $('#fotosheet').style.display='flex'; return; }
  if(e.target.closest('#fotosheet')){
    const a = e.target.dataset.a; $('#fotosheet').style.display='none';
    if(a==='foto-cam') $('#foto').click(); else if(a==='foto-gal') $('#fotog').click();
    return;
  }
  const nav = e.target.closest('nav button[data-t]');
  if(nav){ S.tab=nav.dataset.t; mixOpen=null; ordering=null; editId=null; return render(); }
  if(e.target.id==='cfgbtn'){ S.tab='config'; mixOpen=null; rechOpen=null; sel=null; render(); loadCfg(); return; }
  if(e.target.id==='histbtn'){ S.tab='historial'; mixOpen=null; rechOpen=null; sel=null; loadHist(); return; }
  if(e.target.id==='reset'){
    if(!confirm('¿Empezar una planilla nueva? La actual queda guardada en el historial.')) return;
    (async()=>{
      if(!await asegurarEnviado()){ alert('Hay cambios que todavía no se enviaron al servidor (sin señal). Esperá a que se envíen antes de empezar una planilla nueva.'); return; }
      S.photo=null; S.clients=[]; S.pid=null; S.ver=null; S.tab='planilla'; manual={name:'',addr:'',total:''}; photoRows=[]; pedi=null; ordering=null; mixOpen=null;
      marcarEnviado(); render();
    })();
    return;
  }
  const el = e.target.closest('[data-a]'); if(!el) return;
  const a = el.dataset.a, id = el.dataset.id, c = id&&get(id);
  const i = c ? S.clients.indexOf(c) : -1;
  switch(a){
    case 'login': return doLogin();
    case 'ncok': c.done=true; c.method=null; c.pay={}; c.rech=null; sel=null; break;
    case 'cfg-nombre': cfgRun(async()=>{ const d = await api('PUT','/api/yo',{nombre:$('#c_nombre').value}); setSesion(d.token, d.user.nombre); cfg.yo = {...cfg.yo, nombre:d.user.nombre}; await loadCfgLista(); }, 'Nombre de usuario actualizado.'); return;
    case 'cfg-pass': {
      const pn = $('#c_pn').value;
      if(pn !== $('#c_pn2').value){ cfg.msg=''; cfg.err='Las contraseñas nuevas no coinciden.'; render(); return; }
      cfgRun(async()=>{ const d = await api('PUT','/api/yo',{passActual:$('#c_pa').value, passNueva:pn}); setSesion(d.token, d.user.nombre); }, 'Contraseña cambiada.'); return; }
    case 'cfg-compartidas': cfgRun(async()=>{ const d = await api('PUT','/api/ajustes',{compartidas:!cfg.yo.compartidas}); cfg.yo = {...cfg.yo, compartidas:d.compartidas}; }, 'Ajuste guardado.'); return;
    case 'cfg-add': cfgRun(async()=>{ await api('POST','/api/usuarios',{nombre:$('#c_un').value, pass:$('#c_up').value}); await loadCfgLista(); }, 'Usuario agregado.'); return;
    case 'cfg-reset': { const n = prompt('Nueva contraseña para '+el.dataset.n+' (mínimo 6 caracteres):'); if(!n) return;
      cfgRun(async()=>{ await api('PUT','/api/usuarios/'+id+'/pass',{pass:n}); }, 'Contraseña de '+el.dataset.n+' actualizada.'); return; }
    case 'cfg-del': if(!confirm('¿Borrar el usuario '+el.dataset.n+'? Sus datos de acceso se eliminan; las planillas no se borran.')) return;
      cfgRun(async()=>{ await api('DELETE','/api/usuarios/'+id); await loadCfgLista(); }, 'Usuario borrado.'); return;
    case 'showpass': { const i=$('#l_pass'); i.type = i.type==='password'?'text':'password'; el.textContent = i.type==='password'?'Ver':'Ocultar'; return; }
    case 'color': applyColor(el.dataset.c); break;
    case 'hist-open': (async()=>{
      if(!await asegurarEnviado()){ alert('Hay cambios que todavía no se enviaron al servidor (sin señal). Esperá a que se envíen.'); return; }
      try{ const d = await api('GET','/api/planillas/'+id); S.pid=d.id; S.ver=d.version; S.clients=limpiarClientes(d.data.clients).clients; S.tab='planilla'; marcarEnviado(); normalizarOrden(); render(); }
      catch(e){ if(e.status!==401) setSync('No se pudo abrir la planilla.', true); }
    })(); return;
    case 'hist-del': if(!confirm('¿Borrar esta planilla del historial?')) return;
      api('DELETE','/api/planillas/'+id).then(()=>{ if(+id===S.pid){ S.pid=null; S.ver=null; S.clients=[]; marcarEnviado(); } loadHist(); }).catch(()=>setSync('No se pudo borrar.')); return;
    case 'madd': {
      if(!manual.name.trim()) return;
      const r = dedupe([manual], S.clients);
      r.rows.forEach(d=>addClient(d.name, num(d.total), d.addr));
      dupMsg = r.dups ? 'Ese cliente ya está en la lista con el mismo importe.' : '';
      manual = {name:'',addr:'',total:''}; break; }
    case 'padd': {
      const r = dedupe(photoRows.filter(d=>d.name.trim()), S.clients);
      r.rows.forEach(d=>addClient(d.name, num(d.total), d.addr));
      dupMsg = r.dups ? `Se omitieron ${r.dups} repetido${r.dups>1?'s':''} (mismo nombre e importe).` : '';
      photoRows = []; pedi = null; break; }
    case 'pr-edit': { const k=+el.dataset.i; if(pedi===k) photoRows[k].warn=false; pedi = pedi===k ? null : k; break; }
    case 'pr-del': photoRows.splice(+el.dataset.i,1); pedi=null; break;
    case 'pedit': editId = editId===id ? null : id; break;
    case 'del': if(!confirm(`¿Borrar a "${c.name}" (${money(c.total)}) de la planilla?\n\nNo se puede deshacer.`)) return; S.clients.splice(i,1); editId=null; sel=null; mixOpen=null; rechOpen=null; break;
    case 'up': case 'down': {
      const todo = S.clients.filter(x=>!x.done), k = todo.indexOf(c), o = todo[k+(a==='up'?-1:1)];
      if(o){ const j=S.clients.indexOf(o); [S.clients[i],S.clients[j]]=[S.clients[j],S.clients[i]]; }
      break; }
    case 'ordreset': ordering=[]; break;
    case 'ordenar': ordering=[]; break;
    case 'pick':
      if(!ordering.includes(id)) ordering.push(id);
      if(ordering.length===S.clients.filter(x=>!x.done).length) a_finishOrder();
      break;
    case 'ordend': a_finishOrder(); break;
    case 'go': S.tab='recorrido'; break;
    case 'sel': sel = sel===id ? null : id; mixOpen = (sel===id && c.method==='mix') ? id : null; rechOpen = (sel===id && c.rech && rechMonto(c)>0) ? id : null; break;
    case 'pay': setPay(c, el.dataset.k); sel = el.dataset.k==='mix' ? id : null; break;
    case 'rechopen': rechOpen = rechOpen===id ? null : id; if(rechOpen===id) mixOpen=null; if(!c.rech) c.rech={tipo:'parcial',monto:0,motivo:''}; break;
    case 'nopay': sel=null; c.method=null; c.pay={}; c.rech=null; c.done=true; mixOpen=null; rechOpen=null; break;
    case 'mixtog': {
      const k = el.dataset.k, sel = mixSel[id] || (mixSel[id] = KEYS.filter(x=>(c.pay[x]||0)>0));
      if(sel.includes(k)){ sel.splice(sel.indexOf(k),1); delete c.pay[k]; } else sel.push(k);
      mixManual[id] = false; mixRecalc(c); break; }
    case 'rech': {
      const k = el.dataset.k, prev = c.rech || {};
      if(k==='ninguno'){ c.rech=null; if(c.method==='rech') c.method=null; rechOpen=null; resync(c); }
      else if(k==='total'){ c.rech={tipo:'total', monto:c.total, motivo:prev.motivo||''}; c.pay={}; c.method='rech'; c.done=true; rechOpen=id; mixOpen=null; }
      else { c.rech={tipo:'parcial', monto:prev.tipo==='parcial'?prev.monto:0, motivo:prev.motivo||''}; if(c.method==='rech') c.method=null; c.done=true; rechOpen=id; resync(c); mixRecalc(c); }
      break; }
    case 'rechok': if(c.rech && c.rech.tipo==='parcial' && !(c.rech.monto>0)) c.rech=null; rechOpen=null; if(c.rech && c.rech.tipo==='total') sel=null; break;
    case 'mixok': mixOpen=null; sel=null; break;
    case 'tosum': S.tab='resumen'; break;
    case 'pdf': exportarPDF(); return;
    case 'pdfpend': exportarPendientes(); return;
  }
  render();
});

function a_finishOrder(){
  // los pendientes se reacomodan en los mismos lugares; los ya cobrados no se mueven
  const todo = S.clients.filter(x=>!x.done);
  const nuevo = ordering.map(get).filter(x=>x&&!x.done).concat(todo.filter(x=>!ordering.includes(x.id)));
  let k = 0;
  S.clients = S.clients.map(x=> x.done ? x : nuevo[k++]);
  ordering = null;
}

let lpTimer = null, lpFired = false;
document.addEventListener('pointerdown', e=>{
  const it = e.target.closest('[data-lp]'); if(!it || e.target.closest('button')) return;
  clearTimeout(lpTimer);
  lpTimer = setTimeout(()=>{ lpFired=true; ordering=[it.dataset.id]; render(); }, 600);
});
['pointerup','pointercancel','pointermove','pointerleave'].forEach(t=>document.addEventListener(t, ()=>clearTimeout(lpTimer)));
document.addEventListener('contextmenu', e=>{ if(e.target.closest('[data-lp]')) e.preventDefault(); });

document.addEventListener('keydown', e=>{ if(e.key==='Enter' && e.target.id==='l_pass') doLogin(); });

document.addEventListener('input', e=>{
  if(e.target.id==='colorpick'){ applyColor(e.target.value); return; }
  const f = e.target.dataset.f; if(!f) return;
  if(f==='cname'||f==='caddr'){ const c=get(e.target.dataset.id); if(c){ c[f==='cname'?'name':'addr']=e.target.value; save(); } return; }
  if(f==='mname'||f==='maddr'||f==='mtot'){ manual[f==='mname'?'name':f==='maddr'?'addr':'total']=e.target.value; borradorGuardar(); return; }
  if(f==='prname'||f==='praddr'||f==='prtot'){ photoRows[+e.target.dataset.i][f==='prname'?'name':f==='praddr'?'addr':'total']=e.target.value; borradorGuardar(); return; }
  const c = get(e.target.dataset.id); if(!c) return;
  if(f==='total'){ c.total = num(e.target.value); if(c.rech && c.rech.tipo==='total') c.rech.monto = c.total;
    resync(c); save(); }
  const refrescar = ()=>{
    const r=$('#mixrest-'+c.id); if(r) r.textContent = restTxt(debe(c)-sum(c));
    (mixSel[c.id]||[]).forEach(k=>{ const i=document.querySelector(`input[data-f=mix][data-k=${k}][data-id="${c.id}"]`); if(i && i!==document.activeElement) i.value = fmtInput(c.pay[k]); });
  };
  if(f==='mix'){
    const k = e.target.dataset.k, sel = mixSel[c.id] || [];
    c.pay[k] = num(e.target.value);
    if(k===sel[sel.length-1]) mixManual[c.id] = true;   // si edita el resto automático, pasa a manual
    else mixRecalc(c);
    refrescar(); save();
  }
  if(f==='rmonto' || f==='rresto'){
    if(c.rech){
      const v = num(e.target.value);
      c.rech.monto = Math.min(c.total, Math.max(0, f==='rmonto' ? v : r2(c.total - v)));
      const otro = document.querySelector(`input[data-f=${f==='rmonto'?'rresto':'rmonto'}][data-id="${c.id}"]`);
      if(otro) otro.value = fmtInput(f==='rmonto' ? r2(c.total-c.rech.monto) : c.rech.monto);
      resync(c); mixRecalc(c); refrescar(); save();
    }
  }
  if(f==='rmotivo'){ if(c.rech) c.rech.motivo = e.target.value; save(); }
});

/* ---------- Foto + OCR ---------- */
const MAX_FOTOS = 3;   // por tanda; el servidor además limita 3 fotos cada 10 minutos
function reducirFoto(file){
  return new Promise((ok,ko)=>{
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = ()=>{
      const sc = Math.min(1, 1600/Math.max(img.width,img.height));
      const cv = document.createElement('canvas');
      cv.width=img.width*sc; cv.height=img.height*sc;
      cv.getContext('2d').drawImage(img,0,0,cv.width,cv.height);
      URL.revokeObjectURL(url); ok(cv.toDataURL('image/jpeg',.8));
    };
    img.onerror = ()=>ko(new Error('imagen inválida'));
    img.src = url;
  });
}
document.addEventListener('change', e=>{
  if((e.target.id!=='foto' && e.target.id!=='fotog') || !e.target.files[0]) return;
  const files = [...e.target.files];
  e.target.value = '';
  S.tab = 'planilla';
  leerFotos(files);
});
async function leerFotos(files){
  if(leyendo) return;
  const msgs = [];
  if(files.length>MAX_FOTOS){ msgs.push(`Solo se pueden subir ${MAX_FOTOS} fotos a la vez: se tomaron las primeras ${MAX_FOTOS}.`); files = files.slice(0,MAX_FOTOS); }
  dupMsg = ''; let dups = 0, leidas = 0;
  try{
    for(let i=0;i<files.length;i++){
      leyendo = `Leyendo foto ${i+1} de ${files.length}…`; render();
      const image = await reducirFoto(files[i]);
      const r = await fetch('/api/leer',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+TOKEN},body:JSON.stringify({image})});
      if(r.status===401){ leyendo=''; return logout(); }
      const d = await r.json();
      if(r.status===429){ msgs.push(d.error + (i<files.length-1 ? ` Se leyeron ${leidas} de ${files.length} fotos.` : '')); break; }
      if(!r.ok) throw new Error(d.error||'error');
      leidas++;
      const dd = dedupe(photoRows.concat(d.clients.map(c=>({name:c.name, addr:c.addr||'', total:fmtInput(c.total), warn:!!c.revisar}))));
      dups += photoRows.length + d.clients.length - dd.rows.length;
      photoRows = dd.rows; pedi = null;
      lastRestantes = d.restantes;
    }
    if(dups) msgs.push(`Se quitaron ${dups} repetido${dups>1?'s':''} (mismo nombre e importe).`);
    if(leidas && !photoRows.length) msgs.push('No se encontraron clientes. Cargalos a mano.');
  }catch(err){ msgs.push('No se pudo leer la foto ('+err.message+'). Cargá los clientes a mano mirando la foto.'); }
  leyendo = ''; dupMsg = msgs.join(' '); render();
}
let lastRestantes = null;

if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
window.addEventListener('online', ()=>{ if(!listo || !conectado) cargarServidor(); else syncSave(); });
// Se actualiza sola con lo que cambió otro celular, siempre que no haya nada sin enviar ni se esté editando.
async function refrescarSiLibre(){
  if(!TOKEN || !listo || !conectado || sinEnviar || syncing || cargando || !S.pid || document.visibilityState!=='visible') return;
  const a = document.activeElement; if(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
  if(sel || mixOpen || rechOpen || editId || pedi!==null || ordering || !['planilla','recorrido','resumen'].includes(S.tab)) return;
  try{
    const d = await api('GET','/api/planillas/'+S.pid);
    if(d.version===S.ver || sinEnviar || syncing) return;
    S.ver = d.version; S.clients = limpiarClientes(d.data.clients).clients; marcarEnviado(); render();
  }catch(e){}
}
setInterval(refrescarSiLibre, 20000);
document.addEventListener('visibilitychange', refrescarSiLibre);
window.addEventListener('focus', refrescarSiLibre);
render();
if(TOKEN) cargarServidor();
