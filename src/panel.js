import { N } from './app.js';
const { abrirEditorPedido, abrirVentanaPendiente, actualizarBadge, bloquearCamposCliente, cacheClear, cantidadConCajas, cerrarVentanaPendiente, esAdmin, esAdminEstricto, guardarSesion, initMaps, irAWhatsApp, irAlCatalogo, mostrarToast, renderClubAdminCfg, renderDrawer, saborDot, sesionExpirada, sheetsCall, supabaseCall, tokenVendedor, totalItems } = N;


// ── Ajustar ubicación de un cliente existente (vendedor en sitio) ──
window.abrirAjustarUbicacion = function() {
  const e = document.getElementById('au-tel'); if (e) e.value = '';
  window._auGps = null; window._auTel = null;
  ['au-cliente','au-gps-wrap','au-msg'].forEach(id => { const x = document.getElementById(id); if (x) x.style.display = 'none'; });
  const gs = document.getElementById('au-gps-status'); if (gs) { gs.textContent = 'Toca el botón estando dentro o frente al negocio.'; gs.style.color = 'var(--suave)'; }
  ir('s-ajustar-ubicacion');
};
// Búsqueda en vivo (debounce): dispara la búsqueda al ir escribiendo, desde 3 caracteres
window.buscarClienteUbicacionVivo = function() {
  clearTimeout(window._auBuscaTimer);
  const q = (document.getElementById('au-tel')?.value || '').trim();
  if (q.length < 3) return;
  window._auBuscaTimer = setTimeout(() => buscarClienteUbicacion(), 350);
};
window.buscarClienteUbicacion = async function() {
  const q = (document.getElementById('au-tel')?.value || '').trim();
  const cont = document.getElementById('au-cliente');
  const wrap = document.getElementById('au-gps-wrap');
  const msg = document.getElementById('au-msg'); if (msg) msg.style.display = 'none';
  window._auTel = null;
  if (wrap) wrap.style.display = 'none';
  if (q.length < 3) { if (cont) { cont.style.display = 'block'; cont.innerHTML = '<span style="color:#ff8a8a;">Escribe al menos 3 letras del nombre o el teléfono.</span>'; } return; }
  if (cont) { cont.style.display = 'block'; cont.innerHTML = 'Buscando…'; }
  try {
    const r = await supabaseCall('POST', 'rpc/buscar_clientes_ubicacion', { p_q: q });
    const lista = (r && r.ok && Array.isArray(r.clientes)) ? r.clientes : [];
    if (!lista.length) {
      cont.innerHTML = '<span style="color:#ff8a8a;">Sin resultados. Prueba con otra parte del nombre o el teléfono.</span>';
      return;
    }
    cont.innerHTML = lista.map(c => {
      const ubic = c.tieneUbicacion ? 'Ya tiene ubicación' : 'Sin ubicación';
      const telSafe = String(c.telefono || '').replace(/\D/g, '').slice(-10);
      const nomSafe = (c.nombre || '(sin nombre)').replace(/'/g, '');
      return `<div onclick="elegirClienteUbicacion('${telSafe}', '${nomSafe}')" style="cursor:pointer;border:1px solid var(--gris3);border-radius:10px;padding:10px;margin-bottom:6px;">
        <div style="font-weight:800;color:var(--blanco);">${c.nombre || '(sin nombre)'}</div>
        <div style="color:var(--suave);font-size:0.76rem;margin-top:2px;">${c.tipo || ''} · ···${telSafe.slice(-4)}</div>
        <div style="font-size:0.72rem;margin-top:4px;color:var(--suave);">${ubic} · Toca para elegir</div>
      </div>`;
    }).join('');
  } catch(e) {
    cont.innerHTML = '<span style="color:#ff8a8a;">Error al buscar: ' + e.message + '</span>';
  }
};
window.elegirClienteUbicacion = function(tel, nombre) {
  window._auTel = tel;
  const cont = document.getElementById('au-cliente');
  const wrap = document.getElementById('au-gps-wrap');
  if (cont) cont.innerHTML = `<div style="font-weight:800;color:var(--blanco);">${nombre}</div><div style="color:var(--suave);font-size:0.76rem;margin-top:2px;">···${String(tel).slice(-4)} · Ahora captura el GPS</div>`;
  if (wrap) wrap.style.display = 'block';
};
window.usarGpsAjuste = function() {
  const st = document.getElementById('au-gps-status');
  if (!navigator.geolocation) { if (st) { st.textContent = 'Tu dispositivo no soporta GPS.'; st.style.color = '#ff8a8a'; } return; }
  if (st) { st.textContent = 'Obteniendo ubicación…'; st.style.color = 'var(--suave)'; }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      window._auGps = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      if (st) { st.textContent = `Ubicación capturada (${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)})`; st.style.color = '#7ee787'; }
    },
    (_e) => { if (st) { st.textContent = 'No se pudo obtener el GPS. Revisa los permisos de ubicación.'; st.style.color = '#ff8a8a'; } },
    { enableHighAccuracy: true, timeout: 10000 }
  );
};
window.guardarAjusteUbicacion = async function() {
  const msg = document.getElementById('au-msg');
  const showMsg = (t, ok) => { if (!msg) return; msg.style.display = 'block'; msg.textContent = t; msg.style.background = ok ? '#0d2d0d' : '#3a1515'; msg.style.color = ok ? '#7ee787' : '#ff8a8a'; };
  if (!window._auTel) { showMsg('Primero busca al cliente.'); return; }
  if (!window._auGps) { showMsg('Captura la ubicación con el botón de GPS.'); return; }
  const btn = document.getElementById('au-guardar'); const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Guardando…';
  try {
    const coordStr = `${window._auGps.lat},${window._auGps.lng}`;
    const r = await supabaseCall('POST', 'rpc/set_ubicacion_cliente', { p_telefono: window._auTel, p_coordenadas: coordStr });
    btn.disabled = false; btn.textContent = orig;
    if (r && r.ok) {
      mostrarToast(`Ubicación actualizada para ${r.nombre || 'el cliente'}.`);
      setTimeout(irAlCatalogo, 600);
    } else {
      showMsg((r && r.error) || 'No se pudo actualizar.');
    }
  } catch(e) { btn.disabled = false; btn.textContent = orig; showMsg('Error: ' + e.message); }
};

// ── Alta de negocio B2B liderada por el VENDEDOR (en sitio, sin venta) ──
window.abrirAltaNegocio = function() {
  ['an-tel','an-negocio','an-dir','an-cp','an-colonia','an-municipio','an-estado'].forEach(id => { const e = document.getElementById(id); if (e) e.value = ''; });
  window._altaNegTipo = null;
  window._altaNegGps = null;
  ['tienda','restaurante','mayorista'].forEach(t => pintarTipoAltaBtn(t, false));
  const gs = document.getElementById('an-gps-status');
  if (gs) { gs.textContent = 'Toca el botón estando dentro o frente al negocio.'; gs.style.color = 'var(--suave)'; }
  const msg = document.getElementById('an-msg'); if (msg) msg.style.display = 'none';
  const pv = document.getElementById('an-aviso-pv'); if (pv) pv.style.display = 'none';
  ir('s-alta-negocio');
};
// Aviso suave: la dirección del cliente no debería ser el punto de venta del vendedor
window.chequearDirVsPuntoVenta = function() {
  const pv = document.getElementById('an-aviso-pv'); if (!pv) return;
  const norm = s => (s || '').toString().toLowerCase().replace(/[^a-z0-9áéíóúñ ]/gi, '').replace(/\s+/g, ' ').trim();
  const dirCli = norm(document.getElementById('an-dir')?.value);
  const cpCli  = (document.getElementById('an-cp')?.value || '').replace(/\D/g, '');
  const dirPV  = norm(N.vendedorInfo?.direccionPuntoVenta);
  const cpPV   = (N.vendedorInfo?.cpPuntoVenta || '').toString().replace(/\D/g, '');
  let coincide = false;
  if (dirPV && dirCli && dirCli.length >= 6 && (dirCli === dirPV || dirPV.includes(dirCli) || dirCli.includes(dirPV))) coincide = true;
  if (cpPV && cpCli && cpCli === cpPV && dirPV && dirCli && dirCli.includes(dirPV.split(' ')[0])) coincide = true;
  pv.style.display = coincide ? 'block' : 'none';
};
function pintarTipoAltaBtn(t, on) {
  const b = document.getElementById('an-tipo-' + t); if (!b) return;
  b.style.background = on ? 'var(--amarillo)' : 'var(--gris2)';
  b.style.color = on ? '#000' : 'var(--blanco)';
  b.style.borderColor = on ? 'var(--amarillo)' : 'var(--gris3)';
}
window.setTipoAltaNegocio = function(t) {
  window._altaNegTipo = t;
  ['tienda','restaurante','mayorista'].forEach(x => pintarTipoAltaBtn(x, x === t));
};
window.usarGpsAltaNegocio = function() {
  const st = document.getElementById('an-gps-status');
  if (!navigator.geolocation) { if (st) { st.textContent = 'Tu dispositivo no soporta GPS.'; st.style.color = '#ff8a8a'; } return; }
  if (st) { st.textContent = 'Obteniendo ubicación…'; st.style.color = 'var(--suave)'; }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      window._altaNegGps = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      if (st) { st.textContent = `Ubicación capturada (${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)})`; st.style.color = '#7ee787'; }
    },
    (_e) => { if (st) { st.textContent = 'No se pudo obtener el GPS. Revisa los permisos de ubicación.'; st.style.color = '#ff8a8a'; } },
    { enableHighAccuracy: true, timeout: 10000 }
  );
};
window.guardarAltaNegocio = async function() {
  const val = id => (document.getElementById(id)?.value || '').trim();
  const msg = document.getElementById('an-msg');
  const showMsg = (t, ok) => { if (!msg) return; msg.style.display = 'block'; msg.textContent = t; msg.style.background = ok ? '#0d2d0d' : '#3a1515'; msg.style.color = ok ? '#7ee787' : '#ff8a8a'; };
  const tipo = window._altaNegTipo;
  if (!tipo) { showMsg('Elige el tipo de negocio.'); return; }
  const tel = val('an-tel').replace(/\D/g, '').slice(-10);
  if (tel.length !== 10) { showMsg('Escribe el teléfono del cliente (10 dígitos).'); return; }
  const telVend = String(N.vendedorInfo?.telefono || window._telVendedor || N.telefonoVerif || '').replace(/\D/g, '').slice(-10);
  if (telVend && telVend === tel) { showMsg('El teléfono no puede ser el tuyo. Usa el del dueño del negocio.'); return; }
  const negocio = val('an-negocio'); if (!negocio) { showMsg('Escribe el nombre del negocio.'); return; }
  const dir = val('an-dir'); if (!dir) { showMsg('Escribe la dirección.'); return; }
  const gps = window._altaNegGps || null;
  const coordStr = gps ? `${gps.lat},${gps.lng}` : '';
  const map = { tienda: { label: 'Tienda / Abarrotes', id: 3 }, restaurante: { label: 'Restaurante', id: 2 }, mayorista: { label: 'Mayorista / Distribuidor', id: 4 } };
  const sel = map[tipo];
  const btn = document.getElementById('an-guardar'); const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Guardando…';
  try {
    const rc = await supabaseCall('POST', 'rpc/registrar_o_actualizar_cliente', { p_data: {
      telefono: tel, nombre: negocio, tipo: sel.label, tipoId: sel.id,
      direccion: dir, cp: val('an-cp'), colonia: val('an-colonia'), municipio: val('an-municipio'), estado: val('an-estado'),
      coordenadas: coordStr, aprobadoB2B: false,
      idVendedor: N.vendedorInfo?.id || null, nombreVendedor: N.vendedorInfo?.nombre || '',
    }});
    if (gps) { try { await supabaseCall('POST', 'rpc/set_coordenadas_gps', { p_telefono: tel, p_gps: coordStr }); } catch(_e) {} }
    btn.disabled = false; btn.textContent = orig;
    if (rc && (rc.ok || rc.idCliente)) {
      try {
        const mapsLine = gps ? `\nMaps: https://www.google.com/maps?q=${gps.lat},${gps.lng}` : '\nSin GPS capturado';
        const nota = `*NEGOCIO POR VALIDAR* (alta por vendedor)\n${sel.label}: ${negocio}\nTel: +52${tel}\n${dir}\nVendedor: ${N.vendedorInfo?.nombre || ''}${mapsLine}`;
        if (typeof N.WHATSAPP_NUM !== 'undefined') irAWhatsApp(null, `https://wa.me/${N.WHATSAPP_NUM}?text=${encodeURIComponent(nota)}`);
      } catch(_e) {}
      mostrarToast('Negocio registrado. Pendiente de aprobación.');
      irAlCatalogo();
    } else {
      showMsg('No se pudo guardar. Intenta de nuevo.');
    }
  } catch(e) { btn.disabled = false; btn.textContent = orig; showMsg('Error al guardar: ' + e.message); }
};

// ── TICKETS DE GASTO ───────────────────────────────────────────────────────
// /api/ticket no recibe archivos: solo firma permisos de corta vida contra
// Supabase Storage. El archivo viaja del navegador directo al bucket.
async function ticketCall(payload) {
  const _tk = (typeof tokenVendedor === 'function') ? tokenVendedor() : null;
  if (_tk && payload && payload.token === undefined) {
    payload = { ...payload, token: _tk };
  }
  try {
    const res = await fetch('/api/ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await res.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// El bucket es privado, así que no hay una URL fija que poner en el href: se
// pide una firmada al hacer clic y se abre.
window.abrirTicket = async function(ev, idGasto) {
  if (ev) ev.preventDefault();
  // La pestaña se abre ANTES del await: si se abriera después, el navegador lo
  // trataría como una ventana emergente y la bloquearía.
  const tab = window.open('', '_blank');
  const r = await ticketCall({ accion: 'firmar_descarga', idGasto });
  if (r && r.ok && r.url) {
    if (tab) tab.location.href = r.url;
    else window.location.href = r.url;
  } else {
    if (tab) tab.close();
    mostrarToast('No se pudo abrir el ticket: ' + ((r && r.error) || 'sin respuesta'));
  }
};

// ══════════════════════════════════
// LOGIN CON PIN (vendedores)
// ══════════════════════════════════
// El PIN tiene longitud VARIABLE: 4 para los que nunca lo han cambiado, 6 o más
// para los nuevos. Por eso el envío automático solo ocurre al llenar las seis
// casillas; con 4 dígitos se pulsa «Entrar». Enviar al llegar a 4, como hacía
// antes, haría imposible teclear un PIN de 6.
const PIN_CASILLAS = 6;

function _leerPIN() {
  let pin = '';
  for (let i = 0; i < PIN_CASILLAS; i++) {
    const el = document.getElementById('p' + i);
    if (el) pin += (el.value || '');
  }
  return pin;
}

window.focoPIN = function(inp, idx) {
  inp.value = inp.value.replace(/\D/g,'');
  if (inp.value && idx < PIN_CASILLAS - 1) {
    const sig = document.getElementById('p' + (idx+1));
    if (sig) sig.focus();
  }
  if (_leerPIN().length === PIN_CASILLAS) verificarPIN();
};

window.retrocesoPIN = function(e, idx) {
  if (e.key === 'Backspace') {
    const inp = document.getElementById('p'+idx);
    if (!inp.value && idx > 0) {
      document.getElementById('p'+(idx-1)).value = '';
      document.getElementById('p'+(idx-1)).focus();
    } else inp.value = '';
    e.preventDefault();
  }
};

window.verificarPIN = async function() {
  const pin = _leerPIN();
  const msg = document.getElementById('msg-pin');
  const btn = document.getElementById('btn-pin');
  if (pin.length < 4) { msg.className='msg err'; msg.textContent='El PIN tiene al menos 4 dígitos'; return; }

  btn.disabled = true; btn.innerHTML = '<span class="loader"></span> Verificando...';
  msg.textContent = '';

  try {
    const res = await supabaseCall('POST', 'rpc/validar_vendedor_pin', {
      p_data: { telefono: window._telVendedor, pin }
    });
    if (res && res.ok) {
      // PIN correcto
      msg.className = 'msg ok'; msg.textContent = '✓ Acceso correcto';
      N.esVendedor   = true;
      const v = res.vendedor;
      N.vendedorInfo = {
        id: v.id,
        nombre: v.nombre,
        telefono: v.telefono,
        email: v.email,
        rol: v.rol,
        direccionPuntoVenta: v.direccionPuntoVenta,
        cpPuntoVenta: v.cpPuntoVenta,
        // Etapa B: token de sesión emitido por el servidor. Es la credencial
        // real; `rol` de aquí arriba es solo para pintar la interfaz. Quien
        // decide qué puede ver este vendedor es la base, no el navegador.
        token: res.token || '',
        tokenExpira: res.expiraEn || null,
      };
      N.tipoCliente  = 'vendedor';
      N.telefonoVerif = window._telVendedor;
      setTimeout(irAlCatalogo, 500);
    } else {
      msg.className = 'msg err'; msg.textContent = (res?.error || 'PIN incorrecto') + '. Intenta de nuevo.';
      [0,1,2,3].forEach(i => document.getElementById('p'+i).value = '');
      document.getElementById('p0').focus();
      btn.disabled = false; btn.textContent = 'Entrar';
    }
  } catch(e) {
    msg.className = 'msg err'; msg.textContent = 'Error de conexión.';
    btn.disabled = false; btn.textContent = 'Entrar';
  }
};


// ══════════════════════════════════
// TABS DE PRODUCCIÓN
// ══════════════════════════════════
const PROD_TABS = ['lotes','inventario','invdisp','insumos','consumibles'];

window.setProdTab = function(tab) {
  PROD_TABS.forEach(t => {
    document.getElementById('ptab-' + t)?.classList.toggle('active', t === tab);
    const el = document.getElementById('prod-tab-' + t);
    if (el) el.style.display = t === tab ? 'block' : 'none';
  });
  // Cargar datos del tab si necesario
  if (tab === 'invdisp')    renderResumenInventario('invdisp-resumen', true);
  if (tab === 'insumos')    cargarInsumos();
  if (tab === 'consumibles') cargarConsumibles();
  if (tab === 'inventario') cargarLotesEnSelect();
};

// ── INSUMOS ──
const SABORES_COND = ['Adobada','Feroz','Habanero','Queso Jalapeño','Queso Cheddar','Crunchy Mix'];
const PRESENTACIONES_BOLSAS = ['100g','250g','500g','1kg'];

function initGridInsumos() {
  // Condimentos
  const condGrid = document.getElementById('ins-condimentos-grid');
  if (condGrid && condGrid.children.length === 0) {
    condGrid.innerHTML = SABORES_COND.map(s => `
      <div style="display:grid;grid-template-columns:1fr 80px 80px;gap:6px;align-items:center;">
        <div style="font-size:0.78rem;font-weight:700;color:var(--blanco);">${s}</div>
        <input type="number" class="inp" id="cond-${s.replace(/\s/g,'_')}-kg" placeholder="kg" min="0" step="0.1"
          style="padding:6px;text-align:center;font-size:0.82rem;">
        <input type="number" class="inp" id="cond-${s.replace(/\s/g,'_')}-min" placeholder="mín" min="0" step="0.1"
          style="padding:6px;text-align:center;font-size:0.75rem;background:#1a1000;">
      </div>`).join('');
    condGrid.insertAdjacentHTML('beforebegin',
      '<div style="display:grid;grid-template-columns:1fr 80px 80px;gap:6px;margin-bottom:4px;"><span></span><span style="font-size:0.6rem;font-weight:700;color:#555;text-align:center;">KG</span><span style="font-size:0.6rem;font-weight:700;color:#555;text-align:center;">ALERTA</span></div>');
  }

  // Bolsas
  const bolsasGrid = document.getElementById('ins-bolsas-grid');
  if (bolsasGrid && bolsasGrid.children.length === 0) {
    bolsasGrid.innerHTML = PRESENTACIONES_BOLSAS.map(p => `
      <div style="display:grid;grid-template-columns:1fr 80px 80px;gap:6px;align-items:center;">
        <div style="font-size:0.78rem;font-weight:700;color:var(--blanco);">Bolsa ${p}</div>
        <input type="number" class="inp" id="bolsa-${p}-piezas" placeholder="pzas" min="0"
          style="padding:6px;text-align:center;font-size:0.82rem;">
        <input type="number" class="inp" id="bolsa-${p}-min" placeholder="mín" min="0"
          style="padding:6px;text-align:center;font-size:0.75rem;background:#1a1000;">
      </div>`).join('');
  }

  // Etiquetas
  const etGrid = document.getElementById('ins-etiquetas-grid');
  if (etGrid && etGrid.children.length === 0) {
    etGrid.innerHTML = PRESENTACIONES_BOLSAS.map(p => `
      <div style="display:grid;grid-template-columns:1fr 80px 80px;gap:6px;align-items:center;">
        <div style="font-size:0.78rem;font-weight:700;color:var(--blanco);">Etiqueta ${p}</div>
        <input type="number" class="inp" id="etiq-${p}-piezas" placeholder="pzas" min="0"
          style="padding:6px;text-align:center;font-size:0.82rem;">
        <input type="number" class="inp" id="etiq-${p}-min" placeholder="mín" min="0"
          style="padding:6px;text-align:center;font-size:0.75rem;background:#1a1000;">
      </div>`).join('');
  }
}

async function cargarInsumos() {
  initGridInsumos();
  try {
    const res = await supabaseCall('POST', 'rpc/obtener_insumos_estado',
      { p_data: { grupo: 'insumos' } });
    if (!res || !res.ok || !res.valores) return;
    const ins = res.valores;
    // Llenar campos
    if (ins.aceite_galones !== undefined) document.getElementById('ins-aceite-galones').value = ins.aceite_galones;
    if (ins.aceite_calidad) document.getElementById('ins-aceite-calidad').value = ins.aceite_calidad;
    if (ins.aceite_min !== undefined) document.getElementById('ins-aceite-min').value = ins.aceite_min;
    if (ins.gas_pct !== undefined) {
      document.getElementById('ins-gas-pct').value = ins.gas_pct;
      document.getElementById('ins-gas-display').textContent = ins.gas_pct + '%';
    }
    if (ins.gas_min !== undefined) document.getElementById('ins-gas-min').value = ins.gas_min;
    if (ins.sal_kg !== undefined) document.getElementById('ins-sal-kg').value = ins.sal_kg;
    if (ins.sal_min !== undefined) document.getElementById('ins-sal-min').value = ins.sal_min;
    if (ins.bolsas_aza !== undefined) document.getElementById('ins-bolsas-aza').value = ins.bolsas_aza;
    if (ins.bolsas_aza_min !== undefined) document.getElementById('ins-bolsas-aza-min').value = ins.bolsas_aza_min;

    // Condimentos
    SABORES_COND.forEach(s => {
      const key = s.replace(/\s/g,'_');
      if (ins['cond_'+key+'_kg'] !== undefined) document.getElementById('cond-'+key+'-kg').value = ins['cond_'+key+'_kg'];
      if (ins['cond_'+key+'_min'] !== undefined) document.getElementById('cond-'+key+'-min').value = ins['cond_'+key+'_min'];
    });
    PRESENTACIONES_BOLSAS.forEach(p => {
      if (ins['bolsa_'+p+'_piezas'] !== undefined) document.getElementById('bolsa-'+p+'-piezas').value = ins['bolsa_'+p+'_piezas'];
      if (ins['bolsa_'+p+'_min'] !== undefined) document.getElementById('bolsa-'+p+'-min').value = ins['bolsa_'+p+'_min'];
      if (ins['etiq_'+p+'_piezas'] !== undefined) document.getElementById('etiq-'+p+'-piezas').value = ins['etiq_'+p+'_piezas'];
      if (ins['etiq_'+p+'_min'] !== undefined) document.getElementById('etiq-'+p+'-min').value = ins['etiq_'+p+'_min'];
    });

    // Mostrar alertas
    mostrarAlertasInsumos(ins);
  } catch(e) { console.log('Sin datos de insumos:', e.message); }
}

function mostrarAlertasInsumos(ins) {
  const alertas = [];
  if (ins.aceite_galones <= ins.aceite_min) alertas.push(`Aceite bajo: ${ins.aceite_galones} galones`);
  if (ins.gas_pct <= ins.gas_min) alertas.push(`Gas bajo: ${ins.gas_pct}%`);
  if (ins.sal_kg <= ins.sal_min) alertas.push(`Sal baja: ${ins.sal_kg}kg`);
  if (ins.bolsas_aza <= ins.bolsas_aza_min) alertas.push(`Bolsas de aza bajas: ${ins.bolsas_aza} pzas`);

  const wrap = document.getElementById('alertas-insumos');
  const lista = document.getElementById('alertas-insumos-lista');
  if (alertas.length > 0 && wrap && lista) {
    wrap.style.display = 'block';
    lista.innerHTML = alertas.map(a => `<div style="margin-bottom:4px;">${a}</div>`).join('');
  } else if (wrap) {
    wrap.style.display = 'none';
  }
}

// ── REGISTRO DE USO DE INSUMOS ──
window.registrarUsoInsumo = async function() {
  const tipo     = document.getElementById('uso-insumo-tipo').value;
  const cantidad = parseFloat(document.getElementById('uso-insumo-cantidad').value)||0;
  if (!tipo || !cantidad) { mostrarToast('Selecciona insumo y cantidad'); return; }

  try {
    // Ya no se manda ni la fecha ni el vendedor: el servidor toma quién
    // registra del token y la hora de su propio reloj. Ninguno de los dos
    // era comprobable viniendo del navegador.
    const res = await supabaseCall('POST', 'rpc/registrar_uso_insumo',
      { p_data: { tipo, cantidad } });
    if (res && res.ok) {
      mostrarToast('Uso registrado');
      document.getElementById('uso-insumo-cantidad').value = '';
      // Actualizar mini historial
      cargarUsoHistorialMini(tipo);
    } else {
      mostrarToast('Error: ' + ((res && res.error) || 'Sin respuesta'));
    }
  } catch(e) { mostrarToast('Error: ' + e.message); }
};

async function cargarUsoHistorialMini(tipo) {
  try {
    const res = await supabaseCall('POST', 'rpc/obtener_uso_insumo',
      { p_data: { tipo, limite: 3 } });
    const el  = document.getElementById('uso-historial-mini');
    if (!el || !res || !res.ok || !res.registros?.length) return;
    el.innerHTML = res.registros.map(r =>
      `<div>${new Date(r.fecha).toLocaleDateString('es-MX',{day:'numeric',month:'short'})} — ${r.tipo}: ${r.cantidad} (${r.vendedor})</div>`
    ).join('');
  } catch(e) {}
}

window.guardarInsumos = async function() {
  const data = {
    aceite_galones: parseFloat(document.getElementById('ins-aceite-galones').value)||0,
    aceite_calidad: document.getElementById('ins-aceite-calidad').value,
    aceite_min:     parseFloat(document.getElementById('ins-aceite-min').value)||0,
    gas_pct:        parseInt(document.getElementById('ins-gas-pct').value)||0,
    gas_min:        parseInt(document.getElementById('ins-gas-min').value)||0,
    sal_kg:         parseFloat(document.getElementById('ins-sal-kg').value)||0,
    sal_min:        parseFloat(document.getElementById('ins-sal-min').value)||0,
    bolsas_aza:     parseInt(document.getElementById('ins-bolsas-aza').value)||0,
    bolsas_aza_min: parseInt(document.getElementById('ins-bolsas-aza-min').value)||0,
  };
  SABORES_COND.forEach(s => {
    const key = s.replace(/\s/g,'_');
    data['cond_'+key+'_kg']  = parseFloat(document.getElementById('cond-'+key+'-kg')?.value)||0;
    data['cond_'+key+'_min'] = parseFloat(document.getElementById('cond-'+key+'-min')?.value)||0;
  });
  PRESENTACIONES_BOLSAS.forEach(p => {
    data['bolsa_'+p+'_piezas'] = parseInt(document.getElementById('bolsa-'+p+'-piezas')?.value)||0;
    data['bolsa_'+p+'_min']    = parseInt(document.getElementById('bolsa-'+p+'-min')?.value)||0;
    data['etiq_'+p+'_piezas']  = parseInt(document.getElementById('etiq-'+p+'-piezas')?.value)||0;
    data['etiq_'+p+'_min']     = parseInt(document.getElementById('etiq-'+p+'-min')?.value)||0;
  });

  try {
    const res = await supabaseCall('POST', 'rpc/guardar_insumos_estado',
      { p_data: { grupo: 'insumos', valores: data } });
    if (res && res.ok) { mostrarToast('Insumos guardados'); mostrarAlertasInsumos(data); }
    else mostrarToast('Error: ' + ((res && res.error) || 'Sin respuesta'));
  } catch(e) { mostrarToast('Error: ' + e.message); }
};

// ── CONSUMIBLES ──
const CONSUMIBLES_LIST = [
  { id:'desengrasante', label:'Desengrasante',    unidad:'litros' },
  { id:'jabon',         label:'Jabón',            unidad:'litros' },
  { id:'jergas',        label:'Jergas',           unidad:'piezas' },
  { id:'trapos',        label:'Trapos',           unidad:'piezas' },
  { id:'cloro',         label:'Cloro',            unidad:'litros' },
  { id:'guantes',       label:'Guantes',          unidad:'pares'  },
  { id:'cubrebocas',    label:'Cubrebocas',       unidad:'piezas' },
  { id:'papel_bano',    label:'Papel de baño',    unidad:'rollos' },
  { id:'papel_manos',   label:'Papel para manos', unidad:'rollos' },
];

function initGridConsumibles() {
  const grid = document.getElementById('consumibles-grid');
  if (!grid || grid.innerHTML.trim()) return;
  grid.innerHTML = CONSUMIBLES_LIST.map(c => `
    <div style="display:grid;grid-template-columns:1fr 80px 80px;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--gris3);">
      <div style="font-size:0.82rem;font-weight:700;color:var(--blanco);">${c.label}</div>
      <input type="number" class="inp" id="cons-${c.id}-qty" placeholder="${c.unidad}" min="0"
        style="padding:6px;text-align:center;font-size:0.82rem;">
      <input type="number" class="inp" id="cons-${c.id}-min" placeholder="mín" min="0"
        style="padding:6px;text-align:center;font-size:0.75rem;background:#1a1000;">
    </div>`).join('') +
    '<div style="display:grid;grid-template-columns:1fr 80px 80px;gap:8px;margin-bottom:4px;"><span></span><span style="font-size:0.6rem;font-weight:700;color:#555;text-align:center;">CANT.</span><span style="font-size:0.6rem;font-weight:700;color:#555;text-align:center;">ALERTA</span></div>';
}

async function cargarConsumibles() {
  initGridConsumibles();
  try {
    const res = await supabaseCall('POST', 'rpc/obtener_insumos_estado',
      { p_data: { grupo: 'consumibles' } });
    if (!res || !res.ok || !res.valores) return;
    const cons = res.valores;
    CONSUMIBLES_LIST.forEach(c => {
      if (cons[c.id+'_qty'] !== undefined) document.getElementById('cons-'+c.id+'-qty').value = cons[c.id+'_qty'];
      if (cons[c.id+'_min'] !== undefined) document.getElementById('cons-'+c.id+'-min').value = cons[c.id+'_min'];
    });
  } catch(e) {}
}

window.guardarConsumibles = async function() {
  const data = {};
  CONSUMIBLES_LIST.forEach(c => {
    data[c.id+'_qty'] = parseInt(document.getElementById('cons-'+c.id+'-qty')?.value)||0;
    data[c.id+'_min'] = parseInt(document.getElementById('cons-'+c.id+'-min')?.value)||0;
  });
  try {
    const res = await supabaseCall('POST', 'rpc/guardar_insumos_estado',
      { p_data: { grupo: 'consumibles', valores: data } });
    if (res && res.ok) mostrarToast('Consumibles guardados');
    else mostrarToast('Error: ' + ((res && res.error) || 'Sin respuesta'));
  } catch(e) { mostrarToast('Error: ' + e.message); }
};


// ══════════════════════════════════
// PRODUCCIÓN (solo vendedores)
// ══════════════════════════════════
let _inventarioActual = [];

// El filtro «Últimos 5 / 10 / Todos» del historial de lotes (index.html, `#lotes-filtro`) llama a
// `renderProduccion()` por `onchange`; sin esta línea nunca fue global y el filtro no hacía nada
// (desde antes del corte del monolito; 20 sep 2026).
window.renderProduccion = renderProduccion;
async function renderProduccion() {
  renderHoraLimiteCfg();
  const tabla    = document.getElementById('prod-tabla');
  const fechaEl  = document.getElementById('fecha-prod-actual');

  if (tabla) tabla.innerHTML = '<div style="text-align:center;color:var(--suave);padding:20px;">Cargando...</div>';

  try {
    // v2.9: inventario desde Supabase (vista vista_inventario)
    let arr = await supabaseCall('GET', 'vista_inventario?select=*');
    if (!Array.isArray(arr)) arr = [];

    // Si no hay registros, mostrar mensaje útil + botón para inicializar
    if (arr.length === 0) {
      const SABORES_DEFAULT = ['Natural','Adobada','Feroz','Habanero','Queso Jalapeño','Queso Cheddar','Crunchy Mix'];
      if (tabla) tabla.innerHTML = `
        <div style="background:var(--gris);border:1px dashed var(--gris3);border-radius:12px;padding:18px;text-align:center;">
          <div style="font-size:2rem;margin-bottom:10px;" class="ico-solo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg></div>
          <div style="color:var(--blanco);font-weight:800;margin-bottom:4px;">Sin producción registrada</div>
          <div style="color:var(--suave);font-size:0.84rem;margin-bottom:12px;">
            Inicializa el inventario con los sabores actuales o registra producción para empezar.
          </div>
          <button onclick="inicializarSaboresProduccion()" style="background:var(--amarillo);color:var(--negro);border:none;border-radius:10px;padding:10px 16px;font-weight:800;cursor:pointer;">
            Inicializar ${SABORES_DEFAULT.length} sabores en 0kg
          </button>
        </div>`;
      _inventarioActual = [];
    } else {
    _inventarioActual = arr.map(s => ({
      sabor:              s.sabor,
      kilosProducidos:    Number(s.kilos_producidos_total) || 0,
      kilosVendidos:      Number(s.kilos_vendidos_total) || 0,
      kilosDisponibles:   Number(s.kilos_disponibles) || 0,
      ultimaProduccion:   s.ultima_produccion,
      proximaProduccion:  s.proxima_produccion,
      stockBajo:          s.stock_bajo === true,
    }));

    // Tabla editable
    if (tabla) tabla.innerHTML = _inventarioActual.map((s, idx) => `
      <div style="background:var(--gris);border-radius:12px;padding:14px;display:flex;align-items:center;gap:12px;${s.stockBajo?'border:1px solid var(--rojo)':''}">
        <div style="flex:1;">
          <div style="font-weight:800;font-size:0.88rem;color:${s.stockBajo?'var(--rojo)':'var(--blanco)'};">
            ${s.stockBajo?'':''}${s.sabor}
          </div>
          <div style="font-size:0.72rem;color:var(--suave);margin-top:2px;">
            Producido: ${s.kilosProducidos}kg · Vendido: ${s.kilosVendidos.toFixed(2)}kg
          </div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:0.65rem;font-weight:700;color:#555;margin-bottom:4px;">KG DISPONIBLES</div>
          <input type="number" id="inv-${idx}" value="${s.kilosDisponibles.toFixed(2)}"
            min="0" step="0.1"
            style="background:var(--gris2);border:2px solid var(--gris3);border-radius:8px;padding:6px 10px;color:var(--amarillo);font-family:'Archivo',sans-serif;font-size:1.2rem;width:80px;text-align:center;outline:none;"
            onfocus="this.style.borderColor='var(--amarillo)'" onblur="this.style.borderColor='var(--gris3)'">
        </div>
      </div>
    `).join('');
    }

    // Cargar lotes en select de inventario físico
    cargarLotesEnSelect();

    // Mostrar lotes activos
    try {
      const _rl1 = await supabaseCall('POST', 'rpc/obtener_lotes', { p_data: { limit: 50 } });
      const lotesArr = (_rl1 && _rl1.ok) ? _rl1.lotes : [];
      const lotesEl = document.getElementById('lotes-lista');
      if (lotesEl) {
        if (!Array.isArray(lotesArr) || lotesArr.length === 0) {
          lotesEl.innerHTML = '<div style="color:var(--suave);font-size:0.82rem;padding:10px;text-align:center;">Sin lotes registrados aún</div>';
        } else {
          const limite = parseInt(document.getElementById('lotes-filtro')?.value || '5');
          // Mapear con campos legacy
          const lotes = lotesArr.map(l => ({
            id:                 l.id,
            idLote:             l.id_lote || ('LOTE-' + l.id),
            fechaProduccion:    l.fecha,
            kilosTotales:       Number(l.kilos_totales) || 0,
            kilosVendidos:      Number(l.kilos_vendidos) || 0,
            kilosDisponibles:   Number(l.kilos_disponibles) || 0,
            estatus:            l.estatus,
            notas:              l.notas || '',
          }));
          const lotesParaMostrar = lotes.slice(0, limite); // ya viene ordenado DESC
          lotesEl.innerHTML = lotesParaMostrar.map((l,idx) => {
            const pct = l.kilosTotales > 0 ? Math.round((l.kilosVendidos/l.kilosTotales)*100) : 0;
            const colorPct = pct > 80 ? '#4caf50' : pct > 40 ? 'var(--amarillo)' : 'var(--suave)';
            const esActivo = l.estatus === 'Activo';
            return `
            <div style="background:var(--gris2);border-radius:10px;padding:12px;margin-bottom:8px;border-left:3px solid ${esActivo?'var(--amarillo)':'#333'};">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;">
                <div>
                  <div style="font-weight:800;font-size:0.88rem;color:${esActivo?'var(--amarillo)':'var(--suave)'};">
                    ${l.idLote} ${esActivo?'<span style="font-size:0.65rem;background:#2a1f00;color:var(--amarillo);border-radius:4px;padding:2px 5px;">ACTIVO</span>':''}
                  </div>
                  <div style="font-size:0.7rem;color:#555;">
                    ${l.fechaProduccion ? fechaSoloDia(l.fechaProduccion).toLocaleDateString('es-MX',{weekday:'short',day:'numeric',month:'short',year:'numeric'}) : '—'}
                  </div>
                </div>
                <div style="text-align:right;">
                  <div style="font-family:'Archivo',sans-serif;font-size:1.1rem;color:var(--blanco);">${l.kilosTotales}kg</div>
                  <div style="font-size:0.68rem;color:${colorPct};">${pct}% vendido</div>
                </div>
              </div>
              <div style="background:#222;border-radius:4px;height:6px;margin-bottom:8px;">
                <div style="background:${colorPct};height:6px;border-radius:4px;width:${pct}%;transition:width 0.5s;"></div>
              </div>
              <div style="display:flex;justify-content:space-between;font-size:0.7rem;color:#555;margin-bottom:${l.notas?'6px':'0'};">
                <span>Vendido: ${l.kilosVendidos?.toFixed(2)||0}kg</span>
                <span>Disponible: ${l.kilosDisponibles?.toFixed(2)||0}kg</span>
              </div>
              ${l.notas ? `<div style="font-size:0.72rem;color:#888;font-style:italic;margin-bottom:6px;">"${l.notas}"</div>` : ''}
              ${esActivo ? `
              <div style="display:flex;gap:6px;margin-top:6px;">
                <button onclick="editarLote('${l.idLote}', ${l.kilosTotales}, ${l.kilosDisponibles})" style="flex:1;background:transparent;border:1px solid var(--amarillo);border-radius:6px;padding:5px;font-family:'Inter',sans-serif;font-weight:700;font-size:0.7rem;color:var(--amarillo);cursor:pointer;">Editar</button>
                <button onclick="editarNotasLote('${l.idLote}', \`${(l.notas||'').replace(/`/g,"'")}\`)" style="flex:1;background:transparent;border:1px solid #555;border-radius:6px;padding:5px;font-family:'Inter',sans-serif;font-weight:700;font-size:0.7rem;color:#888;cursor:pointer;">Comentario</button>
                <button onclick="cerrarLote('${l.idLote}')" style="flex:1;background:transparent;border:1px solid #333;border-radius:6px;padding:5px;font-family:'Inter',sans-serif;font-weight:700;font-size:0.7rem;color:#555;cursor:pointer;">✕ Cerrar</button>
              </div>` : ''}
            </div>`}).join('');
        }
      }

      // Estadísticas de lotes (reúsa lotesArr ya cargado)
      const statsEl = document.getElementById('lotes-stats');
      if (statsEl) {
        if (!Array.isArray(lotesArr) || lotesArr.length === 0) {
          statsEl.innerHTML = '<div style="color:var(--suave);">Aún no hay lotes para estadísticas.</div>';
        } else {
          const nL       = lotesArr.length;
          const sumProd  = lotesArr.reduce((s,l)=>s+(Number(l.kilos_totales)||0),0);
          const sumVend  = lotesArr.reduce((s,l)=>s+(Number(l.kilos_vendidos)||0),0);
          const pctGlob  = sumProd > 0 ? Math.round((sumVend/sumProd)*100) : 0;
          const promLote = nL > 0 ? sumProd/nL : 0;
          const activos  = lotesArr.filter(l=>l.estatus==='Activo').length;
          const cerrados = lotesArr.filter(l=>l.estatus!=='Activo');
          const pctCerr  = cerrados.length
            ? Math.round(cerrados.reduce((s,l)=>{const t=Number(l.kilos_totales)||0,v=Number(l.kilos_vendidos)||0;return s+(t>0?(v/t)*100:0);},0)/cerrados.length)
            : null;
          statsEl.innerHTML = `
            <div>Lotes registrados: <strong style="color:var(--amarillo)">${nL}</strong> (${activos} activo${activos!==1?'s':''})</div>
            <div style="margin-top:4px;">Producido total: <strong style="color:var(--amarillo)">${sumProd.toFixed(1)}kg</strong> · vendido: <strong style="color:var(--amarillo)">${sumVend.toFixed(1)}kg</strong> (${pctGlob}%)</div>
            <div style="margin-top:4px;">Promedio por lote: <strong style="color:var(--amarillo)">${promLote.toFixed(1)}kg</strong></div>
            ${pctCerr!==null ? `<div style="margin-top:4px;">Agotamiento prom. (lotes cerrados): <strong style="color:var(--amarillo)">${pctCerr}%</strong></div>` : ''}
          `;
        }
      }
    } catch(e) { console.warn('Error cargando lotes:', e); }

    // v2.9: Próxima producción desde produccion_diaria
    try {
      const hoy = fechaCDMX();
      const _rp1 = await supabaseCall('POST', 'rpc/obtener_produccion', { p_data: { proximaFecha: true } });
      const proxArr = (_rp1 && _rp1.ok) ? _rp1.filas : [];
      if (Array.isArray(proxArr) && proxArr.length > 0 && proxArr[0].fecha_siguiente) {
        const fp = new Date(proxArr[0].fecha_siguiente + 'T12:00:00');
        fechaEl.textContent = 'Próxima: ' + fp.toLocaleDateString('es-MX',{weekday:'long',day:'numeric',month:'long'});
        const inp = document.getElementById('fecha-prod-input');
        if (inp) inp.value = proxArr[0].fecha_siguiente;
      } else {
        fechaEl.textContent = 'Sin fecha programada';
      }
    } catch(e) {
      fechaEl.textContent = 'Sin fecha programada';
    }

    // (El antiguo "Resumen del día" se removió; las estadísticas de lotes
    //  se arman arriba, en el bloque de historial.)

  } catch(e) {
    if (tabla) tabla.innerHTML = '<div style="color:var(--rojo);padding:12px;">Error al cargar inventario</div>';
  }
}

// v2.9: helper para inicializar sabores en producción cuando la BD está vacía
window.inicializarSaboresProduccion = async function() {
  if (!(await confirmar({ titulo: 'Crear los 7 sabores', cuerpo: 'Se crean en producción con 0 kg cada uno.', aceptar: 'Crear' }))) return;
  const SABORES_DEFAULT = ['Natural','Adobada','Feroz','Habanero','Queso Jalapeño','Queso Cheddar','Crunchy Mix'];
  const fechaHoy = fechaCDMX();
  try {
    const calls = SABORES_DEFAULT.map(sabor =>
      supabaseCall('POST', 'rpc/registrar_produccion_sabor', {
        p_data: { sabor, kilos: 0, fechaProduccion: fechaHoy }
      })
    );
    await Promise.all(calls);
    mostrarToast('Sabores inicializados');
    renderProduccion();
  } catch(e) {
    avisar({ titulo: 'No se pudieron crear los sabores', cuerpo: e.message });
  }
};

// Fechas tipo 'YYYY-MM-DD' se parsean como UTC y en CDMX se muestran UN DÍA ANTES.
// Este helper las ancla al mediodía local para que el día mostrado sea el correcto.
window.fechaSoloDia = function(str) {
  const s = String(str || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T12:00:00') : new Date(str);
};

// Vista previa en vivo del peso del lote: "12.915" → "✓ = 12 kg 915 g".
// Hace visible al instante un error de mil veces (12915 → 12,915 kg = toneladas).
window.previewKilosLote = function() {
  const el = document.getElementById('lote-kilos-preview'); if (!el) return;
  const raw = (document.getElementById('lote-kilos')?.value || '').trim().replace(/\s/g, '').replace(',', '.');
  const kg = parseFloat(raw);
  if (!raw || isNaN(kg) || kg <= 0) { el.textContent = ''; return; }
  const enteros = Math.floor(kg);
  const gramos = Math.round((kg - enteros) * 1000);
  if (kg > 200) {
    el.innerHTML = `<span style="color:#ff8a8a;">${kg.toLocaleString('es-MX')} kg = ${(kg/1000).toFixed(1)} toneladas. ¿Quisiste decir ${(kg/1000).toFixed(3)} kg?</span>`;
  } else {
    el.innerHTML = `<span style="color:#7ee787;">✓ = ${enteros} kg ${gramos} g</span>`;
  }
};

window.registrarNuevoLote = async function() {
  const fecha = document.getElementById('lote-fecha').value;
  // Aceptar coma decimal ("12,915" = 12.915 kg) y limpiar espacios
  const kilosRaw = (document.getElementById('lote-kilos').value || '').trim().replace(/\s/g, '').replace(',', '.');
  const kilos = parseFloat(kilosRaw);
  const notas = document.getElementById('lote-notas').value;

  if (!fecha || !kilos || kilos <= 0) {
    mostrarToast('Ingresa fecha y kilos del lote');
    return;
  }
  // Guardia anti-toneladas: un lote artesanal no pesa cientos de kilos
  if (kilos > 200) {
    const sugerido = (kilos / 1000).toFixed(3);
    if (!(await confirmar({ titulo: '¿Toneladas?', cuerpo: `Capturaste ${kilos} kg (${(kilos/1000).toFixed(1)} toneladas).` + N.SALTO + `¿Quisiste decir ${sugerido} kg?`, aceptar: `Guardar ${kilos} kg tal cual`, cancelar: 'Corregir el número', peligroso: true }))) {
      return;
    }
  }

  try {
    const res = await supabaseCall('POST', 'rpc/registrar_lote', {
      p_data: { fecha, kilos, notas }
    });
    if (res && res.ok) {
      mostrarToast(`${res.idLote}: ${kilos}kg registrados`);
      document.getElementById('lote-kilos').value = '';
      document.getElementById('lote-notas').value = '';
      renderProduccion();
    } else {
      mostrarToast('Error: ' + (res?.error || 'Sin respuesta'));
    }
  } catch(e) {
    mostrarToast('Error: ' + e.message);
  }
};

window.guardarFechaProduccion = async function() {
  const fecha = document.getElementById('fecha-prod-input').value;
  if (!fecha) { mostrarToast('Selecciona una fecha'); return; }
  try {
    // v2.9: actualizar fecha_siguiente en todos los sabores activos
    // Actualiza TODAS las filas activas: el RPC lo hace explícito con
    // `todasActivas`, en vez de un filtro en la URL.
    await supabaseCall('POST', 'rpc/actualizar_produccion', {
      p_data: { todasActivas: true, campos: { fecha_siguiente: fecha } }
    });
    mostrarToast('Fecha guardada');
    renderProduccion();
  } catch(e) {
    mostrarToast('Error: ' + e.message);
  }
};

// ══════════════════════════════════
// CAMBIO DE PIN (personal)
// ══════════════════════════════════
// Hasta hoy no existía esta pantalla: `cambiar_pin_vendedor` estaba en la base
// pero index.html no la llamaba, así que rotar un PIN requería SQL. Eso dejaba
// sin salida el caso más común de todos: alguien comparte su PIN, o deja el
// equipo, y hay que cambiarlo el mismo día.

window.abrirCambioPin = function() {
  const f = document.getElementById('pin-form');
  const b = document.getElementById('pin-abrir');
  if (!f) return;
  ['pin-actual','pin-nuevo','pin-nuevo2'].forEach(id => {
    const e = document.getElementById(id); if (e) e.value = '';
  });
  const m = document.getElementById('pin-msg'); if (m) m.textContent = '';
  f.style.display = '';
  if (b) b.style.display = 'none';
  const primero = document.getElementById('pin-actual');
  if (primero) primero.focus();
};

window.guardarPinPropio = async function() {
  const msg = document.getElementById('pin-msg');
  const btn = document.getElementById('pin-guardar');
  const val = (id) => (document.getElementById(id)?.value || '').trim();
  const actual = val('pin-actual'), nuevo = val('pin-nuevo'), nuevo2 = val('pin-nuevo2');
  const err = (t) => { msg.style.color = 'var(--rojo)'; msg.textContent = t; };

  // Validación en el navegador solo para dar mejor mensaje: el servidor vuelve
  // a comprobarlo todo, incluido el PIN actual contra el hash.
  if (!actual || !nuevo || !nuevo2) return err('Completa los tres campos.');
  if (nuevo !== nuevo2)             return err('El PIN nuevo no coincide.');
  if (!/^\d{6,}$/.test(nuevo))      return err('El PIN debe ser de al menos 6 dígitos, solo números.');
  // Mismas reglas que aplica el servidor, comprobadas aquí para avisar antes
  // de enviar. El servidor manda: esto es solo cortesía.
  if (/^(.)\1+$/.test(nuevo)) return err('El PIN no puede ser un mismo dígito repetido.');
  if (['123456','654321','123123','112233','121212','098765'].includes(nuevo))
    return err('Ese PIN es demasiado común. Elige otro.');
  if (nuevo === actual)             return err('El PIN nuevo debe ser distinto del actual.');

  btn.disabled = true; btn.textContent = 'Guardando...';
  msg.textContent = '';
  try {
    const res = await supabaseCall('POST', 'rpc/cambiar_pin_vendedor', {
      p_data: { token: tokenVendedor(), pinActual: actual, pinNuevo: nuevo }
    });
    if (res && res.ok) {
      msg.style.color = '#4caf50';
      msg.textContent = '✓ PIN actualizado. Vuelve a entrar con el nuevo.';
      // El servidor revoca TODAS las sesiones de esta persona al cambiar el
      // PIN — incluida ésta. Si no lo hiciéramos, cambiar el PIN por sospecha
      // de que alguien lo conoce no serviría: su sesión seguiría viva.
      // Se limpia solo la parte de vendedor; `telefonoVerif` se conserva para
      // no gastar un SMS de OTP.
      N.esVendedor = false; N.vendedorInfo = null;
      if (N.tipoCliente === 'vendedor') N.tipoCliente = 'consumidor';
      guardarSesion();
      setTimeout(() => { try { location.reload(); } catch (_e) {} }, 1800);
    } else {
      err((res && res.error) || 'No se pudo cambiar el PIN.');
      btn.disabled = false; btn.textContent = 'Guardar';
    }
  } catch (e) {
    err('Error de conexión.');
    btn.disabled = false; btn.textContent = 'Guardar';
  }
};

window.guardarLealtadCfg = async function() {
  const num = (id) => { const v = parseFloat(document.getElementById(id)?.value); return isNaN(v) ? null : v; };
  const payload = {
    // 'neto' = producto menos descuentos, sin envío (Club fase 1). Con 'total' contaba el envío.
    generacion: { activo: true, base: 'neto', puntos_por_peso: num('cfg-ppp') },
    redencion:  { activo: true, valor_punto_mxn: num('cfg-vpm'), pct_max_pedido: num('cfg-pct'), pago_minimo_mxn: num('cfg-pmin') }
  };
  try {
    const res = await supabaseCall('POST', 'rpc/set_lealtad_config', { p_data: payload });
    if (res && res.ok) {
      if (typeof mostrarToast === 'function') mostrarToast('Reglas del club guardadas');
      renderClubAdminCfg();
    } else if (typeof mostrarToast === 'function') {
      mostrarToast('No se pudo guardar: ' + ((res && res.error) || 'error'));
    }
  } catch (e) {
    if (typeof mostrarToast === 'function') mostrarToast('Error al guardar las reglas');
  }
};

// ── Panel admin: mínimos de mayoreo (editable, sin tocar código) ──
// Hora límite de pedido (entrega 1 de la cola de pedidos). Solo el dueño la
// edita; la lee get_hora_limite_config y la aplica obtener_fecha_entrega.
async function renderHoraLimiteCfg() {
  const cont = document.getElementById('hora-limite-cfg');
  if (!cont) return;
  if (!esAdminEstricto()) { cont.style.display = 'none'; cont.innerHTML = ''; return; }
  cont.style.display = 'block';
  let cfg = { hora: '18:00', diasNormal: 1, diasTarde: 2 };
  try {
    const r = await supabaseCall('POST', 'rpc/get_hora_limite_config', {});
    if (r && r.ok) cfg = { hora: r.hora, diasNormal: r.diasNormal, diasTarde: r.diasTarde };
  } catch (_e) {}
  const num = (id, v) => `<input id="${id}" type="number" inputmode="numeric" min="0" max="7" step="1" value="${v}" style="width:70px;min-height:44px;background:var(--gris2);border:1px solid var(--gris3);border-radius:8px;padding:6px 10px;color:var(--blanco);font-size:0.9rem;text-align:right;">`;
  cont.innerHTML = `
    <div style="background:var(--gris);border-radius:14px;padding:16px;margin-bottom:14px;">
      <div style="font-family:'Archivo',sans-serif;font-size:1rem;color:var(--amarillo);letter-spacing:1px;margin-bottom:6px;">HORA LÍMITE DE PEDIDO</div>
      <div style="font-size:0.78rem;color:var(--suave);margin-bottom:12px;">Un pedido antes de esta hora se entrega en los días «normales»; después, en los días «tarde». Hora de la Ciudad de México.</div>
      <div style="display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;font-size:0.86rem;color:var(--blanco);">
        <label for="hl-hora">Hora límite</label>
        <input id="hl-hora" type="time" value="${cfg.hora}" style="min-height:44px;background:var(--gris2);border:1px solid var(--gris3);border-radius:8px;padding:6px 10px;color:var(--blanco);font-size:0.9rem;">
        <label for="hl-normal">Días si pide antes</label>${num('hl-normal', cfg.diasNormal)}
        <label for="hl-tarde">Días si pide después</label>${num('hl-tarde', cfg.diasTarde)}
      </div>
      <button onclick="guardarHoraLimiteCfg()" style="width:100%;min-height:44px;margin-top:12px;background:var(--amarillo);border:none;border-radius:10px;padding:10px;font-weight:800;font-size:0.86rem;color:var(--negro);cursor:pointer;">Guardar hora límite</button>
    </div>`;
}

window.guardarHoraLimiteCfg = async function() {
  const hora = (document.getElementById('hl-hora')?.value || '').trim();
  const diasNormal = parseInt(document.getElementById('hl-normal')?.value, 10);
  const diasTarde = parseInt(document.getElementById('hl-tarde')?.value, 10);
  if (!/^\d{2}:\d{2}$/.test(hora) || isNaN(diasNormal) || isNaN(diasTarde) || diasTarde < diasNormal) {
    await avisar({ titulo: 'Revisa la hora límite', cuerpo: 'La hora va como HH:MM y los días «después» no pueden ser menos que los días «antes».' });
    return;
  }
  try {
    const res = await supabaseCall('POST', 'rpc/set_hora_limite_config', { p_data: { hora, diasNormal, diasTarde } });
    if (res && res.ok) { mostrarToast('Hora límite guardada'); renderHoraLimiteCfg(); }
    else await avisar({ titulo: 'No se pudo guardar la hora límite', cuerpo: (res && res.error) || 'Sin respuesta' });
  } catch (e) {
    await avisar({ titulo: 'No se pudo guardar la hora límite', cuerpo: e.message || '' });
  }
};

// ── Rutas de reparto (R1, 15 sep 2026) ───────────────────────────────────────
// Una ruta es una zona (colonias y rangos de CP) con días de reparto. Las lee
// get_rutas (público) y las fija set_rutas (solo dueño). El servidor asigna la
// ruta a cada tienda por trigger y nunca pisa una puesta a mano desde aquí.
window._rutasCache = null;   // activas, para selectores
async function cargarRutasCache() {
  try {
    const r = await supabaseCall('POST', 'rpc/get_rutas', { p_data: {} });
    window._rutasCache = (r && r.ok && Array.isArray(r.rutas)) ? r.rutas : [];
  } catch (_e) { window._rutasCache = window._rutasCache || []; }
  return window._rutasCache;
}
function nombreRuta(id) { const r = (window._rutasCache || []).find(x => String(x.id) === String(id)); return r ? r.nombre : ('Ruta ' + id); }
// 18 sep 2026: las rutas (zonas, días, preventa y vendedor) se definen solo en el planeador
// (/planeador, en la computadora). La tarjeta «Rutas de reparto» de B2B se retiró (P-D9);
// aquí queda corregir la ruta de UNA tienda desde su tarjeta.
window.reasignarRuta = async function(idCliente, idRuta) {
  try {
    const res = await supabaseCall('POST', 'rpc/reasignar_ruta_cliente', { p_data: { idCliente: Number(idCliente), idRuta: idRuta ? Number(idRuta) : null } });
    if (!res || !res.ok) { await avisar({ titulo: 'No se pudo cambiar la ruta', cuerpo: (res && res.error) || 'Sin respuesta' }); return; }
    mostrarToast(res.ruta ? 'Ruta: ' + res.ruta : 'Sin ruta');
    const cli = (_b2bClientes || []).find(c => String(c.id) === String(idCliente));
    if (cli) cli.idRuta = res.idRuta;
  } catch (e) { await avisar({ titulo: 'No se pudo cambiar la ruta', cuerpo: e.message || '' }); }
};

async function renderMayoreoAdminCfg() {
  const cont = document.getElementById('mayoreo-admin-cfg');
  if (!cont) return;
  if (!esAdminEstricto()) { cont.style.display = 'none'; cont.innerHTML = ''; return; }
  cont.style.display = 'block';
  cont.innerHTML = '<div style="background:var(--gris);border-radius:14px;padding:14px;margin:12px 16px;color:var(--suave);font-size:0.8rem;">Cargando mínimos de mayoreo…</div>';
  let mins = N.MAYOREO_MINIMOS;
  try {
    const cfg = await supabaseCall('POST', 'rpc/get_mayoreo_config', {});
    if (cfg && cfg.ok && cfg.minimos) { mins = cfg.minimos; N.MAYOREO_MINIMOS = cfg.minimos; }
  } catch(_e) {}
  const presentaciones = ['100g','250g','500g','1kg'];
  const inp = (pres) => `<input id="may-min-${pres}" type="number" inputmode="numeric" step="1" min="0" value="${mins[pres] ?? 0}" style="width:90px;background:var(--gris2);border:1px solid var(--gris3);border-radius:6px;padding:5px 8px;color:var(--blanco);font-size:0.8rem;text-align:right;">`;
  const fila = (pres) => `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px;font-size:0.82rem;color:var(--blanco);">
      <span>Mínimo ${pres}<br><span style="color:var(--suave);font-size:0.66rem;">piezas totales (mezclando sabores)</span></span>
      ${inp(pres)}
    </div>`;
  cont.innerHTML = `
    <div style="background:var(--gris);border-radius:14px;padding:14px;margin:12px 16px;">
      <div style="font-size:0.72rem;font-weight:800;color:var(--amarillo);text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;">Mínimos de mayoreo (admin)</div>
      ${presentaciones.map(fila).join('')}
      <button onclick="guardarMayoreoCfg()" style="width:100%;background:var(--amarillo);border:none;border-radius:10px;padding:10px;font-weight:800;font-size:0.82rem;color:var(--negro);cursor:pointer;">Guardar mínimos</button>
      <div style="font-size:0.64rem;color:var(--suave);margin-top:8px;text-align:center;">0 = sin mínimo. Aplica solo a pedidos de canal Mayorista.</div>
    </div>`;
}

window.guardarMayoreoCfg = async function() {
  const presentaciones = ['100g','250g','500g','1kg'];
  const minimos = {};
  presentaciones.forEach(pres => {
    const v = parseInt(document.getElementById('may-min-' + pres)?.value, 10);
    minimos[pres] = isNaN(v) ? 0 : Math.max(0, v);
  });
  try {
    const res = await supabaseCall('POST', 'rpc/set_mayoreo_config', { p_data: { minimos } });
    if (res && res.ok) {
      N.MAYOREO_MINIMOS = minimos;
      if (typeof mostrarToast === 'function') mostrarToast('Mínimos de mayoreo guardados');
      renderMayoreoAdminCfg();
    } else if (typeof mostrarToast === 'function') {
      mostrarToast('No se pudo guardar: ' + ((res && res.error) || 'error'));
    }
  } catch (e) {
    if (typeof mostrarToast === 'function') mostrarToast('Error al guardar los mínimos');
  }
};

// ══════════════════════════════════
// APROBACIÓN B2B (solo admins)
// ══════════════════════════════════
let _b2bFiltro = 'pendiente';
let _b2bClientes = [];

let _resumenCache = [];
let _resumenSabores = {};

// ══════════════════════════════════════════════════════════════════
// Filtros compartidos del Informe (periodo y producto)
// ══════════════════════════════════════════════════════════════════
// Antes cada tarjeta traía su propio control y el dashboard no aceptaba
// ninguno: el mes en curso estaba cableado dentro de la función de Postgres.
//
// Qué honra cada tarjeta, hoy:
//   Dashboard          periodo + producto
//   Embudo             su propio selector de días (por sabor no aplica:
//                      una sesión ve muchos productos)
//   Regalos, Kárdex    sus propios selectores (pendiente de unificar)
//
// Ojo con el filtro de producto: el dinero pasa a salir de los SUBTOTALES DE
// LÍNEA que casan, no del total del pedido. Si no, filtrar por un sabor daría
// el valor entero de los pedidos que lo llevan, con todo lo demás incluido.
let _filtroInf = { periodo: 'mes', desde: '', hasta: '', sabor: '', presentacion: '' };
let _catalogoFiltro = null;

function _iso(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
         '-' + String(d.getDate()).padStart(2, '0');
}

// Traduce la opción elegida a un rango de fechas concreto. `mes` devuelve
// vacío a propósito: sin fechas, el servidor aplica su valor por defecto, que
// es exactamente la vista de siempre.
function _rangoInforme() {
  const p = _filtroInf.periodo;
  const hoy = new Date();
  if (p === 'mes') return { desde: '', hasta: '' };
  if (p === 'mes-1') {
    const ini = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
    const fin = new Date(hoy.getFullYear(), hoy.getMonth(), 0);
    return { desde: _iso(ini), hasta: _iso(fin) };
  }
  if (p === 'libre') {
    return {
      desde: (document.getElementById('fi-desde') || {}).value || '',
      hasta: (document.getElementById('fi-hasta') || {}).value || '',
    };
  }
  const n = Number(p) || 30;
  const ini = new Date(hoy.getTime() - (n - 1) * 86400000);
  return { desde: _iso(ini), hasta: _iso(hoy) };
}

window.cambiarPeriodoInforme = function () {
  _filtroInf.periodo = (document.getElementById('fi-periodo') || {}).value || 'mes';
  const libre = document.getElementById('fi-libre');
  if (libre) libre.style.display = (_filtroInf.periodo === 'libre') ? 'inline-flex' : 'none';
  if (_filtroInf.periodo === 'libre') {
    // Al abrir el rango a medida se siembra con el mes en curso, para que los
    // dos campos nunca estén vacíos y la consulta no salga sin sentido.
    const hoy = new Date();
    const d = document.getElementById('fi-desde'), h = document.getElementById('fi-hasta');
    if (d && !d.value) d.value = _iso(new Date(hoy.getFullYear(), hoy.getMonth(), 1));
    if (h && !h.value) h.value = _iso(hoy);
  }
  aplicarFiltroInforme();
};

window.aplicarFiltroInforme = function () {
  const rango = _rangoInforme();
  _filtroInf.desde = rango.desde;
  _filtroInf.hasta = rango.hasta;
  _filtroInf.sabor = (document.getElementById('fi-sabor') || {}).value || '';
  _filtroInf.presentacion = (document.getElementById('fi-pres') || {}).value || '';
  cargarDashboard();
};

// El filtro que viaja al servidor. Solo se mandan las claves con valor: sin
// ellas, el RPC aplica su comportamiento de siempre.
function _pFiltroInforme() {
  const p = {};
  if (_filtroInf.desde) p.desde = _filtroInf.desde;
  if (_filtroInf.hasta) p.hasta = _filtroInf.hasta;
  if (_filtroInf.sabor) p.sabor = _filtroInf.sabor;
  if (_filtroInf.presentacion) p.presentacion = _filtroInf.presentacion;
  return p;
}

// Nota bajo la barra: qué periodo se está viendo y contra qué se compara. Sin
// esto, un porcentaje de crecimiento no se puede interpretar.
function _pintarNotaFiltro(d) {
  const el = document.getElementById('fi-nota');
  if (!el || !d) return;
  const fmt = (s) => {
    if (!s) return '';
    const p = String(s).slice(0, 10).split('-');
    return p[2] + '/' + p[1];
  };
  let txt = 'Del ' + fmt(d.desde) + ' al ' + fmt(d.hasta) + ' (' + d.dias +
            ' día' + (d.dias === 1 ? '' : 's') + ') · se compara contra ' +
            fmt(d.prev_desde) + '–' + fmt(d.prev_hasta);
  if (d.filtro_producto) {
    txt += ' · filtrado por ' + [d.sabor, d.presentacion].filter(Boolean).join(' / ') +
           ': el dinero son subtotales de esas líneas, no el total de los pedidos';
  }
  txt += ' · «Por entregar» y «Por cobrar» son saldo global, no del periodo';
  el.textContent = txt;
}

// Sabores y presentaciones para los desplegables. Sale de `productos`, que es
// una de las tres tablas que el navegador puede leer directo.
async function cargarOpcionesFiltro() {
  if (_catalogoFiltro) return;
  try {
    const r = await supabaseCall('GET', 'productos?select=sabor,presentacion&descontinuado=eq.false');
    if (!Array.isArray(r)) return;
    _catalogoFiltro = true;
    const sab = [...new Set(r.map((x) => x.sabor).filter(Boolean))].sort();
    const pre = [...new Set(r.map((x) => x.presentacion).filter(Boolean))].sort();
    const selS = document.getElementById('fi-sabor');
    const selP = document.getElementById('fi-pres');
    if (selS) sab.forEach((v) => selS.insertAdjacentHTML('beforeend', '<option value="' + v + '">' + v + '</option>'));
    if (selP) pre.forEach((v) => selP.insertAdjacentHTML('beforeend', '<option value="' + v + '">' + v + '</option>'));
  } catch (e) {}
}

// ── DASHBOARD VISUAL (admin) — lee del RPC dashboard_resumen (datos completos) ──
let _dashData = null;

async function cargarDashboard() {
  const cont = document.getElementById('resumen-dash');
  if (!cont) return;
  cont.innerHTML = '<div style="text-align:center;color:var(--suave);padding:20px 0;"><span class="loader loader-w"></span> Cargando dashboard...</div>';
  try {
    const res = await supabaseCall('POST', 'rpc/dashboard_resumen',
      { p_data: Object.assign({ token: tokenVendedor() }, _pFiltroInforme()) });
    if (res && res.ok && res.data) { _dashData = res.data; pintarDashboard(); _pintarNotaFiltro(res.data); }
    else { cont.innerHTML = '<div style="color:var(--rojo);font-size:0.8rem;padding:10px;">No se pudo cargar el dashboard: ' + (res?.error || 'sin respuesta') + '</div>'; }
  } catch(e) {
    cont.innerHTML = '<div style="color:var(--rojo);font-size:0.8rem;padding:10px;">Error: ' + e.message + '</div>';
  }
}

window.guardarCuotaDash = async function(idVend, nombre) {
  const inp = document.getElementById('cuota-' + idVend);
  if (!inp) return;
  const cuota = Number(String(inp.value).replace(/\D/g, '')) || 0;
  const d = new Date();
  try {
    await supabaseCall('POST', 'rpc/set_cuota_vendedor', {
      p_data: { idVendedor: idVend, mes: d.getMonth()+1, anio: d.getFullYear(), cuota }
    });
    if (typeof mostrarToast==='function') mostrarToast('Cuota de ' + (nombre||'') + ' guardada');
    cargarDashboard(); // recargar para reflejar objetivo + avance reales
  } catch(e) { if (typeof mostrarToast==='function') mostrarToast('Error al guardar la cuota'); }
};

function pintarDashboard() {
  const cont = document.getElementById('resumen-dash');
  if (!cont || !_dashData) return;
  const D = _dashData;

  const mtdAct  = Number(D.mtd_actual)   || 0;
  const mtdPrev = Number(D.mtd_anterior) || 0;
  const objetivo = Number(D.objetivo_mes) || 0;
  const diaMes  = Number(D.dia_mes) || 0;
  const deltaPct = mtdPrev > 0 ? Math.round(((mtdAct - mtdPrev) / mtdPrev) * 100) : null;
  const avancePct = objetivo > 0 ? Math.round((mtdAct / objetivo) * 100) : 0;

  // Ventas por día (MTD)
  const vd = Array.isArray(D.ventas_dia) ? D.ventas_dia : [];
  const maxDia = Math.max(1, ...vd.map(x => Number(x.monto) || 0));
  const barrasDia = vd.length ? vd.map(x => {
    const m = Number(x.monto) || 0;
    return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;min-width:8px;">
      <div style="width:100%;background:var(--amarillo);border-radius:3px 3px 0 0;height:${Math.round((m/maxDia)*60)}px;min-height:${m>0?3:0}px;" title="Día ${x.dia}: $${m.toLocaleString('es-MX')}"></div>
      <div style="font-size:0.48rem;color:var(--suave);">${x.dia}</div>
    </div>`;
  }).join('') : '<div style="color:var(--suave);font-size:0.78rem;">Sin ventas este mes</div>';

  // Top sabores
  const sab = Array.isArray(D.top_sabores) ? D.top_sabores : [];
  const maxSab = Math.max(1, ...sab.map(x => Number(x.pzas) || 0));
  const barrasSab = sab.length ? sab.map(x => `
    <div style="margin-bottom:6px;">
      <div style="display:flex;justify-content:space-between;font-size:0.72rem;margin-bottom:2px;">
        <span style="color:var(--blanco);font-weight:700;">${x.sabor}</span>
        <span style="color:var(--suave);">${Number(x.pzas).toLocaleString('es-MX')} pz</span>
      </div>
      <div style="background:var(--gris3);border-radius:4px;height:8px;overflow:hidden;">
        <div style="background:var(--amarillo);height:100%;width:${Math.round((Number(x.pzas)/maxSab)*100)}%;"></div>
      </div>
    </div>`).join('') : '<div style="color:var(--suave);font-size:0.78rem;">Sin datos de sabores</div>';

  // Top presentaciones (piezas; granel excluido en el RPC)
  const pres = Array.isArray(D.top_presentaciones) ? D.top_presentaciones : [];
  const maxPres = Math.max(1, ...pres.map(x => Number(x.pzas) || 0));
  const barrasPres = pres.length ? pres.map(x => `
    <div style="margin-bottom:6px;">
      <div style="display:flex;justify-content:space-between;font-size:0.72rem;margin-bottom:2px;">
        <span style="color:var(--blanco);font-weight:700;">${x.presentacion}</span>
        <span style="color:var(--suave);">${Number(x.pzas).toLocaleString('es-MX')} pz</span>
      </div>
      <div style="background:var(--gris3);border-radius:4px;height:8px;overflow:hidden;">
        <div style="background:var(--amarillo);height:100%;width:${Math.round((Number(x.pzas)/maxPres)*100)}%;"></div>
      </div>
    </div>`).join('') : '<div style="color:var(--suave);font-size:0.78rem;">Sin datos de presentaciones</div>';

  // Por vendedor
  const pv = Array.isArray(D.por_vendedor) ? D.por_vendedor : [];
  const maxVend = Math.max(1, ...pv.map(v => Number(v.ventas) || 0));
  const barrasVend = pv.length ? pv.map((v, i) => {
    const ventas = Number(v.ventas) || 0;
    const cuota  = Number(v.cuota)  || 0;
    const pct = cuota > 0 ? Math.min(100, Math.round((ventas/cuota)*100)) : 0;
    const medalla = ['','',''][i] || `${i+1}.`;
    const id = v.id_vendedor;
    const pedidos = Number(v.pedidos) || 0;
    const pend = Number(v.pendientes_pago) || 0;
    const pctPend = Number(v.pct_pendiente_pago) || 0;
    return `
      <div style="background:var(--gris2);border-radius:10px;padding:10px;margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <span style="font-weight:800;color:var(--blanco);font-size:0.82rem;">${medalla} ${v.nombre || ('Vendedor '+id)}</span>
          <span style="font-family:'Archivo',sans-serif;font-size:1.1rem;color:var(--amarillo);">$${ventas.toLocaleString('es-MX')}</span>
        </div>
        <div style="background:var(--gris3);border-radius:4px;height:7px;overflow:hidden;margin-bottom:4px;">
          <div style="background:${pct>=100?'#4caf50':'var(--amarillo)'};height:100%;width:${Math.max(2,Math.round((ventas/maxVend)*100))}%;"></div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.66rem;margin-bottom:4px;">
          <span style="color:var(--suave);">${pedidos} pedido${pedidos===1?'':'s'} este mes</span>
          <span style="font-weight:800;color:${pctPend>0?'#ff6b6b':'#4caf50'};">${pctPend}% pend. de pago${pend>0?` (${pend})`:''}</span>
        </div>
        ${id != null ? `
        <div style="display:flex;align-items:center;gap:6px;font-size:0.7rem;color:var(--suave);">
          <span>Cuota:</span>
          <input id="cuota-${id}" type="number" inputmode="numeric" value="${cuota||''}" placeholder="0"
            style="width:90px;background:var(--gris);border:1px solid var(--gris3);border-radius:6px;padding:3px 6px;color:var(--blanco);font-size:0.72rem;">
          <button onclick="guardarCuotaDash('${id}','${(v.nombre||'').replace(/'/g,'')}')" style="background:var(--amarillo);border:none;border-radius:6px;padding:3px 8px;font-weight:800;font-size:0.66rem;color:var(--negro);cursor:pointer;">Guardar</button>
          ${cuota>0?`<span style="margin-left:auto;font-weight:800;color:${pct>=100?'#4caf50':'var(--amarillo)'};">${pct}%</span>`:''}
        </div>` : ''}
      </div>`;
  }).join('') : '<div style="color:var(--suave);font-size:0.78rem;">Sin ventas este mes</div>';

  const card = (titulo, inner) => `
    <div style="background:var(--gris);border-radius:14px;padding:14px;margin-bottom:10px;">
      <div style="font-size:0.72rem;font-weight:800;color:var(--suave);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">${titulo}</div>
      ${inner}
    </div>`;
  const miniStat = (lbl, val, color) => `
    <div style="flex:1;min-width:70px;background:var(--gris2);border-radius:10px;padding:10px;text-align:center;">
      <div style="font-family:'Archivo',sans-serif;font-size:${String(val).length>8?'0.95rem':String(val).length>6?'1.15rem':'1.4rem'};color:${color||'var(--amarillo)'};line-height:1;">${val}</div>
      <div style="font-size:0.6rem;color:var(--suave);text-transform:uppercase;letter-spacing:0.5px;margin-top:3px;">${lbl}</div>
    </div>`;

  // Comparativo MTD vs MTD
  const deltaTxt = deltaPct === null
    ? '<span style="color:var(--suave);font-size:0.72rem;">sin mes anterior para comparar</span>'
    : `<span style="font-weight:800;color:${deltaPct>=0?'#4caf50':'#ff6b6b'};">${deltaPct>=0?'▲':'▼'} ${Math.abs(deltaPct)}%</span> <span style="color:var(--suave);font-size:0.72rem;">vs mismo periodo mes anterior ($${mtdPrev.toLocaleString('es-MX')})</span>`;

  // Objetivo vs avance
  const objBloque = objetivo > 0 ? `
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;">
        <span style="font-size:0.74rem;color:var(--suave);">Objetivo del mes (suma de cuotas)</span>
        <span style="font-weight:800;color:var(--blanco);">$${objetivo.toLocaleString('es-MX')}</span>
      </div>
      <div style="background:var(--gris3);border-radius:5px;height:12px;overflow:hidden;margin-bottom:4px;">
        <div style="background:${avancePct>=100?'#4caf50':'var(--amarillo)'};height:100%;width:${Math.min(100,avancePct)}%;"></div>
      </div>
      <div style="text-align:right;font-weight:800;color:${avancePct>=100?'#4caf50':'var(--amarillo)'};font-size:0.8rem;">${avancePct}% del objetivo</div>`
    : '<div style="color:var(--suave);font-size:0.74rem;">Define las cuotas por vendedor (abajo) para ver el objetivo del mes.</div>';

  // Bruto y neto (dashboard_resumen.ingresos): bruto − descuentos = neto; neto + envío cobrado = total cobrado.
  const I = D.ingresos || null;
  const dinero = (n) => '$' + (Number(n) || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const filaI = (lbl, val, signo, fuerte) => `
    <div style="display:flex;justify-content:space-between;gap:10px;font-size:0.78rem;padding:3px 0;${fuerte ? 'border-top:1px solid var(--gris3);margin-top:4px;padding-top:7px;font-weight:800;color:var(--blanco);' : 'color:var(--suave);'}">
      <span>${lbl}</span><span>${signo || ''}${dinero(val)}</span>
    </div>`;
  const bloqueIngresos = I
    ? filaI('Ingreso bruto', I.bruto) +
      filaI('Descuento de producto', I.desc_producto, '− ') +
      filaI('Cupones', I.cupones, '− ') +
      filaI('Crunchy Club (canje)', I.canje, '− ') +
      filaI('Ingreso neto', I.neto, '', true) +
      filaI('Envío: tarifa', I.envio_tarifa) +
      filaI('Envío absorbido (envío gratis)', I.envio_absorbido, '− ') +
      filaI('Envío cobrado', I.envio_cobrado, '+ ') +
      filaI('Total cobrado', I.cobrado, '', true) +
      (I.con_filtro ? '<div style="font-size:0.66rem;color:var(--suave);margin-top:6px;">Con filtro de producto: cupones y envío no se reparten por sabor.</div>' : '')
    : '<div style="color:var(--suave);font-size:0.74rem;">Sin desglose de ingresos.</div>';

  cont.innerHTML =
    card(`Ingreso neto del mes · ${new Date().toLocaleDateString('es-MX',{month:'long'})} (MTD, ${diaMes} días)`,
      `<div style="font-family:'Archivo',sans-serif;font-size:2.2rem;color:var(--amarillo);line-height:1;">$${mtdAct.toLocaleString('es-MX')}</div>
       <div style="font-size:0.66rem;color:var(--suave);margin-top:4px;">Producto después de descuentos, sin envío</div>
       <div style="margin:4px 0 12px;">${deltaTxt}</div>
       <div style="display:flex;align-items:flex-end;gap:2px;height:70px;">${barrasDia}</div>
       <div style="font-size:0.58rem;color:var(--suave);text-align:center;margin-top:2px;">ingreso neto por día</div>`) +
    card('Bruto y neto', bloqueIngresos) +
    card('Objetivo vs avance', objBloque) +
    card('Estatus de pedidos',
      `<div style="display:flex;gap:8px;flex-wrap:wrap;">
        ${miniStat('Por entregar', Number(D.por_entregar)||0, (Number(D.por_entregar)||0)>0?'var(--amarillo)':'#4caf50')}
        ${miniStat('Por cobrar', '$'+(Number(D.por_cobrar_monto)||0).toLocaleString('es-MX'), (Number(D.por_cobrar_monto)||0)>0?'var(--amarillo)':'#4caf50')}
        ${miniStat('Entregados', Number(D.entregados)||0, '#4caf50')}
      </div>`) +
    card('Top sabores (piezas)', barrasSab) +
    card('Top presentaciones (piezas)', barrasPres) +
    card('Por vendedor (ingreso neto vs cuota)', barrasVend);
}

// Respaldo de copiado cuando no hay navigator.clipboard (solo existe en https):
// un textarea invisible y execCommand('copy'). Si tampoco, el prompt de siempre.
function copiarResumenRespaldo(txt) {
  let ok = false;
  try {
    const ta = document.createElement('textarea');
    ta.value = txt; ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
    document.body.appendChild(ta);
    ta.focus(); ta.select(); ta.setSelectionRange(0, txt.length);
    ok = document.execCommand('copy');
    document.body.removeChild(ta);
  } catch (e) { ok = false; }
  if (ok) { if (typeof mostrarToast==='function') mostrarToast('Resumen copiado. Pégalo en WhatsApp'); }
  else prompt('Copia el resumen:', txt);
}
window.copiarResumenDia = function() {
  if (!_dashData) { if (typeof mostrarToast==='function') mostrarToast('Aún no carga el dashboard'); return; }
  const D = _dashData;
  const mtdAct = Number(D.mtd_actual)||0, mtdPrev = Number(D.mtd_anterior)||0, obj = Number(D.objetivo_mes)||0;
  const deltaPct = mtdPrev > 0 ? Math.round(((mtdAct-mtdPrev)/mtdPrev)*100) : null;
  const avance = obj > 0 ? Math.round((mtdAct/obj)*100) : null;
  const sab = (Array.isArray(D.top_sabores)?D.top_sabores:[]).slice(0,3);
  const pres = (Array.isArray(D.top_presentaciones)?D.top_presentaciones:[]).slice(0,4);
  const pv = (Array.isArray(D.por_vendedor)?D.por_vendedor:[]);
  const vendTxt = pv.map(v => `• ${v.nombre||('Vend '+v.id_vendedor)}: $${(Number(v.ventas)||0).toLocaleString('es-MX')}`).join('\n');
  const txt =
    `*Crunchy Paps — Resumen*\n${new Date().toLocaleDateString('es-MX',{weekday:'long',day:'numeric',month:'long'})}\n\n` +
    `Ingreso neto del mes (MTD): *$${mtdAct.toLocaleString('es-MX')}*` +
    (deltaPct!==null?` (${deltaPct>=0?'▲':'▼'}${Math.abs(deltaPct)}% vs mes ant.)`:'') + `\n` +
    (avance!==null?`Avance objetivo: ${avance}% (de $${obj.toLocaleString('es-MX')})\n`:'') +
    `Por entregar: ${Number(D.por_entregar)||0}  ·  Por cobrar: $${(Number(D.por_cobrar_monto)||0).toLocaleString('es-MX')}\n` +
    (window._invResumenTxt ? `\n${window._invResumenTxt}` : '') + `\n` +
    (sab.length?`Top sabores: ${sab.map(x=>`${x.sabor} (${Number(x.pzas).toLocaleString('es-MX')})`).join(', ')}\n`:'') +
    (pres.length?`Top presentaciones: ${pres.map(x=>`${x.presentacion} (${Number(x.pzas).toLocaleString('es-MX')})`).join(', ')}\n`:'') +
    `\n` +
    (vendTxt?`Por vendedor:\n${vendTxt}\n`:'');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(txt).then(
      () => { if (typeof mostrarToast==='function') mostrarToast('Resumen copiado. Pégalo en WhatsApp'); },
      () => copiarResumenRespaldo(txt)
    );
  } else { copiarResumenRespaldo(txt); }
};

window.descargarInformePDF = function() {
  const dash  = document.getElementById('resumen-dash')?.innerHTML || '';
  const prod  = document.getElementById('resumen-produccion')?.innerHTML || '';
  const stock = document.getElementById('resumen-stock')?.innerHTML || '';
  if (!dash && !prod && !stock) { if (typeof mostrarToast==='function') mostrarToast('El informe aún no carga'); return; }
  const fecha = new Date().toLocaleDateString('es-MX',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  const css = `
    :root{--amarillo:#FFD200;--rojo:#E8242A;--negro:#0e0e0e;--gris:#1a1a1a;--gris2:#222222;--gris3:#2e2e2e;--blanco:#FAFAFA;--suave:#888;}
    *{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
    body{font-family:'Inter',Arial,sans-serif;background:#fff;color:#111;margin:0;padding:22px;}
    .cp-head{display:flex;align-items:center;gap:10px;border-bottom:3px solid #FFD200;padding-bottom:12px;margin-bottom:18px;}
    .cp-head h1{font-size:18px;margin:0;color:#111;font-family:'Archivo',Arial,sans-serif; font-weight:700;letter-spacing:1px;}
    .cp-head .d{margin-left:auto;color:#666;font-size:12px;text-transform:capitalize;}
    @media print { .noprint{display:none!important;} }
  `;
  const w = window.open('', '_blank');
  if (!w) { if (typeof mostrarToast==='function') mostrarToast('Permite ventanas emergentes para generar el PDF'); return; }
  w.document.write(
    '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">' +
    '<title>Crunchy Paps — Informe ' + fecha + '</title>' +
    '<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700;800&family=Inter:wght@400;700;800;900&display=swap" rel="stylesheet">' +
    '<style>' + css + '</style></head><body>' +
    '<div class="cp-head"><h1>Crunchy Paps — Informe</h1><span class="d">' + fecha + '</span></div>' +
    dash + prod + stock +
    '<button class="noprint" onclick="window.print()" style="position:fixed;bottom:16px;right:16px;background:#FFD200;border:none;border-radius:10px;padding:12px 18px;font-weight:800;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,0.25);">Guardar como PDF</button>' +
    '</body></html>'
  );
  w.document.close();
  setTimeout(() => { try { w.focus(); w.print(); } catch(e) {} }, 700);
};

// ── RECORDATORIOS DE PAGO (manual, solo admin) ──
function cronSecret() {
  let s = '';
  try { s = localStorage.getItem('cp_cron_secret') || ''; } catch(e) {}
  if (!s) {
    s = (prompt('Clave de recordatorios (CRON_SECRET):') || '').trim();
    if (s) { try { localStorage.setItem('cp_cron_secret', s); } catch(e) {} }
  }
  return s;
}

window.cargarRecordatoriosPago = async function() {
  const cont = document.getElementById('recordatorios-lista');
  if (!cont) return;
  const secret = cronSecret();
  if (!secret) { cont.innerHTML = '<div style="color:var(--rojo);font-size:0.8rem;">Se necesita la clave para continuar.</div>'; return; }
  cont.innerHTML = '<div style="color:var(--suave);font-size:0.8rem;">Cargando pendientes…</div>';
  try {
    const r = await fetch(`/api/recordatorios-pago?secret=${encodeURIComponent(secret)}&force=1&dry=1&t=${Date.now()}`);
    const d = await r.json();
    if (!d.ok) {
      if (String(d.error||'').includes('autorizado')) { try{ localStorage.removeItem('cp_cron_secret'); }catch(e){} }
      cont.innerHTML = `<div style="color:var(--rojo);font-size:0.8rem;">${d.error||'Error'}</div>`;
      return;
    }
    const items = d.detalle || [];
    if (!items.length) { cont.innerHTML = '<div style="color:#4caf50;font-size:0.82rem;">✓ No hay pedidos pendientes de pago.</div>'; return; }
    const filas = items.map(x => {
      const sinTel = !x.to;
      return `
      <div style="background:var(--gris2);border-radius:10px;padding:10px;margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <div style="flex:1;min-width:0;">
            <div style="font-weight:800;color:var(--blanco);font-size:0.84rem;">${x.folio} · $${(x.total||0).toLocaleString('es-MX')}</div>
            <div style="font-size:0.7rem;color:var(--suave);">${x.cliente||'—'} · ${x.to||'sin teléfono'}</div>
            <div style="font-size:0.66rem;color:#555;">hace ${x.dias!=null?x.dias:'?'} días · ${x.recordatorios||0} recordatorio(s) enviado(s)</div>
          </div>
          <button onclick="enviarRecordatorioUno('${x.folio}', this)" ${sinTel?'disabled':''}
            style="background:${sinTel?'var(--gris3)':'var(--amarillo)'};border:none;border-radius:8px;padding:8px 10px;font-weight:800;font-size:0.7rem;color:${sinTel?'#666':'var(--negro)'};cursor:${sinTel?'not-allowed':'pointer'};white-space:nowrap;">
            ${sinTel?'sin tel':'Enviar SMS'}
          </button>
        </div>
      </div>`;
    }).join('');
    const conTel = items.filter(x => x.to).length;
    cont.innerHTML = filas + (conTel > 1 ? `
      <button onclick="enviarRecordatoriosTodos(${conTel})" style="width:100%;margin-top:4px;background:#25D366;border:none;border-radius:10px;padding:11px;font-weight:800;font-size:0.8rem;color:#fff;cursor:pointer;">Enviar a todos (${conTel})</button>` : '');
  } catch(e) {
    cont.innerHTML = `<div style="color:var(--rojo);font-size:0.8rem;">Error: ${e.message}</div>`;
  }
};

window.enviarRecordatorioUno = async function(folio, btn) {
  if (!(await confirmar({ titulo: 'Enviar recordatorio de pago', cuerpo: `Pedido ${folio}. Se manda un SMS al cliente.`, aceptar: 'Enviar' }))) return;
  const secret = cronSecret(); if (!secret) return;
  const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Enviando…';
  try {
    const r = await fetch(`/api/recordatorios-pago?secret=${encodeURIComponent(secret)}&solo=${encodeURIComponent(folio)}&t=${Date.now()}`);
    const d = await r.json();
    if (d.ok && d.enviados > 0) mostrarToast(`Recordatorio enviado (${folio})`);
    else if (d.ok && d.fallidos > 0) mostrarToast(`No se envió: ${d.detalle?.[0]?.error || 'revisa el número'}`);
    else mostrarToast(d.error || 'No se pudo enviar');
  } catch(e) { mostrarToast('Error: ' + e.message); }
  btn.disabled = false; btn.textContent = orig;
  setTimeout(cargarRecordatoriosPago, 900);
};

window.enviarRecordatoriosTodos = async function(n) {
  if (!(await confirmar({ titulo: 'Enviar recordatorios de pago', cuerpo: `A los ${n} pedidos pendientes con teléfono. Un SMS por pedido.`, aceptar: `Enviar ${n}`, peligroso: true }))) return;
  const secret = cronSecret(); if (!secret) return;
  mostrarToast('Enviando recordatorios…');
  try {
    const r = await fetch(`/api/recordatorios-pago?secret=${encodeURIComponent(secret)}&force=1&t=${Date.now()}`);
    const d = await r.json();
    if (d.ok) mostrarToast(`Enviados: ${d.enviados} · Fallidos: ${d.fallidos}`);
    else mostrarToast(d.error || 'Error al enviar');
  } catch(e) { mostrarToast('Error: ' + e.message); }
  setTimeout(cargarRecordatoriosPago, 1200);
};

window.editarCopyRecordatorio = async function() {
  const panel = document.getElementById('recordatorios-copy');
  const txt = document.getElementById('recordatorios-copy-txt');
  const msg = document.getElementById('recordatorios-copy-msg');
  if (!panel || !txt) return;
  const abierto = panel.style.display !== 'none';
  panel.style.display = abierto ? 'none' : 'block';
  if (abierto) return;
  const secret = cronSecret();
  if (!secret) { txt.value = ''; if (msg) msg.textContent = 'Se necesita la clave.'; return; }
  txt.value = ''; txt.placeholder = 'Cargando…'; if (msg) msg.textContent = '';
  try {
    const r = await fetch(`/api/recordatorios-pago?secret=${encodeURIComponent(secret)}&t=${Date.now()}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accion: 'get_copy' })
    });
    const d = await r.json();
    if (d.ok) { txt.value = d.plantilla || ''; }
    else {
      if (String(d.error||'').includes('autorizado')) { try{ localStorage.removeItem('cp_cron_secret'); }catch(e){} }
      if (msg) msg.textContent = d.error || 'No se pudo cargar.';
    }
  } catch(e) { if (msg) msg.textContent = 'Error: ' + e.message; }
};

window.guardarCopyRecordatorio = async function(btn) {
  const txt = document.getElementById('recordatorios-copy-txt');
  const msg = document.getElementById('recordatorios-copy-msg');
  if (!txt) return;
  const plantilla = (txt.value || '').trim();
  if (!plantilla) { if (msg) msg.textContent = 'El mensaje no puede quedar vacío.'; return; }
  if (!/\{folio\}/.test(plantilla) || !/\{link\}/.test(plantilla)) {
    if (!(await confirmar({ titulo: 'Faltan marcadores', cuerpo: 'El mensaje no incluye {folio} o {link}.', aceptar: 'Guardar de todos modos' }))) return;
  }
  const secret = cronSecret(); if (!secret) return;
  const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Guardando…';
  try {
    const r = await fetch(`/api/recordatorios-pago?secret=${encodeURIComponent(secret)}&t=${Date.now()}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accion: 'guardar_copy', plantilla })
    });
    const d = await r.json();
    if (d.ok) { if (msg) msg.textContent = 'Mensaje guardado.'; mostrarToast('Mensaje actualizado'); }
    else { if (msg) msg.textContent = d.error || 'No se pudo guardar.'; }
  } catch(e) { if (msg) msg.textContent = 'Error: ' + e.message; }
  btn.disabled = false; btn.textContent = orig;
};

// ══════════════════════════════════
// KÁRDEX DE LOTE — libro contable: cada pedido = un renglón con saldo corrido
// ══════════════════════════════════
// ══════════════════════════════════════════════════════════════════
// Embudo de comportamiento (PLAN.md §7.6, pregunta 1)
// ══════════════════════════════════════════════════════════════════
// Dos embudos: consumidor y personal. El de personal no es ruido a tirar —
// si el equipo se atasca en un paso, es fricción de la herramienta que usan
// todos los días, y hoy eso no lo ve nadie.
//
// El cálculo vive en Postgres (embudo_resumen): aquí solo se pinta. Cada
// sesión aporta su escalón MÁS LEJANO, así que los escalones nunca crecen.
window.cargarEmbudo = async function(dias) {
  const cont = document.getElementById('embudo-cont');
  if (!cont) return;
  cont.innerHTML = '<div style="color:var(--suave);font-size:0.8rem;">Cargando embudo…</div>';
  try {
    const r = await supabaseCall('POST', 'rpc/embudo_resumen',
      { p_data: { dias: Number(dias) || 30 } });
    if (!r || !r.ok) {
      cont.innerHTML = '<div style="color:var(--rojo);font-size:0.8rem;">' +
        ((r && r.error) || 'No se pudo cargar') + '</div>';
      return;
    }
    const canales = r.canales || [];
    if (!canales.length) {
      cont.innerHTML = '<div style="color:var(--suave);font-size:0.8rem;">Sin recorridos en el periodo.</div>';
      return;
    }
    const ETIQ = { consumidor: 'Consumidor', personal: 'Personal (mostrador)' };
    let html = '';
    canales.forEach(function (c) {
      const pasos = c.pasos || [];
      const base = (pasos[0] && pasos[0].sesiones) || 0;
      // La caída MAYOR es el punto donde arreglar la app rinde más: se resalta,
      // porque es la única cifra de toda la tarjeta sobre la que se actúa.
      let peor = -1, peorIdx = -1;
      pasos.forEach(function (p, i) {
        if (i === 0) return;
        const caida = (pasos[i - 1].sesiones || 0) - (p.sesiones || 0);
        if (caida > peor) { peor = caida; peorIdx = i; }
      });
      html += '<div style="margin-bottom:14px;">' +
        '<div style="font-weight:800;font-size:0.8rem;color:var(--blanco);margin-bottom:6px;">' +
        (ETIQ[c.canal] || c.canal) + ' · <span style="color:var(--suave);font-weight:600;">' +
        base + ' sesion' + (base === 1 ? '' : 'es') + '</span></div>';
      pasos.forEach(function (p, i) {
        const n = p.sesiones || 0;
        const pct = base ? Math.round(n * 100 / base) : 0;
        const prev = i ? (pasos[i - 1].sesiones || 0) : n;
        const caida = prev - n;
        const pctCaida = prev ? Math.round(caida * 100 / prev) : 0;
        const esPeor = (i === peorIdx && caida > 0);
        html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:3px;font-size:0.75rem;">' +
          '<div style="flex:0 0 118px;color:var(--suave);">' + p.nombre + '</div>' +
          '<div style="flex:1;background:var(--gris2);border-radius:4px;height:16px;overflow:hidden;min-width:40px;">' +
            '<div style="width:' + pct + '%;height:100%;background:' +
            (esPeor ? 'var(--rojo)' : 'var(--amarillo)') + ';"></div>' +
          '</div>' +
          '<div style="flex:0 0 74px;text-align:right;color:var(--blanco);font-weight:700;">' +
            n + ' <span style="color:var(--suave);font-weight:600;">(' + pct + '%)</span></div>' +
          '<div style="flex:0 0 56px;text-align:right;font-weight:700;color:' +
            (esPeor ? 'var(--rojo)' : 'var(--suave)') + ';">' +
            (i === 0 ? '' : (caida > 0 ? '−' + pctCaida + '%' : '—')) + '</div>' +
        '</div>';
      });
      if (peorIdx > 0 && peor > 0) {
        html += '<div style="font-size:0.72rem;color:var(--rojo);margin-top:4px;">' +
          'Mayor caída: ' + pasos[peorIdx - 1].nombre + ' → ' + pasos[peorIdx].nombre +
          ' (' + peor + ' sesion' + (peor === 1 ? '' : 'es') + ')</div>';
      }
      html += '</div>';
    });
    // El corte importa: los eventos anteriores al 5 sep 2026 no llevan marca de
    // canal, así que las sesiones de personal de antes salen como consumidor.
    html += '<div style="font-size:0.68rem;color:var(--suave);border-top:1px solid var(--gris3);padding-top:6px;">' +
      'Una sesión cuenta en el escalón más lejano al que llegó. Antes del 5 sep 2026 ' +
      'los eventos no distinguían al personal, así que esas sesiones aparecen como consumidor.</div>';
    cont.innerHTML = html;
  } catch (e) {
    cont.innerHTML = '<div style="color:var(--rojo);font-size:0.8rem;">Error: ' + e.message + '</div>';
  }
};

window.cargarMetricaRegalo = async function(yyyymm) {
  const cont = document.getElementById('regalos-cont');
  if (!cont) return;
  const m = String(yyyymm || '').split('-');
  if (m.length !== 2) { cont.innerHTML = '<div style="color:var(--suave);font-size:0.8rem;">Elige un mes.</div>'; return; }
  const anio = parseInt(m[0], 10), mes = parseInt(m[1], 10);
  cont.innerHTML = '<div style="color:var(--suave);font-size:0.8rem;">Calculando…</div>';
  try {
    const r = await supabaseCall('POST', 'rpc/metricas_regalo_mes', { p_anio: anio, p_mes: mes, p_token: tokenVendedor() });
    if (!r || !r.ok) { cont.innerHTML = '<div style="color:var(--rojo);font-size:0.8rem;">No se pudo calcular.</div>'; return; }
    const fmtKg = (n) => (Number(n) || 0).toLocaleString('es-MX', { maximumFractionDigits: 3 }) + ' kg';
    const fmtMx = (n) => '$' + (Number(n) || 0).toLocaleString('es-MX', { maximumFractionDigits: 2 });
    const pctV = (r.pct_volumen == null) ? '—' : r.pct_volumen + '%';
    const pctD = (r.pct_dinero == null) ? '—' : r.pct_dinero + '%';
    const colorPct = (p) => p == null ? 'var(--blanco)' : (p < 5 ? '#7ee787' : (p <= 10 ? '#ffa500' : '#ff6b6b'));

    let html = `
      <div style="display:flex;gap:10px;margin-bottom:12px;">
        <div style="flex:1;background:var(--gris2);border-radius:10px;padding:12px;text-align:center;">
          <div style="font-size:0.66rem;color:var(--suave);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">% en volumen</div>
          <div style="font-family:'Archivo',sans-serif;font-size:1.8rem;color:${colorPct(r.pct_volumen)};line-height:1;">${pctV}</div>
          <div style="font-size:0.68rem;color:var(--suave);margin-top:4px;">${fmtKg(r.regalo_kg)} / ${fmtKg(r.ventas_kg)}</div>
        </div>
        <div style="flex:1;background:var(--gris2);border-radius:10px;padding:12px;text-align:center;">
          <div style="font-size:0.66rem;color:var(--suave);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">% en dinero</div>
          <div style="font-family:'Archivo',sans-serif;font-size:1.8rem;color:${colorPct(r.pct_dinero)};line-height:1;">${pctD}</div>
          <div style="font-size:0.68rem;color:var(--suave);margin-top:4px;">${fmtMx(r.regalo_mxn)} / ${fmtMx(r.ventas_mxn)}</div>
        </div>
      </div>`;

    const pc = Array.isArray(r.por_cliente) ? r.por_cliente : [];
    if (pc.length) {
      html += `<div style="font-size:0.7rem;color:var(--suave);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Por cliente (top)</div>`;
      html += `<div style="display:flex;flex-direction:column;gap:4px;">`;
      pc.forEach(c => {
        const nom = c.nombre || ('Cliente ' + (c.id_cliente || '?'));
        const pctTxt = (c.pct_vol == null) ? 'sin ventas en el mes' : (c.pct_vol + '% de sus ventas');
        html += `
          <div style="display:flex;justify-content:space-between;align-items:center;background:var(--gris2);border-radius:8px;padding:8px 10px;">
            <div style="flex:1;min-width:0;">
              <div style="font-size:0.8rem;color:var(--blanco);font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${nom}</div>
              <div style="font-size:0.68rem;color:var(--suave);">${pctTxt}</div>
            </div>
            <div style="text-align:right;flex:0 0 auto;margin-left:8px;">
              <div style="font-size:0.8rem;color:var(--amarillo);font-weight:800;">${fmtKg(c.regalo_kg)}</div>
              <div style="font-size:0.68rem;color:var(--suave);">${fmtMx(c.regalo_mxn)}</div>
            </div>
          </div>`;
      });
      html += `</div>`;
    } else {
      html += `<div style="color:var(--suave);font-size:0.78rem;">Sin regalos registrados este mes.</div>`;
    }
    cont.innerHTML = html;
  } catch (e) {
    cont.innerHTML = '<div style="color:var(--rojo);font-size:0.8rem;">Error: ' + e.message + '</div>';
  }
};

async function cargarKardexLotes() {
  try {
    const _rl2 = await supabaseCall('POST', 'rpc/obtener_lotes', { p_data: { limit: 500 } });
    const arr = (_rl2 && _rl2.ok) ? _rl2.lotes : [];
    const sel = document.getElementById('kardex-lote-select');
    if (!sel || !Array.isArray(arr)) return;
    const prev = sel.value;
    sel.innerHTML = '<option value="">Selecciona lote…</option><option value="__todos__">Todos los lotes (pedido → lote)</option>';
    arr.forEach(l => {
      const opt = document.createElement('option');
      opt.value = l.id_lote;
      const disp = (Number(l.kilos_disponibles) || 0).toFixed(1);
      const est = l.estatus && l.estatus !== 'Activo' ? ` · ${l.estatus}` : '';
      opt.textContent = `${l.id_lote} · ${disp}kg disp.${est}`;
      sel.appendChild(opt);
    });
    if (prev) { sel.value = prev; }
  } catch(e) {}
}

window.renderKardexLote = async function(idLote) {
  const cont = document.getElementById('kardex-cont');
  if (!cont) return;
  if (!idLote) { cont.innerHTML = '<div style="color:var(--suave);font-size:0.8rem;">Elige un lote para ver el movimiento de cada gramo (pedido a pedido, con saldo corrido).</div>'; return; }
  cont.innerHTML = '<div style="color:var(--suave);font-size:0.82rem;padding:8px 0;">Cargando movimientos…</div>';

  // ── Vista transversal: TODOS los lotes (cada pedido con su lote asignado) ──
  if (idLote === '__todos__') {
    try {
      // Etapa B: el join embebido lo hace ahora el RPC, con sesión.
      const _rk = await supabaseCall('POST', 'rpc/obtener_kardex_lotes', { p_data: { limit: 400 } });
      const det = (_rk && _rk.ok && Array.isArray(_rk.movimientos)) ? _rk.movimientos : [];
      const porPedido = {};
      (det || []).forEach(d => {
        const o = d.ordenes || {};
        const k = o.consecutivo || '?';
        if (!porPedido[k]) porPedido[k] = { fecha: o.fecha_orden, interno: o.tipo_interno || '', lotes: {}, kg: 0 };
        porPedido[k].kg += Number(d.kg_descontado_lote) || 0;
        porPedido[k].lotes[d.id_lote_descontado || '—'] = true;
      });
      const filas = Object.keys(porPedido).sort().reverse().map(k => {
        const p = porPedido[k];
        const f = p.fecha ? new Date(p.fecha).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' }) : '—';
        const lotes = Object.keys(p.lotes).map(l => l.replace('LOTE-', '')).join(', ');
        const tag = p.interno ? ` <span style="color:var(--amarillo);">${p.interno}</span>` : '';
        return `<div style="display:flex;justify-content:space-between;gap:8px;border-bottom:1px solid var(--gris3);padding:7px 0;font-size:0.76rem;">
          <div><strong style="color:var(--blanco);">${k}</strong>${tag}<div style="color:var(--suave);">${f}</div></div>
          <div style="text-align:right;"><strong style="color:var(--amarillo);">${lotes}</strong><div style="color:var(--suave);">${p.kg.toFixed(2)} kg</div></div>
        </div>`;
      }).join('');
      cont.innerHTML = filas
        ? `<div style="font-size:0.72rem;color:var(--suave);margin-bottom:6px;">${Object.keys(porPedido).length} pedidos con lote asignado (más reciente primero)</div>` + filas
        : '<div style="color:var(--suave);font-size:0.8rem;">Aún no hay pedidos con lote asignado.</div>';
    } catch(e) {
      cont.innerHTML = '<div style="color:var(--rojo);font-size:0.82rem;">Error: ' + e.message + '</div>';
    }
    return;
  }
  try {
    // 1) Datos del lote
    const _rl3 = await supabaseCall('POST', 'rpc/obtener_lotes', { p_data: { idLote } });
    const loteArr = (_rl3 && _rl3.ok) ? _rl3.lotes : [];
    const lote = Array.isArray(loteArr) ? loteArr[0] : null;
    if (!lote) { cont.innerHTML = '<div style="color:var(--rojo);font-size:0.82rem;">No se encontró el lote.</div>'; return; }
    const producido = Number(lote.kilos_totales) || 0;
    const vendido   = Number(lote.kilos_vendidos) || 0;
    const disponible = (lote.kilos_disponibles != null) ? Number(lote.kilos_disponibles) : (producido - vendido);

    // 2) Líneas que consumen del lote (estado actual)
    const _rk = await supabaseCall('POST', 'rpc/obtener_kardex_lotes', { p_data: { idLote } });
    const lineas = (_rk && _rk.ok && Array.isArray(_rk.movimientos)) ? _rk.movimientos : [];

    // 3) Datos de los pedidos asociados
    const idsOrden = [...new Set(lineas.map(l => l.id_orden).filter(v => v != null))];
    const mapaOrden = {};
    if (idsOrden.length) {
      const _ro = await supabaseCall('POST', 'rpc/obtener_pedidos', { p_data: { ids: idsOrden } });
      const ords = (_ro && _ro.ok && Array.isArray(_ro.pedidos)) ? _ro.pedidos : [];
      if (Array.isArray(ords)) ords.forEach(o => { mapaOrden[o.id] = o; });
    }

    // 4) Agrupar por pedido (un renglón por pedido)
    const porPedido = {};
    lineas.forEach(l => {
      const o = mapaOrden[l.id_orden] || {};
      const folio = l.consecutivo_orden || o.consecutivo || ('#' + l.id_orden);
      if (!porPedido[folio]) {
        const _tInt = (o.tipo_interno || '').trim();
        const _lblInt = { sampling:'Sampling', consumo:'Consumo', demo:'Demo', regalo:'Regalo', bonificacion:'Bonificación', merma:'Merma' }[_tInt] || (_tInt ? 'Interno' : '');
        const _cli = o.nombre_cliente || '—';
        porPedido[folio] = {
          folio,
          cliente: _lblInt ? `${_lblInt} · ${_cli}` : _cli,
          fecha: o.fecha_orden || null,
          estatus: o.estatus_pedido || '—',
          kg: 0,
          items: [],
        };
      }
      porPedido[folio].kg += Number(l.kg_descontado_lote) || 0;
      const pres = l.presentacion ? ` ${l.presentacion}` : '';
      const cant = l.cantidad ? `${cantidadConCajas(l)} ` : '';
      porPedido[folio].items.push(`${cant}${l.sabor || '—'}${pres}`);
    });

    let filas = Object.values(porPedido);
    // Orden cronológico ascendente (libro contable)
    filas.sort((a, b) => {
      const ta = a.fecha ? new Date(a.fecha).getTime() : 0;
      const tb = b.fecha ? new Date(b.fecha).getTime() : 0;
      return ta - tb;
    });

    // 5) Saldo corrido desde lo producido
    let saldo = producido;
    const fmtKg = (n) => (Math.round(n * 1000) / 1000).toLocaleString('es-MX', { maximumFractionDigits: 3 });
    const fmtFecha = (f) => f ? new Date(f).toLocaleDateString('es-MX', { day: '2-digit', month: 'short' }) : '—';

    const rowsHtml = filas.map(r => {
      saldo -= r.kg;
      const cancel = String(r.estatus).toLowerCase() === 'cancelado';
      const estColor = cancel ? '#ff8a8a' : (String(r.estatus).toLowerCase() === 'entregado' ? '#7ee787' : 'var(--suave)');
      return `<tr style="border-bottom:1px solid var(--gris3);">
        <td style="padding:7px 8px;white-space:nowrap;color:var(--suave);font-size:0.74rem;">${fmtFecha(r.fecha)}</td>
        <td style="padding:7px 8px;white-space:nowrap;font-weight:700;font-size:0.76rem;color:var(--amarillo);">${r.folio}</td>
        <td style="padding:7px 8px;font-size:0.76rem;">${r.cliente}</td>
        <td style="padding:7px 8px;font-size:0.72rem;color:var(--suave);">${r.items.join(', ')}</td>
        <td style="padding:7px 8px;text-align:right;white-space:nowrap;font-weight:800;font-size:0.76rem;color:#ff8a8a;">−${fmtKg(r.kg)}</td>
        <td style="padding:7px 8px;text-align:right;white-space:nowrap;font-weight:800;font-size:0.78rem;">${fmtKg(saldo)}</td>
      </tr>`;
    }).join('');

    const reconcilia = Math.abs(saldo - disponible) < 0.01;
    const aviso = reconcilia
      ? `<span style="color:#7ee787;">✓ Cuadra con disponible</span>`
      : `<span style="color:#ffb454;">Saldo calculado ${fmtKg(saldo)} vs disponible ${fmtKg(disponible)} (revisar)</span>`;

    cont.innerHTML = `
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
        <div style="background:var(--gris2);border-radius:8px;padding:8px 10px;flex:1;min-width:90px;">
          <div style="font-size:0.62rem;color:var(--suave);text-transform:uppercase;letter-spacing:0.5px;">Producido</div>
          <div style="font-size:1rem;font-weight:800;">${fmtKg(producido)}kg</div>
        </div>
        <div style="background:var(--gris2);border-radius:8px;padding:8px 10px;flex:1;min-width:90px;">
          <div style="font-size:0.62rem;color:var(--suave);text-transform:uppercase;letter-spacing:0.5px;">Vendido</div>
          <div style="font-size:1rem;font-weight:800;color:#ff8a8a;">${fmtKg(vendido)}kg</div>
        </div>
        <div style="background:var(--gris2);border-radius:8px;padding:8px 10px;flex:1;min-width:90px;">
          <div style="font-size:0.62rem;color:var(--suave);text-transform:uppercase;letter-spacing:0.5px;">Disponible</div>
          <div style="font-size:1rem;font-weight:800;color:#7ee787;">${fmtKg(disponible)}kg</div>
        </div>
      </div>
      <div style="overflow-x:auto;-webkit-overflow-scrolling:touch;">
        <table style="width:100%;border-collapse:collapse;min-width:520px;">
          <thead>
            <tr style="border-bottom:2px solid var(--gris3);">
              <td style="padding:7px 8px;font-size:0.64rem;color:var(--suave);text-transform:uppercase;letter-spacing:0.5px;">Fecha</td>
              <td style="padding:7px 8px;font-size:0.64rem;color:var(--suave);text-transform:uppercase;letter-spacing:0.5px;">Pedido</td>
              <td style="padding:7px 8px;font-size:0.64rem;color:var(--suave);text-transform:uppercase;letter-spacing:0.5px;">Cliente</td>
              <td style="padding:7px 8px;font-size:0.64rem;color:var(--suave);text-transform:uppercase;letter-spacing:0.5px;">Sabor / Pres.</td>
              <td style="padding:7px 8px;font-size:0.64rem;color:var(--suave);text-transform:uppercase;letter-spacing:0.5px;text-align:right;">kg</td>
              <td style="padding:7px 8px;font-size:0.64rem;color:var(--suave);text-transform:uppercase;letter-spacing:0.5px;text-align:right;">Saldo</td>
            </tr>
            <tr style="border-bottom:1px solid var(--gris3);">
              <td colspan="5" style="padding:7px 8px;font-size:0.72rem;color:var(--suave);">Lote registrado ${fmtFecha(lote.fecha)} · producción inicial</td>
              <td style="padding:7px 8px;text-align:right;font-weight:800;font-size:0.78rem;color:#7ee787;">${fmtKg(producido)}</td>
            </tr>
          </thead>
          <tbody>${rowsHtml || '<tr><td colspan="6" style="padding:12px 8px;color:var(--suave);font-size:0.8rem;text-align:center;">Sin pedidos que consuman de este lote todavía.</td></tr>'}</tbody>
        </table>
      </div>
      <div style="font-size:0.7rem;margin-top:8px;">${aviso}</div>
      <div style="font-size:0.66rem;color:var(--suave);margin-top:4px;">Nota: muestra el consumo vigente. Los pedidos cancelados ya devolvieron sus kg al lote y no aparecen aquí.</div>
    `;
  } catch(e) {
    cont.innerHTML = '<div style="color:var(--rojo);font-size:0.82rem;">Error al cargar el kárdex: ' + e.message + '</div>';
  }
};

// Resumen de inventario (lote en kg + último conteo físico) — solo lectura, reutilizable
async function renderResumenInventario(elId, incluirLote) {
  const cont = document.getElementById(elId);
  if (!cont) return;
  cont.innerHTML = '<div style="background:var(--gris);border-radius:14px;padding:14px;color:var(--suave);font-size:0.82rem;">Cargando inventario…</div>';
  try {
    const _rl4 = await supabaseCall('POST', 'rpc/obtener_lotes', { p_data: { soloActivos: true, limit: 1 } });
    const arrL = (_rl4 && _rl4.ok) ? _rl4.lotes : [];
    if (!Array.isArray(arrL) || arrL.length === 0) {
      cont.innerHTML = '<div style="background:var(--gris);border-radius:14px;padding:14px;color:var(--suave);font-size:0.82rem;text-align:center;">Sin lote activo</div>';
      return;
    }
    const l = arrL[0];
    const idLote = l.id_lote || ('LOTE-'+l.id);
    const tot = Number(l.kilos_totales)||0, ven = Number(l.kilos_vendidos)||0;
    const disp = (l.kilos_disponibles!=null) ? Number(l.kilos_disponibles) : (tot-ven);
    const pct = tot>0 ? Math.min(100,Math.round((ven/tot)*100)) : 0;
    const colP = pct>80?'var(--rojo)':pct>50?'var(--amarillo)':'#4caf50';

    // Último conteo físico de este lote
    const _rs1 = await supabaseCall('POST', 'rpc/obtener_stock_lote', { p_data: { idLote } });
    const st = (_rs1 && _rs1.ok) ? _rs1.stock : [];
    const msDia = 86400000;
    const PRES = ['100g','250g','500g','1kg'];
    let fisicoHTML, _totG = 0, _dias = null, _hayConteo = false;
    if (Array.isArray(st) && st.length) {
      _hayConteo = true;
      const fechas = st.map(r=>r.fecha).filter(Boolean).sort().reverse();
      const fConteo = fechas.length ? new Date(fechas[0]+'T12:00:00') : null;
      const dias = fConteo ? Math.floor((Date.now()-fConteo.getTime())/msDia) : null;
      let badge = '';
      if (dias!==null) {
        if (dias<=1) badge = `<span style="color:#4caf50;"><span class="dot-est conv"></span>${dias===0?'hoy':'ayer'}</span>`;
        else if (dias<=5) badge = `<span style="color:var(--amarillo);">hace ${dias} días</span>`;
        else badge = `<span style="color:var(--rojo);">hace ${dias} días</span>`;
      }
      const porSabor = {};
      let totG = 0;
      st.forEach(r => {
        if (!porSabor[r.sabor]) porSabor[r.sabor] = {};
        porSabor[r.sabor][r.presentacion] = (porSabor[r.sabor][r.presentacion]||0) + (Number(r.piezas)||0);
        totG += (Number(r.piezas)||0) * (Number(r.gramos_unitarios)||0);
      });
      _totG = totG; _dias = dias;
      const filas = Object.keys(porSabor).map(sab => {
        const celdas = PRES.map(p => {
          const n = porSabor[sab][p]||0;
          return `<span style="flex:1;text-align:center;color:${n>0?'var(--amarillo)':'#444'};font-family:'Archivo',sans-serif;font-size:1rem;">${n}</span>`;
        }).join('');
        return `<div style="display:flex;align-items:center;padding:4px 0;border-bottom:1px solid var(--gris3);"><span style="flex:1.4;font-size:0.76rem;font-weight:700;color:var(--blanco);">${sab}</span>${celdas}</div>`;
      }).join('');
      fisicoHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <span style="font-family:'Archivo',sans-serif;font-size:1rem;color:var(--amarillo);letter-spacing:1px;">STOCK TERMINADO</span>
          <span style="font-size:0.64rem;">${badge}</span>
        </div>
        <div style="display:flex;align-items:center;padding:2px 0;"><span style="flex:1.4;"></span>${PRES.map(p=>`<span style="flex:1;text-align:center;font-size:0.6rem;font-weight:800;color:#555;">${p}</span>`).join('')}</div>
        ${filas}
        <div style="margin-top:8px;font-size:0.72rem;color:#555;text-align:right;">Total embolsado: <strong style="color:var(--amarillo)">${totG>=1000?(totG/1000).toFixed(2)+'kg':totG+'g'}</strong></div>
        <div style="margin-top:6px;font-size:0.62rem;color:#444;font-style:italic;">Para actualizar: pestaña Inv. Físico.</div>`;
    } else {
      fisicoHTML = `
        <div style="font-family:'Archivo',sans-serif; font-weight:700;font-size:1rem;color:var(--amarillo);letter-spacing:1px;margin-bottom:6px;">STOCK TERMINADO</div>
        <div style="color:var(--rojo);font-size:0.8rem;">Sin conteo físico de este lote. Regístralo en Inv. Físico.</div>`;
    }

    const loteHTML = incluirLote ? `
      <div style="background:var(--gris);border-radius:14px;padding:14px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <span style="font-family:'Archivo',sans-serif;font-size:1rem;color:var(--amarillo);letter-spacing:1px;">LOTE ACTIVO</span>
          <span style="font-size:0.7rem;color:#666;">${idLote}</span>
        </div>
        <div style="display:flex;justify-content:space-between;text-align:center;">
          <span style="flex:1;"><span style="display:block;font-family:'Archivo',sans-serif;font-size:1.3rem;color:var(--blanco);">${tot.toFixed(2)}</span><span style="font-size:0.62rem;color:#666;">PRODUCIDO kg</span></span>
          <span style="flex:1;"><span style="display:block;font-family:'Archivo',sans-serif;font-size:1.3rem;color:var(--amarillo);">${ven.toFixed(2)}</span><span style="font-size:0.62rem;color:#666;">VENDIDO kg</span></span>
          <span style="flex:1;"><span style="display:block;font-family:'Archivo',sans-serif;font-size:1.3rem;color:${disp<=0?'var(--rojo)':'#4caf50'};">${disp.toFixed(2)}</span><span style="font-size:0.62rem;color:#666;">DISPONIBLE kg</span></span>
        </div>
        <div style="background:#222;border-radius:6px;height:8px;overflow:hidden;margin-top:8px;"><div style="background:${colP};height:8px;width:${pct}%;"></div></div>
        <div style="font-size:0.66rem;color:#666;margin-top:4px;text-align:right;">${pct}% agotado</div>
      </div>` : '';

    window._invResumenTxt =
      `Inventario (${idLote}): disponible *${disp.toFixed(1)}kg* de ${tot.toFixed(1)}kg (${pct}% agotado)\n` +
      (_hayConteo
        ? `Embolsado: ${_totG>=1000?(_totG/1000).toFixed(1)+'kg':_totG+'g'}${_dias!==null?` (conteo ${_dias<=1?(_dias===0?'hoy':'ayer'):'hace '+_dias+' días'})`:''}\n`
        : `Embolsado: sin conteo de este lote\n`);

    cont.innerHTML = loteHTML + `<div style="background:var(--gris);border-radius:14px;padding:14px;">${fisicoHTML}</div>`;
  } catch(e) {
    cont.innerHTML = '<div style="background:var(--gris);border-radius:14px;padding:14px;color:var(--rojo);font-size:0.82rem;">Error al cargar inventario</div>';
  }
}

// ── RESUMEN DE PRODUCCIÓN (informe): Lote activo + Días de inventario ──
async function cargarResumenProduccion() {
  const cont = document.getElementById('resumen-produccion');
  if (!cont) return;
  cont.innerHTML = '<div style="background:var(--gris);border-radius:14px;padding:14px;color:var(--suave);font-size:0.82rem;">Cargando producción…</div>';
  try {
    const _rl5 = await supabaseCall('POST', 'rpc/obtener_lotes', { p_data: { soloActivos: true, limit: 1 } });
    const arr = (_rl5 && _rl5.ok) ? _rl5.lotes : [];
    if (!Array.isArray(arr) || arr.length === 0) {
      cont.innerHTML = '<div style="background:var(--gris);border-radius:14px;padding:14px;color:var(--suave);font-size:0.82rem;text-align:center;">Sin lote activo</div>';
      return;
    }
    const l        = arr[0];
    const totales  = Number(l.kilos_totales) || 0;
    const vendidos = Number(l.kilos_vendidos) || 0;
    const disp     = (l.kilos_disponibles != null) ? Number(l.kilos_disponibles) : (totales - vendidos);
    const pct      = totales > 0 ? Math.min(100, Math.round((vendidos / totales) * 100)) : 0;
    const colorPct = pct > 80 ? 'var(--rojo)' : pct > 50 ? 'var(--amarillo)' : '#4caf50';

    // Promedio de venta diaria a partir del lote
    const msDia       = 1000 * 60 * 60 * 24;
    const fechaLote   = l.fecha ? new Date(l.fecha + 'T12:00:00') : new Date();
    const diasActivos = Math.max(1, Math.round((Date.now() - fechaLote.getTime()) / msDia) + 1);
    const promDiario  = vendidos / diasActivos;

    // Días restantes + fecha sugerida de próxima producción
    let diasRestTxt, fechaSugTxt, alerta = '';
    if (disp <= 0) {
      diasRestTxt = '0 días'; fechaSugTxt = '¡Produce ya!'; alerta = 'agotado';
    } else if (promDiario <= 0) {
      diasRestTxt = '—'; fechaSugTxt = 'Sin ventas aún';
    } else {
      const diasRest = disp / promDiario;
      diasRestTxt = (diasRest < 1 ? diasRest.toFixed(1) : Math.floor(diasRest)) + ' días';
      const fechaSug = new Date(Date.now() + diasRest * msDia);
      fechaSugTxt = fechaSug.toLocaleDateString('es-MX', { weekday:'short', day:'numeric', month:'short' });
      if (diasRest <= 1.5) alerta = 'pronto';
    }
    const fechaLoteTxt = fechaLote.toLocaleDateString('es-MX', { day:'numeric', month:'short' });

    cont.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr;gap:10px;">
        <div style="background:var(--gris);border-radius:14px;padding:14px;${alerta==='agotado'?'border:1px solid var(--rojo);':''}">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
            <span style="font-family:'Archivo',sans-serif;font-size:1rem;color:var(--amarillo);letter-spacing:1px;">LOTE ACTIVO</span>
            <span style="font-size:0.72rem;color:#666;">${l.id_lote || ('LOTE-'+l.id)} · ${fechaLoteTxt}</span>
          </div>
          <div style="display:flex;justify-content:space-between;gap:8px;text-align:center;margin-bottom:10px;">
            <span style="flex:1;"><span style="display:block;font-family:'Archivo',sans-serif;font-size:1.3rem;color:var(--blanco);">${totales.toFixed(2)}</span><span style="font-size:0.62rem;color:#666;">PRODUCIDO kg</span></span>
            <span style="flex:1;"><span style="display:block;font-family:'Archivo',sans-serif;font-size:1.3rem;color:var(--amarillo);">${vendidos.toFixed(2)}</span><span style="font-size:0.62rem;color:#666;">VENDIDO kg</span></span>
            <span style="flex:1;"><span style="display:block;font-family:'Archivo',sans-serif;font-size:1.3rem;color:${disp<=0?'var(--rojo)':'#4caf50'};">${disp.toFixed(2)}</span><span style="font-size:0.62rem;color:#666;">DISPONIBLE kg</span></span>
          </div>
          <div style="background:#222;border-radius:6px;height:8px;overflow:hidden;"><div style="background:${colorPct};height:8px;width:${pct}%;transition:width .5s;"></div></div>
          <div style="font-size:0.7rem;color:${colorPct};margin-top:4px;text-align:right;">${pct}% agotado</div>
        </div>
        <div style="background:var(--gris);border-radius:14px;padding:14px;${alerta==='pronto'?'border:1px solid var(--amarillo);':alerta==='agotado'?'border:1px solid var(--rojo);':''}">
          <div style="font-family:'Archivo',sans-serif;font-size:1rem;color:var(--amarillo);letter-spacing:1px;margin-bottom:10px;">INVENTARIO RESTANTE</div>
          <div style="display:flex;justify-content:space-between;gap:8px;text-align:center;">
            <span style="flex:1;"><span style="display:block;font-family:'Archivo',sans-serif;font-size:1.4rem;color:var(--blanco);">${promDiario>0?promDiario.toFixed(2):'—'}</span><span style="font-size:0.62rem;color:#666;">PROM. kg/día</span></span>
            <span style="flex:1;"><span style="display:block;font-family:'Archivo',sans-serif;font-size:1.4rem;color:${alerta?'var(--amarillo)':'var(--blanco)'};">${diasRestTxt}</span><span style="font-size:0.62rem;color:#666;">TE ALCANZA</span></span>
            <span style="flex:1;"><span style="display:block;font-family:'Archivo',sans-serif;font-size:0.95rem;color:${alerta?'var(--amarillo)':'#4caf50'};margin-top:6px;">${fechaSugTxt}</span><span style="font-size:0.62rem;color:#666;">PRODUCIR ~</span></span>
          </div>
          <div style="font-size:0.66rem;color:#555;margin-top:8px;font-style:italic;">Estimado con el promedio de venta del lote (${diasActivos} día${diasActivos>1?'s':''}).</div>
        </div>
      </div>`;
  } catch(e) {
    cont.innerHTML = '<div style="background:var(--gris);border-radius:14px;padding:14px;color:var(--rojo);font-size:0.82rem;">Error al cargar producción</div>';
  }
}

async function renderResumen() {
  const cont  = document.getElementById('resumen-cont');
  const stats = document.getElementById('resumen-stats');
  if (!cont) return;
  cont.innerHTML = '<div style="text-align:center;color:var(--suave);padding:30px 0;"><span class="loader loader-w"></span> Cargando resumen...</div>';
  if (stats) stats.innerHTML = '';
  try {
    const _ri = await supabaseCall('POST', 'rpc/obtener_pedidos', { p_data: { limit: 200 } });
    const ordenes = (_ri && _ri.ok && Array.isArray(_ri.pedidos)) ? _ri.pedidos : [];
    if (!Array.isArray(ordenes)) { cont.innerHTML = '<div style="color:var(--rojo);padding:16px;">Error al cargar pedidos</div>'; return; }

    // Piezas y sabores por orden (suma desde ordenes_detalle)
    const ids = ordenes.map(o => o.id).filter(x => x != null);
    const pzasPorOrden = {};
    _resumenSabores = {};
    if (ids.length) {
      try {
        const _rd = await supabaseCall('POST', 'rpc/obtener_detalle_pedidos', { p_data: { ids } });
        const det = (_rd && _rd.ok) ? _rd.detalle : null;
        if (Array.isArray(det)) det.forEach(d => {
          pzasPorOrden[d.id_orden] = (pzasPorOrden[d.id_orden] || 0) + (Number(d.cantidad) || 0);
          const sab = (d.sabor || '—').trim() || '—';
          if (!_resumenSabores[sab]) _resumenSabores[sab] = { pzas: 0, monto: 0 };
          _resumenSabores[sab].pzas  += (Number(d.cantidad) || 0);
          _resumenSabores[sab].monto += (Number(d.subtotal) || 0);
        });
      } catch(e) { /* si falla, pzas/sabores quedan vacíos */ }
    }

    _resumenCache = ordenes.map(o => ({
      id:        o.id,
      consec:    o.consecutivo || ('#' + o.id),
      cliente:   o.nombre_cliente || 'Sin cliente',
      vendedor:  o.nombre_vendedor || '—',
      vendedorId: o.id_vendedor != null ? String(o.id_vendedor) : '',
      monto:     Number(o.total) || 0,
      pzas:      pzasPorOrden[o.id] || 0,
      estatus:   o.estatus_pedido || 'Pendiente',
      pago:      o.estatus_pago || 'Pendiente',
      esInterno: !!o.tipo_interno,
      fecha:     o.fecha_orden,
    }));
    cargarDashboard();
    cargarResumenProduccion();
    renderResumenInventario('resumen-stock', false);
    const _recCard = document.getElementById('recordatorios-card');
    if (_recCard) _recCard.style.display = (typeof esAdmin === 'function' && esAdmin()) ? 'block' : 'none';
    const _kdxCard = document.getElementById('kardex-card');
    if (_kdxCard) {
      const _esAdm = (typeof esAdmin === 'function' && esAdmin());
      _kdxCard.style.display = _esAdm ? 'block' : 'none';
      if (_esAdm) cargarKardexLotes();
    }
    const _regCard = document.getElementById('regalos-card');
    if (_regCard) {
      const _esAdmR = (typeof esAdmin === 'function' && esAdmin());
      _regCard.style.display = _esAdmR ? 'block' : 'none';
      if (_esAdmR) {
        const _hoy = new Date();
        const _mesActual = `${_hoy.getFullYear()}-${String(_hoy.getMonth()+1).padStart(2,'0')}`;
        const _inpMes = document.getElementById('regalos-mes');
        if (_inpMes && !_inpMes.value) _inpMes.value = _mesActual;
        cargarMetricaRegalo(_inpMes?.value || _mesActual);
      }
    }
    const _fBar = document.getElementById('filtro-informe');
    if (_fBar) {
      const _esAdmF = (typeof esAdmin === 'function' && esAdmin());
      _fBar.style.display = _esAdmF ? 'block' : 'none';
      if (_esAdmF) cargarOpcionesFiltro();
    }
    const _embCard = document.getElementById('embudo-card');
    if (_embCard) {
      const _esAdmE = (typeof esAdmin === 'function' && esAdmin());
      _embCard.style.display = _esAdmE ? 'block' : 'none';
      if (_esAdmE) cargarEmbudo(document.getElementById('embudo-dias')?.value || 30);
    }
    pintarResumen();
  } catch(e) {
    cont.innerHTML = '<div style="color:var(--rojo);padding:16px;">Error de conexión: ' + e.message + '</div>';
  }
}

function pintarResumen() {
  const cont  = document.getElementById('resumen-cont');
  const stats = document.getElementById('resumen-stats');
  const q = (document.getElementById('resumen-buscar')?.value || '').toLowerCase().trim();

  const filas = _resumenCache.filter(r =>
    !q || r.cliente.toLowerCase().includes(q) || String(r.consec).toLowerCase().includes(q) || r.vendedor.toLowerCase().includes(q)
  );

  // Stats (sobre lo filtrado, excluyendo cancelados/internos del monto)
  const nPed = filas.length;
  let suma = 0, sumaPzas = 0;
  filas.forEach(r => { if (r.estatus !== 'Cancelado') { sumaPzas += r.pzas; if (!r.esInterno) suma += r.monto; } });
  if (stats) {
    stats.innerHTML =
      `<div class="rs-chip"><div class="v">${nPed}</div><div class="l">Pedidos</div></div>` +
      `<div class="rs-chip"><div class="v">$${suma.toLocaleString('es-MX')}</div><div class="l">Monto</div></div>` +
      `<div class="rs-chip"><div class="v">${sumaPzas}</div><div class="l">Piezas</div></div>`;
  }

  if (!filas.length) {
    cont.innerHTML = '<div style="text-align:center;color:var(--suave);padding:30px 0;font-size:0.88rem;">Sin pedidos que coincidan</div>';
    return;
  }

  const estColor = (est, pago, interno) => {
    if (est === 'Cancelado') return 'background:#3a1515;color:#ff8a8a;';
    if (interno)            return 'background:#2a1f00;color:var(--amarillo);';
    if (pago === 'Pagado')  return 'background:#143a1a;color:#7fe0a0;';
    return 'background:#2a2200;color:#ffd24d;';
  };
  const estLbl = (r) => r.estatus === 'Cancelado' ? 'Cancelado'
    : r.esInterno ? 'Interno'
    : (r.pago === 'Pagado' ? 'Pagado' : 'Pendiente');

  const filasHTML = filas.map(r => `
    <tr onclick="verDetallePedido(${r.id})" style="cursor:pointer;">
      <td style="font-weight:800;color:var(--amarillo);">${r.consec}</td>
      <td>${r.cliente}</td>
      <td style="color:var(--suave);">${r.vendedor}</td>
      <td class="num">${r.esInterno ? '—' : '$' + r.monto.toLocaleString('es-MX')}</td>
      <td class="num">${r.pzas || '—'}</td>
      <td><span class="est" style="${estColor(r.estatus, r.pago, r.esInterno)}">${estLbl(r)}</span></td>
    </tr>`).join('');

  cont.innerHTML = `
    <table class="rt">
      <thead><tr>
        <th>Pedido</th><th>Cliente</th><th>Vendedor</th>
        <th class="num">Monto</th><th class="num">Pzas</th><th>Estatus</th>
      </tr></thead>
      <tbody>${filasHTML}</tbody>
    </table>`;
}

window.filtrarResumen = function() { pintarResumen(); };

window.exportarResumenCSV = function() {
  if (!_resumenCache.length) { if (typeof mostrarToast==='function') mostrarToast('No hay datos para exportar'); return; }
  const q = (document.getElementById('resumen-buscar')?.value || '').toLowerCase().trim();
  const filas = _resumenCache.filter(r =>
    !q || r.cliente.toLowerCase().includes(q) || String(r.consec).toLowerCase().includes(q) || r.vendedor.toLowerCase().includes(q)
  );
  const esc = (v) => '"' + String(v).replace(/"/g, '""') + '"';
  const header = ['Pedido','Cliente','Vendedor','Monto','Piezas','Estatus','Pago','Fecha'];
  const lineas = filas.map(r => [r.consec, r.cliente, r.vendedor, r.esInterno?0:r.monto, r.pzas, r.estatus, r.pago, r.fecha].map(esc).join(','));
  const csv = '\uFEFF' + header.map(esc).join(',') + '\n' + lineas.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'resumen-pedidos-' + fechaCDMX() + '.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

// (renderB2B / filtrarB2B / renderB2BLista — versiones mejoradas al final del archivo)

// Reasignar vendedor de un cliente (admin only, desde dropdown en B2B)
window.reasignarVendedor = async function(idCliente, idVendedor, nombreVendedor) {
  // Si seleccionó "— Sin asignar —", mandar valores vacíos
  const idV = idVendedor ? Number(idVendedor) : null;
  const nomV = (idV && nombreVendedor && !nombreVendedor.includes('Sin asignar')) ? nombreVendedor : '';
  try {
    const res = await supabaseCall('POST', 'rpc/reasignar_vendedor_cliente', {
      p_id_cliente: Number(idCliente),
      p_id_vendedor: idV,
      p_nombre_vendedor: nomV,
      p_token: tokenVendedor(),
    });
    if (!res || !res.ok) { avisar({ titulo: 'No se pudo actualizar la ficha B2B', cuerpo: (res?.error || 'Sin respuesta') }); return; }
    mostrarToast('Vendedor reasignado');
    const cli = _b2bClientes.find(c => String(c.id) === String(idCliente));
    if (cli) {
      cli.idVendedor = idV;
      cli.vendedor   = nomV;
    }
  } catch(e) { avisar({ titulo: 'No se pudo actualizar la ficha B2B', cuerpo: e.message }); }
};

window.aprobarB2B = async function(idCliente, tipo) {
  try {
    // Aprobar = actualizar aprobado_b2b=true (manteniendo el tipo)
    const res = await supabaseCall('POST', 'rpc/aprobar_cliente_b2b', {
      p_id_cliente: Number(idCliente),
      p_aprobar: true,
      p_actor: N.vendedorInfo?.nombre || 'admin',
      p_token: tokenVendedor(),
    });
    if (res && res.ok) {
      mostrarToast('Cliente aprobado');
      const c = _b2bClientes.find(x => x.id == idCliente);
      if (c) c.aprobadoB2B = true;
      renderB2BLista();
    } else {
      avisar({ titulo: 'No se pudo actualizar la ficha B2B', cuerpo: (res?.error || '') });
    }
  } catch(e) { mostrarToast('Error: ' + e.message); }
};

window.rechazarB2B = async function(idCliente) {
  if (!(await confirmar({ titulo: '¿Rechazar la solicitud B2B?', cuerpo: 'El cliente pasa a consumidor.', aceptar: 'Rechazar', peligroso: true }))) return;
  try {
    // Cambiar tipo a Consumidor + des-aprobar
    const res = await supabaseCall('POST', 'rpc/actualizar_tipo_cliente', {
      p_data: {
        idCliente: Number(idCliente),
        tipo: 'Consumidor',
        tipoId: 1,
      }
    });
    if (res && res.ok) {
      // Y aprobado_b2b = false
      await supabaseCall('POST', 'rpc/aprobar_cliente_b2b', {
        p_id_cliente: Number(idCliente), p_aprobar: false, p_actor: N.vendedorInfo?.nombre || 'admin', p_token: tokenVendedor()
      });
      mostrarToast('Cliente movido a consumidor');
      _b2bClientes = _b2bClientes.filter(x => x.id != idCliente);
      renderB2BLista();
    }
  } catch(e) { mostrarToast('Error: ' + e.message); }
};

window.revocarB2B = async function(idCliente) {
  if (!(await confirmar({ titulo: '¿Revocar la aprobación B2B?', cuerpo: 'La tienda deja de ver precios de mayoreo.', aceptar: 'Revocar', peligroso: true }))) return;
  try {
    const res = await supabaseCall('POST', 'rpc/actualizar_tipo_cliente', {
      p_data: {
        idCliente: Number(idCliente),
        tipo: 'Consumidor',
        tipoId: 1,
      }
    });
    if (res && res.ok) {
      await supabaseCall('POST', 'rpc/aprobar_cliente_b2b', {
        p_id_cliente: Number(idCliente), p_aprobar: false, p_actor: N.vendedorInfo?.nombre || 'admin', p_token: tokenVendedor()
      });
      mostrarToast('Aprobación revocada');
      const c = _b2bClientes.find(x => x.id == idCliente);
      if (c) { c.aprobadoB2B = false; c.tipo = 'Consumidor'; }
      renderB2BLista();
    }
  } catch(e) { mostrarToast('Error: ' + e.message); }
};


// ══════════════════════════════════
// EDICIÓN DE LOTES
// ══════════════════════════════════
window.editarLote = async function(idLote, kilosTotales, kilosDisponibles) {
  const nuevosKilos = prompt(
    `Lote ${idLote}\nKilos totales actuales: ${kilosTotales}kg\nKilos disponibles: ${kilosDisponibles}kg\n\n¿Cuántos kilos reales se produjeron?`,
    kilosTotales
  );
  if (!nuevosKilos || isNaN(nuevosKilos)) return;
  const kilos = parseFloat(nuevosKilos);
  if (kilos <= 0) { mostrarToast('Ingresa un valor válido'); return; }

  try {
    // v2.9: PATCH lotes_produccion por id_lote
    const res = await supabaseCall('POST', 'rpc/actualizar_lote', { p_data: { idLote, campos: {
      kilos_totales: kilos
    } } });
    if (!res || !res.ok) { mostrarToast('Error: ' + ((res && res.error) || 'Sin respuesta')); return; }
    mostrarToast(`${idLote} actualizado a ${kilos}kg`);
    renderProduccion();
  } catch(e) { mostrarToast('Error: ' + e.message); }
};

window.editarNotasLote = async function(idLote, notasActuales) {
  const nuevasNotas = prompt(`Comentario para ${idLote}:`, notasActuales || '');
  if (nuevasNotas === null) return;
  try {
    const res = await supabaseCall('POST', 'rpc/actualizar_lote', { p_data: { idLote, campos: {
      notas: nuevasNotas
    } } });
    if (!res || !res.ok) { mostrarToast('Error: ' + ((res && res.error) || 'Sin respuesta')); return; }
    mostrarToast('Comentario guardado');
    renderProduccion();
  } catch(e) { mostrarToast('Error: ' + e.message); }
};

window.cerrarLote = async function(idLote) {
  if (!(await confirmar({ titulo: `¿Cerrar el lote ${idLote}?`, cuerpo: 'Quedará marcado como Agotado.', aceptar: 'Cerrar lote', peligroso: true }))) return;
  try {
    const res = await supabaseCall('POST', 'rpc/actualizar_lote', { p_data: { idLote, campos: {
      estatus: 'Cerrado',
      fecha_cierre: new Date().toISOString(),
    } } });
    if (!res || !res.ok) { mostrarToast('Error: ' + ((res && res.error) || 'Sin respuesta')); return; }
    mostrarToast(`Lote ${idLote} cerrado`);
    renderProduccion();
  } catch(e) { mostrarToast('Error: ' + e.message); }
};


// ══════════════════════════════════
// INVENTARIO FÍSICO DE PIEZAS
// ══════════════════════════════════
const PRESENTACIONES = [
  { id:'100g', gramos:100 },
  { id:'250g', gramos:250 },
  { id:'500g', gramos:500 },
  { id:'1kg',  gramos:1000 },
];
const SABORES_INV = ['Natural','Adobada','Feroz','Habanero','Queso Jalapeño','Queso Cheddar','Crunchy Mix'];

async function cargarLotesEnSelect() {
  try {
    const _rl6 = await supabaseCall('POST', 'rpc/obtener_lotes', { p_data: { soloActivos: true, limit: 500 } });
    const arr = (_rl6 && _rl6.ok) ? _rl6.lotes : [];
    const sel = document.getElementById('inv-lote-select');
    if (!sel || !Array.isArray(arr)) return;
    sel.innerHTML = '<option value="">Selecciona lote...</option>';
    arr.forEach(l => {
      const opt = document.createElement('option');
      opt.value = l.id_lote;
      opt.textContent = `${l.id_lote} · ${(Number(l.kilos_disponibles)||0).toFixed(1)}kg disp.`;
      sel.appendChild(opt);
    });
    sel.onchange = function() { renderGridInventarioFisico(this.value); };
  } catch(e) {}
}

async function renderGridInventarioFisico(idLote) {
  const grid = document.getElementById('inv-fisico-grid');
  if (!grid || !idLote) return;

  grid.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr repeat(4,60px);gap:4px;margin-bottom:4px;">
      <div style="font-size:0.65rem;font-weight:800;color:#555;">SABOR</div>
      ${PRESENTACIONES.map(p=>`<div style="font-size:0.65rem;font-weight:800;color:#555;text-align:center;">${p.id}</div>`).join('')}
    </div>
    ${SABORES_INV.map(sabor => `
      <div style="display:grid;grid-template-columns:1fr repeat(4,60px);gap:4px;align-items:center;padding:4px 0;border-bottom:1px solid var(--gris3);">
        <div style="font-size:0.78rem;font-weight:700;color:var(--blanco);">${sabor}</div>
        ${PRESENTACIONES.map(p => `
          <input type="number" min="0" step="1" value="0"
            id="if-${sabor.replace(/\s/g,'_')}-${p.id}"
            style="background:var(--gris2);border:1px solid var(--gris3);border-radius:6px;padding:4px;color:var(--amarillo);font-family:'Archivo',sans-serif;font-size:1rem;text-align:center;width:100%;outline:none;"
            onfocus="this.style.borderColor='var(--amarillo)'" onblur="this.style.borderColor='var(--gris3)'">
        `).join('')}
      </div>`).join('')}
    <div style="margin-top:8px;font-size:0.72rem;font-weight:700;color:#555;text-align:center;" id="inv-total-display">Total: 0g</div>
  `;

  // Listener para calcular total en tiempo real
  grid.querySelectorAll('input[type=number]').forEach(inp => {
    inp.addEventListener('input', calcularTotalFisico);
  });

  // Cargar conteo previo guardado para este lote (si existe)
  try {
    const _rs2 = await supabaseCall('POST', 'rpc/obtener_stock_lote', { p_data: { idLote } });
    const prev = (_rs2 && _rs2.ok) ? _rs2.stock : [];
    if (Array.isArray(prev) && prev.length) {
      prev.forEach(r => {
        const el = document.getElementById(`if-${String(r.sabor).replace(/\s/g,'_')}-${r.presentacion}`);
        if (el) el.value = r.piezas;
      });
      calcularTotalFisico();
    }
  } catch(e) {}
}

function calcularTotalFisico() {
  let totalG = 0;
  SABORES_INV.forEach(sabor => {
    PRESENTACIONES.forEach(p => {
      const id  = `if-${sabor.replace(/\s/g,'_')}-${p.id}`;
      const val = parseInt(document.getElementById(id)?.value) || 0;
      totalG   += val * p.gramos;
    });
  });
  const el = document.getElementById('inv-total-display');
  if (el) el.textContent = `Total contado: ${totalG >= 1000 ? (totalG/1000).toFixed(2)+'kg' : totalG+'g'}`;
}

window.guardarInventarioFisico = async function() {
  const idLote = document.getElementById('inv-lote-select')?.value;
  if (!idLote) { mostrarToast('Selecciona un lote'); return; }

  const items = [];
  SABORES_INV.forEach(sabor => {
    PRESENTACIONES.forEach(p => {
      const id  = `if-${sabor.replace(/\s/g,'_')}-${p.id}`;
      const piezas = parseInt(document.getElementById(id)?.value) || 0;
      if (piezas > 0) {
        items.push({
          id_lote: idLote,
          sabor,
          presentacion: p.id,
          piezas,
          gramos_unitarios: p.gramos,
          registrado_por: (typeof N.vendedorInfo !== 'undefined' && N.vendedorInfo?.nombre) ? N.vendedorInfo.nombre : 'Producción',
        });
      }
    });
  });

  if (!items.length) { mostrarToast('Ingresa al menos una pieza'); return; }

  try {
    // Snapshot: reemplaza el conteo previo por el actual. Antes eran DELETE y
    // POST en dos llamadas: si la segunda fallaba, el lote se quedaba SIN
    // stock porque el borrado ya había ocurrido. El RPC lo hace en una sola
    // transacción.
    const res = await supabaseCall('POST', 'rpc/reemplazar_stock_lote', {
      p_data: { idLote, items }
    });
    if (!res || !res.ok) {
      mostrarToast('No se guardó: ' + (res?.message || res?.hint || 'verifica que exista la tabla stock_terminado'));
      return;
    }
    // Verificación: releer de la BD para confirmar que sí quedó guardado.
    // Se relee de verdad en vez de creerle al contador que devuelve el RPC:
    // la pregunta que responde esta comprobación es "¿está en la base?", y esa
    // solo la contesta una lectura.
    const _rs3 = await supabaseCall('POST', 'rpc/obtener_stock_lote', { p_data: { idLote } });
    const check = (_rs3 && _rs3.ok && Array.isArray(_rs3.stock)) ? _rs3.stock : null;
    const n = Array.isArray(check) ? check.length : (res.insertados || 0);
    if (n > 0) {
      mostrarToast(`Guardado en stock_terminado: ${n} línea${n!==1?'s':''}`);
    } else {
      mostrarToast('No se guardó nada (0 filas). Revisa permisos/RLS de stock_terminado.');
    }
  } catch(e) {
    mostrarToast('Error al guardar: ' + e.message);
  }
};

window.elegirModoCliente = function(modo) {
  N._modoCliente = modo;

  // Resaltar botón seleccionado
  ['existente','nuevo'].forEach(m => {
    const btn = document.getElementById('btn-cliente-' + m);
    if (!btn) return;
    const activo = m === modo;
    btn.style.borderColor = activo ? 'var(--amarillo)' : 'var(--gris3)';
    btn.style.color       = activo ? 'var(--amarillo)' : 'var(--suave)';
    btn.style.background  = activo ? '#2a1f00' : 'var(--gris)';
  });

  const buscarEl = document.getElementById('paso-buscar-cliente');

  if (modo === 'existente') {
    // Mostrar buscador
    buscarEl.style.display = 'block';
    document.getElementById('buscar-cliente-input').focus();
    // Bloquear campos hasta seleccionar
    bloquearCamposCliente(true);
  } else {
    // Nuevo cliente — limpiar y habilitar campos
    buscarEl.style.display = 'none';
    limpiarCamposCliente();
    bloquearCamposCliente(false);
    document.getElementById('btn-editar-cliente-wrap').style.display = 'none';
    document.getElementById('f-nombre').focus();
  }
};

window.habilitarEdicionCliente = function() {
  bloquearCamposCliente(false);
  document.getElementById('btn-editar-cliente-wrap').style.display = 'none';
  mostrarToast('Campos habilitados para editar');
};

function limpiarCamposCliente() {
  ['f-nombre','f-tel-cliente','f-cp','f-dir','f-negocio','f-rfc'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const sel = document.getElementById('f-colonia');
  if (sel) sel.innerHTML = '<option value="">Colonia *</option>';
  N.clienteActual = null;
}


// ══════════════════════════════════
// BUSCADOR DE CLIENTES (vendedor en visita)
// ══════════════════════════════════
let _buscarTimer = null;
let _clientesBuscados = [];

window.buscarCliente = async function(q) {
  const resultados = document.getElementById('resultados-cliente');

  // v2.7.1: si el usuario borra el texto Y había cliente seleccionado, limpiar todo
  if ((!q || q.length === 0) && N.clienteActual) {
    if (await confirmar({ titulo: '¿Quitar el cliente seleccionado?', cuerpo: 'Se limpia el formulario.', aceptar: 'Quitar' })) {
      limpiarBusqueda();
    } else {
      // Restaurar el nombre en el buscador para que no se pierda el contexto
      document.getElementById('buscar-cliente-input').value = N.clienteActual.nombre;
    }
    return;
  }

  if (!q || q.length < 2) { resultados.innerHTML = ''; return; }

  clearTimeout(_buscarTimer);
  _buscarTimer = setTimeout(async () => {
    resultados.innerHTML = '<div style="color:var(--suave);font-size:0.78rem;padding:6px;">Buscando...</div>';
    try {
      // Etapa B: antes esto era `clientes?or=(...)&select=*` directo a la tabla,
      // que cualquiera con la llave anon podía repetir para cosechar el padrón.
      // Ahora va por RPC con sesión: el servidor acota a los clientes del
      // vendedor (o a todos, si es admin).
      const resB = await supabaseCall('POST', 'rpc/buscar_clientes', {
        p_data: { token: tokenVendedor(), q }
      });
      if (sesionExpirada(resB)) {
        resultados.innerHTML = '<div style="color:var(--rojo);font-size:0.78rem;padding:6px;">Tu sesión expiró. Vuelve a entrar.</div>';
        return;
      }
      const arr = (resB && resB.ok) ? resB.clientes : null;
      if (!Array.isArray(arr) || arr.length === 0) {
        resultados.innerHTML = '<div style="color:#555;font-size:0.78rem;padding:6px;">Sin resultados — registra como nuevo cliente</div>';
        return;
      }
      // Mapear a formato esperado por el frontend
      _clientesBuscados = arr.map(c => ({
        id: c.id,
        nombre: c.nombre,
        telefono: c.telefono,
        tipo: c.tipo || 'Consumidor',
        direccion: c.direccion || '',
        cp: c.cp || '',
        colonia: c.colonia || '',
        municipio: c.municipio || '',
        estado: c.estado || '',
        coordenadas: c.coordenadas || '',
      }));
      const res = { ok: true, clientes: _clientesBuscados };
      resultados.innerHTML = res.clientes.map((c, i) => `
        <div onclick="seleccionarCliente(${i})" style="
          background:var(--gris2);border:1px solid var(--gris3);border-radius:8px;
          padding:10px 12px;margin-bottom:6px;cursor:pointer;transition:border-color 0.2s;
        " onmouseover="this.style.borderColor='var(--amarillo)'" onmouseout="this.style.borderColor='var(--gris3)'">
          <div style="font-weight:800;font-size:0.85rem;color:var(--blanco);">${c.nombre}</div>
          <div style="font-size:0.72rem;color:var(--suave);margin-top:2px;">
            ${c.telefono} · ${c.tipo} · ${c.colonia||''} ${c.municipio||''}
          </div>
        </div>`).join('');
    } catch(e) {
      resultados.innerHTML = '<div style="color:var(--rojo);font-size:0.78rem;padding:6px;">Error al buscar</div>';
    }
  }, 500);
};

window.seleccionarCliente = function(idx) {
  const c = _clientesBuscados[idx];
  if (!c) return;

  // Validar que el canal elegido coincida con el tipo de cliente
  const tipoC = (c.tipo || '').toLowerCase();
  const esTienda = tipoC.includes('tienda') || tipoC.includes('abarrotes');
  const esRest   = tipoC.includes('restaurante');
  const esMayorista = tipoC.includes('mayorista') || tipoC.includes('distribuidor');
  const canalCorrecto = esMayorista ? 'mayorista' : (esTienda ? 'tienda' : (esRest ? 'restaurante' : 'consumidor'));

  let alertaCanal = null;
  if (N.canalVenta !== canalCorrecto) {
    const lblCanal = { mayorista:'Mayorista', tienda:'Tienda', restaurante:'Restaurante', consumidor:'Consumidor' }[canalCorrecto];
    alertaCanal = {
      msg: `Este cliente está registrado como "${c.tipo}". Cambiando a precios de ${lblCanal}.`,
      canal: canalCorrecto
    };
  }

  if (alertaCanal) {
    // Vaciar carrito y cambiar canal
    const totalItems = Object.keys(N.carrito).length;
    const msg = alertaCanal.msg + (totalItems > 0
      ? '\n\nSe vaciará el carrito para recalcular los precios correctos.'
      : '');
    avisar({ titulo: 'Cambio de canal', cuerpo: msg });
    // Vaciar carrito
    N.carrito = {};
    actualizarBadge();
    // Cambiar canal
    setCanalVenta(alertaCanal.canal);
    // Cerrar drawer para que el vendedor agregue productos con el precio correcto
    cerrarCarrito();
    return;
  }

  // Pre-llenar TODOS los campos incluyendo teléfono
  document.getElementById('f-nombre').value     = c.nombre || '';
  document.getElementById('f-tel-cliente').value = String(c.telefono || '').replace(/\D/g,'').slice(-10);
  if (c.negocio) document.getElementById('f-negocio').value = c.negocio;

  if (c.cp) {
    document.getElementById('f-cp').value = String(c.cp).padStart(5,'0');
    buscarCP(c.cp);
    seleccionarColoniaCuandoCargue(c.colonia, () => {
      if (c.direccion) document.getElementById('f-dir').value = c.direccion;
      if (typeof actualizarChecklistFaltantes === 'function') actualizarChecklistFaltantes();
    });
  }

  N.clienteActual = c;

  // v2.7.1: vaciar el input del buscador (queda en el chip)
  document.getElementById('buscar-cliente-input').value = '';

  // Bloquear campos y mostrar botón editar
  bloquearCamposCliente(true);
  document.getElementById('btn-editar-cliente-wrap').style.display = 'block';

  // Confirmar selección con botón para cambiar
  document.getElementById('resultados-cliente').innerHTML =
    `<div style="background:#0d2d0d;border-radius:8px;padding:8px 12px;font-size:0.78rem;font-weight:700;color:#4caf50;display:flex;justify-content:space-between;align-items:center;gap:8px;">
      <div style="flex:1;min-width:0;">
        <div>${c.nombre}</div>
        <div style="color:#888;font-size:0.7rem;font-weight:500;margin-top:2px;">${c.telefono}</div>
      </div>
      <button onclick="limpiarBusqueda()" style="background:transparent;border:1px solid #4caf50;color:#4caf50;border-radius:6px;padding:4px 10px;font-weight:800;font-size:0.7rem;cursor:pointer;">✕ Cambiar</button>
    </div>`;

  mostrarToast('Cliente cargado ✓');
};

window.limpiarBusqueda = function() {
  document.getElementById('buscar-cliente-input').value = '';
  document.getElementById('resultados-cliente').innerHTML = '';
  document.getElementById('f-nombre').value = '';
  document.getElementById('f-tel-cliente').value = '';
  if (document.getElementById('f-negocio')) document.getElementById('f-negocio').value = '';
  document.getElementById('f-cp').value = '';
  document.getElementById('f-dir').value = '';
  document.getElementById('f-colonia').innerHTML = '<option value="">Colonia *</option>';
  // Desbloquear campos
  bloquearCamposCliente(false);
  // Ocultar botón editar
  const btnEd = document.getElementById('btn-editar-cliente-wrap');
  if (btnEd) btnEd.style.display = 'none';
  N.clienteActual = null;
  // Limpiar marca de pedido interno también
  window._pedidoInterno = null;
};

// ══════════════════════════════════════════════════════════════════
// PEDIDOS INTERNOS — selector de tipo (se invoca desde el carrito)
// ══════════════════════════════════════════════════════════════════
const TIPOS_INTERNOS = [
  { id:'sampling', label:'Sampling',         desc:'Muestras a clientes nuevos / prospectos' },
  { id:'consumo',  label:'Consumo Interno',  desc:'Consumo del equipo / oficina' },
  { id:'demo',     label:'Demo',              desc:'Activación, evento, demostración' },
  { id:'regalo',   label:'Regalo',           desc:'Cortesía, obsequio a aliados' },
  { id:'bonificacion', label:'Bonificación',  desc:'Producto extra / compensación a un cliente' },
  { id:'merma',    label:'Merma',            desc:'Producto defectuoso / no vendible' },
];

// Setear tipo interno (lo invoca el selector inline en el drawer del carrito)
window.setTipoInterno = function(tipoId) {
  const valido = TIPOS_INTERNOS.some(t => t.id === tipoId);
  if (!valido) return;
  window._pedidoInterno = window._pedidoInterno || {};
  window._pedidoInterno.tipo = tipoId;
  // Re-render del drawer para refrescar selección
  if (typeof renderDrawer === 'function') renderDrawer();
  const t = TIPOS_INTERNOS.find(x => x.id === tipoId);
  mostrarToast('Motivo: ' + (t?.label || tipoId));
};


// ══════════════════════════════════════════════════════════════════
// PEDIDOS DEL VENDEDOR — vista alterna en la sección "Pedidos"
// ══════════════════════════════════════════════════════════════════
let _pedidosVendedorCache = [];
let _resumenVendedorCache = null;

async function renderPedidosVendedor() {
  const lista = document.getElementById('pedidos-lista');
  lista.innerHTML = '<div style="text-align:center;color:var(--suave);padding:40px 0;font-size:0.9rem;"><span class="loader loader-w"></span> Cargando tus pedidos...</div>';

  if (!N.vendedorInfo?.id) {
    lista.innerHTML = '<div style="text-align:center;color:var(--rojo);padding:20px;">Vendedor no identificado</div>';
    return;
  }

  try {
    // v2.8: pedidos del vendedor + cliente desde Supabase
    // Admin ve todos los pedidos, vendedor solo los suyos
    // Etapa B: el alcance lo impone el SERVIDOR a partir del token — admin ve
    // todos, vendedor solo los suyos. Antes lo decidía este archivo, y bastaba
    // con borrar un `if` en DevTools para verlos todos.
    const _rl = await supabaseCall('POST', 'rpc/obtener_pedidos', { p_data: { limit: 200 } });
    const arr = (_rl && _rl.ok) ? _rl.pedidos : null;
    if (!Array.isArray(arr)) {
      lista.innerHTML = '<div style="text-align:center;color:var(--rojo);padding:20px;">Error: respuesta inválida</div>';
      return;
    }

    // Mapear a formato frontend
    const pedidos = arr.map(o => ({
      id:             o.id,
      consecutivo:    o.consecutivo,
      consec:         o.consecutivo,        // alias legacy
      idCliente:      o.id_cliente,
      nombreCliente:  o.nombre_cliente,
      cliente:        o.nombre_cliente,     // alias legacy
      telefono:       o.telefono || o.telefono_cliente || '',
      idVendedor:     o.id_vendedor,
      nombreVendedor: o.nombre_vendedor,
      vendedor:       o.nombre_vendedor,    // alias legacy
      canal:          o.canal,
      fecha:          o.fecha_orden,
      fechaEntrega:   o.fecha_entrega,
      fechaEntregaReal: o.fecha_entrega_real,
      tipoPago:       o.tipo_pago,
      tipoPagoId:     o.tipo_pago_id,
      estatusPedido:  o.estatus_pedido,
      estatus:        o.estatus_pedido,     // alias legacy
      estatusPago:    o.estatus_pago,
      subtotal:       Number(o.subtotal) || 0,
      descuento:      Number(o.descuento) || 0,
      total:          Number(o.total) || 0,
      notas:          o.notas || '',
      cuponCodigo:    o.cupon_codigo || '',
      tipoInterno:    o.tipo_interno || '',
      esInterno:      !!o.tipo_interno,     // helper booleano legacy
      cp:             o.cp,
      colonia:        o.colonia,
      municipio:      o.municipio,
      estado:         o.estado,
      direccion:      o.direccion,
    }));

    // Calcular resumen mensual (mes actual)
    const ahora = new Date();
    const mesAct = ahora.getMonth();
    const anioAct = ahora.getFullYear();
    let ventasMes = 0, ventasMesPagadas = 0, ventasMesPendientes = 0;
    let pedidosMes = 0;
    pedidos.forEach(p => {
      const f = new Date(p.fecha);
      if (f.getMonth() !== mesAct || f.getFullYear() !== anioAct) return;
      if (p.estatusPedido === 'Cancelado') return;
      if (p.tipoInterno) { pedidosMes++; return; } // internos cuentan en # no en $
      pedidosMes++;
      const neto = (Number(p.subtotal) || 0) - (Number(p.descuento) || 0); // ingreso neto, sin envío (19 sep 2026)
      ventasMes += neto;
      if (p.estatusPago === 'Pagado') ventasMesPagadas += neto;
      else ventasMesPendientes += neto;
    });

    // Cuota (por ahora 0 — la calcularemos cuando migremos vendedores)
    const cuotaMes = 0;

    const resumen = {
      ventasMes,
      ventasMesPagadas,
      ventasMesPendientes,
      pedidosMes,
      cuotaMes,
      pctCuota: cuotaMes > 0 ? Math.round((ventasMesPagadas / cuotaMes) * 100) : 0,
      pctCuotaPagada: cuotaMes > 0 ? Math.round((ventasMesPagadas / cuotaMes) * 100) : 0,
      pctCuotaPendiente: cuotaMes > 0 ? Math.round((ventasMesPendientes / cuotaMes) * 100) : 0,
    };

    _pedidosVendedorCache = pedidos;
    _resumenVendedorCache = resumen;
    pintarVistaPedidosVendedor();
  } catch(e) {
    lista.innerHTML = '<div style="text-align:center;color:var(--rojo);padding:20px;">Error de conexión: ' + e.message + '</div>';
  }
}

function pintarVistaPedidosVendedor() {
  const lista   = document.getElementById('pedidos-lista');
  const pedidos = _pedidosVendedorCache;
  const r       = _resumenVendedorCache || {};

  const mesAhora = new Date().toLocaleDateString('es-MX', { month:'long', year:'numeric' });

  // Bloque resumen + cuota
  const cuotaSet = (r.cuotaMes||0) > 0;
  const ventas    = r.ventasMes          || 0;
  const pagado    = r.ventasMesPagadas    || 0;
  const pendiente = r.ventasMesPendientes || 0;
  const pct       = Math.min(100, r.pctCuota || 0);
  const pctPag    = Math.min(100, r.pctCuotaPagada    || 0);
  const pctPen    = Math.min(100 - pctPag, r.pctCuotaPendiente || 0); // no se desborda visualmente
  const colorPag  = (pct >= 100) ? 'over' : 'pagado';
  const esAdminUser = esAdmin();

  // Desglose pagado/pendiente — siempre visible si hay ventas en el mes
  const desgloseHTML = ventas > 0 ? `
    <div style="display:flex;gap:10px;margin-top:8px;font-size:0.75rem;font-weight:700;">
      <div style="flex:1;display:flex;align-items:center;gap:6px;">
        <span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:#4caf50;flex-shrink:0;"></span>
        <span style="color:var(--suave);">Cobrado</span>
        <span style="color:#4caf50;margin-left:auto;">$${pagado.toLocaleString('es-MX')}</span>
      </div>
      <div style="flex:1;display:flex;align-items:center;gap:6px;">
        <span style="display:inline-block;width:10px;height:10px;border-radius:3px;background-image:repeating-linear-gradient(45deg,rgba(255,210,0,0.9) 0,rgba(255,210,0,0.9) 2px,rgba(255,210,0,0.3) 2px,rgba(255,210,0,0.3) 4px);flex-shrink:0;"></span>
        <span style="color:var(--suave);">Por cobrar</span>
        <span style="color:var(--amarillo);margin-left:auto;">$${pendiente.toLocaleString('es-MX')}</span>
      </div>
    </div>
  ` : '';

  const resumenHTML = `
    <div class="vend-resumen">
      <div class="vend-resumen-h">
        <div class="titulo">Mi mes</div>
        <div class="mes">${mesAhora}</div>
      </div>
      ${cuotaSet ? `
        <div style="display:flex;justify-content:space-between;align-items:baseline;">
          <div style="font-family:'Archivo',sans-serif;font-size:1.8rem;color:var(--blanco);line-height:1;">$${ventas.toLocaleString('es-MX')}</div>
          <div style="font-size:0.78rem;font-weight:700;color:var(--suave);">de $${(r.cuotaMes||0).toLocaleString('es-MX')} (${pct}%)</div>
        </div>
        <div class="vend-cuota-bar">
          <div class="vend-cuota-fill ${colorPag}" style="width:${pctPag}%;"></div>
          <div class="vend-cuota-fill pendiente"  style="width:${pctPen}%;"></div>
        </div>
        <div class="vend-cuota-labels">
          <span>0%</span>
          <span>Meta</span>
        </div>
        ${desgloseHTML}
      ` : `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">
          <div>
            <div style="font-family:'Archivo',sans-serif;font-size:1.8rem;color:var(--blanco);line-height:1;">$${ventas.toLocaleString('es-MX')}</div>
            <div style="font-size:0.7rem;font-weight:700;color:var(--suave);text-transform:uppercase;margin-top:2px;">Ingreso neto del mes</div>
          </div>
          ${esAdminUser ? `
          <button onclick="abrirSetCuota()" style="background:transparent;border:1px solid var(--amarillo);border-radius:8px;padding:7px 12px;font-family:'Inter',sans-serif;font-weight:700;font-size:0.74rem;color:var(--amarillo);cursor:pointer;white-space:nowrap;">
            Fijar cuota
          </button>` : ''}
        </div>
        ${desgloseHTML}
      `}
      <div class="vend-stats-grid">
        <div class="vend-stat">
          <div class="v">${r.totalPedidos||0}</div>
          <div class="l">Pedidos totales</div>
        </div>
        <div class="vend-stat">
          <div class="v" style="color:${(r.pendientesEntrega||0)>0?'var(--amarillo)':'#4caf50'}">${r.pendientesEntrega||0}</div>
          <div class="l">Por entregar</div>
        </div>
        <div class="vend-stat">
          <div class="v" style="color:${(r.pendientesCobro||0)>0?'var(--amarillo)':'#4caf50'}">${r.pendientesCobro||0}</div>
          <div class="l">Por cobrar</div>
        </div>
      </div>
      ${(r.kgInternosMes||0) > 0 ? `
        <div style="margin-top:10px;background:rgba(255,210,0,0.06);border:1px dashed rgba(255,210,0,0.3);border-radius:10px;padding:10px;">
          <div style="display:flex;justify-content:space-between;align-items:baseline;">
            <div style="font-size:0.7rem;font-weight:800;color:var(--suave);text-transform:uppercase;letter-spacing:1px;">Volumen interno este mes</div>
            <div style="font-family:'Archivo',sans-serif;font-size:1.3rem;color:var(--amarillo);line-height:1;">${(r.kgInternosMes||0).toFixed(2)} kg</div>
          </div>
          ${r.kgInternosPorTipo ? `
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;font-size:0.7rem;color:var(--suave);font-weight:700;">
              ${Object.entries(r.kgInternosPorTipo)
                .filter(([_,kg]) => kg > 0)
                .map(([tipo, kg]) => {
                  const lbl = {sampling:'Sampling',consumo:'Consumo',demo:'Demo',regalo:'Regalo',merma:'Merma'}[tipo] || tipo;
                  return `<span style="background:var(--gris2);padding:3px 8px;border-radius:50px;">${lbl}: ${kg.toFixed(2)}kg</span>`;
                }).join('')}
            </div>
          ` : ''}
        </div>
      ` : ''}
    </div>
  `;

  // Aplicar filtro
  const filtro = window._filtroPedidos || 'todos';
  const filtrados = pedidos.filter(p => {
    if (filtro === 'nuevos')   return (p.estatus === 'Pendiente' || !p.estatus) && p.estatus !== 'Cancelado' && !p.esInterno;
    if (filtro === 'entregar') return p.estatus !== 'Entregado' && p.estatus !== 'Cancelado';
    if (filtro === 'cobrar')   return p.estatusPago !== 'Pagado' && p.estatus !== 'Cancelado' && !p.esInterno;
    if (filtro === 'internos') return !!p.esInterno;
    if (filtro === 'cancelados') return p.estatus === 'Cancelado';
    return true;
  });

  // Conteos para el desplegable
  const cTodos    = pedidos.length;
  const cNuevos   = pedidos.filter(p => (p.estatus === 'Pendiente' || !p.estatus) && p.estatus !== 'Cancelado' && !p.esInterno).length;
  const cEntregar = pedidos.filter(p => p.estatus !== 'Entregado' && p.estatus !== 'Cancelado').length;
  const cCobrar   = pedidos.filter(p => p.estatusPago !== 'Pagado' && p.estatus !== 'Cancelado' && !p.esInterno).length;
  const cInternos = pedidos.filter(p => !!p.esInterno).length;
  const cCancel   = pedidos.filter(p => p.estatus === 'Cancelado').length;

  const opcion = (id, lbl, n) => `
    <option value="${id}"${filtro === id ? ' selected' : ''}>${lbl} (${n})</option>`;

  // Desplegable en vez de chips: con seis filtros los chips se partían en dos
  // renglones en el teléfono. "Internos" y "Cancelados" solo se ofrecen si hay
  // alguno, igual que hacía el chip de internos.
  const filtrosHTML = pedidos.length > 0 ? `
    <div style="margin:0 0 12px;">
      <select class="inp" aria-label="Filtrar pedidos" style="width:100%;"
              onchange="filtrarPedidosVendedor(this.value)">
        ${opcion('todos',    'Todos',        cTodos)}
        ${opcion('nuevos',   'Nuevos',       cNuevos)}
        ${opcion('entregar', 'Por entregar', cEntregar)}
        ${opcion('cobrar',   'Por cobrar',   cCobrar)}
        ${cInternos > 0 ? opcion('internos',   'Internos',   cInternos) : ''}
        ${cCancel   > 0 ? opcion('cancelados', 'Cancelados', cCancel)   : ''}
      </select>
    </div>
  ` : '';

  // Lista de pedidos
  let listaHTML = '';
  if (!pedidos.length) {
    listaHTML = `<div style="text-align:center;color:var(--suave);padding:30px 0;font-size:0.88rem;">
      <span style="font-size:2rem;display:block;margin-bottom:8px;" class="ico-solo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg></span>
      Aún no has registrado pedidos
    </div>`;
  } else if (!filtrados.length) {
    listaHTML = filtrosHTML + `<div style="text-align:center;color:var(--suave);padding:30px 0;font-size:0.88rem;">
      <span style="font-size:2rem;display:block;margin-bottom:8px;" class="ico-solo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/></svg></span>
      ${filtro==='entregar' ? 'No tienes pedidos pendientes por entregar' :
        filtro==='cobrar'   ? 'No tienes pedidos pendientes por cobrar' :
        filtro==='nuevos'   ? 'Sin pedidos nuevos por confirmar' :
        filtro==='internos' ? 'Sin pedidos internos' :
        filtro==='cancelados' ? 'Sin pedidos cancelados' :
                              'Sin pedidos'}
    </div>`;
  } else {
    listaHTML = filtrosHTML + `
      <div style="font-family:'Archivo',sans-serif;font-size:1rem;color:var(--amarillo);letter-spacing:1px;margin:6px 0 10px;">
        ${filtro==='todos'    ? 'PEDIDOS RECIENTES' :
             filtro==='nuevos'   ? 'NUEVOS — POR CONFIRMAR' :
             filtro==='entregar' ? 'POR ENTREGAR' :
             filtro==='cobrar'   ? 'POR COBRAR' :
             filtro==='internos' ? 'INTERNOS / SAMPLING' :
             filtro==='cancelados' ? 'PEDIDOS CANCELADOS' :
                                   'PEDIDOS'} (${filtrados.length})
      </div>
      ${filtrados.map(p => pedidoCardVendedorHTML(p)).join('')}
    `;
  }

  lista.innerHTML = resumenHTML + listaHTML;
}

// Cambiar filtro y re-pintar (sin round-trip al backend)
window.filtrarPedidosVendedor = function(filtro) {
  window._filtroPedidos = filtro;
  pintarVistaPedidosVendedor();
};

// Confirmar pedido al cliente por WhatsApp (envío manual: abre WhatsApp con el mensaje listo)
window.confirmarPedidoWpp = async function(idOrden) {
  const ventana = abrirVentanaPendiente();
  const p = (_pedidosVendedorCache || []).find(x => x.id === idOrden);
  if (!p) { if (typeof mostrarToast==='function') mostrarToast('Pedido no encontrado'); cerrarVentanaPendiente(ventana); return; }
  let tel = String(p.telefono || '').replace(/\D/g, '');
  // Respaldo: si el pedido no trae teléfono, buscarlo en el cliente
  if (!tel && p.idCliente) {
    try {
      // Etapa B: por RPC con sesión. Antes era `clientes?id=eq.N&select=telefono`,
      // que se podía recorrer en bucle para cosechar la agenda completa.
      const c = await supabaseCall('POST', 'rpc/obtener_telefono_cliente', {
        p_data: { token: tokenVendedor(), idCliente: p.idCliente }
      });
      if (c && c.ok && c.telefono) tel = String(c.telefono).replace(/\D/g, '');
    } catch(e) {}
  }
  if (!tel) { if (typeof mostrarToast==='function') mostrarToast('Este pedido no tiene teléfono registrado'); cerrarVentanaPendiente(ventana); return; }
  if (tel.length === 10) tel = '52' + tel; // lada México si viene a 10 dígitos
  const primerNombre = (p.cliente || '').trim().split(' ')[0];
  const saludo = primerNombre ? `¡Hola ${primerNombre}!` : '¡Hola!';
  const msg =
    `${saludo} Te saluda *Crunchy Paps*.\n\n` +
    `Confirmamos que recibimos tu pedido *${p.consec || ''}* y ya lo estamos preparando.\n\n` +
    `Cualquier duda, por aquí estamos para ayudarte. ¡Gracias por tu compra!`;
  irAWhatsApp(ventana, `https://wa.me/${tel}?text=${encodeURIComponent(msg)}`);
};

window.enviarResumenPedidoWpp = async function(idOrden) {
  const ventana = abrirVentanaPendiente();
  const p = (_pedidosVendedorCache || []).find(x => x.id === idOrden);
  if (!p) { if (typeof mostrarToast==='function') mostrarToast('Pedido no encontrado'); cerrarVentanaPendiente(ventana); return; }
  let tel = String(p.telefono || '').replace(/\D/g, '');
  if (!tel && p.idCliente) {
    try {
      // Etapa B: por RPC con sesión. Antes era `clientes?id=eq.N&select=telefono`,
      // que se podía recorrer en bucle para cosechar la agenda completa.
      const c = await supabaseCall('POST', 'rpc/obtener_telefono_cliente', {
        p_data: { token: tokenVendedor(), idCliente: p.idCliente }
      });
      if (c && c.ok && c.telefono) tel = String(c.telefono).replace(/\D/g, '');
    } catch(e) {}
  }
  if (!tel) { if (typeof mostrarToast==='function') mostrarToast('Este pedido no tiene teléfono registrado'); cerrarVentanaPendiente(ventana); return; }
  if (tel.length === 10) tel = '52' + tel;

  // Traer el detalle del pedido (sabores/presentaciones)
  let lineas = [];
  try {
    const _rd = await supabaseCall('POST', 'rpc/obtener_detalle_pedidos', { p_data: { ids: [idOrden] } });
    const det = (_rd && _rd.ok) ? _rd.detalle : null;
    if (Array.isArray(det)) lineas = det;
  } catch(e) {}

  const primerNombre = (p.cliente || '').trim().split(' ')[0];
  const saludo = primerNombre ? `¡Hola ${primerNombre}!` : '¡Hola!';
  let cuerpo = '';
  lineas.forEach(l => {
    const cant = l.cantidad ? `${cantidadConCajas(l)} ` : '';
    const pres = l.presentacion ? ` ${l.presentacion}` : '';
    const sub = (l.subtotal != null) ? ` — $${Number(l.subtotal).toLocaleString('es-MX')}` : '';
    cuerpo += `• ${cant}${l.sabor || 'Producto'}${pres}${sub}\n`;
  });
  if (!cuerpo) cuerpo = '• (Ver detalle con tu vendedor)\n';

  const totalTxt = `$${Number(p.total || 0).toLocaleString('es-MX')}`;
  const pagoTxt = p.estatusPago === 'Pagado' ? 'Pagado' : 'Pendiente de pago';
  const link = `https://crunchypaps.mx/?track=${encodeURIComponent(p.consec || '')}`;

  const msg =
    `${saludo} Aquí está el resumen de tu pedido *${p.consec || ''}* en *Crunchy Paps*:\n\n` +
    `${cuerpo}\n` +
    `*Total: ${totalTxt}*\n` +
    `Pago: ${pagoTxt}\n\n` +
    `Puedes dar seguimiento aquí: ${link}\n\n` +
    `¡Gracias por tu compra!`;

  irAWhatsApp(ventana, `https://wa.me/${tel}?text=${encodeURIComponent(msg)}`);
};

function pedidoCardVendedorHTML(p) {
  const fecha = p.fecha ? new Date(p.fecha).toLocaleDateString('es-MX',{day:'numeric',month:'short'}) : '—';
  const hora  = p.fecha ? new Date(p.fecha).toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit'}) : '';
  const canalLbl = p.canal === 'mostrador' ? 'Mostrador' :
                   p.canal === 'vendedor'  ? 'Visita' :
                   p.canal === 'web'       ? 'Web' :
                   p.canal === 'interno'   ? 'Interno' : (p.canal || '');

  const estClass = p.estatus === 'Entregado' ? 'entregado' :
                   p.estatus === 'Cancelado' ? 'cancelado' : '';
  const pagoClass = p.estatusPago === 'Pagado' ? 'pagado' : 'pendiente-pago';

  // Etiqueta de tipo interno (sampling, consumo, etc.)
  const tiposInternosMap = {
    sampling:'Sampling', consumo:'Consumo', demo:'Demo',
    regalo:'Regalo', merma:'Merma'
  };
  const tipoInternoLbl = (p.esInterno && p.tipoInterno && tiposInternosMap[p.tipoInterno])
    ? tiposInternosMap[p.tipoInterno]
    : (p.esInterno ? 'Interno' : null);

  // Cuando es interno, mostrar "Sin cargo" en vez de $0
  const totalDisplay = p.esInterno
    ? `<span style="font-size:0.78rem;font-weight:800;color:var(--amarillo);">Sin cargo</span>`
    : `$${(p.total||0).toLocaleString('es-MX')}`;

  return `<div class="pedido-card clickable ${p.esInterno?'pedido-interno':''}" onclick="verDetallePedido(${p.id})"
    ${p.esInterno?'style="border-left:3px solid rgba(255,210,0,0.6);"':''}>
    <div class="pedido-top">
      <span class="pedido-consec">${p.consec||'—'}</span>
      <span class="pedido-total">${totalDisplay}</span>
    </div>
    <div class="pedido-cliente">${p.cliente||'Sin cliente'}</div>
    <div class="pedido-fecha">
      <span class="pedido-canal">${canalLbl}</span>
      ${fecha} · ${hora}
    </div>
    <div class="estatus-row">
      <span class="pedido-estatus ${estClass}">${p.estatus||'Pendiente'}</span>
      ${p.esInterno
        ? `<span class="pedido-estatus" style="background:#2a1f00;color:var(--amarillo);">${tipoInternoLbl||'Interno'}</span>`
        : `<span class="pedido-estatus ${pagoClass}">${p.estatusPago==='Pagado'?'Pagado':''+p.estatusPago}</span>`}
    </div>
    ${(!p.esInterno && p.estatus !== 'Cancelado')
      ? `<button class="btn-confirm-wpp" onclick="event.stopPropagation(); confirmarPedidoWpp(${p.id})">Confirmar al cliente</button>
         <button class="btn-confirm-wpp" style="background:var(--gris2);color:var(--blanco);border:1px solid var(--gris3);margin-top:6px;" onclick="event.stopPropagation(); enviarResumenPedidoWpp(${p.id})">Reenviar resumen</button>
         <button class="btn-confirm-wpp" style="background:var(--gris2);color:var(--blanco);border:1px solid var(--gris3);margin-top:6px;" onclick="event.stopPropagation(); imprimirTicketPedido(${p.id})">Ticket</button>`
      : ''}
    ${(typeof esAdminEstricto === 'function' && esAdminEstricto() && p.estatus !== 'Cancelado')
      ? `<button class="btn-confirm-wpp" style="background:var(--gris2);color:var(--amarillo);border:1px solid var(--gris3);margin-top:6px;" onclick="event.stopPropagation(); abrirReasignarLote(${p.id}, '${p.consecutivo||''}')">Lote del pedido</button>
         <div id="reasignar-lote-${p.id}" style="display:none;margin-top:8px;" onclick="event.stopPropagation();"></div>`
      : ''}
  </div>`;
}

// ══════════════════════════════════════════════════════════════════
// REASIGNAR LOTE DE UN PEDIDO (admin) — cura de sobregiros y ventas
// físicas desde lotes que el motor no eligió (siempre toma el más nuevo)
// ══════════════════════════════════════════════════════════════════
window.abrirReasignarLote = async function(idOrden, consecutivo) {
  const cont = document.getElementById('reasignar-lote-' + idOrden);
  if (!cont) return;
  if (cont.style.display === 'block') { cont.style.display = 'none'; return; }  // toggle
  cont.style.display = 'block';
  cont.innerHTML = '<div style="font-size:0.76rem;color:var(--suave);">Cargando lotes…</div>';
  try {
    const [detalle, lotes] = await Promise.all([
      supabaseCall('POST', 'rpc/obtener_detalle_pedidos', { p_data: { ids: [idOrden] } })
        .then(r => (r && r.ok) ? r.detalle : []),
      supabaseCall('POST', 'rpc/obtener_lotes', { p_data: { limit: 12 } })
        .then(r => (r && r.ok) ? r.lotes : []),
    ]);
    const lineas = (detalle || []).filter(d => Number(d.kg_descontado_lote) > 0);
    if (!lineas.length) {
      cont.innerHTML = '<div style="font-size:0.76rem;color:var(--suave);">Este pedido no tiene kg descontados de lote (¿bebidas o aún Pendiente?). Nada que reasignar.</div>';
      return;
    }
    const kgTotal = lineas.reduce((s, d) => s + Number(d.kg_descontado_lote), 0);
    const loteActual = lineas[0].id_lote_descontado || '—';
    const mezclado = lineas.some(d => d.id_lote_descontado !== loteActual);
    const ops = (lotes || []).map(l => {
      const disp = Number(l.kilos_disponibles).toFixed(2);
      const sel = (!mezclado && l.id_lote === loteActual) ? ' selected' : '';
      return `<option value="${l.id_lote}"${sel}>${l.id_lote} · ${disp}kg disp · ${l.estatus}</option>`;
    }).join('');
    cont.innerHTML = `
      <div style="background:var(--gris);border:1px solid var(--gris3);border-radius:10px;padding:10px;">
        <div style="font-size:0.74rem;color:var(--suave);margin-bottom:6px;">Lote actual: <strong style="color:var(--blanco);">${mezclado ? 'varios' : loteActual}</strong> · ${kgTotal.toFixed(2)} kg en ${lineas.length} línea(s)</div>
        <select id="sel-lote-${idOrden}" class="inp" style="width:100%;margin-bottom:8px;">${ops}</select>
        <button class="btn-confirm-wpp" style="margin-top:0;" onclick="guardarReasignacionLote(${idOrden}, '${consecutivo}')">Guardar reasignación</button>
      </div>`;
  } catch(e) {
    cont.innerHTML = `<div style="font-size:0.76rem;color:#ff8a8a;">Error al cargar: ${e.message}</div>`;
  }
};

window.guardarReasignacionLote = async function(idOrden, consecutivo) {
  const sel = document.getElementById('sel-lote-' + idOrden);
  const idLote = sel ? sel.value : '';
  if (!idLote) return;
  if (!(await confirmar({ titulo: 'Mover el pedido de lote', cuerpo: `TODOS los kg del pedido ${consecutivo || idOrden} pasan al lote ${idLote}.` + N.SALTO + 'Los kilos vendidos de ambos lotes se recalculan.', aceptar: 'Mover', peligroso: true }))) return;
  try {
    const r = await supabaseCall('POST', 'rpc/reasignar_lote_pedido', { p_id_orden: idOrden, p_id_lote: idLote, p_token: tokenVendedor() });
    if (r && r.ok) {
      mostrarToast(`${r.lineas} línea(s) · ${Number(r.kg).toFixed(2)} kg → ${idLote}`);
      const cont = document.getElementById('reasignar-lote-' + idOrden);
      if (cont) cont.style.display = 'none';
    } else {
      avisar({ titulo: 'No se pudo reasignar el lote', cuerpo: (r && r.error) || 'error desconocido' });
    }
  } catch(e) { avisar({ titulo: 'No se pudo reasignar el lote', cuerpo: e.message }); }
};

// ══════════════════════════════════════════════════════════════════
// FIJAR CUOTA (admins)
// ══════════════════════════════════════════════════════════════════
window.abrirSetCuota = async function() {
  const ahora = new Date();
  const cuotaActual = _resumenVendedorCache?.cuotaMes || 0;
  const nueva = prompt(
    `Fijar cuota mensual para ${N.vendedorInfo?.nombre||'este vendedor'}\n` +
    `Mes: ${ahora.toLocaleDateString('es-MX',{month:'long',year:'numeric'})}\n` +
    `Cuota actual: $${cuotaActual.toLocaleString('es-MX')}\n\n` +
    `Ingresa la nueva meta de ventas (en pesos):`,
    cuotaActual || ''
  );
  if (nueva === null || nueva === '') return;
  const cuota = Number(String(nueva).replace(/\D/g,''));
  if (isNaN(cuota) || cuota < 0) { mostrarToast('Cantidad inválida'); return; }

  try {
    const res = await supabaseCall('POST', 'rpc/set_cuota_vendedor', {
      p_data: {
        idVendedor: N.vendedorInfo.id,
        mes: ahora.getMonth() + 1,
        anio: ahora.getFullYear(),
        cuota,
      }
    });
    if (res && res.ok) {
      mostrarToast('Cuota actualizada');
      renderPedidosVendedor(); // refrescar
    } else {
      avisar({ titulo: 'No se pudo guardar la cuota', cuerpo: (res?.error || 'Sin respuesta') });
    }
  } catch(e) { avisar({ titulo: 'No se pudo guardar la cuota', cuerpo: e.message }); }
};

function pintarDetallePedido({ orden, lineas }) {
  const consec = orden.consecutivo || '—';
  document.getElementById('dp-titulo').textContent = consec;

  const fecha = orden.fecha_orden ? new Date(orden.fecha_orden) : null;
  const fechaStr = fecha ? fecha.toLocaleDateString('es-MX',{weekday:'long',day:'numeric',month:'long',year:'numeric'}) : '—';
  const horaStr  = fecha ? fecha.toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit'}) : '';

  const fEntrega = orden.fecha_entrega ? new Date(orden.fecha_entrega).toLocaleDateString('es-MX',{weekday:'long',day:'numeric',month:'long'}) : '—';

  // ¿Es pedido interno?
  const esInterno = orden.canal === 'interno' || Number(orden.id_cliente) === 999999;
  const tipoInterno = orden.tipo_interno || '';
  const tiposInternosLbl = {
    sampling:'Sampling',
    consumo: 'Consumo interno',
    demo:    'Demo / Activación',
    regalo:  'Regalo / Cortesía',
    merma:   'Merma',
  };
  // Suma de gramos del pedido para banner interno
  let gramosTotalPedido = 0;
  (lineas||[]).forEach(l => { gramosTotalPedido += Number(l.gramos)||0; });

  // ¿Puede modificar el estatus?
  // Política: vendedores → solo sus pedidos. Admins → cualquier pedido.
  const idVendOrden = String(orden.id_vendedor || '').trim();
  const idVendUsr   = String(N.vendedorInfo?.id || '').trim();
  const puedeEditar = N.esVendedor && (esAdmin() || (idVendOrden && idVendOrden === idVendUsr));

  // Estatus actuales
  const estPedido = orden.estatus_pedido || 'Pendiente';
  const estPago   = orden.estatus_pago   || 'Pendiente';
  const cancelado = estPedido === 'Cancelado';

  // Líneas del pedido
  const lineasHTML = (lineas||[]).map(l => {
    const sub = (l.subtotal || 0).toLocaleString('es-MX');
    const cantStr = l.tipo_venta === 'A granel'
      ? `${(l.gramos/1000).toFixed(3)}kg`
      : cantidadConCajas(l);
    const pesoLinea = (Number(l.gramos)||0) / 1000;
    return `
      <div style="display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid var(--gris3);font-size:0.86rem;">
        <div style="flex:1;">
          <div style="font-weight:800;color:var(--blanco);">${cantStr} ${l.sabor||''}</div>
          <div style="font-size:0.74rem;color:var(--suave);">${l.presentacion||''}${esInterno ? '' : ` · $${(l.precio_unitario||0).toLocaleString('es-MX')} c/u`}</div>
          ${l.notas ? `<div style="font-size:0.7rem;color:#888;font-style:italic;">${l.notas}</div>` : ''}
        </div>
        <div style="font-family:'Archivo',sans-serif;font-size:1.1rem;color:var(--amarillo);white-space:nowrap;">
          ${esInterno ? `${pesoLinea.toFixed(3)} kg` : `$${sub}`}
        </div>
      </div>
    `;
  }).join('');

  // Acciones de estatus — selector segmentado: el vendedor puede cambiar a cualquier estatus
  const optsPedido = ['Pendiente','En proceso','En camino','Entregado','Cancelado'];
  const optsPago   = ['Pendiente','Pagado'];

  const segPedidoHTML = puedeEditar ? `
    <div style="margin-top:14px;">
      <div style="font-size:0.66rem;font-weight:800;color:#555;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Estatus del pedido</div>
      <div style="display:flex;gap:4px;background:var(--gris2);border-radius:10px;padding:3px;">
        ${optsPedido.map(opt => {
          const sel = opt === estPedido;
          const colorOk = opt === 'Entregado';
          const colorBad = opt === 'Cancelado';
          return `<button onclick="marcarEstatus(${orden.id},'estatusPedido','${opt}')" style="
            flex:1;border:none;border-radius:8px;
            padding:8px 4px;font-family:'Inter',sans-serif;font-weight:800;
            font-size:0.7rem;cursor:pointer;
            background:${sel ? (colorOk?'#0d2d0d':colorBad?'#2d0d0d':'var(--amarillo)') : 'transparent'};
            color:${sel ? (colorOk?'#4caf50':colorBad?'var(--rojo)':'var(--negro)') : 'var(--suave)'};
            ${sel && !colorOk && !colorBad ? '' : ''}">
            ${opt}
          </button>`;
        }).join('')}
      </div>
      ${orden.fecha_entrega_real ? `<div style="font-size:0.7rem;color:#666;margin-top:4px;">Entregado el ${new Date(orden.fecha_entrega_real).toLocaleDateString('es-MX',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</div>` : ''}
    </div>
  ` : '';

  // Reparto P1: quién reparte (consumidores) y evidencia de la entrega.
  const esTiendaPedido = String(orden.canal || '').toLowerCase() === 'b2b';
  const vendsRep = window._vendedoresReparto || [];
  const nombreRep = orden.id_repartidor ? ((vendsRep.find(v => String(v.id) === String(orden.id_repartidor)) || {}).nombre || ('vendedor ' + orden.id_repartidor)) : (orden.nombre_vendedor || 'el vendedor del pedido');
  const reparteHTML = (!esTiendaPedido && N.esVendedor) ? `
    <div style="margin-top:12px;font-size:0.8rem;color:var(--suave);display:flex;gap:8px;align-items:center;">
      <span>Reparte:</span>
      ${esAdmin() ? `<select onchange="asignarRepartidor(${orden.id}, this)" aria-label="Quién reparte" style="flex:1;min-height:40px;background:var(--gris2);border:1px solid var(--gris3);border-radius:8px;color:var(--blanco);padding:0 8px;">
          <option value="">${rutaEsc(orden.nombre_vendedor || 'el vendedor del pedido')}</option>
          ${vendsRep.map(v => `<option value="${v.id}" ${String(orden.id_repartidor || '') === String(v.id) ? 'selected' : ''}>${rutaEsc(v.nombre || '')}</option>`).join('')}
        </select>` : `<b style="color:var(--blanco);">${rutaEsc(nombreRep)}</b>`}
    </div>
    ${orden.entrega_distancia_m != null ? `<div style="font-size:0.74rem;margin-top:4px;color:${orden.entrega_fuera_del_punto ? 'var(--rojo)' : '#666'};">${orden.entrega_fuera_del_punto ? 'Entregado fuera del punto, a ' : 'Entregado a '}${orden.entrega_distancia_m} m</div>` : ''}
  ` : '';

  const segPagoHTML = puedeEditar ? `
    <div style="margin-top:10px;">
      <div style="font-size:0.66rem;font-weight:800;color:#555;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Estatus del pago</div>
      <div style="display:flex;gap:4px;background:var(--gris2);border-radius:10px;padding:3px;">
        ${optsPago.map(opt => {
          const sel = opt === estPago;
          const colorOk = opt === 'Pagado';
          return `<button onclick="marcarEstatus(${orden.id},'estatusPago','${opt}')" style="
            flex:1;border:none;border-radius:8px;
            padding:9px;font-family:'Inter',sans-serif;font-weight:800;
            font-size:0.78rem;cursor:pointer;
            background:${sel ? (colorOk?'#0d2d0d':'#2a1f00') : 'transparent'};
            color:${sel ? (colorOk?'#4caf50':'var(--amarillo)') : 'var(--suave)'};">
            ${opt}
          </button>`;
        }).join('')}
      </div>
      ${orden.fecha_pago ? `<div style="font-size:0.7rem;color:#666;margin-top:4px;">Pagado el ${new Date(orden.fecha_pago).toLocaleDateString('es-MX',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</div>` : ''}
    </div>
  ` : '';

  // Editar pedido (20 sep 2026): el botón solo si el servidor dijo `editable`; si no, el motivo, nunca silencio.
  const motivoTxt = (N.MOTIVO_EDICION.vendedor || {})[orden.motivo] || '';
  const editarHTML = !puedeEditar || orden.editable === undefined ? '' : orden.editable ? `
    <div style="margin-top:12px;">
      <button type="button" onclick="editarPedidoDesdeDrawer()" style="width:100%;min-height:44px;background:var(--gris2);border:1px solid var(--amarillo);border-radius:10px;color:var(--amarillo);font-family:'Inter',sans-serif;font-weight:800;font-size:0.84rem;cursor:pointer;">Editar pedido</button>
      ${motivoTxt ? `<div style="font-size:0.72rem;color:var(--amarillo);margin-top:4px;">${motivoTxt}</div>` : ''}
      ${orden.editado_en ? `<div style="font-size:0.7rem;color:#666;margin-top:4px;">Editado el ${new Date(orden.editado_en).toLocaleDateString('es-MX',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}${orden.editado_por ? ' por ' + rutaEsc(orden.editado_por) : ''}</div>` : ''}
    </div>` : `
    <div style="margin-top:12px;font-size:0.76rem;color:var(--suave);">${motivoTxt || 'Este pedido no se puede editar'}</div>`;

  const accionesHTML = editarHTML + segPedidoHTML + reparteHTML + segPagoHTML;

  // Construcción final
  document.getElementById('dp-contenido').innerHTML = `
    <!-- Header con estatus -->
    <div style="background:var(--gris2);border-radius:12px;padding:12px;margin-bottom:12px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <div>
          <div style="font-family:'Archivo',sans-serif;font-size:1.4rem;color:var(--amarillo);">${consec}</div>
          <div style="font-size:0.75rem;color:var(--suave);font-weight:600;text-transform:capitalize;">${fechaStr} · ${horaStr}</div>
        </div>
        <div style="text-align:right;">
          ${esInterno
            ? `<div style="font-family:'Archivo',sans-serif;font-size:1.4rem;color:var(--amarillo);line-height:1;">SIN CARGO</div>
               <div style="font-size:0.7rem;color:var(--suave);">${(gramosTotalPedido/1000).toFixed(2)} kg de producto</div>`
            : `<div style="font-family:'Archivo',sans-serif;font-size:1.6rem;color:var(--blanco);line-height:1;">$${(orden.total||0).toLocaleString('es-MX')}</div>
               <div style="font-size:0.7rem;color:var(--suave);">${orden.tipo_pago||''}</div>`}
        </div>
      </div>
      <div class="estatus-row">
        <span class="pedido-estatus ${estPedido==='Entregado'?'entregado':(cancelado?'cancelado':'')}">${estPedido}</span>
        ${esInterno
          ? `<span class="pedido-estatus" style="background:#2a1f00;color:var(--amarillo);">${tiposInternosLbl[tipoInterno] || 'Interno'}</span>`
          : `<span class="pedido-estatus ${estPago==='Pagado'?'pagado':'pendiente-pago'}">${estPago}</span>`}
      </div>
    </div>

    ${esInterno ? `
      <!-- Banner: pedido interno -->
      <div style="background:linear-gradient(135deg,#2a1f00,#1a1200);border:1px dashed rgba(255,210,0,0.4);border-radius:12px;padding:12px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;gap:10px;">
        <div>
          <div style="font-size:0.7rem;font-weight:800;color:var(--amarillo);text-transform:uppercase;letter-spacing:1px;">Pedido interno</div>
          <div style="font-size:0.78rem;color:var(--suave);font-weight:600;margin-top:2px;">${tiposInternosLbl[tipoInterno] || tipoInterno || 'Sin tipo'} · No genera ingreso</div>
        </div>
        <div style="text-align:right;">
          <div style="font-family:'Archivo',sans-serif;font-size:1.4rem;color:var(--amarillo);line-height:1;">${(gramosTotalPedido/1000).toFixed(2)}</div>
          <div style="font-size:0.65rem;color:var(--suave);font-weight:700;text-transform:uppercase;">kg del lote</div>
        </div>
      </div>
    ` : ''}

    <!-- Cliente -->
    <div style="background:var(--gris2);border-radius:12px;padding:12px;margin-bottom:12px;">
      <div style="font-size:0.66rem;font-weight:800;color:#555;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Cliente</div>
      <div style="font-weight:800;color:var(--blanco);font-size:0.92rem;">${orden.nombre_cliente||'—'}</div>
      ${orden.direccion ? `<div style="font-size:0.78rem;color:var(--suave);margin-top:3px;">${orden.direccion}</div>` : ''}
      ${(orden.colonia||orden.municipio) ? `<div style="font-size:0.74rem;color:var(--suave);">${orden.colonia||''} ${orden.municipio||''} ${orden.codigo_postal||''}</div>` : ''}
    </div>

    <!-- Fechas (editables si puedeEditar) -->
    <div style="background:var(--gris2);border-radius:12px;padding:12px;margin-bottom:12px;">
      <div style="font-size:0.66rem;font-weight:800;color:#555;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Fechas</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div>
          <label style="display:block;font-size:0.7rem;font-weight:700;color:var(--suave);margin-bottom:4px;">Entrega programada</label>
          ${puedeEditar ? `
            <input type="date" id="dp-fecha-prog"
              value="${fechaParaInput(orden.fecha_entrega)}"
              onchange="actualizarFechaPedido(${orden.id}, 'fechaEntrega', this.value)"
              style="width:100%;background:var(--gris3);border:1px solid #444;border-radius:8px;padding:8px;color:var(--blanco);font-family:'Inter',sans-serif;font-size:0.8rem;font-weight:600;">
          ` : `
            <div style="font-size:0.84rem;color:var(--blanco);font-weight:700;">${fEntrega}</div>
          `}
        </div>
        <div>
          <label style="display:block;font-size:0.7rem;font-weight:700;color:var(--suave);margin-bottom:4px;">Entrega real</label>
          ${puedeEditar ? `
            <input type="date" id="dp-fecha-real"
              value="${fechaParaInput(orden.fecha_entrega_real)}"
              onchange="actualizarFechaPedido(${orden.id}, 'fechaEntregaReal', this.value)"
              style="width:100%;background:var(--gris3);border:1px solid #444;border-radius:8px;padding:8px;color:var(--blanco);font-family:'Inter',sans-serif;font-size:0.8rem;font-weight:600;">
          ` : `
            <div style="font-size:0.84rem;color:var(--blanco);font-weight:700;">${orden.fecha_entrega_real ? new Date(orden.fecha_entrega_real).toLocaleDateString('es-MX',{day:'numeric',month:'short',year:'numeric'}) : '—'}</div>
          `}
        </div>
      </div>
      <div style="font-size:0.65rem;color:#666;margin-top:6px;">
        Pedido creado: ${fechaStr} ${horaStr}
      </div>
    </div>

    <!-- Productos -->
    <div style="background:var(--gris2);border-radius:12px;padding:12px;margin-bottom:12px;">
      <div style="font-size:0.66rem;font-weight:800;color:#555;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Productos (${(lineas||[]).length})</div>
      ${lineasHTML || '<div style="color:var(--suave);font-size:0.8rem;padding:6px 0;">Sin productos</div>'}
      ${(!esInterno && Number(orden.descuento) > 0) ? `
        <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:0.82rem;color:var(--suave);border-top:1px solid var(--gris3);margin-top:8px;">
          <span>Subtotal</span>
          <span>$${(Number(orden.subtotal) || (Number(orden.total)+Number(orden.descuento))).toLocaleString('es-MX')}</span>
        </div>
        <div style="display:flex;justify-content:space-between;padding:3px 0;font-size:0.82rem;color:#4caf50;font-weight:700;">
          <span>Cupón ${orden.cupon_codigo || ''}</span>
          <span>-$${Number(orden.descuento).toLocaleString('es-MX')}</span>
        </div>
      ` : ''}
      <div style="display:flex;justify-content:space-between;padding:10px 0 4px;border-top:2px solid var(--amarillo);margin-top:8px;">
        <span style="font-weight:800;color:var(--blanco);">${esInterno ? 'Total kg' : 'Total'}</span>
        <span style="font-family:'Archivo',sans-serif;font-size:1.4rem;color:var(--amarillo);">
          ${esInterno
            ? `${(gramosTotalPedido/1000).toFixed(3)} kg`
            : `$${(orden.total||0).toLocaleString('es-MX')}`}
        </span>
      </div>
    </div>

    ${orden.notas ? `
      <div style="background:var(--gris2);border-radius:12px;padding:12px;margin-bottom:12px;">
        <div style="font-size:0.66rem;font-weight:800;color:#555;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Notas</div>
        <div style="font-size:0.84rem;color:var(--blanco);">${orden.notas}</div>
      </div>` : ''}

    ${accionesHTML}

    <!-- Imprimir / Tracking / cerrar -->
    <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;">
      <button onclick="imprimirTicket()" style="flex:1;min-width:130px;background:var(--amarillo);border:none;border-radius:10px;padding:12px;font-family:'Inter',sans-serif;font-weight:900;font-size:0.88rem;color:var(--negro);cursor:pointer;">
        Imprimir
      </button>
      <button onclick="cerrarDetallePedido();abrirTracking('${orden.consecutivo}')" style="flex:1;min-width:130px;background:transparent;border:1px solid var(--amarillo);border-radius:10px;padding:12px;font-family:'Inter',sans-serif;font-weight:800;font-size:0.84rem;color:var(--amarillo);cursor:pointer;">
        Seguimiento
      </button>
      <button onclick="cerrarDetallePedido()" style="background:transparent;border:1px solid #333;border-radius:10px;padding:12px 16px;font-family:'Inter',sans-serif;font-weight:700;font-size:0.85rem;color:var(--suave);cursor:pointer;">
        Cerrar
      </button>
    </div>
  `;
}

// Marcar estatus (selector segmentado: cualquier valor)
// Helper: convierte Date / string a 'yyyy-mm-dd' para <input type="date">
function fechaParaInput(val) {
  if (!val) return '';
  try {
    const d = new Date(val);
    if (isNaN(d.getTime())) return '';
    // Usar fecha local, no UTC (evita off-by-one con timezone México)
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const dd = String(d.getDate()).padStart(2,'0');
    return `${yyyy}-${mm}-${dd}`;
  } catch(e) { return ''; }
}

// Actualizar fecha de entrega programada o real
window.actualizarFechaPedido = async function(idOrden, campo, valor) {
  // Mapear campos camelCase → snake_case
  const colMap = {
    fechaEntrega: 'fecha_entrega',
    fechaEntregaReal: 'fecha_entrega_real',
  };
  const colSql = colMap[campo];
  if (!colSql) { mostrarToast('Campo de fecha no válido'); return; }

  // valor viene como 'yyyy-mm-dd'; convertir a ISO timestamp para Postgres
  const patch = {};
  patch[colSql] = valor ? new Date(valor + 'T12:00:00').toISOString() : null;
  patch['actualizado_por'] = N.vendedorInfo?.nombre || 'Vendedor';

  try {
    // Etapa B: por RPC con sesión. El RPC acepta id o consecutivo, y solo deja
    // tocar columnas de una lista blanca — `total` no está en ella.
    const res = await supabaseCall('POST', 'rpc/actualizar_campos_pedido', {
      p_data: { idOrden: String(idOrden), campos: patch }
    });
    if (!res || !res.ok) { avisar({ titulo: 'No se pudo cambiar la fecha del pedido', cuerpo: ((res && res.error) || 'Sin respuesta') }); return; }
    mostrarToast('Fecha actualizada');

    if (N._pedidoActual) {
      const fechaObj = valor ? new Date(valor + 'T12:00:00') : null;
      if (campo === 'fechaEntrega')     N._pedidoActual.orden.fecha_entrega      = fechaObj;
      if (campo === 'fechaEntregaReal') N._pedidoActual.orden.fecha_entrega_real = fechaObj;
    }
  } catch(e) { avisar({ titulo: 'No se pudo cambiar la fecha del pedido', cuerpo: e.message }); }
};

// Helper: pregunta método de pago con modal simple
// metodoActual: si se pasa, lo marca como pre-seleccionado (vendedor puede confirmar o cambiar)
function preguntarMetodoPago(metodoActual) {
  return new Promise((resolve) => {
    const opciones = [
      { id: 'Efectivo',      ico: '', label: 'Efectivo' },
      { id: 'Transferencia', ico: '', label: 'Transferencia bancaria' },
      { id: 'Tarjeta',       ico: '', label: 'Tarjeta' },
    ];

    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;animation:fadeIn 0.15s;';
    wrap.innerHTML = `
      <div style="background:var(--gris);border:1px solid var(--gris3);border-radius:14px;padding:18px;max-width:340px;width:100%;">
        <div style="font-family:'Archivo',sans-serif;font-size:1.3rem;color:var(--amarillo);letter-spacing:1px;margin-bottom:4px;">¿CÓMO TE PAGARON?</div>
        <div style="color:var(--suave);font-size:0.78rem;margin-bottom:14px;">Confirma el método de pago real para registrar el cobro.</div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${opciones.map(o => {
            const activo = metodoActual === o.id;
            return `<button data-met="${o.id}" style="background:${activo?'#2a1f00':'var(--gris2)'};border:2px solid ${activo?'var(--amarillo)':'var(--gris3)'};border-radius:10px;padding:14px;color:var(--blanco);font-size:0.95rem;text-align:left;cursor:pointer;display:flex;align-items:center;gap:10px;font-weight:${activo?'800':'500'};">
              <span style="font-size:1.2rem;">${o.ico}</span>
              <span style="flex:1;">${o.label}</span>
              ${activo ? '<span style="color:var(--amarillo);font-size:0.7rem;font-weight:800;">SUGERIDO</span>' : ''}
            </button>`;
          }).join('')}
          <button data-met="" style="background:transparent;border:none;color:var(--suave);font-size:0.84rem;margin-top:6px;cursor:pointer;padding:8px;">Cancelar</button>
        </div>
      </div>
    `;
    document.body.appendChild(wrap);
    wrap.querySelectorAll('button[data-met]').forEach(btn => {
      btn.addEventListener('click', () => {
        const met = btn.dataset.met;
        document.body.removeChild(wrap);
        resolve(met || null);
      });
    });
  });
}

window.marcarEstatus = async function(idOrden, campo, valor) {
  // Confirmar solo cuando se cancela un pedido
  if (valor === 'Cancelado' && !(await confirmar({ titulo: '¿Cancelar este pedido?', cuerpo: 'Si ya estaba confirmado, los kg descontados se DEVOLVERÁN al inventario del lote.', aceptar: 'Cancelar pedido', cancelar: 'No, volver', peligroso: true }))) return;

  // SIEMPRE preguntar método de pago al marcar como Pagado
  // (incluso si ya hay uno definido — el vendedor confirma o lo cambia)
  let metodoSeleccionado = null;
  if (campo === 'estatusPago' && valor === 'Pagado') {
    const ordenLocal = N._pedidoActual?.orden;
    const tipoPagoActual = ordenLocal?.tipo_pago || '';
    metodoSeleccionado = await preguntarMetodoPago(tipoPagoActual);
    if (!metodoSeleccionado) return; // canceló
  }

  try {
    // Si hay método nuevo, primero corregirlo
    if (metodoSeleccionado) {
      // Actualizar tipo_pago en el pedido (Etapa B: por RPC, no PATCH directo)
      const metodoId = metodoSeleccionado === 'Efectivo' ? 1
                     : metodoSeleccionado === 'Transferencia' ? 2
                     : metodoSeleccionado === 'Tarjeta' ? 3 : 0;
      // Etapa B: por RPC con sesión (antes era PATCH directo a `ordenes`).
      await supabaseCall('POST', 'rpc/actualizar_campos_pedido', {
        p_data: {
          idOrden: String(idOrden),
          campos: { tipo_pago: metodoSeleccionado, tipo_pago_id: metodoId }
        }
      });
    }

    // Llamar a la función RPC actualizar_estatus_pedido
    const data = {
      idOrden: String(idOrden),
      actualizadoPor: N.vendedorInfo?.nombre || 'Vendedor',
    };
    if (campo === 'estatusPedido') data.estatusPedido = valor;
    if (campo === 'estatusPago')   data.estatusPago = valor;

    const res = await supabaseCall('POST', 'rpc/actualizar_estatus_pedido', { p_data: data });
    if (!res || !res.ok) { avisar({ titulo: 'No se pudo cambiar el estatus del pedido', cuerpo: (res?.error || 'Sin respuesta') }); return; }
    mostrarToast('' + (campo === 'estatusPago' ? 'Pago' : 'Estatus') + ': ' + valor);

    // Actualizar localmente
    if (N._pedidoActual) {
      if (metodoSeleccionado) {
        N._pedidoActual.orden.tipo_pago = metodoSeleccionado;
      }
      if (campo === 'estatusPedido') {
        N._pedidoActual.orden.estatus_pedido = valor;
        if (valor === 'Entregado') N._pedidoActual.orden.fecha_entrega_real = new Date();
        else N._pedidoActual.orden.fecha_entrega_real = null;
      }
      if (campo === 'estatusPago') {
        N._pedidoActual.orden.estatus_pago = valor;
        if (valor === 'Pagado') N._pedidoActual.orden.fecha_pago = new Date();
        else N._pedidoActual.orden.fecha_pago = null;
      }
      pintarDetallePedido(N._pedidoActual);
    }

    // Refrescar lista en background si aplica
    if (N.esVendedor && document.getElementById('s-pedidos').classList.contains('active')) {
      renderPedidosVendedor();
    }
  } catch(e) { avisar({ titulo: 'No se pudo cambiar el estatus del pedido', cuerpo: e.message }); }
};

// ══════════════════════════════════════════════════════════════════
// IMPRIMIR TICKET (HTML imprimible con window.print) — v2.7 estilo Pastorcitos
// ══════════════════════════════════════════════════════════════════
function _numerosALetras(num) {
  // Convierte número a letras en español. Soporta hasta millones.
  num = Math.round(Number(num) || 0);
  if (num === 0) return 'CERO PESOS 00/100 M.N.';

  const u = ['','UNO','DOS','TRES','CUATRO','CINCO','SEIS','SIETE','OCHO','NUEVE'];
  const d10_19 = ['DIEZ','ONCE','DOCE','TRECE','CATORCE','QUINCE','DIECISÉIS','DIECISIETE','DIECIOCHO','DIECINUEVE'];
  const d = ['','','VEINTI','TREINTA','CUARENTA','CINCUENTA','SESENTA','SETENTA','OCHENTA','NOVENTA'];
  const c = ['','CIENTO','DOSCIENTOS','TRESCIENTOS','CUATROCIENTOS','QUINIENTOS','SEISCIENTOS','SETECIENTOS','OCHOCIENTOS','NOVECIENTOS'];

  function decenas(n) {
    if (n < 10) return u[n];
    if (n < 20) return d10_19[n-10];
    if (n === 20) return 'VEINTE';
    if (n < 30) return 'VEINTI'+u[n-20].toLowerCase().toUpperCase();
    const dec = Math.floor(n/10), uni = n%10;
    return uni === 0 ? d[dec] : d[dec]+' Y '+u[uni];
  }
  function centenas(n) {
    if (n < 100) return decenas(n);
    if (n === 100) return 'CIEN';
    const cen = Math.floor(n/100), resto = n%100;
    return resto === 0 ? c[cen] : c[cen]+' '+decenas(resto);
  }
  function miles(n) {
    if (n < 1000) return centenas(n);
    const mil = Math.floor(n/1000), resto = n%1000;
    let prefijo = mil === 1 ? 'MIL' : centenas(mil)+' MIL';
    return resto === 0 ? prefijo : prefijo+' '+centenas(resto);
  }
  function millones(n) {
    if (n < 1000000) return miles(n);
    const mll = Math.floor(n/1000000), resto = n%1000000;
    let prefijo = mll === 1 ? 'UN MILLÓN' : centenas(mll)+' MILLONES';
    return resto === 0 ? prefijo : prefijo+' '+miles(resto);
  }

  const enteros = Math.floor(num);
  const cents   = Math.round((Number(num) - enteros) * 100);
  const cstr    = String(cents).padStart(2,'0');
  const sufijo  = enteros === 1 ? 'PESO' : 'PESOS';
  return millones(enteros) + ' ' + sufijo + ' ' + cstr + '/100 M.N.';
}

// Ticket desde la tarjeta del pedido (QA 13 sep: el botón del cajón no se
// encontraba). Carga el detalle por el mismo camino que el cajón, lo cierra y
// manda a imprimir.
window.imprimirTicketPedido = async function(idOrden) {
  await verDetallePedido(idOrden);
  if (!N._pedidoActual || String(N._pedidoActual.orden?.id) !== String(idOrden)) return;
  cerrarDetallePedido();
  imprimirTicket();
};

window.imprimirTicket = function() {
  if (!N._pedidoActual) { mostrarToast('No hay pedido seleccionado'); return; }
  const { orden, lineas } = N._pedidoActual;

  // Crear contenedor de impresión
  let printDiv = document.getElementById('ticket-print');
  if (!printDiv) {
    printDiv = document.createElement('div');
    printDiv.id = 'ticket-print';
    document.body.appendChild(printDiv);
  }

  const fecha = orden.fecha_orden ? new Date(orden.fecha_orden) : new Date();
  const fStr  = fecha.toLocaleDateString('es-MX',{day:'2-digit',month:'2-digit',year:'numeric'});
  const hStr  = fecha.toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit'});

  const esInternoTk = orden.canal === 'interno' || Number(orden.id_cliente) === 999999;
  const tipoInternoTk = orden.tipo_interno || '';
  const tiposInternosLblTk = {
    sampling:'SAMPLING', consumo:'CONSUMO INTERNO',
    demo:'DEMO / ACTIVACION', regalo:'REGALO / CORTESIA', merma:'MERMA'
  };

  // Filas de items con formato Cant | Descripción | Importe
  const itemsHTML = (lineas||[]).map(l => {
    const cantNum = l.tipo_venta === 'A granel'
      ? `${(l.gramos/1000).toFixed(3)}kg`
      : `${l.cantidad || 0}`;
    // Caja: «Natural Bolsa 50g (2 cajas de 12)»; la columna Cant sigue en piezas.
    const nom = `${l.sabor||''} ${l.presentacion||''}`.trim() + (l.piezas_por_caja ? ` (${cantidadConCajas(l).replace(/ \(\d+ pz\)$/, '')})` : '');
    const pesoLineaKg = (Number(l.gramos)||0) / 1000;
    const importe = esInternoTk
      ? `${pesoLineaKg.toFixed(3)}kg`
      : `$${(l.subtotal||0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return `<tr><td>${cantNum}</td><td>${nom}</td><td>${importe}</td></tr>`;
  }).join('');

  const subtotal = (lineas||[]).reduce((s,l) => s + (l.subtotal||0), 0);
  const desc     = Number(orden.descuento) || 0;
  const total    = Number(orden.total) || subtotal;
  const gramosTotalTk = (lineas||[]).reduce((s,l) => s + (Number(l.gramos)||0), 0);
  const totalArticulos = (lineas||[]).reduce((s,l) => s + Number(l.cantidad||0), 0);
  const totalLetras = esInternoTk ? '' : _numerosALetras(total);

  printDiv.innerHTML = `
    <div class="tk-paper">
      <div class="tk-h1">Crunchy</div>
      <div class="tk-h2">PAPS</div>

      <div class="tk-sub">${esInternoTk ? 'DOCUMENTO INTERNO' : 'Pre-ticket de venta'}</div>
      ${esInternoTk ? `<div style="text-align:center;font-weight:700;background:#000;color:#FFD200;padding:2pt 4pt;display:inline-block;font-size:9pt;margin:0 auto 4pt;">${tiposInternosLblTk[tipoInternoTk] || tipoInternoTk.toUpperCase() || 'INTERNO'}</div>` : ''}

      <div class="tk-meta">
        CRUNCHY PAPS<br>
        CDMX
      </div>

      <div class="tk-fields">
        <div class="tk-field"><b>Fecha:</b><span>${fStr}</span></div>
        <div class="tk-field"><b>Hora:</b><span>${hStr}</span></div>
        <div class="tk-field"><b>Folio:</b><span>${orden.consecutivo||'—'}</span></div>
        <div class="tk-field"><b>Cliente:</b><span style="text-align:right;max-width:50%;">${(orden.nombre_cliente||'—').substring(0,28)}</span></div>
        ${orden.nombre_vendedor ? `<div class="tk-field"><b>Vendedor:</b><span>${orden.nombre_vendedor}</span></div>` : ''}
        ${!esInternoTk && orden.tipo_pago ? `<div class="tk-field"><b>Pago:</b><span>${orden.tipo_pago}</span></div>` : ''}
      </div>

      <table class="tk-items">
        <thead>
          <tr><th>Cant</th><th>Descripción</th><th>Importe</th></tr>
        </thead>
        <tbody>${itemsHTML}</tbody>
      </table>

      <div class="tk-articulos"><b>Artículos: ${totalArticulos}</b></div>

      ${esInternoTk ? `
        <div class="tk-total">
          <span>VOLUMEN</span>
          <span>${(gramosTotalTk/1000).toFixed(3)} kg</span>
        </div>
        <div style="text-align:center;font-weight:700;background:#000;color:#FFD200;padding:4pt;margin-top:6pt;font-size:10pt;">SIN CARGO — NO ES VENTA</div>
      ` : `
        ${desc > 0 ? `
          <div class="tk-field" style="border:none;margin-top:4pt;"><b>Subtotal:</b><span>$${subtotal.toLocaleString('es-MX', { minimumFractionDigits: 2 })}</span></div>
          <div class="tk-field" style="border:none;"><b>Cupón ${orden.cupon_codigo || ''}:</b><span>-$${desc.toLocaleString('es-MX', { minimumFractionDigits: 2 })}</span></div>
        ` : ''}
        <div class="tk-total">
          <span>Gran Total:</span>
          <span>$${total.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>
        <div class="tk-total-letras">${totalLetras}</div>
      `}

      ${orden.notas ? `<div style="font-size:9pt;margin-top:6pt;padding-top:4pt;border-top:1px dashed #888;"><b>Notas:</b> ${orden.notas}</div>` : ''}

      <div class="tk-foot">
        <div class="tk-thanks">${esInternoTk ? 'Documento interno — control de lote' : '¡GRACIAS POR SU VISITA!'}</div>
        <div class="tk-redes">
          Facebook: <b>Crunchy Paps</b><br>
          Instagram: <b>@crunchy.papsmx</b><br>
          Correo: crunchypaps1@gmail.com
        </div>
        <div class="tk-powered">Powered by Crunchy Paps</div>
      </div>
    </div>
  `;

  // Mostrar y disparar impresión
  printDiv.classList.add('show');
  setTimeout(() => {
    window.print();
    setTimeout(() => { printDiv.classList.remove('show'); }, 300);
  }, 150);
};

// ══════════════════════════════════════════════════════════════════
// B2B MEJORADO — usa get_clientes_vendedor con stats
// Sobrescribe renderB2B y renderB2BLista existentes
// ══════════════════════════════════════════════════════════════════
// Cache global de vendedores activos (para selectores de reasignación)
let _vendedoresActivos = [];

async function renderB2B() {
  await cargarRutasCache();
  const lista = document.getElementById('b2b-lista');
  lista.innerHTML = '<div style="text-align:center;color:var(--suave);padding:20px;"><span class="loader loader-w"></span> Cargando clientes...</div>';

  try {
    // Etapa B: antes era `clientes?select=*` sin límite, y el filtro por
    // vendedor lo decidía ESTE archivo — es decir, el navegador. Cualquiera
    // podía borrar esa condición en DevTools y ver el padrón completo.
    // Ahora el alcance lo impone el servidor a partir del token: admin ve
    // todos, vendedor ve solo los suyos. El navegador ya no elige.
    const peticiones = [supabaseCall('POST', 'rpc/obtener_clientes', {
      p_data: { token: tokenVendedor(), limit: 200, offset: 0 }
    })];
    if (esAdmin() && _vendedoresActivos.length === 0) {
      peticiones.push(supabaseCall('POST', 'rpc/obtener_vendedores', { p_data: { token: tokenVendedor() } }));
    }
    const resultados = await Promise.all(peticiones);
    const resC = resultados[0];
    if (resultados[1] && resultados[1].ok) {
      _vendedoresActivos = resultados[1].vendedores || [];
    }

    if (sesionExpirada(resC)) {
      lista.innerHTML = '<div style="color:var(--rojo);padding:12px;">Tu sesión expiró. Vuelve a entrar para ver tus clientes.</div>';
      return;
    }
    if (!resC || !resC.ok || !Array.isArray(resC.clientes)) {
      lista.innerHTML = '<div style="color:var(--rojo);padding:12px;">Error: respuesta inválida</div>';
      return;
    }
    const arr = resC.clientes;
    // El RPC pagina (tope 200). Si hay más, decirlo en vez de perder filas en
    // silencio. La paginación de la interfaz queda pendiente.
    if (typeof resC.total === 'number' && resC.total > arr.length) {
      console.warn('[CP] Mostrando ' + arr.length + ' de ' + resC.total + ' clientes.');
    }

    // Total de compras por cliente.
    // Etapa B: la suma la hace Postgres y viaja solo el resultado. Antes se
    // traían TODAS las filas de `ordenes` de esos clientes para que el
    // navegador las recorriera: más datos personales en el cliente, más
    // tráfico, y la misma cuenta.
    let totales = {};
    if (arr.length > 0) {
      const _rt = await supabaseCall('POST', 'rpc/obtener_totales_clientes', {
        p_data: { ids: arr.map(c => c.id) }
      });
      if (_rt && _rt.ok && _rt.totales) totales = _rt.totales;
    }

    // Mapear clientes al formato esperado por el frontend
    _b2bClientes = arr.map(c => {
      const t = totales[c.id] || { total: 0, num: 0 };
      const esB2B = (c.tipo_id === 2 || c.tipo_id === 3 || c.tipo_id === 4) || /tienda|restaurante|abarrotes|mayorista|distribuidor/i.test(c.tipo || '');
      return {
        id:           c.id,
        tipo:         c.tipo || 'Consumidor',
        tipoId:       c.tipo_id,
        nombre:       c.nombre,
        telefono:     c.telefono,
        direccion:    c.direccion,
        cp:           c.cp,
        colonia:      c.colonia,
        municipio:    c.municipio,
        estado:       c.estado,
        coordenadas:  c.coordenadas,
        coordenadasGps: c.coordenadas_gps,
        idVendedor:   c.id_vendedor,
        idRuta:       c.id_ruta,
        vendedor:     c.vendedor,
        aprobadoB2B:  c.aprobado_b2b !== false,
        fechaSolicitud: c.fecha_creacion,
        esB2B,
        totalCompras: t.total,
        numPedidos:   t.num,
      };
    }).sort((a, b) => {
      // B2B no aprobados primero
      if (a.esB2B && !a.aprobadoB2B && (!b.esB2B || b.aprobadoB2B)) return -1;
      if (b.esB2B && !b.aprobadoB2B && (!a.esB2B || a.aprobadoB2B)) return 1;
      return b.totalCompras - a.totalCompras;
    });

    const pendientes = _b2bClientes.filter(c => c.esB2B && !c.aprobadoB2B).length;

    // Badge en navbar
    const badge = document.getElementById('b2b-badge');
    if (badge) {
      if (pendientes > 0) {
        badge.textContent = pendientes;
        badge.style.display = 'flex';
      } else {
        badge.style.display = 'none';
      }
    }

    // Resumen arriba
    pintarResumenB2B();
    renderB2BLista();
  } catch(e) {
    lista.innerHTML = '<div style="color:var(--rojo);padding:12px;">Error: ' + e.message + '</div>';
  }
}

function pintarResumenB2B() {
  const wrap = document.getElementById('b2b-resumen');
  if (!wrap) return;
  const b2b = _b2bClientes.filter(c => c.esB2B);
  const totalClientes = b2b.length;
  const ventasMes = b2b.reduce((s,c) => s + (c.comprasMes||0), 0);
  const pendientes = b2b.filter(c => !c.aprobadoB2B).length;
  document.getElementById('b2b-r-total').textContent = totalClientes;
  document.getElementById('b2b-r-ventas').textContent = '$' + ventasMes.toLocaleString('es-MX');
  document.getElementById('b2b-r-pend').textContent = pendientes;
  wrap.style.display = totalClientes > 0 ? 'block' : 'none';
}

// Sobrescribir filtrarB2B con tab "Todos"
window.filtrarB2B = function(filtro) {
  _b2bFiltro = filtro;
  ['pend','apro','todos'].forEach(t => {
    const btn = document.getElementById('b2b-tab-' + t);
    if (!btn) return;
    const map = {pend:'pendiente', apro:'aprobado', todos:'todos'};
    const activo = map[t] === filtro;
    btn.style.background  = activo ? 'var(--amarillo)' : 'var(--gris)';
    btn.style.color       = activo ? 'var(--negro)'   : 'var(--suave)';
    btn.style.borderColor = activo ? 'var(--amarillo)' : 'var(--gris3)';
  });
  renderB2BLista();
};

// Distancia en metros entre dos coords "lat,lng" (haversine). null si falta alguna.
function distanciaCoords(a, b) {
  try {
    if (!a || !b) return null;
    const pa = String(a).split(',').map(s => parseFloat(s.trim()));
    const pb = String(b).split(',').map(s => parseFloat(s.trim()));
    if (pa.length !== 2 || pb.length !== 2 || pa.some(isNaN) || pb.some(isNaN)) return null;
    const R = 6371000, rad = x => x * Math.PI / 180;
    const dLat = rad(pb[0] - pa[0]), dLng = rad(pb[1] - pa[1]);
    const s = Math.sin(dLat/2)**2 + Math.cos(rad(pa[0])) * Math.cos(rad(pb[0])) * Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  } catch (_e) { return null; }
}

function renderB2BLista() {
  const lista    = document.getElementById('b2b-lista');
  const filtrados = _b2bClientes.filter(c => {
    if (!c.esB2B) return false;
    if (_b2bFiltro === 'pendiente') return !c.aprobadoB2B;
    if (_b2bFiltro === 'aprobado')  return c.aprobadoB2B;
    return true; // 'todos'
  });

  if (!filtrados.length) {
    lista.innerHTML = `<div style="text-align:center;color:var(--suave);padding:40px 0;font-size:0.85rem;">
      ${_b2bFiltro === 'pendiente' ? 'Sin solicitudes pendientes' :
        _b2bFiltro === 'aprobado'  ? 'Sin clientes aprobados aún' :
                                     'Sin clientes B2B registrados'}
    </div>`;
    return;
  }

  lista.innerHTML = filtrados.map(c => {
    const ventasMes = c.comprasMes || 0;
    const totalHist = c.totalCompras || 0;
    // Cuánto lleva esperando una solicitud (o desde cuándo es cliente)
    const fSol = c.fechaSolicitud ? new Date(c.fechaSolicitud) : null;
    const diasSol = fSol && !isNaN(fSol) ? Math.max(0, Math.floor((Date.now() - fSol.getTime()) / 86400000)) : null;
    const fSolTxt = fSol && !isNaN(fSol) ? fSol.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' }) : '';
    const esperaTxt = diasSol === null ? '' : (diasSol === 0 ? 'hoy' : diasSol === 1 ? 'lleva 1 día esperando' : `lleva ${diasSol} días esperando`);
    const ult = c.ultimaCompra
      ? new Date(c.ultimaCompra).toLocaleDateString('es-MX',{day:'numeric',month:'short'})
      : 'Nunca';

    return `
    <div style="background:var(--gris);border-radius:14px;padding:14px;margin-bottom:10px;
      ${!c.aprobadoB2B ? 'border-left:3px solid var(--amarillo)' : 'border-left:3px solid #4caf50'}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;gap:8px;">
        <div style="flex:1;">
          <div style="font-weight:900;font-size:0.92rem;color:var(--blanco);">${c.nombre ? c.nombre : '<span style="color:#888;font-style:italic;font-weight:700;">(Sin nombre — solicitud nueva)</span>'}</div>
          <div style="font-size:0.72rem;color:var(--suave);margin-top:2px;">
            ${c.telefono} · ${c.tipo}
          </div>
          <div style="font-size:0.72rem;color:var(--suave);">
            ${c.colonia||''} ${c.municipio||''} ${c.estado||''}
          </div>
          ${fSolTxt ? `<div style="font-size:0.72rem;margin-top:2px;color:${!c.aprobadoB2B ? 'var(--amarillo)' : 'var(--suave)'};">${!c.aprobadoB2B ? 'Solicitud: ' + fSolTxt + (esperaTxt ? ' · ' + esperaTxt : '') : 'Cliente desde ' + fSolTxt}</div>` : ''}
          ${esAdmin() ? `
            <div style="display:flex;align-items:center;gap:6px;margin-top:4px;font-size:0.72rem;">
              <span style="color:var(--suave);">Vendedor:</span>
              <select onchange="reasignarVendedor(${c.id}, this.value, this.options[this.selectedIndex].text)"
                style="background:var(--gris2);border:1px solid var(--gris3);border-radius:6px;padding:3px 6px;color:var(--amarillo);font-family:'Inter',sans-serif;font-weight:700;font-size:0.72rem;cursor:pointer;flex:1;max-width:170px;">
                <option value="">— Sin asignar —</option>
                ${_vendedoresActivos.map(v => `<option value="${v.id}" ${String(v.id)===String(c.idVendedor)?'selected':''}>${v.nombre}</option>`).join('')}
              </select>
            </div>
          ` : (c.vendedor
            ? `<div style="font-size:0.72rem;color:var(--suave);">Vendedor: <span style="color:var(--amarillo);font-weight:700;">${c.vendedor}</span></div>`
            : `<div style="font-size:0.7rem;color:#666;font-style:italic;">Sin vendedor asignado</div>`)}
          ${esAdmin() ? `
            <div style="display:flex;align-items:center;gap:6px;margin-top:4px;font-size:0.72rem;">
              <span style="color:var(--suave);">Ruta:</span>
              <select onchange="reasignarRuta(${c.id}, this.value)" aria-label="Ruta de reparto"
                style="background:var(--gris2);border:1px solid var(--gris3);border-radius:6px;padding:3px 6px;min-height:32px;color:var(--amarillo);font-family:'Inter',sans-serif;font-weight:700;font-size:0.72rem;cursor:pointer;">
                <option value="">— Sin ruta —</option>
                ${(window._rutasCache || []).filter(r => r.activa !== false).map(r => `<option value="${r.id}" ${String(r.id)===String(c.idRuta)?'selected':''}>${r.nombre}</option>`).join('')}
              </select>
            </div>
          ` : (c.idRuta
            ? `<div style="font-size:0.72rem;color:var(--suave);">Ruta: <span style="color:var(--amarillo);font-weight:700;">${nombreRuta(c.idRuta)}</span></div>`
            : `<div style="font-size:0.7rem;color:#666;font-style:italic;">Sin ruta</div>`)}
          ${c.rfc ? `<div style="font-size:0.72rem;color:var(--suave);">RFC: ${c.rfc}</div>` : ''}
        </div>
        <div style="font-size:0.66rem;font-weight:800;padding:3px 8px;border-radius:50px;white-space:nowrap;
          ${c.aprobadoB2B ? 'background:#0d2d0d;color:#4caf50' : 'background:#2a1f00;color:var(--amarillo)'}">
          ${c.aprobadoB2B ? 'Aprobado' : 'Pendiente'}
        </div>
      </div>

      ${c.aprobadoB2B && (totalHist > 0 || c.numPedidos > 0) ? `
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;background:var(--gris2);border-radius:8px;padding:8px;margin:6px 0;text-align:center;">
          <div>
            <div style="font-family:'Archivo',sans-serif;font-size:1.05rem;color:var(--amarillo);line-height:1;">$${ventasMes.toLocaleString('es-MX')}</div>
            <div style="font-size:0.58rem;font-weight:700;color:#555;text-transform:uppercase;margin-top:2px;">Mes</div>
          </div>
          <div>
            <div style="font-family:'Archivo',sans-serif;font-size:1.05rem;color:var(--amarillo);line-height:1;">$${totalHist.toLocaleString('es-MX')}</div>
            <div style="font-size:0.58rem;font-weight:700;color:#555;text-transform:uppercase;margin-top:2px;">Total</div>
          </div>
          <div>
            <div style="font-family:'Archivo',sans-serif;font-size:1.05rem;color:var(--amarillo);line-height:1;">${c.numPedidos||0}</div>
            <div style="font-size:0.58rem;font-weight:700;color:#555;text-transform:uppercase;margin-top:2px;">Pedidos</div>
          </div>
        </div>
        <div style="font-size:0.7rem;color:#666;margin-top:2px;">Última compra: ${ult}</div>
      ` : ''}

      <div style="margin-top:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
        <a href="https://wa.me/52${String(c.telefono||'').replace(/\D/g,'').slice(-10)}" target="_blank"
          style="background:#0d2d0d;border:1px solid #25D366;border-radius:6px;padding:4px 8px;font-size:0.68rem;font-weight:700;color:#25D366;text-decoration:none;">
          Contactar
        </a>
        ${c.coordenadas
          ? `<a href="https://www.google.com/maps?q=${c.coordenadas}" target="_blank" style="background:#0d2d0d;border:1px solid #2a5a2a;border-radius:6px;padding:4px 8px;font-size:0.68rem;font-weight:700;color:#4caf50;text-decoration:none;">Ver en Maps (entrega)</a>`
          : `<span style="background:#2a1f00;border:1px solid #5a4a2a;border-radius:6px;padding:4px 8px;font-size:0.66rem;font-weight:700;color:var(--amarillo);">Sin ubicación capturada</span>`}
        ${c.coordenadasGps
          ? `<a href="https://www.google.com/maps?q=${c.coordenadasGps}" target="_blank" style="background:#0d1a2d;border:1px solid #2a4a5a;border-radius:6px;padding:4px 8px;font-size:0.68rem;font-weight:700;color:#4ab3ff;text-decoration:none;">GPS</a>`
          : ''}
        ${(() => { const d = distanciaCoords(c.coordenadas, c.coordenadasGps); if (d === null) return ''; const cerca = d <= 150; const col = cerca ? '#7ee787' : (d <= 500 ? '#ffb454' : '#ff8a8a'); const bg = cerca ? '#0d2d0d' : (d <= 500 ? '#2a1f00' : '#3a1515'); const txt = d < 1000 ? `${Math.round(d)} m` : `${(d/1000).toFixed(1)} km`; return `<span title="Distancia entre la dirección y el GPS detectado" style="background:${bg};border:1px solid ${col}55;border-radius:6px;padding:4px 8px;font-size:0.66rem;font-weight:800;color:${col};">${cerca ? '✓' : ''} GPS a ${txt}</span>`; })()}
      </div>

      ${!c.aprobadoB2B ? `
        <div style="display:flex;gap:8px;margin-top:8px;">
          <button onclick="aprobarB2B(${c.id}, '${(c.tipo||'').replace(/'/g,'')}')" style="
            flex:1;background:var(--amarillo);border:none;border-radius:8px;
            padding:8px;font-family:'Inter',sans-serif;font-weight:800;
            font-size:0.8rem;color:var(--negro);cursor:pointer;">
            Aprobar
          </button>
          <button onclick="rechazarB2B(${c.id})" style="
            flex:1;background:transparent;border:1px solid #333;border-radius:8px;
            padding:8px;font-family:'Inter',sans-serif;font-weight:800;
            font-size:0.8rem;color:var(--suave);cursor:pointer;">
            ✕ Rechazar
          </button>
        </div>` : `
        <button onclick="revocarB2B(${c.id})" style="
          background:transparent;border:1px solid #333;border-radius:8px;
          padding:6px 12px;font-family:'Inter',sans-serif;font-weight:700;
          font-size:0.75rem;color:#555;cursor:pointer;margin-top:6px;">
          Revocar aprobación
        </button>`}
    </div>`;
  }).join('');
}


// ══════════════════════════════════════════════════════════════════
// PROSPECCIÓN — mapa, lista, detalle, importación CSV (v2.3)
// ══════════════════════════════════════════════════════════════════
let _prospectos = [];
let _prospectoFiltro = 'todos';
let _vistaProspectos = 'mapa';
let _ordenProspectos = 'cerca_mi'; // 'cerca_mi' | 'cerca_planta' | 'score'

window.cambiarOrdenProspectos = async function(modo) {
  _ordenProspectos = modo;
  // Si elige "cerca_mi" y no tenemos ubicación, intentar obtenerla
  if (modo === 'cerca_mi' && (!_userLat || !_userLng)) {
    mostrarToast('Obteniendo tu ubicación...');
    const loc = await obtenerMiUbicacion();
    if (loc) {
      _userLat = loc.lat;
      _userLng = loc.lng;
      if (typeof actualizarPinUsuario === 'function') actualizarPinUsuario(loc.lat, loc.lng);
    } else {
      mostrarToast('Sin GPS, usando cercanía a planta');
      _ordenProspectos = 'cerca_planta';
      document.getElementById('pros-orden').value = 'cerca_planta';
    }
  }
  pintarListaProspectos();
};
let _prosMapa = null;
let _prosMarkers = [];
let _prosCSVPendientes = []; // datos parseados del CSV para confirmar

// Un prospecto tal como lo pinta la app, a partir de la fila de la base.
// La usan la lista de Prospección y «Mi ruta» (cuando abre uno que no está en la lista).
function normalizarProspecto(p) {
  return ({
      id:                     p.id,
      ref:                    p.ref || '',
      nombreNegocio:          p.nombre_negocio || '',
      // Alias legacy: el frontend (mapa, lista, detalle) usa p.nombre directamente
      nombre:                 p.nombre_negocio || '',
      tipoNegocio:            p.tipo_negocio || '',
      tipo:                   p.tipo_negocio || '',
      tipoCliente:            p.tipo_cliente || '',
      contactoNombre:         p.contacto_nombre || '',
      contactoTelefono:       p.contacto_telefono || '',
      // Alias legacy: usado por algunos pintados antiguos
      telefono:               p.contacto_telefono || '',
      email:                  p.email || '',
      direccion:              p.direccion || '',
      calle:                  p.calle || '',
      colonia:                p.colonia || '',
      codigoPostal:           p.codigo_postal || '',
      municipio:              p.municipio || '',
      estado:                 p.estado || '',
      coordenadas:            p.coordenadas || '',
      latitud:                p.latitud,
      longitud:               p.longitud,
      // Alias legacy: el mapa y rutas usan p.lat / p.lng
      lat:                    p.latitud  ? Number(p.latitud)  : null,
      lng:                    p.longitud ? Number(p.longitud) : null,
      distanciaMetros:        Number(p.distancia_metros) || 0,
      score:                  Number(p.score) || 0,
      estatus:                p.estatus || 'pendiente',
      notas:                  p.notas || '',
      idVendedor:             p.id_vendedor,
      nombreVendedor:         p.nombre_vendedor || '',
      fechaVisita:            p.fecha_visita,
      numVisitas:             Number(p.num_visitas) || 0,
      // Alias legacy: la lista usa p.numContactos
      numContactos:           Number(p.num_visitas) || 0,
      // La ficha usaba «Descartado: …» pero el motivo nunca se copiaba.
      motivoDescarte:         p.motivo_descarte || '',
      idClienteConvertido:    p.id_cliente_convertido,
  });
}

async function renderProspeccion() {
  // Mostrar botón importar solo a admin
  const btnImp = document.getElementById('pros-btn-import');
  if (btnImp) btnImp.style.display = (esAdmin && esAdmin()) ? '' : 'none';

  const lista = document.getElementById('pros-lista');
  if (lista) lista.innerHTML = '<div style="text-align:center;color:var(--suave);padding:20px 0;"><span class="loader loader-w"></span> Cargando prospectos...</div>';

  try {
    const _rpr = await supabaseCall('POST', 'rpc/obtener_prospectos', { p_data: { limit: 2000 } });
    const arr = (_rpr && _rpr.ok) ? _rpr.prospectos : null;
    if (!Array.isArray(arr)) {
      if (lista) lista.innerHTML = '<div style="color:var(--rojo);padding:14px;">Error: respuesta inválida</div>';
      return;
    }
    // Mapear nombres snake_case → camelCase que el frontend usa
    _prospectos = arr.map(normalizarProspecto);
    pintarResumenProspectos();
    pintarMapaProspectos();
    pintarListaProspectos();
  } catch(e) {
    if (lista) lista.innerHTML = '<div style="color:var(--rojo);padding:14px;">Error: ' + e.message + '</div>';
  }
}

function pintarResumenProspectos() {
  const total = _prospectos.length;
  const pend  = _prospectos.filter(p => p.estatus === 'pendiente').length;
  const cont  = _prospectos.filter(p => p.estatus === 'contactado').length;
  const conv  = _prospectos.filter(p => p.estatus === 'convertido').length;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('pros-r-total', total);
  set('pros-r-pend',  pend);
  set('pros-r-cont',  cont);
  set('pros-r-conv',  conv);
}

window.filtrarProspectos = function(estatus) {
  _prospectoFiltro = estatus;
  // Actualizar chips
  document.querySelectorAll('.pros-fchip').forEach(b => {
    const activo = b.getAttribute('data-est') === estatus;
    b.style.background  = activo ? 'var(--amarillo)' : 'var(--gris)';
    b.style.color       = activo ? 'var(--negro)' : 'var(--suave)';
    b.style.borderColor = activo ? 'var(--amarillo)' : 'var(--gris3)';
  });
  // Repintar ambas vistas
  pintarMapaProspectos();
  pintarListaProspectos();
};

function filtrarLista() {
  return _prospectos.filter(p => {
    if (_prospectoFiltro === 'todos') return true;
    return p.estatus === _prospectoFiltro;
  });
}

// ──────────────────────────────────────────
// VISTA MAPA
// ──────────────────────────────────────────
// Coordenadas de la planta de producción (constante)
const PLANTA_LAT = 19.390975800000;
const PLANTA_LNG = -99.124934500000;

// Estado del mapa (persiste entre renders)
let _userMarker = null;          // pin "tú estás aquí"
let _plantaMarker = null;        // pin "planta"
let _userLat = null;             // última ubicación conocida del usuario
let _userLng = null;

// Pedir ubicación al usuario (no bloquea el render del mapa)
function obtenerMiUbicacion() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 60000 }
    );
  });
}

async function pintarMapaProspectos() {
  const mapDiv = document.getElementById('pros-mapa-div');
  if (!mapDiv) return;

  // Asegurar Maps cargado
  if (!N.mapsListo) initMaps();
  let intentos = 0;
  while ((typeof google === 'undefined' || !google.maps?.Map) && intentos < 60) {
    await new Promise(r => setTimeout(r, 100));
    intentos++;
  }
  if (typeof google === 'undefined' || !google.maps?.Map) {
    mapDiv.innerHTML = '<div style="padding:30px;text-align:center;color:var(--rojo);">No se pudo cargar Google Maps.<br>Revisa tu conexión y recarga la página.</div>';
    return;
  }

  // Si el div del mapa está vacío (cambió de vista o fue re-renderizado), invalidar mapa cacheado
  if (_prosMapa && mapDiv && mapDiv.children.length === 0) {
    _prosMapa = null;
    _prosMarkers = [];
    _userMarker = null;
    _plantaMarker = null;
  }

  // PASO 1: Inicializar mapa SIEMPRE en planta primero (sin esperar GPS)
  if (!_prosMapa) {
    try {
      _prosMapa = new google.maps.Map(mapDiv, {
        center: { lat: PLANTA_LAT, lng: PLANTA_LNG },
        zoom: 15,
        disableDefaultUI: true,
        zoomControl: true,
        mapTypeControl: false,
        streetViewControl: false,
        styles: [{ featureType:'all', elementType:'labels.text.fill', stylers:[{color:'#444'}] }]
      });

      // Pin planta
      _plantaMarker = new google.maps.Marker({
        position: { lat: PLANTA_LAT, lng: PLANTA_LNG },
        map: _prosMapa,
        title: 'Planta Crunchy Paps',
        // Sin etiqueta: con texto vacío Google Maps pintaba «[object Object]».
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 0,
          fillColor: '#FFD200',
          fillOpacity: 1,
        },
        zIndex: 9999,
      });
    } catch(err) {
      console.error('[Mapa] Error inicializando:', err);
      mapDiv.innerHTML = '<div style="padding:30px;text-align:center;color:var(--rojo);">Error: ' + err.message + '</div>';
      return;
    }

    // PASO 2: Pedir ubicación del usuario en SEGUNDO PLANO (no bloquea)
    // Si falla, el mapa sigue visible centrado en la planta
    setTimeout(() => {
      obtenerMiUbicacion().then(loc => {
        if (loc && _prosMapa) {
          _userLat = loc.lat;
          _userLng = loc.lng;
          actualizarPinUsuario(loc.lat, loc.lng);
          _prosMapa.setCenter({ lat: loc.lat, lng: loc.lng });
          _prosMapa.setZoom(15);
        }
      }).catch(err => {
        console.warn('[Mapa] Sin ubicación de usuario:', err);
      });
    }, 500);
  } else {
    google.maps.event.trigger(_prosMapa, 'resize');
  }

  // PASO 3: Pintar marcadores de prospectos
  const filtrados = filtrarLista();

  // Limpiar marcadores previos (NO el pin planta ni el de usuario)
  _prosMarkers.forEach(m => m.setMap(null));
  _prosMarkers = [];

  const colorPorEstatus = {
    pendiente:  '#e74c3c',
    contactado: '#FFD200',
    convertido: '#4caf50',
    descartado: '#666'
  };

  filtrados.forEach(p => {
    if (!p.lat || !p.lng) return;
    const color = colorPorEstatus[p.estatus] || '#999';
    // Si está en modo ruta y el prospecto está seleccionado, marca diferente
    const seleccionadoRuta = _modoRuta && _rutaSeleccion.indexOf(p.id) >= 0;
    const indiceEnRuta = seleccionadoRuta ? _rutaSeleccion.indexOf(p.id) + 1 : 0;
    try {
      const marker = new google.maps.Marker({
        position: { lat: p.lat, lng: p.lng },
        map: _prosMapa,
        title: seleccionadoRuta ? `[${indiceEnRuta}] ${p.nombre}` : p.nombre,
        label: seleccionadoRuta ? { text: String(indiceEnRuta), color: '#000', fontWeight: '900', fontSize: '14px' } : null,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: seleccionadoRuta ? 14 : escalaPunto(p.score),
          fillColor: seleccionadoRuta ? '#FFD200' : color,
          fillOpacity: seleccionadoRuta ? 1 : 0.85,
          strokeColor: '#000',
          strokeWeight: seleccionadoRuta ? 3 : grosorPunto(),
        }
      });
      marker.addListener('click', () => {
        if (_modoRuta) {
          toggleSeleccionRuta(p.id);
        } else {
          verDetalleProspecto(p.id);
        }
      });
      marker.__score = p.score;
      marker.__sel = seleccionadoRuta;
      _prosMarkers.push(marker);
    } catch(err) {
      console.error('[Mapa] Error agregando marcador para', p.nombre, err);
    }
  });

  hookZoomProspectos();
  pintarRutasEnMapa();
}

// El punto de un prospecto crece con el zoom: con mil puntos, 8 px de radio
// tapan la calle. El score se sigue notando, pero solo de cerca.
function escalaPunto(score) {
  const z = _prosMapa ? (_prosMapa.getZoom() || 15) : 15;
  const base = z >= 17 ? 8 : z >= 16 ? 6 : z >= 15 ? 4 : z >= 14 ? 3 : 2;
  const sc = Math.min(5, Math.max(1, Number(score) || 3));   // estrellas: 1 a 5
  return Math.max(1.5, base + (sc - 3) * (z >= 15 ? 0.8 : 0.3));
}
function grosorPunto() {
  const z = _prosMapa ? (_prosMapa.getZoom() || 15) : 15;
  return z >= 16 ? 1.5 : z >= 14 ? 1 : 0.5;
}
function ajustarPuntosProspectos() {
  for (const m of _prosMarkers) {
    if (!m || m.__sel) continue;
    const ic = m.getIcon();
    if (!ic || typeof ic !== 'object') continue;
    ic.scale = escalaPunto(m.__score);
    ic.strokeWeight = grosorPunto();
    m.setIcon(ic);
  }
}
let _zoomHook = false;
function hookZoomProspectos() {
  if (!_prosMapa || _zoomHook) return;
  _zoomHook = true;
  _prosMapa.addListener('zoom_changed', ajustarPuntosProspectos);
}

// ── Rutas de reparto sobre el mapa (15 sep 2026) ────────────────────────────
// Polígonos de código postal (SEPOMEX). Se descargan una vez, a demanda, y se
// pintan debajo de los marcadores. La cobertura por colonia no se dibuja.
let _cpZona = null, _cpZonaCargando = null, _rutasPoligonos = [];
let _rutasEnMapa = true;
try { _rutasEnMapa = localStorage.getItem('cp_rutas_mapa') !== '0'; } catch (_e) {}

async function cargarGeoCP() {
  if (_cpZona) return _cpZona;
  if (!_cpZonaCargando) {
    _cpZonaCargando = fetch('/datos-cp-zona.json')
      .then(r => r.ok ? r.json() : null)
      .catch(() => null)
      .then(j => { _cpZona = j || {}; return _cpZona; });
  }
  return _cpZonaCargando;
}

// Una cobertura de CP puede ser un código suelto o un rango.
function cpsDeCobertura(cob) {
  const cps = [];
  for (const c of (cob || [])) {
    if (c.tipo !== 'cp') continue;
    const desde = String(c.valor || '').trim();
    const hasta = String(c.cpHasta || '').trim() || desde;
    if (!desde) continue;
    for (const cp of Object.keys(_cpZona || {})) if (cp >= desde && cp <= hasta) cps.push(cp);
  }
  return [...new Set(cps)];
}

async function pintarRutasEnMapa() {
  if (!_prosMapa) return;
  _rutasPoligonos.forEach(p => p.setMap(null));
  _rutasPoligonos = [];
  const btn = document.getElementById('pros-rutas-btn');
  if (btn) { btn.setAttribute('aria-pressed', _rutasEnMapa ? 'true' : 'false'); btn.style.opacity = _rutasEnMapa ? '1' : '0.5'; }
  if (!_rutasEnMapa) return;
  if (!window._rutasCache) await cargarRutasCache();
  const rutas = (window._rutasCache || []).filter(r => r.activa !== false);
  if (!rutas.length) return;
  await cargarGeoCP();
  for (const r of rutas) {
    const color = r.color || '#ffd200';
    for (const cp of cpsDeCobertura(r.cobertura)) {
      for (const poli of (_cpZona[cp] || [])) {
        try {
          _rutasPoligonos.push(new google.maps.Polygon({
            paths: poli.map(anillo => anillo.map(c => ({ lat: c[1], lng: c[0] }))),
            map: _prosMapa, clickable: false, zIndex: 1,
            strokeColor: color, strokeOpacity: 0.9, strokeWeight: 1.5,
            fillColor: color, fillOpacity: 0.16,
          }));
        } catch (_e) {}
      }
    }
  }
}

window.alternarRutasMapa = function() {
  _rutasEnMapa = !_rutasEnMapa;
  try { localStorage.setItem('cp_rutas_mapa', _rutasEnMapa ? '1' : '0'); } catch (_e) {}
  pintarRutasEnMapa();
};

function actualizarPinUsuario(lat, lng) {
  if (!_prosMapa) return;
  if (_userMarker) {
    _userMarker.setPosition({ lat, lng });
  } else {
    _userMarker = new google.maps.Marker({
      position: { lat, lng },
      map: _prosMapa,
      title: 'Tú estás aquí',
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 10,
        fillColor: '#3498db',
        fillOpacity: 0.9,
        strokeColor: '#fff',
        strokeWeight: 3,
      },
      zIndex: 9998,
    });
  }
}

window.centrarEnPlanta = function() {
  if (!_prosMapa) return;
  _prosMapa.setCenter({ lat: PLANTA_LAT, lng: PLANTA_LNG });
  _prosMapa.setZoom(16);
  mostrarToast('Planta Crunchy Paps');
};

window.centrarEnMiUbicacion = async function() {
  mostrarToast('Buscando tu ubicación...');
  const loc = await obtenerMiUbicacion();
  if (!loc) {
    avisar({ titulo: 'No pude obtener tu ubicación', cuerpo: 'Verifica los permisos de geolocalización.' });
    return;
  }
  _userLat = loc.lat;
  _userLng = loc.lng;
  actualizarPinUsuario(loc.lat, loc.lng);
  _prosMapa.setCenter({ lat: loc.lat, lng: loc.lng });
  _prosMapa.setZoom(16);
  mostrarToast('Tu ubicación');
};

// ──────────────────────────────────────────
// RUTA ÓPTIMA DE PROSPECCIÓN
// ──────────────────────────────────────────
let _modoRuta = false;
let _rutaSeleccion = []; // ids de prospectos seleccionados
let _rutaResultado = null; // {paradas, totalDist, totalTime, urlMaps}
let _rutaPolyline = null; // línea dibujada en el mapa
const MAX_PUNTOS_RUTA = 25;

window.toggleModoRuta = function() {
  _modoRuta = !_modoRuta;
  const banner = document.getElementById('pros-ruta-banner');
  const footer = document.getElementById('pros-ruta-footer');
  const btn = document.getElementById('pros-btn-ruta');
  if (_modoRuta) {
    banner.style.display = 'flex';
    footer.style.display = 'block';
    btn.style.background = 'var(--amarillo)';
    btn.style.color = '#000';
    btn.style.borderColor = 'var(--amarillo)';
    _rutaSeleccion = [];
    actualizarBannerRuta();
    // Re-pintar mapa con marcadores tappeables
    pintarMapaProspectos();
    mostrarToast('Toca prospectos para agregarlos a la ruta');
  } else {
    cancelarModoRuta();
  }
};

window.cancelarModoRuta = function() {
  _modoRuta = false;
  _rutaSeleccion = [];
  document.getElementById('pros-ruta-banner').style.display = 'none';
  document.getElementById('pros-ruta-footer').style.display = 'none';
  const btn = document.getElementById('pros-btn-ruta');
  btn.style.background = 'var(--gris)';
  btn.style.color = 'var(--blanco)';
  btn.style.borderColor = 'var(--gris3)';
  // Limpiar polyline si existe
  if (_rutaPolyline) { _rutaPolyline.setMap(null); _rutaPolyline = null; }
  pintarMapaProspectos();
};

function actualizarBannerRuta() {
  const cuenta = document.getElementById('pros-ruta-cuenta');
  const btn = document.getElementById('pros-ruta-calcular');
  const n = _rutaSeleccion.length;
  if (n === 0) {
    cuenta.textContent = 'Toca prospectos para agregar a la ruta';
    btn.disabled = true; btn.style.opacity = '0.5';
    btn.textContent = 'Selecciona al menos 2 puntos';
  } else if (n === 1) {
    cuenta.textContent = `${n} punto seleccionado`;
    btn.disabled = true; btn.style.opacity = '0.5';
    btn.textContent = 'Selecciona al menos 2 puntos';
  } else {
    cuenta.textContent = `${n} punto${n>1?'s':''} seleccionado${n>1?'s':''}`;
    btn.disabled = false; btn.style.opacity = '1';
    btn.textContent = `Calcular ruta óptima (${n} paradas)`;
  }
}

function toggleSeleccionRuta(id) {
  const i = _rutaSeleccion.indexOf(id);
  if (i >= 0) {
    _rutaSeleccion.splice(i, 1);
  } else {
    if (_rutaSeleccion.length >= MAX_PUNTOS_RUTA) {
      mostrarToast(`Máximo ${MAX_PUNTOS_RUTA} puntos por ruta`);
      return;
    }
    _rutaSeleccion.push(id);
  }
  actualizarBannerRuta();
  pintarMapaProspectos(); // re-pintar para actualizar visual
}

window.calcularRutaOptima = async function() {
  if (_rutaSeleccion.length < 2) return;

  const btn = document.getElementById('pros-ruta-calcular');
  btn.disabled = true; btn.textContent = 'Calculando...';

  // Origen: ubicación del usuario, o planta si no hay GPS
  let origen;
  if (_userLat && _userLng) {
    origen = { lat: _userLat, lng: _userLng, nombre: 'Tu ubicación' };
  } else {
    origen = { lat: PLANTA_LAT, lng: PLANTA_LNG, nombre: 'Planta Crunchy Paps' };
  }

  // Construir lista de paradas (objetos prospecto)
  const paradas = _rutaSeleccion
    .map(id => _prospectos.find(p => String(p.id) === String(id)))
    .filter(Boolean);
  if (paradas.length < 2) { mostrarToast('Datos insuficientes'); return; }

  try {
    if (typeof google === 'undefined' || !google.maps) throw new Error('Maps no cargado');
    const directionsService = new google.maps.DirectionsService();

    // Última parada como destino, las demás como waypoints
    const destino = paradas[paradas.length - 1];
    const waypoints = paradas.slice(0, -1).map(p => ({
      location: new google.maps.LatLng(p.lat, p.lng),
      stopover: true,
    }));

    const result = await new Promise((resolve, reject) => {
      directionsService.route({
        origin: { lat: origen.lat, lng: origen.lng },
        destination: { lat: destino.lat, lng: destino.lng },
        waypoints: waypoints,
        optimizeWaypoints: true,
        travelMode: google.maps.TravelMode.DRIVING,
      }, (res, status) => {
        if (status === 'OK') resolve(res);
        else reject(new Error('Error Directions: ' + status));
      });
    });

    // Reordenar paradas según el orden óptimo (waypoint_order)
    const route = result.routes[0];
    const order = route.waypoint_order; // índices reordenados de waypoints (no incluye destino)
    const paradasOrdenadas = order.map(i => paradas[i]);
    paradasOrdenadas.push(destino); // el destino siempre va al final

    // Calcular totales
    let totalDist = 0, totalTime = 0;
    route.legs.forEach(leg => {
      totalDist += leg.distance.value;
      totalTime += leg.duration.value;
    });

    _rutaResultado = {
      origen, paradas: paradasOrdenadas,
      legs: route.legs,
      totalDist, totalTime,
    };

    // Dibujar línea en el mapa
    if (_rutaPolyline) _rutaPolyline.setMap(null);
    _rutaPolyline = new google.maps.Polyline({
      path: route.overview_path,
      strokeColor: '#FFD200',
      strokeOpacity: 0.8,
      strokeWeight: 5,
      map: _prosMapa,
    });

    mostrarResultadoRuta();
  } catch(e) {
    avisar({ titulo: 'Error calculando la ruta', cuerpo: e.message });
    btn.disabled = false; actualizarBannerRuta();
  }
};

function mostrarResultadoRuta() {
  document.getElementById('overlay-ruta').classList.add('visible');
  document.getElementById('drawer-ruta').classList.add('open');

  const r = _rutaResultado;
  const distKm = (r.totalDist / 1000).toFixed(1);
  const minTotal = Math.round(r.totalTime / 60);
  const horas = Math.floor(minTotal / 60);
  const mins = minTotal % 60;
  const tiempoStr = horas > 0 ? `${horas}h ${mins}min` : `${mins} min`;

  document.getElementById('ruta-resumen').innerHTML = `
    <div style="display:flex;justify-content:space-around;text-align:center;">
      <div>
        <div style="font-family:'Archivo',sans-serif;font-size:1.6rem;color:var(--amarillo);line-height:1;">${distKm}km</div>
        <div style="font-size:0.66rem;font-weight:800;color:var(--suave);text-transform:uppercase;letter-spacing:1px;">Distancia</div>
      </div>
      <div>
        <div style="font-family:'Archivo',sans-serif;font-size:1.6rem;color:var(--amarillo);line-height:1;">${tiempoStr}</div>
        <div style="font-size:0.66rem;font-weight:800;color:var(--suave);text-transform:uppercase;letter-spacing:1px;">Tiempo total</div>
      </div>
      <div>
        <div style="font-family:'Archivo',sans-serif;font-size:1.6rem;color:var(--amarillo);line-height:1;">${r.paradas.length}</div>
        <div style="font-size:0.66rem;font-weight:800;color:var(--suave);text-transform:uppercase;letter-spacing:1px;">Paradas</div>
      </div>
    </div>
  `;

  // Lista de paradas en orden óptimo
  let html = `<div style="font-size:0.7rem;font-weight:800;color:var(--suave);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Orden óptimo</div>`;
  // Origen
  html += `<div style="background:var(--gris2);border-left:3px solid #4caf50;border-radius:8px;padding:9px 12px;margin-bottom:6px;">
    <div style="font-size:0.66rem;color:#4caf50;font-weight:800;">SALIDA</div>
    <div style="font-size:0.84rem;color:var(--blanco);font-weight:700;">${r.origen.nombre}</div>
  </div>`;
  // Paradas
  r.paradas.forEach((p, i) => {
    const leg = r.legs[i];
    const dKm = (leg.distance.value / 1000).toFixed(1);
    const tMin = Math.round(leg.duration.value / 60);
    html += `<div style="background:var(--gris2);border-left:3px solid var(--amarillo);border-radius:8px;padding:9px 12px;margin-bottom:6px;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;">
        <div style="font-size:0.66rem;color:var(--amarillo);font-weight:800;">PARADA ${i+1}</div>
        <div style="font-size:0.7rem;color:var(--suave);">${dKm}km · ${tMin}min</div>
      </div>
      <div style="font-size:0.84rem;color:var(--blanco);font-weight:700;margin-top:2px;">${p.nombre}</div>
      <div style="font-size:0.7rem;color:var(--suave);">${p.tipo}${p.direccion ? ' · '+p.direccion : ''}</div>
    </div>`;
  });
  document.getElementById('ruta-paradas').innerHTML = html;

  // Reset del botón
  const btn = document.getElementById('pros-ruta-calcular');
  btn.disabled = false; btn.textContent = 'Ruta calculada (ver detalle)';
}

window.cerrarRuta = function() {
  document.getElementById('overlay-ruta').classList.remove('visible');
  document.getElementById('drawer-ruta').classList.remove('open');
};

document.addEventListener('click', e => {
  const ov = document.getElementById('overlay-ruta');
  if (e.target === ov) cerrarRuta();
});

window.abrirEnMaps = function() {
  if (!_rutaResultado) return;
  const r = _rutaResultado;
  // Construir URL de Google Maps con todos los puntos en orden
  const origin = `${r.origen.lat},${r.origen.lng}`;
  const destination = `${r.paradas[r.paradas.length-1].lat},${r.paradas[r.paradas.length-1].lng}`;
  const waypoints = r.paradas.slice(0, -1).map(p => `${p.lat},${p.lng}`).join('|');
  let url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&travelmode=driving`;
  if (waypoints) url += `&waypoints=${encodeURIComponent(waypoints)}`;
  window.open(url, '_blank');
};

// ──────────────────────────────────────────
// NUEVO PROSPECTO DESDE MAPA (botón flotante "+")
// ──────────────────────────────────────────
let _scoreNuevoProspecto = 3;
let _coordsNuevoProspecto = null;

window.abrirNuevoProspecto = async function() {
  // Reset form
  document.getElementById('np-nombre').value = '';
  document.getElementById('np-tel').value = '';
  document.getElementById('np-notas').value = '';
  document.getElementById('np-tipo').value = 'Tienda / Abarrotes';
  setScoreNP(3);
  _coordsNuevoProspecto = null;

  // Abrir drawer
  document.getElementById('overlay-nuevo-prospecto').classList.add('visible');
  document.getElementById('drawer-nuevo-prospecto').classList.add('open');

  // Capturar ubicación GPS
  const info = document.getElementById('np-coords-info');
  info.innerHTML = 'Capturando tu ubicación... <span class="loader loader-w"></span>';
  info.style.background = '#2a1f00';
  info.style.borderColor = 'rgba(255,210,0,0.4)';
  info.style.color = 'var(--amarillo)';

  const loc = await obtenerMiUbicacion();
  if (loc) {
    _coordsNuevoProspecto = { lat: loc.lat, lng: loc.lng };
    info.innerHTML = `Ubicación capturada: ${loc.lat.toFixed(6)}, ${loc.lng.toFixed(6)}`;
    info.style.background = '#0d2d0d';
    info.style.borderColor = '#2a5a2a';
    info.style.color = '#4caf50';
  } else {
    // Fallback: usar la última ubicación conocida o el centro del mapa
    if (_userLat && _userLng) {
      _coordsNuevoProspecto = { lat: _userLat, lng: _userLng };
      info.innerHTML = `Usando última ubicación conocida: ${_userLat.toFixed(6)}, ${_userLng.toFixed(6)}`;
    } else if (_prosMapa) {
      const c = _prosMapa.getCenter();
      _coordsNuevoProspecto = { lat: c.lat(), lng: c.lng() };
      info.innerHTML = `Sin GPS — usando centro del mapa: ${c.lat().toFixed(6)}, ${c.lng().toFixed(6)}`;
      info.style.background = '#2d0d0d';
      info.style.borderColor = 'var(--rojo)';
      info.style.color = 'var(--rojo)';
    } else {
      info.innerHTML = 'No se pudo obtener ubicación. Activa GPS y vuelve a intentar.';
      info.style.background = '#2d0d0d';
      info.style.borderColor = 'var(--rojo)';
      info.style.color = 'var(--rojo)';
    }
  }
};

window.cerrarNuevoProspecto = function() {
  document.getElementById('overlay-nuevo-prospecto').classList.remove('visible');
  document.getElementById('drawer-nuevo-prospecto').classList.remove('open');
};

document.addEventListener('click', e => {
  const ov = document.getElementById('overlay-nuevo-prospecto');
  if (e.target === ov) cerrarNuevoProspecto();
});

window.setScoreNP = function(score) {
  _scoreNuevoProspecto = score;
  document.querySelectorAll('.np-star').forEach(b => {
    const s = Number(b.getAttribute('data-s'));
    if (s <= score) {
      b.style.background = 'var(--amarillo)';
      b.style.borderColor = 'var(--amarillo)';
    } else {
      b.style.background = 'var(--gris2)';
      b.style.borderColor = 'var(--gris3)';
    }
  });
};

window.guardarNuevoProspecto = async function() {
  const nombre = document.getElementById('np-nombre').value.trim();
  const tipo   = document.getElementById('np-tipo').value;
  const tel    = document.getElementById('np-tel').value.trim();
  const notas  = document.getElementById('np-notas').value.trim();

  if (!nombre) { mostrarToast('Ingresa el nombre del negocio'); return; }
  if (!_coordsNuevoProspecto) { mostrarToast('No hay ubicación. Activa el GPS y vuelve a intentar.'); return; }

  // Calcular distancia a la planta
  function distanciaMetros(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat/2)**2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLng/2)**2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  const distancia = distanciaMetros(
    _coordsNuevoProspecto.lat, _coordsNuevoProspecto.lng,
    PLANTA_LAT, PLANTA_LNG
  );

  try {
    const payload = {
      nombre_negocio:    nombre,
      tipo_negocio:      tipo,
      contacto_telefono: tel || null,
      latitud:           _coordsNuevoProspecto.lat,
      longitud:          _coordsNuevoProspecto.lng,
      coordenadas:       `${_coordsNuevoProspecto.lat},${_coordsNuevoProspecto.lng}`,
      score:             _scoreNuevoProspecto,
      notas:             notas || null,
      distancia_metros:  Math.round(distancia),
      id_vendedor:       N.vendedorInfo?.id || null,
      nombre_vendedor:   N.vendedorInfo?.nombre || '',
      num_visitas:       1, // primera visita registrada
      fecha_visita:      new Date().toISOString(),
      estatus:           'contactado',
    };
    // Etapa B: por RPC con sesión. El id del vendedor lo pone el servidor a
    // partir del token, no el navegador: nadie registra prospectos a nombre de otro.
    const res = await supabaseCall('POST', 'rpc/crear_prospecto', { p_data: payload });
    if (!res || !res.ok) {
      avisar({ titulo: 'No se pudo guardar el prospecto', cuerpo: ((res && res.error) || 'Sin respuesta') });
      return;
    }
    mostrarToast('Prospecto registrado');
    cerrarNuevoProspecto();
    renderProspeccion();
  } catch(e) { avisar({ titulo: 'No se pudo guardar el prospecto', cuerpo: e.message }); }
};

// ──────────────────────────────────────────
// VISTA LISTA
// ──────────────────────────────────────────
function pintarListaProspectos() {
  const cont = document.getElementById('pros-lista');
  if (!cont) return;

  const filtrados = filtrarLista();

  // Helper distancia
  function dist(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  // Calcular distancia desde el usuario para cada prospecto si tenemos GPS
  const tengoUbicacion = !!(_userLat && _userLng);
  if (tengoUbicacion) {
    filtrados.forEach(p => {
      p._distMi = (p.lat && p.lng) ? dist(_userLat, _userLng, p.lat, p.lng) : 999999;
    });
  }

  // Orden según modo seleccionado
  // Pendientes/contactados primero, descartados al final
  const ordenEst = { pendiente:0, contactado:1, convertido:2, descartado:3 };
  filtrados.sort((a,b) => {
    const dEst = (ordenEst[a.estatus] ?? 9) - (ordenEst[b.estatus] ?? 9);
    if (dEst !== 0) return dEst;

    if (_ordenProspectos === 'cerca_mi' && tengoUbicacion) {
      const dA = a._distMi ?? 999999;
      const dB = b._distMi ?? 999999;
      if (dA !== dB) return dA - dB;
      return (b.score || 0) - (a.score || 0);
    }
    if (_ordenProspectos === 'score') {
      const sd = (b.score || 0) - (a.score || 0);
      if (sd !== 0) return sd;
      // Desempate: cerca de planta
      return (a.distanciaMetros || 999999) - (b.distanciaMetros || 999999);
    }
    // Default y "cerca_planta": por distancia a planta
    const dA = a.distanciaMetros || 999999;
    const dB = b.distanciaMetros || 999999;
    if (dA !== dB) return dA - dB;
    return (b.score || 0) - (a.score || 0);
  });

  if (filtrados.length === 0) {
    cont.innerHTML = `<div style="text-align:center;color:var(--suave);padding:40px 0;font-size:0.85rem;">
      <span style="font-size:2.5rem;display:block;margin-bottom:8px;" class="ico-solo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/></svg></span>
      ${_prospectoFiltro === 'todos' ? 'Sin prospectos registrados aún' : 'Sin prospectos en este estatus'}
    </div>`;
    return;
  }

  // Helper formatear distancia
  function fmtDist(m) {
    if (!m || m === 999999) return null;
    return m < 1000 ? `${Math.round(m)}m` : `${(m/1000).toFixed(1)}km`;
  }

  const ico = { pendiente:'<span class="dot-est pend"></span>', contactado:'<span class="dot-est cont"></span>', convertido:'<span class="dot-est conv"></span>', descartado:'<span class="dot-est desc"></span>' };
  cont.innerHTML = filtrados.map(p => {
    const sc = Math.max(0, Math.min(5, Math.round(Number(p.score) || 0)));
    const estrellas = '★'.repeat(sc) + '☆'.repeat(5 - sc);
    const ult = p.fechaUltimoContacto
      ? new Date(p.fechaUltimoContacto).toLocaleDateString('es-MX',{day:'numeric',month:'short'})
      : 'Nunca';

    // Distancia destacada según modo
    let distLabel = '';
    if (_ordenProspectos === 'cerca_mi' && tengoUbicacion && p._distMi < 999999) {
      distLabel = `<span style="background:#0d2d0d;color:#4caf50;font-size:0.66rem;font-weight:700;padding:2px 7px;border-radius:50px;">${fmtDist(p._distMi)}</span>`;
    } else if (_ordenProspectos === 'cerca_planta' && p.distanciaMetros) {
      distLabel = `<span style="background:#2a1f00;color:var(--amarillo);font-size:0.66rem;font-weight:700;padding:2px 7px;border-radius:50px;">${fmtDist(p.distanciaMetros)}</span>`;
    }

    return `<div onclick="verDetalleProspecto(${p.id})" style="
      background:var(--gris);border-radius:12px;padding:12px;margin-bottom:8px;cursor:pointer;
      border-left:3px solid ${p.estatus==='pendiente'?'var(--rojo)':p.estatus==='contactado'?'var(--amarillo)':p.estatus==='convertido'?'#4caf50':'#666'};">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:900;font-size:0.92rem;color:var(--blanco);">${ico[p.estatus]||''} ${p.nombre}</div>
          <div style="font-size:0.72rem;color:var(--suave);margin-top:2px;">${p.tipo}${p.telefono?' · '+p.telefono:''}</div>
          <div style="font-size:0.7rem;color:var(--suave);">${p.direccion || 'Sin dirección'}</div>
          <div style="display:flex;align-items:center;gap:6px;margin-top:5px;flex-wrap:wrap;">
            ${distLabel}
            <span style="font-size:0.7rem;color:#666;">${p.numContactos>0 ? `${p.numContactos} contacto(s) · últ ${ult}` : 'Sin contactos'}${p.nombreVendedor ? ` · ${p.nombreVendedor}` : ''}</span>
          </div>
        </div>
        <div style="font-size:0.78rem;color:var(--amarillo);font-weight:700;white-space:nowrap;">${estrellas}</div>
      </div>
    </div>`;
  }).join('');
}

// ──────────────────────────────────────────
// MODAL DETALLE
// ──────────────────────────────────────────
let _prospectoActual = null;

window.verDetalleProspecto = function(id) {
  const p = _prospectos.find(x => String(x.id) === String(id));
  if (!p) return;
  _prospectoActual = p;
  document.getElementById('overlay-prospecto').classList.add('visible');
  document.getElementById('drawer-prospecto').classList.add('open');
  document.getElementById('dpr-titulo').textContent = p.nombre;

  const ico = { pendiente:'Pendiente', contactado:'Contactado', convertido:'Convertido', descartado:'Descartado' };
  const sc = Math.max(0, Math.min(5, Math.round(Number(p.score) || 0)));
  const estrellas = '★'.repeat(sc) + '☆'.repeat(5 - sc);
  const ult = p.fechaUltimoContacto
    ? new Date(p.fechaUltimoContacto).toLocaleDateString('es-MX',{weekday:'short',day:'numeric',month:'short'})
    : '—';
  const yaConvertido = p.estatus === 'convertido';
  const descartado   = p.estatus === 'descartado';

  document.getElementById('dpr-contenido').innerHTML = `
    <!-- Estatus + score -->
    <div style="background:var(--gris2);border-radius:12px;padding:12px;margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <span class="pedido-estatus" style="background:${p.estatus==='pendiente'?'#2d0d0d':p.estatus==='contactado'?'#2a1f00':p.estatus==='convertido'?'#0d2d0d':'#222'};color:${p.estatus==='pendiente'?'var(--rojo)':p.estatus==='contactado'?'var(--amarillo)':p.estatus==='convertido'?'#4caf50':'#888'};">${ico[p.estatus]||p.estatus}</span>
        <span style="font-size:0.86rem;color:var(--amarillo);font-weight:700;">${estrellas}</span>
      </div>
      <div style="font-weight:800;color:var(--blanco);font-size:0.94rem;">${p.tipo}${p.tierOriginal?` · <span style="color:var(--amarillo);font-size:0.78rem;">${p.tierOriginal}</span>`:''}</div>
      ${p.direccion ? `<div style="font-size:0.78rem;color:var(--suave);margin-top:3px;">${p.direccion}</div>` : ''}
      ${(p.colonia || p.codigoPostal) ? `<div style="font-size:0.74rem;color:var(--suave);">${p.colonia||''} ${p.codigoPostal?'· CP '+p.codigoPostal:''}</div>` : ''}
      ${p.telefono ? `<div style="font-size:0.78rem;color:var(--suave);">${p.telefono}</div>` : ''}
      ${p.distanciaMetros > 0 ? `<div style="font-size:0.72rem;color:#888;margin-top:3px;">A ${Math.round(p.distanciaMetros)}m de la planta</div>` : ''}
      ${p.lat && p.lng ? `<a href="https://www.google.com/maps?q=${p.lat},${p.lng}" target="_blank" style="display:inline-block;margin-top:6px;background:#0d2d0d;border:1px solid #2a5a2a;border-radius:6px;padding:4px 10px;font-size:0.7rem;font-weight:700;color:#4caf50;text-decoration:none;">Abrir en Maps</a>` : ''}
    </div>

    <!-- Info de seguimiento -->
    <div style="background:var(--gris2);border-radius:12px;padding:12px;margin-bottom:10px;">
      <div style="font-size:0.66rem;font-weight:800;color:#555;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Seguimiento</div>
      <div style="font-size:0.8rem;color:var(--blanco);">
        <strong style="color:var(--amarillo);">${p.numContactos}</strong> contacto(s) · Último: <strong>${ult}</strong>
      </div>
      ${p.nombreVendedor
        ? `<div style="font-size:0.78rem;color:var(--suave);margin-top:3px;">Asignado: <strong style="color:var(--amarillo);">${p.nombreVendedor}</strong></div>`
        : `<div style="font-size:0.74rem;color:#888;font-style:italic;margin-top:3px;">Sin vendedor asignado</div>`}
    </div>

    <!-- Notas -->
    ${p.notas ? `
      <div style="background:var(--gris2);border-radius:12px;padding:12px;margin-bottom:10px;">
        <div style="font-size:0.66rem;font-weight:800;color:#555;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Notas</div>
        <div style="font-size:0.8rem;color:var(--blanco);white-space:pre-wrap;line-height:1.5;">${p.notas}</div>
      </div>` : ''}

    ${descartado && p.motivoDescarte ? `
      <div style="background:#2d0d0d;border:1px solid var(--rojo);border-radius:12px;padding:10px;margin-bottom:10px;font-size:0.78rem;color:var(--rojo);">
        Descartado: ${p.motivoDescarte}
      </div>` : ''}

    <div id="pros-visitas-hist" style="margin-bottom:10px;"></div>

    <!-- Acciones -->
    ${!descartado && !yaConvertido ? `
      <div id="pros-acciones" style="display:flex;flex-direction:column;gap:8px;">
        <button onclick="accionRegistrarVisita(${p.id})" style="min-height:44px;background:var(--amarillo);border:none;border-radius:10px;padding:11px;font-family:'Inter',sans-serif;font-weight:900;font-size:0.86rem;color:var(--negro);cursor:pointer;">
          Registrar visita
        </button>
      </div>
      <div id="pros-visita-hoja" hidden style="background:var(--gris2);border-radius:12px;padding:12px;">
        <div style="font-size:0.66rem;font-weight:800;color:var(--suave);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">¿Qué pasó en la visita?</div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${RESULTADOS_VISITA.map(r => `<button onclick="elegirResultadoVisita(${p.id}, '${r.codigo}')" style="min-height:44px;text-align:left;background:transparent;border:1px solid ${r.descarta ? 'var(--rojo)' : (r.codigo === 'convertido' ? '#4caf50' : 'var(--gris3)')};border-radius:10px;padding:10px 12px;font-family:'Inter',sans-serif;font-weight:700;font-size:0.84rem;color:var(--blanco);cursor:pointer;">${r.etiqueta}${r.descarta ? '<span style="display:block;font-size:0.7rem;font-weight:600;color:var(--suave);margin-top:2px;">Sale de la ruta</span>' : ''}</button>`).join('')}
        </div>
        ${!p.telefono ? `<label for="visita-telefono" style="display:block;font-size:0.72rem;color:var(--suave);margin:10px 0 4px;">Teléfono del cliente, solo si se convierte</label>
        <input id="visita-telefono" type="tel" inputmode="numeric" maxlength="10" placeholder="10 dígitos" style="width:100%;min-height:44px;background:var(--gris3);border:1px solid #444;border-radius:8px;padding:8px 10px;color:var(--blanco);font-family:'Inter',sans-serif;font-size:0.9rem;">` : ''}
        <label for="visita-nota" style="display:block;font-size:0.72rem;color:var(--suave);margin:10px 0 4px;">Nota de la visita (opcional)</label>
        <textarea id="visita-nota" rows="2" style="width:100%;background:var(--gris3);border:1px solid #444;border-radius:8px;padding:8px 10px;color:var(--blanco);font-family:'Inter',sans-serif;font-size:0.86rem;resize:vertical;"></textarea>
        <button onclick="cancelarVisita()" style="margin-top:8px;width:100%;min-height:44px;background:transparent;border:1px solid #333;border-radius:10px;font-family:'Inter',sans-serif;font-weight:700;font-size:0.8rem;color:var(--suave);cursor:pointer;">Cancelar</button>
      </div>
    ` : descartado ? `
      <button onclick="accionReactivarProspecto(${p.id})" style="width:100%;background:transparent;border:1px solid var(--amarillo);border-radius:10px;padding:11px;font-family:'Inter',sans-serif;font-weight:800;font-size:0.84rem;color:var(--amarillo);cursor:pointer;">
        ↩️ Reactivar prospecto
      </button>
    ` : `
      <div style="background:#0d2d0d;border:1px solid #4caf50;border-radius:10px;padding:11px;text-align:center;font-weight:800;color:#4caf50;font-size:0.84rem;">
        Convertido a cliente${p.idClienteConvertido ? ' #' + p.idClienteConvertido : ''}
      </div>
    `}

    <button onclick="cerrarDetalleProspecto()" style="width:100%;background:transparent;border:1px solid #333;border-radius:10px;padding:10px;font-family:'Inter',sans-serif;font-weight:700;font-size:0.82rem;color:var(--suave);cursor:pointer;margin-top:10px;">
      Cerrar
    </button>
  `;
  cargarHistorialVisitas(p.id);
};

window.cerrarDetalleProspecto = function() {
  document.getElementById('overlay-prospecto').classList.remove('visible');
  document.getElementById('drawer-prospecto').classList.remove('open');
};
document.addEventListener('click', e => {
  const ov = document.getElementById('overlay-prospecto');
  if (e.target === ov) cerrarDetalleProspecto();
});

// ──────────────────────────────────────────
// ACCIONES
// ──────────────────────────────────────────
// ── Mi ruta de hoy (Ruta del día, entrega 2) ─────────────────────────────────
// El servidor (ruta_del_dia) decide las paradas, su orden y el avance: aquí solo
// se pintan, se filtra por ruta y día (dueño) y se registran visitas. Cada
// vendedor ve solo su ruta; el dueño y los socios eligen cualquiera.
const RESULTADOS_VISITA_CLIENTE = [
  { codigo: 'pedido',      etiqueta: 'Levantó pedido' },
  { codigo: 'no_necesita', etiqueta: 'No necesita resurtido' },
  { codigo: 'no_estaba',   etiqueta: 'No estaba el encargado' },
];
window._rutaDia = null;
const RUTA_DIA_NOMBRE = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const rutaEsc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

async function renderRuta() {
  const cab = document.getElementById('ruta-cabecera');
  const lista = document.getElementById('mr-paradas');
  const filtros = document.getElementById('ruta-filtros');
  const sel = document.getElementById('ruta-sel');
  const fecha = document.getElementById('ruta-fecha');
  if (!cab || !lista) return;
  lista.innerHTML = '<div style="text-align:center;color:var(--suave);padding:20px;"><span class="loader"></span> Cargando tu ruta…</div>';
  const payload = {};
  if (filtros && filtros.style.display !== 'none') {
    if (sel && sel.value) payload.idRuta = Number(sel.value);
    if (fecha && fecha.value) payload.fecha = fecha.value;
  }
  let r = null;
  try { r = await supabaseCall('POST', 'rpc/ruta_del_dia', { p_data: payload }); }
  catch (e) { r = { ok: false, error: e.message }; }
  if (!r || !r.ok) {
    cab.innerHTML = '';
    lista.innerHTML = `<div style="background:var(--gris);border-radius:14px;padding:16px;color:var(--suave);font-size:0.86rem;">No se pudo cargar la ruta: ${rutaEsc((r && r.error) || 'sin respuesta')}</div>`;
    return;
  }
  window._rutaDia = r;
  if (r.veTodas && filtros && filtros.style.display === 'none') {
    if (!window._rutasCache) await cargarRutasCache();
    sel.innerHTML = '<option value="">La que toca ese día</option>' + (window._rutasCache || []).map(x => `<option value="${x.id}">${rutaEsc(x.nombre)}</option>`).join('');
    fecha.value = r.fecha;
    filtros.style.display = 'flex';
  }
  pintarRutaDia();
}
window.rutaDiaCambiar = function() { renderRuta(); };

function pintarRutaDia() {
  const r = window._rutaDia;
  const cab = document.getElementById('ruta-cabecera');
  const lista = document.getElementById('mr-paradas');
  if (!r || !cab || !lista) return;
  if (!r.ruta) {
    cab.innerHTML = '';
    const prox = r.proximaFecha ? new Date(r.proximaFecha + 'T12:00:00') : null;
    lista.innerHTML = `<div style="background:var(--gris);border:1px dashed var(--gris3);border-radius:14px;padding:18px;text-align:center;color:var(--suave);font-size:0.86rem;">No hay ruta para este día.${prox ? ' La siguiente es el ' + RUTA_DIA_NOMBRE[prox.getDay()] + ' ' + prox.getDate() + '.' : ''}</div>`;
    return;
  }
  const a = r.avance || {};
  const pct = a.programadas ? Math.round(100 * (a.visitadas || 0) / a.programadas) : 0;
  const f = new Date(r.fecha + 'T12:00:00');
  const paradas = r.paradas || [];
  const hayPendientes = paradas.some(p => !p.visitadaHoy && p.lat != null && p.lng != null);
  cab.innerHTML = `
    <div style="background:var(--gris);border-radius:14px;padding:14px;margin-bottom:12px;border-left:4px solid ${rutaEsc(r.ruta.color || '#ffd200')};">
      <div style="font-family:'Archivo',sans-serif;font-size:1.1rem;color:var(--blanco);">${rutaEsc(r.ruta.nombre)}</div>
      <div style="color:var(--suave);font-size:0.78rem;margin-top:2px;">${RUTA_DIA_NOMBRE[f.getDay()]} ${f.getDate()} · ${r.ruta.vendedor ? rutaEsc(r.ruta.vendedor) : 'sin vendedor asignado'}</div>
      <div role="progressbar" aria-label="Avance del día" aria-valuemin="0" aria-valuemax="${a.programadas || 0}" aria-valuenow="${a.visitadas || 0}" style="margin-top:10px;height:8px;background:var(--gris3);border-radius:999px;overflow:hidden;"><div style="height:100%;width:${pct}%;background:var(--amarillo);"></div></div>
      <div style="margin-top:6px;font-size:0.84rem;color:var(--blanco);font-variant-numeric:tabular-nums;"><b>${a.visitadas || 0} de ${a.programadas || 0}</b> visitadas · ${a.convertidas || 0} convertidas${a.fueraDelPunto ? ' · <span style="color:var(--rojo);">' + a.fueraDelPunto + ' fuera del punto</span>' : ''}</div>
      ${hayPendientes ? '<button type="button" onclick="abrirRecorridoRuta()" style="margin-top:10px;width:100%;min-height:44px;background:transparent;border:1px solid var(--amarillo);border-radius:10px;color:var(--amarillo);font-family:\'Inter\',sans-serif;font-weight:800;font-size:0.84rem;cursor:pointer;">Abrir recorrido en Google Maps</button>' : ''}
    </div>`;
  const CHECK = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  const fila = (p) => {
    const accion = p.tipo === 'cliente' ? `abrirVisitaCliente(${p.id})` : `abrirParadaProspecto(${p.id})`;
    // El discurso cambia: a una parada NUEVA nadie la ha visitado; a una ya
    // visitada se vuelve con lo que pasó la última vez, aunque no haya comprado.
    const nuevo = !p.ultimaVisita && !p.visitadaHoy;
    const detalle = p.visitadaHoy
      ? rutaEsc(p.etiquetaHoy || '')
      : (nuevo ? '<b style="color:var(--amarillo);">NUEVO</b> · primera visita'
               : 'ya visitado ' + new Date(p.ultimaVisita).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' })
                 + (p.ultimoResultado ? ' · ' + rutaEsc((RESULTADOS_VISITA.concat(RESULTADOS_VISITA_CLIENTE).find(r => r.codigo === p.ultimoResultado) || {}).etiqueta || p.ultimoResultado) : ''));
    return `
    <button type="button" onclick="${accion}" aria-label="Parada ${p.orden}: ${rutaEsc(p.nombre)}${p.visitadaHoy ? ', visitada' : ''}" style="display:flex;align-items:center;gap:10px;width:100%;min-height:56px;text-align:left;background:var(--gris);border:1px solid ${p.visitadaHoy ? '#2e5a34' : 'var(--gris3)'};border-radius:12px;padding:10px 12px;margin-bottom:8px;color:var(--blanco);font-family:'Inter',sans-serif;cursor:pointer;">
      <span style="flex:0 0 30px;height:30px;border-radius:999px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:0.8rem;background:${p.visitadaHoy ? '#4caf50' : 'var(--gris3)'};color:${p.visitadaHoy ? '#000' : 'var(--blanco)'};">${p.visitadaHoy ? CHECK : p.orden}</span>
      <span style="min-width:0;flex:1 1 auto;">
        <span style="display:block;font-weight:700;font-size:0.88rem;overflow-wrap:anywhere;">${rutaEsc(p.nombre || 'Sin nombre')}</span>
        <span style="display:block;color:var(--suave);font-size:0.72rem;">${rutaEsc(p.colonia || '')}${p.colonia ? ' · ' : ''}${detalle}${p.fueraDelPunto ? ' · <span style="color:var(--rojo);">fuera del punto</span>' : ''}</span>
      </span>
    </button>`;
  };
  const bloque = (titulo, arr) => arr.length
    ? `<div style="font-size:0.72rem;font-weight:800;color:var(--suave);text-transform:uppercase;letter-spacing:1px;margin:14px 0 8px;">${titulo} (${arr.filter(x => x.visitadaHoy).length} de ${arr.length})</div>${arr.map(fila).join('')}`
    : '';
  const html = bloque('Clientes', paradas.filter(p => p.tipo === 'cliente')) + bloque('Prospectos', paradas.filter(p => p.tipo === 'prospecto'));
  lista.innerHTML = html || '<div style="background:var(--gris);border-radius:14px;padding:16px;color:var(--suave);font-size:0.86rem;">Esta ruta no tiene paradas para este día.</div>';
}

// El detalle del prospecto usa la lista de Prospección: si no está cargada, se carga.
window.abrirParadaProspecto = async function(id) {
  // La lista de Prospección trae solo los prospectos con vendedor asignado; los
  // de la ruta sin visitar no lo tienen. Se piden por id con la regla del servidor.
  if (!_prospectos.some(x => String(x.id) === String(id))) {
    try {
      const r = await supabaseCall('POST', 'rpc/obtener_prospecto', { p_data: { id: Number(id) } });
      if (!r || !r.ok || !r.prospecto) {
        await avisar({ titulo: 'No se pudo abrir el prospecto', cuerpo: (r && r.error) || 'Sin respuesta' });
        return;
      }
      _prospectos.push(normalizarProspecto(r.prospecto));
    } catch (e) {
      await avisar({ titulo: 'No se pudo abrir el prospecto', cuerpo: (e && e.message) || '' });
      return;
    }
  }
  verDetalleProspecto(id);
};

window.abrirVisitaCliente = function(id) {
  const p = ((window._rutaDia && window._rutaDia.paradas) || []).find(x => x.tipo === 'cliente' && String(x.id) === String(id));
  const hoja = document.getElementById('ruta-hoja');
  if (!p || !hoja) return;
  hoja.innerHTML = `
    <div style="font-family:'Archivo',sans-serif;font-size:1rem;color:var(--blanco);">${rutaEsc(p.nombre)}</div>
    <div style="color:var(--suave);font-size:0.74rem;margin:2px 0 10px;">Cliente${p.colonia ? ' · ' + rutaEsc(p.colonia) : ''}${p.visitadaHoy ? ' · ya visitado hoy: ' + rutaEsc(p.etiquetaHoy || '') : ''}</div>
    <div style="font-size:0.66rem;font-weight:800;color:var(--suave);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">¿Qué pasó en la visita?</div>
    <div style="display:flex;flex-direction:column;gap:6px;">
      ${RESULTADOS_VISITA_CLIENTE.map(r => `<button type="button" onclick="registrarVisitaCliente(${p.id}, '${r.codigo}')" style="min-height:44px;text-align:left;background:transparent;border:1px solid ${r.codigo === 'pedido' ? '#4caf50' : 'var(--gris3)'};border-radius:10px;padding:10px 12px;font-family:'Inter',sans-serif;font-weight:700;font-size:0.84rem;color:var(--blanco);cursor:pointer;">${r.etiqueta}</button>`).join('')}
    </div>
    <label for="ruta-visita-nota" style="display:block;font-size:0.72rem;color:var(--suave);margin:10px 0 4px;">Nota de la visita (opcional)</label>
    <textarea id="ruta-visita-nota" rows="2" style="width:100%;background:var(--gris3);border:1px solid #444;border-radius:8px;padding:8px 10px;color:var(--blanco);font-family:'Inter',sans-serif;font-size:0.86rem;resize:vertical;"></textarea>
    <button type="button" onclick="cerrarHojaRuta()" style="margin-top:8px;width:100%;min-height:44px;background:transparent;border:1px solid #333;border-radius:10px;font-family:'Inter',sans-serif;font-weight:700;font-size:0.8rem;color:var(--suave);cursor:pointer;">Cancelar</button>`;
  hoja.hidden = false;
};

window.cerrarHojaRuta = function() {
  const h = document.getElementById('ruta-hoja');
  if (h) { h.hidden = true; h.innerHTML = ''; }
};

let _visitaClienteEnCurso = false;
window.registrarVisitaCliente = async function(id, codigo) {
  if (_visitaClienteEnCurso) return;
  const r = RESULTADOS_VISITA_CLIENTE.find(x => x.codigo === codigo);
  if (!r) return;
  const nota = (document.getElementById('ruta-visita-nota')?.value || '').trim();
  _visitaClienteEnCurso = true;
  try {
    mostrarToast('Tomando tu ubicación…');
    const u = await ubicacionParaVisita();
    if (u.error) {
      await avisar({ titulo: 'Sin ubicación no se registra la visita', cuerpo: u.error });
      return;
    }
    const res = await supabaseCall('POST', 'rpc/registrar_visita', {
      p_data: { idCliente: id, resultado: codigo, nota, lat: u.lat, lng: u.lng, precision: u.precision }
    });
    if (!res || !res.ok) {
      await avisar({ titulo: 'No se pudo registrar la visita', cuerpo: (res && res.error) || 'Sin respuesta' });
      return;
    }
    cerrarHojaRuta();
    if (res.fueraDelPunto) {
      await avisar({ titulo: 'Visita registrada fuera del punto', cuerpo: `Estás a ${res.distanciaMetros} m del cliente. La visita quedó marcada para revisión.` });
    } else {
      mostrarToast(`Visita registrada: ${r.etiqueta}`);
    }
    renderRuta();
  } catch (e) {
    await avisar({ titulo: 'No se pudo registrar la visita', cuerpo: (e && e.message) || '' });
  } finally {
    _visitaClienteEnCurso = false;
  }
};

// Las siguientes paradas pendientes, hasta 10, en Google Maps. Sin origen: el
// teléfono usa su ubicación actual. Sin await antes de abrir la pestaña.
window.abrirRecorridoRuta = function() {
  const pend = ((window._rutaDia && window._rutaDia.paradas) || [])
    .filter(p => !p.visitadaHoy && p.lat != null && p.lng != null).slice(0, 10);
  if (!pend.length) return;
  const destino = pend[pend.length - 1];
  const intermedios = pend.slice(0, -1).map(p => p.lat + ',' + p.lng).join('|');
  const url = 'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' + destino.lat + ',' + destino.lng
    + (intermedios ? '&waypoints=' + encodeURIComponent(intermedios) : '');
  window.open(url, '_blank');
};

// ── Reparto y Mis entregas (Reparto P1, 17 sep 2026) ────────────────────────
// El servidor (reparto_del_dia) arma los bloques del día y decide qué ve cada
// quien: el dueño todo; el vendedor con ruta su ruta; la familia sus consumidores.
// «Salir a ruta» y «Entregado» pasan por la función de estatus de siempre.
window._reparto = null;

function repartoFila(p, acciones) {
  const pagado = (p.estatusPago || '') === 'Pagado';
  const est = p.estatusPedido === 'Entregado' ? '<span style="color:#4caf50;font-weight:800;">Entregado</span>'
    : p.estatusPedido === 'En camino' ? '<span style="color:var(--amarillo);font-weight:800;">En camino</span>' : '';
  // La marca de Armado solo importa antes de salir: en camino o entregado ya no se enseña.
  const armado = p.estatusPedido !== 'En proceso' ? '' : (p.armadoEn ? 'armado' : '<span style="color:var(--rojo);">sin armar</span>');
  const dist = p.entregaDistanciaM != null ? (p.entregaFueraDelPunto
    ? `<span style="color:var(--rojo);">fuera del punto, a ${p.entregaDistanciaM} m</span>` : `a ${p.entregaDistanciaM} m`) : '';
  return `<div style="display:flex;gap:10px;align-items:center;min-height:56px;padding:8px 0;border-bottom:1px solid var(--gris3);">
    <div style="flex:1;min-width:0;cursor:pointer;" onclick="verDetallePedido(${p.id})">
      <div style="font-weight:800;color:var(--blanco);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${rutaEsc(p.consecutivo || '')} · ${rutaEsc(p.cliente || '')}</div>
      <div style="font-size:0.76rem;color:var(--suave);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${rutaEsc(p.colonia || p.direccion || '')} · $${Number(p.total || 0).toLocaleString('es-MX')}${pagado ? '' : ' · <b style="color:var(--amarillo);">cobrar</b>'}${armado ? ' · ' + armado : ''}${est ? ' · ' + est : ''}${dist ? ' · ' + dist : ''}</div>
    </div>
    ${acciones || ''}
  </div>`;
}

function repartoBotonEntregar(p) {
  if (p.estatusPedido === 'Entregado') return '';
  if (p.metodoEntrega === 'paqueteria') return p.estatusPedido === 'En camino' ? '' : `<button onclick="repartoEnviado(${p.id})" style="min-height:44px;background:var(--gris2);border:1px solid var(--gris3);border-radius:10px;padding:0 12px;color:var(--blanco);font-weight:800;">Enviado</button>`;
  return `<button onclick="repartoEntregar(${p.id})" style="min-height:44px;background:var(--amarillo);border:none;border-radius:10px;padding:0 12px;color:var(--negro);font-weight:800;">Entregado</button>`;
}

function repartoBloque(titulo, pedidos, clave, conSalir) {
  const pend = pedidos.filter(p => p.estatusPedido === 'En proceso').map(p => p.id);
  const sinArmar = pedidos.filter(p => !p.armadoEn && p.estatusPedido === 'En proceso').length;
  const ent = pedidos.filter(p => p.estatusPedido === 'Entregado').length;
  const salir = conSalir && pend.length ? `<button onclick="repartoSalir('${pend.join(',')}', ${sinArmar})" style="min-height:44px;background:var(--amarillo);border:none;border-radius:10px;padding:0 14px;color:var(--negro);font-weight:800;">Salir a ruta</button>` : '';
  const rec = pedidos.some(p => p.estatusPedido !== 'Entregado' && p.lat != null) ? `<button onclick="repartoRecorrido('${clave}')" style="min-height:44px;background:var(--gris2);border:1px solid var(--gris3);border-radius:10px;padding:0 12px;color:var(--blanco);font-weight:800;">Recorrido</button>` : '';
  return `<div style="background:var(--gris);border-radius:14px;padding:12px 14px;margin-bottom:12px;">
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px;">
      <div style="flex:1 1 170px;min-width:0;"><div style="font-family:'Archivo',sans-serif;color:var(--blanco);">${titulo}</div>
        <div style="font-size:0.76rem;color:var(--suave);">${pedidos.length} pedidos · ${ent} entregados${sinArmar ? ` · <span style="color:var(--rojo);">${sinArmar} sin armar</span>` : ''}</div></div>
      ${rec}${salir}
    </div>
    ${pedidos.map(p => repartoFila(p, repartoBotonEntregar(p))).join('')}
  </div>`;
}

async function renderReparto() {
  const cuerpo = document.getElementById('reparto-cuerpo');
  const fecha = document.getElementById('reparto-fecha');
  if (!cuerpo) return;
  cuerpo.innerHTML = '<div style="text-align:center;color:var(--suave);padding:20px;"><span class="loader"></span> Cargando el reparto…</div>';
  const payload = {};
  if (fecha && fecha.value) payload.fecha = fecha.value;
  let r = null;
  try { r = await supabaseCall('POST', 'rpc/reparto_del_dia', { p_data: payload }); } catch (e) { r = { ok: false, error: e.message }; }
  if (!r || !r.ok) { cuerpo.innerHTML = `<div style="background:var(--gris);border-radius:14px;padding:16px;color:var(--suave);">No se pudo cargar el reparto: ${rutaEsc((r && r.error) || 'Sin respuesta')}</div>`; return; }
  window._reparto = r;
  if (fecha && !fecha.value) fecha.value = r.fecha;
  let html = '';
  for (const ru of r.rutas) html += repartoBloque(rutaEsc(ru.nombre), ru.pedidos, 'ruta:' + ru.id, true);
  for (const g of r.consumidores) html += repartoBloque('Consumidores · ' + rutaEsc(g.nombre || 'sin repartidor'), g.pedidos, 'cons:' + g.idRepartidor, true);
  if (r.paqueteria.length) html += repartoBloque('Paquetería', r.paqueteria, 'paq', false);
  if (r.sinRuta.length) html += repartoBloque('Sin ruta', r.sinRuta, 'sin', false);
  if (!html) html = `<div style="background:var(--gris);border:1px dashed var(--gris3);border-radius:14px;padding:18px;text-align:center;color:var(--suave);">Nada que repartir ese día.</div>`;
  if (r.porConfirmar) html += `<div style="font-size:0.8rem;color:var(--suave);text-align:center;margin-top:4px;">${r.porConfirmar} por confirmar, fuera del reparto hasta confirmarse.</div>`;
  cuerpo.innerHTML = html;
}
window.renderReparto = renderReparto;
window.repartoCambiar = function() { renderReparto(); };

function repartoPedidosDe(clave) {
  const r = window._reparto; if (!r) return [];
  if (clave.startsWith('ruta:')) return (r.rutas.find(x => String(x.id) === clave.slice(5)) || {}).pedidos || [];
  if (clave.startsWith('cons:')) return (r.consumidores.find(x => String(x.idRepartidor) === clave.slice(5)) || {}).pedidos || [];
  if (clave === 'paq') return r.paqueteria;
  if (clave === 'sin') return r.sinRuta;
  if (clave === 'entregas') return window._entregasDia || r.consumidores.flatMap(g => g.pedidos);
  return [];
}

window.repartoRecorrido = function(clave) {
  const pend = repartoPedidosDe(clave).filter(p => p.estatusPedido !== 'Entregado' && p.lat != null && p.lng != null).slice(0, 10);
  if (!pend.length) return;
  const destino = pend[pend.length - 1];
  const intermedios = pend.slice(0, -1).map(p => p.lat + ',' + p.lng).join('|');
  window.open('https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' + destino.lat + ',' + destino.lng + (intermedios ? '&waypoints=' + encodeURIComponent(intermedios) : ''), '_blank');
};

function repartoRefrescar() {
  const ent = document.getElementById('s-entregas');
  if (ent && ent.classList.contains('active')) renderEntregas(); else renderReparto();
}

window.repartoSalir = async function(idsCsv, sinArmar) {
  const ids = String(idsCsv).split(',').map(Number).filter(Boolean);
  if (!ids.length) return;
  if (sinArmar > 0) {
    const sigue = await confirmar({ titulo: 'Hay pedidos sin armar', cuerpo: `${sinArmar} de estos pedidos no tienen la marca de Armado. ¿Salir de todos modos?`, aceptar: 'Salir', cancelar: 'Esperar' });
    if (!sigue) return;
  }
  const r = await supabaseCall('POST', 'rpc/salir_a_ruta', { p_data: { ids } });
  if (!r || !r.ok) { await avisar({ titulo: 'No se pudo salir a ruta', cuerpo: (r && r.error) || 'Sin respuesta' }); return; }
  mostrarToast(`${r.cambiados} en camino${r.rechazados.length ? ` · ${r.rechazados.length} sin cambiar` : ''}`);
  repartoRefrescar();
};

window.repartoEntregar = async function(id) {
  const u = await ubicacionParaVisita();
  if (u.error) { await avisar({ titulo: 'Sin ubicación no se marca la entrega', cuerpo: u.error }); return; }
  const r = await supabaseCall('POST', 'rpc/entregar_pedido', { p_data: { id, lat: u.lat, lng: u.lng } });
  if (!r || !r.ok) { await avisar({ titulo: 'No se pudo marcar la entrega', cuerpo: (r && r.error) || 'Sin respuesta' }); return; }
  mostrarToast(r.fueraDelPunto ? `Entregado, fuera del punto (${r.distanciaM} m)` : `Entregado a ${r.distanciaM} m`);
  repartoRefrescar();
};

window.repartoEnviado = async function(id) {
  const r = await supabaseCall('POST', 'rpc/entregar_pedido', { p_data: { id, enviado: true } });
  if (!r || !r.ok) { await avisar({ titulo: 'No se pudo marcar el envío', cuerpo: (r && r.error) || 'Sin respuesta' }); return; }
  mostrarToast('Enviado por paquetería');
  repartoRefrescar();
};

// Mis entregas (familia): solo sus consumidores, ordenados desde el teléfono si da ubicación.
window._entregasDia = null;
async function renderEntregas() {
  const cab = document.getElementById('entregas-cabecera');
  const lista = document.getElementById('entregas-lista');
  if (!cab || !lista) return;
  lista.innerHTML = '<div style="text-align:center;color:var(--suave);padding:20px;"><span class="loader"></span> Cargando tus entregas…</div>';
  let r = null;
  try { r = await supabaseCall('POST', 'rpc/reparto_del_dia', { p_data: {} }); } catch (e) { r = { ok: false, error: e.message }; }
  if (!r || !r.ok) { cab.innerHTML = ''; lista.innerHTML = `<div style="background:var(--gris);border-radius:14px;padding:16px;color:var(--suave);">No se pudieron cargar tus entregas: ${rutaEsc((r && r.error) || 'Sin respuesta')}</div>`; return; }
  window._reparto = r;
  let pedidos = r.consumidores.flatMap(g => g.pedidos);
  // Orden desde donde está el teléfono; sin ubicación se queda el orden del servidor (desde la planta).
  const aqui = await new Promise(res => { if (!navigator.geolocation) return res(null); navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lng: p.coords.longitude }), () => res(null), { timeout: 5000, maximumAge: 60000 }); });
  if (aqui) {
    const d = (a, b) => { const rad = x => x * Math.PI / 180; const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2; return 2 * 6371000 * Math.asin(Math.sqrt(h)); };
    const con = pedidos.filter(p => p.lat != null), sin = pedidos.filter(p => p.lat == null), orden = []; let cur = aqui;
    while (con.length) { let bi = 0; for (let i = 1; i < con.length; i++) if (d(cur, con[i]) < d(cur, con[bi])) bi = i; cur = con[bi]; orden.push(con.splice(bi, 1)[0]); }
    pedidos = orden.concat(sin);
  }
  window._entregasDia = pedidos;
  const ent = pedidos.filter(p => p.estatusPedido === 'Entregado').length;
  const pend = pedidos.filter(p => p.estatusPedido === 'En proceso').map(p => p.id);
  const f = new Date(r.fecha + 'T12:00:00');
  cab.innerHTML = `<div style="background:var(--gris);border-radius:14px;padding:12px 14px;margin-bottom:12px;">
    <div style="font-family:'Archivo',sans-serif;color:var(--blanco);">${RUTA_DIA_NOMBRE[f.getDay()]} ${f.getDate()} · ${pedidos.length} entregas · ${ent} entregada${ent === 1 ? '' : 's'}</div>
    <div style="display:flex;gap:8px;margin-top:8px;">
      ${pend.length ? `<button onclick="repartoSalir('${pend.join(',')}', 0)" style="flex:1;min-height:44px;background:var(--amarillo);border:none;border-radius:10px;color:var(--negro);font-weight:800;">Salir</button>` : ''}
      ${pedidos.some(p => p.estatusPedido !== 'Entregado' && p.lat != null) ? `<button onclick="repartoRecorrido('entregas')" style="flex:1;min-height:44px;background:var(--gris2);border:1px solid var(--gris3);border-radius:10px;color:var(--blanco);font-weight:800;">Recorrido</button>` : ''}
    </div></div>`;
  lista.innerHTML = pedidos.length ? pedidos.map(p => repartoFila(p, repartoBotonEntregar(p))).join('')
    : `<div style="background:var(--gris);border:1px dashed var(--gris3);border-radius:14px;padding:18px;text-align:center;color:var(--suave);">No tienes entregas hoy.</div>`;
}
window.renderEntregas = renderEntregas;

// Tarjeta del pedido: «Reparte: …» con selector solo para el dueño y solo en consumidores.
window._vendedoresReparto = null;
window.asignarRepartidor = async function(id, sel) {
  const r = await supabaseCall('POST', 'rpc/asignar_repartidor', { p_data: { id, idRepartidor: sel.value ? Number(sel.value) : null } });
  if (!r || !r.ok) { await avisar({ titulo: 'No se pudo cambiar quién reparte', cuerpo: (r && r.error) || 'Sin respuesta' }); return; }
  mostrarToast(r.repartidor ? `Reparte ${r.repartidor}` : 'Reparte el vendedor del pedido');
  if (N._pedidoActual && N._pedidoActual.orden && String(N._pedidoActual.orden.id) === String(id)) N._pedidoActual.orden.id_repartidor = r.idRepartidor;
};

// ── Visitas con resultado (Ruta del día, entrega 1, 16 sep 2026) ────────────
// Cada visita es un renglón en `visitas` que nunca se borra, con resultado de
// catálogo y la ubicación del teléfono. Sin ubicación no hay visita; a más de
// 100 m de la tienda queda marcada «fuera del punto». Sustituye a los prompt()
// de antes, que borraban la nota anterior y guardaban el motivo como texto libre.
const RESULTADOS_VISITA = [
  { codigo: 'convertido',         etiqueta: 'Convertido',              descarta: false },
  { codigo: 'interesado',         etiqueta: 'Interesado, volver',      descarta: false },
  { codigo: 'no_estaba',          etiqueta: 'No estaba el encargado',  descarta: false },
  { codigo: 'ya_tiene_proveedor', etiqueta: 'Ya tiene proveedor',      descarta: false },
  { codigo: 'caro',               etiqueta: 'Le pareció caro',         descarta: false },
  { codigo: 'no_le_interesa',     etiqueta: 'No le interesa',          descarta: true  },
  { codigo: 'ya_no_existe',       etiqueta: 'Ya no existe el negocio', descarta: true  },
];

// Ubicación fresca (maximumAge 0): una posición de hace un minuto puede ser la
// de la tienda anterior.
function ubicacionParaVisita() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({ error: 'Este teléfono no da ubicación.' });
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, precision: Math.round(pos.coords.accuracy || 0) }),
      (err) => resolve({ error: (err && err.code === 1)
        ? 'La ubicación está bloqueada para este sitio. Actívala en los permisos del navegador y vuelve a intentarlo.'
        : 'No se pudo obtener la ubicación. Sal a un lugar abierto y vuelve a intentarlo.' }),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });
}

window.accionRegistrarVisita = function(id) {
  const acc = document.getElementById('pros-acciones');
  const hoja = document.getElementById('pros-visita-hoja');
  if (acc) acc.style.display = 'none';
  if (hoja) hoja.hidden = false;
};

window.cancelarVisita = function() {
  const acc = document.getElementById('pros-acciones');
  const hoja = document.getElementById('pros-visita-hoja');
  if (hoja) hoja.hidden = true;
  if (acc) acc.style.display = 'flex';
};

let _visitaEnCurso = false;
window.elegirResultadoVisita = async function(id, codigo) {
  if (_visitaEnCurso) return;
  const p = _prospectos.find(x => String(x.id) === String(id));
  const r = RESULTADOS_VISITA.find(x => x.codigo === codigo);
  if (!p || !r) return;
  const nota = (document.getElementById('visita-nota')?.value || '').trim();
  const telefono = String(p.telefono || document.getElementById('visita-telefono')?.value || '').replace(/\D/g, '');

  if (r.codigo === 'convertido') {
    if (telefono.length !== 10) {
      await avisar({ titulo: 'Falta el teléfono', cuerpo: 'Para convertir a cliente escribe su teléfono de 10 dígitos.' });
      return;
    }
    if (!(await confirmar({ titulo: `Convertir "${p.nombre}" a cliente`, cuerpo: 'Se creará en la lista de clientes B2B y la visita quedará como «Convertido».', aceptar: 'Convertir' }))) return;
  }
  if (r.descarta) {
    if (!(await confirmar({ titulo: `«${r.etiqueta}»`, cuerpo: `"${p.nombre}" sale de la ruta. Se puede reactivar después.`, aceptar: 'Registrar y sacar de la ruta', cancelar: 'Volver', peligroso: true }))) return;
  }

  _visitaEnCurso = true;
  try {
    // La ubicación va ANTES de convertir: sin ella no se escribe nada.
    mostrarToast('Tomando tu ubicación…');
    const u = await ubicacionParaVisita();
    if (u.error) {
      await avisar({ titulo: 'Sin ubicación no se registra la visita', cuerpo: u.error });
      return;
    }

    let idCliente = null;
    if (r.codigo === 'convertido') {
      const c = await supabaseCall('POST', 'rpc/convertir_prospecto_a_cliente', {
        p_data: { id, telefono, idVendedor: N.vendedorInfo?.id || null, nombreVendedor: N.vendedorInfo?.nombre || '' }
      });
      if (!c || !c.ok) {
        await avisar({ titulo: 'No se pudo convertir el prospecto', cuerpo: (c && c.error) || 'Sin respuesta' });
        return;
      }
      idCliente = c.idCliente;
    }

    const res = await supabaseCall('POST', 'rpc/registrar_visita', {
      p_data: { idProspecto: id, resultado: r.codigo, nota, lat: u.lat, lng: u.lng, precision: u.precision, idCliente }
    });
    if (!res || !res.ok) {
      await avisar({ titulo: 'No se pudo registrar la visita', cuerpo: (res && res.error) || 'Sin respuesta' });
      return;
    }

    if (res.fueraDelPunto) {
      await avisar({ titulo: 'Visita registrada fuera del punto', cuerpo: `Estás a ${res.distanciaMetros} m de la tienda. La visita quedó marcada para revisión.` });
    } else {
      mostrarToast(`Visita registrada: ${r.etiqueta}`);
    }
    cerrarDetalleProspecto();
    renderProspeccion();
    if (document.getElementById('s-ruta')?.classList.contains('active')) renderRuta();
  } catch (e) {
    await avisar({ titulo: 'No se pudo registrar la visita', cuerpo: (e && e.message) || '' });
  } finally {
    _visitaEnCurso = false;
  }
};

// Historial de la ficha: las últimas 20 visitas, la más reciente primero.
async function cargarHistorialVisitas(id) {
  const el = document.getElementById('pros-visitas-hist');
  if (!el) return;
  try {
    const r = await supabaseCall('POST', 'rpc/obtener_visitas', { p_data: { idProspecto: id } });
    if (!r || !r.ok) { el.innerHTML = ''; return; }
    const vs = r.visitas || [];
    if (!vs.length) {
      el.innerHTML = '<div style="font-size:0.74rem;color:var(--suave);">Sin visitas registradas.</div>';
      return;
    }
    const esc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    el.innerHTML = `
      <div style="background:var(--gris2);border-radius:12px;padding:12px;">
        <div style="font-size:0.66rem;font-weight:800;color:var(--suave);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Visitas (${vs.length})</div>
        ${vs.map(v => `
          <div style="padding:6px 0;border-top:1px solid var(--gris3);font-size:0.78rem;color:var(--blanco);">
            <div style="display:flex;justify-content:space-between;gap:8px;"><b>${esc(v.etiqueta)}</b><span style="color:var(--suave);white-space:nowrap;">${new Date(v.creadaEn).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span></div>
            <div style="color:var(--suave);font-size:0.72rem;">${esc(v.vendedor)}${v.distanciaMetros != null ? ' · a ' + v.distanciaMetros + ' m' : ' · tienda sin coordenadas'}${v.fueraDelPunto ? ' · <span style="color:var(--rojo);font-weight:700;">fuera del punto</span>' : ''}</div>
            ${v.nota ? `<div style="margin-top:2px;white-space:pre-wrap;">${esc(v.nota)}</div>` : ''}
          </div>`).join('')}
      </div>`;
  } catch (_e) {
    el.innerHTML = '';
  }
}

window.accionReactivarProspecto = async function(id) {
  if (!(await confirmar({ titulo: '¿Reactivar este prospecto?', aceptar: 'Reactivar' }))) return;
  try {
    const res = await supabaseCall('POST', 'rpc/actualizar_prospecto', { p_data: { id, campos: {
      estatus: 'pendiente',
      motivo_descarte: null,
      fecha_descarte: null,
    } } });
    if (!res || !res.ok) { avisar({ titulo: 'No se pudo reactivar el prospecto', cuerpo: ((res && res.error) || 'Sin respuesta') }); return; }
    mostrarToast('↩️ Reactivado');
    cerrarDetalleProspecto();
    renderProspeccion();
  } catch(e) { avisar({ titulo: 'No se pudo reactivar el prospecto', cuerpo: e.message }); }
};

// ──────────────────────────────────────────
// IMPORTACIÓN CSV
// ──────────────────────────────────────────
window.abrirImportadorProspectos = function() {
  document.getElementById('overlay-import').classList.add('visible');
  document.getElementById('drawer-import').classList.add('open');
  // Reset estado
  document.getElementById('pros-csv-file').value = '';
  document.getElementById('pros-csv-preview').style.display = 'none';
  document.getElementById('pros-csv-resultado').innerHTML = '';
  const btn = document.getElementById('pros-csv-confirm');
  btn.disabled = true; btn.style.opacity = '0.5';
  _prosCSVPendientes = [];
};

window.cerrarImportador = function() {
  document.getElementById('overlay-import').classList.remove('visible');
  document.getElementById('drawer-import').classList.remove('open');
};

document.addEventListener('click', e => {
  const ov = document.getElementById('overlay-import');
  if (e.target === ov) cerrarImportador();
});

// Parser CSV simple — soporta valores entre comillas con comas adentro
function parseCSV(texto) {
  const filas = [];
  const lineas = texto.split(/\r?\n/).filter(l => l.trim());
  for (const linea of lineas) {
    const campos = [];
    let act = '', dentroComillas = false;
    for (let i = 0; i < linea.length; i++) {
      const ch = linea[i];
      if (ch === '"') {
        if (dentroComillas && linea[i+1] === '"') { act += '"'; i++; }
        else dentroComillas = !dentroComillas;
      } else if (ch === ',' && !dentroComillas) {
        campos.push(act); act = '';
      } else {
        act += ch;
      }
    }
    campos.push(act);
    filas.push(campos.map(c => c.trim()));
  }
  return filas;
}

// Normaliza un nombre de columna para matching (quita acentos, espacios, guiones bajos, mayúsculas)
function normalizarHeader(h) {
  return String(h || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // quitar acentos
    .replace(/[^a-z0-9]/g, '');                          // quitar todo lo que no sea letra/número
}

// Mapeo de variantes aceptadas para cada campo del sistema
const CSV_COLUMNAS_MAP = {
  nombre:           ['nombre','nombrecliente','nombrenegocio','razon','razonsocial'],
  tipo:             ['tipo','tipocomercio','tipodecomercio','giro'],
  direccion:        ['direccion','direccioncompleta','dir'],
  lat:              ['lat','latitud','latitude','y'],
  lng:              ['lng','longitud','longitude','lon','x'],
  score:            ['score','scoreprospecto','prioridad'],
  telefono:         ['telefono','tel','phone','celular','contacto'],
  // Campos adicionales
  idExterno:        ['id','idexterno','idoriginal','idsource'],
  ref:              ['ref','referencia','codigo'],
  tierOriginal:     ['tipocliente','tier','nivel','categoria'],
  calle:            ['calle','street'],
  colonia:          ['colonia','col','neighborhood'],
  codigoPostal:     ['codigopostal','codigopostaltt','cp','zip','codpostal'],
  distanciaMetros:  ['distanciametros','distancia','distance']
};

// Limpia un valor: quita espacios, comillas redundantes, prefijo ' de Excel
function limpiarValor(v) {
  if (v === undefined || v === null) return '';
  let s = String(v).trim();
  // Excel a veces prefija con ' para preservar string
  if (s.startsWith("'")) s = s.slice(1);
  // Quitar comillas envolventes
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  return s.trim();
}

window.procesarCSV = function(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const filas = parseCSV(e.target.result);
      if (filas.length < 2) {
        document.getElementById('pros-csv-preview').innerHTML = '<div style="color:var(--rojo);">CSV vacío o sin datos</div>';
        document.getElementById('pros-csv-preview').style.display = 'block';
        return;
      }

      // Construir mapa de índices: para cada campo del sistema, encontrar qué columna del CSV le corresponde
      const headersRaw = filas[0];
      const headersNorm = headersRaw.map(normalizarHeader);
      const idx = {};
      Object.keys(CSV_COLUMNAS_MAP).forEach(campo => {
        const variantes = CSV_COLUMNAS_MAP[campo];
        idx[campo] = -1;
        for (const v of variantes) {
          const pos = headersNorm.indexOf(v);
          if (pos !== -1) { idx[campo] = pos; break; }
        }
      });

      // Validar columnas obligatorias
      const faltantes = [];
      ['nombre','lat','lng'].forEach(k => { if (idx[k] === -1) faltantes.push(k); });
      if (faltantes.length > 0) {
        document.getElementById('pros-csv-preview').innerHTML =
          `<div style="color:var(--rojo);font-weight:700;">Faltan columnas obligatorias: ${faltantes.join(', ')}</div>
           <div style="margin-top:6px;font-size:0.74rem;">Encabezados detectados: <code style="color:var(--amarillo);">${headersRaw.join(', ')}</code></div>
           <div style="margin-top:6px;font-size:0.72rem;color:var(--suave);">Asegúrate de tener al menos: <strong>NombreCliente</strong>, <strong>lat</strong> y <strong>lng</strong>.</div>`;
        document.getElementById('pros-csv-preview').style.display = 'block';
        return;
      }

      // Parsear filas
      const prospectos = [];
      let invalidos = 0;
      let coordsSwapped = 0;
      for (let i = 1; i < filas.length; i++) {
        const f = filas[i];
        if (f.length === 0 || f.every(c => !c)) continue; // saltar líneas vacías

        const nombre = limpiarValor(f[idx.nombre]);
        let lat      = Number(limpiarValor(f[idx.lat])) || 0;
        let lng      = Number(limpiarValor(f[idx.lng])) || 0;

        // Defensa contra coordenadas invertidas: si lat luce como longitud y lng como latitud, swap
        // Latitud válida CDMX-México: 14 a 33. Longitud válida: -120 a -86.
        if (Math.abs(lat) > 60 && Math.abs(lng) < 60) {
          [lat, lng] = [lng, lat];
          coordsSwapped++;
        }

        if (!lat || !lng || !nombre) { invalidos++; continue; }

        // Score: tomar de columna score; si no existe o no es válido, default 3
        let score = 3;
        if (idx.score >= 0) {
          const sRaw = limpiarValor(f[idx.score]);
          const sNum = Number(sRaw);
          if (!isNaN(sNum) && sNum >= 1 && sNum <= 5) score = sNum;
        }

        const obj = {
          nombre,
          tipo:      idx.tipo >= 0      ? limpiarValor(f[idx.tipo])      : 'Tienda',
          direccion: idx.direccion >= 0 ? limpiarValor(f[idx.direccion]) : '',
          lat, lng, score,
          telefono:  idx.telefono >= 0  ? limpiarValor(f[idx.telefono])  : '',
          // Campos adicionales
          idExterno:       idx.idExterno >= 0       ? limpiarValor(f[idx.idExterno])       : '',
          ref:             idx.ref >= 0             ? limpiarValor(f[idx.ref])             : '',
          tierOriginal:    idx.tierOriginal >= 0    ? limpiarValor(f[idx.tierOriginal])    : '',
          calle:           idx.calle >= 0           ? limpiarValor(f[idx.calle])           : '',
          colonia:         idx.colonia >= 0         ? limpiarValor(f[idx.colonia])         : '',
          codigoPostal:    idx.codigoPostal >= 0    ? limpiarValor(f[idx.codigoPostal]).padStart(5,'0').slice(0,5) : '',
          distanciaMetros: idx.distanciaMetros >= 0 ? Number(limpiarValor(f[idx.distanciaMetros])) || 0 : 0,
        };
        prospectos.push(obj);
      }

      _prosCSVPendientes = prospectos;
      const previewLineas = prospectos.slice(0, 3).map(p => {
        const tier = p.tierOriginal ? ` · ${p.tierOriginal}` : '';
        return `• ${p.nombre} (${p.tipo})${tier} — ${p.score}/5 ${p.codigoPostal?'· CP '+p.codigoPostal:''}`;
      }).join('<br>');

      document.getElementById('pros-csv-preview').innerHTML = `
        <div style="font-weight:800;color:var(--amarillo);">${prospectos.length} prospectos listos para importar</div>
        ${invalidos > 0 ? `<div style="color:var(--rojo);font-size:0.74rem;margin-top:4px;">${invalidos} filas inválidas (sin nombre o coordenadas)</div>` : ''}
        ${coordsSwapped > 0 ? `<div style="color:var(--amarillo);font-size:0.74rem;margin-top:4px;">↔️ ${coordsSwapped} coordenadas detectadas invertidas y corregidas automáticamente</div>` : ''}
        <div style="margin-top:6px;font-size:0.74rem;color:var(--suave);">Primeros registros:<br>${previewLineas}${prospectos.length > 3 ? '<br>...' : ''}</div>
      `;
      document.getElementById('pros-csv-preview').style.display = 'block';

      const btn = document.getElementById('pros-csv-confirm');
      if (prospectos.length > 0) { btn.disabled = false; btn.style.opacity = '1'; }
    } catch(err) {
      document.getElementById('pros-csv-preview').innerHTML =
        '<div style="color:var(--rojo);">Error al parsear CSV: ' + err.message + '</div>';
      document.getElementById('pros-csv-preview').style.display = 'block';
    }
  };
  reader.readAsText(file, 'UTF-8');
};

window.confirmarImportacion = async function() {
  if (!_prosCSVPendientes.length) return;

  const btn = document.getElementById('pros-csv-confirm');
  btn.disabled = true; btn.style.opacity = '0.5';
  btn.textContent = 'Importando...';

  const resultadoEl = document.getElementById('pros-csv-resultado');
  resultadoEl.innerHTML = '<div style="color:var(--suave);"><span class="loader loader-w"></span> Procesando...</div>';

  // ── Diagnóstico defensivo ─────────────────────────────────────
  // Verificar que el payload sea serializable y sin caracteres problemáticos.
  console.log('[ImportProspectos] Total a importar:', _prosCSVPendientes.length);
  console.log('[ImportProspectos] Muestra primer prospecto:', _prosCSVPendientes[0]);
  // Probar serialización completa antes de enviar
  try {
    const testJson = JSON.stringify({ p_data: { prospectos: _prosCSVPendientes } });
    console.log('[ImportProspectos] Tamaño total JSON:', testJson.length, 'bytes');
    if (testJson.length > 5_000_000) {
      resultadoEl.innerHTML = `<div style="color:var(--rojo);">Payload demasiado grande (${(testJson.length/1024/1024).toFixed(1)} MB). Divide tu CSV en varios archivos más pequeños.</div>`;
      btn.disabled = false; btn.style.opacity = '1'; btn.textContent = 'Reintentar';
      return;
    }
  } catch(e) {
    resultadoEl.innerHTML = `<div style="color:var(--rojo);">Error serializando datos: ${e.message}. Tu CSV tiene caracteres no válidos.</div>`;
    btn.disabled = false; btn.style.opacity = '1'; btn.textContent = 'Reintentar';
    return;
  }

  // Lotes pequeños (50) para no agotar timeout de Apps Script (6 min)
  // y dar feedback frecuente al usuario.
  const LOTE = 50;
  const total = _prosCSVPendientes.length;
  let importadosTotal = 0, duplicadosTotal = 0, invalidosTotal = 0;
  const erroresAcum = [];

  const lotes = [];
  for (let i = 0; i < _prosCSVPendientes.length; i += LOTE) {
    lotes.push(_prosCSVPendientes.slice(i, i + LOTE));
  }

  for (let i = 0; i < lotes.length; i++) {
    resultadoEl.innerHTML = `
      <div style="color:var(--suave);">
        <span class="loader loader-w"></span> Procesando lote ${i+1}/${lotes.length} (${(i*LOTE)+1}–${Math.min((i+1)*LOTE, total)} de ${total})...
      </div>
      <div style="font-size:0.74rem;margin-top:6px;color:var(--amarillo);">
        Hasta ahora: ${importadosTotal} ok · ${duplicadosTotal} dup · ${invalidosTotal} inv
      </div>`;
    try {
      console.log(`[ImportProspectos] Enviando lote ${i+1}/${lotes.length}, ${lotes[i].length} prospectos`);
      const t0 = Date.now();
      const res = await supabaseCall('POST', 'rpc/importar_prospectos_bulk', {
        p_data: { prospectos: lotes[i] }
      });
      console.log(`[ImportProspectos] Lote ${i+1} respondió en ${Date.now()-t0}ms:`, res);
      if (res && res.ok) {
        importadosTotal += res.creados || 0;
        duplicadosTotal += res.duplicados || 0;
        invalidosTotal  += (res.errores?.length || 0);
        if (res.errores && res.errores.length) {
          erroresAcum.push(...res.errores);
        }
      } else {
        console.error(`[ImportProspectos] Lote ${i+1} respondió error:`, res);
        resultadoEl.innerHTML = `
          <div style="color:var(--rojo);font-weight:700;">Error en lote ${i+1}/${lotes.length}: ${res?.error||'Sin respuesta'}</div>
          <div style="font-size:0.78rem;margin-top:6px;color:var(--suave);">
            Procesados antes del fallo: ${importadosTotal} ok · ${duplicadosTotal} dup · ${invalidosTotal} inv
          </div>`;
        btn.disabled = false; btn.style.opacity = '1'; btn.textContent = 'Reintentar';
        return;
      }
    } catch(e) {
      console.error(`[ImportProspectos] Lote ${i+1} EXCEPCIÓN:`, e);
      console.error('[ImportProspectos] Payload del lote fallido:', lotes[i]);
      resultadoEl.innerHTML = `
        <div style="color:var(--rojo);font-weight:700;">Error de conexión en lote ${i+1}/${lotes.length}: ${e.message}</div>
        <div style="font-size:0.78rem;margin-top:6px;color:var(--suave);">
          Procesados antes del fallo: ${importadosTotal} ok · ${duplicadosTotal} dup · ${invalidosTotal} inv
        </div>
        <div style="font-size:0.74rem;margin-top:6px;color:var(--amarillo);">
          Tip: abre la consola (F12) para ver detalle del error. También puedes intentar el botón "Probar 1 fila" para diagnosticar.
        </div>`;
      btn.disabled = false; btn.style.opacity = '1'; btn.textContent = 'Reintentar';
      return;
    }
  }

  resultadoEl.innerHTML = `
    <div style="background:#0d2d0d;border:1px solid #4caf50;border-radius:8px;padding:10px;color:#4caf50;font-weight:700;">
      Importación completa<br>
      <span style="font-weight:500;font-size:0.78rem;color:var(--suave);">
        ${importadosTotal} nuevos · ${duplicadosTotal} duplicados (omitidos) · ${invalidosTotal} inválidos
      </span>
    </div>
    ${erroresAcum.length ? `<div style="margin-top:8px;font-size:0.72rem;color:var(--rojo);">Errores muestra: ${erroresAcum.slice(0,3).join(' · ')}</div>` : ''}
  `;
  btn.textContent = 'Cerrar';
  btn.disabled = false; btn.style.opacity = '1';
  btn.onclick = () => { cerrarImportador(); renderProspeccion(); };
};

// ──────────────────────────────────────────
// Botón de prueba: intentar import con 1 sola fila
// ──────────────────────────────────────────
window.probarImportUnaFila = async function() {
  if (!_prosCSVPendientes.length) {
    mostrarToast('Primero carga el CSV.');
    return;
  }
  const test = _prosCSVPendientes[0];
  console.log('[ProbarImport] Enviando 1 prospecto de prueba:', test);
  const resultadoEl = document.getElementById('pros-csv-resultado');
  resultadoEl.innerHTML = '<div style="color:var(--suave);">Probando con 1 fila...</div>';
  try {
    const res = await supabaseCall('POST', 'rpc/importar_prospectos_bulk', {
      p_data: { prospectos: [test] }
    });
    console.log('[ProbarImport] Respuesta:', res);
    if (res && res.ok) {
      resultadoEl.innerHTML = `<div style="color:#4caf50;font-weight:700;">Prueba exitosa: ${res.creados} creado(s), ${res.duplicados} dup</div>
        <div style="font-size:0.72rem;color:var(--suave);margin-top:4px;">El backend acepta los datos. Puedes intentar la importación completa.</div>`;
    } else {
      resultadoEl.innerHTML = `<div style="color:var(--rojo);font-weight:700;">El backend respondió error: ${res?.error}</div>
        <div style="font-size:0.72rem;color:var(--suave);margin-top:4px;">Es problema del backend. Revisa logs.</div>`;
    }
  } catch(e) {
    console.error('[ProbarImport] Excepción:', e);
    resultadoEl.innerHTML = `<div style="color:var(--rojo);font-weight:700;">HTTP error con 1 sola fila: ${e.message}</div>
      <div style="font-size:0.72rem;color:var(--suave);margin-top:4px;">El problema NO es el tamaño del payload. Es algo del transporte o del frontend. Abre consola (F12) para ver detalle.</div>`;
  }
};


// ══════════════════════════════════════════════════════════════════
// GASTOS (v2.4) — registrar, listar, aprobar, foto ticket
// ══════════════════════════════════════════════════════════════════
let _gastos = [];
let _gastoFiltro = 'todos';
let _editandoGasto = null;
// Se guarda el File tal cual. Antes se convertía a base64 para mandarlo
// dentro de un JSON, y eso infla el tamaño un 33%: los 5 MB del selector se
// volvían ~6.7 MB, por encima del límite de cuerpo de una función
// serverless. Era el "bug del proxy >16KB" del comentario viejo. Ahora el
// archivo sube directo a Storage y no pasa por Vercel.
let _ticketArchivo = null;
let _ticketMimeType = '';

const SUBCATEGORIAS_GASTOS = {
  'Materia Prima': ['Papa', 'Aceite', 'Sal', 'Sazonadores', 'Otros'],
  'Servicios':     ['Luz', 'Agua', 'Gas', 'Internet', 'Renta', 'Otros'],
  'Nómina':        ['Sueldo', 'Comisiones', 'Bonos', 'Aguinaldo', 'Otros'],
  'Empaque':       ['Bolsas', 'Etiquetas', 'Cajas', 'Otros'],
  'Logística':     ['Combustible', 'Mensajería', 'Mantenimiento vehículo', 'Otros'],
  'Equipo':        ['Herramientas', 'Reparaciones', 'Compra equipo', 'Otros'],
  'Otros':         ['Otros']
};

// Subcategorías que requieren registro de cantidad para análisis de precio unitario
const GASTOS_METRICAS_FRONT = {
  'Papa':         { unidad: 'kg',         label: 'Cantidad (kg)',     factorLts: null },
  'Aceite':       { unidad: 'bidón 20L',  label: 'Bidones (20L c/u)', factorLts: 20 },
  'Sal':          { unidad: 'kg',         label: 'Cantidad (kg)',     factorLts: null },
  'Sazonadores':  { unidad: 'kg',         label: 'Cantidad (kg)',     factorLts: null },
};

window.actualizarCampoCantidad = function() {
  const sub = document.getElementById('ng-subcategoria').value;
  const bloque = document.getElementById('ng-bloque-cantidad');
  const label  = document.getElementById('ng-cantidad-label');
  const inp    = document.getElementById('ng-cantidad');
  const precio = document.getElementById('ng-precio-unitario');

  const metrica = GASTOS_METRICAS_FRONT[sub];
  if (metrica) {
    bloque.style.display = '';
    label.textContent = metrica.label;
    inp.placeholder = metrica.unidad === 'kg' ? '0.00 kg' : '0 bidones';
  } else {
    bloque.style.display = 'none';
    inp.value = '';
    precio.style.display = 'none';
  }
};

window.recalcularPrecioUnitario = function() {
  const sub      = document.getElementById('ng-subcategoria').value;
  const cantidad = Number(document.getElementById('ng-cantidad').value) || 0;
  const monto    = Number(document.getElementById('ng-monto').value) || 0;
  const precioEl = document.getElementById('ng-precio-unitario');

  const metrica = GASTOS_METRICAS_FRONT[sub];
  if (!metrica || !cantidad || !monto) {
    precioEl.style.display = 'none';
    return;
  }

  const precioU = monto / cantidad;
  let html = '';
  if (sub === 'Aceite' && metrica.factorLts) {
    const totalLts = cantidad * metrica.factorLts;
    const precioLt = monto / totalLts;
    html = `${cantidad} bidón(es) = ${totalLts}L · $${precioU.toFixed(2)}/bidón · $${precioLt.toFixed(2)}/L`;
  } else {
    html = `$${precioU.toFixed(2)} por ${metrica.unidad}`;
  }
  precioEl.innerHTML = html;
  precioEl.style.display = '';
};

async function renderGastos() {
  const lista = document.getElementById('g-lista');
  if (lista) lista.innerHTML = '<div style="text-align:center;color:var(--suave);padding:30px 0;"><span class="loader loader-w"></span> Cargando...</div>';

  try {
    // El alcance lo impone el servidor: admin ve todos los gastos, vendedor
    // los suyos. Antes lo decidía este `if`, que se podía borrar en DevTools.
    const _rg = await supabaseCall('POST', 'rpc/obtener_gastos', { p_data: { limit: 200 } });
    const arr = (_rg && _rg.ok) ? _rg.gastos : null;
    if (!Array.isArray(arr)) {
      if (lista) lista.innerHTML = '<div style="color:var(--rojo);padding:14px;">Error: respuesta inválida</div>';
      return;
    }
    // Mapear campos snake_case → camelCase legacy
    _gastos = arr.map(g => ({
      id:              g.id,
      fecha:           g.fecha,
      categoria:       g.categoria,
      subcategoria:    g.subcategoria,
      concepto:        g.descripcion,      // alias legacy
      descripcion:     g.descripcion,
      monto:           Number(g.monto) || 0,
      moneda:          g.moneda,
      metodoPago:      g.metodo_pago,
      tipoPago:        g.metodo_pago,      // alias legacy (UI usa tipoPago)
      fuenteDinero:    g.fuente_dinero || 'Crunchy',  // default
      proveedor:       g.proveedor,
      rfcProveedor:    g.rfc_proveedor,
      tieneFactura:    g.tiene_factura,
      factura:         g.tiene_factura ? (g.notas || '').match(/Factura:\s*(.+)/i)?.[1] || '' : '', // legacy extracted
      ticketUrl:       g.ticket_url,
      notas:           g.notas,
      idVendedor:      g.id_vendedor,
      nombreVendedor:  g.nombre_vendedor,
      estatus:         g.estatus || 'pendiente',
      estatusAprobacion: g.estatus || 'pendiente',           // alias legacy (UI usa estatusAprobacion)
      motivoRechazo:   g.motivo_rechazo,
      aprobadoPor:     g.aprobado_por,
      fechaAprobacion: g.fecha_aprobacion,
      fechaRegistro:   g.fecha_creacion,
      fuente:          g.id_vendedor ? 'Vendedor' : 'Crunchy', // legacy
      cantidad:        0, // se calcula al cargar líneas si aplica
    }));

    // Resumen mes via RPC
    const resR = await supabaseCall('POST', 'rpc/resumen_gastos', { p_data: { token: tokenVendedor() } });
    if (resR && resR.ok) {
      // Mapear a estructura legacy esperada por pintarResumenGastos
      pintarResumenGastos({
        total:      resR.totalMes,
        aprobados:  resR.aprobados,
        pendientes: resR.pendientes,
        rechazados: resR.rechazados,
        porFuente:  resR.porCategoria || {}, // legacy usaba 'porFuente'
        porCategoria: resR.porCategoria || {},
      });
    }

    pintarListaGastos();
  } catch(e) {
    if (lista) lista.innerHTML = '<div style="color:var(--rojo);padding:14px;">Error: ' + e.message + '</div>';
  }
}

function pintarResumenGastos(r) {
  const total = document.getElementById('g-total');
  if (total) total.textContent = '$' + (r.total || 0).toLocaleString('es-MX');

  const det = document.getElementById('g-resumen-detalle');
  if (!det) return;

  const fuentes = r.porFuente || {};
  let html = '';
  if (fuentes['Crunchy'] > 0) {
    html += `<span>Crunchy: <strong style="color:var(--blanco);">$${fuentes['Crunchy'].toLocaleString('es-MX')}</strong></span>`;
  }
  if (fuentes['Inversión'] > 0) {
    html += `<span>Inversión: <strong style="color:var(--blanco);">$${fuentes['Inversión'].toLocaleString('es-MX')}</strong></span>`;
  }
  if (r.totalPendientes > 0) {
    html += `<span>Pendientes: <strong style="color:var(--amarillo);">$${r.totalPendientes.toLocaleString('es-MX')}</strong></span>`;
  }
  det.innerHTML = html || '<span>Sin gastos este mes</span>';

  // Desglose de insumos con métrica
  const insumos = r.insumos || {};
  const insumosKeys = Object.keys(insumos);
  let blockEl = document.getElementById('g-resumen-insumos');
  if (insumosKeys.length === 0) {
    if (blockEl) blockEl.remove();
    return;
  }

  if (!blockEl) {
    blockEl = document.createElement('div');
    blockEl.id = 'g-resumen-insumos';
    blockEl.style.cssText = 'margin-top:10px;padding-top:10px;border-top:1px solid var(--gris3);';
    document.getElementById('g-resumen').appendChild(blockEl);
  }

  let insumosHTML = '<div style="font-size:0.66rem;font-weight:800;color:var(--amarillo);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Insumos del mes (precio promedio)</div>';
  insumosKeys.forEach(s => {
    const i = insumos[s];
    let detalleLts = '';
    if (s === 'Aceite' && i.totalLitros) {
      detalleLts = ` · ${i.totalLitros}L · $${i.precioPorLt.toFixed(2)}/L`;
    }
    insumosHTML += `
      <div style="display:flex;justify-content:space-between;font-size:0.74rem;color:var(--blanco);padding:3px 0;">
        <span><strong>${s}</strong>: ${i.totalCantidad} ${i.unidad}${detalleLts}</span>
        <span style="color:var(--amarillo);font-weight:700;">$${i.precioPromedio.toFixed(2)}/${i.unidad}</span>
      </div>`;
  });
  blockEl.innerHTML = insumosHTML;
}

window.filtrarGastos = function(estatus) {
  _gastoFiltro = estatus;
  document.querySelectorAll('.g-fchip').forEach(b => {
    const activo = b.getAttribute('data-est') === estatus;
    b.style.background  = activo ? 'var(--amarillo)' : 'var(--gris)';
    b.style.color       = activo ? 'var(--negro)' : 'var(--suave)';
    b.style.borderColor = activo ? 'var(--amarillo)' : 'var(--gris3)';
  });
  pintarListaGastos();
};

function pintarListaGastos() {
  const cont = document.getElementById('g-lista');
  if (!cont) return;

  const filtrados = _gastos.filter(g => {
    if (_gastoFiltro === 'todos') return true;
    return g.estatusAprobacion === _gastoFiltro;
  });

  if (filtrados.length === 0) {
    cont.innerHTML = `<div style="text-align:center;color:var(--suave);padding:40px 0;font-size:0.85rem;">
      <span style="font-size:2.5rem;display:block;margin-bottom:8px;" class="ico-solo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/></svg></span>
      ${_gastoFiltro === 'todos' ? 'Sin gastos registrados' : 'Sin gastos en este estatus'}
    </div>`;
    return;
  }

  const ico = { pendiente:'', aprobado:'', rechazado:'' };
  const colorEst = {
    pendiente: { bg:'#2a1f00', fg:'var(--amarillo)' },
    aprobado:  { bg:'#0d2d0d', fg:'#4caf50' },
    rechazado: { bg:'#2d0d0d', fg:'var(--rojo)' }
  };
  const fuenteIco = { 'Crunchy': '', 'Inversión': '' };

  cont.innerHTML = filtrados.map(g => {
    const fecha = g.fecha ? new Date(g.fecha).toLocaleDateString('es-MX',{day:'numeric',month:'short'}) : '—';
    const c = colorEst[g.estatusAprobacion] || colorEst.pendiente;
    return `<div onclick="verDetalleGasto(${g.id})" style="
      background:var(--gris);border-radius:12px;padding:12px;margin-bottom:8px;cursor:pointer;
      border-left:3px solid ${c.fg};">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:900;font-size:0.92rem;color:var(--blanco);">${g.categoria}${g.subcategoria?' · '+g.subcategoria:''}</div>
          ${g.concepto ? `<div style="font-size:0.78rem;color:var(--suave);margin-top:2px;">${g.concepto}</div>` : ''}
          ${g.cantidad > 0 ? `<div style="font-size:0.74rem;color:var(--amarillo);margin-top:2px;font-weight:700;">${g.cantidad} ${g.unidad} · $${g.precioUnitario.toFixed(2)}/${g.unidad.replace(/^bidón\s*/,'').replace(/L$/,'L').trim()||g.unidad}</div>` : ''}
          <div style="font-size:0.7rem;color:#888;margin-top:4px;">
            ${fecha} · ${fuenteIco[g.fuenteDinero]||''} ${g.fuenteDinero}
            ${g.tieneTicket ? ' ·' : ''}
          </div>
          ${g.nombreVendedor ? `<div style="font-size:0.66rem;color:#666;margin-top:2px;">${g.nombreVendedor}</div>` : ''}
        </div>
        <div style="text-align:right;white-space:nowrap;">
          <div style="font-family:'Archivo',sans-serif;font-size:1.4rem;color:var(--amarillo);line-height:1;">$${g.monto.toLocaleString('es-MX')}</div>
          <div style="display:inline-block;margin-top:4px;background:${c.bg};color:${c.fg};font-size:0.66rem;font-weight:800;padding:2px 8px;border-radius:50px;">${ico[g.estatusAprobacion]} ${g.estatusAprobacion}</div>
        </div>
      </div>
    </div>`;
  }).join('');
}

// ──────────────────────────────────────────
// MODAL NUEVO/EDITAR GASTO
// ──────────────────────────────────────────
window.abrirNuevoGasto = function() {
  _editandoGasto = null;
  _ticketArchivo = null;
  _ticketMimeType = '';

  // Reset form
  document.getElementById('ng-titulo').textContent = 'Nuevo gasto';
  document.getElementById('ng-fecha').value = fechaCDMX();
  document.getElementById('ng-categoria').value = '';
  document.getElementById('ng-subcategoria').innerHTML = '<option value="">Selecciona categoría primero</option>';
  document.getElementById('ng-concepto').value = '';
  document.getElementById('ng-monto').value = '';
  document.getElementById('ng-tipo-pago').value = 'Efectivo';
  document.getElementById('ng-fuente').value = 'Crunchy';
  document.getElementById('ng-proveedor').value = '';
  document.getElementById('ng-factura').value = '';
  document.getElementById('ng-notas').value = '';
  document.getElementById('ng-ticket-file').value = '';
  document.getElementById('ng-ticket-preview').style.display = 'none';
  document.getElementById('ng-bloque-cantidad').style.display = 'none';
  document.getElementById('ng-cantidad').value = '';
  document.getElementById('ng-precio-unitario').style.display = 'none';

  document.getElementById('overlay-nuevo-gasto').classList.add('visible');
  document.getElementById('drawer-nuevo-gasto').classList.add('open');
};

window.cerrarNuevoGasto = function() {
  document.getElementById('overlay-nuevo-gasto').classList.remove('visible');
  document.getElementById('drawer-nuevo-gasto').classList.remove('open');
};

document.addEventListener('click', e => {
  const ov = document.getElementById('overlay-nuevo-gasto');
  if (e.target === ov) cerrarNuevoGasto();
});

window.actualizarSubcategorias = function() {
  const cat = document.getElementById('ng-categoria').value;
  const sel = document.getElementById('ng-subcategoria');
  if (!cat) {
    sel.innerHTML = '<option value="">Selecciona categoría primero</option>';
    return;
  }
  const subs = SUBCATEGORIAS_GASTOS[cat] || ['Otros'];
  sel.innerHTML = subs.map(s => `<option value="${s}">${s}</option>`).join('');
};

// Listener para captura de ticket. Ya no se lee el archivo: basta con
// quedarse la referencia y subirlo tal cual al guardar el gasto.
const TICKET_TIPOS_OK = ['image/jpeg','image/png','image/webp','image/heic','application/pdf'];

document.addEventListener('change', function(e) {
  if (e.target && e.target.id === 'ng-ticket-file') {
    const file = e.target.files[0];
    const prev = document.getElementById('ng-ticket-preview');
    if (!file) {
      _ticketArchivo = null;
      prev.style.display = 'none';
      return;
    }
    // Mismo límite que el bucket, para avisar aquí en vez de fallar al subir.
    if (file.size > 5 * 1024 * 1024) {
      mostrarToast('La imagen no debe exceder 5MB.');
      e.target.value = '';
      _ticketArchivo = null;
      return;
    }
    const tipo = file.type || 'image/jpeg';
    if (!TICKET_TIPOS_OK.includes(tipo)) {
      mostrarToast('Formato no admitido. Usa JPG, PNG, WEBP, HEIC o PDF.');
      e.target.value = '';
      _ticketArchivo = null;
      return;
    }
    _ticketArchivo  = file;
    _ticketMimeType = tipo;
    prev.textContent = `${file.name} (${(file.size/1024).toFixed(1)} KB) — se subirá al guardar`;
    prev.style.display = 'block';
  }
});

window.guardarGasto = async function() {
  const fecha     = document.getElementById('ng-fecha').value;
  const categoria = document.getElementById('ng-categoria').value;
  const sub       = document.getElementById('ng-subcategoria').value;
  const concepto  = document.getElementById('ng-concepto').value.trim();
  const monto     = Number(document.getElementById('ng-monto').value);
  const tipoPago  = document.getElementById('ng-tipo-pago').value;
  const fuente    = document.getElementById('ng-fuente').value;
  const proveedor = document.getElementById('ng-proveedor').value.trim();
  const factura   = document.getElementById('ng-factura').value.trim();
  const notas     = document.getElementById('ng-notas').value.trim();

  if (!fecha)      { mostrarToast('Falta la fecha'); return; }
  if (!categoria)  { mostrarToast('Selecciona una categoría'); return; }
  if (!monto || monto <= 0) { mostrarToast('Ingresa un monto válido'); return; }

  const btn = document.getElementById('ng-btn-guardar');
  btn.disabled = true; btn.textContent = 'Guardando...';

  try {
    // v2.9: crear/editar gasto en Supabase
    const payload = {
      fecha,
      categoria,
      subcategoria: sub || null,
      descripcion: concepto,
      monto,
      moneda: 'MXN',
      metodo_pago: tipoPago,
      fuente_dinero: fuente,
      proveedor: proveedor || null,
      // legacy: factura va a notas (campo factura no existe en BD nueva, lo mantenemos así)
      notas: notas || (factura ? `Factura: ${factura}` : null),
      tiene_factura: !!factura,
      // id_vendedor y nombre_vendedor NO van aquí: los pone guardar_gasto
      // desde el token, y su lista blanca los rechaza si llegan del cliente.
      estatus: 'pendiente',
    };

    // Alta y edición por el mismo RPC. El id del vendedor lo pone el
    // servidor desde el token: nadie registra gastos a nombre de otro.
    const res = await supabaseCall('POST', 'rpc/guardar_gasto', {
      p_data: { id: _editandoGasto || null, campos: payload }
    });
    const idGasto = (res && res.ok) ? res.id : null;
    const itemCheck = (res && res.ok) ? null : { message: (res && res.error) || 'Sin respuesta', code: 'RPC' };
    if (itemCheck && itemCheck.message && itemCheck.code) {
      avisar({ titulo: 'No se pudo guardar el gasto', cuerpo: itemCheck.message });
      btn.disabled = false; btn.textContent = 'Guardar gasto';
      return;
    }

    // Si hay línea de insumo (categoría Insumos), agregar también
    const cantidad = Number(document.getElementById('ng-cantidad').value) || 0;
    if (idGasto && cantidad > 0 && sub) {
      try {
        await supabaseCall('POST', 'rpc/registrar_gasto_insumo', {
          p_data: { campos: {
            id_gasto: idGasto,
            insumo: sub,
            unidad: (GASTOS_METRICAS_FRONT[sub]?.unidad || ''),
            cantidad,
            precio_unitario: cantidad > 0 ? (monto / cantidad) : 0,
            subtotal: monto,
          } }
        });
      } catch(e) {}
    }

    // El archivo va del navegador DIRECTO a Supabase Storage con una URL
    // firmada. No pasa por Vercel, así que el límite de cuerpo que obligaba a
    // usar Apps Script ya no aplica.
    if (_ticketArchivo && idGasto) {
      btn.textContent = 'Subiendo foto...';
      try {
        const permiso = await ticketCall({
          accion: 'firmar_subida',
          idGasto,
          mimeType: _ticketMimeType,
        });
        if (!permiso.ok) {
          mostrarToast('Gasto guardado pero ticket falló: ' + (permiso.error||''));
        } else {
          const subida = await fetch(permiso.url, {
            method: 'PUT',
            headers: { 'Content-Type': _ticketMimeType },
            body: _ticketArchivo,
          });
          if (!subida.ok) throw new Error('HTTP ' + subida.status);
          // Se guarda la RUTA dentro del bucket, no una URL: las firmadas
          // caducan, así que se firma de nuevo cada vez que alguien mira.
          await supabaseCall('POST', 'rpc/guardar_gasto', {
            p_data: { id: idGasto, campos: { ticket_url: permiso.ruta } }
          });
        }
      } catch(e) {
        mostrarToast('Gasto guardado pero ticket falló: ' + e.message);
      }
    }

    mostrarToast('Gasto guardado');
    cerrarNuevoGasto();
    renderGastos();
  } catch(e) {
    avisar({ titulo: 'No se pudo guardar el gasto', cuerpo: e.message });
    btn.disabled = false; btn.textContent = 'Guardar gasto';
  }
};

// ──────────────────────────────────────────
// MODAL DETALLE DE GASTO
// ──────────────────────────────────────────
let _gastoActual = null;

window.verDetalleGasto = function(id) {
  const g = _gastos.find(x => String(x.id) === String(id));
  if (!g) return;
  _gastoActual = g;
  document.getElementById('overlay-detalle-gasto').classList.add('visible');
  document.getElementById('drawer-detalle-gasto').classList.add('open');
  document.getElementById('dg-titulo').textContent = g.consecutivo || 'Gasto';

  const fecha = g.fecha ? new Date(g.fecha).toLocaleDateString('es-MX',{weekday:'long',day:'numeric',month:'long',year:'numeric'}) : '—';
  const fechaReg = g.fechaRegistro ? new Date(g.fechaRegistro).toLocaleDateString('es-MX',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) : '—';
  const ico = { pendiente:'Pendiente', aprobado:'Aprobado', rechazado:'Rechazado' };
  const colorEst = {
    pendiente: { bg:'#2a1f00', fg:'var(--amarillo)' },
    aprobado:  { bg:'#0d2d0d', fg:'#4caf50' },
    rechazado: { bg:'#2d0d0d', fg:'var(--rojo)' }
  };
  const c = colorEst[g.estatusAprobacion] || colorEst.pendiente;
  const adminViendo = esAdmin && esAdmin();
  const esCreador = String(g.idVendedor) === String(N.vendedorInfo?.id);
  const puedeEditar = (adminViendo || (esCreador && g.estatusAprobacion === 'pendiente'));
  const puedeAprobar = adminViendo && g.estatusAprobacion === 'pendiente';

  document.getElementById('dg-contenido').innerHTML = `
    <!-- Encabezado: monto + estatus -->
    <div style="background:var(--gris2);border-radius:12px;padding:14px;margin-bottom:10px;text-align:center;">
      <div style="font-family:'Archivo',sans-serif;font-size:2.4rem;color:var(--amarillo);line-height:1;">$${g.monto.toLocaleString('es-MX')}</div>
      <div style="display:inline-block;margin-top:8px;background:${c.bg};color:${c.fg};font-size:0.78rem;font-weight:800;padding:4px 14px;border-radius:50px;">${ico[g.estatusAprobacion]||g.estatusAprobacion}</div>
    </div>

    <!-- Datos del gasto -->
    <div style="background:var(--gris2);border-radius:12px;padding:12px;margin-bottom:10px;display:flex;flex-direction:column;gap:6px;font-size:0.82rem;">
      <div><strong style="color:var(--suave);font-size:0.7rem;text-transform:uppercase;">Categoría:</strong> <span style="color:var(--blanco);">${g.categoria}${g.subcategoria?' · '+g.subcategoria:''}</span></div>
      ${g.cantidad > 0 ? `<div style="background:#2a1f00;border-radius:8px;padding:8px;margin:4px 0;">
        <strong style="color:var(--amarillo);font-size:0.7rem;text-transform:uppercase;">Métrica:</strong>
        <div style="color:var(--blanco);margin-top:2px;">
          ${g.cantidad} ${g.unidad} · <strong style="color:var(--amarillo);">$${g.precioUnitario.toFixed(2)}/${g.unidad}</strong>
          ${g.unidad === 'bidón 20L' ? `<br><span style="font-size:0.74rem;color:var(--suave);">≈ ${g.cantidad * 20}L totales · $${(g.monto / (g.cantidad * 20)).toFixed(2)}/L</span>` : ''}
        </div>
      </div>` : ''}
      ${g.concepto ? `<div><strong style="color:var(--suave);font-size:0.7rem;text-transform:uppercase;">Concepto:</strong> <span style="color:var(--blanco);">${g.concepto}</span></div>` : ''}
      <div><strong style="color:var(--suave);font-size:0.7rem;text-transform:uppercase;">Fecha:</strong> <span style="color:var(--blanco);">${fecha}</span></div>
      <div><strong style="color:var(--suave);font-size:0.7rem;text-transform:uppercase;">Tipo de pago:</strong> <span style="color:var(--blanco);">${g.tipoPago}</span></div>
      <div><strong style="color:var(--suave);font-size:0.7rem;text-transform:uppercase;">Fuente:</strong> <span style="color:var(--blanco);">${g.fuenteDinero}</span></div>
      ${g.proveedor ? `<div><strong style="color:var(--suave);font-size:0.7rem;text-transform:uppercase;">Proveedor:</strong> <span style="color:var(--blanco);">${g.proveedor}</span></div>` : ''}
      ${g.factura ? `<div><strong style="color:var(--suave);font-size:0.7rem;text-transform:uppercase;">Factura:</strong> <span style="color:var(--blanco);">${g.factura}</span></div>` : ''}
      ${g.notas ? `<div><strong style="color:var(--suave);font-size:0.7rem;text-transform:uppercase;">Notas:</strong> <span style="color:var(--blanco);">${g.notas}</span></div>` : ''}
    </div>

    <!-- Trazabilidad -->
    <div style="background:var(--gris2);border-radius:12px;padding:12px;margin-bottom:10px;font-size:0.78rem;color:var(--suave);">
      <div>Registrado por: <strong style="color:var(--amarillo);">${g.nombreVendedor || 'Sin nombre'}</strong></div>
      <div>${fechaReg}</div>
      ${g.aprobadoPor ? `<div style="margin-top:4px;">${g.estatusAprobacion === 'aprobado' ? '' : ''} ${g.estatusAprobacion === 'aprobado' ? 'Aprobado' : 'Rechazado'} por: <strong style="color:var(--amarillo);">${g.aprobadoPor}</strong></div>` : ''}
      ${g.motivoRechazo ? `<div style="margin-top:4px;color:var(--rojo);">Motivo: ${g.motivoRechazo}</div>` : ''}
    </div>

    ${g.tieneTicket && g.ticketUrl ? `
      <div style="margin-bottom:10px;">
        <a href="#" onclick="abrirTicket(event, ${'${g.id}'})" style="display:block;background:#0d2d0d;border:1px solid #2a5a2a;border-radius:10px;padding:11px;text-align:center;font-weight:800;color:#4caf50;text-decoration:none;font-size:0.84rem;">
          Ver foto del ticket
        </a>
      </div>
    ` : ''}

    <!-- Acciones admin -->
    ${puedeAprobar ? `
      <div style="display:flex;gap:8px;margin-bottom:10px;">
        <button onclick="aprobarGastoUI(${g.id})" style="flex:1;background:#0d2d0d;border:1px solid #4caf50;border-radius:10px;padding:11px;font-family:'Inter',sans-serif;font-weight:900;font-size:0.84rem;color:#4caf50;cursor:pointer;">Aprobar</button>
        <button onclick="rechazarGastoUI(${g.id})" style="flex:1;background:#2d0d0d;border:1px solid var(--rojo);border-radius:10px;padding:11px;font-family:'Inter',sans-serif;font-weight:900;font-size:0.84rem;color:var(--rojo);cursor:pointer;">Rechazar</button>
      </div>
    ` : ''}

    ${puedeEditar ? `
      <div style="display:flex;gap:8px;margin-bottom:6px;">
        <button onclick="editarGastoUI(${g.id})" style="flex:1;background:transparent;border:1px solid var(--amarillo);border-radius:10px;padding:9px;font-family:'Inter',sans-serif;font-weight:800;font-size:0.78rem;color:var(--amarillo);cursor:pointer;">Editar</button>
        <button onclick="eliminarGastoUI(${g.id})" style="flex:1;background:transparent;border:1px solid #555;border-radius:10px;padding:9px;font-family:'Inter',sans-serif;font-weight:700;font-size:0.78rem;color:#888;cursor:pointer;">Eliminar</button>
      </div>
    ` : ''}

    <button onclick="cerrarDetalleGasto()" style="width:100%;background:transparent;border:1px solid #333;border-radius:10px;padding:10px;font-family:'Inter',sans-serif;font-weight:700;font-size:0.82rem;color:var(--suave);cursor:pointer;margin-top:6px;">
      Cerrar
    </button>
  `;
};

window.cerrarDetalleGasto = function() {
  document.getElementById('overlay-detalle-gasto').classList.remove('visible');
  document.getElementById('drawer-detalle-gasto').classList.remove('open');
};

document.addEventListener('click', e => {
  const ov = document.getElementById('overlay-detalle-gasto');
  if (e.target === ov) cerrarDetalleGasto();
});

window.aprobarGastoUI = async function(id) {
  if (!(await confirmar({ titulo: '¿Aprobar este gasto?', aceptar: 'Aprobar' }))) return;
  try {
    const res = await supabaseCall('POST', 'rpc/aprobar_gasto', {
      p_data: {
        idGasto: Number(id),
        aprobadoPor: N.vendedorInfo?.nombre || 'Admin',
      }
    });
    if (!res || !res.ok) { avisar({ titulo: 'No se pudo aprobar el gasto', cuerpo: (res?.error || '') }); return; }
    mostrarToast('Aprobado');
    cerrarDetalleGasto();
    renderGastos();
  } catch(e) { avisar({ titulo: 'No se pudo aprobar el gasto', cuerpo: e.message }); }
};

window.rechazarGastoUI = async function(id) {
  const motivo = prompt('Motivo del rechazo:');
  if (!motivo) return;
  try {
    const res = await supabaseCall('POST', 'rpc/rechazar_gasto', {
      p_data: {
        idGasto: Number(id),
        motivo,
        aprobadoPor: N.vendedorInfo?.nombre || 'Admin',
      }
    });
    if (!res || !res.ok) { avisar({ titulo: 'No se pudo rechazar el gasto', cuerpo: (res?.error || '') }); return; }
    mostrarToast('Rechazado');
    cerrarDetalleGasto();
    renderGastos();
  } catch(e) { avisar({ titulo: 'No se pudo rechazar el gasto', cuerpo: e.message }); }
};

window.editarGastoUI = function(id) {
  const g = _gastos.find(x => String(x.id) === String(id));
  if (!g) return;
  cerrarDetalleGasto();
  // Pre-llenar el form
  abrirNuevoGasto();
  _editandoGasto = id;
  document.getElementById('ng-titulo').textContent = 'Editar gasto';
  document.getElementById('ng-fecha').value = g.fecha ? fechaDeValorCDMX(g.fecha) : '';
  document.getElementById('ng-categoria').value = g.categoria;
  actualizarSubcategorias();
  setTimeout(() => { document.getElementById('ng-subcategoria').value = g.subcategoria || ''; }, 50);
  document.getElementById('ng-concepto').value = g.concepto;
  document.getElementById('ng-monto').value = g.monto;
  document.getElementById('ng-tipo-pago').value = g.tipoPago;
  document.getElementById('ng-fuente').value = g.fuenteDinero;
  document.getElementById('ng-proveedor').value = g.proveedor;
  document.getElementById('ng-factura').value = g.factura;
  document.getElementById('ng-notas').value = g.notas;
  // v2.4.1 - cantidad si la subcategoría tiene métrica
  setTimeout(() => {
    if (g.cantidad > 0 && GASTOS_METRICAS_FRONT[g.subcategoria]) {
      document.getElementById('ng-cantidad').value = g.cantidad;
      actualizarCampoCantidad();
      recalcularPrecioUnitario();
    }
  }, 100);
};

window.eliminarGastoUI = async function(id) {
  if (!(await confirmar({ titulo: '¿Eliminar este gasto?', cuerpo: 'Esta acción no se puede deshacer.', aceptar: 'Eliminar', peligroso: true }))) return;
  try {
    // Borrar contabilidad no se deshace sin respaldos, así que el RPC lo
    // reserva al rol dueño.
    const res = await supabaseCall('POST', 'rpc/eliminar_gasto', { p_data: { id } });
    if (!res || !res.ok) { avisar({ titulo: 'No se pudo eliminar el gasto', cuerpo: ((res && res.error) || 'Sin respuesta') }); return; }
    mostrarToast('Eliminado');
    cerrarDetalleGasto();
    renderGastos();
  } catch(e) { avisar({ titulo: 'No se pudo eliminar el gasto', cuerpo: e.message }); }
};


// ══════════════════════════════════════════════════════════════════
// CAJA — apertura, cierre, movimientos, vista del día
// ══════════════════════════════════════════════════════════════════
let _cajaFecha = null;            // 'yyyy-mm-dd'
let _cajaPuntos = [];             // [{idPunto, nombre, tipo, cajaDia, movimientos, ...}]
let _cajaPuntoSeleccionado = null; // para drawer de mov manual

function fechaYYYYMMDD(d) {
  return fechaCDMX(d);
}

window.cajaHoy = function() {
  _cajaFecha = fechaYYYYMMDD(new Date());
  renderCaja();
};

window.cambiarFechaCaja = function(delta) {
  const d = new Date(_cajaFecha + 'T12:00:00');
  d.setDate(d.getDate() + delta);
  _cajaFecha = fechaYYYYMMDD(d);
  renderCaja();
};

// ── Armado (cola de pedidos, entrega 2) ──────────────────────────────────────
// Qué armar para una fecha: consolidado por sabor y presentación y una tarjeta
// por pedido con casilla. El servidor decide qué entra (cola_armado) y quién
// puede verlo (sección «armado»). Los pedidos Pendientes de esa fecha van
// aparte, «por confirmar»; confirmar sigue haciéndose en Pedidos.
window._armadoFecha = null;

function armadoFechaISO(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function armadoManana() { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + 1); return armadoFechaISO(d); }
function armadoFechaLarga(iso) { const d = new Date(iso + 'T12:00:00'); return d.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' }); }
const ARMADO_CANAL = { tienda: 'Abarrotes', restaurante: 'Restaurante', mayorista: 'Mayoreo', consumidor: 'Consumidor', mostrador: 'Mostrador', web: 'Web', b2b: 'B2B', telefono: 'Teléfono' };
function armadoLinea(l) {
  const ppc = Number(l.piezasPorCaja || 0);
  const n = Number(l.cantidad || 0);
  if (ppc > 0 && n >= ppc) { const cajas = Math.round(n / ppc); return `${cajas} caja${cajas === 1 ? '' : 's'} de ${ppc} · ${l.sabor} ${l.presentacion}`; }
  if (/granel/i.test(l.tipoVenta || '')) return `${(Number(l.gramos || 0) / 1000).toFixed(2)} kg ${l.sabor} granel`;
  return `${n} × ${l.sabor} ${l.presentacion}`;
}
const ARMADO_VACIO = '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>';

// ── Cola en vivo (entrega 3) ────────────────────────────────────────────────
// «Nuevos» = pedidos caídos desde el último vistazo (cp_armado_visto, por
// dispositivo). El refresco de 30 s solo corre con la pantalla activa y la
// pestaña visible; se detiene solo si la sesión caduca. El tono suena solo
// cuando el número de nuevos sube.
window._armadoTimer = null;
window._armadoNuevosPrev = null;
window._armadoAudio = null;
function armadoLS(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (_e) { return null; } }
function armadoSonidoActivo() { return armadoLS('cp_armado_sonido') !== '0'; }
function armadoPintarSonido() {
  const b = document.getElementById('armado-btn-sonido'), l = document.getElementById('armado-sonido-lbl');
  const on = armadoSonidoActivo();
  if (b) { b.setAttribute('aria-pressed', on ? 'true' : 'false'); b.style.color = on ? 'var(--amarillo)' : 'var(--suave)'; }
  if (l) l.textContent = on ? 'Sonido activado' : 'Sonido apagado';
}
window.armadoSonido = function() { armadoLS('cp_armado_sonido', armadoSonidoActivo() ? '0' : '1'); armadoPintarSonido(); if (armadoSonidoActivo()) armadoTono(); };
// El AudioContext solo puede nacer de un gesto del usuario; se crea en el
// primer toque y se reutiliza. Si el navegador lo niega, no suena y ya.
document.addEventListener('pointerdown', function () {
  if (window._armadoAudio) return;
  try { const AC = window.AudioContext || window.webkitAudioContext; if (AC) window._armadoAudio = new AC(); } catch (_e) {}
}, { passive: true });
function armadoTono() {
  if (!armadoSonidoActivo() || !window._armadoAudio) return;
  try {
    const ctx = window._armadoAudio; if (ctx.state === 'suspended') ctx.resume();
    [[880, 0], [1175, 0.16]].forEach(([hz, t0]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = hz; g.gain.value = 0.0001;
      o.connect(g); g.connect(ctx.destination);
      const t = ctx.currentTime + t0;
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      o.start(t); o.stop(t + 0.15);
    });
    window.__armadoTonos = (window.__armadoTonos || 0) + 1;   // bandera para las pruebas
  } catch (_e) {}
}
function armadoPantallaActiva() { return !!document.getElementById('s-armado')?.classList.contains('active'); }
function armadoTitulo(n) { document.title = (n > 0 ? '(' + n + ') ' : '') + (armadoPantallaActiva() ? 'Armado · Crunchy Paps' : N.ARMADO_TITULO_BASE); }
function armadoArrancarRefresco() {
  armadoPararRefresco();
  window._armadoTimer = setInterval(() => {
    if (!armadoPantallaActiva()) { armadoPararRefresco(); return; }
    if (document.visibilityState === 'hidden') return;
    renderArmado(true);
  }, 30000);
}
function armadoPararRefresco() { if (window._armadoTimer) { clearInterval(window._armadoTimer); window._armadoTimer = null; } }
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible' && armadoPantallaActiva() && window._armadoTimer) renderArmado(true);
});
window.armadoVisto = function() {
  armadoLS('cp_armado_visto', new Date().toISOString());
  window._armadoNuevosPrev = 0;
  renderArmado(true);
};
function armadoPintarNuevos(nuevos) {
  const el = document.getElementById('armado-nuevos');
  if (!el) return;
  const n = nuevos.length;
  if (window._armadoNuevosPrev !== null && n > window._armadoNuevosPrev) armadoTono();
  window._armadoNuevosPrev = n;
  armadoTitulo(n);
  if (!n) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div style="background:var(--gris);border:1px solid var(--amarillo);border-radius:14px;padding:12px 14px;">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px;">
        <div style="font-family:'Archivo',sans-serif;font-size:0.95rem;color:var(--amarillo);letter-spacing:1px;">NUEVOS (${n})</div>
        <button onclick="armadoVisto()" style="min-height:44px;background:var(--amarillo);border:none;border-radius:10px;padding:8px 14px;font-weight:800;font-size:0.8rem;color:var(--negro);cursor:pointer;">Visto</button>
      </div>
      ${nuevos.map(p => `
        <button onclick="verDetallePedido(${p.id})" style="display:block;width:100%;background:transparent;border:0;border-top:1px solid var(--gris3);padding:10px 0;color:var(--blanco);font-family:'Inter',sans-serif;font-size:0.84rem;text-align:left;cursor:pointer;min-height:44px;">
          <div style="display:flex;justify-content:space-between;gap:8px;"><b>${p.negocio || p.cliente || 'Sin nombre'}</b><span style="color:var(--suave);white-space:nowrap;">${new Date(p.fechaOrden).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}</span></div>
          <div style="color:var(--suave);font-size:0.74rem;">${p.consecutivo} · ${ARMADO_CANAL[p.canal] || p.canal || ''} · ${p.estatus} · entrega ${armadoFechaLarga(String(p.fechaEntrega).slice(0, 10))}</div>
          <div style="font-size:0.8rem;margin-top:2px;">${p.lineasResumen || ''}</div>
        </button>`).join('')}
    </div>`;
}

async function renderArmado(silencioso) {
  if (!window._armadoFecha) window._armadoFecha = armadoManana();
  const fecha = window._armadoFecha;
  const desde = armadoLS('cp_armado_visto') || null;
  armadoPintarSonido();
  if (!window._armadoTimer) armadoArrancarRefresco();
  const elF = document.getElementById('armado-fecha'), elH = document.getElementById('armado-hora');
  const elR = document.getElementById('armado-resumen'), elP = document.getElementById('armado-pedidos'), elC = document.getElementById('armado-por-confirmar');
  if (!elF || !elR) return;
  elF.textContent = armadoFechaLarga(fecha);
  if (!silencioso) {
    elR.innerHTML = '<div style="text-align:center;color:var(--suave);padding:20px;"><span class="loader"></span> Cargando…</div>';
    elP.innerHTML = ''; elC.innerHTML = '';
  }
  let r = null;
  try { r = await supabaseCall('POST', 'rpc/cola_armado', { p_data: desde ? { fecha, desde } : { fecha } }); } catch (e) { r = { ok: false, error: e.message }; }
  if (!r || !r.ok) {
    const caduco = sesionExpirada(r) || /autorizado/i.test(r?.error || '');
    if (caduco) { armadoPararRefresco(); armadoTitulo(0); }
    elR.innerHTML = `<div style="background:var(--gris);border-radius:12px;padding:16px;color:var(--suave);font-size:0.86rem;">${caduco ? 'Tu sesión no tiene la sección Armado o caducó. Vuelve a entrar.' : 'No se pudo cargar: ' + (r?.error || 'sin respuesta')}</div>`;
    return;
  }
  armadoPintarNuevos(Array.isArray(r.nuevos) ? r.nuevos : []);
  armadoPushPintar();
  if (elH) elH.textContent = r.horaLimite ? `Pedidos hasta las ${r.horaLimite} entran al día siguiente` : '';
  const t = r.totales || {};
  const resumen = Array.isArray(r.resumen) ? r.resumen : [];
  const pedidos = Array.isArray(r.pedidos) ? r.pedidos : [];
  const porConfirmar = Array.isArray(r.porConfirmar) ? r.porConfirmar : [];
  // Consolidado
  if (!resumen.length) {
    elR.innerHTML = `<div style="background:var(--gris);border:1px dashed var(--gris3);border-radius:12px;padding:22px;text-align:center;color:var(--suave);"><div class="ico-solo" style="margin-bottom:8px;">${ARMADO_VACIO}</div>Nada que armar para el ${armadoFechaLarga(fecha)}</div>`;
  } else {
    const filas = resumen.map(x => {
      const cajas = (x.cajas || []).map(c => `${c.cajas} × caja de ${c.piezasPorCaja}`).join(', ');
      return `<tr><td style="padding:8px 6px;">${x.sabor}<div style="color:var(--suave);font-size:0.72rem;">${x.presentacion}${cajas ? ' · ' + cajas : ''}</div></td><td style="padding:8px 6px;text-align:right;font-variant-numeric:tabular-nums;">${Number(x.piezas)}</td><td style="padding:8px 6px;text-align:right;font-variant-numeric:tabular-nums;">${Number(x.kg).toFixed(2)}</td></tr>`;
    }).join('');
    elR.innerHTML = `
      <div style="background:var(--gris);border-radius:14px;padding:12px 10px;">
        <div style="font-family:'Archivo',sans-serif;font-size:0.95rem;color:var(--amarillo);letter-spacing:1px;margin:0 6px 6px;">PARA ARMAR</div>
        <table style="width:100%;border-collapse:collapse;font-size:0.86rem;color:var(--blanco);">
          <thead><tr style="color:var(--suave);font-size:0.7rem;text-transform:uppercase;"><th style="text-align:left;padding:4px 6px;">Producto</th><th style="text-align:right;padding:4px 6px;">Piezas</th><th style="text-align:right;padding:4px 6px;">kg</th></tr></thead>
          <tbody>${filas}</tbody>
          <tfoot><tr style="border-top:1px solid var(--gris3);font-weight:800;"><td style="padding:8px 6px;">${t.pedidos} pedido${Number(t.pedidos) === 1 ? '' : 's'} · ${t.armados} armado${Number(t.armados) === 1 ? '' : 's'}</td><td style="padding:8px 6px;text-align:right;">${Number(t.piezas || 0)}</td><td style="padding:8px 6px;text-align:right;">${Number(t.kg || 0).toFixed(2)}</td></tr></tfoot>
        </table>
      </div>`;
  }
  // Por pedido y por confirmar: R2, con filtros, buscador y tabla si son muchos.
  window._armadoDatos = { pedidos, porConfirmar };
  armadoPintarPedidos();
}

window.armadoCambiarFecha = function(delta) {
  const d = new Date((window._armadoFecha || armadoManana()) + 'T12:00:00');
  d.setDate(d.getDate() + delta);
  window._armadoFecha = armadoFechaISO(d);
  renderArmado();
};
window.armadoRecargar = function() { renderArmado(); };

// ── Push «Pedido nuevo» en este dispositivo (entrega 4) ─────────────────────
// La suscripción vive en el navegador (service worker) y en push_suscripciones
// (por RPC con sesión y sección). En iPhone solo funciona con la PWA instalada.
function armadoPushSoporte() {
  return !!(window.__CP_CONFIG__ && window.__CP_CONFIG__.VAPID_PUBLIC_KEY) && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}
function armadoEsIphoneSinInstalar() {
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  return ios && window.navigator.standalone !== true && !window.matchMedia('(display-mode: standalone)').matches;
}
function armadoB64aBytes(b64) {
  const p = '='.repeat((4 - b64.length % 4) % 4); const s = (b64 + p).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(s); const out = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i); return out;
}
async function armadoPushSuscripcion() {
  try { const reg = await navigator.serviceWorker.ready; return await reg.pushManager.getSubscription(); } catch (_e) { return null; }
}
async function armadoPushPintar() {
  const el = document.getElementById('armado-push');
  if (!el) return;
  const caja = (titulo, texto, boton) => `
    <div style="background:var(--gris);border-radius:14px;padding:14px;">
      <div style="font-family:'Archivo',sans-serif;font-size:0.95rem;color:var(--amarillo);letter-spacing:1px;margin-bottom:4px;">${titulo}</div>
      <div style="font-size:0.8rem;color:var(--suave);margin-bottom:${boton ? '10px' : '0'};">${texto}</div>${boton || ''}
    </div>`;
  const btn = (txt, fn) => `<button onclick="${fn}()" style="width:100%;min-height:44px;background:var(--amarillo);border:none;border-radius:10px;padding:10px;font-weight:800;font-size:0.84rem;color:var(--negro);cursor:pointer;">${txt}</button>`;
  const btnGris = (txt, fn) => `<button onclick="${fn}()" style="width:100%;min-height:44px;background:transparent;border:1px solid var(--gris3);border-radius:10px;padding:10px;color:var(--blanco);font-family:'Inter',sans-serif;font-weight:700;font-size:0.84rem;cursor:pointer;">${txt}</button>`;
  if (armadoEsIphoneSinInstalar()) { el.innerHTML = caja('Avisos en este dispositivo', 'En iPhone los avisos solo llegan con la app instalada. Instálala primero.', btnGris('Cómo instalar la app', 'mostrarInstruccionesInstalar')); return; }
  if (!armadoPushSoporte()) { el.innerHTML = caja('Avisos en este dispositivo', 'Este navegador no puede recibir avisos, o el servidor no tiene configurado el push.'); return; }
  if (Notification.permission === 'denied') { el.innerHTML = caja('Avisos en este dispositivo', 'Los avisos están bloqueados en los ajustes del navegador para este sitio.'); return; }
  const sub = await armadoPushSuscripcion();
  el.innerHTML = sub
    ? caja('Avisos en este dispositivo', 'Activados: cada pedido nuevo llega como notificación aunque la app esté cerrada.', btnGris('Desactivar en este dispositivo', 'armadoPushDesactivar'))
    : caja('Avisos en este dispositivo', 'Recibe una notificación por cada pedido nuevo, aunque la app esté cerrada.', btn('Activar avisos', 'armadoPushActivar'));
}
window.armadoPushActivar = async function() {
  try {
    const permiso = await Notification.requestPermission();
    if (permiso !== 'granted') { mostrarToast('Sin permiso para avisos'); armadoPushPintar(); return; }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: armadoB64aBytes(window.__CP_CONFIG__.VAPID_PUBLIC_KEY) });
    const j = sub.toJSON();
    const r = await supabaseCall('POST', 'rpc/guardar_suscripcion_push', { p_data: { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, userAgent: navigator.userAgent } });
    if (!r || !r.ok) { await sub.unsubscribe(); await avisar({ titulo: 'No se pudo activar el aviso', cuerpo: r?.error || 'Sin respuesta' }); }
    else mostrarToast('Avisos activados en este dispositivo');
  } catch (e) {
    await avisar({ titulo: 'No se pudo activar el aviso', cuerpo: e.message || '' });
  }
  armadoPushPintar();
};
window.armadoPushDesactivar = async function() {
  try {
    const sub = await armadoPushSuscripcion();
    if (sub) {
      const endpoint = sub.endpoint;
      await sub.unsubscribe();
      await supabaseCall('POST', 'rpc/borrar_suscripcion_push', { p_data: { endpoint } });
    }
    mostrarToast('Avisos desactivados en este dispositivo');
  } catch (e) {
    await avisar({ titulo: 'No se pudo desactivar', cuerpo: e.message || '' });
  }
  armadoPushPintar();
};

// ── Armado a escala (R2, 15 sep 2026) ───────────────────────────────────────
// Con seis pedidos o menos, tarjetas; con más, tabla compacta. Filtro «Por
// armar» por defecto, buscador por folio o nombre, y lista de empaque antes de
// marcar. Nada de esto vuelve a pedir al servidor: pinta window._armadoDatos.
window._armadoDatos = null;
window._armadoFiltro = 'por-armar';
window._armadoBusqueda = '';
const ARMADO_ESTILO = document.createElement('style');
ARMADO_ESTILO.textContent = `
  .armado-chip{min-height:40px;padding:0 14px;border-radius:999px;border:1px solid var(--gris3);background:transparent;color:var(--suave);font-family:'Inter',sans-serif;font-weight:700;font-size:0.8rem;cursor:pointer}
  .armado-chip[aria-pressed="true"]{background:var(--amarillo);border-color:var(--amarillo);color:var(--negro)}
  .armado-chip:focus-visible{outline:3px solid var(--amarillo);outline-offset:2px}
  .armado-tabla{width:100%;border-collapse:collapse;font-size:0.8rem;color:var(--blanco)}
  .armado-tabla th{text-align:left;padding:6px 6px;color:var(--suave);font-size:0.68rem;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid var(--gris3)}
  .armado-tabla td{padding:8px 6px;border-bottom:1px solid var(--gris3);vertical-align:top}
  .armado-tabla tr.hecho td{opacity:.6}
  .armado-tabla .folio{color:var(--suave);font-size:0.7rem}
  .armado-ruta{display:inline-block;padding:1px 7px;border-radius:999px;font-size:0.66rem;font-weight:800;color:var(--negro);white-space:nowrap}
  .armado-editado{display:inline-block;padding:1px 7px;border-radius:999px;font-size:0.66rem;font-weight:800;color:var(--blanco);background:var(--rojo);white-space:nowrap}
  .armado-fila-btn{background:transparent;border:0;padding:0;color:inherit;font:inherit;text-align:left;cursor:pointer;min-height:44px;display:block;width:100%}
`;
document.head.appendChild(ARMADO_ESTILO);
// Regla 3 de la revisión final (spec cambios/2026-09-20-editar-pedido/diseno.md:287-290): un pedido
// editado tras armarse vuelve a «Por armar» sin ninguna marca que lo distinga de uno nunca tocado, y
// el push del webhook es solo-INSERT (no avisa de la edición). La etiqueta «Editado» es esa marca.
function armadoEditadoBadge(p) {
  if (!p || !p.editadoEn || (p.armadoEn && !(new Date(p.editadoEn) > new Date(p.armadoEn)))) return '';
  const titulo = p.editadoPor ? `Editado por ${rutaEsc(p.editadoPor)}` : 'Editado';
  return `<span class="armado-editado" title="${titulo}">Editado</span>`;
}
function armadoRutaBadge(p) { return p && p.ruta ? `<span class="armado-ruta" style="background:${p.rutaColor || 'var(--amarillo)'};">${p.ruta}</span>` : ''; }
function armadoFechaCorta(iso, conDia = true) { if (!iso) return '—'; const d = new Date(String(iso).length <= 10 ? iso + 'T12:00:00' : iso); return isNaN(d) ? '—' : d.toLocaleDateString('es-MX', conDia ? { weekday: 'short', day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short' }); }
function armadoHora(iso) { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }); }
function armadoHoraCorta(iso) { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false }); }
function armadoPiezasKg(p) { const ls = p.lineas || []; return { piezas: ls.reduce((s, l) => s + (/granel/i.test(l.tipoVenta || '') ? 0 : Number(l.cantidad || 0)), 0), kg: ls.reduce((s, l) => s + Number(l.kg || 0), 0) }; }
function armadoCoincide(p) {
  const q = (window._armadoBusqueda || '').trim().toLowerCase();
  if (!q) return true;
  return [p.consecutivo, p.negocio, p.cliente, p.ruta].some(v => String(v || '').toLowerCase().includes(q));
}
function armadoOrden(a, b) {
  const ra = a.rutaOrden ?? (a.ruta ? 0 : 9), rb = b.rutaOrden ?? (b.ruta ? 0 : 9);
  return ra - rb || String(a.fechaOrden || '').localeCompare(String(b.fechaOrden || ''));
}
window.armadoFiltro = function(f) { window._armadoFiltro = f; armadoPintarPedidos(); };
window.armadoBuscar = function(t) { window._armadoBusqueda = t || ''; armadoPintarPedidos(); };
function armadoPintarPedidos() {
  const d = window._armadoDatos; const elP = document.getElementById('armado-pedidos'), elC = document.getElementById('armado-por-confirmar'), elF = document.getElementById('armado-filtros');
  if (!d || !elP || !elC) return;
  const pedidos = (d.pedidos || []).filter(armadoCoincide).sort(armadoOrden);
  const porConfirmar = (d.porConfirmar || []).filter(armadoCoincide).sort(armadoOrden);
  const muchos = (d.pedidos || []).length + (d.porConfirmar || []).length > 6;
  if (elF) { elF.style.display = muchos ? 'block' : 'none'; elF.querySelectorAll('.armado-chip').forEach(b => b.setAttribute('aria-pressed', b.dataset.f === window._armadoFiltro ? 'true' : 'false')); }
  const f = muchos ? window._armadoFiltro : 'todos-tarjetas';
  // ── Tarjetas (pocos pedidos): como hasta ahora ──
  if (!muchos) {
    elP.innerHTML = pedidos.map(p => {
      const canal = p.tipoInterno ? `Interno · ${p.tipoInterno}` : (ARMADO_CANAL[p.canal] || p.canal || '');
      const quien = p.negocio || p.cliente || 'Sin nombre';
      const hecho = !!p.armadoEn;
      return `
      <div style="background:var(--gris);border:1px solid ${hecho ? 'var(--verde, #1f7a2e)' : 'var(--gris3)'};border-radius:14px;padding:12px 14px;margin-bottom:10px;opacity:${hecho ? 0.75 : 1};">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
          <div style="min-width:0;">
            <div style="font-weight:800;color:var(--blanco);">${quien}</div>
            <div style="color:var(--suave);font-size:0.74rem;">${p.consecutivo} · ${canal}${p.vendedor ? ' · ' + p.vendedor : ''} ${armadoRutaBadge(p)}${armadoEditadoBadge(p)}</div>
          </div>
          <label style="display:flex;align-items:center;gap:8px;min-height:44px;cursor:pointer;font-size:0.8rem;color:var(--blanco);white-space:nowrap;">
            <input type="checkbox" ${hecho ? 'checked' : ''} onchange="armadoMarcarConLista(${p.id}, this)" style="width:24px;height:24px;accent-color:var(--amarillo);"> Armado
          </label>
        </div>
        <ul style="margin:8px 0 0;padding-left:18px;color:var(--blanco);font-size:0.84rem;line-height:1.5;">${(p.lineas || []).map(l => '<li>' + armadoLinea(l) + '</li>').join('')}</ul>
        ${hecho ? `<div style="color:var(--suave);font-size:0.7rem;margin-top:6px;">Armado por ${p.armadoPor || '—'} · ${armadoHora(p.armadoEn)}</div>` : ''}
      </div>`;
    }).join('');
    elC.innerHTML = porConfirmar.length ? `
      <div style="font-family:'Archivo',sans-serif;font-size:0.9rem;color:var(--suave);letter-spacing:1px;margin:6px 0 8px;">POR CONFIRMAR (${porConfirmar.length})</div>
      ${porConfirmar.map(p => `
        <button onclick="verDetallePedido(${p.id})" style="display:flex;justify-content:space-between;align-items:center;width:100%;min-height:44px;background:transparent;border:1px dashed var(--gris3);border-radius:12px;padding:10px 14px;margin-bottom:8px;color:var(--blanco);font-family:'Inter',sans-serif;font-size:0.84rem;text-align:left;cursor:pointer;">
          <span style="min-width:0;flex:1 1 auto;overflow-wrap:anywhere;"><b>${p.negocio || p.cliente || 'Sin nombre'}</b><span style="color:var(--suave);"> · ${p.consecutivo} · ${ARMADO_CANAL[p.canal] || p.canal || ''}</span> ${armadoRutaBadge(p)}</span>
          <span style="color:var(--amarillo);font-weight:800;white-space:nowrap;flex-shrink:0;margin-left:10px;">Confirmar ›</span>
        </button>`).join('')}` : '';
    return;
  }
  // ── Tabla (muchos pedidos) ──
  elC.innerHTML = '';
  let filas = [];
  if (f === 'por-armar') filas = pedidos.filter(p => !p.armadoEn).map(p => ({ p, tipo: 'proceso' }));
  else if (f === 'armados') filas = pedidos.filter(p => !!p.armadoEn).map(p => ({ p, tipo: 'proceso' }));
  else if (f === 'por-confirmar') filas = porConfirmar.map(p => ({ p, tipo: 'pendiente' }));
  else filas = [...porConfirmar.map(p => ({ p, tipo: 'pendiente' })), ...pedidos.map(p => ({ p, tipo: 'proceso' }))];
  if (!filas.length) { elP.innerHTML = `<div style="background:var(--gris);border:1px dashed var(--gris3);border-radius:12px;padding:18px;text-align:center;color:var(--suave);font-size:0.86rem;">Nada en este filtro${window._armadoBusqueda ? ' con «' + window._armadoBusqueda + '»' : ''}.</div>`; return; }
  const tr = ({ p, tipo }) => {
    const { piezas, kg } = armadoPiezasKg(p);
    const quien = p.negocio || p.cliente || 'Sin nombre';
    const hecho = !!p.armadoEn;
    const estado = tipo === 'pendiente'
      ? `<button type="button" onclick="verDetallePedido(${p.id})" style="min-height:44px;background:transparent;border:1px dashed var(--gris3);border-radius:8px;padding:0 10px;color:var(--amarillo);font-family:'Inter',sans-serif;font-weight:800;font-size:0.76rem;cursor:pointer;white-space:nowrap;">Confirmar ›</button>`
      : `<label style="display:flex;align-items:center;gap:6px;min-height:44px;cursor:pointer;font-size:0.76rem;color:var(--blanco);white-space:nowrap;"><input type="checkbox" ${hecho ? 'checked' : ''} onchange="armadoMarcarConLista(${p.id}, this)" style="width:22px;height:22px;accent-color:var(--amarillo);"> ${hecho ? 'Armado' : 'Armar'}</label>`;
    return `<tr class="${hecho ? 'hecho' : ''}">
      <td><button class="armado-fila-btn" onclick="verDetallePedido(${p.id})"><b>${quien}</b><div class="folio">${p.consecutivo} · ${p.tipoInterno ? 'Interno' : (ARMADO_CANAL[p.canal] || p.canal || '')}${hecho ? ' · ' + (p.armadoPor || '') : ''}</div>${armadoEditadoBadge(p) ? '<div style="margin-top:3px;">' + armadoEditadoBadge(p) + '</div>' : ''}</button></td>
      <td style="white-space:nowrap;"><div class="folio">pedido</div>${armadoFechaCorta(p.fechaOrden, false)} · ${armadoHoraCorta(p.fechaOrden)}<div class="folio" style="margin-top:4px;">entrega</div>${armadoFechaCorta(p.fechaEntrega || window._armadoFecha)}${p.ruta ? '<div style="margin-top:3px;">' + armadoRutaBadge(p) + '</div>' : ''}</td>
      <td style="text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;">${tipo === 'pendiente' ? '—' : piezas + '<div class="folio">' + kg.toFixed(2) + ' kg</div>'}</td>
      <td>${estado}</td>
    </tr>`;
  };
  elP.innerHTML = `
    <div style="background:var(--gris);border-radius:14px;padding:6px 8px;overflow-x:auto;">
      <table class="armado-tabla">
        <thead><tr><th>Pedido</th><th>Fechas</th><th style="text-align:right;">Pzas · kg</th><th>Armado</th></tr></thead>
        <tbody>${filas.map(tr).join('')}</tbody>
      </table>
      <div style="color:var(--suave);font-size:0.72rem;padding:8px 6px 4px;">${filas.length} de ${(d.pedidos || []).length + (d.porConfirmar || []).length} pedidos del día</div>
    </div>`;
}
// Lista de empaque: antes de marcar, el cuadro enseña qué lleva el pedido.
window.armadoMarcarConLista = async function(id, input) {
  const checked = !!(input && input.checked);
  if (!checked) { return armadoMarcar(id, false); }
  const p = ((window._armadoDatos && window._armadoDatos.pedidos) || []).find(x => String(x.id) === String(id));
  const lineas = p ? (p.lineas || []).map(armadoLinea) : [];
  const ok = await confirmar({
    titulo: 'Este pedido incluye:',
    cuerpo: (p ? (p.negocio || p.cliente || 'Sin nombre') + ' · ' + p.consecutivo + N.SALTO + N.SALTO : '') + (lineas.length ? lineas.map(l => '• ' + l).join(N.SALTO) : 'Sin líneas de papa') + N.SALTO + N.SALTO + '¿Está armado y completo?',
    aceptar: 'Sí, armado', cancelar: 'Todavía no',
  });
  if (!ok) { if (input) input.checked = false; return; }
  return armadoMarcar(id, true);
};

window.armadoMarcar = async function(id, checked) {
  try {
    const r = await supabaseCall('POST', 'rpc/marcar_armado', { p_data: { id, armado: !!checked } });
    if (!r || !r.ok) {
      await avisar({ titulo: 'No se pudo marcar el pedido', cuerpo: r?.motivo || r?.error || 'Sin respuesta' });
    } else {
      mostrarToast(checked ? `${r.consecutivo} armado` : `${r.consecutivo} sin armar`);
    }
  } catch (e) {
    await avisar({ titulo: 'No se pudo marcar el pedido', cuerpo: e.message || '' });
  }
  renderArmado(true);   // repinta con lo que diga el servidor, pase lo que pase
};

async function renderCaja() {
  if (!_cajaFecha) _cajaFecha = fechaYYYYMMDD(new Date());

  // Actualizar label de fecha
  const lbl = document.getElementById('caja-fecha-label');
  if (lbl) {
    const d = new Date(_cajaFecha + 'T12:00:00');
    const hoy = fechaYYYYMMDD(new Date());
    const ayer = (() => { const a = new Date(); a.setDate(a.getDate()-1); return fechaYYYYMMDD(a); })();
    let prefijo = '';
    if (_cajaFecha === hoy) prefijo = 'HOY · ';
    else if (_cajaFecha === ayer) prefijo = 'AYER · ';
    lbl.textContent = prefijo + d.toLocaleDateString('es-MX', { weekday:'long', day:'numeric', month:'short', year:'numeric' });
  }

  const cont = document.getElementById('caja-contenedor');
  cont.innerHTML = '<div style="text-align:center;color:var(--suave);padding:30px 0;"><span class="loader loader-w"></span> Cargando...</div>';

  try {
    const res = await supabaseCall('POST', 'rpc/obtener_caja_dia', { p_fecha: _cajaFecha });
    if (!res || !res.ok) {
      cont.innerHTML = '<div style="color:var(--rojo);padding:14px;">Error al cargar caja</div>';
      return;
    }
    _cajaPuntos = res.puntos || [];
    pintarCaja();
  } catch(e) {
    cont.innerHTML = '<div style="color:var(--rojo);padding:14px;">Error: ' + e.message + '</div>';
  }
}

function pintarCaja() {
  const cont = document.getElementById('caja-contenedor');
  const esHoy = _cajaFecha === fechaYYYYMMDD(new Date());

  if (_cajaPuntos.length === 0) {
    cont.innerHTML = '<div style="color:var(--suave);text-align:center;padding:30px;">No hay puntos de caja configurados</div>';
    return;
  }

  const esMostradorOAdmin = (esAdmin && esAdmin()) || (N.esVendedor && /mostrador/i.test(N.vendedorInfo?.rol || ''));

  // Solo centrales (Punto de Venta + Cuenta Bancaria)
  const centrales = _cajaPuntos.filter(p =>
    p.codigo === 'punto_venta' || p.codigo === 'cuenta_banco' || (!p.idVendedor && p.subtipo !== 'vendedor_personal')
  );

  let html = '';

  // v2.10: Alerta de cajas abiertas de días anteriores (solo en vista HOY)
  if (esHoy) {
    html += '<div id="caja-alerta-pasada" style="margin-bottom:10px;"></div>';
  }

  if (centrales.length > 0) {
    html += centrales.map(p => renderPuntoCaja(p, esHoy)).join('');
  }

  // Cargar y renderizar pendientes solo para admin/mostrador y solo en fecha de hoy
  if (esMostradorOAdmin) {
    html += '<div id="caja-pendientes" style="margin-top:14px;"><div style="text-align:center;color:var(--suave);font-size:0.82rem;padding:10px;"><span class="loader loader-w"></span> Cargando pendientes...</div></div>';
    cont.innerHTML = html;
    cargarPendientesCaja();
  } else {
    cont.innerHTML = html;
  }

  // Disparar la búsqueda de cajas abiertas del día anterior (solo en HOY)
  if (esHoy) verificarCajasAbiertasAnteriores();
}

async function verificarCajasAbiertasAnteriores() {
  const cont = document.getElementById('caja-alerta-pasada');
  if (!cont) return;
  try {
    const hoy = fechaYYYYMMDD(new Date());
    // Buscar cajas abiertas con fecha < hoy
    const url = `caja_dias?estatus=eq.abierta&fecha=lt.${hoy}&order=fecha.asc&select=id,fecha,id_punto,saldo_apertura,abierta_por`;
    const res = await supabaseCall('GET', url);
    if (!Array.isArray(res) || res.length === 0) {
      cont.innerHTML = '';
      return;
    }
    // Render alerta
    const lista = res.map(c => {
      const punto = _cajaPuntos.find(p => p.idPunto === c.id_punto);
      const nombre = punto ? punto.nombre : ('punto ' + c.id_punto);
      const fecha = new Date(c.fecha + 'T12:00:00').toLocaleDateString('es-MX', {day:'numeric', month:'short'});
      return `<li style="margin-top:4px;"><strong>${nombre}</strong> — abierta desde ${fecha}</li>`;
    }).join('');
    cont.innerHTML = `
      <div style="background:#2d1a00;border-left:3px solid #ffa500;border-radius:8px;padding:10px 12px;font-size:0.84rem;color:var(--blanco);">
        <div style="font-weight:800;color:#ffa500;margin-bottom:6px;">Hay cajas abiertas de días anteriores</div>
        <ul style="margin:0;padding-left:18px;color:var(--suave);font-size:0.78rem;">${lista}</ul>
        <div style="margin-top:6px;font-size:0.72rem;color:var(--suave);">Navega con ◀ a esos días para cerrarlas antes de continuar.</div>
      </div>
    `;
  } catch(e) {
    // silencioso
  }
}

async function cargarPendientesCaja() {
  const cont = document.getElementById('caja-pendientes');
  if (!cont) return;
  try {
    const res = await supabaseCall('POST', 'rpc/obtener_pendientes_caja', { p_token: tokenVendedor() });
    if (!res || !res.ok) {
      cont.innerHTML = '';
      return;
    }
    const efectivoArr = res.efectivoPorVendedor || [];
    const transferArr = res.transferenciasPendientes || [];
    const tot = res.totales || {};

    let html = '';

    // Resumen rápido
    if ((tot.numEfectivoPendiente || 0) > 0 || (tot.numTransferPendiente || 0) > 0) {
      html += `
        <div style="background:var(--gris);border-radius:10px;padding:10px;margin-bottom:12px;">
          <div style="font-size:0.7rem;color:var(--amarillo);font-weight:800;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:6px;">Pendientes de procesar</div>
          ${(tot.numEfectivoPendiente||0) > 0 ? `<div style="display:flex;justify-content:space-between;font-size:0.84rem;color:var(--blanco);margin-bottom:3px;"><span>Efectivo en vendedores</span><span style="font-family:'Archivo',sans-serif;color:#ffc107;">$${Number(tot.totalEfectivoPendiente).toLocaleString('es-MX',{minimumFractionDigits:2})}</span></div>` : ''}
          ${(tot.numTransferPendiente||0) > 0 ? `<div style="display:flex;justify-content:space-between;font-size:0.84rem;color:var(--blanco);"><span>Transferencias por verificar</span><span style="font-family:'Archivo',sans-serif;color:#ffc107;">$${Number(tot.totalTransferPendiente).toLocaleString('es-MX',{minimumFractionDigits:2})}</span></div>` : ''}
        </div>
      `;
    }

    // Sección efectivo por vendedor
    if (efectivoArr.length > 0) {
      html += '<div style="font-family:\'Archivo\',sans-serif;font-size:0.9rem;color:var(--suave);letter-spacing:1.5px;margin:14px 0 8px;">EFECTIVO PENDIENTE POR VENDEDOR</div>';
      html += efectivoArr.map(v => renderEfectivoVendedor(v)).join('');
    }

    // Sección transferencias pendientes
    if (transferArr.length > 0) {
      html += '<div style="font-family:\'Archivo\',sans-serif;font-size:0.8rem;color:var(--suave);letter-spacing:0;margin:14px 0 8px;">TRANSFERENCIAS POR CONFIRMAR EN BANCO</div>';
      html += transferArr.map(p => renderTransferPendiente(p)).join('');
    }

    if (efectivoArr.length === 0 && transferArr.length === 0) {
      html += '<div style="background:var(--gris);border-radius:12px;padding:14px;margin-top:8px;font-size:0.84rem;color:var(--suave);text-align:center;">No hay pedidos pendientes de procesar.</div>';
    }

    cont.innerHTML = html;
  } catch(e) {
    cont.innerHTML = '<div style="color:var(--rojo);padding:10px;">Error cargando pendientes: ' + e.message + '</div>';
  }
}

function renderEfectivoVendedor(v) {
  const alerta = v.diasMasViejo >= 2
    ? `<span style="font-size:0.7rem;color:var(--rojo);font-weight:800;">${v.diasMasViejo} días sin entregar</span>`
    : '';

  const pedidosHTML = (v.pedidos || []).map(p => {
    const f = p.fecha ? new Date(p.fecha) : null;
    const fechaFmt = f ? f.toLocaleString('es-MX',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) : '—';
    return `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px;background:var(--gris2);border-radius:8px;margin-top:6px;">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:800;font-size:0.82rem;color:var(--blanco);">${p.consec}</div>
          <div style="font-size:0.7rem;color:var(--suave);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.cliente || '—'} · ${fechaFmt}</div>
        </div>
        <div style="font-family:'Archivo',sans-serif;color:var(--amarillo);font-size:1.1rem;">$${Number(p.monto).toLocaleString('es-MX',{minimumFractionDigits:2})}</div>
        <button onclick="abrirAccionesPendiente(${p.idOrden}, '${p.consec}', ${p.monto}, 'efectivo')" style="background:transparent;border:1px solid var(--amarillo);border-radius:6px;padding:5px 10px;color:var(--amarillo);font-size:0.72rem;font-weight:800;cursor:pointer;">⋯</button>
      </div>
    `;
  }).join('');

  return `
    <div style="background:var(--gris);border-radius:12px;padding:12px;margin-bottom:10px;border-left:3px solid #ffc107;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div style="flex:1;min-width:0;">
          <div style="font-family:'Archivo',sans-serif;font-size:1.1rem;color:var(--blanco);letter-spacing:1px;">${v.nombreVendedor}</div>
          <div style="font-size:0.72rem;color:var(--suave);">${v.numPedidos} pedido${v.numPedidos===1?'':'s'} ${alerta}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:0.62rem;color:var(--suave);text-transform:uppercase;letter-spacing:1px;">Pendiente</div>
          <div style="font-family:'Archivo',sans-serif;font-size:1.4rem;color:#ffc107;line-height:1;">$${Number(v.montoTotal).toLocaleString('es-MX',{minimumFractionDigits:2})}</div>
        </div>
      </div>
      <details style="margin-top:8px;">
        <summary style="font-size:0.72rem;color:var(--amarillo);cursor:pointer;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;">Ver pedidos (${v.numPedidos})</summary>
        <div style="margin-top:6px;">${pedidosHTML}</div>
      </details>
    </div>
  `;
}

function renderTransferPendiente(p) {
  const f = p.fecha ? new Date(p.fecha) : null;
  const fechaFmt = f ? f.toLocaleString('es-MX',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) : '—';
  const alerta = p.diasEspera >= 1
    ? `<span style="font-size:0.7rem;color:var(--rojo);font-weight:800;margin-left:6px;">${p.diasEspera}d</span>`
    : '';
  return `
    <div style="background:var(--gris);border-radius:12px;padding:12px;margin-bottom:8px;border-left:3px solid #ffc107;display:flex;justify-content:space-between;align-items:center;gap:8px;">
      <div style="flex:1;min-width:0;">
        <div style="display:flex;align-items:baseline;gap:6px;">
          <span style="font-weight:800;color:var(--blanco);font-size:0.88rem;">${p.consec}</span>
          ${alerta}
        </div>
        <div style="font-size:0.72rem;color:var(--suave);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.cliente || '—'} · ${fechaFmt}</div>
        <div style="font-size:0.7rem;color:#888;margin-top:1px;">${p.tipoPago}${p.nombreVendedor ? ' · vía ' + p.nombreVendedor : ''}</div>
      </div>
      <div style="text-align:right;">
        <div style="font-family:'Archivo',sans-serif;color:#ffc107;font-size:1.2rem;">$${Number(p.monto).toLocaleString('es-MX',{minimumFractionDigits:2})}</div>
      </div>
      <button onclick="abrirAccionesPendiente(${p.idOrden}, '${p.consec}', ${p.monto}, 'transferencia')" style="background:transparent;border:1px solid var(--amarillo);border-radius:6px;padding:5px 10px;color:var(--amarillo);font-size:0.72rem;font-weight:800;cursor:pointer;">⋯</button>
    </div>
  `;
}

function renderPuntoCaja(p, esHoy) {
  const tipoIco = p.tipo === 'efectivo' ? '' : '';
  const cajaDia = p.cajaDia;
  const estatusDia = cajaDia ? cajaDia.estatus : 'no_abierta';

  // Saldo del día (apertura + movimientos del día)
  const saldoApertura = cajaDia ? Number(cajaDia.saldo_apertura) || 0 : 0;
  const totalIngresos = Number(p.totalIngresos) || 0;
  const totalEgresos = Number(p.totalEgresos) || 0;
  const saldoCalculado = saldoApertura + totalIngresos + totalEgresos;
  const numVentas = Number(p.numVentas) || 0;
  const numGastos = Number(p.numGastos) || 0;
  const movimientos = p.movimientos || [];

  // Estado visual
  let estadoBadge = '';
  let estadoColor = '';
  if (estatusDia === 'abierta') {
    estadoBadge = 'ABIERTA';
    estadoColor = '#4caf50';
  } else if (estatusDia === 'cerrada') {
    estadoBadge = 'CERRADA';
    estadoColor = 'var(--suave)';
  } else {
    estadoBadge = 'SIN ABRIR';
    estadoColor = 'var(--suave)';
  }

  // Alerta fondo mínimo
  const fondoMin = Number(p.fondoMinimo) || 0;
  const alertaFondo = (p.tipo === 'efectivo' && fondoMin > 0 && saldoCalculado < fondoMin && estatusDia === 'abierta')
    ? `<div style="background:#2d0d0d;border:1px solid var(--rojo);border-radius:8px;padding:8px;margin:10px 0;font-size:0.78rem;color:var(--rojo);">Saldo bajo el fondo mínimo de $${fondoMin}</div>`
    : '';

  // Acciones
  let acciones = '';
  if (estatusDia === 'no_abierta' && esHoy) {
    acciones = `<button onclick="abrirAperturaCaja(${p.idPunto})" style="flex:1;background:var(--amarillo);border:none;border-radius:10px;padding:12px;font-family:'Inter',sans-serif;font-weight:800;font-size:0.88rem;color:var(--negro);cursor:pointer;">Abrir caja</button>`;
  } else if (estatusDia === 'abierta') {
    acciones = `
      <button onclick="abrirMovCaja(${p.idPunto})" style="flex:1;background:transparent;border:1px solid var(--amarillo);border-radius:10px;padding:10px;font-family:'Inter',sans-serif;font-weight:800;font-size:0.82rem;color:var(--amarillo);cursor:pointer;">+ Movimiento</button>
      <button onclick="abrirCierreCaja(${p.idPunto})" style="flex:1;background:transparent;border:1px solid #555;border-radius:10px;padding:10px;font-family:'Inter',sans-serif;font-weight:800;font-size:0.82rem;color:var(--suave);cursor:pointer;">Cerrar caja</button>
    `;
  } else if (estatusDia === 'cerrada') {
    const diferencia = Number(cajaDia.diferencia) || 0;
    const declarado = Number(cajaDia.saldo_cierre_declarado) || 0;
    const calculado = Number(cajaDia.saldo_cierre_calculado) || 0;
    acciones = `
      <div style="flex:1;background:var(--gris2);border-radius:10px;padding:10px;font-size:0.78rem;color:var(--suave);">
        Cierre: $${declarado.toLocaleString('es-MX')} declarado · $${calculado.toLocaleString('es-MX')} calculado<br>
        ${diferencia !== 0 ? `<span style="color:${diferencia>0?'#4caf50':'var(--rojo)'};">Diferencia: ${diferencia>0?'+':''}$${diferencia.toLocaleString('es-MX')}</span>` : '<span style="color:#4caf50;">Cuadrado ✓</span>'}
      </div>
    `;
  }

  // Movimientos
  const movHTML = movimientos.length === 0
    ? '<div style="color:#555;font-size:0.78rem;padding:8px;text-align:center;">Sin movimientos</div>'
    : movimientos.slice(0, 50).map(m => {
        const hora = m.fecha ? new Date(m.fecha).toLocaleTimeString('es-MX', {hour:'2-digit', minute:'2-digit'}) : '';
        const ico = {
          apertura: '', cierre: '',
          venta_efectivo: '', venta_transferencia: '', venta_tarjeta: '',
          gasto_efectivo: '', gasto_transferencia: '',
          retiro: '↗️', deposito: '↙️',
          ajuste_pos: '', ajuste_neg: '',
        }[m.tipo] || '·';
        const monto = Number(m.monto) || 0;
        const color = monto > 0 ? '#4caf50' : monto < 0 ? 'var(--rojo)' : 'var(--blanco)';
        const signo = monto > 0 ? '+' : '';
        return `
          <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #1a1a1a;">
            
            <div style="flex:1;min-width:0;">
              <div style="font-size:0.84rem;color:var(--blanco);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${m.descripcion || m.tipo}</div>
              <div style="font-size:0.7rem;color:#555;">${hora} · ${m.actor || ''}</div>
            </div>
            <div style="text-align:right;font-family:'Archivo',sans-serif;font-size:1.1rem;color:${color};">${signo}$${monto.toLocaleString('es-MX', {minimumFractionDigits:2, maximumFractionDigits:2})}</div>
          </div>`;
      }).join('');

  return `
    <div style="background:var(--gris);border-radius:12px;padding:14px;margin-bottom:12px;border-left:3px solid ${estadoColor};">
      <!-- Header del punto -->
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <div>
          <div style="font-family:'Archivo',sans-serif;font-size:1.2rem;color:var(--blanco);letter-spacing:1px;">${tipoIco} ${p.nombre}</div>
          <div style="font-size:0.7rem;color:${estadoColor};font-weight:700;">${estadoBadge}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:0.66rem;color:var(--suave);text-transform:uppercase;letter-spacing:1px;">${estatusDia==='cerrada'?'Saldo cierre':'Saldo'} </div>
          <div style="font-family:'Archivo',sans-serif;font-size:1.6rem;color:var(--amarillo);line-height:1;">$${saldoCalculado.toLocaleString('es-MX', {minimumFractionDigits:2})}</div>
        </div>
      </div>

      ${alertaFondo}

      ${estatusDia !== 'no_abierta' ? `
      <!-- Desglose -->
      <div style="background:var(--gris2);border-radius:8px;padding:10px;margin-bottom:10px;font-size:0.78rem;">
        <div style="display:flex;justify-content:space-between;color:var(--suave);">
          <span>Apertura</span>
          <span>$${saldoApertura.toLocaleString('es-MX')}</span>
        </div>
        ${totalIngresos > 0 ? `<div style="display:flex;justify-content:space-between;color:#4caf50;margin-top:4px;">
          <span>Ingresos (${numVentas} ventas)</span>
          <span>+$${totalIngresos.toLocaleString('es-MX')}</span>
        </div>` : ''}
        ${totalEgresos < 0 ? `<div style="display:flex;justify-content:space-between;color:var(--rojo);margin-top:4px;">
          <span>Egresos (${numGastos} gastos)</span>
          <span>$${totalEgresos.toLocaleString('es-MX')}</span>
        </div>` : ''}
      </div>
      ` : ''}

      ${acciones ? `<div style="display:flex;gap:8px;margin-bottom:10px;">${acciones}</div>` : ''}

      ${estatusDia !== 'no_abierta' ? `
      <!-- Movimientos -->
      <details style="margin-top:6px;">
        <summary style="font-size:0.78rem;color:var(--amarillo);cursor:pointer;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;">Movimientos del día (${movimientos.length})</summary>
        <div style="margin-top:8px;">${movHTML}</div>
      </details>
      ` : ''}
    </div>
  `;
}

// ──────────────────────────────────────
// APERTURA
// ──────────────────────────────────────
window.abrirAperturaCaja = async function(idPunto) {
  const p = _cajaPuntos.find(x => x.idPunto === idPunto);
  if (!p) return;
  _cajaPuntoSeleccionado = p;

  // Defaults antes de la query
  document.getElementById('ap-info').innerHTML =
    `Vas a abrir caja de <strong style="color:var(--amarillo);">${p.nombre}</strong> para hoy. Ingresa el saldo inicial (fondo en mano).`;
  document.getElementById('ap-saldo').value = p.fondoMinimo || '';
  document.getElementById('ap-notas').value = '';
  document.getElementById('overlay-apertura-caja').classList.add('visible');
  document.getElementById('drawer-apertura-caja').classList.add('open');

  // v2.10: Buscar el último cierre de este punto y precargar
  try {
    const url = `caja_dias?id_punto=eq.${p.idPunto}&estatus=eq.cerrada&order=fecha.desc&limit=1&select=fecha,saldo_cierre_declarado,saldo_cierre_calculado`;
    const ult = await supabaseCall('GET', url);
    if (Array.isArray(ult) && ult.length > 0) {
      const r = ult[0];
      const saldoUlt = Number(r.saldo_cierre_declarado ?? r.saldo_cierre_calculado ?? 0);
      const fechaUlt = r.fecha ? new Date(r.fecha + 'T12:00:00') : null;
      const fechaFmt = fechaUlt ? fechaUlt.toLocaleDateString('es-MX', {day:'numeric', month:'short'}) : '—';

      document.getElementById('ap-saldo').value = saldoUlt.toFixed(2);
      document.getElementById('ap-info').innerHTML = `
        <div style="margin-bottom:6px;">Vas a abrir caja de <strong style="color:var(--amarillo);">${p.nombre}</strong> para hoy.</div>
        <div style="background:#1a2a1a;border-left:3px solid #4caf50;padding:8px 10px;border-radius:6px;font-size:0.78rem;color:var(--blanco);">
          Saldo de cierre de <strong>${fechaFmt}</strong>: <strong style="color:var(--amarillo);">$${saldoUlt.toLocaleString('es-MX', {minimumFractionDigits:2})}</strong><br>
          <span style="color:var(--suave);font-size:0.72rem;">Se precargó automáticamente. Ajusta si el efectivo físico difiere.</span>
        </div>
      `;
    }
  } catch(e) {
    // Si falla la query, dejamos los defaults
  }
};

window.cerrarAperturaCaja = function() {
  document.getElementById('overlay-apertura-caja').classList.remove('visible');
  document.getElementById('drawer-apertura-caja').classList.remove('open');
};

window.confirmarApertura = async function() {
  const saldo = parseFloat(document.getElementById('ap-saldo').value) || 0;
  const notas = document.getElementById('ap-notas').value.trim();
  if (saldo < 0) { mostrarToast('El saldo no puede ser negativo'); return; }
  if (!_cajaPuntoSeleccionado) return;

  const btn = document.getElementById('ap-btn');
  btn.disabled = true; btn.textContent = 'Abriendo...';

  try {
    const res = await supabaseCall('POST', 'rpc/abrir_caja_dia', {
      p_data: {
        idPunto: _cajaPuntoSeleccionado.idPunto,
        saldoInicial: saldo,
        actor: N.vendedorInfo?.nombre || 'admin',
        notas,
      }
    });
    if (!res || !res.ok) {
      avisar({ titulo: 'No se pudo abrir la caja', cuerpo: (res?.error || 'Sin respuesta') });
      return;
    }
    mostrarToast('Caja abierta');
    cerrarAperturaCaja();
    renderCaja();
  } catch(e) {
    avisar({ titulo: 'No se pudo abrir la caja', cuerpo: e.message });
  } finally {
    btn.disabled = false; btn.textContent = 'Abrir caja';
  }
};

// ──────────────────────────────────────
// CIERRE
// ──────────────────────────────────────
window.abrirCierreCaja = function(idPunto) {
  const p = _cajaPuntos.find(x => x.idPunto === idPunto);
  if (!p || !p.cajaDia) return;
  _cajaPuntoSeleccionado = p;
  const saldoApertura = Number(p.cajaDia.saldo_apertura) || 0;
  const ingresos = Number(p.totalIngresos) || 0;
  const egresos = Number(p.totalEgresos) || 0;
  const calculado = saldoApertura + ingresos + egresos;

  document.getElementById('ci-info').innerHTML = `
    <div style="margin-bottom:6px;color:var(--blanco);"><strong style="color:var(--amarillo);">${p.nombre}</strong></div>
    <div style="display:flex;justify-content:space-between;color:var(--suave);font-size:0.78rem;margin-bottom:3px;"><span>Apertura</span><span>$${saldoApertura.toLocaleString('es-MX')}</span></div>
    <div style="display:flex;justify-content:space-between;color:#4caf50;font-size:0.78rem;margin-bottom:3px;"><span>Ingresos</span><span>+$${ingresos.toLocaleString('es-MX')}</span></div>
    <div style="display:flex;justify-content:space-between;color:var(--rojo);font-size:0.78rem;margin-bottom:6px;"><span>Egresos</span><span>$${egresos.toLocaleString('es-MX')}</span></div>
    <div style="display:flex;justify-content:space-between;color:var(--amarillo);font-weight:800;border-top:1px solid #333;padding-top:6px;"><span>Saldo calculado</span><span>$${calculado.toLocaleString('es-MX')}</span></div>
  `;
  document.getElementById('ci-saldo').value = calculado.toFixed(2);
  document.getElementById('ci-notas').value = '';
  actualizarDiferenciaCierre();
  document.getElementById('overlay-cierre-caja').classList.add('visible');
  document.getElementById('drawer-cierre-caja').classList.add('open');
};

window.cerrarCierreCaja = function() {
  document.getElementById('overlay-cierre-caja').classList.remove('visible');
  document.getElementById('drawer-cierre-caja').classList.remove('open');
};

window.actualizarDiferenciaCierre = function() {
  const p = _cajaPuntoSeleccionado;
  if (!p || !p.cajaDia) return;
  const declarado = parseFloat(document.getElementById('ci-saldo').value) || 0;
  const calculado = (Number(p.cajaDia.saldo_apertura) || 0) + (Number(p.totalIngresos) || 0) + (Number(p.totalEgresos) || 0);
  const dif = declarado - calculado;
  const el = document.getElementById('ci-diferencia');
  if (dif === 0) {
    el.innerHTML = '<span style="color:#4caf50;">✓ Cuadrado perfecto</span>';
  } else if (dif > 0) {
    el.innerHTML = `<span style="color:#4caf50;">Sobrante: +$${dif.toLocaleString('es-MX', {minimumFractionDigits:2})}</span>`;
  } else {
    el.innerHTML = `<span style="color:var(--rojo);">Faltante: $${dif.toLocaleString('es-MX', {minimumFractionDigits:2})}</span>`;
  }
};

window.confirmarCierre = async function() {
  if (!_cajaPuntoSeleccionado?.cajaDia) return;
  const declarado = parseFloat(document.getElementById('ci-saldo').value) || 0;
  const notas = document.getElementById('ci-notas').value.trim();
  if (declarado < 0) { mostrarToast('El saldo no puede ser negativo'); return; }
  if (!(await confirmar({ titulo: '¿Confirmas el cierre de caja?', cuerpo: 'Esta acción no se puede deshacer.', aceptar: 'Cerrar caja', peligroso: true }))) return;

  const btn = document.getElementById('ci-btn');
  btn.disabled = true; btn.textContent = 'Cerrando...';

  try {
    const res = await supabaseCall('POST', 'rpc/cerrar_caja_dia', {
      p_data: {
        idCajaDia: _cajaPuntoSeleccionado.cajaDia.id,
        saldoDeclarado: declarado,
        actor: N.vendedorInfo?.nombre || 'admin',
        notas,
      }
    });
    if (!res || !res.ok) {
      avisar({ titulo: 'No se pudo cerrar la caja', cuerpo: (res?.error || 'Sin respuesta') });
      return;
    }
    mostrarToast(`Cerrada. ${res.diferencia === 0 ? 'Cuadrado.' : 'Diferencia: $' + Number(res.diferencia).toFixed(2)}`);
    cerrarCierreCaja();
    renderCaja();
  } catch(e) {
    avisar({ titulo: 'No se pudo cerrar la caja', cuerpo: e.message });
  } finally {
    // Garantizar que el botón vuelva a su estado original SIEMPRE
    btn.disabled = false; btn.textContent = 'Cerrar caja';
  }
};

// ──────────────────────────────────────
// MOVIMIENTO MANUAL
// ──────────────────────────────────────
window.abrirMovCaja = function(idPunto) {
  const p = _cajaPuntos.find(x => x.idPunto === idPunto);
  if (!p) return;
  _cajaPuntoSeleccionado = p;
  document.getElementById('mc-punto-info').innerHTML =
    `Movimiento en <strong style="color:var(--amarillo);">${p.nombre}</strong>`;
  document.getElementById('mc-tipo').value = '';
  document.getElementById('mc-monto').value = '';
  document.getElementById('mc-desc').value = '';
  document.getElementById('overlay-mov-caja').classList.add('visible');
  document.getElementById('drawer-mov-caja').classList.add('open');
};

window.cerrarMovCaja = function() {
  document.getElementById('overlay-mov-caja').classList.remove('visible');
  document.getElementById('drawer-mov-caja').classList.remove('open');
};

window.cambioTipoMov = function() {
  const tipo = document.getElementById('mc-tipo').value;
  const desc = document.getElementById('mc-desc');
  const placeholders = {
    efectivo_a_banco: 'Depósito al banco BBVA',
    banco_a_efectivo: 'Retiro de cajero / banco',
    ajuste_pos:       'Entrada manual (corrección, regalo, etc)',
    ajuste_neg:       'Salida manual (préstamo, gasto sin factura)',
  };
  desc.placeholder = placeholders[tipo] || 'Descripción';
};

window.confirmarMovCaja = async function() {
  const tipo = document.getElementById('mc-tipo').value;
  const monto = parseFloat(document.getElementById('mc-monto').value) || 0;
  const desc = document.getElementById('mc-desc').value.trim();
  if (!tipo || monto <= 0) { mostrarToast('Selecciona tipo y monto'); return; }
  if (!_cajaPuntoSeleccionado) return;

  const btn = document.getElementById('mc-btn');
  btn.disabled = true; btn.textContent = 'Registrando...';

  try {
    // Encontrar puntos efectivo y banco
    const pEfectivo = _cajaPuntos.find(p => p.tipo === 'efectivo');
    const pBanco    = _cajaPuntos.find(p => p.tipo === 'banco');

    // Determinar idPunto (origen), tipo del backend y idPuntoDestino
    let idPuntoOrigen, idPuntoDestino = null, tipoBackend, montoFinal;

    if (tipo === 'efectivo_a_banco') {
      // Sale efectivo, entra a banco
      if (!pEfectivo || !pBanco) { avisar({ titulo: 'Faltan puntos de caja configurados', cuerpo: 'Configura el punto de efectivo y el de banco antes de registrar movimientos.' }); btn.disabled=false; btn.textContent='Registrar movimiento'; return; }
      idPuntoOrigen = pEfectivo.idPunto;
      idPuntoDestino = pBanco.idPunto;
      tipoBackend = 'retiro';  // desde efectivo es un retiro (sale)
      montoFinal = monto;       // la RPC se encarga de signos
    } else if (tipo === 'banco_a_efectivo') {
      if (!pEfectivo || !pBanco) { avisar({ titulo: 'Faltan puntos de caja configurados', cuerpo: 'Configura el punto de efectivo y el de banco antes de registrar movimientos.' }); btn.disabled=false; btn.textContent='Registrar movimiento'; return; }
      idPuntoOrigen = pBanco.idPunto;
      idPuntoDestino = pEfectivo.idPunto;
      tipoBackend = 'retiro';   // desde banco es un retiro (sale)
      montoFinal = monto;
    } else if (tipo === 'ajuste_pos') {
      idPuntoOrigen = _cajaPuntoSeleccionado.idPunto;
      tipoBackend = 'ajuste_pos';
      montoFinal = Math.abs(monto);
    } else if (tipo === 'ajuste_neg') {
      idPuntoOrigen = _cajaPuntoSeleccionado.idPunto;
      tipoBackend = 'ajuste_neg';
      montoFinal = -Math.abs(monto);
    } else {
      btn.disabled = false; btn.textContent = 'Registrar movimiento';
      return;
    }

    const res = await supabaseCall('POST', 'rpc/registrar_movimiento_caja', {
      p_data: {
        idPunto: idPuntoOrigen,
        tipo: tipoBackend,
        monto: montoFinal,
        descripcion: desc,
        actor: N.vendedorInfo?.nombre || 'admin',
        idPuntoDestino,
      }
    });
    if (!res || !res.ok) {
      avisar({ titulo: 'No se pudo registrar el movimiento de caja', cuerpo: (res?.error || 'Sin respuesta') });
      btn.disabled = false; btn.textContent = 'Registrar movimiento';
      return;
    }
    mostrarToast('Movimiento registrado');
    cerrarMovCaja();
    renderCaja();
  } catch(e) {
    avisar({ titulo: 'No se pudo registrar el movimiento de caja', cuerpo: e.message });
    btn.disabled = false; btn.textContent = 'Registrar movimiento';
  } finally {
    // Garantizar restauración del botón en cualquier caso
    btn.disabled = false; btn.textContent = 'Registrar movimiento';
  }
};


// ──────────────────────────────────────
// CONFIRMAR / CORREGIR PEDIDOS PENDIENTES (admin)
// ──────────────────────────────────────
let _accionPendActual = null;

window.abrirAccionesPendiente = function(idOrden, consec, monto, modo) {
  _accionPendActual = { idOrden, consec, monto: Number(monto)||0, modo };
  const icoModo = modo === 'efectivo' ? 'Efectivo' : 'Transferencia/Tarjeta';
  document.getElementById('ap-pend-info').innerHTML = `
    <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
      <strong style="color:var(--amarillo);">${consec}</strong>
      <span style="font-family:'Archivo',sans-serif;color:var(--amarillo);font-size:1.2rem;">$${_accionPendActual.monto.toLocaleString('es-MX',{minimumFractionDigits:2})}</span>
    </div>
    <div style="color:var(--suave);font-size:0.78rem;">Método declarado: ${icoModo}</div>
  `;
  document.getElementById('ap-nuevo-metodo').value = '';
  document.getElementById('overlay-accion-pendiente').classList.add('visible');
  document.getElementById('drawer-accion-pendiente').classList.add('open');
};

window.cerrarAccionesPendiente = function() {
  document.getElementById('overlay-accion-pendiente').classList.remove('visible');
  document.getElementById('drawer-accion-pendiente').classList.remove('open');
};

window.ejecutarConfirmarPedido = async function() {
  if (!_accionPendActual) return;
  const btn = document.getElementById('ap-confirmar');
  btn.disabled = true; btn.textContent = 'Confirmando...';
  try {
    const res = await supabaseCall('POST', 'rpc/confirmar_caja_pedido', {
      p_data: {
        idOrden: _accionPendActual.idOrden,
        actor: N.vendedorInfo?.nombre || 'admin',
      }
    });
    if (!res || !res.ok) {
      avisar({ titulo: 'No se pudo confirmar el pedido', cuerpo: (res?.error || 'Sin respuesta') });
      return;
    }
    mostrarToast('Pedido confirmado en caja');
    cerrarAccionesPendiente();
    renderCaja();
  } catch(e) {
    avisar({ titulo: 'No se pudo confirmar el pedido', cuerpo: e.message });
  } finally {
    btn.disabled = false; btn.textContent = '✓ Confirmar (entró en caja/banco)';
  }
};

window.ejecutarCorregirMetodo = async function() {
  if (!_accionPendActual) return;
  const nuevoMet = document.getElementById('ap-nuevo-metodo').value;
  if (!nuevoMet) { mostrarToast('Selecciona método correcto'); return; }
  if (!(await confirmar({ titulo: 'Cambiar método de pago', cuerpo: `${_accionPendActual.consec} pasa a ${nuevoMet}.`, aceptar: 'Cambiar' }))) return;
  try {
    const res = await supabaseCall('POST', 'rpc/corregir_metodo_pago_pedido', {
      p_data: {
        idOrden: _accionPendActual.idOrden,
        nuevoMetodo: nuevoMet,
        actor: N.vendedorInfo?.nombre || 'admin',
      }
    });
    if (!res || !res.ok) {
      avisar({ titulo: 'No se pudo cambiar el método de pago', cuerpo: (res?.error || 'Sin respuesta') });
      return;
    }
    mostrarToast('Método corregido a ' + nuevoMet);
    cerrarAccionesPendiente();
    renderCaja();
  } catch(e) {
    avisar({ titulo: 'No se pudo cambiar el método de pago', cuerpo: e.message });
  }
};


// ══════════════════════════════════════════════════════════════════
// PERMISOS — UI ADMIN (configuración)
// ══════════════════════════════════════════════════════════════════
let _permisosTab = 'rol';
let _configRoles = null;
let _vendedoresParaPermisos = null;

window.abrirPermisos = async function() {
  if (!esAdmin || !esAdmin()) return;
  document.getElementById('overlay-permisos').classList.add('visible');
  document.getElementById('drawer-permisos').classList.add('open');
  setTabPermisos('rol');
};

window.cerrarPermisos = function() {
  document.getElementById('overlay-permisos').classList.remove('visible');
  document.getElementById('drawer-permisos').classList.remove('open');
};

document.addEventListener('click', e => {
  const ov = document.getElementById('overlay-permisos');
  if (e.target === ov) cerrarPermisos();
});

window.setTabPermisos = async function(tab) {
  _permisosTab = tab;
  const tR = document.getElementById('pm-tab-rol');
  const tV = document.getElementById('pm-tab-vend');
  const tS = document.getElementById('pm-tab-resumen');
  const off = (b) => { b.style.background='var(--gris)'; b.style.color='var(--suave)'; b.style.borderColor='var(--gris3)'; };
  const on  = (b) => { b.style.background='var(--amarillo)'; b.style.color='var(--negro)'; b.style.borderColor='var(--amarillo)'; };
  off(tR); off(tV); if (tS) off(tS);
  if (tab === 'rol') {
    on(tR);
    pintarPermisosPorRol();
  } else if (tab === 'resumen') {
    if (tS) on(tS);
    pintarMatrizPermisos();
  } else {
    on(tV);
    pintarPermisosPorVendedor();
  }
};

const SECCIONES_LABELS = {
  catalogo:    'Catálogo',
  pedidos:     'Pedidos',
  premia:      'Crunchy Club',
  b2b:         'B2B',
  produccion:  'Producción',
  prospeccion: 'Prospectos',
  caja:        'Caja',
  gastos:      'Gastos',
  jornadas:    'Jornada',
  productos:   'Productos',
  cupones:     'Cupones',
  resumen:     'Resumen',
  armado:      'Armado',
  ruta:        'Mi ruta',
  reparto:     'Reparto',
  entregas:    'Mis entregas',
  cuenta:      'Mi cuenta',
};

async function pintarPermisosPorRol() {
  const cont = document.getElementById('pm-contenido');
  cont.innerHTML = '<div style="text-align:center;padding:20px;"><span class="loader loader-w"></span></div>';

  try {
    const res = await supabaseCall('POST', 'rpc/get_config_secciones', { p_data: {} });
    if (!res || !res.ok) throw new Error(res?.error || '');
    // Adaptar formato: backend devuelve array [{rol, secciones}], frontend espera objeto {rol: [...]}
    _configRoles = {};
    (res.configs || []).forEach(c => { _configRoles[c.rol] = c.secciones; });
    const disp = Object.keys(SECCIONES_LABELS);

    cont.innerHTML = ['vendedor','consumidor'].map(rol => `
      <div style="background:var(--gris2);border-radius:10px;padding:12px;margin-bottom:10px;">
        <div style="font-weight:900;color:var(--amarillo);text-transform:uppercase;letter-spacing:1px;font-size:0.78rem;margin-bottom:8px;">${rol === 'vendedor' ? 'Vendedores' : 'Consumidores'}</div>
        ${disp.map(sec => {
          const checked = (_configRoles[rol] || []).indexOf(sec) >= 0;
          return `<label style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:0.84rem;color:var(--blanco);cursor:pointer;">
            <input type="checkbox" data-rol="${rol}" data-sec="${sec}" ${checked?'checked':''} class="pm-chk-rol" style="width:18px;height:18px;cursor:pointer;">
            <span>${SECCIONES_LABELS[sec] || sec}</span>
          </label>`;
        }).join('')}
        <button onclick="guardarPermisosRol('${rol}')" style="margin-top:8px;width:100%;background:var(--amarillo);border:none;border-radius:8px;padding:9px;font-family:'Inter',sans-serif;font-weight:900;font-size:0.78rem;color:var(--negro);cursor:pointer;">
          Guardar ${rol}
        </button>
      </div>
    `).join('');
  } catch(e) {
    cont.innerHTML = `<div style="color:var(--rojo);">Error: ${e.message}</div>`;
  }
}

window.guardarPermisosRol = async function(rol) {
  const checks = document.querySelectorAll('.pm-chk-rol[data-rol="' + rol + '"]:checked');
  const secciones = Array.from(checks).map(c => c.getAttribute('data-sec'));
  try {
    const res = await supabaseCall('POST', 'rpc/set_config_secciones', {
      p_data: { rol, secciones }
    });
    if (!res || !res.ok) { avisar({ titulo: 'No se pudieron guardar los permisos del rol', cuerpo: (res?.error||'') }); return; }
    mostrarToast('Permisos de ' + rol + ' guardados');
  } catch(e) { avisar({ titulo: 'No se pudieron guardar los permisos del rol', cuerpo: e.message }); }
};

async function pintarPermisosPorVendedor() {
  const cont = document.getElementById('pm-contenido');
  cont.innerHTML = '<div style="text-align:center;padding:20px;"><span class="loader loader-w"></span></div>';

  try {
    // Cargar lista de vendedores
    const res = await supabaseCall('POST', 'rpc/obtener_vendedores', { p_data: { token: tokenVendedor() } });
    if (!res || !res.ok) throw new Error(res?.error || '');
    _vendedoresParaPermisos = res.vendedores || [];
    const disp = Object.keys(SECCIONES_LABELS);

    cont.innerHTML = `
      <div style="font-size:0.74rem;color:var(--suave);margin-bottom:10px;">
        Si dejas TODAS desmarcadas, el vendedor usará la config por rol. Marca las que quieras override.
      </div>
      ${_vendedoresParaPermisos.map(v => {
        const override = String(v.secciones_visibles || '').split(',').map(s => s.trim()).filter(Boolean);
        const tieneOverride = override.length > 0;
        return `
          <div style="background:var(--gris2);border-radius:10px;padding:12px;margin-bottom:10px;">
            <div style="font-weight:900;color:var(--amarillo);font-size:0.84rem;margin-bottom:6px;">${v.nombre} ${tieneOverride ? '<span style="font-size:0.66rem;background:#0d2d0d;color:#4caf50;padding:1px 6px;border-radius:50px;font-weight:700;">OVERRIDE</span>' : '<span style="font-size:0.66rem;color:#888;font-weight:600;">(usa config rol)</span>'}</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:0.78rem;">
              ${disp.map(sec => {
                const checked = override.indexOf(sec) >= 0;
                return `<label style="display:flex;align-items:center;gap:6px;padding:3px 0;color:var(--blanco);cursor:pointer;">
                  <input type="checkbox" data-id="${v.id}" data-sec="${sec}" ${checked?'checked':''} class="pm-chk-vend" style="width:14px;height:14px;cursor:pointer;">
                  <span>${SECCIONES_LABELS[sec] || sec}</span>
                </label>`;
              }).join('')}
            </div>
            <div style="display:flex;gap:6px;margin-top:8px;">
              <button onclick="guardarPermisosVendedor('${v.id}')" style="flex:1;background:var(--amarillo);border:none;border-radius:8px;padding:7px;font-family:'Inter',sans-serif;font-weight:900;font-size:0.74rem;color:var(--negro);cursor:pointer;">Guardar override</button>
              <button onclick="quitarOverrideVendedor('${v.id}')" style="background:transparent;border:1px solid #555;border-radius:8px;padding:7px 10px;font-family:'Inter',sans-serif;font-weight:700;font-size:0.74rem;color:#888;cursor:pointer;">Quitar override</button>
            </div>
          </div>`;
      }).join('')}
    `;
  } catch(e) {
    cont.innerHTML = `<div style="color:var(--rojo);">Error: ${e.message}</div>`;
  }
}

window.guardarPermisosVendedor = async function(idVendedor) {
  const checks = document.querySelectorAll('.pm-chk-vend[data-id="' + idVendedor + '"]:checked');
  const secciones = Array.from(checks).map(c => c.getAttribute('data-sec'));
  try {
    const res = await supabaseCall('POST', 'rpc/set_secciones_vendedor', {
      p_data: { idVendedor, secciones }
    });
    if (!res || !res.ok) { avisar({ titulo: 'No se pudieron guardar los permisos del vendedor', cuerpo: (res?.error||'') }); return; }
    mostrarToast('Permisos guardados');
    pintarPermisosPorVendedor();
  } catch(e) { avisar({ titulo: 'No se pudieron guardar los permisos del vendedor', cuerpo: e.message }); }
};

window.quitarOverrideVendedor = async function(idVendedor) {
  if (!(await confirmar({ titulo: '¿Quitar el override?', cuerpo: 'El vendedor vuelve a la configuración de su rol.', aceptar: 'Quitar' }))) return;
  try {
    const res = await supabaseCall('POST', 'rpc/set_secciones_vendedor', {
      p_data: { idVendedor, secciones: [] }
    });
    if (!res || !res.ok) { avisar({ titulo: 'No se pudo quitar el override', cuerpo: (res?.error||'') }); return; }
    mostrarToast('Override quitado');
    pintarPermisosPorVendedor();
  } catch(e) { avisar({ titulo: 'No se pudo quitar el override', cuerpo: e.message }); }
};

// Resolver qué secciones ve realmente un vendedor (mismo criterio que aplicarPermisosNavbar)
function _seccionesEfectivasVendedor(v) {
  const rol = String(v.rol || 'vendedor').toLowerCase();
  if (rol.startsWith('admin')) return { secs: Object.keys(SECCIONES_LABELS), fuente: 'admin', rol };
  const override = String(v.secciones_visibles || '').split(',').map(s => s.trim()).filter(Boolean);
  let secs, fuente;
  if (override.length > 0) {
    secs = override.slice(); fuente = 'override';
  } else {
    secs = (_configRoles && _configRoles[rol]) ? _configRoles[rol].slice()
         : ['catalogo','pedidos','prospeccion','gastos','cuenta'];
    fuente = 'rol';
  }
  if (rol === 'mostrador') {
    if (secs.indexOf('productos') < 0) secs.push('productos');
    if (secs.indexOf('cupones')   < 0) secs.push('cupones');
  }
  return { secs, fuente, rol };
}

async function pintarMatrizPermisos() {
  const cont = document.getElementById('pm-contenido');
  cont.innerHTML = '<div style="text-align:center;padding:20px;"><span class="loader loader-w"></span></div>';
  try {
    const [resCfg, resVend] = await Promise.all([
      supabaseCall('POST', 'rpc/get_config_secciones', { p_data: {} }),
      supabaseCall('POST', 'rpc/obtener_vendedores',   { p_data: { token: tokenVendedor() } }),
    ]);
    _configRoles = {};
    if (resCfg && resCfg.ok) (resCfg.configs || []).forEach(c => { _configRoles[c.rol] = c.secciones; });
    const vendedores = (resVend && resVend.ok) ? (resVend.vendedores || []) : [];
    const disp = Object.keys(SECCIONES_LABELS);

    const th = (txt, sticky) => `<th style="${sticky
      ? 'position:sticky;left:0;z-index:2;background:var(--negro);text-align:left;min-width:120px;'
      : 'background:var(--negro);'}padding:8px 6px;font-size:0.62rem;color:var(--suave);border-bottom:1px solid var(--gris3);white-space:nowrap;font-weight:800;">${txt}</th>`;

    const headCols = disp.map(sec => {
      const lbl = SECCIONES_LABELS[sec];
      const emoji = lbl.split(' ')[0];
      const name = lbl.split(' ').slice(1).join(' ');
      return `<th title="${name}" style="background:var(--negro);padding:8px 4px;border-bottom:1px solid var(--gris3);min-width:54px;">
        <div style="font-size:1rem;">${emoji}</div>
        <div style="font-size:0.55rem;color:var(--suave);font-weight:700;line-height:1.1;margin-top:2px;">${name}</div>
      </th>`;
    }).join('');

    // Fila admin (fija, no editable)
    const admins = vendedores.filter(v => String(v.rol||'').toLowerCase().startsWith('admin'));
    const noAdmins = vendedores.filter(v => !String(v.rol||'').toLowerCase().startsWith('admin'));

    const celdaFija = `<td style="position:sticky;left:0;z-index:1;background:var(--gris2);padding:8px 6px;font-weight:800;color:var(--amarillo);font-size:0.74rem;white-space:nowrap;border-bottom:1px solid var(--gris3);">`;

    const filaAdmin = admins.map(v => `
      <tr>
        ${celdaFija}${v.nombre}<div style="font-size:0.58rem;color:#888;font-weight:600;">ve todo (fijo)</div></td>
        ${disp.map(() => `<td style="text-align:center;padding:8px 4px;border-bottom:1px solid var(--gris3);background:rgba(255,210,0,0.05);">
          <input type="checkbox" checked disabled style="width:16px;height:16px;accent-color:#888;cursor:not-allowed;">
        </td>`).join('')}
      </tr>`).join('');

    const filasVend = noAdmins.map(v => {
      const { secs } = _seccionesEfectivasVendedor(v); // hereda del rol si no tiene override (se mostrará palomeado)
      return `
        <tr>
          ${celdaFija}${v.nombre}</td>
          ${disp.map(sec => {
            const checked = secs.indexOf(sec) >= 0;
            return `<td style="text-align:center;padding:8px 4px;border-bottom:1px solid var(--gris3);">
              <input type="checkbox" class="pm-chk-matriz" data-id="${v.id}" data-sec="${sec}" ${checked?'checked':''} style="width:16px;height:16px;accent-color:var(--amarillo);cursor:pointer;">
            </td>`;
          }).join('')}
        </tr>`;
    }).join('');

    cont.innerHTML = `
      <div style="font-size:0.74rem;color:var(--suave);margin-bottom:10px;">
        Marca lo que ve cada quien. El admin ve todo (fijo). Lo que veas palomeado en un vendedor es lo que hereda del rol; al guardar, queda como su configuración propia.
      </div>
      <div style="overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--gris3);border-radius:10px;">
        <table style="border-collapse:collapse;width:100%;">
          <thead><tr>${th('Vendedor', true)}${headCols}</tr></thead>
          <tbody>${filaAdmin}${filasVend}</tbody>
        </table>
      </div>
      <button onclick="guardarMatrizPermisos(this)" style="margin-top:12px;width:100%;background:var(--amarillo);border:none;border-radius:10px;padding:12px;font-family:'Inter',sans-serif;font-weight:900;font-size:0.85rem;color:var(--negro);cursor:pointer;">Guardar todo</button>

      <!-- Restablecer el PIN de otra persona. Va aparte de la matriz para no
           tocar su layout de celdas fijas, y porque es una acción de otro tipo:
           la matriz se guarda en bloque, esto es puntual y con confirmación. -->
      <div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--gris3);">
        <div style="font-size:0.68rem;font-weight:800;color:#555;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Restablecer PIN</div>
        <div style="font-size:0.74rem;color:var(--suave);margin-bottom:10px;line-height:1.4;">
          Para cuando alguien lo olvida, lo comparte o deja el equipo. Se cierran de inmediato sus sesiones abiertas.
        </div>
        <select class="inp" id="pmr-vendedor" style="margin-bottom:8px;">
          <option value="">¿A quién?</option>
          ${vendedores.map(v => `<option value="${v.id}">${v.nombre} — ${v.rol || 'Vendedor'}</option>`).join('')}
        </select>
        <input class="inp" id="pmr-pin" type="password" inputmode="numeric" autocomplete="new-password"
               placeholder="PIN nuevo (mínimo 6 dígitos)" maxlength="10" style="margin-bottom:8px;">
        <div id="pmr-msg" style="font-size:0.76rem;margin-bottom:8px;min-height:1em;"></div>
        <button onclick="restablecerPinVendedor(this)" style="width:100%;background:transparent;border:2px solid var(--gris3);border-radius:10px;padding:12px;font-family:'Inter',sans-serif;font-weight:800;font-size:0.85rem;color:var(--blanco);cursor:pointer;">
          Restablecer PIN
        </button>
      </div>`;
  } catch(e) {
    cont.innerHTML = `<div style="color:var(--rojo);">Error: ${e.message}</div>`;
  }
}

// Restablecer el PIN de OTRA persona. El servidor exige rol dueño (admin /
// administrador exactos), así que un socio administrador2 no puede usarlo
// aunque llegue a ver esta pantalla.
window.restablecerPinVendedor = async function(btn) {
  const msg = document.getElementById('pmr-msg');
  const sel = document.getElementById('pmr-vendedor');
  const inp = document.getElementById('pmr-pin');
  const err = (t) => { msg.style.color = 'var(--rojo)'; msg.textContent = t; };

  const idVendedor = sel && sel.value;
  const nuevo = (inp && inp.value || '').trim();
  if (!idVendedor)             return err('Elige a quién.');
  if (!/^\d{6,}$/.test(nuevo)) return err('El PIN debe ser de al menos 6 dígitos, solo números.');
  // Mismas reglas que aplica el servidor, comprobadas aquí para avisar antes
  // de enviar. El servidor manda: esto es solo cortesía.
  if (/^(.)\1+$/.test(nuevo)) return err('El PIN no puede ser un mismo dígito repetido.');
  if (['123456','654321','123123','112233','121212','098765'].includes(nuevo))
    return err('Ese PIN es demasiado común. Elige otro.');

  const nombre = sel.options[sel.selectedIndex].textContent.split(' — ')[0];
  if (!(await confirmar({ titulo: `¿Restablecer el PIN de ${nombre}?`, cuerpo: 'Se cerrarán sus sesiones abiertas y tendrá que entrar con el PIN nuevo.', aceptar: 'Restablecer', peligroso: true }))) return;

  if (btn) { btn.disabled = true; btn.textContent = 'Restableciendo...'; }
  msg.textContent = '';
  try {
    const res = await supabaseCall('POST', 'rpc/cambiar_pin_vendedor', {
      p_data: { token: tokenVendedor(), idVendedor: Number(idVendedor), pinNuevo: nuevo }
    });
    if (res && res.ok) {
      msg.style.color = '#4caf50';
      msg.textContent = `✓ PIN de ${nombre} restablecido. Comunícaselo por un canal seguro.`;
      inp.value = ''; sel.value = '';
    } else {
      err((res && res.error) || 'No se pudo restablecer.');
    }
  } catch (e) {
    err('Error de conexión.');
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Restablecer PIN'; }
};

window.guardarMatrizPermisos = async function(btn) {
  const checks = document.querySelectorAll('.pm-chk-matriz');
  const porVend = {};
  checks.forEach(c => {
    const id = c.getAttribute('data-id');
    if (!porVend[id]) porVend[id] = [];
    if (c.checked) porVend[id].push(c.getAttribute('data-sec'));
  });
  const ids = Object.keys(porVend);
  if (!ids.length) { mostrarToast('No hay vendedores que guardar'); return; }
  if (btn) { btn.textContent = 'Guardando...'; btn.disabled = true; }
  try {
    const results = await Promise.all(ids.map(id =>
      supabaseCall('POST', 'rpc/set_secciones_vendedor', { p_data: { idVendedor: id, secciones: porVend[id] } })
    ));
    const fallos = results.filter(r => !r || !r.ok).length;
    if (fallos) { avisar({ titulo: 'Se guardó con errores', cuerpo: 'Se guardaron con ' + fallos + ' error(es). Revisa e intenta de nuevo.' }); }
    else { mostrarToast('Permisos guardados (' + ids.length + ' vendedores)'); }
    pintarMatrizPermisos();
  } catch(e) {
    avisar({ titulo: 'No se pudieron guardar los permisos', cuerpo: e.message });
    if (btn) { btn.textContent = 'Guardar todo'; btn.disabled = false; }
  }
};


// ══════════════════════════════════════════════════════════════════
// JORNADAS (v2.5)
// ══════════════════════════════════════════════════════════════════
const ACTIVIDADES_JORNADA = ['Freír','Embolsar','Prospección','Reparto','Atención cliente','Inventario','Otros'];
let _jornadaAbierta = null;
let _jornadas = [];
let _coordsJornada = null;

async function renderJornadas() {
  const cont = document.getElementById('j-estado-actual');
  cont.innerHTML = '<div style="text-align:center;color:var(--suave);padding:20px;"><span class="loader loader-w"></span> Cargando...</div>';

  // Verificar jornada abierta — desde Supabase
  try {
    const idV = N.vendedorInfo?.id || 0;
    const _rja = await supabaseCall('POST', 'rpc/obtener_jornadas',
      { p_data: { soloAbierta: true, limit: 1 } });
    const arrAbierta = (_rja && _rja.ok && Array.isArray(_rja.jornadas)) ? _rja.jornadas : [];
    if (Array.isArray(arrAbierta) && arrAbierta.length > 0) {
      const j = arrAbierta[0];
      _jornadaAbierta = {
        id:               j.id,
        idVendedor:       j.id_vendedor,
        nombreVendedor:   j.nombre_vendedor || '',
        fecha:            j.fecha,
        horaEntrada:      j.hora_inicio,
        coordsEntrada:    j.coords_entrada || '',
        enPlantaEntrada:  j.en_planta_entrada,
        actividades:      j.actividades || [],
        notasInicio:      j.notas_inicio || '',
      };
    } else {
      _jornadaAbierta = null;
    }
    pintarEstadoActual();

    // Reporte admin
    if (esAdmin && esAdmin()) await pintarReporteAdmin();

    // Historial
    // Alcance decidido por el servidor a partir del token.
    const _rj = await supabaseCall('POST', 'rpc/obtener_jornadas', { p_data: { limit: 50 } });
    const arrJ = (_rj && _rj.ok) ? _rj.jornadas : null;
    if (Array.isArray(arrJ)) {
      _jornadas = arrJ.map(j => ({
        id:               j.id,
        idVendedor:       j.id_vendedor,
        nombreVendedor:   j.nombre_vendedor || '',
        fecha:            j.fecha,
        horaEntrada:      j.hora_inicio,
        horaSalida:       j.hora_cierre,
        coordsEntrada:    j.coords_entrada || '',
        coordsSalida:     j.coords_salida || '',
        enPlantaEntrada:  j.en_planta_entrada,
        enPlantaSalida:   j.en_planta_salida,
        actividades:      j.actividades || [],
        notasInicio:      j.notas_inicio || '',
        notasCierre:      j.notas_cierre || '',
        duracionMinutos:  j.duracion_minutos,
        estatus:          j.estatus,
      }));
    }
    pintarHistorialJornadas();
  } catch(e) {
    cont.innerHTML = `<div style="color:var(--rojo);">Error: ${e.message}</div>`;
  }
}

function pintarEstadoActual() {
  const cont = document.getElementById('j-estado-actual');
  if (!cont) return;

  if (_jornadaAbierta) {
    const ent = new Date(_jornadaAbierta.horaEntrada);
    const ahora = new Date();
    const minTrans = Math.round((ahora - ent) / 60000);
    const horas = Math.floor(minTrans / 60);
    const mins  = minTrans % 60;
    const ubicacionInfo = _jornadaAbierta.dentroPlantaEntrada
      ? '<span style="color:#4caf50;">En planta</span>'
      : '<span style="color:var(--rojo);">Fuera de planta</span>';

    cont.innerHTML = `
      <div style="background:linear-gradient(135deg,#0d2d0d,#1a4a1a);border:1px solid #4caf50;border-radius:14px;padding:14px;">
        <div style="font-size:0.7rem;font-weight:800;color:#4caf50;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Jornada activa</div>
        <div style="font-family:'Archivo',sans-serif;font-size:1.8rem;color:var(--blanco);line-height:1;">${horas}h ${mins}m</div>
        <div style="font-size:0.74rem;color:var(--suave);margin-top:4px;">
          Entrada: ${ent.toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit'})} · ${ubicacionInfo}
        </div>
        ${_jornadaAbierta.actividades.length ? `<div style="margin-top:8px;font-size:0.74rem;color:var(--blanco);">${_jornadaAbierta.actividades.join(' · ')}</div>` : ''}
        <div style="display:flex;gap:8px;margin-top:12px;">
          <button onclick="abrirEditarActividades()" style="flex:1;background:transparent;border:1px solid var(--amarillo);border-radius:8px;padding:8px;font-family:'Inter',sans-serif;font-weight:800;font-size:0.78rem;color:var(--amarillo);cursor:pointer;">Actividades</button>
          <button onclick="abrirCerrarJornada()" style="flex:2;background:var(--amarillo);border:none;border-radius:8px;padding:9px;font-family:'Inter',sans-serif;font-weight:900;font-size:0.84rem;color:var(--negro);cursor:pointer;">Cerrar jornada</button>
        </div>
      </div>`;
  } else {
    cont.innerHTML = `
      <div style="background:var(--gris);border-radius:14px;padding:18px;text-align:center;">
        <div style="font-size:2.2rem;margin-bottom:8px;" class="ico-solo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 21V3h12v18"/><path d="M16 12h4"/><circle cx="12" cy="12" r="1"/></svg></div>
        <div style="font-weight:900;color:var(--blanco);font-size:1.05rem;margin-bottom:4px;">Sin jornada activa</div>
        <div style="font-size:0.78rem;color:var(--suave);margin-bottom:12px;">Registra tu entrada cuando llegues a la planta o empieces tu día.</div>
        <button onclick="abrirIniciarJornada()" style="width:100%;background:var(--amarillo);border:none;border-radius:10px;padding:13px;font-family:'Inter',sans-serif;font-weight:900;font-size:0.9rem;color:var(--negro);cursor:pointer;">
          Registrar entrada
        </button>
      </div>`;
  }
}

async function pintarReporteAdmin() {
  const cont = document.getElementById('j-reporte-admin');
  if (!cont) return;
  cont.style.display = '';
  try {
    // v2.9: leer jornadas del mes actual desde Supabase y agregar en frontend
    const ahora = new Date();
    const mesIni = fechaCDMX(new Date(ahora.getFullYear(), ahora.getMonth(), 1));
    const mesFin = fechaCDMX(new Date(ahora.getFullYear(), ahora.getMonth()+1, 0));
    const _rjm = await supabaseCall('POST', 'rpc/obtener_jornadas',
      { p_data: { desde: mesIni, hasta: mesFin, limit: 500 } });
    const arr = (_rjm && _rjm.ok) ? _rjm.jornadas : null;
    if (!Array.isArray(arr) || arr.length === 0) { cont.innerHTML = ''; return; }

    // Agregar por vendedor
    const porVendedor = {};
    arr.forEach(j => {
      const id = j.id_vendedor;
      if (!id) return;
      if (!porVendedor[id]) {
        porVendedor[id] = {
          idVendedor: id,
          nombreVendedor: j.nombre_vendedor || ('Vendedor ' + id),
          minutosTotales: 0,
          dias: new Set(),
          enPlanta: 0,
          total: 0,
          actividadesConteo: {},
        };
      }
      const v = porVendedor[id];
      v.minutosTotales += (Number(j.duracion_minutos) || 0);
      if (j.fecha) v.dias.add(j.fecha);
      v.total++;
      if (j.en_planta_entrada) v.enPlanta++;
      (j.actividades || []).forEach(a => {
        v.actividadesConteo[a] = (v.actividadesConteo[a] || 0) + 1;
      });
    });
    const reporte = Object.values(porVendedor).map(v => ({
      nombreVendedor: v.nombreVendedor,
      horasTotales: (v.minutosTotales / 60).toFixed(1),
      diasTrabajados: v.dias.size,
      promedioHorasDia: v.dias.size > 0 ? ((v.minutosTotales / 60) / v.dias.size).toFixed(1) : '0',
      porcentajeEnPlanta: v.total > 0 ? Math.round((v.enPlanta / v.total) * 100) : 0,
      actividadesConteo: v.actividadesConteo,
    })).sort((a,b) => parseFloat(b.horasTotales) - parseFloat(a.horasTotales));

    if (reporte.length === 0) { cont.innerHTML = ''; return; }

    const meses = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
    cont.innerHTML = `
      <div style="background:var(--gris);border-radius:12px;padding:12px;">
        <div style="font-size:0.7rem;font-weight:800;color:var(--amarillo);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Reporte ${meses[ahora.getMonth()]} ${ahora.getFullYear()}</div>
        ${reporte.map(v => `
          <div style="background:var(--gris2);border-radius:8px;padding:9px;margin-bottom:6px;">
            <div style="display:flex;justify-content:space-between;align-items:baseline;">
              <div style="font-weight:800;color:var(--blanco);font-size:0.84rem;">${v.nombreVendedor}</div>
              <div style="font-family:'Archivo',sans-serif;color:var(--amarillo);font-size:1.2rem;line-height:1;">${v.horasTotales}h</div>
            </div>
            <div style="font-size:0.7rem;color:var(--suave);margin-top:2px;">
              ${v.diasTrabajados} día(s) · ${v.promedioHorasDia}h/día prom · ${v.porcentajeEnPlanta}% en planta
            </div>
            ${Object.keys(v.actividadesConteo).length ? `<div style="font-size:0.68rem;color:#888;margin-top:3px;">${Object.entries(v.actividadesConteo).map(([a,n]) => `${a} (${n})`).join(' · ')}</div>` : ''}
          </div>
        `).join('')}
      </div>`;
  } catch(e) {
    cont.innerHTML = '';
  }
}

function pintarHistorialJornadas() {
  const cont = document.getElementById('j-lista');
  if (!cont) return;
  if (_jornadas.length === 0) {
    cont.innerHTML = `<div style="text-align:center;color:var(--suave);padding:30px 0;font-size:0.85rem;">
      <span style="font-size:2.2rem;display:block;margin-bottom:8px;" class="ico-solo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 1.5M9 2h6"/></svg></span>
      Sin jornadas registradas aún
    </div>`;
    return;
  }
  cont.innerHTML = _jornadas.map(j => {
    const fecha = j.horaEntrada ? new Date(j.horaEntrada).toLocaleDateString('es-MX',{weekday:'short',day:'numeric',month:'short'}) : '—';
    const ent = j.horaEntrada ? new Date(j.horaEntrada).toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit'}) : '—';
    const sal = j.horaSalida ? new Date(j.horaSalida).toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit'}) : '';
    const horas = (j.duracionMinutos / 60).toFixed(1);
    const colorBorde = j.estatus === 'abierta' ? '#4caf50' : j.autoCerrada ? 'var(--rojo)' : 'var(--amarillo)';
    const adminViendo = esAdmin && esAdmin();
    return `<div onclick="verDetalleJornada(${j.id})" style="
      background:var(--gris);border-radius:12px;padding:11px;margin-bottom:8px;cursor:pointer;
      border-left:3px solid ${colorBorde};">
      <div style="display:flex;justify-content:space-between;gap:8px;">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:800;color:var(--blanco);font-size:0.84rem;">${fecha}${adminViendo ? ' · ' + j.nombreVendedor : ''}</div>
          <div style="font-size:0.74rem;color:var(--suave);margin-top:2px;">
            ${ent} → ${sal} ${j.dentroPlantaEntrada ? '· en planta' : '· fuera de planta'}
          </div>
          ${j.actividades.length ? `<div style="font-size:0.7rem;color:#888;margin-top:3px;">${j.actividades.join(' · ')}</div>` : ''}
          ${j.autoCerrada ? `<div style="font-size:0.66rem;color:var(--rojo);margin-top:2px;">Cerrada automáticamente</div>` : ''}
        </div>
        <div style="text-align:right;white-space:nowrap;">
          <div style="font-family:'Archivo',sans-serif;color:var(--amarillo);font-size:1.4rem;line-height:1;">${horas}h</div>
        </div>
      </div>
    </div>`;
  }).join('');
}

// ──── Iniciar jornada ────
window.abrirIniciarJornada = async function() {
  document.getElementById('overlay-iniciar-jornada').classList.add('visible');
  document.getElementById('drawer-iniciar-jornada').classList.add('open');

  // Reset
  document.getElementById('ij-notas').value = '';
  _coordsJornada = null;

  // Pintar checkboxes de actividades
  document.getElementById('ij-actividades').innerHTML = ACTIVIDADES_JORNADA.map(a => `
    <label style="display:flex;align-items:center;gap:8px;background:var(--gris2);padding:9px 10px;border-radius:8px;cursor:pointer;">
      <input type="checkbox" value="${a}" class="ij-act-chk" style="width:18px;height:18px;cursor:pointer;">
      <span style="font-size:0.86rem;color:var(--blanco);">${a}</span>
    </label>
  `).join('');

  // Capturar GPS
  const info = document.getElementById('ij-coords-info');
  info.innerHTML = 'Capturando ubicación... <span class="loader loader-w"></span>';
  info.style.background = '#2a1f00';
  info.style.borderColor = 'rgba(255,210,0,0.4)';
  info.style.color = 'var(--amarillo)';

  const loc = await obtenerMiUbicacion();
  if (loc) {
    _coordsJornada = loc;
    // Calcular distancia a planta
    const d = distanciaMetros(loc.lat, loc.lng, PLANTA_LAT, PLANTA_LNG);
    if (d <= 100) {
      info.innerHTML = `En la planta (a ${Math.round(d)}m)`;
      info.style.background = '#0d2d0d'; info.style.borderColor = '#2a5a2a'; info.style.color = '#4caf50';
    } else {
      info.innerHTML = `Estás a ${Math.round(d)}m de la planta. Se registrará como "fuera".`;
      info.style.background = '#2d0d0d'; info.style.borderColor = 'var(--rojo)'; info.style.color = 'var(--rojo)';
    }
  } else {
    info.innerHTML = 'No se pudo obtener ubicación. Activa GPS y reintenta.';
    info.style.background = '#2d0d0d'; info.style.borderColor = 'var(--rojo)'; info.style.color = 'var(--rojo)';
  }
};

window.cerrarIniciarJornada = function() {
  document.getElementById('overlay-iniciar-jornada').classList.remove('visible');
  document.getElementById('drawer-iniciar-jornada').classList.remove('open');
};

document.addEventListener('click', e => {
  const ov = document.getElementById('overlay-iniciar-jornada');
  if (e.target === ov) cerrarIniciarJornada();
});

function distanciaMetros(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

window.confirmarIniciarJornada = async function() {
  if (!_coordsJornada) {
    if (!(await confirmar({ titulo: 'Sin GPS confirmado', cuerpo: '¿Continuar de todos modos?', aceptar: 'Continuar' }))) return;
  }
  const checks = document.querySelectorAll('.ij-act-chk:checked');
  const actividades = Array.from(checks).map(c => c.value);
  if (actividades.length === 0) {
    if (!(await confirmar({ titulo: 'Sin actividades', cuerpo: 'No seleccionaste actividades. ¿Continuar?', aceptar: 'Continuar' }))) return;
  }
  const notas = document.getElementById('ij-notas').value.trim();

  try {
    const lat = _coordsJornada?.lat || 0;
    const lng = _coordsJornada?.lng || 0;
    const distancia = distanciaMetros(lat, lng, PLANTA_LAT, PLANTA_LNG);
    const dentroPlanta = distancia <= 100;

    const payload = {
      // Igual que en gastos: el vendedor sale del token en guardar_jornada.
      fecha: fechaCDMX(),
      hora_inicio: new Date().toISOString(),
      coords_entrada: lat && lng ? `${lat},${lng}` : null,
      en_planta_entrada: dentroPlanta,
      actividades: actividades.length > 0 ? actividades : null,
      notas_inicio: notas || null,
      estatus: 'abierta',
    };
    // El vendedor sale del token: nadie ficha por otro.
    const res = await supabaseCall('POST', 'rpc/guardar_jornada', { p_data: { campos: payload } });
    if (!res || !res.ok) { avisar({ titulo: 'No se pudo iniciar la jornada', cuerpo: ((res && res.error) || 'Sin respuesta') }); return; }
    mostrarToast(dentroPlanta ? 'Jornada iniciada en planta' : 'Iniciada FUERA de planta');
    cerrarIniciarJornada();
    renderJornadas();
  } catch(e) { avisar({ titulo: 'No se pudo iniciar la jornada', cuerpo: e.message }); }
};

// ──── Cerrar jornada ────
window.abrirCerrarJornada = async function() {
  if (!_jornadaAbierta) return;
  document.getElementById('overlay-cerrar-jornada').classList.add('visible');
  document.getElementById('drawer-cerrar-jornada').classList.add('open');

  document.getElementById('cj-notas').value = _jornadaAbierta.notas || '';

  // Resumen
  const ent = new Date(_jornadaAbierta.horaEntrada);
  const ahora = new Date();
  const min = Math.round((ahora - ent) / 60000);
  const h = Math.floor(min/60), m = min%60;
  document.getElementById('cj-resumen').innerHTML = `
    <div style="font-weight:700;color:var(--amarillo);">${h}h ${m}m de jornada</div>
    <div style="font-size:0.74rem;color:var(--suave);margin-top:3px;">Entrada: ${ent.toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit'})}</div>
  `;

  // Pintar checkboxes con las actividades actuales pre-seleccionadas
  document.getElementById('cj-actividades').innerHTML = ACTIVIDADES_JORNADA.map(a => {
    const checked = _jornadaAbierta.actividades.indexOf(a) >= 0 ? 'checked' : '';
    return `<label style="display:flex;align-items:center;gap:8px;background:var(--gris2);padding:9px 10px;border-radius:8px;cursor:pointer;">
      <input type="checkbox" value="${a}" ${checked} class="cj-act-chk" style="width:18px;height:18px;cursor:pointer;">
      <span style="font-size:0.86rem;color:var(--blanco);">${a}</span>
    </label>`;
  }).join('');
};

window.cerrarCerrarJornada = function() {
  document.getElementById('overlay-cerrar-jornada').classList.remove('visible');
  document.getElementById('drawer-cerrar-jornada').classList.remove('open');
};

document.addEventListener('click', e => {
  const ov = document.getElementById('overlay-cerrar-jornada');
  if (e.target === ov) cerrarCerrarJornada();
});

window.confirmarCerrarJornada = async function() {
  const checks = document.querySelectorAll('.cj-act-chk:checked');
  const actividades = Array.from(checks).map(c => c.value);
  const notas = document.getElementById('cj-notas').value.trim();

  // Capturar GPS para coords de salida
  const loc = await obtenerMiUbicacion();

  try {
    const lat = loc?.lat || 0;
    const lng = loc?.lng || 0;
    const dentro = lat && lng ? distanciaMetros(lat, lng, PLANTA_LAT, PLANTA_LNG) <= 100 : null;
    const horaInicio = new Date(_jornadaAbierta.horaEntrada);
    const ahora = new Date();
    const duracionMin = Math.round((ahora - horaInicio) / 60000);

    const payload = {
      hora_cierre: ahora.toISOString(),
      coords_salida: lat && lng ? `${lat},${lng}` : null,
      en_planta_salida: dentro,
      actividades: actividades.length > 0 ? actividades : _jornadaAbierta.actividades,
      notas_cierre: notas || null,
      duracion_minutos: duracionMin,
      estatus: 'cerrada',
    };
    const res = await supabaseCall('POST', 'rpc/guardar_jornada',
      { p_data: { id: _jornadaAbierta.id, campos: payload } });
    if (!res || !res.ok) { avisar({ titulo: 'No se pudo cerrar la jornada', cuerpo: ((res && res.error) || 'Sin respuesta') }); return; }
    mostrarToast('Jornada cerrada');
    cerrarCerrarJornada();
    renderJornadas();
  } catch(e) { avisar({ titulo: 'No se pudo cerrar la jornada', cuerpo: e.message }); }
};

// ──── Editar actividades durante la jornada ────
window.abrirEditarActividades = function() {
  // Reusa el modal de cerrar pero con botón de "guardar cambios"
  if (!_jornadaAbierta) return;
  abrirCerrarJornada();
  // Cambiar el botón de cerrar por uno de actualizar
  document.querySelector('#drawer-cerrar-jornada button[onclick="confirmarCerrarJornada()"]').setAttribute('onclick','actualizarActividades()');
  document.querySelector('#drawer-cerrar-jornada button[onclick="actualizarActividades()"]').textContent = 'Guardar cambios (sin cerrar)';
};

window.actualizarActividades = async function() {
  const checks = document.querySelectorAll('.cj-act-chk:checked');
  const actividades = Array.from(checks).map(c => c.value);
  const notas = document.getElementById('cj-notas').value.trim();
  try {
    const res = await supabaseCall('POST', 'rpc/guardar_jornada', { p_data: {
      id: _jornadaAbierta.id,
      campos: {
        actividades: actividades.length > 0 ? actividades : null,
        notas_inicio: notas || null,
      }
    } });
    if (!res || !res.ok) { avisar({ titulo: 'No se pudieron guardar las actividades', cuerpo: ((res && res.error) || 'Sin respuesta') }); return; }
    mostrarToast('Actualizado');
    cerrarCerrarJornada();
    // Restaurar onclick original para próxima vez
    document.querySelector('#drawer-cerrar-jornada button[onclick="actualizarActividades()"]').setAttribute('onclick','confirmarCerrarJornada()');
    document.querySelector('#drawer-cerrar-jornada button[onclick="confirmarCerrarJornada()"]').textContent = 'Cerrar jornada';
    renderJornadas();
  } catch(e) { avisar({ titulo: 'No se pudieron guardar las actividades', cuerpo: e.message }); }
};

// ──── Detalle jornada ────
window.verDetalleJornada = function(id) {
  const j = _jornadas.find(x => String(x.id) === String(id));
  if (!j) return;
  document.getElementById('overlay-detalle-jornada').classList.add('visible');
  document.getElementById('drawer-detalle-jornada').classList.add('open');
  document.getElementById('dj-titulo').textContent = j.consecutivo || 'Jornada';

  const fecha = j.horaEntrada ? new Date(j.horaEntrada).toLocaleDateString('es-MX',{weekday:'long',day:'numeric',month:'long'}) : '—';
  const ent   = j.horaEntrada ? new Date(j.horaEntrada).toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit'}) : '—';
  const sal   = j.horaSalida  ? new Date(j.horaSalida).toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit'}) : 'En curso';
  const horas = (j.duracionMinutos/60).toFixed(1);
  const adminViendo = esAdmin && esAdmin();

  document.getElementById('dj-contenido').innerHTML = `
    <div style="background:var(--gris2);border-radius:12px;padding:14px;margin-bottom:10px;text-align:center;">
      <div style="font-family:'Archivo',sans-serif;font-size:2.2rem;color:var(--amarillo);line-height:1;">${horas}h</div>
      <div style="font-size:0.78rem;color:var(--suave);margin-top:4px;">${fecha}</div>
      ${adminViendo ? `<div style="font-size:0.74rem;color:var(--blanco);margin-top:3px;">${j.nombreVendedor}</div>` : ''}
      ${j.autoCerrada ? `<div style="margin-top:8px;font-size:0.72rem;color:var(--rojo);font-weight:700;">Cerrada automáticamente</div>` : ''}
    </div>
    <div style="background:var(--gris2);border-radius:12px;padding:12px;margin-bottom:10px;font-size:0.82rem;">
      <div style="margin-bottom:4px;"><strong style="color:var(--suave);font-size:0.7rem;text-transform:uppercase;">Entrada:</strong> ${ent} ${j.dentroPlantaEntrada ? '· <span style="color:#4caf50;">en planta</span>' : '· <span style="color:var(--rojo);">fuera</span>'}</div>
      <div><strong style="color:var(--suave);font-size:0.7rem;text-transform:uppercase;">Salida:</strong> ${sal} ${j.horaSalida ? (j.dentroPlantaSalida ? '· <span style="color:#4caf50;">en planta</span>' : '· <span style="color:var(--rojo);">fuera</span>') : ''}</div>
    </div>
    ${adminViendo && (j.coordsEntrada || j.coordsSalida) ? `
      <div style="display:flex;gap:6px;margin-bottom:10px;">
        ${j.coordsEntrada ? `<button onclick="abrirCoordsEnMapa('${j.coordsEntrada}')" style="flex:1;background:transparent;border:1px solid var(--amarillo);border-radius:10px;padding:10px;font-family:'Inter',sans-serif;font-weight:800;font-size:0.78rem;color:var(--amarillo);cursor:pointer;">Ver entrada en mapa</button>` : ''}
        ${j.coordsSalida ? `<button onclick="abrirCoordsEnMapa('${j.coordsSalida}')" style="flex:1;background:transparent;border:1px solid #4caf50;border-radius:10px;padding:10px;font-family:'Inter',sans-serif;font-weight:800;font-size:0.78rem;color:#4caf50;cursor:pointer;">Ver salida en mapa</button>` : ''}
      </div>` : ''}
    ${j.actividades.length ? `
      <div style="background:var(--gris2);border-radius:12px;padding:12px;margin-bottom:10px;">
        <div style="font-size:0.7rem;font-weight:800;color:var(--suave);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Actividades</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;">
          ${j.actividades.map(a => `<span style="background:var(--amarillo);color:var(--negro);font-size:0.74rem;font-weight:700;padding:3px 10px;border-radius:50px;">${a}</span>`).join('')}
        </div>
      </div>` : ''}
    ${j.notas ? `<div style="background:var(--gris2);border-radius:12px;padding:12px;margin-bottom:10px;font-size:0.78rem;color:var(--blanco);"><strong style="color:var(--suave);font-size:0.7rem;text-transform:uppercase;">Notas:</strong><br>${j.notas}</div>` : ''}
    <button onclick="cerrarDetalleJornada()" style="width:100%;background:transparent;border:1px solid #333;border-radius:10px;padding:10px;font-family:'Inter',sans-serif;font-weight:700;font-size:0.82rem;color:var(--suave);cursor:pointer;">Cerrar</button>
  `;
};

window.cerrarDetalleJornada = function() {
  document.getElementById('overlay-detalle-jornada').classList.remove('visible');
  document.getElementById('drawer-detalle-jornada').classList.remove('open');
};

document.addEventListener('click', e => {
  const ov = document.getElementById('overlay-detalle-jornada');
  if (e.target === ov) cerrarDetalleJornada();
});


// ══════════════════════════════════════════════════════════════════
// PRODUCTOS (BEBIDAS) — admin (v2.7)
// ══════════════════════════════════════════════════════════════════
let _quaggaCargado = false;
let _quaggaActivo = false;
let _escanerCallback = null;

function cargarQuagga() {
  if (_quaggaCargado) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/quagga@0.12.1/dist/quagga.min.js';
    script.onload = () => { _quaggaCargado = true; resolve(); };
    script.onerror = () => reject(new Error('No se pudo cargar QuaggaJS'));
    document.head.appendChild(script);
  });
}

let _productosLista = [];
let _papasLista = [];

async function cargarListaProductos() {
  const cont = document.getElementById('prod-lista');
  cont.innerHTML = '<div style="text-align:center;color:var(--suave);padding:20px;"><span class="loader loader-w"></span></div>';
  try {
    // v2.7.5: ambos desde Supabase
    // El cliente solo ve `activo = true` por política; el panel necesita ver
    // también los desactivados para poder reactivarlos, así que va por RPC.
    const _rcat = await supabaseCall('POST', 'rpc/obtener_catalogo_admin', { p_data: {} });
    const papasResp   = (_rcat && _rcat.ok) ? _rcat.productos : [];
    const bebidasResp = (_rcat && _rcat.ok) ? _rcat.bebidas   : [];

    // Bebidas con formato esperado
    _productosLista = (Array.isArray(bebidasResp) ? bebidasResp : []).map(b => ({
      id: b.id,
      nombre: b.nombre,
      categoria: b.categoria || 'bebida',
      tipo_bebida: b.tipo_bebida,
      sabor: b.sabor || '',
      presentacion: b.presentacion || '',
      precio_consumidor: Number(b.precio) || 0,
      codigo_barras: b.codigo_barras || '',
      imagen_url: b.imagen_url || '',
      activo: b.activo !== false,
    }));

    // Papas con formato esperado
    _papasLista = (Array.isArray(papasResp) ? papasResp : []).map(p => ({
      id: p.id,
      sabor: p.sabor,
      presentacion: p.presentacion,
      precio_consumidor: Number(p.precio_consumidor) || 0,
      activo: p.activo !== false,
      categoria: 'papa',
    }));
    pintarListaProductos();
  } catch(e) {
    cont.innerHTML = `<div style="color:var(--rojo);">Error: ${e.message}</div>`;
  }
}

function pintarListaProductos() {
  const cont = document.getElementById('prod-lista');
  if (!cont) return;

  let html = '';

  // Sección de papas con switches on/off (solo control de disponibilidad)
  if (_papasLista.length > 0) {
    html += `<div style="font-size:0.74rem;font-weight:800;color:var(--amarillo);text-transform:uppercase;letter-spacing:1px;margin:6px 0 8px;">Papas (disponibilidad)</div>`;
    html += `<div style="font-size:0.7rem;color:#777;margin-bottom:10px;">Apaga el switch cuando un sabor esté agotado.</div>`;
    _papasLista.forEach(p => {
      const activo = p.activo !== false;
      const id = p.id;
      const ico = saborDot(p.sabor, 14);
      html += `<div style="background:var(--gris2);border-radius:10px;padding:11px;margin-bottom:6px;display:flex;gap:10px;align-items:center;${activo?'':'opacity:0.55;'}">
        <div style="display:flex;align-items:center;">${ico}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:800;color:var(--blanco);font-size:0.86rem;">${p.sabor} <span style="color:#666;font-weight:500;">${p.presentacion}</span></div>
          <div style="font-size:0.7rem;color:#777;">${activo ? 'Disponible' : 'Agotado'} · $${p.precio_consumidor||0}</div>
        </div>
        <label style="position:relative;display:inline-block;width:48px;height:26px;cursor:pointer;flex-shrink:0;">
          <input type="checkbox" ${activo?'checked':''} onchange="togglePapa(${id}, this.checked, this)" style="opacity:0;width:0;height:0;">
          <span class="papa-slider" style="position:absolute;top:0;left:0;right:0;bottom:0;background:${activo?'var(--amarillo)':'#444'};border-radius:34px;transition:0.2s;">
            <span class="papa-knob" style="position:absolute;top:3px;${activo?'right:3px;':'left:3px;'}width:20px;height:20px;background:white;border-radius:50%;transition:0.2s;"></span>
          </span>
        </label>
      </div>`;
    });
  }

  // Sección de bebidas (gestión completa con tarjetas que abren modal)
  html += `<div style="font-size:0.74rem;font-weight:800;color:var(--amarillo);text-transform:uppercase;letter-spacing:1px;margin:18px 0 8px;">Bebidas</div>`;
  if (_productosLista.length === 0) {
    html += '<div style="text-align:center;color:var(--suave);padding:18px 8px;font-size:0.82rem;">Sin bebidas. Toca "+ Nuevo producto" o "Escanear código" para empezar.</div>';
  } else {
    _productosLista.forEach(b => { html += cardProducto(b); });
  }

  cont.innerHTML = html;
}

window.togglePapa = async function(id, nuevoActivo, el) {
  const slider = el.parentElement.querySelector('.papa-slider');
  const knob   = el.parentElement.querySelector('.papa-knob');
  // Update visual inmediato
  if (nuevoActivo) {
    slider.style.background = 'var(--amarillo)';
    knob.style.right = '3px'; knob.style.left = '';
  } else {
    slider.style.background = '#444';
    knob.style.left = '3px'; knob.style.right = '';
  }
  try {
    // `productos` está cerrada a anon: con la llave publicada se podían
    // cambiar los PRECIOS de todo el catálogo. Ahora va por RPC con sesión y
    // lista blanca de columnas.
    const res = await supabaseCall('POST', 'rpc/actualizar_producto', {
      p_data: { id, campos: { activo: nuevoActivo } }
    });
    if (!res || !res.ok) {
      avisar({ titulo: 'No se pudo activar o desactivar el producto', cuerpo: ((res && res.error) || 'Sin respuesta') });
      el.checked = !nuevoActivo;
      togglePapa(id, !nuevoActivo, el);
      return;
    }
    cacheClear(N.CACHE_KEYS.CATALOGO); // Invalidar para próxima carga
    mostrarToast(nuevoActivo ? 'Disponible' : 'Agotado');
    // Refrescar localmente
    const p = _papasLista.find(x => String(x.id) === String(id));
    if (p) p.activo = nuevoActivo;
    pintarListaProductos();
  } catch(e) {
    avisar({ titulo: 'No se pudo activar o desactivar el producto', cuerpo: e.message });
    el.checked = !nuevoActivo;
  }
};

function cardProducto(p) {
  const inactivo = p.activo === false || p.activo === 'FALSE' || p.activo === 'false';
  const tipoIco = { Refresco:'', Agua:'', Cerveza:'', Jugo:'', Energizante:'', Otro:'' };
  const ico = tipoIco[p.tipo_bebida] || '';
  const detalle = (p.sabor || p.presentacion)
    ? `<div style="font-size:0.72rem;color:var(--amarillo);font-weight:600;margin-top:1px;">${[p.sabor, p.presentacion].filter(Boolean).join(' · ')}</div>`
    : '';
  const badge = inactivo
    ? `<span style="background:#5a1a1a;color:#ff8888;padding:2px 8px;border-radius:50px;font-size:0.6rem;font-weight:800;letter-spacing:0.5px;">AGOTADO</span>`
    : '';
  return `<div onclick="editarProducto('${p.id}')" style="
    background:var(--gris2);border-radius:10px;padding:11px;margin-bottom:6px;cursor:pointer;
    display:flex;gap:10px;align-items:center;${inactivo?'opacity:0.55;':''}">
    <div style="font-size:1.7rem;">${ico}</div>
    <div style="flex:1;min-width:0;">
      <div style="display:flex;gap:6px;align-items:center;">
        <div style="font-weight:800;color:var(--blanco);font-size:0.88rem;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.nombre || ''}</div>
        ${badge}
      </div>
      ${detalle}
      <div style="font-size:0.7rem;color:#777;margin-top:2px;">
        ${p.codigo_barras ? ''+p.codigo_barras : ''}
      </div>
    </div>
    <div style="font-family:'Archivo',sans-serif;color:var(--amarillo);font-size:1.4rem;line-height:1;">$${Number(p.precio_consumidor||0).toLocaleString('es-MX')}</div>
  </div>`;
}

let _editandoProducto = null;
let _ultimoCodigoEscaneado = null;

window.abrirNuevoProducto = function() {
  _editandoProducto = null;
  document.getElementById('pf-titulo').textContent = 'Nueva bebida';
  document.getElementById('pf-tipo-bebida').value = 'Refresco';
  document.getElementById('pf-sabor').value = '';
  document.getElementById('pf-presentacion').value = '';
  document.getElementById('pf-codigo').value = _ultimoCodigoEscaneado || '';
  document.getElementById('pf-nombre').value = '';
  document.getElementById('pf-precio').value = '';
  document.getElementById('pf-imagen').value = '';
  document.getElementById('pf-img-preview').style.display = 'none';
  document.getElementById('pf-activo').checked = true;
  actualizarSwitchActivo();
  document.getElementById('pf-eliminar').style.display = 'none';
  document.getElementById('overlay-prod-form').classList.add('visible');
  document.getElementById('drawer-prod-form').classList.add('open');
};

window.editarProducto = function(id) {
  const p = _productosLista.find(x => String(x.id) === String(id));
  if (!p) return;
  _editandoProducto = p;
  document.getElementById('pf-titulo').textContent = 'Editar bebida';
  document.getElementById('pf-tipo-bebida').value = p.tipo_bebida || 'Refresco';
  document.getElementById('pf-sabor').value = p.sabor || '';
  document.getElementById('pf-presentacion').value = p.presentacion || '';
  document.getElementById('pf-codigo').value = p.codigo_barras || '';
  document.getElementById('pf-nombre').value = p.nombre || '';
  document.getElementById('pf-precio').value = p.precio_consumidor || '';
  document.getElementById('pf-imagen').value = p.imagen_url || '';
  if (p.imagen_url) {
    document.getElementById('pf-img-preview').innerHTML = `<img src="${p.imagen_url}" style="max-width:120px;max-height:120px;border-radius:8px;">`;
    document.getElementById('pf-img-preview').style.display = '';
  } else {
    document.getElementById('pf-img-preview').style.display = 'none';
  }
  // Activo: aceptar variantes (boolean, string TRUE/FALSE)
  const activo = !(p.activo === false || p.activo === 'FALSE' || p.activo === 'false');
  document.getElementById('pf-activo').checked = activo;
  actualizarSwitchActivo();
  document.getElementById('pf-eliminar').style.display = '';
  document.getElementById('overlay-prod-form').classList.add('visible');
  document.getElementById('drawer-prod-form').classList.add('open');
};

window.cerrarProdForm = function() {
  document.getElementById('overlay-prod-form').classList.remove('visible');
  document.getElementById('drawer-prod-form').classList.remove('open');
  _ultimoCodigoEscaneado = null;
};

window.actualizarSwitchActivo = function() {
  const checked = document.getElementById('pf-activo').checked;
  const slider  = document.getElementById('pf-activo-slider');
  const knob    = document.getElementById('pf-activo-knob');
  if (checked) {
    slider.style.background = 'var(--amarillo)';
    knob.style.right = '3px';
    knob.style.left = '';
  } else {
    slider.style.background = '#444';
    knob.style.left = '3px';
    knob.style.right = '';
  }
};

window.guardarProducto = async function() {
  const nombre = document.getElementById('pf-nombre').value.trim();
  const precio = Number(document.getElementById('pf-precio').value);
  if (!nombre) { mostrarToast('Captura un nombre'); return; }
  if (!precio || precio <= 0) { mostrarToast('Captura un precio válido'); return; }

  const payload = {
    nombre,
    precio,
    categoria: 'bebida',
    tipo_bebida: document.getElementById('pf-tipo-bebida').value,
    sabor: document.getElementById('pf-sabor').value.trim() || null,
    presentacion: document.getElementById('pf-presentacion').value.trim() || null,
    codigo_barras: document.getElementById('pf-codigo').value.trim() || null,
    imagen_url: document.getElementById('pf-imagen').value.trim() || null,
    activo: document.getElementById('pf-activo').checked,
  };

  try {
    // Alta y edición por el mismo RPC: el panel usa el mismo formulario para
    // las dos cosas, y así hay una sola puerta que proteger.
    const res = await supabaseCall('POST', 'rpc/guardar_bebida', {
      p_data: { id: _editandoProducto ? _editandoProducto.id : null, campos: payload }
    });
    const created = res;
    if (!res || !res.ok) {
      // Es un error de Supabase (ej. {message: "...", code: "..."})
      avisar({ titulo: 'No se pudo guardar el producto', cuerpo: created.message });
      return;
    }
    cacheClear(N.CACHE_KEYS.CATALOGO);
    mostrarToast(_editandoProducto ? 'Bebida actualizada' : 'Bebida creada');
    cerrarProdForm();
    cargarListaProductos();
  } catch(e) { avisar({ titulo: 'No se pudo guardar el producto', cuerpo: e.message }); }
};

window.eliminarBebidaActual = async function() {
  if (!_editandoProducto) return;
  if (!(await confirmar({ titulo: `¿Eliminar "${_editandoProducto.nombre}"?`, cuerpo: 'Quedará marcada como inactiva en el catálogo.', aceptar: 'Eliminar', peligroso: true }))) return;
  try {
    // "Eliminar del catálogo" es DESCONTINUAR, no agotar: el producto debe
    // desaparecer para el cliente, no quedarse visible como "No disponible".
    // Esa distinción es justo la que separa `descontinuado` de `activo`.
    const res = await supabaseCall('POST', 'rpc/guardar_bebida', {
      p_data: { id: _editandoProducto.id, campos: { descontinuado: true, activo: false } }
    });
    if (!res || !res.ok) {
      avisar({ titulo: 'No se pudo eliminar el producto', cuerpo: ((res && res.error) || 'Sin respuesta') });
      return;
    }
    cacheClear(N.CACHE_KEYS.CATALOGO);
    mostrarToast('Bebida eliminada');
    cerrarProdForm();
    cargarListaProductos();
  } catch(e) { avisar({ titulo: 'No se pudo eliminar el producto', cuerpo: e.message }); }
};

// ──── Escáner código de barras ────
let _escanerEnContexto = 'productos'; // 'productos' | 'form'

window.abrirEscanerCB = function() {
  _escanerEnContexto = 'productos';
  abrirEscanerInterno();
};
window.abrirEscanerCBenForm = function() {
  _escanerEnContexto = 'form';
  abrirEscanerInterno();
};

async function abrirEscanerInterno() {
  document.getElementById('overlay-escaner').classList.add('visible');
  document.getElementById('drawer-escaner').classList.add('open');
  document.getElementById('esc-status').textContent = 'Cargando librería...';
  document.getElementById('esc-manual').value = '';

  try {
    await cargarQuagga();
    iniciarQuagga();
  } catch(e) {
    document.getElementById('esc-status').innerHTML = `<span style="color:var(--rojo);">${e.message}. Usa entrada manual.</span>`;
  }
}

function iniciarQuagga() {
  if (typeof Quagga === 'undefined') return;
  document.getElementById('esc-status').textContent = 'Solicitando cámara...';

  Quagga.init({
    inputStream: {
      type: 'LiveStream',
      target: document.querySelector('#esc-video-wrap'),
      constraints: {
        facingMode: 'environment',
        width: { ideal: 800 },
        height: { ideal: 600 },
      },
    },
    decoder: {
      readers: ['ean_reader','ean_8_reader','upc_reader','upc_e_reader','code_128_reader','code_39_reader'],
    },
    locate: true,
  }, function(err) {
    if (err) {
      document.getElementById('esc-status').innerHTML = `<span style="color:var(--rojo);">${err.message || 'Sin acceso a cámara'}. Usa entrada manual.</span>`;
      return;
    }
    document.getElementById('esc-status').textContent = 'Apuntando — espera detección...';
    Quagga.start();
    _quaggaActivo = true;
  });

  Quagga.onDetected(function(result) {
    const code = result.codeResult.code;
    if (!code) return;
    procesarCodigoEscaneado(code);
  });
}

window.cerrarEscanerCB = function() {
  if (_quaggaActivo && typeof Quagga !== 'undefined') {
    try { Quagga.stop(); } catch(e) {}
    _quaggaActivo = false;
  }
  document.getElementById('overlay-escaner').classList.remove('visible');
  document.getElementById('drawer-escaner').classList.remove('open');
};

document.addEventListener('click', e => {
  const ov = document.getElementById('overlay-escaner');
  if (e.target === ov) cerrarEscanerCB();
});

window.confirmarEscanerManual = function() {
  const codigo = document.getElementById('esc-manual').value.trim();
  if (!codigo) { mostrarToast('Captura un código'); return; }
  procesarCodigoEscaneado(codigo);
};

async function procesarCodigoEscaneado(codigo) {
  cerrarEscanerCB();
  _ultimoCodigoEscaneado = codigo;

  if (_escanerEnContexto === 'form') {
    document.getElementById('pf-codigo').value = codigo;
    // Si está vacío el nombre, intentar lookup externo
    if (!document.getElementById('pf-nombre').value) {
      mostrarToast('Buscando información del producto...');
      try {
        const r = await sheetsCall({ accion:'lookup_producto_externo', codigo_barras: codigo });
        if (r.ok && r.encontrado) {
          document.getElementById('pf-nombre').value = r.producto.nombre || '';
          if (r.producto.imagen_url) {
            document.getElementById('pf-imagen').value = r.producto.imagen_url;
            document.getElementById('pf-img-preview').innerHTML = `<img src="${r.producto.imagen_url}" style="max-width:120px;max-height:120px;border-radius:8px;">`;
            document.getElementById('pf-img-preview').style.display = '';
          }
          mostrarToast('Producto encontrado en base externa');
        } else {
          mostrarToast('ℹ️ Producto no encontrado, captura manualmente');
        }
      } catch(e) { /* silencioso */ }
    }
    return;
  }

  // Contexto 'productos': verificar si ya existe en BD; si no, abrir form pre-llenado
  try {
    // Buscar en Supabase por código de barras
    const _rb = await supabaseCall('POST', 'rpc/buscar_bebida_por_codigo', { p_data: { codigo } });
    const existSupa = (_rb && _rb.ok && Array.isArray(_rb.bebidas)) ? _rb.bebidas : [];
    if (existSupa.length > 0) {
      mostrarToast('Producto ya existe — abriendo edición');
      editarProducto(existSupa[0].id);
    } else {
      // Buscar info externa (Open Food Facts via Apps Script proxy)
      let nombre = '';
      let imagen = '';
      try {
        const r = await sheetsCall({ accion:'lookup_producto_externo', codigo_barras: codigo });
        if (r.ok && r.encontrado) {
          nombre = r.producto.nombre || '';
          imagen = r.producto.imagen_url || '';
        }
      } catch(e) {}
      abrirNuevoProducto();
      document.getElementById('pf-codigo').value = codigo;
      document.getElementById('pf-nombre').value = nombre;
      if (imagen) {
        document.getElementById('pf-imagen').value = imagen;
        document.getElementById('pf-img-preview').innerHTML = `<img src="${imagen}" style="max-width:120px;max-height:120px;border-radius:8px;">`;
        document.getElementById('pf-img-preview').style.display = '';
      }
    }
  } catch(e) { mostrarToast('Error: ' + e.message); }
}


// ══════════════════════════════════════════════════════════════════
// CUPONES — admin (v2.7)
// ══════════════════════════════════════════════════════════════════
let _cuponesLista = [];
let _editandoCupon = null;

async function cargarCupones() {
  const cont = document.getElementById('cup-lista');
  cont.innerHTML = '<div style="text-align:center;color:var(--suave);padding:20px;"><span class="loader loader-w"></span></div>';
  try {
    // `cupones` está cerrada a anon: contiene los CÓDIGOS de descuento y se
    // podía leer entera porque una política `true` anulaba el filtro
    // `activo = true`. El panel la lee por RPC con sesión.
    const _rc = await supabaseCall('POST', 'rpc/obtener_cupones', { p_data: {} });
    const res = (_rc && _rc.ok && Array.isArray(_rc.cupones)) ? _rc.cupones : [];
    _cuponesLista = res.map(c => ({
      id: c.id,
      codigo: c.codigo,
      descripcion: c.descripcion,
      tipo: c.tipo,
      valor: Number(c.valor) || 0,
      vigenciaInicio: c.vigencia_inicio,
      vigenciaFin: c.vigencia_fin,
      usosMaximos: Number(c.usos_maximos) || 0,
      usosActuales: Number(c.usos_actuales) || 0,
      compraMinima: Number(c.compra_minima) || 0,
      segmento: c.segmento,
      unUsoPorUsuario: c.un_uso_por_usuario,
      activo: c.activo !== false,
    }));
    pintarListaCupones();
  } catch(e) {
    cont.innerHTML = `<div style="color:var(--rojo);">Error: ${e.message}</div>`;
  }
}

function pintarListaCupones() {
  const cont = document.getElementById('cup-lista');
  if (!cont) return;
  if (_cuponesLista.length === 0) {
    cont.innerHTML = '<div style="text-align:center;color:var(--suave);padding:30px;">Sin cupones creados</div>';
    return;
  }
  const ico = { descuento_pct:'', descuento_fijo:'', producto_gratis:'', envio_gratis:'' };
  cont.innerHTML = _cuponesLista.map(c => {
    const inactivo = c.activo === false;
    const ahora = new Date();
    const vigFin = c.vigencia_fin ? new Date(c.vigencia_fin) : null;
    // vigencia_fin es el último día a las 00:00 de CDMX; «Hasta» incluye ese día entero.
    const expirado = vigFin && ahora.getTime() >= vigFin.getTime() + 864e5;
    const agotado = c.usos_maximos > 0 && c.usos_actuales >= c.usos_maximos;

    let estado = '';
    if (inactivo) estado = '<span style="background:#444;color:#888;padding:2px 8px;border-radius:50px;font-size:0.66rem;font-weight:700;">DESACTIVADO</span>';
    else if (expirado) estado = '<span style="background:#5a1a1a;color:var(--rojo);padding:2px 8px;border-radius:50px;font-size:0.66rem;font-weight:700;">EXPIRADO</span>';
    else if (agotado) estado = '<span style="background:#5a1a1a;color:var(--rojo);padding:2px 8px;border-radius:50px;font-size:0.66rem;font-weight:700;">AGOTADO</span>';
    else estado = '<span style="background:#0d2d0d;color:#4caf50;padding:2px 8px;border-radius:50px;font-size:0.66rem;font-weight:700;">ACTIVO</span>';

    let valorStr = '';
    if (c.tipo === 'descuento_pct') valorStr = `-${c.valor}%`;
    else if (c.tipo === 'descuento_fijo') valorStr = `-$${c.valor}`;
    else if (c.tipo === 'producto_gratis') valorStr = 'Gratis';
    else if (c.tipo === 'envio_gratis') valorStr = 'Sin envío';

    return `<div onclick="editarCupon(${c.id})" style="
      background:var(--gris2);border-radius:10px;padding:11px;margin-bottom:6px;cursor:pointer;
      ${inactivo||expirado||agotado?'opacity:0.55;':''}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:1.1rem;">${ico[c.tipo]||''}</span>
            <span style="font-family:'Archivo',sans-serif;color:var(--amarillo);font-size:1.2rem;line-height:1;">${c.codigo}</span>
            ${estado}
          </div>
          <div style="font-size:0.74rem;color:var(--blanco);margin-top:3px;">${c.descripcion || valorStr}</div>
          <div style="font-size:0.66rem;color:#888;margin-top:2px;">
            Usos: ${c.usos_actuales||0}${c.usos_maximos>0?'/'+c.usos_maximos:''}
            ${c.vigencia_fin ? ' · Hasta '+new Date(c.vigencia_fin).toLocaleDateString('es-MX',{day:'numeric',month:'short'}) : ''}
            ${c.min_compra > 0 ? ' · Mín $'+c.min_compra : ''}
          </div>
        </div>
        <div style="font-family:'Archivo',sans-serif;color:var(--amarillo);font-size:1.4rem;">${valorStr}</div>
      </div>
    </div>`;
  }).join('');
}

window.abrirNuevoCupon = function() {
  _editandoCupon = null;
  document.getElementById('cf-titulo').textContent = 'Nuevo cupón';
  document.getElementById('cf-codigo').value = '';
  document.getElementById('cf-tipo').value = 'descuento_pct';
  document.getElementById('cf-valor').value = '';
  document.getElementById('cf-descripcion').value = '';
  document.getElementById('cf-vig-inicio').value = fechaCDMX();
  document.getElementById('cf-vig-fin').value = '';
  document.getElementById('cf-usos-max').value = '';
  document.getElementById('cf-min-compra').value = '';
  document.getElementById('cf-segmento').value = 'todos';
  actualizarValorCupon();
  document.getElementById('overlay-cup-form').classList.add('visible');
  document.getElementById('drawer-cup-form').classList.add('open');
};

window.editarCupon = function(id) {
  const c = _cuponesLista.find(x => String(x.id) === String(id));
  if (!c) return;
  _editandoCupon = c;
  document.getElementById('cf-titulo').textContent = 'Editar cupón';
  document.getElementById('cf-codigo').value = c.codigo || '';
  document.getElementById('cf-tipo').value = c.tipo || 'descuento_pct';
  document.getElementById('cf-valor').value = c.valor || '';
  document.getElementById('cf-descripcion').value = c.descripcion || '';
  if (c.vigencia_inicio) document.getElementById('cf-vig-inicio').value = fechaDeValorCDMX(c.vigencia_inicio);
  if (c.vigencia_fin) document.getElementById('cf-vig-fin').value = fechaDeValorCDMX(c.vigencia_fin);
  document.getElementById('cf-usos-max').value = c.usos_maximos || '';
  document.getElementById('cf-min-compra').value = c.min_compra || '';
  document.getElementById('cf-segmento').value = c.segmento || 'todos';
  actualizarValorCupon();
  document.getElementById('overlay-cup-form').classList.add('visible');
  document.getElementById('drawer-cup-form').classList.add('open');
};

window.cerrarCupForm = function() {
  document.getElementById('overlay-cup-form').classList.remove('visible');
  document.getElementById('drawer-cup-form').classList.remove('open');
};

window.actualizarValorCupon = function() {
  const tipo = document.getElementById('cf-tipo').value;
  const lbl = document.getElementById('cf-lbl-valor');
  const bloque = document.getElementById('cf-bloque-valor');
  const inp = document.getElementById('cf-valor');
  if (tipo === 'descuento_pct') { lbl.textContent = 'Porcentaje (1-100)'; bloque.style.display=''; inp.placeholder='10'; }
  else if (tipo === 'descuento_fijo') { lbl.textContent = 'Monto del descuento ($)'; bloque.style.display=''; inp.placeholder='50'; }
  else { bloque.style.display='none'; }
};

window.guardarCupon = async function() {
  const codigo = document.getElementById('cf-codigo').value.trim().toUpperCase();
  const tipo = document.getElementById('cf-tipo').value;
  if (!codigo) { mostrarToast('Captura un código'); return; }

  const payload = {
    codigo,
    tipo,
    valor: Number(document.getElementById('cf-valor').value) || 0,
    descripcion: document.getElementById('cf-descripcion').value.trim() || null,
    vigencia_inicio: document.getElementById('cf-vig-inicio').value,
    vigencia_fin: document.getElementById('cf-vig-fin').value,
    usos_maximos: Number(document.getElementById('cf-usos-max').value) || 0,
    compra_minima: Number(document.getElementById('cf-min-compra').value) || 0,
    segmento: document.getElementById('cf-segmento').value,
    activo: true,
  };

  try {
    // `cupones` está cerrada a anon: escribir aquí era poder crearse un
    // descuento del 100% y usarlo.
    const res = await supabaseCall('POST', 'rpc/guardar_cupon', {
      p_data: { id: _editandoCupon ? _editandoCupon.id : null, campos: payload }
    });
    if (!res || !res.ok) {
      avisar({ titulo: 'No se pudo guardar el cupón', cuerpo: ((res && res.error) || 'Sin respuesta') });
      return;
    }
    mostrarToast(_editandoCupon ? 'Cupón actualizado' : 'Cupón creado');
    cerrarCupForm();
    cargarCupones();
  } catch(e) { avisar({ titulo: 'No se pudo guardar el cupón', cuerpo: e.message }); }
};


// Editar pedido desde el drawer (20 sep 2026): abre el editor compartido con el catálogo del canal del pedido.
window.editarPedidoDesdeDrawer = function () {
  const pa = N._pedidoActual; if (!pa || !pa.orden) return;
  const o = pa.orden;
  const llamar = (modo) => (lineas) => supabaseCall('POST', 'rpc/editar_pedido', { p_data: { idOrden: String(o.id), actualizadoPor: N.vendedorInfo?.nombre || 'vendedor', modo, lineas } });
  abrirEditorPedido({
    pedido: { id: o.id, consecutivo: o.consecutivo, total: o.total, editable: o.editable, motivo: o.motivo },
    lineas: pa.lineas || [],
    catalogo: (N.catalogo || []),
    nivel: o.nivel || 'consumidor',
    audiencia: 'vendedor',
    cotizar: llamar('cotizar'), aplicar: llamar('aplicar'),
    alGuardar: (r) => {
      // Regla 6 de la revisión final: si el total sube en un pedido en efectivo/transferencia ya
      // marcado Pagado, estatus_pago se queda en 'Pagado' (decisión de Abraham: no lo toca el editor) y
      // la diferencia nunca aparece como por cobrar — solo se nota como faltante al cerrar caja. El
      // aviso aquí es la única señal de que falta cobrar esa diferencia.
      if (r.caja && r.caja.monto) mostrarToast(r.caja.monto > 0
        ? `Faltan por cobrar $${Number(r.caja.monto).toLocaleString('es-MX')} de este pedido`
        : `Caja: ajuste de $${Number(r.caja.monto).toLocaleString('es-MX')}`);
      if (r.puntos && r.puntos.puntos) mostrarToast(`Puntos: ajuste de ${r.puntos.puntos}`);
      verDetallePedido(o.id);
    },
  });
};

// Lo que app.js llama del panel
export { armadoPararRefresco, cargarCupones, cargarListaProductos, pintarDetallePedido, renderArmado, renderB2B, renderCaja, renderEntregas, renderGastos, renderJornadas, renderMayoreoAdminCfg, renderPedidosVendedor, renderProduccion, renderProspeccion, renderReparto, renderResumen, renderRuta };
