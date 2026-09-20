
// ══════════════════════════════════
// CONFIG
// ══════════════════════════════════
// SHEETS_URL se eliminó de aquí: era código muerto (una sola aparición en
// todo el archivo) y publicaba la URL /exec del Apps Script en un repo
// público. La usa el backend, no el navegador: vive en api/sheets.js, ahora
// desde variable de entorno. Ver ACCESOS.md §3.4.
const WHATSAPP_NUM        = '525573654109'; // Crunchy Paps (negocio)
const WHATSAPP_BODEGA     = '525573654109'; // Mismo número (bodega)
// La llave de Maps sale de /api/config.js (una por entorno). La de abajo es el
// respaldo: si el entorno no la trae, la app sigue como hasta hoy. Una llave de
// Maps NO es un secreto —viaja al navegador por diseño—; lo que la protege son
// sus restricciones, y por eso staging usa una llave aparte.
const GOOGLE_MAPS_KEY = ((typeof window !== 'undefined' && window.__CP_CONFIG__ && window.__CP_CONFIG__.GOOGLE_MAPS_KEY) || 'AIzaSyCrFgvrh7Hk-o2TdtsT3A2oy9956PmioQw');

// ════════════════════════════════════════════════════════════════
// SUPABASE — migración progresiva (Fase 1: solo bebidas)
// ════════════════════════════════════════════════════════════════
// ── Configuración por entorno (Fase 1c) ─────────────────────────────────
// El origen de verdad son las variables de entorno de Vercel, que sirve
// /api/config.js (cargado en el <head>, antes de este módulo).
//
// Ni la URL ni la llave anon son secretos: viajan al navegador por diseño.
// Lo que protege los datos son las políticas RLS (ACCESOS.md §3.0). El punto
// de este bloque no es esconderlas, sino que CADA ENTORNO HABLE CON SU BASE:
// que un preview de Vercel o una sesión local jamás escriban en producción.
// Eso es el hallazgo 16.
const CP_PROD_URL  = 'https://xbyzarzyxiugrucyjwfn.supabase.co';
// Llave PUBLISHABLE, no la anon legacy. Supabase borra las anon/service_role
  // a finales de 2026: lo que siga con ellas deja de funcionar. Las dos
  // conviven mientras tanto, así que el cambio no tiene ventana de corte.
  const CP_PROD_ANON = 'sb_publishable_8-OwEr5hYTWdNWBG-wpshQ_SVHmH3W5';
const CP_HOSTS_PROD = ['crunchypaps.mx', 'www.crunchypaps.mx'];

const _cpCfg = (typeof window !== 'undefined' && window.__CP_CONFIG__) || {};

// La variable de entorno manda; el hostname es el respaldo si no llegó config.
const _cpEsProd = _cpCfg.ENTORNO
  ? _cpCfg.ENTORNO === 'production'
  : CP_HOSTS_PROD.indexOf(location.hostname) !== -1;

// Escape hatch para desarrollo local sin `vercel dev`. En la consola:
//   localStorage.setItem('cp_supabase_url',  'https://<ref>.supabase.co');
//   localStorage.setItem('cp_supabase_anon', '<llave anon>');
function _cpLocal(k) { try { return localStorage.getItem(k) || ''; } catch (_e) { return ''; } }

const SUPABASE_URL =
  _cpCfg.SUPABASE_URL || _cpLocal('cp_supabase_url') || (_cpEsProd ? CP_PROD_URL : '');
const SUPABASE_ANON_KEY =
  _cpCfg.SUPABASE_ANON_KEY || _cpLocal('cp_supabase_anon') || (_cpEsProd ? CP_PROD_ANON : '');

// Salvaguarda dura: fuera de producción, nunca hablar con la base de producción.
// Es preferible que un preview falle a la vista y no que escriba datos reales.
if (!_cpEsProd && SUPABASE_URL === CP_PROD_URL) {
  console.error('[CP] BLOQUEADO: entorno no productivo apuntando a la base de PRODUCCIÓN.');
  throw new Error('Configuración inválida: preview/local no puede usar la base de producción.');
}
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('[CP] Sin configuración de Supabase. Fuera de producción hace falta ' +
                '/api/config.js (usa `vercel dev`) o el override de localStorage.');
}

// v2.11: Exponer en window para que el bloque vanilla pueda usarlos
window.SUPABASE_URL = SUPABASE_URL;
window.SUPABASE_ANON_KEY = SUPABASE_ANON_KEY;
window.CP_ENTORNO = _cpEsProd ? 'produccion' : (_cpCfg.ENTORNO || 'no-produccion');

// ══════════════════════════════════════════════════════════════════
// Cola de eventos de navegación (PLAN.md §3.3)
// ══════════════════════════════════════════════════════════════════
// Antes cada evento era una petición HTTP; `registrar_evento` era el RPC más
// usado de la app (3,757 llamadas). Ahora se acumulan y se descargan en lote.
//
// La cola vive SOLO en memoria — decisión de Abraham, 4 sep 2026. No se guarda
// navegación en el teléfono del cliente, y a cambio se acepta perder el lote
// pendiente si el navegador se cae de golpe: segundos de eventos. La pérdida
// no es nueva, track() ya se tragaba los errores en silencio; cambia de forma,
// de evento suelto a lote.
//
// Cada evento se apunta con su instante local y viaja con `msAtras` (el
// desfase en milisegundos, no la fecha del reloj del teléfono); el servidor
// reconstruye `now() - msAtras`. Así los huecos del embudo son exactos aunque
// el reloj del cliente esté mal puesto. Ver la migración
// 20260911000000_eventos_en_lote.sql.
const EV_LOTE_MAX  = 20;     // descarga al llegar a este tamaño
const EV_ESPERA_MS = 5000;   // ...o a los 5 s del primero en cola
const EV_TOPE_RPC  = 50;     // el servidor rechaza lotes mayores
let _evCola  = [];
let _evTimer = null;

function _evProgramar() {
  if (_evTimer) return;
  try { _evTimer = setTimeout(_evDescargar, EV_ESPERA_MS); } catch (_e) {}
}

function _evDescargar() {
  if (_evTimer) { try { clearTimeout(_evTimer); } catch (_e) {} _evTimer = null; }
  if (!_evCola.length) return;
  var lote = _evCola.splice(0, EV_TOPE_RPC);
  if (_evCola.length) _evProgramar();     // lo que sobró va en el siguiente
  var ahora = Date.now();
  var eventos = lote.map(function (x) {
    x.ev.msAtras = Math.max(0, ahora - x.t);
    return x.ev;
  });
  try {
    // keepalive: la petición sobrevive al cierre de la pestaña.
    supabaseCall('POST', 'rpc/registrar_eventos', { p_data: { eventos: eventos } },
                 { keepalive: true }).catch(function () {});
  } catch (_e) {}
}

// Cuarto momento de descarga: la pestaña se oculta (cambiar de app, bloquear
// el teléfono, cerrar). Es el que salva las sesiones que terminan sin compra.
try {
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') _evDescargar();
  });
} catch (_e) {}

// GA4: helper seguro para enviar eventos (no-op si gtag no está listo)
function track(nombre, params) {
  // GA4 no cambia: sigue disparando evento por evento. Solo se agrupa la
  // escritura de primera parte a Supabase.
  try { if (typeof window.gtag === 'function') window.gtag('event', nombre, params || {}); } catch (_e) {}
  // Dual-write first-party a Supabase (fire-and-forget; nunca bloquea ni rompe la app)
  try {
    var _g = function (k) { try { return sessionStorage.getItem(k) || ''; } catch (e) { return ''; } };
    // Las columnas utm_* del evento llevan la ÚLTIMA atribución: "de dónde vino
    // esta visita". La primera viaja solo en `purchase` (abajo), que es donde
    // la atribución paga.
    var _atr = (typeof window.cpAtribucion === 'function') ? window.cpAtribucion('last') : {};
    var _params = params || {};
    // Marca de canal. Es una sola app: un vendedor en el mostrador pasa por el
    // mismo catálogo y el mismo checkout, así que sin esto sus sesiones entran
    // al embudo como si fueran de un cliente — y no es ruido neutro: abre el
    // checkout para cerrar una venta YA hecha, así que convierte casi al 100 %
    // y esconde la caída real. Va en `params` (jsonb): sin columnas nuevas.
    // `v` = es personal · `t` = tipo de cliente (consumidor/tienda/restaurante/
    // mayorista). Los dos separan embudos que no se parecen: un tendero que
    // repone cada semana no se comporta como quien descubre la marca, y
    // promediarlos da una cifra que no describe a ninguno.
    if (esVendedor) _params = Object.assign({}, _params, { v: 1 });
    if (tipoCliente) _params = Object.assign({}, _params, { t: tipoCliente });
    if (nombre === 'purchase') {
      var _pri = (typeof window.cpAtribucion === 'function') ? window.cpAtribucion('first') : {};
      if (_pri.utm_source || _pri.utm_campaign) {
        // `params` es jsonb: cabe sin migración ni columnas nuevas.
        _params = Object.assign({}, _params, {
          utm_first_source:   _pri.utm_source   || '',
          utm_first_medium:   _pri.utm_medium   || '',
          utm_first_campaign: _pri.utm_campaign || '',
          utm_first_dias:     Math.round((Date.now() - _pri.t) / 86400000),
        });
      }
    }
    _evCola.push({ t: Date.now(), ev: {
      sessionId:   _g('cp_sid'),
      idCliente:   (clienteActual && clienteActual.id) ? clienteActual.id : null,
      evento:      nombre,
      params:      _params,
      utmSource:   _atr.utm_source   || '',
      utmMedium:   _atr.utm_medium   || '',
      utmCampaign: _atr.utm_campaign || '',
      path:        location.pathname + location.search
    } });
    // `purchase` cierra el embudo y es el que más duele perder: sale ya.
    if (nombre === 'purchase' || _evCola.length >= EV_LOTE_MAX) _evDescargar();
    else _evProgramar();
  } catch (_e) {}
}

// GA4 User-ID: une visitas y dispositivos del MISMO cliente en un solo usuario.
// Usa el id opaco de Supabase (nunca teléfono/correo/nombre — eso viola las políticas).
function gaSetUser(id) {
  try { if (id && typeof window.gtag === 'function') window.gtag('set', { user_id: String(id) }); } catch (_e) {}
}

// Whitelist B2B aprobados { telefono: true }
// Cuando conectes Sheets esto se consulta dinámicamente
const B2B_APROBADOS = {};


// ══════════════════════════════════
// ESTADO
// ══════════════════════════════════
let tipoCliente    = window._tipoCliente || '';
let esVendedor     = false;
let vendedorInfo   = null;   // { id, nombre, rol }
// Token de sesión de CLIENTE, emitido al verificar el OTP. Es la única
// prueba de que quien pide datos controla ese teléfono. Dura 60 días, como
// la sesión: renovarlo cuesta un SMS.
let clienteToken   = '';
let clienteTokenExp = null;
let telefonoVerif  = '';
let clienteActual  = null;
let vendedorAsig   = null;
let puntos         = 0;
let carrito        = {};
let tipoPagoId     = 1;
let tipoPagoNom    = 'Efectivo';
// v2.10: Método de entrega
let metodoEntrega  = 'coordinar';  // 'coordinar' | 'paqueteria'
let _contactoVendedor = null;  // v2.11: vendedor elegido por consumidor cuando coordina. {id, nombre, rol, telefono}
let _vendedoresCheckoutCache = null;  // cache de la lista para no consultar a cada tecla
const COSTO_PAQUETERIA = 80;  // configurable: costo fijo de envío por paquetería
const MIN_PAQUETERIA   = 250; // monto mínimo de compra (sin envío) para elegir paquetería
let saborActivo    = '';
let presentacionActiva = '';   // filtro por presentación (papas); '' = todas
let detalleKey = null;         // producto abierto en el detalle
let modoVenta      = 'pieza'; // 'pieza' | 'granel'
let mapsListo      = false;
let dirCoords      = null;
let wppUrlPend     = null;
let catalogo       = []; // productos desde Sheets

const TIPO_LABELS  = window.TIPO_LABELS = { consumidor:'Consumidor', tienda:'Tienda / Abarrotes', restaurante:'Restaurante', mayorista:'Mayorista', vendedor:'Vendedor', mostrador:'Mostrador' };
const SABORES_ORDER = ['Natural','Adobada','Feroz','Habanero','Queso Jalapeño','Queso Cheddar','Crunchy Mix'];
// Rediseno visual, paso 3: en pantalla cada sabor es un punto de color, no un
// emoji. El nombre va al lado siempre; el color solo acelera el reconocimiento.
const SABOR_COLOR   = { 'Natural':'#FFD200','Adobada':'#B5432E','Feroz':'#FF6A00','Habanero':'#E8242A','Queso Jalapeño':'#7CB342','Queso Cheddar':'#F5A623','Crunchy Mix':'mix' };
function saborDot(sabor, px) {
  const c = SABOR_COLOR[sabor] || '#777';
  const tam = px ? `width:${px}px;height:${px}px;` : '';
  return c === 'mix'
    ? `<span class="sabor-dot mix" aria-hidden="true" style="${tam}"></span>`
    : `<span class="sabor-dot" aria-hidden="true" style="${tam}background:${c};"></span>`;
}
// Un solo placeholder de trazo para todo producto sin foto (papas y bebidas).
const ICONO_CARRITO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4h2l2.4 11.2a1 1 0 0 0 1 .8h9.6a1 1 0 0 0 1-.8L21 8H6.3"/><circle cx="9.5" cy="20" r="1.2"/><circle cx="17.5" cy="20" r="1.2"/></svg>';
const ICONO_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const ICONO_FOTO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="m21 15-5-5-8 8"/></svg>';
const MINIMOS       = { consumidor:0, tienda:200, restaurante:300, mayorista:500, vendedor:0, mostrador:0 };

// ══════════════════════════════════
// NAVEGACIÓN
// ══════════════════════════════════
window.ir = function(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
};

// Entrada de INVITADO. Esta función llevaba meses en el archivo sin un solo
// llamador —quedó huérfana cuando la Sesión 21 quitó «comprar como consumidor»
// de la pantalla de espera—, y es exactamente lo que hacía falta para abrir la
// puerta. Se revive en vez de escribir una nueva.
//
// Sin sesión, `tipoCliente` = consumidor y `getPrecio` cae en
// `precio_consumidor` por defecto: ver el catálogo NO revela precios de
// mayoreo, que era la razón de negocio del muro. El OTP se exige al pagar.
// Si el OTP se disparó DESDE el checkout, se vuelve al carrito y se reabre el
// cajón — pero NO se reenvía el pedido solo. Autoenviar después de un rodeo por
// otra pantalla es exactamente como se crean pedidos duplicados: el cliente
// confirma él, viendo lo que confirma.
function volverTrasVerificar(rutaNormal) {
  return async function () {
    if (!window._volverAlCheckout) { rutaNormal(); return; }
    window._volverAlCheckout = false;
    await irAlCatalogo();
    try { abrirCarrito(); } catch (_e) {}
    if (typeof mostrarToast === 'function') mostrarToast('Número verificado. Revisa y confirma tu pedido.');
  };
}

window.usarComoConsumidor = function() {
  tipoCliente = 'consumidor';
  window._tipoCliente = 'consumidor';
  esVendedor = false;
  irAlCatalogo();
};

// ══════════════════════════════════
// OTP
// ══════════════════════════════════

window.enviarSMS = async function() {
  const tel = document.getElementById('inp-tel').value.trim();
  const msg = document.getElementById('msg-tel');
  const btn = document.getElementById('btn-sms');
  if (!/^\d{10}$/.test(tel)) {
    msg.className='msg err'; msg.textContent='Ingresa 10 dígitos válidos'; return;
  }
  btn.disabled=true; btn.innerHTML='<span class="loader"></span> Enviando...';
  msg.className='msg info'; msg.textContent='Enviando...';
  try {
    // Enviar OTP via Twilio (proxy Vercel)
    const res = await fetch('/api/sheets', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ accion:'enviar_otp', telefono:tel })
    });
    const data = await res.json();

    if (!data.ok) {
      msg.className='msg err'; msg.textContent = data.error || 'Error al enviar. Intenta de nuevo.';
      btn.disabled=false; btn.textContent='Enviar código SMS';
      return;
    }

    // SMS enviado correctamente
    telefonoVerif = tel;
    window._otpCanal = 'sms';
    window._tipoCliente = tipoCliente;
    document.getElementById('otp-tel').style.display='none';
    const cod = document.getElementById('otp-cod');
    cod.style.display='flex';
    document.getElementById('otp-desc-cod').textContent = `Código enviado al +52 ${tel}`;
    document.getElementById('d0').focus();
    // Mostrar botón reenviar después de 30 segundos
    setTimeout(()=>{ document.getElementById('btn-reenviar').style.display='inline-block'; }, 30000);

  } catch(e) {
    console.error('Error SMS:', e);
    msg.className='msg err'; msg.textContent='Error de conexión. Verifica tu internet e intenta de nuevo.';
    btn.disabled=false; btn.textContent='Enviar código SMS';
  }
};

window.enviarOTPEmail = async function() {
  const tel = document.getElementById('inp-tel').value.trim();
  const email = (document.getElementById('inp-email-otp').value || '').trim();
  const msg = document.getElementById('msg-email-otp');
  const btn = document.getElementById('btn-email-otp');
  if (!/^\d{10}$/.test(tel)) { msg.className='msg err'; msg.textContent='Primero captura tu número (10 dígitos)'; return; }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { msg.className='msg err'; msg.textContent='Ingresa un correo válido'; return; }
  btn.disabled=true; btn.innerHTML='<span class="loader"></span> Enviando...';
  msg.className='msg info'; msg.textContent='Enviando...';
  try {
    const res = await fetch('/api/otp-email', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ accion:'enviar', telefono:tel, email })
    });
    const data = await res.json();
    if (!data.ok) {
      msg.className='msg err'; msg.textContent = data.error || 'No se pudo enviar el correo.';
      btn.disabled=false; btn.innerHTML='Enviar código por correo'; return;
    }
    window._otpCanal = 'email';
    window._otpEmail = email;
    telefonoVerif = tel;
    window._tipoCliente = tipoCliente;
    document.getElementById('otp-tel').style.display='none';
    const cod = document.getElementById('otp-cod');
    cod.style.display='flex';
    document.getElementById('otp-desc-cod').textContent = `Código enviado a ${email}`;
    document.getElementById('d0').focus();
    setTimeout(()=>{ const r=document.getElementById('btn-reenviar'); if(r) r.style.display='inline-block'; }, 30000);
  } catch(e) {
    msg.className='msg err'; msg.textContent='Error de conexión. Intenta de nuevo.';
    btn.disabled=false; btn.innerHTML='Enviar código por correo';
  }
};

window.foco = function(inp, idx) {
  inp.value=inp.value.replace(/\D/g,'');
  if (inp.value && idx<5) document.getElementById(`d${idx+1}`).focus();
  const cod=[0,1,2,3,4,5].map(i=>document.getElementById(`d${i}`).value).join('');
  if (cod.length===6) verificarCodigo();
};

window.retroceso = function(e, idx) {
  if (e.key==='Backspace') {
    const inp=document.getElementById(`d${idx}`);
    if (!inp.value && idx>0) { document.getElementById(`d${idx-1}`).value=''; document.getElementById(`d${idx-1}`).focus(); }
    else inp.value=''; e.preventDefault();
  }
  if (e.key==='ArrowLeft'&&idx>0) document.getElementById(`d${idx-1}`).focus();
  if (e.key==='ArrowRight'&&idx<5) document.getElementById(`d${idx+1}`).focus();
};

window.verificarCodigo = async function() {
  const cod=[0,1,2,3,4,5].map(i=>document.getElementById(`d${i}`).value).join('');
  const msg=document.getElementById('msg-cod');
  const btn=document.getElementById('btn-verificar');
  if (cod.length<6) { msg.className='msg err'; msg.textContent='Ingresa los 6 dígitos'; return; }
  btn.disabled=true; btn.innerHTML='<span class="loader"></span> Verificando...';
  msg.className='msg info'; msg.textContent='Verificando...';
  try {
    // Verificar OTP via Twilio (proxy Vercel)
    telefonoVerif = document.getElementById('inp-tel').value.trim();
    const _canal = window._otpCanal || 'sms';
    const _endpoint = _canal === 'email' ? '/api/otp-email' : '/api/sheets';
    const _payloadV = _canal === 'email'
      ? { accion:'verificar', telefono:telefonoVerif, codigo:cod }
      : { accion:'verificar_otp', telefono:telefonoVerif, codigo:cod };
    const resVerif = await fetch(_endpoint, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(_payloadV)
    });
    const dataVerif = await resVerif.json();

    if (!dataVerif.ok || !dataVerif.verificado) {
      msg.className='msg err'; msg.textContent = dataVerif.error || 'Código incorrecto.';
      btn.disabled=false; btn.textContent='Verificar y continuar';
      [0,1,2,3,4,5].forEach(i=>{ document.getElementById(`d${i}`).value=''; });
      document.getElementById('d0').focus();
      return;
    }

    msg.className='msg ok'; msg.textContent='✓ Número verificado';
    // El token lo emite el servidor tras comprobar el código; el navegador
    // solo lo guarda. Puede venir null si la emisión falló: entonces se
    // entra igual, pero sin poder consultar datos propios.
    clienteToken    = dataVerif.token || '';
    clienteTokenExp = dataVerif.expiraEn || null;
    track('login', { method: 'otp' });

    try {
      // 1. Verificar si es cliente ya registrado (Supabase RPC)
      const resC = await supabaseCall('POST', 'rpc/obtener_cliente_con_stats', { p_telefono: telefonoVerif, p_token: tokenParaConsultaCliente() });

      if (resC && resC.ok && resC.existe) {
        // Cliente conocido → usar su tipo guardado
        clienteActual = resC.cliente;
        gaSetUser(clienteActual.id);
        puntos = resC.puntos || 0;
        const tipo = resC.cliente.tipo?.toLowerCase() || 'consumidor';
        if (tipo.includes('tienda') || tipo.includes('abarrotes')) tipoCliente = 'tienda';
        else if (tipo.includes('restaurante')) tipoCliente = 'restaurante';
        else if (tipo.includes('mayorista') || tipo.includes('distribuidor')) tipoCliente = 'mayorista';
        else tipoCliente = 'consumidor';
        if (tipoCliente === 'tienda' || tipoCliente === 'restaurante' || tipoCliente === 'mayorista') {
          setTimeout(volverTrasVerificar(enrutarTrasLoginB2B), 400);   // gating B2B: catálogo solo si aprobada
        } else {
          setTimeout(volverTrasVerificar(irAlCatalogo), 400);
        }
        // Encuesta F&F: si hay un pedido entregado sin encuesta, mostrarla
        if (!esVendedor) setTimeout(function(){ try { window.crunchyEncuesta && window.crunchyEncuesta.checarPendiente(telefonoVerif); } catch(_e){} }, 1500);

      } else {
        // Cliente nuevo → preguntar tipo
        btn.disabled = false; btn.textContent = 'Verificar y continuar';
        mostrarSeleccionTipo();
      }
    } catch(e) {
      tipoCliente = 'consumidor';
      setTimeout(volverTrasVerificar(irAlCatalogo), 400);
    }

  } catch(e) {
    // Solo aquí es error de OTP incorrecto
    console.error('OTP error:', e);
    msg.className='msg err'; msg.textContent='Código incorrecto. Intenta de nuevo.';
    btn.disabled=false; btn.textContent='Verificar y continuar';
    [0,1,2,3,4,5].forEach(i=>{ document.getElementById(`d${i}`).value=''; });
    document.getElementById('d0').focus();
  }
};

window.reenviar = async function() {
  const tel = telefonoVerif || document.getElementById('inp-tel').value.trim();
  if (!tel) {
    document.getElementById('otp-cod').style.display='none';
    document.getElementById('otp-tel').style.display='flex';
    return;
  }
  const msg = document.getElementById('msg-cod');
  msg.className='msg info'; msg.textContent='Reenviando...';
  try {
    const _canal = window._otpCanal || 'sms';
    const res = (_canal === 'email' && window._otpEmail)
      ? await fetch('/api/otp-email', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ accion:'enviar', telefono:tel, email:window._otpEmail })
        })
      : await fetch('/api/sheets', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ accion:'enviar_otp', telefono:tel })
        });
    const data = await res.json();
    if (data.ok) {
      msg.className='msg ok'; msg.textContent='✓ Nuevo código enviado';
      document.getElementById('btn-reenviar').style.display='none';
      setTimeout(()=>{ document.getElementById('btn-reenviar').style.display='inline-block'; }, 30000);
      [0,1,2,3,4,5].forEach(i=>{ document.getElementById(`d${i}`).value=''; });
      document.getElementById('d0').focus();
    } else {
      msg.className='msg err'; msg.textContent = data.error || 'Error al reenviar';
    }
  } catch(e) {
    msg.className='msg err'; msg.textContent='Error de conexión';
  }
};

window.volverTel = function() {
  document.getElementById('otp-cod').style.display='none';
  document.getElementById('otp-tel').style.display='flex';
  [0,1,2,3,4,5].forEach(i=>{ document.getElementById(`d${i}`).value=''; });
};

// ══════════════════════════════════
// CATÁLOGO
// ══════════════════════════════════

// ══════════════════════════════════
// SELECCIÓN TIPO CLIENTE NUEVO
// ══════════════════════════════════
function mostrarSeleccionTipo() {
  ir('s-tipo');
}

window.elegirTipoNuevo = async function(tipo) {
  tipoCliente = tipo;
  window._tipoCliente = tipo;

  if (tipo === 'consumidor') {
    // Consumidor → ir al catálogo sin registrar aún
    // Se registrará al confirmar su primer pedido
    setTimeout(irAlCatalogo, 200);
  } else {
    // Tienda o Restaurante → NO se registra nada todavía.
    //
    // Antes se creaba aquí la fila con solo el teléfono y el tipo, y después se
    // pedían los datos. Quien abandonaba el formulario dejaba una solicitud B2B
    // sin nombre, sin dirección y sin coordenadas: así aparecieron los clientes
    // 53 y 54 en producción. Si se aprueban, queda una tienda sin dirección de
    // entrega, y eso se descubre el día del reparto.
    //
    // El alta la hace guardarDatosTienda(), que ya exige nombre y dirección y
    // resuelve la ubicación por tres vías: el pin del mapa, la geocodificación
    // de la dirección escrita y el GPS como respaldo. Registrar antes no
    // aportaba nada — ese mismo RPC se vuelve a llamar con los datos completos
    // al guardar el formulario.
    mostrarFormDatosTienda();
  }
};

// ══════════════════════════════════
// B2B — Captura obligatoria de datos de tienda + gating (Opción 3)
// ══════════════════════════════════
function mostrarFormDatosTienda() {
  // Places para autocompletar «Dirección»: el cargador solo se llamaba desde el
  // checkout y Prospección, así que aquí nunca había autocompletado.
  if (!mapsListo) initMaps();
  window._dtCoords = null;     // ubicación de ENTREGA (la que ajusta el tendero)
  window._dtGpsCoords = null;  // GPS de validación (silencioso)
  ['dt-negocio','dt-dir','dt-cp','dt-colonia','dt-municipio','dt-estado'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  // Prefill si la tienda ya tenía algún dato
  if (clienteActual) {
    const set = (id, v) => { const el = document.getElementById(id); if (el && v) el.value = v; };
    set('dt-negocio', clienteActual.nombre);
    set('dt-dir', clienteActual.direccion);
    set('dt-cp', clienteActual.cp);
    { const sc = document.getElementById('dt-colonia'); if (sc) sc.dataset.previa = clienteActual.colonia || ''; }
    if (clienteActual.cp) buscarCPTienda(clienteActual.cp);
    set('dt-municipio', clienteActual.municipio);
    set('dt-estado', clienteActual.estado);
  }
  const st = document.getElementById('dt-geo-status');
  if (st) { st.textContent = 'Escribe tu dirección arriba y toca "Ubicar mi tienda en el mapa".'; st.style.color = 'var(--suave)'; }
  const btn = document.getElementById('dt-geo-btn'); if (btn) btn.textContent = 'Ubicar mi tienda en el mapa';
  const wrap = document.getElementById('dt-mapa-wrap'); if (wrap) wrap.style.display = 'none';
  const msg = document.getElementById('dt-msg'); if (msg) msg.style.display = 'none';
  ir('s-datos-tienda');
  // Captura GPS de validación en silencio (el navegador puede pedir permiso 1 vez)
  capturarGpsValidacion();
}

// GPS de validación: se guarda aparte, NO es la ubicación de entrega.
function capturarGpsValidacion() {
  if (!navigator.geolocation) return;
  try {
    navigator.geolocation.getCurrentPosition(
      (pos) => { window._dtGpsCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude }; },
      (_err) => { /* sin permiso: se queda sin GPS de validación, no bloquea */ },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  } catch (_e) {}
}

// Geocodifica la dirección escrita y muestra el mapa con pin arrastrable (ENTREGA).
window.ubicarTiendaEnMapa = async function() {
  const val = id => (document.getElementById(id)?.value || '').trim();
  const dir = val('dt-dir');
  const st = document.getElementById('dt-geo-status');
  if (!dir) { if (st) { st.textContent = 'Primero escribe la calle y número.'; st.style.color = '#ffb454'; } return; }
  if (st) { st.textContent = 'Buscando tu dirección en el mapa…'; st.style.color = 'var(--suave)'; }
  const partes = [dir, val('dt-colonia'), val('dt-cp'), val('dt-municipio'), val('dt-estado'), 'México'].filter(Boolean);
  let coords = null;
  try { coords = await geocodificarDireccionTexto(partes.join(', ')); } catch (_e) {}
  if (!coords) { if (st) { st.textContent = 'No encontramos esa dirección. Revísala e inténtalo de nuevo.'; st.style.color = '#ff8a8a'; } return; }
  window._dtCoords = coords;
  mostrarMapaTienda(coords.lat, coords.lng);
  if (st) { st.innerHTML = 'Pin colocado. <strong>Arrástralo</strong> a la entrada exacta de tu tienda.'; st.style.color = '#7ee787'; }
};

// Mapa con pin arrastrable para la ubicación de ENTREGA de la tienda.
function mostrarMapaTienda(lat, lng) {
  const wrap = document.getElementById('dt-mapa-wrap');
  const div = document.getElementById('dt-mapa-div');
  if (!wrap || !div || typeof google === 'undefined' || !google.maps) return;
  wrap.style.display = 'block';
  const center = { lat, lng };
  if (!window._dtMap) {
    window._dtMap = new google.maps.Map(div, {
      center, zoom: 17, disableDefaultUI: true, zoomControl: true,
      mapTypeControl: false, streetViewControl: false,
    });
    window._dtMarker = new google.maps.Marker({
      position: center, map: window._dtMap, draggable: true,
      animation: google.maps.Animation.DROP, title: 'Arrastra a la entrada de tu tienda',
    });
    window._dtMarker.addListener('dragend', function() {
      const p = window._dtMarker.getPosition();
      window._dtCoords = { lat: p.lat(), lng: p.lng() };
    });
  } else {
    window._dtMap.setCenter(center); window._dtMap.setZoom(17);
    window._dtMarker.setPosition(center);
    window._dtMarker.setAnimation(google.maps.Animation.DROP);
  }
}

// Colonias por CP en el alta de tienda, como en el checkout (mismo servicio).
// Rellena Estado si está vacío; el municipio lo escribe el tendero (el servicio
// no lo devuelve). Restaura la colonia que ya estaba elegida si sigue en la lista.
let _cpTiendaTimer = null;
window.buscarCPTienda = function(cp) {
  cp = String(cp || '').padStart(5, '0');
  const sel = document.getElementById('dt-colonia'), st = document.getElementById('dt-cp-status');
  if (!sel) return;
  const previa = ((sel.dataset.previa || sel.value) || '').trim();
  sel.dataset.previa = '';
  sel.innerHTML = '<option value="">Elige tu colonia</option>'; sel.style.color = '#444';
  if (st) st.textContent = '';
  if (cp.length < 5) return;
  clearTimeout(_cpTiendaTimer);
  if (st) { st.style.color = '#888'; st.textContent = 'Buscando...'; }
  _cpTiendaTimer = setTimeout(async () => {
    try {
      const r = await fetch(`https://api.zippopotam.us/MX/${cp}`);
      if (!r.ok) throw new Error();
      const d = await r.json();
      const places = d.places || [];
      if (!places.length) throw new Error();
      places.forEach(p => { const o = document.createElement('option'); o.value = o.textContent = p['place name']; sel.appendChild(o); });
      // Sin acentos ni mayúsculas: Google dice «Juárez» y el servicio de CP «Juarez».
      const llano = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
      if (previa) { const obj = llano(previa); for (let i = 0; i < sel.options.length; i++) { if (llano(sel.options[i].value) === obj) { sel.selectedIndex = i; break; } } }
      sel.style.color = 'var(--blanco)';
      const est = document.getElementById('dt-estado');
      if (est && !est.value && places[0].state) est.value = places[0].state;
      if (st) { st.style.color = '#4caf50'; st.textContent = `✓ ${places.length} colonia${places.length > 1 ? 's' : ''}`; }
    } catch (e) {
      if (st) { st.style.color = 'var(--rojo)'; st.textContent = '✗ CP no encontrado'; }
    }
  }, 600);
};

window.guardarDatosTienda = async function() {
  const val = id => (document.getElementById(id)?.value || '').trim();
  const negocio = val('dt-negocio');
  const dir = val('dt-dir');
  const cp = val('dt-cp');
  const colonia = val('dt-colonia');
  const municipio = val('dt-municipio');
  const estado = val('dt-estado');
  const msg = document.getElementById('dt-msg');
  const showMsg = (txt, ok) => {
    if (!msg) return;
    msg.style.display = 'block'; msg.textContent = txt;
    msg.style.background = ok ? '#0d2d0d' : '#3a1515';
    msg.style.color = ok ? '#7ee787' : '#ff8a8a';
  };

  if (!negocio) { showMsg('Escribe el nombre de tu negocio.'); return; }
  if (!dir) { showMsg('Escribe la dirección de tu tienda.'); return; }

  // Ubicación de entrega: pin del mapa → geocodificación → GPS de respaldo.
  // NUNCA bloquea: si no hay coords, se guarda igual y se confirma al validar la tienda.
  let coords = window._dtCoords || null;
  if (!coords) {
    const partes = [dir, colonia, cp, municipio, estado, 'México'].filter(Boolean);
    try { coords = await geocodificarDireccionTexto(partes.join(', ')); } catch(_e) {}
    if (coords) window._dtCoords = coords;
  }
  if (!coords && window._dtGpsCoords) {
    coords = window._dtGpsCoords;  // respaldo: GPS silencioso (el dueño suele estar en su tienda)
  }
  const coordStr = coords ? `${coords.lat},${coords.lng}` : '';
  if (!coords) {
    mostrarToast('Guardamos tus datos. Ajustaremos la ubicación exacta al validar tu negocio.');
  }

  const btn = document.getElementById('dt-guardar');
  const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Guardando…';

  const gps = window._dtGpsCoords || null;

  // El tipo se resuelve con el mismo mapa que usa el alta por vendedor
  // (guardarAltaNegocio). Antes eran dos ternarios binarios —restaurante o
  // "Tienda / Abarrotes"— así que al exponer mayorista en el selector, un
  // mayorista se habría guardado como tienda: precios y mínimo equivocados.
  const TIPOS_B2B = {
    tienda:      { label: 'Tienda / Abarrotes',      id: 3 },
    restaurante: { label: 'Restaurante',             id: 2 },
    mayorista:   { label: 'Mayorista / Distribuidor', id: 4 },
  };
  const _t = TIPOS_B2B[tipoCliente] || TIPOS_B2B.tienda;
  const tipoLabel = _t.label;
  const tipoIdNum = _t.id;
  try {
    const rc = await supabaseCall('POST', 'rpc/registrar_o_actualizar_cliente', {
      p_data: {
        telefono: telefonoVerif,
        nombre: negocio,
        tipo: tipoLabel,
        tipoId: tipoIdNum,
        direccion: dir, cp, colonia, municipio, estado,
        coordenadas: coordStr,
        aprobadoB2B: false,
      }
    });
    // Guardar el GPS de validación por separado (no es la ubicación de entrega)
    if (gps) {
      try {
        await supabaseCall('POST', 'rpc/set_coordenadas_gps', {
          p_telefono: telefonoVerif, p_gps: `${gps.lat},${gps.lng}`
        });
      } catch(_e) {}
    }
    clienteActual = Object.assign({}, clienteActual || {}, {
      id: (rc && rc.idCliente) || clienteActual?.id,
      nombre: negocio, tipo: tipoLabel, tipo_id: tipoIdNum,
      direccion: dir, cp, colonia, municipio, estado,
      coordenadas: coordStr, aprobadoB2B: false,
    });
  } catch(e) {
    btn.disabled = false; btn.textContent = orig;
    showMsg('Error al guardar: ' + e.message);
    return;
  }

  // NO se avisa al equipo de un alta B2B nueva. Aquí se armaba un enlace de
  // WhatsApp («🏪 TIENDA POR VALIDAR») que se guardaba en
  // window._wppNotificacionB2B, y su ÚNICO lector —notificarYEntrar()— quedó
  // huérfano cuando la Sesión 21 rehizo la pantalla de espera. Desde entonces
  // la tienda veía «validando tu tienda» y nadie se enteraba.
  // Se retira el enlace en vez de dejarlo fingiendo: el aviso de verdad tiene
  // que salir del servidor, no del teléfono del propio cliente.
  // Ver cambios/2026-09-06-funciones-huerfanas.md

  // Pantalla de validación (Opción 3)
  const pt = document.getElementById('pend-tipo'); if (pt) pt.textContent = tipoCliente === 'restaurante' ? 'restaurante' : (tipoCliente === 'mayorista' ? 'negocio mayorista' : 'tienda');
  const ptel = document.getElementById('pend-tel'); if (ptel) ptel.textContent = '+52 ' + telefonoVerif.replace(/(\d{2})(\d{4})(\d{4})/, '$1 $2 $3');
  btn.disabled = false; btn.textContent = orig;
  ir('s-pendiente');
};

// Enrutar una tienda/restaurante tras login: catálogo solo si está aprobada.
// alRestaurar=true: viene de intentarRestaurarSesion; si la tienda está aprobada
// devuelve true y el que llama sigue con el catálogo ya restaurado (irAlCatalogo
// es el camino de entrada, no el de restauración). Si no, muestra el formulario
// o «Validando» y devuelve false. Antes la puerta B2B solo existía al entrar:
// una tienda a medio registrar que cerraba la app volvía al catálogo de mayoreo.
async function enrutarTrasLoginB2B(alRestaurar) {
  let estado = null;
  try {
    const r = await supabaseCall('POST', 'rpc/get_estado_tienda', { p_telefono: telefonoVerif });
    if (r && r.ok && r.existe) estado = r;
  } catch(_e) {}
  if (estado && estado.aprobado) { if (!alRestaurar) irAlCatalogo(); return true; } // aprobada → catálogo B2B
  if (!estado || !estado.completo) { mostrarFormDatosTienda(); return false; }     // sin datos → formulario
  // datos completos pero no aprobada → pantalla de validación
  const pt = document.getElementById('pend-tipo'); if (pt) pt.textContent = tipoCliente === 'restaurante' ? 'restaurante' : (tipoCliente === 'mayorista' ? 'negocio mayorista' : 'tienda');
  const ptel = document.getElementById('pend-tel'); if (ptel) ptel.textContent = '+52 ' + telefonoVerif.replace(/(\d{2})(\d{4})(\d{4})/, '$1 $2 $3');
  ir('s-pendiente');
  return false;
}


// ══════════════════════════════════
// PERSISTENCIA DE SESIÓN
// Sobrevive recargas accidentales
// ══════════════════════════════════
function guardarSesion() {
  try {
    const datos = {
      tipoCliente, telefonoVerif, esVendedor,
      clienteToken, clienteTokenExp,
      vendedorInfo: vendedorInfo || null,
      clienteActual: clienteActual || null,
      puntos, carrito, modoVenta, canalVenta,
      expira: Date.now() + 60 * 24 * 60 * 60 * 1000, // 60 días (menos re-verificaciones OTP)
    };
    localStorage.setItem('cp_session', JSON.stringify(datos));
  } catch(e) {}
}

function restaurarSesion() {
  try {
    const raw = localStorage.getItem('cp_session');
    if (!raw) return false;
    const s = JSON.parse(raw);
    if (!s.telefonoVerif) return false;
    // Verificar expiración
    if (s.expira && Date.now() > s.expira) { localStorage.removeItem('cp_session'); return false; }
    // Un vendedor entra siempre como 'vendedor' (así lo deja el PIN). Las
    // sesiones guardadas antes del 7 sep 2026 pueden traer 'consumidor' —lo
    // escribía confirmarPedido— y con eso el vendedor veía el checkout del
    // consumidor. Se repara aquí, al restaurar.
    tipoCliente   = s.esVendedor ? 'vendedor' : (s.tipoCliente || 'consumidor');
    telefonoVerif = s.telefonoVerif || '';
    esVendedor    = s.esVendedor    || false;
    vendedorInfo  = s.vendedorInfo  || null;
    clienteToken    = s.clienteToken    || '';
    clienteTokenExp = s.clienteTokenExp || null;
    clienteActual = s.clienteActual || null;
    puntos        = s.puntos        || 0;
    carrito       = s.carrito       || {};
    modoVenta     = s.modoVenta     || 'pieza';
    canalVenta    = s.canalVenta    || 'consumidor';

    // Etapa B: aquí conviven DOS sesiones con vidas y costes distintos.
    //
    //   1. Identidad de CLIENTE (telefonoVerif): se verifica por OTP, dura 60
    //      días a propósito, y rehacerla CUESTA UN SMS de Twilio.
    //   2. Privilegio de VENDEDOR (vendedorInfo.token): dura 12 h por
    //      seguridad, y rehacerlo es gratis — teclear un PIN de 4 dígitos.
    //
    // Cuando cae el privilegio de vendedor, se cae SOLO eso. Borrar también la
    // identidad del cliente obligaría a un OTP nuevo y a pagar un SMS por algo
    // que no lo necesita. (La primera versión de esta guardia lo hacía, y era
    // un error: colapsaba los 60 días a 12 horas y con cargo.)
    const _tokenVendedorInvalido =
      esVendedor && (
        !(vendedorInfo && vendedorInfo.token) ||
        (vendedorInfo.tokenExpira &&
         Date.now() > new Date(vendedorInfo.tokenExpira).getTime())
      );

    if (_tokenVendedorInvalido) {
      esVendedor   = false;
      vendedorInfo = null;
      // `telefonoVerif`, `tipoCliente`, `clienteActual`, `puntos` y `carrito`
      // se conservan: siguen siendo válidos y no dependen del PIN.
      if (tipoCliente === 'vendedor') tipoCliente = 'consumidor';
      guardarSesion();   // persistir la sesión ya sin la parte de vendedor
    }
    return true;
  } catch(e) { return false; }
}

function limpiarSesion() {
  try { localStorage.removeItem('cp_session'); } catch(e) {}
}

// Titular del catálogo para el consumidor: «Hola, Nombre» con sesión, «Elige tus
// papas» como invitado. El nombre viene de la base (su propia ficha) y se escapa.
function tituloConsumidor() {
  const bruto = (typeof clienteActual !== 'undefined' && clienteActual && clienteActual.nombre && !esVendedor)
    ? String(clienteActual.nombre).trim().split(/\s+/)[0] : '';
  const nombre = bruto.replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  return nombre ? 'Hola, <span class="hl">' + nombre + '</span>' : 'Elige tus <span class="hl">papas</span>';
}

// Campos B2B del checkout (nombre del negocio y RFC). Antes solo los encendía
// irAlCatalogo(), o sea al entrar; una tienda que volvía con su sesión de 60
// días no los veía y el checklist le pedía «Nombre del establecimiento» sin
// dónde escribirlo (recorrido como tendero, 13 sep 2026).
function mostrarCamposB2B() {
  const esB2B = tipoCliente === 'tienda' || tipoCliente === 'restaurante' || tipoCliente === 'mayorista';
  const wn = document.getElementById('wrap-negocio'), wr = document.getElementById('wrap-rfc'), fn = document.getElementById('f-negocio');
  if (!wn || !wr || !fn) return;
  wn.classList.toggle('visible', esB2B);
  wr.classList.toggle('visible', esB2B);
  if (esB2B) fn.placeholder = tipoCliente === 'tienda' ? 'Nombre de tu tienda *' : (tipoCliente === 'mayorista' ? 'Nombre de tu negocio *' : 'Nombre del restaurante *');
}

async function irAlCatalogo() {
  track('view_catalog');
  // Tras entrar con PIN la barra debe reflejar las secciones del servidor sin
  // esperar a recargar (antes solo pasaba en intentarRestaurarSesion).
  if (esVendedor) aplicarPermisosNavbar();
  // Header
  const telDisp = telefonoVerif.replace(/(\d{2})(\d{4})(\d{4})/,'$1 $2 $3');
  // Un invitado no tiene teléfono, y dejar el nombre vacío hace que la
  // cabecera se vea a medio cargar. Se dice lo que es.
  document.getElementById('h-nombre').textContent = telefonoVerif ? telDisp : 'Invitado';
  document.getElementById('h-tipo').textContent = esVendedor ? (vendedorInfo?.nombre||'Vendedor') : TIPO_LABELS[tipoCliente];
  const ht2 = document.getElementById('h-tipo2');
  if (ht2) ht2.textContent = esVendedor ? 'Vendedor' : TIPO_LABELS[tipoCliente];

  // Banner
  const banners = {
    consumidor: { tag:'Tu pedido', titulo:tituloConsumidor() },
    tienda:     { tag:'Abarrotes', titulo:'Pedido para tu <span class="hl">tienda</span>' },
    mayorista:  { tag:'Mayoreo',   titulo:'Pedido de <span class="hl">mayoreo</span>' },
    restaurante:{ tag:'Restaurante',titulo:'Pedido para tu <span class="hl">cocina</span>' },
    vendedor:   { tag:'Vendedor',  titulo:`Hola, <span class="hl">${vendedorInfo?.nombre?.split(' ')[0]||'vendedor'}</span>` },
    mostrador:  { tag:'Mostrador', titulo:'Punto de <span class="hl">venta</span>' },
  };
  const b = banners[tipoCliente] || banners.consumidor;
  const elCatTag = document.getElementById('cat-tag');
  if (elCatTag) elCatTag.innerHTML = b.tag;
  const elCatTit = document.getElementById('cat-titulo');
  if (elCatTit) elCatTit.innerHTML = b.titulo;

  // Modo venta (vendedor)
  if (esVendedor) {
    document.getElementById('modo-wrap').classList.add('visible');
    mostrarNavProduccion();
    mostrarNavB2B();
    mostrarNavCaja();
    mostrarNavResumen();
    // Restaurar modo granel y canal si estaba activo
    setTimeout(() => {
      if (typeof aplicarModoVenta === 'function') aplicarModoVenta();
      if (typeof mostrarCanalVenta === 'function') mostrarCanalVenta();
    }, 100);
  }

  // Campos B2B (también al restaurar sesión: ver mostrarCamposB2B)
  mostrarCamposB2B();

  // v2.10: Método de entrega solo para CONSUMIDOR
  // B2B (tienda/restaurante) coordina entrega con su vendedor directo
  const wrapEntrega = document.getElementById('entrega-wrap');
  if (wrapEntrega) {
    if (tipoCliente === 'consumidor') {
      wrapEntrega.style.display = 'block';
    } else {
      wrapEntrega.style.display = 'none';
      // Forzar coordinar para B2B (sin opción de paquetería)
      metodoEntrega = 'coordinar';
    }
  }

  ir('s-catalogo');
  document.getElementById('navbar').style.display='flex';
  guardarSesion();

  // v2.7.3: activar performance monitor para admin
  if (typeof activarPerfSiAdmin === 'function') activarPerfSiAdmin();

  // Cargar catálogo desde Sheets
  await cargarCatalogo();

  // Cargar historial y vendedor (background)
  cargarDatosCliente();
}

// ══════════════════════════════════
// RESTAURAR SESIÓN AL CARGAR
// Se ejecuta al cargar el módulo
// ══════════════════════════════════
async function intentarRestaurarSesion() {
  if (!restaurarSesion()) return;

  // Panel bajo demanda: el vendedor lo va a necesitar sí o sí, así que se pide ya, en paralelo
  // con el catálogo. El consumidor nunca entra aquí, y por eso nunca descarga panel.js.
  if (esVendedor) cargarPanel().catch(() => {});

  // Sesión encontrada — restaurar sin OTP
  if (!saborActivo) saborActivo = SABORES_ORDER[0];
  const telDisp = telefonoVerif.replace(/(\d{2})(\d{4})(\d{4})/, '$1 $2 $3');
  const hNombre = document.getElementById('h-nombre');
  const hTipo   = document.getElementById('h-tipo');
  if (hNombre) hNombre.textContent = clienteActual?.nombre || telDisp;
  const hTipo2 = document.getElementById('h-tipo2');
  if (hTipo2) hTipo2.textContent = esVendedor ? 'Vendedor' : (TIPO_LABELS[tipoCliente] || 'Consumidor');
  if (hTipo)   hTipo.textContent   = esVendedor
    ? (vendedorInfo?.nombre || 'Vendedor')
    : (TIPO_LABELS[tipoCliente] || tipoCliente);

  // Aplicar permisos de secciones (config admin) — async pero no bloquea render
  aplicarPermisosNavbar();
  // Botón de permisos en Mi cuenta solo para admin
  const btnPerm = document.getElementById('btn-permisos-cuenta');
  if (btnPerm) btnPerm.style.display = (esAdmin && esAdmin()) ? '' : 'none';
  // v2.7.3: activar performance monitor para admin
  if (typeof activarPerfSiAdmin === 'function') activarPerfSiAdmin();

  // Botón de instalar app: ocultar si ya está instalada
  const btnInst = document.getElementById('btn-instalar-app');
  if (btnInst) {
    const yaInstalada = window.matchMedia('(display-mode: standalone)').matches ||
                        window.navigator.standalone === true;
    btnInst.style.display = yaInstalada ? 'none' : '';
  }

  // Restaurar banner
  mostrarCamposB2B();
  const banners = {
    consumidor:  { tag:'Tu pedido',   titulo:tituloConsumidor() },
    tienda:      { tag:'Abarrotes',   titulo:'Pedido para tu <span class=\"hl\">tienda</span>' },
    mayorista:   { tag:'Mayoreo',     titulo:'Pedido de <span class=\"hl\">mayoreo</span>' },
    restaurante: { tag:'Restaurante', titulo:'Pedido para tu <span class=\"hl\">cocina</span>' },
    vendedor:    { tag:'Vendedor',    titulo:`Hola, <span class=\"hl\">${vendedorInfo?.nombre?.split(' ')[0]||'vendedor'}</span>` },
  };
  const b = banners[tipoCliente] || banners.consumidor;
  const catTag = document.getElementById('cat-tag');
  const catTit = document.getElementById('cat-titulo');
  if (catTag) catTag.innerHTML = b.tag;
  if (catTit) catTit.innerHTML = b.titulo;

  // Puerta B2B también al restaurar: una tienda sin datos o sin aprobar no ve
  // el catálogo de mayoreo (antes solo se comprobaba al entrar con OTP).
  const esB2BRestaurada = !esVendedor && (tipoCliente === 'tienda' || tipoCliente === 'restaurante' || tipoCliente === 'mayorista');
  if (esB2BRestaurada && !(await enrutarTrasLoginB2B(true))) return;

  // Mostrar catálogo y navbar
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('s-catalogo').classList.add('active');
  document.getElementById('navbar').style.display = 'flex';

  // Cargar catálogo y actualizar badge
  await cargarCatalogo();
  if (window.renderTabs) window.renderTabs();
  if (window.renderCatalogo) window.renderCatalogo();
  if (esVendedor && window.aplicarModoVenta) window.aplicarModoVenta();
  if (esVendedor && window.mostrarCanalVenta) window.mostrarCanalVenta();
  actualizarBadge();

  // Cargar historial en background
  cargarDatosCliente();
}

// Ejecutar restauración cuando el módulo esté listo
setTimeout(intentarRestaurarSesion, 200);
setTimeout(cargarMayoreoCfg, 350);

// v2.11.1: Listener global para actualizar el checklist de faltantes
// cada vez que cambia un input dentro del form de pedido
document.addEventListener('input', function(e) {
  const fp = document.getElementById('form-pedido');
  if (!fp || fp.style.display === 'none') return;
  if (fp.contains(e.target) && typeof actualizarChecklistFaltantes === 'function') {
    actualizarChecklistFaltantes();
  }
});
document.addEventListener('change', function(e) {
  const fp = document.getElementById('form-pedido');
  if (!fp || fp.style.display === 'none') return;
  if (fp.contains(e.target) && typeof actualizarChecklistFaltantes === 'function') {
    actualizarChecklistFaltantes();
  }
});

// ══════════════════════════════════════════════════════════════════
// CACHE FRONTEND (v2.7.3) — localStorage con TTL
// ══════════════════════════════════════════════════════════════════
const CACHE_KEYS = {
  CATALOGO:    'cp_cache_catalogo',
  SECCIONES:   'cp_cache_secciones',
  VENDEDORES:  'cp_cache_vendedores',
};
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

function cacheGet(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !obj.ts || Date.now() - obj.ts > CACHE_TTL_MS) {
      localStorage.removeItem(key);
      return null;
    }
    return obj.data;
  } catch(e) { return null; }
}
function cacheSet(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data }));
  } catch(e) { /* localStorage lleno o deshabilitado: ignorar */ }
}
function cacheClear(key) {
  try { localStorage.removeItem(key); } catch(e) {}
}
window.cacheClear = cacheClear; // exponer para invalidación manual

async function cargarCatalogo(forzarFresh) {
  // Siempre arrancar con catálogo local para mostrar algo de inmediato
  catalogo = generarCatalogoLocal();
  if (!saborActivo) saborActivo = SABORES_ORDER[0];
  renderTabs();
  renderCatalogo();

  // Poblar select granel
  const sel = document.getElementById('granel-sabor');
  sel.innerHTML = '<option value="">Elige sabor</option>';
  SABORES_ORDER.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s; opt.textContent = s;
    sel.appendChild(opt);
  });

  // 1) Intentar cache localStorage si no se pidió fresh
  if (!forzarFresh) {
    const cached = cacheGet(CACHE_KEYS.CATALOGO);
    if (cached && Array.isArray(cached) && cached.length > 0) {
      catalogo = cached;
      renderTabs();
      renderCatalogo();
      perfPush(`cache hit: catalogo (${cached.length} items)`, '#4caf50');
      // Refresh silencioso en background después de 1s para mantener fresh
      setTimeout(() => refrescarCatalogoEnBackground_(), 1000);
      return;
    }
    perfPush(`cache miss: catalogo`, '#FFD200');
  }

  // 2) Sin cache (o fresh forzado): cargar todo desde Supabase
  try {
    const productos = await cargarCatalogoSupabase();
    if (productos.length > 0) {
      catalogo = productos;
      cacheSet(CACHE_KEYS.CATALOGO, catalogo);
      renderTabs();
      renderCatalogo();
    }
  } catch(e) {
    console.log('Usando catálogo local:', e.message);
  }
}

// Refresh silencioso en background sin afectar UI hasta que llegue
async function refrescarCatalogoEnBackground_() {
  try {
    const productos = await cargarCatalogoSupabase();
    if (productos.length > 0) {
      const cambioRelevante = JSON.stringify(catalogo) !== JSON.stringify(productos);
      catalogo = productos;
      cacheSet(CACHE_KEYS.CATALOGO, catalogo);
      if (cambioRelevante) {
        renderTabs();
        renderCatalogo();
      }
    }
  } catch(e) { /* silencioso */ }
}

function generarCatalogoLocal() {
  const prods = [];
  const pres = [
    {id:'100g',gramos:100,pc:32,pt:22,pr:24,pm:32},
    {id:'250g',gramos:250,pc:62,pt:43,pr:46.5,pm:62},
    {id:'500g',gramos:500,pc:110,pt:76,pr:82.5,pm:110},
    {id:'1kg',gramos:1000,pc:220,pt:152,pr:165,pm:220},
  ];
  let id=1;
  SABORES_ORDER.forEach(sabor => {
    pres.forEach(p => {
      prods.push({ id, sabor, presentacion:p.id, gramos:p.gramos,
        precio_consumidor:p.pc, precio_tienda:p.pt, precio_restaurante:p.pr, precio_mostrador:p.pm,
        precio_granel_kg:220, tipo_venta:1, imagen_url:'' });
      id++;
    });
  });
  return prods;
}

function getSabores() {
  return [...new Set(catalogo.filter(p=>p.tipo_venta===1 && (p.categoria||'papa')==='papa').map(p=>p.sabor))]
    .sort((a,b) => SABORES_ORDER.indexOf(a) - SABORES_ORDER.indexOf(b));
}

// v2.7: detectar si hay bebidas para mostrar como tab
function hayBebidasVisibles() {
  // Solo admin/mostrador ven bebidas
  const puedeVer = (typeof esAdmin === 'function' && esAdmin())
    || (vendedorInfo && String(vendedorInfo.rol||'').toLowerCase() === 'mostrador');
  if (!puedeVer) return false;
  return catalogo.some(p => (p.categoria || '') === 'bebida');
}

function getPrecio(prod) {
  // Para vendedor usar el canal seleccionado
  const canal = esVendedor ? (canalVenta || 'consumidor') : tipoCliente;
  let precio = prod.precio_consumidor;
  if (canal==='tienda')      precio = prod.precio_tienda;
  else if (canal==='restaurante') precio = prod.precio_restaurante;
  else if (canal==='mayorista') precio = (Number(prod.precio_mayorista) > 0 ? prod.precio_mayorista : prod.precio_tienda); // puente: precio tienda hasta fijar precio_mayorista
  else if (canal==='mostrador' || (esVendedor && vendedorInfo?.rol==='Mostrador')) precio = prod.precio_mostrador;
  return precio;
}

function getPrecioConDescuento(prod) {
  const base = getPrecio(prod);
  const pct  = prod.descuento_pct || 0;
  if (!pct) return { precio: base, precioOriginal: base, descuento: 0 };
  const precioFinal = Math.round(base * (1 - pct/100));
  return { precio: precioFinal, precioOriginal: base, descuento: pct };
}

window.renderTabs = function() {
  const sabores = getSabores();
  const tieneBebidas = hayBebidasVisibles();
  // Si saborActivo es '__bebidas' pero ya no hay bebidas, resetear
  if (saborActivo === '__bebidas' && !tieneBebidas) saborActivo = '';
  if (!saborActivo || (saborActivo !== '__bebidas' && saborActivo !== '__todos' && !sabores.includes(saborActivo))) {
    saborActivo = sabores[0] || '';
  }
  let html = `<button class="tab ${saborActivo==='__todos'?'active':''}" onclick="cambiarSabor('__todos')">Todos</button>`;
  html += sabores.map(s => `
    <button class="tab ${s===saborActivo?'active':''}" onclick="cambiarSabor('${s}')">
      ${saborDot(s)}${s}
    </button>`).join('');
  if (tieneBebidas) {
    html += `<button class="tab ${saborActivo==='__bebidas'?'active':''}" onclick="cambiarSabor('__bebidas')">
      Bebidas
    </button>`;
  }
  document.getElementById('tabs').innerHTML = html;
  if (window.renderTabsPresentacion) window.renderTabsPresentacion();
}

window.cambiarSabor = function(s) { saborActivo=s; renderTabs(); renderCatalogo(); try{ track('filter_sabor', { sabor: s }); }catch(e){} };

// Filtro por presentación (100g, 1kg…) — solo papas; se cruza con el sabor
function getPresentaciones() {
  const m = {};
  catalogo.filter(p => (p.categoria||'papa')==='papa' && p.tipo_venta===1)
    .forEach(p => { const v=(p.presentacion||'').trim(); if(v) m[v] = Math.min(m[v]!=null?m[v]:Infinity, Number(p.gramos)||0); });
  return Object.keys(m).sort((a,b)=> m[a]-m[b]);
}
window.renderTabsPresentacion = function() {
  const cont = document.getElementById('tabs-pres');
  if (!cont) return;
  if (saborActivo === '__bebidas') { cont.style.display='none'; cont.innerHTML=''; return; }
  cont.style.display='';
  const pres = getPresentaciones();
  if (pres.length <= 1) { cont.innerHTML=''; return; }
  let html = `<button class="tab tab-pres ${presentacionActiva===''?'active':''}" onclick="cambiarPresentacion('')">Todas</button>`;
  html += pres.map(p => `<button class="tab tab-pres ${p===presentacionActiva?'active':''}" onclick="cambiarPresentacion('${p}')">${p}</button>`).join('');
  cont.innerHTML = html;
};
window.cambiarPresentacion = function(p) { presentacionActiva = p; renderTabsPresentacion(); renderCatalogo(); try{ track('filter_presentacion', { presentacion: p }); }catch(e){} };

// ── Detalle de producto (pantalla casi completa, estilo Juntos+) ──────
window.verProducto = function(key) {
  const p = catalogo.find(x => String(x.id) === String(key));
  if (!p) return;
  detalleKey = String(key);
  const esBebida = (p.categoria || '') === 'bebida';
  const { precio, precioOriginal, descuento } = getPrecioConDescuento(p);

  const imgEl = document.getElementById('pd-img');
  const phEl  = document.getElementById('pd-img-ph');
  if (p.imagen_url) {
    imgEl.src = p.imagen_url; imgEl.alt = p.sabor || ''; imgEl.style.display = ''; phEl.style.display = 'none';
  } else {
    imgEl.style.display = 'none'; phEl.style.display = 'flex';
    phEl.querySelector('.emoji').innerHTML = ICONO_FOTO;  // constante propia, no texto del servidor
  }
  document.getElementById('pd-topttl').textContent = p.sabor || '';
  document.getElementById('pd-nombre').textContent = p.sabor || '';
  document.getElementById('pd-pres').textContent = p.presentacion || '';
  document.getElementById('pd-precio').innerHTML =
    (descuento > 0 ? `<span class="pd-precio-orig">$${precioOriginal}</span> ` : '') + `$${precio}`;
  const desc = (p.descripcion || '').trim();
  const descEl = document.getElementById('pd-desc');
  descEl.textContent = desc;
  descEl.style.display = desc ? '' : 'none';

  renderDetalleQty();
  const ov = document.getElementById('prod-detalle');
  ov.style.display = 'flex';
  requestAnimationFrame(() => ov.classList.add('open'));
  track('view_item', { sabor: p.sabor, presentacion: p.presentacion });
};
function renderDetalleQty() {
  const p = catalogo.find(x => String(x.id) === String(detalleKey));
  if (!p) return;
  const bottom = document.getElementById('pd-bottom');
  if (p.activo === false) { bottom.innerHTML = `<div class="pd-agotado">No disponible</div>`; return; }
  const it = carrito[String(detalleKey)];
  const qty = it ? it.qty : 0;
  // Venta por caja: lo que va en cajas se suma a «Llevas N» y se ofrece abajo
  const esBebidaPD = (p.categoria || '') === 'bebida';
  const { precio } = getPrecioConDescuento(p);
  const enCajas = CAJAS_PIEZAS.reduce((n, c) => n + ((carrito[`${detalleKey}-c${c}`] || {}).qty || 0), 0);
  const total = qty + enCajas;
  const conCajasPD = !esBebidaPD && esCanalCaja() && presentacionConCaja(p.presentacion);
  const uPD = conCajasPD ? unidadDe(String(detalleKey)) : 1;
  const nUPD = uPD === 1 ? qty : ((carrito[`${detalleKey}-c${uPD}`] || {}).cajas || 0);
  const cajasHTML = conCajasPD ? `
    <div class="pd-cajas-lbl">Cómo lo llevas</div>
    <div class="u-sel pd-usel" role="group" aria-label="Cómo lo llevas">
      ${[1, ...CAJAS_PIEZAS].map(n => {
        const enC = n === 1 ? qty : ((carrito[`${detalleKey}-c${n}`] || {}).cajas || 0);
        return `<button type="button" class="u-chip ${n === uPD ? 'sel' : ''}" aria-pressed="${n === uPD}" onclick="setUnidad('${detalleKey}',${n})">${n === 1 ? 'Pieza' : 'Caja ' + n}${enC > 0 ? `<span class="u-x">×${enC}</span>` : ''}</button>`;
      }).join('')}
    </div>` : '';
  const linea = total > 0
    ? `<div class="pd-cart-line">✓ Llevas ${total} en tu canasta${enCajas > 0 ? ` (${enCajas} en cajas)` : ''}</div>`
    : `<div class="pd-cart-line pd-cart-empty">Aún no lo agregas</div>`;
  const etiqueta = uPD > 1 ? `Agregar caja de ${uPD} · $${precioCaja(p, uPD)}` : (qty > 0 ? 'Agregar más' : 'Agregar');
  const ahorroHTML = uPD > 1 ? ahorroCajaHTML(p, uPD, 'pd-ahorro') : '';
  bottom.innerHTML = `
    ${linea}
    ${cajasHTML}
    ${ahorroHTML}
    <div class="pd-bottom-row">
      <div class="qty-ctrl pd-qty">
        <button class="qty-btn" onclick="detalleAgregar(-1)" aria-label="Quitar ${uPD > 1 ? 'una caja' : 'uno'}">−</button>
        <span class="qty-num pd-qty-num">${nUPD}${uPD > 1 ? `<small class="u-unit">caja${nUPD === 1 ? '' : 's'}</small>` : ''}</span>
        <button class="qty-btn" onclick="detalleAgregar(1)" aria-label="Agregar ${uPD > 1 ? 'una caja' : 'uno'}">+</button>
      </div>
      <button class="pd-add ${nUPD > 0 ? 'pd-add-sec' : ''}" onclick="detalleAgregar(1)">${etiqueta}</button>
    </div>`;
}
window.detalleAgregar = function(delta) { agregarUnidad(String(detalleKey), delta); renderDetalleQty(); };
window.detalleQty = function(delta) { cambiarQty(String(detalleKey), delta); renderDetalleQty(); };
window.cerrarProducto = function() {
  const ov = document.getElementById('prod-detalle');
  ov.classList.remove('open');
  setTimeout(() => { ov.style.display = 'none'; }, 250);
};
// ══════════════════════════════════
// SELECTOR DE CANAL (vendedor)
// ══════════════════════════════════
let canalVenta = 'consumidor'; // canal activo para ventas del vendedor

window.setCanalVenta = function(canal) {
  canalVenta = canal;
  // Guardar en sesión
  guardarSesion();

  // Actualizar botones
  ['consumidor','tienda','restaurante','mayorista'].forEach(c => {
    const btn = document.getElementById('canal-' + c);
    if (!btn) return;
    const activo = c === canal;
    btn.style.background    = activo ? 'var(--amarillo)' : 'var(--gris)';
    btn.style.color         = activo ? 'var(--negro)' : 'var(--suave)';
    btn.style.borderColor   = activo ? 'var(--amarillo)' : 'var(--gris3)';
  });

  // Re-renderizar catálogo con nuevos precios
  renderCatalogo();
};

window.mostrarCanalVenta = function mostrarCanalVenta() {
  const wrap = document.getElementById('canal-wrap');
  if (wrap && esVendedor) {
    wrap.style.display = 'block';
    // Aplicar canal guardado en sesión
    setCanalVenta(canalVenta || 'consumidor');
  }
}


window.setModo = function(m) {
  // Si entra/sale del modo interno, marcar globalmente
  const eraInterno = modoVenta === 'interno';
  modoVenta = m;

  if (m === 'interno') {
    // Activar marca: el resto del flujo lo respeta
    window._pedidoInterno = window._pedidoInterno || { tipo: '' };
  } else if (eraInterno) {
    // Salir del modo interno: limpiar marca
    window._pedidoInterno = null;
  }

  aplicarModoVenta();
  // Al cambiar de modo, re-renderizar catálogo para actualizar precios visibles
  if (typeof renderCatalogo === 'function') {
    try { renderCatalogo(); } catch(e) {}
  }
  // También actualizar mini-carrito para mostrar kg si modo interno
  if (typeof actualizarMiniCarrito === 'function') {
    try { actualizarMiniCarrito(); } catch(e) {}
  }
};

function aplicarModoVenta() {
  const m = modoVenta || 'pieza';
  const btnPieza   = document.getElementById('modo-pieza');
  const btnGranel  = document.getElementById('modo-granel');
  const btnInterno = document.getElementById('modo-interno');
  const vistaPieza  = document.getElementById('vista-pieza');
  const vistaGranel = document.getElementById('vista-granel');
  const tabs        = document.getElementById('tabs');
  const modoWrap    = document.getElementById('modo-wrap');
  const banner      = document.getElementById('banner-interno');

  // Para vendedor, siempre mostrar el selector de modo + el botón Interno
  if (esVendedor && modoWrap) modoWrap.classList.add('visible');
  if (esVendedor && btnInterno) btnInterno.style.display = '';

  if (btnPieza)   btnPieza.classList.toggle('active',   m==='pieza');
  if (btnGranel)  btnGranel.classList.toggle('active',  m==='granel');
  if (btnInterno) btnInterno.classList.toggle('active', m==='interno');

  // En modo interno mostramos el catálogo de pieza (mismas presentaciones, pero sin precios)
  // El modo se trata como pieza para efectos de UI principal
  const modoUI = (m === 'interno') ? 'pieza' : m;

  if (vistaPieza)  vistaPieza.style.display = modoUI==='pieza'?'block':'none';
  if (vistaGranel) vistaGranel.classList.toggle('visible', modoUI==='granel');
  if (tabs) tabs.style.display = modoUI==='granel' ? 'none' : 'flex';

  // Banner amarillo cuando modo=interno
  if (banner) banner.style.display = (m === 'interno') ? 'block' : 'none';

  // Marcar el body con clase para que el CSS pueda esconder precios fácilmente
  if (m === 'interno') document.body.classList.add('modo-interno');
  else                 document.body.classList.remove('modo-interno');
}

function ordenarProductos(arr) {
  const idx = s => { const i = SABORES_ORDER.indexOf(s); return i === -1 ? 999 : i; };
  return arr.slice().sort((a, b) => {
    const oa = (a.orden != null ? a.orden : 999), ob = (b.orden != null ? b.orden : 999);
    if (oa !== ob) return oa - ob;
    const ia = idx(a.sabor), ib = idx(b.sabor);
    if (ia !== ib) return ia - ib;
    return (Number(a.gramos) || 0) - (Number(b.gramos) || 0);
  });
}
window.renderCatalogo = function() {
  // v2.7: si tab activo es bebidas, mostrar bebidas; si es sabor de papa, filtrar por sabor
  let prods;
  if (saborActivo === '__bebidas') {
    prods = catalogo.filter(p => (p.categoria || '') === 'bebida');
  } else if (saborActivo === '__todos') {
    prods = catalogo.filter(p => p.tipo_venta===1 && (p.categoria||'papa')==='papa'
            && (presentacionActiva==='' || (p.presentacion||'').trim()===presentacionActiva));
  } else {
    prods = catalogo.filter(p => p.sabor===saborActivo && p.tipo_venta===1 && (p.categoria||'papa')==='papa'
            && (presentacionActiva==='' || (p.presentacion||'').trim()===presentacionActiva));
  }
  // Orden jerárquico: 'orden' (manual) → sabor de marca → gramos
  prods = ordenarProductos(prods);
  // Preservar modo de venta actual
  if (esVendedor) setTimeout(aplicarModoVenta, 0);
  document.getElementById('catalogo').innerHTML = prods.map(p => {
    const key  = `${p.id}`;
    const it   = carrito[key];
    const qty  = it ? it.qty : 0;
    const esBebida = (p.categoria || '') === 'bebida';
    const agotado  = p.activo === false;
    const { precio, precioOriginal, descuento } = getPrecioConDescuento(p);

    // Precios B2B visibles para vendedores (solo en papas, no bebidas)
    const preciosB2BHTML = (esVendedor && !esBebida) ? `
      <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:3px;" title="Solo referencia de precios">
        <div style="font-size:0.63rem;font-weight:700;background:#1a1a1a;color:#666;border-radius:4px;padding:2px 5px;pointer-events:none;user-select:none;">$${p.precio_tienda||0}</div>
        <div style="font-size:0.63rem;font-weight:700;background:#1a1a1a;color:#666;border-radius:4px;padding:2px 5px;pointer-events:none;user-select:none;">$${p.precio_restaurante||0}</div>
        ${Number(p.precio_mayorista) > 0 ? `<div style="font-size:0.63rem;font-weight:700;background:#1a1a1a;color:#666;border-radius:4px;padding:2px 5px;pointer-events:none;user-select:none;">Mayoreo $${p.precio_mayorista}</div>` : ''}
      </div>` : '';

    // Sin foto: el mismo placeholder de trazo para papas y bebidas
    const iconoFallback = ICONO_FOTO;
    const altText = esBebida ? p.sabor : `${p.sabor} ${p.presentacion}`;
    const imgHTML = p.imagen_url
      ? `<img class="prod-img" src="${p.imagen_url}" alt="${altText}" loading="lazy"${agotado?' style="filter:grayscale(1);"':''}>`
      : `<div class="prod-placeholder"${agotado?' style="filter:grayscale(1);"':''}><span class="emoji">${iconoFallback}</span><span class="prox">Foto pronto</span></div>`;

    const promoHTML = (descuento > 0 && !agotado)
      ? `<div class="promo-badge">Promo</div><div class="promo-pct">${descuento}%</div>` : '';

    // Para bebidas mostrar nombre completo, para papas el sabor + presentacion
    const nombreHTML = esBebida
      ? `<div class="prod-nombre">${p.sabor}</div>
         <div class="prod-pres">${[p.tipo_bebida, p.sabor_bebida, p.presentacion?p.presentacion.split(' · ').pop():null].filter(Boolean).join(' · ') || ''}</div>`
      : `<div class="prod-nombre">${p.sabor}</div>
         <div class="prod-pres">${p.presentacion}</div>`;

    // Si está agotado: badge + sin botón agregar
    const agotadoBadge = agotado ? `<div style="position:absolute;top:8px;right:8px;background:#5a1a1a;color:#ff8888;padding:3px 9px;border-radius:50px;font-size:0.62rem;font-weight:900;letter-spacing:0.5px;z-index:3;">AGOTADO</div>` : '';
    // Venta por caja (tienda/mayorista, papas de 50/100/250 g): se ELIGE cómo se
    // lleva (pieza o caja de 3/6/12) y un solo control agrega esa unidad. Antes
    // había tres botones que agregaban al instante y parecían una selección.
    const conCajas = !agotado && !esBebida && esCanalCaja() && presentacionConCaja(p.presentacion);
    const cajasTot = CAJAS_PIEZAS.reduce((n, c) => n + ((carrito[`${key}-c${c}`] || {}).cajas || 0), 0);
    const u = conCajas ? unidadDe(key) : 1;
    const nU = u === 1 ? qty : ((carrito[`${key}-c${u}`] || {}).cajas || 0);
    const cajasHTML = conCajas ? `
      <div class="u-sel" role="group" aria-label="Cómo lo llevas">
        ${[1, ...CAJAS_PIEZAS].map(n => {
          const enC = n === 1 ? qty : ((carrito[`${key}-c${n}`] || {}).cajas || 0);
          return `<button type="button" class="u-chip ${n === u ? 'sel' : ''}" aria-pressed="${n === u}" onclick="setUnidad('${key}',${n})">${n === 1 ? 'Pieza' : 'Caja ' + n}${enC > 0 ? `<span class="u-x">×${enC}</span>` : ''}</button>`;
        }).join('')}
      </div>
      ${u > 1 ? `<div class="u-precio">Caja de ${u} piezas · <b>$${precioCaja(p, u)}</b></div>${ahorroCajaHTML(p, u, 'u-ahorro')}` : ''}` : '';
    const ctrlHTML = agotado ? `
      <div style="margin-top:6px;font-size:0.74rem;color:#888;font-weight:700;text-align:center;padding:6px;background:#1a1a1a;border-radius:6px;">No disponible</div>
    ` : `
      ${nU===0
        ? `<div class="qty-ctrl"><button class="agregar-btn" onclick="agregarUnidad('${key}',1)">${u > 1 ? 'Agregar caja' : 'Agregar'}</button></div>`
        : `<div class="qty-ctrl">
        <button class="qty-btn" onclick="agregarUnidad('${key}',-1)" aria-label="Quitar ${u > 1 ? 'una caja' : 'uno'}">−</button>
        <span class="qty-num">${nU}${u > 1 ? `<small class="u-unit">caja${nU === 1 ? '' : 's'}</small>` : ''}</span>
        <button class="qty-btn" onclick="agregarUnidad('${key}',1)" aria-label="Agregar ${u > 1 ? 'una caja' : 'uno'}">+</button>
      </div>`}
    `;

    return `
      <div class="prod-card ${(qty>0||cajasTot>0)?'en-carrito':''}" style="${agotado?'opacity:0.6;':''}position:relative;">
        ${agotadoBadge}
        <div class="prod-img-wrap" onclick="verProducto('${key}')" style="cursor:pointer;">
          ${promoHTML}
          ${imgHTML}
        </div>
        <div class="prod-info">
          <div onclick="verProducto('${key}')" style="cursor:pointer;">${nombreHTML}</div>
          ${descuento > 0 && !agotado ? `<div class="prod-precio-orig">$${precioOriginal}</div>` : ''}
          <div class="prod-precio">$${precio}</div>
          ${preciosB2BHTML}
          ${cajasHTML}
          ${ctrlHTML}
        </div>
      </div>`;
  }).join('');

  // Si la lista está vacía, mostrar mensaje
  if (prods.length === 0) {
    const msg = saborActivo === '__bebidas'
      ? 'Aún no hay bebidas registradas. Da de alta una en la sección Productos.'
      : 'No hay productos para mostrar.';
    document.getElementById('catalogo').innerHTML = `<div style="grid-column:1/-1;text-align:center;color:var(--suave);padding:30px 20px;font-size:0.85rem;">${msg}</div>`;
  }
}

// ── Venta por caja (tienda y mayorista) ───────────────────────────────
// Cajas de un solo sabor; precio = precio del canal × piezas; conviven con las
// piezas sueltas. La línea se guarda como piezas (qty) y recuerda caja/cajas
// solo para mostrarlo: el servidor y el lote no saben de cajas.
const CAJAS_PIEZAS = [3, 6, 12];
// Comparativa de una caja: piezas × precio del canal (lo que costarían sueltas)
// frente al precio de la caja, y el ahorro. ahorro = 0 cuando no hay precio
// propio o no es menor: entonces no se enseña nada.
function ahorroCaja(prod, n) {
  const sueltas = getPrecioConDescuento(prod).precio * n;
  const caja = precioCaja(prod, n);
  const ahorro = Math.max(0, Math.round((sueltas - caja) * 100) / 100);
  return { sueltas, caja, ahorro, pct: sueltas > 0 ? Math.round(ahorro / sueltas * 100) : 0 };
}
function ahorroCajaHTML(prod, n, clase) {
  const a = ahorroCaja(prod, n);
  if (a.ahorro <= 0) return '';
  return `<div class="${clase}">${n} sueltas <s>$${a.sueltas}</s> · Ahorras <b>$${a.ahorro}</b> (${a.pct}%)</div>`;
}
// Precio de una caja de n piezas: el propio del producto (productos.precio_caja_n)
// o, si no lo tiene, piezas × precio del canal. Es el mismo cálculo que hace
// crear_pedido en el servidor; si difieren, el pedido vuelve con precio_cambiado.
function precioCaja(prod, n) {
  const propio = Number(prod['precio_caja_' + n]) || 0;
  if (propio > 0) return propio;
  return getPrecioConDescuento(prod).precio * n;
}
// Importe de una línea del carrito: granel por monto, caja por cajas × precio de
// caja, pieza por piezas × precio. Las líneas guardadas antes de hoy no traen
// precioCaja: se recompone con piezas × precio.
function subLinea(i) {
  if (i.tipoVenta === 'A granel') return i.monto;
  if (i.caja) return (i.cajas || 0) * (i.precioCaja || i.precio * i.caja);
  return i.qty * i.precio;
}
// «2 cajas de 12 (24 pz)» si la línea del pedido se vendió por caja; si no, «24×».
function cantidadConCajas(l) {
  const n = Number(l.cantidad) || 0, c = Number(l.piezas_por_caja) || 0;
  if (c > 0 && n > 0 && n % c === 0) { const k = n / c; return `${k} caja${k === 1 ? '' : 's'} de ${c} (${n} pz)`; }
  return `${n}×`;
}
function esCanalCaja() {
  const canal = esVendedor ? (canalVenta || '') : (tipoCliente || '');
  return canal === 'tienda' || canal === 'mayorista';
}
function presentacionConCaja(pres) { return /\b(50|100|250)\s*g\b/i.test(String(pres || '')); }
// Unidad elegida por producto en el catálogo: 1 (pieza) o 3/6/12 (caja). Solo
// vive en memoria: es cómo se está mirando la tarjeta, no lo que hay en el carrito.
const _unidadSel = {};
function unidadDe(key) { const u = _unidadSel[String(key)]; return CAJAS_PIEZAS.includes(u) ? u : 1; }
window.setUnidad = function(key, n) {
  _unidadSel[String(key)] = n;
  renderCatalogo();
  const ov = document.getElementById('prod-detalle');
  if (ov && ov.classList.contains('open') && String(detalleKey) === String(key)) renderDetalleQty();
};
window.agregarUnidad = function(key, delta) {
  const u = unidadDe(key);
  if (u === 1) cambiarQty(String(key), delta); else cambiarCaja(String(key), u, delta);
};

window.cambiarCaja = function(keyProd, piezas, delta) {
  const prod = catalogo.find(p => String(p.id) === keyProd);
  if (!prod || !CAJAS_PIEZAS.includes(piezas)) return;
  const key = `${keyProd}-c${piezas}`;
  const { precio, precioOriginal, descuento } = getPrecioConDescuento(prod);
  if (!carrito[key]) {
    carrito[key] = {
      key, keyProd, idProducto: prod.id, sabor: prod.sabor, presentacion: prod.presentacion,
      precio, precioOriginal, descuento,
      gramos: prod.gramos, tipoVenta: 'Por Pieza', caja: piezas, cajas: 0, qty: 0, precioCaja: precioCaja(prod, piezas),
    };
  }
  carrito[key].cajas = Math.max(0, (carrito[key].cajas || 0) + delta);
  carrito[key].qty = carrito[key].cajas * piezas;
  carrito[key].precioCaja = precioCaja(prod, piezas);
  if (carrito[key].cajas === 0) {
    delete carrito[key];
    if (delta < 0) { try { track('remove_from_cart', { sabor: prod.sabor, presentacion: prod.presentacion, caja: piezas }); } catch (e) {} }
  }
  if (delta > 0) {
    mostrarToast(`Caja de ${piezas} agregada`);
    track('add_to_cart', { sabor: prod.sabor, presentacion: prod.presentacion, caja: piezas, value: Number(precio) * piezas || 0, currency: 'MXN' });
  }
  actualizarBadge();
  renderCatalogo();
  if (document.getElementById('drawer').classList.contains('open')) renderDrawer();
};

window.cambiarQty = function(key, delta) {
  const prod = catalogo.find(p=>String(p.id)===key);
  if (!prod) return;
  const { precio, precioOriginal, descuento } = getPrecioConDescuento(prod);
  if (!carrito[key]) {
    carrito[key] = {
      key, idProducto:prod.id, sabor:prod.sabor, presentacion:prod.presentacion,
      precio, precioOriginal, descuento,
      gramos:prod.gramos, tipoVenta:'Por Pieza', qty:0
    };
  }
  carrito[key].qty = Math.max(0, carrito[key].qty+delta);
  if (carrito[key].qty===0) { if (delta<0) { try{ track('remove_from_cart', { sabor: prod.sabor, presentacion: prod.presentacion }); }catch(e){} } delete carrito[key]; }
  if (delta>0) { mostrarToast(); track('add_to_cart', { sabor: prod.sabor, presentacion: prod.presentacion, value: Number(precio) || 0, currency: 'MXN' }); }
  actualizarBadge();
  renderCatalogo();
  if (document.getElementById('drawer').classList.contains('open')) renderDrawer();
};

// GRANEL
window.calcGranel = function() {
  const monto = parseFloat(document.getElementById('granel-monto').value)||0;
  const sabor = document.getElementById('granel-sabor').value;
  const granel = catalogo.find(p=>p.sabor===sabor&&p.tipo_venta===2);
  const kg = granel ? (granel.precio_granel_kg||220) : 220;
  const grs = monto>0 ? Math.round((monto/kg)*1000) : 0;
  document.getElementById('granel-result').textContent = grs>0 ? `${grs}g de ${sabor||'—'}` : '— gramos';
};

window.agregarGranel = function() {
  const monto = parseFloat(document.getElementById('granel-monto').value)||0;
  const sabor = document.getElementById('granel-sabor').value;
  if (!monto||!sabor) { mostrarToast('Selecciona un sabor e ingresa el monto'); return; }
  const granel = catalogo.find(p=>p.sabor===sabor&&p.tipo_venta===2);
  const kg  = granel?(granel.precio_granel_kg||220):220;
  const grs = Math.round((monto/kg)*1000);
  const key = `granel-${sabor}-${Date.now()}`;
  carrito[key] = { key, idProducto:granel?.id||'', sabor, presentacion:'Granel',
    precio:monto, gramos:grs, tipoVenta:'A granel', qty:1, monto, precioKg:kg };
  mostrarToast();
  track('add_to_cart', { sabor, presentacion: 'Granel', value: Number(monto) || 0, currency: 'MXN' });
  actualizarBadge();
  // NO limpiar el monto para que el vendedor pueda agregar más rápido
  document.getElementById('granel-result').textContent=`${grs}g de ${sabor} agregado`;
  // Mantener el modo granel activo
  setTimeout(() => {
    document.getElementById('granel-result').textContent='— gramos';
  }, 2000);
  if (document.getElementById('drawer').classList.contains('open')) renderDrawer();
};

// ══════════════════════════════════
// CARRITO
// ══════════════════════════════════
function totalItems() { return Object.values(carrito).reduce((s,i)=>s+i.qty,0); }
function totalMonto() {
  return Object.values(carrito).reduce((s,i)=>{
    return s + subLinea(i);
  },0);
}
function totalGramos() {
  return Object.values(carrito).reduce((s,i)=>{
    if (i.tipoVenta === 'A granel') return s + (Number(i.gramos)||0);
    return s + (Number(i.qty)||0) * (Number(i.gramos)||0);
  },0);
}
function actualizarBadge() { document.getElementById('cart-badge').textContent=totalItems(); actualizarMiniCarrito(); guardarSesion(); }

function mostrarToast(mensaje) {
  const t=document.getElementById('toast');
  if (mensaje) t.textContent = mensaje;
  else t.textContent = '¡Guardado!';  // mensaje default solo si no se pasa nada
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),2400);
}

// Sustituto de alert(). Devuelve una promesa que se resuelve al cerrarse, asi
// que dentro de una funcion async se comporta igual que alert(): el codigo de
// despues espera. Esa espera es lo que un toast NO puede dar -dura 2,4s y se
// va-, y estos mensajes llevan cifras y listas que hay que poder leer.
//
// Se cierra con el boton, con Escape o tocando fuera. Nunca se cierra solo:
// si un mensaje se puede ignorar, es un toast, no un aviso.
const SALTO = String.fromCharCode(10);
let _avisoCerrarActual = null;
let _avisoApertura = 0;   // cuenta aperturas: el cierre viejo no oculta al cuadro nuevo
// Un solo cuadro para dos usos: avisar() -un boton, resuelve al cerrarse- y
// confirmar() -dos botones, resuelve true/false-. Escape y tocar fuera valen
// «cancelar» en los dos: el cuadro nunca acepta nada por accidente.
function _abrirDialogo(opciones, conCancelar) {
  const o = opciones || {};
  return new Promise(function(resolver) {
    // Si ya habia uno abierto se cierra primero, para no apilar dos cajas ni
    // dejar dos promesas colgando.
    if (_avisoCerrarActual) { try { _avisoCerrarActual(); } catch (_e) {} }

    const fondo    = document.getElementById('aviso-fondo');
    const caja     = document.getElementById('aviso');
    const boton    = document.getElementById('aviso-ok');
    const cancelar = document.getElementById('aviso-cancelar');
    const botones  = document.getElementById('aviso-botones');
    const titulo   = document.getElementById('aviso-titulo');
    const cuerpo   = document.getElementById('aviso-cuerpo');
    // Si el marcado no esta (una version cacheada por el service worker, por
    // ejemplo), no se pierde la pregunta: se cae a los nativos antes que callar.
    if (!fondo || !caja || !boton || (conCancelar && !cancelar)) {
      const texto = `${o.titulo||''}

${o.cuerpo||''}`.trim();
      let r = true;
      try { if (conCancelar) r = confirm(texto); else alert(texto); } catch (_e) {}
      resolver(conCancelar ? !!r : undefined); return;
    }

    // textContent y no innerHTML: el cuerpo lleva texto que viene del servidor
    // -nombre de producto, mensaje de error- y no debe poder inyectar marcado.
    titulo.textContent = o.titulo || (conCancelar ? '¿Seguro?' : 'Aviso');
    cuerpo.textContent = o.cuerpo || '';
    cuerpo.hidden = !o.cuerpo;
    boton.textContent = o.boton || o.aceptar || (conCancelar ? 'Aceptar' : 'Entendido');
    if (cancelar) { cancelar.textContent = o.cancelar || 'Cancelar'; cancelar.hidden = !conCancelar; }
    if (botones) botones.classList.toggle('dos', !!conCancelar);
    caja.classList.toggle('peligro', !!(conCancelar && o.peligroso));

    const teniaFoco = document.activeElement;
    const miApertura = ++_avisoApertura;
    caja.hidden = false;
    let resultado = false;

    function cerrar() {
      fondo.classList.remove('visible');
      caja.classList.remove('open');
      boton.removeEventListener('click', aceptar);
      if (cancelar) cancelar.removeEventListener('click', cerrar);
      fondo.removeEventListener('click', cerrar);
      document.removeEventListener('keydown', porTecla);
      // El marcado se vuelve a ocultar cuando termina la transicion, no antes,
      // para que no desaparezca de golpe.
      // Solo si nadie abrio otro cuadro mientras tanto: si no, este temporizador
      // escondia al recien abierto (visto con la pestaña en segundo plano).
      setTimeout(function(){ if (_avisoApertura === miApertura) caja.hidden = true; }, 320);
      try { if (teniaFoco && teniaFoco.focus) teniaFoco.focus(); } catch (_e) {}
      _avisoCerrarActual = null;
      resolver(conCancelar ? resultado : undefined);
    }
    function aceptar() { resultado = true; cerrar(); }
    function porTecla(e) {
      if (e.key === 'Escape') { e.preventDefault(); cerrar(); return; }
      // Trampa de foco: con dos botones el tabulador alterna entre ellos; con
      // uno se queda. Sin esto se pasearia por el formulario que hay debajo.
      if (e.key === 'Tab') {
        e.preventDefault();
        const alterno = (conCancelar && cancelar && document.activeElement === boton) ? cancelar : boton;
        try { alterno.focus(); } catch (_e) {}
      }
    }

    _avisoCerrarActual = cerrar;
    boton.addEventListener('click', aceptar);
    if (cancelar) cancelar.addEventListener('click', cerrar);
    fondo.addEventListener('click', cerrar);
    document.addEventListener('keydown', porTecla);

    // Un fotograma de margen para que la transicion tenga desde donde salir.
    requestAnimationFrame(function(){
      fondo.classList.add('visible');
      caja.classList.add('open');
      // En una accion peligrosa el foco arranca en «cancelar»: Enter no borra nada.
      const primero = (conCancelar && o.peligroso && cancelar) ? cancelar : boton;
      setTimeout(function(){ try { primero.focus(); } catch (_e) {} }, 60);
    });
  });
}
window.avisar    = function(opciones) { return _abrirDialogo(opciones, false); };
window.confirmar = function(opciones) { return _abrirDialogo(opciones, true); };

// #3: aviso inmediato si el vendedor pone su propio número como teléfono del cliente
// #4: renumeración dinámica de los encabezados de sección (omite las ocultas)
function renumerarSecciones() {
  const orden = ['cliente','entrega','direccion','pago','fecha'];
  let n = 0;
  orden.forEach(key => {
    const span = document.getElementById('secnum-' + key);
    if (!span) return;
    const visible = span.offsetParent !== null; // null si algún ancestro tiene display:none
    if (visible) { n++; span.textContent = String(n); }
  });
}

window.validarTelClienteVsVendedor = function(el) {
  const aviso = document.getElementById('f-tel-cliente-aviso');
  if (!el) return;
  const tel = String(el.value || '').replace(/\D/g, '').slice(-10);
  const telVend = String(vendedorInfo?.telefono || window._telVendedor || telefonoVerif || '').replace(/\D/g, '').slice(-10);
  const choca = esVendedor && tel.length === 10 && telVend && tel === telVend;
  el.style.borderColor = choca ? '#ff5a5a' : '';
  if (aviso) aviso.style.display = choca ? 'block' : 'none';
};

window.abrirCarrito = function() {
  renderDrawer();
  // "Tarjeta terminal" SOLO para el perfil Mostrador: es quien tiene la
  // terminal física delante. Antes se mostraba a cualquier vendedor, y un
  // vendedor en ruta no puede cobrar con ella.
  const _bt = document.getElementById('pago-terminal');
  const _esMostrador = esVendedor &&
    String(vendedorInfo?.rol || '').toLowerCase().trim() === 'mostrador';
  if (_bt) _bt.style.display = _esMostrador ? '' : 'none';
  document.getElementById('drawer').classList.add('open');
  document.getElementById('overlay').classList.add('visible');
  setTimeout(initMaps, 300);
  // Cargar fecha de entrega sugerida
  cargarFechaEntrega();
  // GA4: inicio de checkout
  try { track('begin_checkout', { currency: 'MXN', value: (typeof totalMonto === 'function' ? Number(totalMonto()) || 0 : 0) }); } catch (_e) {}
};

async function cargarFechaEntrega() {
  const wrap = document.getElementById('fecha-entrega-wrap');
  const lbl  = document.getElementById('fecha-entrega-lbl');
  const msg  = document.getElementById('fecha-entrega-msg');
  const editor = document.getElementById('fecha-entrega-editor');
  const inp     = document.getElementById('f-fecha-entrega');
  if (!wrap || !lbl) return;

  // Editor visible para todos: el cliente puede ajustar a una fecha igual o posterior
  const puedeEditar = true;
  if (editor) editor.style.display = puedeEditar ? 'block' : 'none';

  // Helper para setear el input prellenado
  const setInputFecha = (yyyymmdd) => {
    if (inp && yyyymmdd) inp.value = yyyymmdd;
    // Mínimo = la fecha sugerida: solo se permite esa fecha o posterior (nunca antes)
    if (inp) {
      const hoyStr = fechaCDMX();
      inp.min = yyyymmdd || hoyStr;
    }
  };

  // Para mostrador: fecha de entrega = HOY (puede editar si quiere otra cosa)
  const esMostrador = esVendedor && vendedorInfo?.rol === 'Mostrador';
  if (esMostrador) {
    const hoy = new Date();
    const hoyStr = fechaCDMX(hoy);
    wrap.style.display = 'block';
    lbl.textContent = hoy.toLocaleDateString('es-MX', {weekday:'long', day:'numeric', month:'long'});
    msg.textContent = 'Entrega inmediata — punto de venta';
    window._fechaEntrega = hoyStr;
    setInputFecha(hoyStr);
    return;
  }

  try {
    const res = await supabaseCall('POST', 'rpc/obtener_fecha_entrega', { p_data: telefonoVerif ? { telefono: telefonoVerif } : {} });
    if (res && res.ok) {
      wrap.style.display = 'block';
      // fechaDisplay lo arma Postgres con TO_CHAR y el locale del servidor (inglés):
      // se prefiere la fecha ISO y se escribe aquí en español.
      const fSug = res.fecha ? new Date(res.fecha + 'T12:00:00') : null;
      lbl.textContent  = (fSug && !isNaN(fSug))
        ? fSug.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' })
        : (res.fechaDisplay || 'El equipo confirmará la fecha');
      msg.textContent  = res.msg || '';
      window._fechaEntrega = res.fecha;
      if (res.fecha) setInputFecha(res.fecha);
    }
  } catch(e) { console.log('Sin fecha entrega:', e.message); }
  if (typeof renumerarSecciones === 'function') renumerarSecciones();
}

// Cuando vendedor cambia la fecha en el input
window.onCambioFechaEntrega = function(yyyymmdd) {
  if (!yyyymmdd) return;
  window._fechaEntrega = yyyymmdd;
  // Actualizar el label visible para confirmar al usuario
  const lbl = document.getElementById('fecha-entrega-lbl');
  const msg = document.getElementById('fecha-entrega-msg');
  if (lbl) {
    // Parsear como local (mediodía) para evitar off-by-one
    const d = new Date(yyyymmdd + 'T12:00:00');
    lbl.textContent = d.toLocaleDateString('es-MX',{weekday:'long',day:'numeric',month:'long'});
  }
  if (msg) msg.textContent = 'Fecha de entrega ajustada';
};
// Helper: resetea header al estado del vendedor logueado y limpia clienteActual.
// Se invoca al cerrar carrito sin pedido, después de un pedido exitoso, o cuando
// queremos asegurarnos de que el header no muestre el cliente del pedido anterior.
function resetHeaderVendedor() {
  if (!esVendedor) return;
  clienteActual = null;
  _modoCliente  = null;
  const hNombre = document.getElementById('h-nombre');
  const hTipo   = document.getElementById('h-tipo');
  if (hNombre) hNombre.textContent = vendedorInfo?.nombre || 'Vendedor';
  if (hTipo)   hTipo.textContent   = vendedorInfo?.rol    || 'Vendedor';
}

window.cerrarCarrito = function() {
  document.getElementById('drawer').classList.remove('open');
  document.getElementById('overlay').classList.remove('visible');
  // Si es vendedor y había seleccionado un cliente, limpiar para no contaminar el header
  if (esVendedor && _modoCliente === 'existente') {
    resetHeaderVendedor();
  }
};

function renderDrawer() {
  const items = Object.values(carrito);
  const ci    = document.getElementById('cart-items');
  const tr    = document.getElementById('cart-total-row');
  const fp    = document.getElementById('form-pedido');
  const mm    = document.getElementById('min-msg');
  const monto = totalMonto();
  const min   = MINIMOS[tipoCliente]||0;

  const esInternoModo = (modoVenta === 'interno');

  if (items.length===0) {
    ci.innerHTML='<div class="cart-empty"><span>' + ICONO_CARRITO + '</span>Tu carrito está vacío.<br>¡Elige tus papas!</div>';
    tr.style.display='none'; fp.style.display='none'; mm.classList.remove('visible');
    return;
  }

  // Items
  ci.innerHTML = items.map(i => {
    const sub = subLinea(i);
    const grsLinea = i.tipoVenta==='A granel'
      ? (Number(i.gramos)||0)
      : (Number(i.qty)||0) * (Number(i.gramos)||0);
    const esPieza = i.tipoVenta !== 'A granel';
    const desc = !esPieza
      ? `${i.gramos}g · $${i.monto}`
      : i.caja ? `Caja de ${i.caja} · ${i.qty} pz · $${i.precioCaja || i.precio * i.caja} por caja` : `$${i.precio} c/u`;
    const descInterno = !esPieza
      ? `${i.gramos}g a granel`
      : `${i.gramos}g c/u`;
    // Paso 4 (II): la cantidad se cambia desde el carrito (solo piezas; el
    // granel se quita entero). cambiarQty ya redibuja el cajón si está abierto.
    const qtyHTML = i.canje
      ? `<div class="ci-qty"><button class="ci-btn" onclick="cambiarCanje('${i.idProducto}',-1)" aria-label="Quitar una pieza canjeada">−</button><span class="ci-num">${i.qty}</span><button class="ci-btn" onclick="cambiarCanje('${i.idProducto}',1)" aria-label="Canjear otra pieza">+</button></div>`
      : i.caja
      ? `<div class="ci-qty"><button class="ci-btn" onclick="cambiarCaja('${i.keyProd}',${i.caja},-1)" aria-label="Quitar una caja">−</button><span class="ci-num">${i.cajas} caja${i.cajas === 1 ? '' : 's'}</span><button class="ci-btn" onclick="cambiarCaja('${i.keyProd}',${i.caja},1)" aria-label="Agregar una caja">+</button></div>`
      : esPieza
      ? `<div class="ci-qty"><button class="ci-btn" onclick="cambiarQty('${i.key}',-1)" aria-label="Quitar uno">−</button><span class="ci-num">${i.qty}</span><button class="ci-btn" onclick="cambiarQty('${i.key}',1)" aria-label="Agregar uno">+</button></div>`
      : '';

    return `<div class="cart-item">
      ${saborDot(i.sabor, 12)}
      <div class="cart-item-info">
        <div class="cart-item-nom">${i.sabor} · ${i.presentacion}</div>
        <div class="cart-item-sub">${i.canje ? `Canje · ${i.puntos} pts c/u` : esInternoModo ? descInterno : desc}</div>
        ${qtyHTML}
      </div>
      <span class="cart-item-precio">${i.canje ? `${(i.qty * i.puntos).toLocaleString('es-MX')} pts` : esInternoModo ? `${(grsLinea/1000).toFixed(3)}kg` : `$${sub}`}</span>
      <button class="del-btn" onclick="eliminarItem('${i.key}')" aria-label="Quitar del pedido">${ICONO_X}</button>
    </div>`;
  }).join('');
  // Canje: un pedido nunca es solo de canje (crear_pedido lo rechaza con canje_sin_compra).
  if (lineasCanje().length && !items.some(i => !i.canje)) {
    ci.innerHTML += '<div class="cart-aviso-canje">Para canjear puntos, agrega al menos un producto comprado.</div>';
  } else if (lineasCanje().length) {
    ci.innerHTML += `<div class="cart-aviso-canje">Puntos usados en este pedido: ${puntosCanjeCarrito().toLocaleString('es-MX')}</div>`;
  }

  // Selector de tipo de pedido interno (solo cuando modo=interno)
  if (esInternoModo) {
    const tipoActual = window._pedidoInterno?.tipo || '';
    const TIPOS = [
      { id:'sampling', label:'Sampling' },
      { id:'consumo',  label:'Consumo' },
      { id:'demo',     label:'Demo' },
      { id:'regalo',   label:'Regalo' },
      { id:'bonificacion', label:'Bonificación' },
      { id:'merma',    label:'Merma' },
    ];
    const selectorHTML = `
      <div style="background:linear-gradient(135deg,#2a1f00,#1a1200);border:1px dashed rgba(255,210,0,0.4);border-radius:12px;padding:12px;margin:6px 0 10px;">
        <div style="font-size:0.7rem;font-weight:900;color:var(--amarillo);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Motivo del pedido interno *</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
          ${TIPOS.map(t => {
            const sel = t.id === tipoActual;
            return `<button onclick="setTipoInterno('${t.id}')" style="
              background:${sel?'var(--amarillo)':'var(--gris2)'};
              border:1px solid ${sel?'var(--amarillo)':'var(--gris3)'};
              border-radius:8px;padding:9px 6px;
              font-family:'Inter',sans-serif;font-weight:800;font-size:0.78rem;
              color:${sel?'var(--negro)':'var(--blanco)'};cursor:pointer;text-align:left;">
              ${t.label}
            </button>`;
          }).join('')}
        </div>
        ${!tipoActual ? '<div style="font-size:0.7rem;color:var(--rojo);margin-top:6px;font-weight:700;">Selecciona un motivo antes de confirmar</div>' : ''}
      </div>
    `;
    ci.insertAdjacentHTML('afterend', `<div id="selector-tipo-interno-wrap">${selectorHTML}</div>`);
    // Si ya existía un wrapper anterior, asegurar que solo quede el nuevo
    const wraps = document.querySelectorAll('#selector-tipo-interno-wrap');
    if (wraps.length > 1) {
      for (let i = 0; i < wraps.length - 1; i++) wraps[i].remove();
    }
  } else {
    // Limpiar selector si no es modo interno
    const w = document.getElementById('selector-tipo-interno-wrap');
    if (w) w.remove();
  }

  // Total: en modo interno mostramos kg
  const totalLabelEl = document.getElementById('cart-total-lbl');
  const totalMntEl   = document.getElementById('cart-total-mnt');

  // v2.7: Mostrar campo de cupón solo cuando NO es modo interno y hay items
  const cuponWrap = document.getElementById('cupon-wrap');
  if (cuponWrap) cuponWrap.style.display = (esInternoModo || items.length === 0) ? 'none' : 'block';

  const subRow = document.getElementById('cart-subtotal-row');
  const descRow = document.getElementById('cart-descuento-row');

  if (esInternoModo) {
    if (totalLabelEl) totalLabelEl.textContent = 'Total volumen';
    totalMntEl.textContent = `${(totalGramos()/1000).toFixed(3)} kg`;
    if (subRow) subRow.style.display = 'none';
    if (descRow) descRow.style.display = 'none';
  } else {
    // Calcular descuento del cupón si está aplicado
    const descCupon = calcularDescuentoCupon(monto);
    // v2.10: costo envío si eligió paquetería
    const costoEnv = (metodoEntrega === 'paqueteria' && tipoCliente === 'consumidor') ? COSTO_PAQUETERIA : 0;
    // v2.10: si cupón es envío_gratis, descontamos el envío
    const descEnvio = calcularDescuentoEnvio(costoEnv);
    const totalFinal = Math.max(0, monto - descCupon + costoEnv - descEnvio);

    if (descCupon > 0 || costoEnv > 0 || descEnvio > 0) {
      if (subRow) {
        subRow.style.display = 'flex';
        document.getElementById('cart-subtotal-mnt').textContent = `$${monto.toLocaleString('es-MX')}`;
      }
      if (descRow) {
        if (descCupon > 0) {
          descRow.style.display = 'flex';
          document.getElementById('cart-descuento-lbl').textContent = `Descuento (${_cuponEnCarrito.codigo})`;
          document.getElementById('cart-descuento-mnt').textContent = `-$${descCupon.toLocaleString('es-MX')}`;
        } else {
          descRow.style.display = 'none';
        }
      }
      // Mostrar línea de envío si aplica
      let envRow = document.getElementById('cart-envio-row');
      if (!envRow && costoEnv > 0 && subRow) {
        envRow = document.createElement('div');
        envRow.id = 'cart-envio-row';
        envRow.style.cssText = subRow.style.cssText || 'display:flex;justify-content:space-between;font-size:0.82rem;color:var(--suave);padding:4px 0;';
        subRow.parentNode.insertBefore(envRow, totalLabelEl?.parentNode || tr);
      }
      if (envRow) {
        envRow.style.display = costoEnv > 0 ? 'flex' : 'none';
        if (costoEnv > 0) envRow.innerHTML = `<span>Envío paquetería</span><span style="color:var(--amarillo);">+$${costoEnv}</span>`;
      }
      // v2.10: línea de descuento por cupón envío gratis
      let envDescRow = document.getElementById('cart-envio-desc-row');
      if (!envDescRow && descEnvio > 0 && subRow) {
        envDescRow = document.createElement('div');
        envDescRow.id = 'cart-envio-desc-row';
        envDescRow.style.cssText = subRow.style.cssText || 'display:flex;justify-content:space-between;font-size:0.82rem;color:var(--suave);padding:4px 0;';
        subRow.parentNode.insertBefore(envDescRow, totalLabelEl?.parentNode || tr);
      }
      if (envDescRow) {
        envDescRow.style.display = descEnvio > 0 ? 'flex' : 'none';
        if (descEnvio > 0) envDescRow.innerHTML = `<span>Cupón envío gratis (${_cuponEnCarrito.codigo})</span><span style="color:#4caf50;">-$${descEnvio.toLocaleString('es-MX')}</span>`;
      }

      if (totalLabelEl) {
        if (descEnvio > 0) totalLabelEl.textContent = 'Total con cupón envío';
        else if (costoEnv > 0) totalLabelEl.textContent = 'Total con envío';
        else totalLabelEl.textContent = 'Total con cupón';
      }
      totalMntEl.textContent = `$${totalFinal.toLocaleString('es-MX')}`;
    } else {
      if (subRow) subRow.style.display = 'none';
      if (descRow) descRow.style.display = 'none';
      const envRow = document.getElementById('cart-envio-row');
      if (envRow) envRow.style.display = 'none';
      const envDescRow = document.getElementById('cart-envio-desc-row');
      if (envDescRow) envDescRow.style.display = 'none';
      if (totalLabelEl) totalLabelEl.textContent = 'Total';
      totalMntEl.textContent = `$${monto}`;
    }
  }
  tr.style.display='flex';

  // Calcular ahorro total
  const ahorro = Object.values(carrito).reduce((s,i) => {
    if (i.tipoVenta==='A granel'||!i.precioOriginal) return s;
    return s + (i.precioOriginal - i.precio) * i.qty;
  }, 0);
  const ahorroEl = document.getElementById('cart-ahorro');
  if (ahorro > 0) {
    ahorroEl.style.display='block';
    ahorroEl.innerHTML=`<strong>¡Ahorraste $${ahorro}!</strong> con tus descuentos activos`;
  } else {
    ahorroEl.style.display='none';
  }

  // Mínimos: advertencia visible pero permitimos continuar siempre.
  // El vendedor puede tener buenas razones para registrar pedidos pequeños
  // (cliente que apenas inicia, prueba de producto, etc.).
  const faltMay = validarMinimosMayoreo();
  if (faltMay.length) {
    mm.innerHTML = '<strong>Mínimo de mayoreo:</strong> ' +
      faltMay.map(f => `${f.presentacion} ${f.actual}/${f.minimo}`).join(' · ') +
      '. Agrega más de esas presentaciones para confirmar.';
    mm.classList.add('visible');
    mm.classList.add('warning');
  } else if (min>0 && monto<min) {
    mm.innerHTML = `<strong>Sugerido ${TIPO_LABELS[tipoCliente]}: $${min}</strong> (faltan $${min-monto}). Puedes continuar igual.`;
    mm.classList.add('visible');
    mm.classList.add('warning');
  } else {
    mm.classList.remove('visible');
    mm.classList.remove('warning');
  }
  // El form siempre se muestra (ya no se oculta por mínimo no cubierto)
  fp.style.display='block';

  // v2.10: Visibilidad bloque entrega (solo consumidor — B2B coordina con vendedor)
  // Se reaplica cada vez que se abre el carrito por si tipoCliente cambió
  const wrapEntrega = document.getElementById('entrega-wrap');
  if (wrapEntrega) {
    if (tipoCliente === 'consumidor' && !esInternoModo) {
      wrapEntrega.style.display = 'block';
      if (typeof actualizarVisibilidadOptIn === 'function') actualizarVisibilidadOptIn();
      // v2.11.1: También mostrar el selector de vendedor (si está en "coordinar")
      const selectorWrap = document.getElementById('vendedor-selector-wrap');
      if (selectorWrap && metodoEntrega === 'coordinar') {
        selectorWrap.style.display = 'block';
        // Si no hay vendedor cacheado, intentar precargar desde historial
        if (!_contactoVendedor) {
          if (typeof precargarContactoDesdeHistorial === 'function') precargarContactoDesdeHistorial();
        } else {
          if (typeof pintarVendedorSeleccionado === 'function') pintarVendedorSeleccionado();
        }
      }
    } else {
      wrapEntrega.style.display = 'none';
      metodoEntrega = 'coordinar';  // forzar coordinar para B2B / interno
    }
  }

  // v2.10: Actualizar estado del botón paquetería según monto del carrito
  if (typeof actualizarEstadoPaqueteria === 'function') actualizarEstadoPaqueteria();

  // #4: renumerar secciones visibles (interno muestra 1·2·3 sin huecos)
  setTimeout(renumerarSecciones, 0);

    // Mostrar buscador de cliente para vendedores en visita (no mostrador)
    const buscadorWrap = document.getElementById('buscador-cliente-wrap');
    if (buscadorWrap) {
      const esVendedorVisita = esVendedor && vendedorInfo?.rol !== 'Mostrador';
      buscadorWrap.style.display = esVendedorVisita ? 'block' : 'none';
      if (esVendedorVisita) {
        // Resetear selección al abrir carrito
        _modoCliente = null;
        ['existente','nuevo'].forEach(m => {
          const btn = document.getElementById('btn-cliente-' + m);
          if (btn) { btn.style.borderColor='var(--gris3)'; btn.style.color='var(--suave)'; btn.style.background='var(--gris)'; }
        });
        document.getElementById('paso-buscar-cliente').style.display = 'none';
        document.getElementById('btn-editar-cliente-wrap').style.display = 'none';
        bloquearCamposCliente(false);
      }
    }

    // Pre-llenar con datos del punto de venta si es mostrador
    const esMostradorDrawer = esVendedor && vendedorInfo?.rol === 'Mostrador';
    if (esMostradorDrawer) {
      const fNombre = document.getElementById('f-nombre');
      const fDir    = document.getElementById('f-dir');
      const fCp     = document.getElementById('f-cp');
      if (!fNombre.value) fNombre.value = vendedorInfo.nombre || 'Crunchy Paps Local';
      if (!fDir.value && vendedorInfo.direccionPV) fDir.value = vendedorInfo.direccionPV;
      if (!fCp.value && vendedorInfo.cpPV) {
        fCp.value = vendedorInfo.cpPV;
        buscarCP(vendedorInfo.cpPV);
      }
    }

    // Pre-llenar con datos del cliente existente
    if (clienteActual) {
      const fNombre = document.getElementById('f-nombre');
      const fCp     = document.getElementById('f-cp');
      // Solo pre-llenar si el campo está vacío
      if (!fNombre.value && clienteActual.nombre) {
        fNombre.value = clienteActual.nombre;
      }
      // B2B: el nombre del negocio también debe precargarse (si no, el checklist bloquea)
      if (tipoCliente === 'tienda' || tipoCliente === 'restaurante' || tipoCliente === 'mayorista') {
        const fNeg = document.getElementById('f-negocio');
        if (fNeg && !fNeg.value) fNeg.value = clienteActual.negocio || clienteActual.nombre || '';
      }
      if (!fCp.value && clienteActual.cp) {
        fCp.value = String(clienteActual.cp).padStart(5,'0');
        buscarCP(clienteActual.cp);
        // Pre-llenar colonia/dirección cuando el combo ya cargó (reintentos, no espera fija)
        seleccionarColoniaCuandoCargue(clienteActual.colonia, () => {
          if (clienteActual.direccion && !document.getElementById('f-dir').value) {
            document.getElementById('f-dir').value = clienteActual.direccion;
          }
          // Fix coordenadas (Opción 1): geocodificar en segundo plano la dirección
          // precargada para que el pedido siempre tenga coordenada, sin que el cliente toque el mapa
          if (!dirCoords) { asegurarCoordenadasDesdeFormulario().catch(() => {}); }
          // Mostrar alerta de zona con CP pre-rellenado
          const zonaPreview = detectarZona(String(clienteActual.cp).padStart(5,'0'));
          mostrarAlertaZona(zonaPreview);
          if (typeof actualizarChecklistFaltantes === 'function') actualizarChecklistFaltantes();
        });
      }
    }

    // Puntos
    if (puntos>0) {
      document.getElementById('puntos-chip').style.display='flex';
      document.getElementById('puntos-val').textContent=puntos;
    }

    // v2.11.1: Actualizar avisos de validaciones faltantes
    if (typeof actualizarChecklistFaltantes === 'function') actualizarChecklistFaltantes();
}

// Selecciona la colonia cuando el combo YA tiene opciones (reintenta cada 300ms hasta 8s).
// Cura la condición de carrera del prefill: antes se esperaba un tiempo fijo y en redes
// lentas el combo seguía vacío, dejando la colonia sin cargar aunque el cliente la tuviera guardada.
window.seleccionarColoniaCuandoCargue = function(colonia, despues, _intento) {
  const n = _intento || 0;
  const sel = document.getElementById('f-colonia');
  const listo = sel && sel.options && sel.options.length > 1;
  if (listo) {
    if (colonia) {
      for (let opt of sel.options) {
        if (opt.value === colonia) { sel.value = colonia; break; }
      }
    }
    if (typeof despues === 'function') despues();
    return;
  }
  if (n >= 26) { if (typeof despues === 'function') despues(); return; } // ~8s: rendirse con gracia
  setTimeout(() => seleccionarColoniaCuandoCargue(colonia, despues, n + 1), 300);
};

// v2.11.1: Mostrar al cliente qué falta para confirmar pedido (en tiempo real)
// Solo validamos lo ESPECÍFICO del flujo nuevo (entrega + B2B).
// El nombre/dirección/CP los maneja la validación tradicional del botón.
window.actualizarChecklistFaltantes = function() {
  const cont = document.getElementById('checkout-faltantes');
  const btn = document.getElementById('btn-confirmar');
  if (!cont || !btn) return;

  const faltantes = [];

  // Solo evaluar si hay items en el carrito
  if (Object.keys(carrito).length === 0) {
    cont.style.display = 'none';
    return;
  }

  // 1. Para consumidor: si elige paquetería, validar mínimo
  if (tipoCliente === 'consumidor' && metodoEntrega === 'paqueteria') {
    const subtotal = totalMonto();
    if (subtotal < MIN_PAQUETERIA) {
      faltantes.push({ campo: 'min', msg: `Para envío por paquetería se requiere mínimo $${MIN_PAQUETERIA} (faltan $${MIN_PAQUETERIA - subtotal})` });
    }
  }

  // 2. Para consumidor: si elige coordinar, debe seleccionar contacto.
  //    NO aplica en modo interno (sampling/consumo/etc.: no hay entrega que coordinar)
  //    ni a pedidos levantados por vendedor (el vendedor ES el contacto).
  const _esInterno = (modoVenta === 'interno') || !!(window._pedidoInterno && window._pedidoInterno.tipo);
  if (tipoCliente === 'consumidor' && metodoEntrega === 'coordinar' && !_contactoVendedor && !_esInterno && !esVendedor) {
    faltantes.push({ campo: 'contacto', msg: 'Elige a tu contacto Crunchy (o "Cualquiera")' });
  }

  // 3. Nombre del negocio requerido para B2B
  if (tipoCliente === 'tienda' || tipoCliente === 'restaurante' || tipoCliente === 'mayorista') {
    const negocio = (document.getElementById('f-negocio')?.value || '').trim();
    if (!negocio) faltantes.push({ campo: 'negocio', msg: 'Nombre del ' + (tipoCliente === 'tienda' ? 'establecimiento' : (tipoCliente === 'mayorista' ? 'negocio' : 'restaurante')) });
  }

  if (faltantes.length === 0) {
    cont.style.display = 'none';
    btn.disabled = false;
    btn.style.opacity = '1';
    btn.style.cursor = 'pointer';
    btn.innerHTML = 'Confirmar pedido';
  } else {
    cont.style.display = 'block';
    cont.innerHTML = `
      <div style="font-weight:800;color:#ffa500;margin-bottom:6px;font-size:0.86rem;">Falta poco para confirmar tu pedido:</div>
      <ul style="margin:0;padding-left:20px;color:#ffd699;">
        ${faltantes.map(f => `<li style="margin:3px 0;">${f.msg}</li>`).join('')}
      </ul>
    `;
    btn.disabled = true;
    btn.style.opacity = '0.55';
    btn.style.cursor = 'not-allowed';
    btn.innerHTML = `Completa lo de arriba (${faltantes.length} ${faltantes.length === 1 ? 'pendiente' : 'pendientes'})`;
  }
};

window.eliminarItem = function(key) {
  try { var _it = carrito[key]; if (_it) track('remove_from_cart', { sabor: _it.sabor, presentacion: _it.presentacion }); } catch(e) {}
  delete carrito[key]; actualizarBadge(); renderCatalogo(); renderDrawer();
};

// ══════════════════════════════════
// PAGO
// ══════════════════════════════════
window.setPago = function(id, nom) {
  tipoPagoId=id; tipoPagoNom=nom;
  document.querySelectorAll('.pago-btn').forEach(b=>b.classList.remove('active'));
  document.querySelector(`.pago-btn[data-id="${id}"]`)?.classList.add('active');
  document.getElementById('stripe-wrap').classList.toggle('visible', id===5);
  document.getElementById('transfer-wrap')?.classList.toggle('visible', id===3);
  try { track('select_payment', { metodo: nom, id: id }); } catch(e) {}
};

// En paquetería (envío) solo se permite el cobro en línea (Stripe).
function aplicarRestriccionPagoEntrega(metodo) {
  const soloOnline = (metodo === 'paqueteria');
  document.querySelectorAll('.pago-btn').forEach(b => {
    const esOnline = b.dataset.id === '5';
    if (soloOnline && !esOnline) {
      b.style.opacity = '0.4';
      b.style.pointerEvents = 'none';
    } else {
      b.style.opacity = '';
      b.style.pointerEvents = '';
    }
  });
  if (soloOnline) setPago(5, 'Tarjeta (Stripe)');
}

// Copia un dato (ej. CLABE) al portapapeles con aviso
window.copiarDato = function(txt, label) {
  try {
    navigator.clipboard.writeText(String(txt));
    if (typeof mostrarToast === 'function') mostrarToast((label||'Dato') + ' copiado ✓');
  } catch(e) {
    if (typeof mostrarToast === 'function') mostrarToast('No se pudo copiar');
  }
};

// Stripe Checkout: pide la sesión de pago a la Edge Function y devuelve la URL segura
async function crearCheckoutStripe(idOrden) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/crear-checkout`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'apikey': SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ orden_id: idOrden }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.url) throw new Error(data.error || ('HTTP ' + r.status));
  return data.url;
}

// v2.10: Método de entrega
// #4 (Entrega A): aviso de envío para destinos fuera de CDMX
function esFueraCDMX() {
  const cp = String(document.getElementById('f-cp')?.value || '').replace(/\D/g, '');
  if (cp.length < 5) return null; // CP desconocido
  const n = parseInt(cp, 10);
  return !(n >= 1000 && n <= 16999); // CDMX ≈ 01000–16999
}
function avisoEnvioCDMX() {
  if (esFueraCDMX() !== true) return '';
  return `<div style="margin-top:8px;background:#2d1a00;border:1px solid #ffa500;border-radius:8px;padding:10px;color:#ffd699;font-size:0.74rem;line-height:1.45;">
    <strong style="color:#ffa500;">Destino fuera de CDMX.</strong> Tu pedido sí se puede enviar, pero el <strong>costo de envío puede variar según la distancia</strong> y quizá requiera un <strong>pago adicional</strong>. Confirmaremos el costo final contigo y <strong>el total se ajusta y se cobra antes de enviar</strong>.
  </div>`;
}
function repintarInfoEntrega() {
  if (metodoEntrega === 'paqueteria') setEntrega('paqueteria');
}
// El oninput del C.P. la llama desde el HTML: sin esto, ReferenceError en consola.
window.repintarInfoEntrega = repintarInfoEntrega;

window.setEntrega = function(id) {
  // Si intenta elegir paquetería, validar mínimo
  if (id === 'paqueteria') {
    const subtotal = totalMonto();
    if (subtotal < MIN_PAQUETERIA) {
      mostrarToast(`Para envío por paquetería, mínimo $${MIN_PAQUETERIA} de compra (actual: $${subtotal})`);
      return; // no cambia la selección
    }
  }
  metodoEntrega = id;
  document.querySelectorAll('.entrega-btn').forEach(b => {
    const activo = b.dataset.id === id;
    b.style.borderColor = activo ? 'var(--amarillo)' : 'var(--gris3)';
    b.style.background = activo ? '#2a1f00' : 'var(--gris2)';
  });
  // Paquetería => solo cobro en línea
  aplicarRestriccionPagoEntrega(id);
  // Actualizar info contextual
  const info = document.getElementById('entrega-info');
  if (id === 'paqueteria') {
    info.style.display = 'block';
    // ¿Hay cupón envío gratis aplicado?
    const tieneCuponEnvio = _cuponEnCarrito && _cuponEnCarrito.tipo === 'envio_gratis';
    if (tieneCuponEnvio) {
      info.innerHTML = `Tu pedido se enviará por <strong style="color:var(--amarillo);">enviatodo.com</strong>. <strong style="color:#4caf50;">¡Cupón ${_cuponEnCarrito.codigo} aplicado!</strong> El costo del envío ($${COSTO_PAQUETERIA}) se descuenta automáticamente. Se asignará una guía de rastreo.` + avisoEnvioCDMX();
    } else {
      info.innerHTML = `Tu pedido se enviará por <strong style="color:var(--amarillo);">enviatodo.com</strong>. Costo: <strong>$${COSTO_PAQUETERIA}</strong> que se sumará al total. Se asignará una guía de rastreo una vez confirmado.` + avisoEnvioCDMX();
    }
  } else if (id === 'coordinar') {
    info.style.display = 'block';
    info.innerHTML = 'Tu contacto Crunchy te escribirá para coordinar la entrega. Sin costo extra.';
  } else {
    info.style.display = 'none';
  }

  // v2.11: Mostrar/ocultar selector de vendedor (solo cuando "coordinar")
  const selectorWrap = document.getElementById('vendedor-selector-wrap');
  if (selectorWrap) {
    if (id === 'coordinar' && tipoCliente === 'consumidor') {
      selectorWrap.style.display = 'block';
      // Si no hay vendedor cacheado, intentar precargar desde historial
      if (!_contactoVendedor) {
        precargarContactoDesdeHistorial();
      } else {
        pintarVendedorSeleccionado();
      }
    } else {
      selectorWrap.style.display = 'none';
      // En paquetería no aplica contacto (se entrega por paquetería)
      if (id === 'paqueteria') _contactoVendedor = null;
    }
  }

  // Recalcular total del carrito (renderDrawer reagiliza toda la vista del carrito)
  if (typeof renderDrawer === 'function') renderDrawer();
  if (typeof actualizarChecklistFaltantes === 'function') actualizarChecklistFaltantes();
};

// Actualiza visualmente el botón de paquetería según el mínimo (disabled visual)
window.actualizarEstadoPaqueteria = function() {
  const subtotal = totalMonto();
  const btnPaq = document.querySelector('.entrega-btn[data-id="paqueteria"]');
  if (!btnPaq) return;
  // Paquetería SOLO para canal consumidor. B2B (tienda/restaurante/mayorista)
  // coordina la entrega con su vendedor/reparto.
  const _canalEnt = esVendedor ? (canalVenta || 'consumidor') : tipoCliente;
  if (_canalEnt !== 'consumidor') {
    btnPaq.style.display = 'none';
    if (metodoEntrega === 'paqueteria') setEntrega('coordinar');
    return;
  }
  btnPaq.style.display = '';
  const costoLbl = document.getElementById('entrega-paq-costo');
  if (subtotal < MIN_PAQUETERIA) {
    btnPaq.style.opacity = '0.45';
    btnPaq.style.cursor = 'not-allowed';
    if (costoLbl) costoLbl.innerHTML = `<span style="color:var(--rojo);">Mín. $${MIN_PAQUETERIA}</span>`;
    // Si tenía paquetería seleccionada pero ya no llega al mínimo, revertir a coordinar
    if (metodoEntrega === 'paqueteria') {
      setEntrega('coordinar');
    }
  } else {
    btnPaq.style.opacity = '1';
    btnPaq.style.cursor = 'pointer';
    if (costoLbl) costoLbl.innerHTML = `+$${COSTO_PAQUETERIA}`;
  }
};

// Inicializar default (coordinar)
setTimeout(() => { if (document.querySelector('.entrega-btn')) setEntrega('coordinar'); }, 100);

// ══════════════════════════════════
// v2.11: SELECTOR DE VENDEDOR EN CHECKOUT
// ══════════════════════════════════

// Cargar lista inicial de vendedores aptos (sin filtro)
async function cargarVendedoresCheckout() {
  if (_vendedoresCheckoutCache) return _vendedoresCheckoutCache;
  try {
    // Fase 1c: sin respaldo escrito a mano (hallazgo 16).
    const supaUrl = window.SUPABASE_URL;
    const supaKey = window.SUPABASE_ANON_KEY;
    if (!supaUrl || !supaKey) return [];
    const resp = await fetch(supaUrl + '/rest/v1/rpc/buscar_vendedores', {
      method: 'POST',
      headers: {
        'apikey': supaKey,
        'Authorization': 'Bearer ' + supaKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_data: { query: '', modo: 'checkout' } }),
    });
    const data = await resp.json();
    _vendedoresCheckoutCache = (data && data.ok) ? (data.vendedores || []) : [];
    return _vendedoresCheckoutCache;
  } catch(e) {
    console.log('Error cargando vendedores:', e);
    return [];
  }
}

// Buscar vendedores según texto del input (con debounce simple)
let _vendBusquedaTimer = null;
window.buscarVendedoresCheckout = function() {
  clearTimeout(_vendBusquedaTimer);
  _vendBusquedaTimer = setTimeout(async () => {
    const q = (document.getElementById('vend-search')?.value || '').trim().toLowerCase();
    const cont = document.getElementById('vend-resultados');
    if (!cont) return;
    // Cargar lista del cache (todos los vendedores aptos)
    const todos = await cargarVendedoresCheckout();
    // Reglas de visibilidad por privacidad:
    // - Sin query (o <2 chars): mostrar SOLO el "Crunchy Paps Local" (Mostrador) + opción Cualquiera
    // - Con query ≥2 chars: mostrar todos los que matchean por nombre
    let visibles;
    if (q.length < 2) {
      visibles = todos.filter(v => v.rol === 'Mostrador');
    } else {
      visibles = todos.filter(v => v.nombre.toLowerCase().includes(q));
    }
    pintarResultadosVendedor(visibles, q);
  }, 150);
};

function pintarResultadosVendedor(vendedores, query) {
  const cont = document.getElementById('vend-resultados');
  if (!cont) return;

  // Caso: hay query pero sin coincidencias
  if (vendedores.length === 0 && query.length >= 2) {
    cont.innerHTML = `<div style="color:var(--suave);font-size:0.78rem;padding:8px;text-align:center;">Sin resultados para "${query}"</div>
      <div style="border-top:1px solid var(--gris3);margin-top:6px;padding-top:6px;">
        ${botonCualquiera()}
      </div>`;
    return;
  }

  const items = vendedores.slice(0, 20).map(v => {
    const esMostrador = v.rol === 'Mostrador';
    // Solo el Mostrador conserva un subtítulo identificativo (es el punto físico).
    // Para todo lo demás (Vendedor, Admin), NO mostramos rol — privacidad.
    const ico = '';
    const subtituloHtml = esMostrador
      ? '<div style="color:var(--suave);font-size:0.7rem;">Punto de venta local</div>'
      : '';
    return `
      <div onclick='seleccionarVendedor(${JSON.stringify(v).replace(/'/g, "&apos;")})'
        style="display:flex;align-items:center;gap:10px;padding:10px;background:var(--gris2);border-radius:8px;margin-bottom:6px;cursor:pointer;transition:background 0.15s;"
        onmouseover="this.style.background='var(--gris3)'" onmouseout="this.style.background='var(--gris2)'">
        
        <div style="flex:1;min-width:0;">
          <div style="color:var(--blanco);font-weight:700;font-size:0.86rem;">${v.nombre}</div>
          ${subtituloHtml}
        </div>
        <span style="color:var(--amarillo);">→</span>
      </div>
    `;
  }).join('');

  // Hint cuando no hay query: "escribe el nombre de tu contacto..."
  const hint = (query.length < 2)
    ? `<div style="color:var(--suave);font-size:0.74rem;padding:6px 4px 10px;text-align:center;font-style:italic;">Escribe el nombre de tu contacto Crunchy</div>`
    : '';

  cont.innerHTML = hint + items + botonCualquiera();
}

function botonCualquiera() {
  return `
    <div onclick="seleccionarVendedor({id:0,nombre:'Cualquier vendedor',rol:'Cualquiera'})"
      style="display:flex;align-items:center;gap:10px;padding:10px;background:transparent;border:1px dashed var(--gris3);border-radius:8px;cursor:pointer;margin-top:4px;"
      onmouseover="this.style.borderColor='var(--amarillo)'" onmouseout="this.style.borderColor='var(--gris3)'">
      <div style="flex:1;">
        <div style="color:var(--blanco);font-weight:700;font-size:0.86rem;">No conozco a nadie</div>
        <div style="color:var(--suave);font-size:0.7rem;">Que cualquiera me contacte</div>
      </div>
    </div>
  `;
}

window.seleccionarVendedor = function(vendedor) {
  _contactoVendedor = vendedor;
  pintarVendedorSeleccionado();
  if (typeof actualizarChecklistFaltantes === 'function') actualizarChecklistFaltantes();
};

function pintarVendedorSeleccionado() {
  const cont = document.getElementById('vend-seleccionado');
  const buscador = document.getElementById('vend-buscador');
  const lblNombre = document.getElementById('vend-sel-nombre');
  const lblRol = document.getElementById('vend-sel-rol');
  if (!cont || !buscador || !lblNombre || !lblRol) return;

  if (_contactoVendedor) {
    cont.style.display = 'flex';
    buscador.style.display = 'none';
    lblNombre.textContent = _contactoVendedor.nombre;
    // No exponer roles (admin, vendedor). Solo mostramos texto cuando aporta info real.
    let rolTxt = '';
    if (_contactoVendedor.rol === 'Mostrador') rolTxt = 'Punto de venta local';
    else if (_contactoVendedor.rol === 'Cualquiera') rolTxt = 'Cualquier vendedor disponible';
    lblRol.textContent = rolTxt;
    lblRol.style.display = rolTxt ? 'block' : 'none';
  } else {
    cont.style.display = 'none';
    buscador.style.display = 'block';
  }
}

window.limpiarVendedorSeleccionado = function() {
  _contactoVendedor = null;
  pintarVendedorSeleccionado();
  // Limpiar buscador y recargar lista completa
  const search = document.getElementById('vend-search');
  if (search) search.value = '';
  buscarVendedoresCheckout();
  if (typeof actualizarChecklistFaltantes === 'function') actualizarChecklistFaltantes();
};

// Opt-in marketing: mostrar la casilla solo si el cliente NO ha aceptado aún.
async function actualizarVisibilidadOptIn() {
  const wrap = document.getElementById('chk-promos-wrap');
  if (!wrap) return;
  const chk = document.getElementById('chk-promos');
  // Por defecto visible (cliente nuevo/desconocido), sin marcar
  wrap.style.display = '';
  if (chk) chk.checked = false;
  try {
    const tel = String(telefonoVerif || clienteActual?.telefono || '').replace(/\D/g, '').slice(-10);
    if (tel.length < 10) return;
    const r = await supabaseCall('POST', 'rpc/get_opt_in_promos', { p_telefono: tel });
    if (r && r.ok && r.acepta === true) {
      wrap.style.display = 'none';  // ya aceptó → no volver a pedirlo
    }
  } catch (_e) {}
}

// v2.11.2: Mostrar HINT del último contacto en lugar de auto-seleccionar
// Esto evita confusión: el cliente decide explícitamente si reutilizar o cambiar
async function precargarContactoDesdeHistorial() {
  // SIEMPRE resetear visual: ocultar tarjeta verde, mostrar buscador, limpiar input
  const cont = document.getElementById('vend-seleccionado');
  const buscador = document.getElementById('vend-buscador');
  const search = document.getElementById('vend-search');
  if (cont) cont.style.display = 'none';
  if (buscador) buscador.style.display = 'block';
  if (search) search.value = '';  // v2.11.3: limpiar texto previo

  if (_contactoVendedor) return;  // ya hay uno seleccionado en memoria

  // Buscar en window._misPedidos un pedido con id_vendedor
  const misPedidos = window._misPedidos || [];
  let idVendedorHistorial = null;
  for (const p of misPedidos) {
    if (p.id_vendedor || p.idVendedor) {
      idVendedorHistorial = p.id_vendedor || p.idVendedor;
      break;
    }
  }
  // Cargar la lista de vendedores aptos (siempre)
  const todos = await cargarVendedoresCheckout();
  if (!idVendedorHistorial) {
    // Sin historial: pintar la lista normal
    pintarResultadosVendedor(todos.filter(v => v.rol === 'Mostrador'), '');
    return;
  }
  // Buscar el vendedor en el cache
  const vend = todos.find(v => Number(v.id) === Number(idVendedorHistorial));
  if (vend) {
    // No autoselecciona: muestra hint con opción de usar ese contacto
    pintarHintUltimoContacto(vend);
  } else {
    // No encontrado: lista normal
    pintarResultadosVendedor(todos.filter(v => v.rol === 'Mostrador'), '');
  }
}

// v2.11.2: Pinta sugerencia visual del último contacto sin seleccionarlo
function pintarHintUltimoContacto(vend) {
  const cont = document.getElementById('vend-resultados');
  if (!cont) return;
  const esMostrador = vend.rol === 'Mostrador';
  const ico = '';
  const subtitulo = esMostrador ? 'Punto de venta local' : '';

  cont.innerHTML = `
    <div style="background:#2d1a00;border:1px dashed #ffa500;border-radius:8px;padding:12px;margin-bottom:10px;">
      <div style="color:#ffa500;font-size:0.74rem;font-weight:700;margin-bottom:6px;">LA ÚLTIMA VEZ ELEGISTE</div>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
        <span style="font-size:1.4rem;">${ico}</span>
        <div style="flex:1;min-width:0;">
          <div style="color:var(--blanco);font-weight:700;font-size:0.95rem;">${vend.nombre}</div>
          ${subtitulo ? `<div style="color:var(--suave);font-size:0.74rem;">${subtitulo}</div>` : ''}
        </div>
      </div>
      <button onclick='seleccionarVendedor(${JSON.stringify(vend).replace(/'/g, "&apos;")})'
        style="width:100%;background:var(--amarillo);border:none;border-radius:8px;padding:10px;color:#000;font-weight:800;font-size:0.86rem;cursor:pointer;">
        ✓ Usar este contacto otra vez
      </button>
    </div>
    <div style="text-align:center;color:var(--suave);font-size:0.74rem;padding:4px 0 8px;font-style:italic;">— o elige otro —</div>
    ${botonCualquiera()}
  `;
}

// ══════════════════════════════════
// CP → COLONIAS
// ══════════════════════════════════
let cpTimer = null;

// ══════════════════════════════════
// DETECCIÓN DE ZONA DE ENTREGA
// ══════════════════════════════════
function detectarZona(cp) {
  const cpNum = parseInt(cp);
  if (cpNum >= 1000 && cpNum <= 16999) {
    return { zona: 'cdmx', label: 'CDMX', color: '#4caf50', entrega: 'normal',
      msg: null };
  }
  if ((cpNum >= 50000 && cpNum <= 57999) || (cpNum >= 52000 && cpNum <= 54999)) {
    return { zona: 'edomex', label: 'Estado de México', color: '#FFD200', entrega: 'coordinacion',
      msg: 'Tu pedido requiere coordinación de entrega. El equipo de Crunchy Paps se pondrá en contacto contigo para confirmar fecha y costo de envío.' };
  }
  return { zona: 'foraneo', label: 'Envío foráneo', color: '#E8242A', entrega: 'paqueteria',
    msg: 'Tu pedido es foráneo y se enviará por paquetería. Al confirmar, nuestro equipo te contactará para coordinar el envío y costos adicionales.' };
}

function mostrarAlertaZona(zona) {
  let alertaEl = document.getElementById('zona-alerta');
  if (!alertaEl) {
    alertaEl = document.createElement('div');
    alertaEl.id = 'zona-alerta';
    const cpInfo = document.getElementById('cp-info');
    if (cpInfo) cpInfo.parentNode.insertBefore(alertaEl, cpInfo.nextSibling);
  }
  if (!zona.msg) { alertaEl.style.display='none'; return; }
  alertaEl.style.cssText = `display:block;background:var(--gris2);border-left:3px solid ${zona.color};border-radius:0 10px 10px 0;padding:10px 14px;margin-top:6px;font-size:0.8rem;font-weight:700;color:var(--suave);line-height:1.5;`;
  alertaEl.textContent = zona.msg;
  // Guardar zona para el pedido
  window._zonaEntrega = zona;
}

window.buscarCP = async function(cp) {
  // Asegurar 5 dígitos con ceros a la izquierda
  cp = String(cp).padStart(5,'0');
  const st=document.getElementById('cp-status');
  const col=document.getElementById('f-colonia');
  const info=document.getElementById('cp-info');
  // Recordar la colonia ya elegida ANTES de vaciar el desplegable. Repoblarlo
  // la borraba, así que quien ya la había puesto tenía que volver a elegirla
  // cada vez que tocaba la dirección o usaba la ubicación. Bug anterior a la
  // Etapa B: `buscarCP` reconstruía las opciones sin restaurar la selección.
  const _coloniaPrevia = (col.value || '').trim();
  col.innerHTML='<option value="">Elige tu colonia</option>'; col.style.color='#444';
  info.style.display='none'; st.textContent='';
  if (cp.length<5) return;
  clearTimeout(cpTimer);
  st.style.color='#888'; st.textContent='Buscando...';
  cpTimer = setTimeout(async()=>{
    try {
      const r=await fetch(`https://api.zippopotam.us/MX/${cp}`);
      if (!r.ok) throw new Error();
      const d=await r.json();
      const places=d.places||[];
      if (!places.length) throw new Error();
      places.forEach(p=>{
        const o=document.createElement('option');
        o.value=o.textContent=p['place name']; col.appendChild(o);
      });
      // Devolver la selección previa si sigue estando entre las opciones del
      // CP nuevo. Si el CP cambió y esa colonia ya no aplica, se queda vacío,
      // que es lo correcto.
      if (_coloniaPrevia) {
        const objetivo = _coloniaPrevia.toLowerCase();
        for (let i = 0; i < col.options.length; i++) {
          if (col.options[i].value.toLowerCase() === objetivo) { col.selectedIndex = i; break; }
        }
      }
      col.style.color='var(--blanco)';
      st.style.color='#4caf50'; st.textContent=`✓ ${places.length} colonia${places.length>1?'s':''}`;
      document.getElementById('cp-mun').textContent=places[0]['place name'];
      document.getElementById('cp-est').textContent=places[0]['state']||'';
      info.style.display='block';
    } catch(e) {
      st.style.color='var(--rojo)'; st.textContent='✗ CP no encontrado';
    }
  },600);
};

// ══════════════════════════════════
// MAPS
// ══════════════════════════════════
let mapInstance = null;
let markerInstance = null;

function initMaps() {
  if (mapsListo || !GOOGLE_MAPS_KEY || GOOGLE_MAPS_KEY==='TU_API_KEY') return;
  const s=document.createElement('script');
  s.src=`https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_KEY}&libraries=places,geocoder&language=es`;
  // Si Google rechaza la llave (referer no permitido, cuota, llave caída), Places
  // deshabilita #f-dir y le pone «Se ha producido un error.» como placeholder: el
  // cliente se queda sin poder escribir su dirección. Se le devuelve el campo.
  window.gm_authFailure = function() {
    mapsListo = false;
    // Los dos campos con Autocomplete: el del checkout y el del alta de tienda.
    const CAMPOS = { 'f-dir': 'Ej. Av. Insurgentes Sur 123, int. 4', 'dt-dir': 'Calle y número' };
    const devolver = () => {
      Object.entries(CAMPOS).forEach(([id, ph]) => {
        const i = document.getElementById(id);
        if (!i) return;
        i.disabled = false;
        i.placeholder = ph;
        i.classList.remove('gm-err-autocomplete');
        i.style.backgroundImage = '';
      });
    };
    devolver(); setTimeout(devolver, 500); setTimeout(devolver, 2000);
    // Places vuelve a marcar el campo al enfocarlo: se deshace cada vez que lo toque.
    Object.keys(CAMPOS).forEach((id) => {
      const i = document.getElementById(id);
      if (i && window.MutationObserver && !i._obsErr) {
        i._obsErr = new MutationObserver(() => { if (i.disabled || i.classList.contains('gm-err-autocomplete')) devolver(); });
        i._obsErr.observe(i, { attributes: true, attributeFilter: ['disabled', 'class', 'placeholder', 'style'] });
      }
    });
  };
  s.onload=()=>{
    mapsListo=true;
    const input=document.getElementById('f-dir');

    // Autocomplete sin restricción de bounds inicial
    const ac=new google.maps.places.Autocomplete(input,{
      componentRestrictions:{country:'mx'},
      fields:['geometry','formatted_address','address_components'],
      types:['address']
    });

    // Cuando el CP ya está puesto, restringir el área del autocomplete
    window.restringirAutocompletePorCP = function(lat, lng, radio=8000) {
      const center = new google.maps.LatLng(lat, lng);
      const circle = new google.maps.Circle({ center, radius: radio });
      ac.setBounds(circle.getBounds());
    };

    ac.addListener('place_changed',()=>{
      const place=ac.getPlace();
      if (!place.geometry) return;
      dirCoords={lat:place.geometry.location.lat(),lng:place.geometry.location.lng()};

      // Extraer CP de la dirección seleccionada
      let cpNuevo = '';
      place.address_components.forEach(c=>{
        if (c.types.includes('postal_code')) cpNuevo = c.long_name.padStart(5,'0');
      });

      // Siempre actualizar CP y zona con la dirección seleccionada
      if (cpNuevo) {
        document.getElementById('f-cp').value = cpNuevo;
        buscarCP(cpNuevo); // Esto actualiza colonias Y zona
      }

      document.getElementById('mapa-lbl').textContent=place.formatted_address;
      mostrarMapaInteractivo(dirCoords.lat, dirCoords.lng);
    });

    // Alta de tienda: el mismo autocompletado en «Dirección» (Abraham, 13 sep
    // 2026). Al elegir, la calle queda como «calle número» y se rellenan CP,
    // colonia (por el CP, como el checkout), municipio, estado y la ubicación
    // de entrega, que se muestra en el mapa para ajustar el pin.
    const inputT = document.getElementById('dt-dir');
    if (inputT) {
      const acT = new google.maps.places.Autocomplete(inputT, {
        componentRestrictions: { country: 'mx' },
        fields: ['geometry', 'formatted_address', 'address_components'],
        types: ['address']
      });
      window._acTienda = acT;
      acT.addListener('place_changed', () => {
        const place = acT.getPlace();
        if (!place || !place.geometry) return;
        const comp = (tipo) => (place.address_components || []).find(c => c.types.includes(tipo));
        const g = (tipo) => (comp(tipo) || {}).long_name || '';
        const calle = [g('route'), g('street_number')].filter(Boolean).join(' ');
        if (calle) inputT.value = calle;
        const cp = g('postal_code');
        const colonia = g('sublocality_level_1') || g('sublocality') || g('neighborhood');
        const municipio = g('locality') || g('administrative_area_level_2') || g('administrative_area_level_3');
        const estado = g('administrative_area_level_1');
        const set = (id, v) => { const e = document.getElementById(id); if (e && v) e.value = v; };
        set('dt-municipio', municipio);
        set('dt-estado', estado);
        if (cp) {
          set('dt-cp', cp.padStart(5, '0'));
          const sc = document.getElementById('dt-colonia'); if (sc) sc.dataset.previa = colonia || '';
          buscarCPTienda(cp);
        }
        window._dtCoords = { lat: place.geometry.location.lat(), lng: place.geometry.location.lng() };
        mostrarMapaTienda(window._dtCoords.lat, window._dtCoords.lng);
      });
    }
  };
  document.head.appendChild(s);
}

// ── Fix coordenadas (Opción 1) ──────────────────────────────────────
// Geocodifica una dirección de texto a {lat,lng}. Espera a que el SDK
// de Maps esté listo. Devuelve null si no se pudo resolver.
// Tope de espera al geocodificador. Si Maps carga pero no responde —bloqueador
// de rastreo, corte de googleapis, referer rechazado— la devolución de llamada
// no llega NUNCA, y confirmarPedido se quedaba en «Registrando...» para
// siempre. Sin coordenadas el pedido sale igual; sin respuesta, no.
// 2 s: un geocode vivo tarda 200-600 ms, hasta ~1.5 s en red movil floja.
// (Empezo en 4 s; Abraham lo bajo el 7 sep: «es demasiado».)
const GEOCODE_TOPE_MS = 2000;
async function geocodificarDireccionTexto(direccionCompleta) {
  let intentos = 0;
  while ((typeof google === 'undefined' || !google.maps || !google.maps.Geocoder) && intentos < 40) {
    await new Promise(r => setTimeout(r, 150));
    intentos++;
  }
  if (typeof google === 'undefined' || !google.maps || !google.maps.Geocoder) return null;
  return new Promise((resolve) => {
    const tope = setTimeout(() => resolve(null), GEOCODE_TOPE_MS);
    try {
      const geocoder = new google.maps.Geocoder();
      geocoder.geocode({ address: direccionCompleta, componentRestrictions: { country: 'MX' } }, (results, status) => {
        clearTimeout(tope);
        if (status === 'OK' && results && results[0] && results[0].geometry) {
          const loc = results[0].geometry.location;
          resolve({ lat: loc.lat(), lng: loc.lng() });
        } else {
          resolve(null);
        }
      });
    } catch (_e) { clearTimeout(tope); resolve(null); }
  });
}

// Garantiza que dirCoords tenga valor: reusa las coords guardadas del
// cliente si la dirección no cambió; si no, geocodifica el formulario.
async function asegurarCoordenadasDesdeFormulario() {
  if (dirCoords) return dirCoords;
  const fDir = document.getElementById('f-dir');
  const dir = (fDir && fDir.value || '').trim();
  if (!dir) return null;

  // 1) Reusar coords guardadas SOLO si la dirección no cambió
  if (clienteActual && clienteActual.coordenadas && clienteActual.direccion
      && dir === String(clienteActual.direccion).trim()) {
    const p = String(clienteActual.coordenadas).split(',').map(s => parseFloat(s.trim()));
    if (p.length === 2 && !isNaN(p[0]) && !isNaN(p[1])) {
      dirCoords = { lat: p[0], lng: p[1] };
      try { mostrarMapaInteractivo(dirCoords.lat, dirCoords.lng); } catch (_e) {}
      return dirCoords;
    }
  }

  // 2) Geocodificar la dirección del formulario
  const fCp = document.getElementById('f-cp');
  const cp = (fCp && fCp.value || '').trim();
  const fCol = document.getElementById('f-colonia');
  const colonia = fCol ? (fCol.value || '') : '';
  const partes = [dir, colonia, cp, (clienteActual && clienteActual.municipio) || '', (clienteActual && clienteActual.estado) || '', 'México'].filter(Boolean);
  const coords = await geocodificarDireccionTexto(partes.join(', '));
  if (coords) {
    dirCoords = coords;
    try { mostrarMapaInteractivo(coords.lat, coords.lng); } catch (_e) {}
  }
  return dirCoords;
}

function mostrarMapaInteractivo(lat, lng) {
  const wrap = document.getElementById('mapa-wrap');
  wrap.style.display='block';

  const mapDiv = document.getElementById('mapa-div');
  const center = { lat, lng };

  if (!mapInstance) {
    mapInstance = new google.maps.Map(mapDiv, {
      center, zoom: 17,
      disableDefaultUI: true,
      zoomControl: true,
      mapTypeControl: false,
      streetViewControl: false,
      styles: [{ featureType:'all', elementType:'labels.text.fill', stylers:[{color:'#444'}] }]
    });
    markerInstance = new google.maps.Marker({
      position: center,
      map: mapInstance,
      draggable: true,
      animation: google.maps.Animation.DROP,
      title: 'Arrastra para ajustar la ubicación'
    });

    // Al arrastrar el pin, actualizar coordenadas y dirección
    markerInstance.addListener('dragend', function() {
      const pos = markerInstance.getPosition();
      dirCoords = { lat: pos.lat(), lng: pos.lng() };
      actualizarCoordsDisplay(pos.lat(), pos.lng());

      // Geocodificar para obtener dirección del nuevo punto
      const geocoder = new google.maps.Geocoder();
      geocoder.geocode({ location: pos }, (results, status) => {
        if (status === 'OK' && results[0]) {
          const addr = results[0].formatted_address;
          document.getElementById('mapa-lbl').textContent = addr;
          // Actualizar campo de dirección
          document.getElementById('f-dir').value = addr;

          // Actualizar CP y zona si cambió
          let cpNuevo = '';
          results[0].address_components.forEach(c => {
            if (c.types.includes('postal_code')) cpNuevo = c.long_name.padStart(5,'0');
          });
          if (cpNuevo && cpNuevo !== document.getElementById('f-cp').value) {
            document.getElementById('f-cp').value = cpNuevo;
            buscarCP(cpNuevo);
          }
        }
      });
    });
  } else {
    mapInstance.setCenter(center);
    mapInstance.setZoom(17);
    markerInstance.setPosition(center);
    markerInstance.setAnimation(google.maps.Animation.DROP);
  }

  actualizarCoordsDisplay(lat, lng);
}

function actualizarCoordsDisplay(lat, lng) {
  const el = document.getElementById('mapa-coords');
  if (el) el.textContent = `Coordenadas: ${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

// ══════════════════════════════════
// USAR MI UBICACIÓN (geolocalización + reverse geocode)
// ══════════════════════════════════
window.usarMiUbicacion = function() {
  const btn  = document.getElementById('btn-usar-ubicacion');
  const icon = document.getElementById('btn-ubic-icon');
  const text = document.getElementById('btn-ubic-text');

  // Verificar soporte del navegador
  if (!navigator.geolocation) {
    avisar({ titulo: 'Sin geolocalización', cuerpo: 'Tu navegador no soporta geolocalización. Escribe la dirección manualmente.' });
    return;
  }

  // Estado de carga
  btn.disabled = true;
  if (icon) icon.style.opacity = '0.4';
  if (text) text.textContent = 'Obteniendo ubicación…';
  btn.style.opacity = '0.7';

  // Helper para restablecer el botón
  const reset = (msg) => {
    btn.disabled = false;
    if (icon) icon.style.opacity = '';
    if (text) text.textContent = msg || 'Usar mi ubicación';
    btn.style.opacity = '1';
  };

  navigator.geolocation.getCurrentPosition(
    async function(position) {
      const lat = position.coords.latitude;
      const lng = position.coords.longitude;
      const accuracy = position.coords.accuracy; // en metros

      // Si la precisión es pobre (>200m) avisamos pero seguimos
      const precisionPobre = accuracy && accuracy > 200;

      try {
        // Cargar Maps si aún no está
        if (!mapsListo) initMaps();
        // Esperar a que google esté disponible (hasta 4 segundos)
        let intentos = 0;
        while ((typeof google === 'undefined' || !google.maps?.Geocoder) && intentos < 40) {
          await new Promise(r => setTimeout(r, 100));
          intentos++;
        }
        if (typeof google === 'undefined' || !google.maps?.Geocoder) {
          throw new Error('Google Maps no disponible');
        }

        const geocoder = new google.maps.Geocoder();
        geocoder.geocode({ location: { lat, lng } }, async (results, status) => {
          if (status !== 'OK' || !results || !results[0]) {
            reset();
            avisar({ titulo: 'No pude identificar la dirección', cuerpo: 'Mueve el pin del mapa al punto exacto o escribe la dirección manualmente.' });
            // Aún así mostramos el mapa con el punto detectado
            dirCoords = { lat, lng };
            mostrarMapaInteractivo(lat, lng);
            actualizarCoordsDisplay(lat, lng);
            return;
          }

          // Parsear componentes de la dirección
          const r = results[0];
          let cp = '', colonia = '', ciudad = '', estado = '', calle = '', numero = '';
          r.address_components.forEach(c => {
            if (c.types.includes('postal_code'))                    cp      = c.long_name.padStart(5,'0');
            if (c.types.includes('sublocality') ||
                c.types.includes('sublocality_level_1') ||
                c.types.includes('neighborhood'))                   colonia = c.long_name;
            if (c.types.includes('locality'))                       ciudad  = c.long_name;
            if (c.types.includes('administrative_area_level_1'))    estado  = c.long_name;
            if (c.types.includes('route'))                          calle   = c.long_name;
            if (c.types.includes('street_number'))                  numero  = c.long_name;
          });

          // Llenar dirección (calle + número, o formatted_address si no tenemos calle)
          const direccionCorta = (calle && numero) ? `${calle} ${numero}` :
                                 (calle)            ? calle :
                                                      r.formatted_address;
          const fDir = document.getElementById('f-dir');
          if (fDir) fDir.value = direccionCorta;

          // Llenar CP (esto dispara buscarCP que también llena colonias y zona)
          if (cp) {
            const fCp = document.getElementById('f-cp');
            if (fCp) fCp.value = cp;
            await buscarCP(cp);
            // Después de que cargaron las colonias, intentar seleccionar la del reverse geocode
            if (colonia) {
              const sel = document.getElementById('f-colonia');
              if (sel) {
                // Buscar opción que coincida (case-insensitive)
                const target = colonia.toLowerCase();
                let matched = false;
                for (let i = 0; i < sel.options.length; i++) {
                  if (sel.options[i].value.toLowerCase() === target ||
                      sel.options[i].text.toLowerCase() === target) {
                    sel.selectedIndex = i;
                    matched = true;
                    break;
                  }
                }
                // Si no hay match exacto, agregar la del reverse geocode como opción nueva
                if (!matched && colonia) {
                  const opt = document.createElement('option');
                  opt.value = colonia;
                  opt.text  = colonia + ' (detectada)';
                  opt.selected = true;
                  sel.appendChild(opt);
                }
              }
            }
          }

          // Guardar coordenadas y mostrar mapa
          dirCoords = { lat, lng };
          mostrarMapaInteractivo(lat, lng);
          actualizarCoordsDisplay(lat, lng);
          document.getElementById('mapa-lbl').textContent = r.formatted_address;

          // Mensaje de éxito
          mostrarToast('Ubicación detectada' + (precisionPobre ? ' (ajusta el pin)' : ''));
          reset('Cambiar ubicación');
        });
      } catch(e) {
        reset();
        avisar({ titulo: 'Error al consultar Google Maps', cuerpo: e.message });
      }
    },
    function(error) {
      reset();
      let msg = 'No pude obtener tu ubicación.';
      if (error.code === 1)      msg = 'Permiso denegado. Activa la ubicación en los ajustes del navegador.';
      else if (error.code === 2) msg = 'Ubicación no disponible. Verifica el GPS de tu dispositivo.';
      else if (error.code === 3) msg = 'Tiempo agotado. Intenta de nuevo.';
      avisar({ titulo: 'Ubicación', cuerpo: msg });
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
};

window.onDirInput = function(v) {
  if (!mapsListo) document.getElementById('maps-sug').style.display='none';
};

// ══════════════════════════════════
// DATOS CLIENTE (background)
// ══════════════════════════════════
async function cargarDatosCliente() {
  if (!telefonoVerif) return;
  try {
    // v2.11: Ya no asignamos vendedor por CP automáticamente.
    // El cliente elige su vendedor desde el catálogo o lo hereda de su historial.
    vendedorAsig = null;

    // Historial cliente (Supabase RPC)
    // 19 sep 2026: las encuestas respondidas solo dependen del teléfono, no del
    // historial, así que se piden A LA VEZ que el cliente (antes iban después:
    // un viaje a Ohio más en serie en cada apertura con sesión).
    const pEncuestas = supabaseCall('POST', 'rpc/obtener_encuestas_cliente', { p_data: { telefono: telefonoVerif } }).catch(() => null);
    const rc = await supabaseCall('POST', 'rpc/obtener_cliente_con_stats', { p_telefono: telefonoVerif, p_token: tokenParaConsultaCliente() });
    if (rc.ok && rc.existe) {
      clienteActual = rc.cliente;
      gaSetUser(clienteActual.id);
      puntos        = rc.puntos || 0;
      const stats   = rc.stats;

      // Actualizar header con nombre — solo si NO es vendedor
      if (clienteActual.nombre && !esVendedor) {
        document.getElementById('h-nombre').textContent = clienteActual.nombre;
        const hn2 = document.getElementById('h-nombre2');
        if (hn2) hn2.textContent = clienteActual.nombre;
      }

      // Guardar datos globalmente para Pedidos y Mi Cuenta
      window._statsCliente = stats;
      window._misPedidos = stats?.pedidos || (stats?.ultimoPedido ? [stats.ultimoPedido] : []);

      // Encuestas ya respondidas (para marcar "Evaluado" en Mi Cuenta)
      const _re = await pEncuestas;
      window._encuestadas = (_re && _re.ok && Array.isArray(_re.idsEncuestadas)) ? _re.idsEncuestadas : (window._encuestadas || []);

      if (stats && stats.totalPedidos>0) {
        // Aliases defensivos: el SQL devuelve totalGastado, totalCompras y comprasMes
        const _totalCompras = Number(stats.totalCompras ?? stats.totalGastado ?? 0);
        const _comprasMes   = Number(stats.comprasMes ?? 0);
        // Actualizar stats en sección premia
        document.getElementById('p-total-pedidos').textContent = stats.totalPedidos;
        document.getElementById('p-total-compras').textContent = '$' + _totalCompras.toLocaleString('es-MX');
        document.getElementById('p-mes').textContent = '$' + _comprasMes.toLocaleString('es-MX');
        if (stats.ultimoPedido && stats.ultimoPedido.fecha) {
          const f = new Date(stats.ultimoPedido.fecha);
          if (!isNaN(f.getTime())) {
            document.getElementById('p-ultimo').textContent = f.toLocaleDateString('es-MX',{day:'numeric',month:'short'});
          } else {
            document.getElementById('p-ultimo').textContent = '—';
          }
        } else {
          document.getElementById('p-ultimo').textContent = '—';
        }
        document.getElementById('h-pedidos').textContent = stats.totalPedidos;
        document.getElementById('h-mes').textContent = `$${_comprasMes.toLocaleString('es-MX')}`;
        document.getElementById('h-puntos').textContent = puntos;
        if (stats.ultimoPedido && stats.ultimoPedido.fecha) {
          const f = new Date(stats.ultimoPedido.fecha);
          if (!isNaN(f.getTime())) {
            document.getElementById('h-ultimo').textContent =
              `Último pedido: ${f.toLocaleDateString('es-MX',{day:'numeric',month:'short'})} · $${stats.ultimoPedido.total||0}`;
          }
        }
        // Mostrar brevemente el dropdown para avisar que hay historial
        const dd = document.getElementById('historial-dropdown');
        dd.style.display = 'block';
        setTimeout(() => { dd.style.display = 'none'; }, 4000);
      }

      // Vendedor del cliente
      if (clienteActual.idVendedor && !vendedorAsig) {
        vendedorAsig = { id:clienteActual.idVendedor, nombre:clienteActual.vendedor };
      }
    }
  } catch(e) { console.log('Sin historial:', e.message); }
}

window.cerrarHistorial = function() {
  document.getElementById('historial-dropdown').style.display='none';
};

window.toggleHistorial = function() {
  const dd = document.getElementById('historial-dropdown');
  dd.style.display = dd.style.display==='none' ? 'block' : 'none';
};

// ══════════════════════════════════
// CONFIRMAR PEDIDO
// ══════════════════════════════════
// Helper UUID v4 (compatible con todos los browsers, sin depender de crypto.randomUUID)
function generarUUID() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    try { return window.crypto.randomUUID(); } catch(e){}
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// Guard global para evitar doble click / doble submit en la misma sesión.
// Se libera al recibir respuesta (éxito o error explícito).
let _enviandoPedido = false;

// ── Mínimos de compra para canal MAYORISTA (suma por presentación, mezclando sabores) ──
// Valores por defecto; se sobreescriben desde config_produccion (editable en panel admin).
let MAYOREO_MINIMOS = { '100g': 10, '250g': 8, '500g': 6, '1kg': 5 };
async function cargarMayoreoCfg() {
  try {
    const cfg = await supabaseCall('POST', 'rpc/get_mayoreo_config', {});
    if (cfg && cfg.ok && cfg.minimos && typeof cfg.minimos === 'object') MAYOREO_MINIMOS = cfg.minimos;
  } catch(_e) {}
}
function esCanalMayorista() {
  const canal = esVendedor ? (canalVenta || '') : (tipoCliente || '');
  return canal === 'mayorista';
}
function sumarCarritoPorPresentacion() {
  const sumas = {};
  Object.values(carrito).forEach(it => { if (it.canje) return; const pres = it.presentacion || ''; sumas[pres] = (sumas[pres] || 0) + (it.qty || 0); });
  return sumas;
}
function validarMinimosMayoreo() {
  if (!esCanalMayorista()) return [];
  const sumas = sumarCarritoPorPresentacion();
  const faltantes = [];
  Object.keys(sumas).forEach(pres => {
    const min = MAYOREO_MINIMOS[pres] || 0;
    if (min > 0 && sumas[pres] < min) faltantes.push({ presentacion: pres, actual: sumas[pres], minimo: min });
  });
  return faltantes;
}

window.confirmarPedido = async function() {
  // ── El OTP es forzoso para pedir ──────────────────────────────────
  // Decisión de Abraham: «no quiero pedidos sin relación de consumidor real».
  // El servidor ya lo exige (crear_pedido devuelve sesion_requerida), pero se
  // comprueba aquí ANTES de armar el pedido para no hacerle perder el carrito a
  // nadie: se guarda a dónde volver y se manda a verificar.
  if (!esVendedor && !telefonoVerif) {
    window._volverAlCheckout = true;
    try { cerrarCarrito(); } catch (_e) {}
    await avisar({
      titulo: 'Ya casi',
      cuerpo: `Verificamos tu número para confirmar el pedido.
Tu carrito se queda como está.`,
      boton: 'Verificar mi número'
    });
    ir('s-otp');
    return;
  }

  // ── Defensa antiduplicados (cliente) ─────────────────────────────
  // 1) Si ya hay una petición en vuelo, ignorar nuevos clicks
  if (_enviandoPedido) {
    mostrarToast('Procesando pedido… espera');
    return;
  }
  _enviandoPedido = true;
  // Safety net: si por cualquier razón el flag queda colgado, liberarlo en 60s
  // para que el vendedor pueda intentar de nuevo en lugar de quedarse atascado.
  const safetyTimer = setTimeout(() => { _enviandoPedido = false; }, 60000);

  // ── Mínimos de compra para canal MAYORISTA ───────────────────────
  const _faltMay = validarMinimosMayoreo();
  if (_faltMay.length) {
    _enviandoPedido = false; clearTimeout(safetyTimer);
    const detalle = _faltMay.map(f => `• ${f.presentacion}: tienes ${f.actual}, mínimo ${f.minimo}`).join('\n');
    await avisar({
      titulo: 'Aún no alcanzas el mínimo de mayoreo',
      cuerpo: 'Falta llegar al mínimo por presentación:' + SALTO + SALTO + detalle + SALTO + SALTO +
              'Agrega más piezas de esas presentaciones para continuar.'
    });
    return;
  }

  const nombre  = document.getElementById('f-nombre').value.trim();
  const cp      = String(document.getElementById('f-cp').value.trim()).padStart(5,'0');
  const colonia = document.getElementById('f-colonia').value.trim();
  const dir     = document.getElementById('f-dir').value.trim();
  const negocio = document.getElementById('f-negocio').value.trim();
  const rfc     = document.getElementById('f-rfc').value.trim();
  const notas   = document.getElementById('f-notas').value.trim();
  const confirm = document.getElementById('chk-confirm').checked;
  const errEl   = document.getElementById('form-err');
  const mun     = document.getElementById('cp-mun').textContent;
  const est     = document.getElementById('cp-est').textContent;
  // Tipo de ESTE pedido. Para un vendedor es el canal elegido; para el cliente
  // web, su propio tipo. Antes se escribía en la global `tipoCliente`, y como
  // `guardarSesion` la persiste, un vendedor que vendía a consumidor heredaba
  // desde su segunda venta el checkout del consumidor (bloque de entrega y
  // guarda del contacto Crunchy). La global no se toca.
  const tipoPedido = (esVendedor && canalVenta) ? canalVenta : tipoCliente;
  const esB2B   = tipoPedido==='tienda'||tipoPedido==='restaurante';

  // Validar RFC B2B
  if (esB2B && rfc) {
    if (!/^([A-ZÑ&]{3,4})(\d{6})([A-Z0-9]{3})$/.test(rfc)) {
      document.getElementById('rfc-err').style.display='block';
      _enviandoPedido = false; clearTimeout(safetyTimer); return;
    }
  }
  document.getElementById('rfc-err').style.display='none';

  // v2.10: Validar mínimo si eligió paquetería (solo aplica a consumidor)
  if (metodoEntrega === 'paqueteria' && tipoCliente === 'consumidor') {
    const subtotal = totalMonto();
    if (subtotal < MIN_PAQUETERIA) {
      mostrarToast(`Para envío por paquetería se requiere mínimo $${MIN_PAQUETERIA} de compra (actual: $${subtotal})`);
      _enviandoPedido = false; clearTimeout(safetyTimer); return;
    }
  }

  // v2.11: Validar contacto vendedor si eligió coordinar (consumidor)
  if (metodoEntrega === 'coordinar' && tipoCliente === 'consumidor' && !_contactoVendedor) {
    mostrarToast('Selecciona a tu contacto Crunchy o elige "Cualquiera me contacte"');
    // Scroll al selector
    document.getElementById('vendedor-selector-wrap')?.scrollIntoView({ behavior:'smooth', block:'center' });
    _enviandoPedido = false; clearTimeout(safetyTimer); return;
  }

  // Validación básica (vendedor en mostrador no necesita dirección)
  // Vendedor en mostrador = usar dirección del punto de venta
  // Pedido interno = no necesita dirección
  const esMostrador = esVendedor && (vendedorInfo?.rol==='Mostrador' || vendedorInfo?.rol==='Administrador');
  const esModoInternoActivo = (modoVenta === 'interno');
  const esInternoCheck = !!(window._pedidoInterno && window._pedidoInterno.tipo);
  const needsDir = !esMostrador && !esInternoCheck;

  // Si está en modo interno pero no eligió tipo, frenar con mensaje claro
  if (esModoInternoActivo && !esInternoCheck) {
    await avisar({
      titulo: 'Falta el motivo del pedido interno',
      cuerpo: `Elige uno antes de confirmar:
Sampling, Consumo, Demo, Regalo o Merma.`
    });
    _enviandoPedido = false; clearTimeout(safetyTimer); return;
  }

  // Para mostrador, pre-llenar con dirección del punto de venta del vendedor
  if (esMostrador) {
    const dirPV = vendedorInfo?.direccionPV || 'Punto de venta Crunchy Paps';
    const cpPV  = vendedorInfo?.cpPV || '03400';
    if (!document.getElementById('f-dir').value) {
      document.getElementById('f-dir').value = dirPV;
    }
    if (!document.getElementById('f-cp').value) {
      document.getElementById('f-cp').value = cpPV;
      buscarCP(cpPV);
    }
  }
  if (!nombre || (needsDir && (!cp||!colonia||!dir)) || !confirm) {
    errEl.classList.add('visible');
    _enviandoPedido = false; clearTimeout(safetyTimer); return;
  }
  errEl.classList.remove('visible');

  const btn = document.getElementById('btn-confirmar');
  btn.disabled=true; btn.innerHTML='<span class="loader"></span> Registrando...';

  // v2.11: Vendedor por CP DEPRECADO. Ahora el cliente elige vendedor por nombre
  // (próximamente con UI de búsqueda) o lo hereda de su historial.
  // Cuando se implementen rutas (preventa/reparto), se agregará lógica aquí.

  // Determinar canal
  // Recalcular zona con CP correcto (con ceros)
  const zonaFinal = detectarZona(cp);
  window._zonaEntrega = zonaFinal;

  // Si es vendedor registrando cliente, usar teléfono del cliente
  const telClienteEl = document.getElementById('f-tel-cliente');
  const telCliente = telClienteEl?.value?.trim();
  const telParaRegistro = (esVendedor && telCliente && telCliente.length === 10)
    ? telCliente : telefonoVerif;

  // REGLA (#3): el teléfono del cliente NO puede ser el del propio vendedor
  if (esVendedor && telCliente && telCliente.length === 10) {
    const telVend = String(vendedorInfo?.telefono || window._telVendedor || telefonoVerif || '').replace(/\D/g, '').slice(-10);
    if (telVend && telVend === telCliente.replace(/\D/g, '').slice(-10)) {
      mostrarToast('El teléfono del cliente no puede ser el tuyo. Usa el número real del cliente.');
      if (telClienteEl) { telClienteEl.focus(); telClienteEl.style.borderColor = '#ff5a5a'; }
      return;
    }
  }

  // ── Detección de pedido interno ──────────────────────────────
  const esPedidoInterno = !!(window._pedidoInterno && window._pedidoInterno.tipo);

  // Para vendedor, el tipo de cliente es el canal seleccionado
  // (`tipoPedido`, declarado arriba, ya lleva el canal del vendedor)
  const canal = esPedidoInterno
    ? 'interno'
    : (esVendedor
        ? (vendedorInfo?.rol==='Mostrador'?'mostrador':'vendedor')
        : 'web');

  // Vendedor del CLIENTE: si hay vendedor logueado, ese es quien lo levantó.
  // Si no, usar el de la zona (caso web). Si tampoco, queda en blanco.
  const vendedorClienteId     = esVendedor ? (vendedorInfo?.id     || '') : (vendedorAsig?.id     || '');
  const vendedorClienteNombre = esVendedor ? (vendedorInfo?.nombre || '') : (vendedorAsig?.nombre || '');

  // Para pedidos internos, NO actualizamos el cliente (es reservado).
  // Para los demás, registrar/actualizar el cliente normalmente.
  let idCliente;
  if (esPedidoInterno) {
    idCliente = clienteActual?.id || 999999;
  } else {
    const tipoParaRegistro = clienteActual?.tipo || TIPO_LABELS[tipoPedido] || tipoPedido;
    // Mapear tipo a tipoId numérico
    const tipoIdMap = {
      'Consumidor': 1, 'consumidor': 1,
      'Restaurante': 2, 'restaurante': 2,
      'Tienda / Abarrotes': 3, 'tienda': 3, 'Tienda': 3,
      'Comerciante': 4, 'Mayorista / Distribuidor': 4, 'Mayorista': 4, 'mayorista': 4,
      'Mostrador': 5, 'mostrador': 5,
    };
    const tipoIdNum = tipoIdMap[tipoParaRegistro] || 1;

    // Fix coordenadas (Opción 1): garantizar coordenada antes de registrar/crear.
    // Cubre el caso de aceptar la dirección precargada sin tocar el mapa.
    if (!dirCoords) { try { await asegurarCoordenadasDesdeFormulario(); } catch (_e) {} }

    // v2.8: registrar/actualizar cliente via Supabase RPC
    const rc = await supabaseCall('POST', 'rpc/registrar_o_actualizar_cliente', {
      p_data: {
        telefono: telParaRegistro,
        nombre,
        tipo: tipoParaRegistro,
        tipoId: tipoIdNum,
        direccion: dir, cp, colonia, municipio: mun, estado: est,
        coordenadas: dirCoords ? `${dirCoords.lat},${dirCoords.lng}` : '',
        idVendedor: vendedorClienteId || null,
        nombreVendedor: vendedorClienteNombre || '',
        rfc,
        aprobadoB2B: clienteActual?.aprobadoB2B || false,
      }
    });
    idCliente = (rc && rc.ok) ? rc.idCliente : (clienteActual?.id || null);
    gaSetUser(idCliente);

    // Opt-in marketing explícito (solo si marcó la casilla)
    try {
      const _aceptaPromos = !!document.getElementById('chk-promos')?.checked;
      if (_aceptaPromos && telParaRegistro) {
        supabaseCall('POST', 'rpc/set_opt_in_promos', {
          p_telefono: telParaRegistro, p_acepta: true, p_origen: 'checkout_web'
        }).catch(() => {});
      }
    } catch (_e) {}
  }

  // Registrar pedido
  // BUG FIX: si el pedido lo está registrando un vendedor logueado, ese vendedor
  // SIEMPRE es quien queda asignado al pedido. vendedorAsig (búsqueda por CP) solo
  // aplica para el cliente nuevo, no para suplantar al vendedor que registró la venta.
  // v2.11: Si es consumidor coordinando, usar el contacto vendedor que eligió en checkout
  let vendedorPedidoId, vendedorPedidoNombre;
  if (esVendedor) {
    vendedorPedidoId     = vendedorInfo?.id || '';
    vendedorPedidoNombre = vendedorInfo?.nombre || '';
  } else if (tipoPedido === 'consumidor' && metodoEntrega === 'coordinar' && _contactoVendedor && _contactoVendedor.id > 0) {
    vendedorPedidoId     = _contactoVendedor.id;
    vendedorPedidoNombre = _contactoVendedor.nombre;
  } else {
    vendedorPedidoId     = vendedorAsig?.id     || '';
    vendedorPedidoNombre = vendedorAsig?.nombre || '';
  }

  // ── Idempotency key: reusar si hay uno persistido (caso reintento), o generar nuevo
  let idempotencyKey;
  try {
    idempotencyKey = sessionStorage.getItem('cp_idem_pedido_actual') || generarUUID();
    sessionStorage.setItem('cp_idem_pedido_actual', idempotencyKey);
  } catch(e) {
    // sessionStorage puede estar deshabilitado (ej. modo privado en Safari)
    idempotencyKey = generarUUID();
  }

  // Fecha de entrega: si se editó en el input usar esa, si no la sugerida del backend
  const fechaEntregaFinal = document.getElementById('f-fecha-entrega')?.value
    || window._fechaEntrega
    || null;

  const items = Object.values(carrito);
  // v2.7: calcular descuento de cupón y total final
  const subtotalCarrito = totalMonto();
  const descuentoCupon = calcularDescuentoCupon(subtotalCarrito);
  // v2.10: Costo de envío si eligió paquetería
  const costoEnvio = (metodoEntrega === 'paqueteria' && tipoPedido === 'consumidor' && !esPedidoInterno) ? COSTO_PAQUETERIA : 0;
  // v2.10: descuento envío si cupón es envio_gratis
  const descuentoEnvio = calcularDescuentoEnvio(costoEnvio);
  const totalFinal = esPedidoInterno ? 0 : Math.max(0, subtotalCarrito - descuentoCupon + costoEnvio - descuentoEnvio);

  let rp;
  try {
    // v2.8: registrar pedido via Supabase RPC crear_pedido (atómico)
    const payload = {
      canal,
      // 18 sep 2026: con sesión de vendedor, crear_pedido cobra el nivel que dice
      // esta clave (sin ella, consumidor). Faltaba: una venta de vendedor a tienda
      // o el 500g de mostrador volvían con precio_cambiado. Mismo criterio que getPrecio.
      tipoCliente: !esVendedor ? tipoPedido
        : (['tienda', 'restaurante', 'mayorista'].includes(tipoPedido) ? tipoPedido
          : ((tipoPedido === 'mostrador' || vendedorInfo?.rol === 'Mostrador') ? 'mostrador' : 'consumidor')),
      idempotencyKey,
      idCliente: idCliente || null,
      nombreCliente: nombre,
      telefono: telefonoVerif,
      idVendedor: vendedorPedidoId || null,
      nombreVendedor: vendedorPedidoNombre || '',
      tipoPagoId, tipoPago: tipoPagoNom,
      total: totalFinal,
      subtotal: subtotalCarrito,
      descuento: descuentoCupon,
      cuponCodigo: _cuponEnCarrito?.codigo || '',
      tokenCliente: (typeof tokenCliente === 'function' ? tokenCliente() : ''),
      // 17 sep 2026: crear_pedido cobra el envío por esta clave. Sin ella el
      // servidor calculaba $0 de envío y rechazaba con precio_cambiado.
      metodoEntrega: (tipoPedido === 'consumidor' && !esPedidoInterno) ? metodoEntrega : 'coordinar',
      // v2.10: notas enriquecidas con método de entrega (solo consumidor)
      notas: (() => {
        let n = notas || '';
        // Solo agregar etiqueta de método de entrega para consumidor
        if (tipoPedido !== 'consumidor' || esPedidoInterno) {
          return n;
        }
        let etiqueta;
        if (metodoEntrega === 'paqueteria') {
          if (descuentoEnvio > 0) {
            etiqueta = `[ENTREGA: Paquetería enviatodo.com — cupón ${_cuponEnCarrito.codigo} envío gratis aplicado]`;
          } else {
            etiqueta = `[ENTREGA: Paquetería enviatodo.com — +$${COSTO_PAQUETERIA}]`;
          }
        } else {
          etiqueta = '[ENTREGA: Coordinar con contacto]';
        }
        return n ? `${etiqueta}\n${n}` : etiqueta;
      })(),
      tipoInterno: esPedidoInterno ? window._pedidoInterno.tipo : '',
      cp, colonia, municipio: mun, estado: est, direccion: dir,
      zonaEntrega: window._zonaEntrega?.zona || 'cdmx',
      // Mediodía de CDMX: new Date('AAAA-MM-DD') es medianoche UTC, que en México ya es el día anterior.
      fechaEntrega: fechaEntregaFinal ? new Date(fechaEntregaFinal + 'T12:00:00-06:00').toISOString() : null,
      coordenadas: dirCoords ? `${dirCoords.lat},${dirCoords.lng}` : '',
      productos: items.map(i => ({
        idProducto: i.idProducto || '', sabor: i.sabor, presentacion: i.presentacion,
        tipoVenta: i.tipoVenta, cantidad: i.qty || 0,
        caja: i.caja || 0,
        monto: i.monto || 0, precioKg: i.precioKg || 220,
        precio: i.precio || 0,
        precioOriginal: i.precioOriginal || i.precio || 0,
        descuento: i.descuento || 0,
        gramos: i.gramos || 0,
        subtotal: subLinea(i),
        canje: !!i.canje, puntos: i.canje ? (Number(i.puntos) || 0) : 0,
      })),
      puntosCanje: puntosCanjeCarrito(),
    };
    rp = await supabaseCall('POST', 'rpc/crear_pedido', { p_data: payload });
  } catch(e) {
    // Error de red / timeout. NO limpiar idempotency key.
    _enviandoPedido = false; clearTimeout(safetyTimer);
    btn.disabled = false; btn.textContent = 'Confirmar pedido';
    await avisar({
      titulo: 'No se pudo enviar el pedido',
      cuerpo: (e.message || 'Sin conexión') + SALTO + SALTO +
              'Intenta de nuevo. Si el pedido sí llegó a registrarse, no se duplicará.',
      boton: 'Reintentar'
    });
    return;
  }

  // ── El servidor puede RECHAZAR el pedido ──────────────────────────────
  // Desde la parte 2 lo hace de verdad: precio que no cuadra, sesión que falta,
  // producto que ya no existe. Antes de este guard el código SEGUÍA de largo con
  // el folio 'WEB-?????' y le enseñaba al cliente una pantalla de gracias por un
  // pedido que no existía. Casi nunca saltaba —el RPC casi nunca decía que no—,
  // y por eso nadie lo vio.
  if (!rp || !rp.ok) {
    _enviandoPedido = false; clearTimeout(safetyTimer);
    btn.disabled = false; btn.textContent = 'Confirmar pedido';
    // NO se limpia la llave de idempotencia: el pedido no se creó, y si el
    // cliente reintenta debe reusarla para no duplicar si la primera sí entró.
    var _err = (rp && rp.error) || 'desconocido';
    var _msg = (rp && rp.mensaje) || '';

    if (_err === 'precio_cambiado') {
      await avisar({
        titulo: 'El precio cambió mientras armabas tu pedido',
        cuerpo: 'Tu total: $' + Number(rp.totalEnviado || 0).toLocaleString('es-MX') + SALTO +
                'Total correcto: $' + Number(rp.totalCorrecto || 0).toLocaleString('es-MX') + SALTO + SALTO +
                'Revisa tu carrito y confirma de nuevo.',
        boton: 'Revisar mi carrito'
      });
    } else if (_err === 'sesion_requerida') {
      // Igual que la guarda del OTP forzoso: se cierra el carrito ANTES de
      // navegar —el cajón es fijo y tapaba la pantalla de OTP— y se marca la
      // vuelta al checkout para que el cliente regrese a su pedido.
      window._volverAlCheckout = true;
      try { cerrarCarrito(); } catch (_e) {}
      await avisar({
        titulo: 'Falta verificar tu teléfono',
        cuerpo: 'Para completar tu pedido necesitamos confirmar tu número.',
        boton: 'Verificar ahora'
      });
      try { ir('s-otp'); } catch (_e) {}
    } else if (['canje_sin_compra', 'canje_maximo', 'saldo_insuficiente', 'puntos_cambiados', 'canje_no_disponible', 'canje_sin_cliente'].includes(_err)) {
      await avisar({ titulo: 'Revisa tu canje de puntos', cuerpo: _msg || 'No se pudo aplicar el canje.', boton: 'Revisar mi carrito' });
      if (_err === 'puntos_cambiados' || _err === 'saldo_insuficiente') { try { await abrirTiendaCanje(); abrirCarrito(); } catch (_e) {} }
    } else if (_err === 'producto_no_encontrado' || _err === 'granel_sin_precio') {
      await avisar({
        titulo: 'Un producto ya no está disponible',
        cuerpo: (_msg || 'Uno de los productos de tu carrito ya no está disponible.') + SALTO + SALTO +
                'Quítalo del carrito e intenta de nuevo.',
        boton: 'Revisar mi carrito'
      });
    } else {
      await avisar({
        titulo: 'No se pudo registrar el pedido',
        cuerpo: (_msg || _err) + SALTO + SALTO +
                'Intenta de nuevo. Si el pedido sí llegó a registrarse, no se duplicará.',
        boton: 'Reintentar'
      });
    }
    return;
  }

  // Limpiar idempotency key sólo si la respuesta fue OK (incluso si fue duplicado detectado)
  if (rp && rp.ok) {
    try { sessionStorage.removeItem('cp_idem_pedido_actual'); } catch(e) {}
    if (rp.duplicado) {
      mostrarToast('ℹ️ Este pedido ya estaba registrado: ' + (rp.consecutivo||'—'));
    }
    // v2.7.5: si había cupón aplicado y no es duplicado, registrar uso vía Supabase RPC
    if (_cuponEnCarrito && !rp.duplicado && !esPedidoInterno) {
      try {
        await supabaseCall('POST', 'rpc/aplicar_cupon', {
          p_codigo: _cuponEnCarrito.codigo,
          p_id_cliente: idCliente || null,
          p_telefono: String(telParaRegistro || '').replace(/\D/g, '').slice(-10) || null,
          p_id_orden: String(rp.idOrden || rp.consecutivo || ''),
          p_monto_descuento: descuentoCupon,
        });
      } catch(e) { /* no bloquear el flujo si falla el registro de uso */ }
      // Mantener la referencia para el mensaje WhatsApp; se limpiará al cerrar carrito
    }
  }
  // Liberar el guard antiduplicado independientemente del resultado
  _enviandoPedido = false; clearTimeout(safetyTimer);

  // Construir mensaje WhatsApp
  // Llegar aquí implica rp.ok: el guard de arriba corta cualquier otro caso.
  const consec     = rp.consecutivo;

  // Sampling/Regalo a persona NUEVA → registrar PROSPECTO enlazado (no bloquea el pedido)
  if (rp && rp.ok && !rp.duplicado && esPedidoInterno && !clienteActual?.id) {
    const _tipoInt = window._pedidoInterno?.tipo;
    const _telPros = String(telParaRegistro || telefonoVerif || '').replace(/\D/g, '').slice(-10);
    if ((_tipoInt === 'sampling' || _tipoInt === 'regalo' || _tipoInt === 'bonificacion') && _telPros.length === 10) {
      supabaseCall('POST', 'rpc/registrar_prospecto_desde_interno', {
        p_data: {
          nombre,
          tipo: 'consumidor',
          telefono: _telPros,
          lat: dirCoords?.lat ?? null,
          lng: dirCoords?.lng ?? null,
          coordenadas: dirCoords ? `${dirCoords.lat},${dirCoords.lng}` : '',
          notas: `Generado por ${_tipoInt} ${consec}`,
          estatus: 'sampling',
          origen: _tipoInt,
          id_orden: rp.idOrden || null,
          consecutivo: consec,
          id_vendedor: vendedorInfo?.id || null,
          nombre_vendedor: vendedorInfo?.nombre || '',
        }
      }).catch(() => {});
    }
  }

  // GA4: evento de compra (excluye pedidos internos)
  if (rp && rp.ok && !esPedidoInterno) {
    try { track('purchase', { transaction_id: String(consec), value: Number(totalFinal) || 0, currency: 'MXN', coupon: (_cuponEnCarrito && _cuponEnCarrito.codigo) || undefined, items: items.length }); } catch (_e) {}
  }
  const fecha      = new Date().toLocaleString('es-MX',{dateStyle:'short',timeStyle:'short'});
  const lineas     = items.map(i=>{
    const sub = subLinea(i);
    const desc = i.tipoVenta==='A granel'?`${i.gramos}g`:(i.caja?`${i.cajas} caja${i.cajas===1?'':'s'} de ${i.caja} (${i.qty} pz)`:`×${i.qty}`);
    if (i.canje) return `• *${i.sabor}* ${i.presentacion} ${desc} = canje · ${(i.qty * i.puntos).toLocaleString('es-MX')} pts`;
    return `• *${i.sabor}* ${i.presentacion} ${desc} = $${sub}`;
  }).join('\n');

  // v2.7.2 / v2.10: bloque de totales con cupón y/o envío si aplica
  const huboCupon = !!(_cuponEnCarrito && descuentoCupon > 0);
  const huboEnvio = costoEnvio > 0;
  const huboDescEnvio = descuentoEnvio > 0;
  let bloqueTotales;
  if (huboCupon || huboEnvio || huboDescEnvio) {
    const lineas = [`*Subtotal:* $${subtotalCarrito.toLocaleString('es-MX')}`];
    if (huboCupon) {
      lineas.push(`*Cupón ${_cuponEnCarrito.codigo}:* -$${descuentoCupon.toLocaleString('es-MX')}`);
    }
    if (huboEnvio) {
      lineas.push(`*Envío paquetería:* +$${costoEnvio.toLocaleString('es-MX')}`);
    }
    if (huboDescEnvio) {
      lineas.push(`*Cupón envío gratis (${_cuponEnCarrito.codigo}):* -$${descuentoEnvio.toLocaleString('es-MX')}`);
    }
    lineas.push(`*Total:* $${totalFinal.toLocaleString('es-MX')}`);
    bloqueTotales = lineas.join('\n');
  } else {
    bloqueTotales = `*Total:* $${totalFinal.toLocaleString('es-MX')}`;
  }

  const msgWpp =
`*NUEVO PEDIDO — Crunchy Paps*
No. *${consec}*
━━━━━━━━━━━━━━━━━━
*Canal:* ${(TIPO_LABELS[tipoPedido]||tipoPedido).toUpperCase()}
*Cliente:* ${nombre}
*Tel:* +52 ${telefonoVerif}
${negocio?`*Negocio:* ${negocio}\n`:''}${rfc?`*RFC:* ${rfc}\n`:''}━━━━━━━━━━━━━━━━━━
*C.P.:* ${cp}
*Colonia:* ${colonia}
*Municipio:* ${mun}, ${est}
*Dirección:* ${dir}
━━━━━━━━━━━━━━━━━━
*Productos:*
${lineas}
━━━━━━━━━━━━━━━━━━
${bloqueTotales}
*Pago:* ${tipoPagoNom}
*Zona:* ${zonaFinal.label}${zonaFinal.entrega !== 'normal' ? ' — requiere coordinación de envío' : ''}
${notas?`*Notas:* ${notas}\n`:''}${fecha}
_Pedido registrado #${consec}_`;

  // Número WhatsApp del vendedor asignado
  // v2.11: Si consumidor eligió un contacto específico con teléfono, mandarle a él
  let telVendedor = WHATSAPP_NUM;  // default: número general
  if (tipoPedido === 'consumidor' && metodoEntrega === 'coordinar' && _contactoVendedor && _contactoVendedor.id > 0) {
    // Buscar el teléfono del contacto en el cache
    const cached = (_vendedoresCheckoutCache || []).find(v => v.id === _contactoVendedor.id);
    const telCached = cached?.telefono;
    if (telCached) {
      // Normalizar a 10 dígitos y agregar prefijo 521 (formato wa.me México)
      const tel10 = String(telCached).replace(/\D/g, '').slice(-10);
      if (tel10.length === 10) telVendedor = '521' + tel10;
    }
  }
  // B2B: el resumen va al asesor asignado en la ficha si sigue activo. La lista
  // pública (buscar_vendedores, modo checkout) solo devuelve activos con rol de
  // atención, así que un vendedor dado de baja cae solo al número del negocio.
  // Sin nombre en pantalla: el asesor rota y la tienda no debe quedar ligada a
  // una persona (Abraham, 14 sep 2026). Sin copia al negocio: el pedido ya está
  // en el panel, y abrir dos WhatsApp seguidos lo bloquea iOS.
  const esB2BPedido = !esVendedor && (tipoPedido === 'tienda' || tipoPedido === 'restaurante' || tipoPedido === 'mayorista');
  let asesorActivo = false;
  if (esB2BPedido && vendedorAsig?.id) {
    try {
      const lista = await cargarVendedoresCheckout();
      const v = (lista || []).find(x => Number(x.id) === Number(vendedorAsig.id));
      const tel10 = String(v?.telefono || '').replace(/\D/g, '').slice(-10);
      if (tel10.length === 10) { telVendedor = '521' + tel10; asesorActivo = true; }
    } catch (_e) { /* sin lista: al negocio */ }
  }
  const wppVendedor = `https://wa.me/${telVendedor}?text=${encodeURIComponent(msgWpp)}`;
  const wppBodega   = `https://wa.me/${WHATSAPP_BODEGA}?text=${encodeURIComponent(msgWpp)}`;
  wppUrlPend = { vendedor: wppVendedor, bodega: wppBodega };

  // Puntos ganados (los internos NO generan puntos: sampling, consumo, demo, regalo, merma)
  const ptosGanados = (esPedidoInterno || esCanalMayorista()) ? 0 : Math.floor(totalMonto()/10);

  // Pago en línea (Stripe): guarda el resumen y redirige a la página segura.
  // Al volver, se reconstruye esta misma pantalla de ¡Gracias! con sus botones de WhatsApp.
  if (tipoPagoId === 5 && rp && rp.ok) {
    try {
      btn.textContent = 'Redirigiendo a pago seguro…';
      localStorage.setItem('cp_gracias_pendiente', JSON.stringify({
        consec,
        b2b: esB2BPedido && !esPedidoInterno, asesor: asesorActivo,
        puntos: ptosGanados,
        wppVendedor, wppBodega,
      }));
      const urlPago = await crearCheckoutStripe(rp.idOrden);
      window.location.href = urlPago;
      return;
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Confirmar pedido';
      await avisar({ titulo: 'No se pudo iniciar el pago con tarjeta', cuerpo: (err.message || '') + SALTO + SALTO +
            'Tu pedido quedó guardado. Intenta pagar de nuevo.' });
      return;
    }
  }

  cerrarCarrito();
  btn.disabled=false;
  btn.innerHTML='Confirmar pedido';

  // Mostrar gracias
  document.getElementById('g-consec').textContent = consec;
  // Sin nombre de persona: el asesor rota y la tienda no queda ligada a nadie (Abraham, 14 sep 2026).
  document.getElementById('g-vendedor').textContent = '';
  // Puntos se ganan al confirmar pago, no al hacer pedido
  document.getElementById('g-puntos').textContent = ptosGanados>0 ? `+${ptosGanados} puntos al confirmar tu pago` : '';
  pintarGraciasB2B(esB2BPedido && !esPedidoInterno, asesorActivo);
  document.getElementById('gracias-overlay').classList.add('visible');
  // El pedido ya está registrado: el carrito se vacía aquí, no solo al cerrar «¡Gracias!». Si el
  // cliente cerraba la app en esta pantalla, al volver le reaparecía el pedido completo (y con el
  // canje, piezas «canjeadas» con puntos que ya no tiene). El resumen de WhatsApp ya va armado.
  carrito = {}; actualizarBadge();

  // v2.11.1: refrescar stats del cliente en background para que historial y "Mi cuenta" se actualicen
  if (telefonoVerif && !esPedidoInterno) {
    setTimeout(() => { cargarDatosCliente(); }, 1500);  // pequeño delay para que el trigger de BD termine
  }
};

window.abrirTrackingDesdeGracias = function() {
  const consec = document.getElementById('g-consec').textContent;
  if (!consec) return;
  // Cerrar pantalla gracias y resetear estado
  cerrarGracias();
  // Abrir tracking
  setTimeout(() => abrirTracking(consec), 200);
};

// iOS Safari bloquea window.open() cuando llega después de un await (lo trata como
// ventana emergente). La pestaña se abre en el gesto del usuario, vacía, y se le
// pone la URL al terminar. Si no se pudo abrir: en el teléfono se navega en la
// misma pestaña (wa.me abre la app y la PWA sigue detrás); en escritorio se
// intenta window.open como siempre.
function abrirVentanaPendiente() {
  try { return window.open('about:blank', '_blank'); } catch (e) { return null; }
}
function cerrarVentanaPendiente(v) { try { if (v && !v.closed) v.close(); } catch (e) {} }
function irAWhatsApp(v, url) {
  if (v && !v.closed) { v.location.href = url; return; }
  if (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent)) { window.location.href = url; return; }
  window.open(url, '_blank');
}

// Caja B2B de la pantalla de gracias. Con asesor activo: «Tu asesor Crunchy te
// contacta para coordinar la entrega»; sin asesor: «Te contactamos…». Nunca un
// nombre. También la usa la vuelta de Stripe, que reconstruye la pantalla.
function pintarGraciasB2B(mostrar, conAsesor) {
  const caja = document.getElementById('g-entrega-b2b');
  if (!caja) return;
  caja.style.display = mostrar ? 'block' : 'none';
  const t = document.getElementById('g-b2b-txt');
  if (t) t.textContent = conAsesor ? 'Tu asesor Crunchy te contacta' : 'Te contactamos';
}

window.enviarWpp = function() {
  if (!wppUrlPend) return;
  window.open(wppUrlPend.vendedor, '_blank');
  // Enviar a bodega si es número diferente
  if (WHATSAPP_BODEGA !== WHATSAPP_NUM) {
    setTimeout(() => window.open(wppUrlPend.bodega, '_blank'), 1000);
  }
  const btn=document.getElementById('g-btn-wpp');
  btn.textContent='✓ Resumen enviado'; btn.disabled=true; btn.style.background='#1a7a3a';
};

// v2.10: enviar resumen a otro contacto (abre WhatsApp para que el usuario elija)
window.enviarWppOtro = function() {
  if (!wppUrlPend) { mostrarToast('Sin datos del pedido'); return; }
  // Extraer el texto codificado del URL del vendedor
  const match = wppUrlPend.vendedor.match(/wa\.me\/\d+\?text=(.*)$/);
  const textParam = match && match[1] ? match[1] : '';
  if (!textParam) {
    mostrarToast('No hay texto de resumen para compartir');
    return;
  }
  // Usar wa.me/?text=... (sin número) → WhatsApp abre el selector de contacto
  // En móviles abre la app, en desktop abre web.whatsapp.com con selector
  const url = `https://wa.me/?text=${textParam}`;
  window.open(url, '_blank');
  mostrarToast('Elige el contacto en WhatsApp');
};

window.cerrarGracias = function() {
  document.getElementById('gracias-overlay').classList.remove('visible');
  wppUrlPend=null;
  // Reset
  carrito={}; actualizarBadge();
  window._pedidoInterno = null; // limpiar marca interna para próximo pedido
  _cuponEnCarrito = null; // v2.7.2: limpiar cupón aplicado del pedido anterior
  // Si estaba en modo interno, volver a pieza
  if (modoVenta === 'interno') {
    modoVenta = 'pieza';
    aplicarModoVenta();
  }
  // Resetear header al vendedor (evita que se quede pegado el cliente del pedido anterior)
  resetHeaderVendedor();
  // Limpiar coordenadas y datos del cliente para próximo pedido
  dirCoords = null;
  vendedorAsig = null;
  _contactoVendedor = null;  // v2.11: limpiar contacto seleccionado
  ['f-nombre','f-cp','f-dir','f-notas','f-negocio','f-rfc','f-tel-cliente'].forEach(id=>{
    const el=document.getElementById(id); if(el) el.value='';
  });
  document.getElementById('f-colonia').innerHTML='<option value="">Colonia *</option>';
  document.getElementById('chk-confirm').checked=false;
  document.getElementById('cp-info').style.display='none';
  document.getElementById('mapa-wrap').style.display='none';
  mapInstance=null; markerInstance=null;
  document.getElementById('mapa-div').innerHTML='';
  document.getElementById('puntos-chip').style.display='none';

  // Reset botón wpp
  const bw=document.getElementById('g-btn-wpp');
  bw.innerHTML=`<svg viewBox="0 0 24 24" style="width:18px;height:18px;fill:white"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>Enviar resumen por WhatsApp`;
  bw.disabled=false; bw.style.background='var(--verde)';

  renderCatalogo();
};

// ══════════════════════════════════
// SHEETS API — via proxy Netlify
// ══════════════════════════════════
// ══════════════════════════════════════════════════════════════════
// PERFORMANCE MONITOR (v2.7.3) — solo admin
// Mide tiempos de navegación entre secciones y llamadas a Sheets.
// ══════════════════════════════════════════════════════════════════
const PERF = {
  log: [],
  enabled: false,
  pendientes: {},  // por accion: { ts }
};

function perfPush(line, color) {
  if (!PERF.enabled) return;
  PERF.log.unshift({ t: new Date(), line, color: color || '#ddd' });
  if (PERF.log.length > 60) PERF.log = PERF.log.slice(0, 60);
  perfRender();
}

function perfRender() {
  const el = document.getElementById('perf-log');
  if (!el) return;
  el.innerHTML = PERF.log.map(e => {
    const hh = String(e.t.getHours()).padStart(2,'0');
    const mm = String(e.t.getMinutes()).padStart(2,'0');
    const ss = String(e.t.getSeconds()).padStart(2,'0');
    return `<div style="color:${e.color};"><span style="color:#666;">${hh}:${mm}:${ss}</span> ${e.line}</div>`;
  }).join('');
}

window.perfClear = function() {
  PERF.log = [];
  perfRender();
};

window.perfShow = function() {
  PERF.enabled = true;
  document.getElementById('perf-monitor').style.display = 'block';
  perfPush('Monitor activado', '#FFD200');
};

window.perfHide = function() {
  PERF.enabled = false;
  document.getElementById('perf-monitor').style.display = 'none';
};

// Mostrar automáticamente para admin
function activarPerfSiAdmin() {
  if (typeof esAdmin === 'function' && esAdmin()) {
    perfShow();
  }
}

// Helpers de medición
function perfStartNav(seccion) {
  if (!PERF.enabled) return null;
  return { tipo: 'nav', label: seccion, t0: performance.now() };
}
function perfEndNav(handle) {
  if (!handle || !PERF.enabled) return;
  const ms = Math.round(performance.now() - handle.t0);
  const color = ms < 200 ? '#4caf50' : ms < 700 ? '#FFD200' : '#ff8888';
  perfPush(`📺 nav→${handle.label}: <b style="color:${color};">${ms}ms</b>`, '#bbb');
}


async function sheetsCall(payload) {
  const accion = payload?.accion || 'desconocida';
  // /api/sheets era el único backend que no pedía credencial alguna: bastaba
  // un POST desde cualquier parte para escribir inventario o inyectar
  // prospectos. Ahora viaja el token de sesión y el servidor comprueba la
  // sección antes de tocar nada.
  const _tk = (typeof tokenVendedor === 'function') ? tokenVendedor() : null;
  if (_tk && payload && typeof payload === 'object' && payload.token === undefined) {
    payload = { ...payload, token: _tk };
  }
  const t0 = (typeof PERF !== 'undefined' && PERF.enabled) ? performance.now() : 0;
  try {
    const res = await fetch('/api/sheets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (t0) {
      const ms = Math.round(performance.now() - t0);
      const color = ms < 200 ? '#4caf50' : ms < 700 ? '#FFD200' : '#ff8888';
      perfPush(`🌐 ${accion}: <b style="color:${color};">${ms}ms</b>`, '#999');
    }
    return data;
  } catch(e) {
    if (t0) {
      const ms = Math.round(performance.now() - t0);
      perfPush(`🌐 ${accion}: <b style="color:#ff8888;">ERROR ${ms}ms</b>`, '#ff8888');
    }
    throw e;
  }
}

// ════════════════════════════════════════════════════════════════
// SUPABASE helper — Fase 1 migración (solo bebidas por ahora)
// ════════════════════════════════════════════════════════════════
// Etapa B: token de sesión del vendedor. Los RPCs protegidos lo exigen; sin él
// la base responde "Sesión inválida o expirada" y no devuelve datos.
// Token de cliente. Para los RPCs que aceptan ambos, manda el de vendedor
// cuando lo hay: un vendedor consultando a un cliente debe identificarse
// como vendedor, no como el cliente que además pueda ser.
function tokenCliente() {
  return clienteToken || '';
}
function tokenParaConsultaCliente() {
  return esVendedor ? tokenVendedor() : tokenCliente();
}

function tokenVendedor() {
  return (vendedorInfo && vendedorInfo.token) ? vendedorInfo.token : '';
}

// Un RPC protegido devuelve { ok:false, error:'Sesión inválida o expirada' }
// cuando el token venció (12 h) o se revocó. En ese caso hay que volver a
// entrar: no tiene sentido reintentar.
function sesionExpirada(res) {
  return res && res.ok === false && /Sesión inválida o expirada/.test(res.error || '');
}

async function supabaseCall(method, path, body, opciones) {
  // Etapa B: inyectar el token de sesión en las llamadas que usan la
  // convención `p_data`. Se hace aquí y no en cada punto de llamada porque son
  // más de 30, y treinta ediciones a mano es donde se cuela el olvido.
  //
  // Solo se toca `p_data`: añadir una clave a un objeto JSON es inofensivo para
  // los RPCs que no la leen. Lo que NO se puede hacer aquí es añadir un
  // parámetro suelto como `p_token`, porque cambiaría la firma y PostgREST no
  // encontraría la función. Los tres RPCs con argumentos posicionales lo pasan
  // explícitamente en su propia llamada.
  if (body && typeof body === 'object' &&
      body.p_data && typeof body.p_data === 'object' && !Array.isArray(body.p_data)) {
    const _tk = tokenVendedor();
    if (_tk && body.p_data.token === undefined) {
      body = { ...body, p_data: { ...body.p_data, token: _tk } };
    }
  }
  const t0 = (typeof PERF !== 'undefined' && PERF.enabled) ? performance.now() : 0;
  const url = SUPABASE_URL + '/rest/v1/' + path;
  const opts = {
    method,
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  // `keepalive` deja que la petición sobreviva al cierre de la pestaña. Lo usa
  // la descarga de eventos (PLAN.md §3.3); `sendBeacon` no sirve para esto
  // porque no admite cabeceras propias y Supabase exige `apikey`.
  if (opciones && opciones.keepalive) opts.keepalive = true;
  try {
    const res = await fetch(url, opts);
    const data = await res.json();
    if (t0) {
      const ms = Math.round(performance.now() - t0);
      const color = ms < 200 ? '#4caf50' : ms < 700 ? '#FFD200' : '#ff8888';
      const shortPath = path.split('?')[0];
      perfPush(`⚡ supabase ${method} ${shortPath}: <b style="color:${color};">${ms}ms</b>`, '#4caf50');
    }
    return data;
  } catch(e) {
    if (t0) {
      const ms = Math.round(performance.now() - t0);
      perfPush(`⚡ supabase ERROR: ${e.message} (${ms}ms)`, '#ff8888');
    }
    throw e;
  }
}

// ════════════════════════════════════════════════════════════════
// Helper para cargar el catálogo COMPLETO desde Supabase
// (papas + bebidas en paralelo, una llamada cada una)
// ════════════════════════════════════════════════════════════════
async function cargarCatalogoSupabase() {
  const [papasResp, bebidasResp] = await Promise.all([
    supabaseCall('GET', 'productos?select=*&order=sabor.asc,presentacion.asc').catch(() => []),
    supabaseCall('GET', 'productos_bebidas?select=*&order=id.asc').catch(() => []),
  ]);
  const papas = Array.isArray(papasResp) ? papasResp : [];
  const bebidas = Array.isArray(bebidasResp) ? bebidasResp : [];

  const productos = [];
  // Papas (mantenemos campos ya conocidos por frontend)
  papas.forEach(p => {
    productos.push({
      id: p.id,
      sabor: p.sabor,
      presentacion: p.presentacion,
      gramos: Number(p.gramos) || 0,
      precio_consumidor: Number(p.precio_consumidor) || 0,
      precio_tienda: Number(p.precio_tienda) || 0,
      precio_restaurante: Number(p.precio_restaurante) || 0,
      precio_mayorista: Number(p.precio_mayorista) || 0,
      precio_mostrador: Number(p.precio_mostrador) || 0,
      precio_granel_kg: Number(p.precio_granel_kg) || 0,
      precio_caja_3:  Number(p.precio_caja_3)  || 0,
      precio_caja_6:  Number(p.precio_caja_6)  || 0,
      precio_caja_12: Number(p.precio_caja_12) || 0,
      tipo_venta: Number(p.tipo_venta) || 1,
      imagen_url: p.imagen_url || '',
      descripcion: p.descripcion || '',
      orden: (p.orden != null ? Number(p.orden) : null),
      descuento_pct: Number(p.descuento_pct) || 0,
      categoria: 'papa',
      activo: p.activo !== false,
    });
  });
  // Bebidas (mismo formato que ya esperaba el frontend)
  bebidas.forEach(b => {
    productos.push({
      id: 'b' + b.id,
      sabor: b.nombre,
      presentacion: [b.tipo_bebida, b.sabor, b.presentacion].filter(Boolean).join(' · ') || (b.presentacion || ''),
      gramos: 0,
      precio_consumidor: Number(b.precio) || 0,
      precio_tienda: Number(b.precio) || 0,
      precio_restaurante: Number(b.precio) || 0,
      precio_mayorista: Number(b.precio) || 0,
      precio_mostrador: Number(b.precio) || 0,
      precio_granel_kg: 0,
      tipo_venta: 1,
      imagen_url: b.imagen_url || '',
      descripcion: b.descripcion || '',
      orden: (b.orden != null ? Number(b.orden) : null),
      descuento_pct: 0,
      categoria: 'bebida',
      tipo_bebida: b.tipo_bebida || '',
      codigo_barras: b.codigo_barras || '',
      activo: b.activo !== false,
      sabor_bebida: b.sabor || '',
    });
  });
  return productos;
}

window.navegar = window.navegar; // ya existe, solo extendemos

// Mostrar navbar de producción solo para vendedores
function mostrarNavProduccion() {
  const navProd = document.getElementById('nav-produccion');
  if (navProd && esVendedor) navProd.style.display = 'flex';
}


// ══════════════════════════════════
// CANJE DE PUNTOS
// ══════════════════════════════════
window.calcCanje = function(val) {
  const pts = parseInt(val) || 0;
  const descuento = Math.floor(pts / 100) * 10;
  document.getElementById('canje-resultado').textContent = '$' + descuento;
};

// DESARMADA el 5 sep 2026. Lo que hacía antes: calculaba un descuento, lo
// guardaba en `window._canjeActivo` y le prometía al cliente que se aplicaría
// en su próximo pedido. `_canjeActivo` no se leía en NINGUNA otra línea del
// archivo, así que el descuento no llegaba nunca y los puntos tampoco se
// descontaban — no había una sola llamada al servidor.
//
// Se conserva la función, sin efecto, porque puede quedar algún `onclick` en
// una versión cacheada de la PWA: mejor un aviso honesto que un ReferenceError.
//
// La redención de verdad tiene que decidirse en Postgres —RPC con tope y
// asiento en `lealtad_movimientos`—, no en el navegador: la comprobación vieja
// era `pts > puntos` contra una variable local, y cualquiera con la consola
// abierta se habría regalado el descuento.
window.aplicarCanje = function() {
  avisar({ titulo: 'Muy pronto', cuerpo: 'El canje de puntos estará disponible muy pronto. Tus puntos se siguen acumulando y vencen 12 meses después de ganarlos.' });
};


// ══════════════════════════════════
// NAVBAR Y NAVEGACIÓN
// ══════════════════════════════════
window.cerrarSesion = async function() {
  if (!(await confirmar({ titulo: '¿Cerrar sesión?', aceptar: 'Cerrar sesión' }))) return;
  // Etapa B: revocar el token en el servidor. Sin esto, salir del navegador no
  // invalida nada: el token seguiría sirviendo hasta expirar (12 h).
  // Sin await a propósito — cerrar sesión no debe quedarse esperando a la red.
  const _tok = tokenVendedor();
  if (_tok) {
    try { supabaseCall('POST', 'rpc/cerrar_sesion_vendedor', { p_data: { token: _tok } }); } catch (_e) {}
  }
  // Resetear estado
  tipoCliente=''; esVendedor=false; vendedorInfo=null;
  telefonoVerif=''; clienteActual=null; vendedorAsig=null;
  puntos=0; carrito={};
  actualizarBadge();
  // Ocultar navbar
  document.getElementById('navbar').style.display='none';
  document.getElementById('mini-cart').classList.remove('visible');
  limpiarSesion();
  ir('s-welcome');
};

window.cerrarCambioPin = function() {
  const f = document.getElementById('pin-form');
  const b = document.getElementById('pin-abrir');
  if (f) f.style.display = 'none';
  if (b) b.style.display = '';
  // No dejar los PIN escritos en el DOM después de cerrar.
  ['pin-actual','pin-nuevo','pin-nuevo2'].forEach(id => {
    const e = document.getElementById(id); if (e) e.value = '';
  });
  const m = document.getElementById('pin-msg'); if (m) m.textContent = '';
};

window.renderCuenta = function() {
  const _inv = document.getElementById('cuenta-invitado');
  if (!telefonoVerif) {
    // No se oculta nada por debajo: los campos se rellenan como invitado y el
    // panel de arriba explica qué falta. Ocultar bloques exigiría envolver la
    // pantalla entera, y ese cambio estructural no vale el riesgo aquí.
    if (_inv) _inv.style.display = '';
    const pon = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
    pon('cuenta-nombre', 'Invitado');
    pon('cuenta-tipo', 'Sin registrar');
    pon('cuenta-tel', '—');
    pon('cuenta-pedidos', '0');
    pon('cuenta-total', '$0');
    pon('cuenta-puntos', '0');
    return;
  }
  if (_inv) _inv.style.display = 'none';
  const tel = telefonoVerif.replace(/(\d{2})(\d{4})(\d{4})/, '+52 $1 $2 $3');
  document.getElementById('cuenta-tel').textContent = tel;

  // El cambio de PIN solo aplica al personal: el cliente entra por OTP y no
  // tiene PIN. Se oculta el formulario por si quedó abierto de una visita
  // anterior a la pantalla.
  const _pinWrap = document.getElementById('cuenta-pin-wrap');
  if (_pinWrap) _pinWrap.style.display = (esVendedor && vendedorInfo) ? '' : 'none';
  cerrarCambioPin();

  if (esVendedor && vendedorInfo) {
    // Para vendedor mostrar siempre sus propios datos
    document.getElementById('cuenta-nombre').textContent = vendedorInfo.nombre || 'Vendedor';
    document.getElementById('cuenta-tipo').textContent = vendedorInfo.rol || 'Vendedor';
    if (vendedorInfo.direccionPV) {
      document.getElementById('cuenta-dir').textContent = vendedorInfo.direccionPV;
      document.getElementById('cuenta-cp').textContent = vendedorInfo.cpPV || '';
    }
  } else {
    // Para cliente normal
    document.getElementById('cuenta-nombre').textContent = clienteActual?.nombre || 'Cliente';
    document.getElementById('cuenta-tipo').textContent = TIPO_LABELS[tipoCliente] || tipoCliente;
    if (clienteActual?.direccion) {
      document.getElementById('cuenta-dir').textContent = clienteActual.direccion;
      document.getElementById('cuenta-cp').textContent =
        [clienteActual.colonia, clienteActual.municipio, clienteActual.cp].filter(Boolean).join(', ');
    }
  }

  document.getElementById('cuenta-pedidos').textContent = window._statsCliente?.totalPedidos || 0;
  document.getElementById('cuenta-total').textContent = '$' + (window._statsCliente?.totalCompras || 0);
  document.getElementById('cuenta-puntos').textContent = puntos;

  cargarPromosPerfil();

  // Botón de alta B2B: solo vendedores
  const _btnAlta = document.getElementById('btn-alta-negocio');
  if (_btnAlta) _btnAlta.style.display = esVendedor ? 'block' : 'none';
  const _btnUbic = document.getElementById('btn-ajustar-ubicacion');
  if (_btnUbic) _btnUbic.style.display = esVendedor ? 'block' : 'none';
};

// ── Opt-in de promociones editable desde "Mi cuenta" ──
function pintarSwitchPromos(on) {
  const slider = document.getElementById('cuenta-promos-slider');
  const knob = document.getElementById('cuenta-promos-knob');
  if (slider) slider.style.background = on ? 'var(--amarillo)' : '#444';
  if (knob) knob.style.left = on ? '23px' : '3px';
}

async function cargarPromosPerfil() {
  const card = document.getElementById('cuenta-promos-card');
  if (!card) return;
  // Es opt-in de clientes; ocultar para vendedores
  if (esVendedor) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  const chk = document.getElementById('cuenta-promos-chk');
  const st = document.getElementById('cuenta-promos-status');
  if (st) st.textContent = '';
  const tel = String(telefonoVerif || clienteActual?.telefono || '').replace(/\D/g, '').slice(-10);
  if (tel.length < 10) { if (chk) chk.checked = false; pintarSwitchPromos(false); return; }
  try {
    const r = await supabaseCall('POST', 'rpc/get_opt_in_promos', { p_telefono: tel });
    const on = !!(r && r.ok && r.acepta === true);
    if (chk) chk.checked = on;
    pintarSwitchPromos(on);
  } catch (_e) { if (chk) chk.checked = false; pintarSwitchPromos(false); }
}

window.togglePromosPerfil = async function(el) {
  const on = !!el.checked;
  pintarSwitchPromos(on);
  const st = document.getElementById('cuenta-promos-status');
  const tel = String(telefonoVerif || clienteActual?.telefono || '').replace(/\D/g, '').slice(-10);
  if (tel.length < 10) { if (st) { st.textContent = 'Inicia sesión para cambiar esto.'; st.style.color = '#ff8a8a'; } return; }
  if (st) { st.textContent = 'Guardando…'; st.style.color = 'var(--suave)'; }
  try {
    const r = await supabaseCall('POST', 'rpc/set_opt_in_promos', { p_telefono: tel, p_acepta: on, p_origen: 'perfil' });
    if (r && r.ok) {
      if (st) { st.textContent = on ? 'Activadas' : 'Desactivadas'; st.style.color = on ? '#7ee787' : 'var(--suave)'; }
    } else {
      el.checked = !on; pintarSwitchPromos(!on);
      if (st) { st.textContent = 'No se pudo guardar.'; st.style.color = '#ff8a8a'; }
    }
  } catch (e) {
    el.checked = !on; pintarSwitchPromos(!on);
    if (st) { st.textContent = 'Error: ' + e.message; st.style.color = '#ff8a8a'; }
  }
};

// Las trece secciones que viven en panel.js. `premia` y `pedidos` NO están aquí: las usan también
// los consumidores, y meterlas cargaría el panel a cada cliente. Esas dos se resuelven en su rama.
const SECCIONES_PANEL = new Set(['produccion', 'b2b', 'prospeccion', 'ruta', 'reparto', 'entregas', 'armado', 'caja', 'gastos', 'jornadas', 'productos', 'cupones', 'resumen']);

window.navegar = function(seccion) {
  // Panel bajo demanda (cambios/2026-09-19-partir-monolito): si la sección vive en panel.js y aún no
  // cargó, se carga y se vuelve a navegar. Un consumidor nunca llega aquí con esas secciones.
  if (SECCIONES_PANEL.has(seccion) && !P) {
    cargarPanel().then(() => navegar(seccion)).catch(() => avisar({ titulo: 'Panel', cuerpo: 'No se pudo cargar el panel. Revisa tu conexión e inténtalo de nuevo.' }));
    return;
  }
  const _perfH = perfStartNav(seccion);
  try { track('view_section', { seccion: seccion }); } catch(e) {}
  // Cola en vivo: al dejar Armado se detiene el refresco y el título vuelve.
  // `P &&` porque el consumidor navega sin panel: sin esa guardia, `P.x` revienta en el primer toque.
  if (seccion !== 'armado' && P && typeof P.armadoPararRefresco === 'function') { P.armadoPararRefresco(); document.title = ARMADO_TITULO_BASE; }
  // Apagar pantallas sueltas (s-alta-negocio, s-ajustar-ubicacion, etc.):
  // si quedan activas se enciman con la sección destino
  document.querySelectorAll('.screen.active').forEach(s => {
    if (!navSections.includes(s.id)) s.classList.remove('active');
  });
  // Ocultar todas las secciones del catálogo
  const screens = ['s-catalogo', 's-premia', 's-pedidos'];
  screens.forEach(s => document.getElementById(s).classList.remove('active'));

  // Activar sección correcta
  navSections.forEach(s=>{const e=document.getElementById(s);if(e)e.classList.remove('active');});
  if (seccion === 'inicio') { document.getElementById('s-catalogo').classList.add('active'); }
  else if (seccion === 'pedidos') {
    document.getElementById('s-pedidos').classList.add('active');
    renderPedidos();
  }
  else if (seccion === 'premia') {
    // Clientes ven su lealtad; el admin entra para administrar las reglas del Club.
    if (esVendedor && !(typeof esAdminEstricto === 'function' && esAdminEstricto())) { navegar('inicio'); return; }
    document.getElementById('s-premia').classList.add('active');
    renderPremia();
  }
  else if (seccion === 'cuenta') {
    document.getElementById('s-cuenta').classList.add('active');
    renderCuenta();
  }
  else if (seccion === 'produccion') {
    document.getElementById('s-produccion').classList.add('active');
    P.renderProduccion();
  }
  else if (seccion === 'b2b') {
    document.getElementById('s-b2b').classList.add('active');
    P.renderB2B();
  }
  else if (seccion === 'prospeccion') {
    document.getElementById('s-prospeccion').classList.add('active');
    P.renderProspeccion();
  }
  else if (seccion === 'gastos') {
    document.getElementById('s-gastos').classList.add('active');
    P.renderGastos();
  }
  else if (seccion === 'caja') {
    document.getElementById('s-caja').classList.add('active');
    P.renderCaja();
  }
  else if (seccion === 'jornadas') {
    document.getElementById('s-jornadas').classList.add('active');
    P.renderJornadas();
  }
  else if (seccion === 'productos') {
    document.getElementById('s-productos').classList.add('active');
    P.cargarListaProductos();
  }
  else if (seccion === 'cupones') {
    document.getElementById('s-cupones').classList.add('active');
    P.cargarCupones();
  }
  else if (seccion === 'armado') {
    document.getElementById('s-armado').classList.add('active');
    P.renderArmado();
  }
  else if (seccion === 'ruta') {
    document.getElementById('s-ruta').classList.add('active');
    P.renderRuta();
  }
  else if (seccion === 'reparto') {
    document.getElementById('s-reparto').classList.add('active');
    P.renderReparto();
  }
  else if (seccion === 'entregas') {
    document.getElementById('s-entregas').classList.add('active');
    P.renderEntregas();
  }
  else if (seccion === 'resumen') {
    document.getElementById('s-resumen').classList.add('active');
    P.renderResumen();
  }

  // Actualizar estado activo del nav
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const navEl = document.getElementById('nav-' + seccion);
  if (navEl) navEl.classList.add('active');

  // Medir tiempo de cambio de sección (DOM render). Las llamadas async aparecen aparte.
  perfEndNav(_perfH);
};

// ── Botón "atrás" del teléfono: retroceder DENTRO de la app, no salirse ──
// Envuelve ir() y navegar() con una pila + history.pushState. El popstate
// restaura la pantalla anterior; en la raíz, el back nativo sale (estándar).
(function() {
  window._navStack = [];
  window._navPop = false;
  const _irOrig = window.ir;
  const _navOrig = window.navegar;
  function _navPush(t, id) {
    if (window._navPop) return;
    const top = window._navStack[window._navStack.length - 1];
    if (top && top.t === t && top.id === id) return;  // no duplicar la misma pantalla
    window._navStack.push({ t, id });
    try { history.pushState({ cp: true }, '', location.pathname + location.search); } catch(_e) {}
  }
  window.ir = function(id) { _irOrig(id); _navPush('ir', id); };
  window.navegar = function(s) { _navOrig(s); _navPush('nav', s); };
  window.addEventListener('popstate', function() {
    // Si el drawer del carrito está abierto, el back lo cierra primero
    const dw = document.getElementById('drawer');
    if (dw && dw.classList.contains('open')) {
      if (typeof cerrarCarrito === 'function') cerrarCarrito();
      try { history.pushState({ cp: true }, '', location.pathname + location.search); } catch(_e) {}
      return;
    }
    if (window._navStack.length > 1) {
      window._navStack.pop();
      const prev = window._navStack[window._navStack.length - 1];
      window._navPop = true;
      try { prev.t === 'ir' ? _irOrig(prev.id) : _navOrig(prev.id); } finally { window._navPop = false; }
      // reponer el colchón para que el siguiente back siga dentro de la app
      try { history.pushState({ cp: true }, '', location.pathname + location.search); } catch(_e) {}
    }
    // pila en raíz: dejar que el back nativo actúe (salir de la app)
  });
})();

function renderPremia() {
  // Admin: ocultar las tarjetas de cliente y mostrar solo el panel de reglas.
  const _esAdminCfg = (typeof esAdminEstricto === 'function' && esAdminEstricto());
  document.querySelectorAll('#s-premia .club-cliente').forEach(el => { el.style.display = _esAdminCfg ? 'none' : ''; });
  // Puerta compartida: `premia` la abren consumidor y admin. El panel se carga SOLO en la rama del
  // admin; la del consumidor sigue sin tocarlo. Para el admin la promesa ya está resuelta (precarga).
  if (_esAdminCfg) {
    cargarPanel()
      .then((p) => { renderClubAdminCfg(); p.renderMayoreoAdminCfg(); })
      .catch(() => avisar({ titulo: 'Panel', cuerpo: 'No se pudo cargar el panel. Revisa tu conexión e inténtalo de nuevo.' }));
    return;
  }
  cargarMisPuntos();

  document.getElementById('p-puntos').textContent = puntos;
  const dispEl = document.getElementById('canje-disponibles'); if(dispEl) dispEl.textContent = puntos;

  renderClubAdminCfg();
}

// ── Crunchy Club: tarjeta de puntos y estado de cuenta (mis_puntos) ──
// A la manera de Premia Juntos+: saludo, tarjeta con saldo, «Mis movimientos» y un estado de cuenta
// por mes con filtros. El saldo es la suma del ledger, como en el servidor.
const MIS_PUNTOS_TIPO = { generacion: 'Generados', reversion: 'Cancelado', canje: 'Canje', devolucion: 'Devuelto', vencimiento: 'Vencido', reto: 'Reto', ajuste: 'Ajuste' };
let _misPuntos = null;
let _valorPunto = 0;
async function cargarMisPuntos() {
  const nombre = String(clienteActual?.nombre || '').trim().split(/\s+/)[0];
  const hola = document.getElementById('club-hola-nombre'); if (hola) hola.textContent = nombre ? ', ' + nombre : '';
  const act = document.getElementById('club-actualizado');
  if (act) act.textContent = 'Actualizado ' + new Date().toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City', day: '2-digit', month: '2-digit' });
  // La equivalencia sale de las reglas, no de un texto fijo.
  supabaseCall('POST', 'rpc/get_lealtad_config', {}).then(cfg => {
    _valorPunto = Number(cfg?.redencion?.valor_punto_mxn) || 0;
    const el = document.getElementById('canje-equiv');
    if (el && _valorPunto > 0) el.textContent = `10 puntos = $${(10 * _valorPunto).toLocaleString('es-MX', { maximumFractionDigits: 2 })} en producto.`;
    pintarEquivalencia();
  }).catch(() => {});
  if (!tokenCliente()) { _misPuntos = { error: 'Verifica tu número para ver tus puntos.' }; pintarMovimientos(); return; }
  let r;
  try { r = await supabaseCall('POST', 'rpc/mis_puntos', { p_token: tokenCliente() }); } catch (e) { r = null; }
  _misPuntos = (r && r.ok) ? r : { error: sesionExpirada(r) ? 'Tu sesión venció. Vuelve a entrar para ver tus puntos.' : 'No se pudieron cargar tus puntos.' };
  if (r && r.ok) {
    const n = Number(r.saldo || 0).toLocaleString('es-MX');
    const pp = document.getElementById('p-puntos'); if (pp) pp.textContent = n;
    const ms = document.getElementById('club-movs-saldo'); if (ms) ms.textContent = n;
  }
  pintarEquivalencia();
  pintarMovimientos();
  pintarRetos();
}
// Retos vigentes del cliente (mis_puntos.retos): avance medido en el servidor; el bono lo escribe el trigger.
const RETO_UNIDAD = { frecuencia: ['pedido', 'pedidos'], producto: ['pieza', 'piezas'], monto: ['peso', 'pesos'], surtido: ['sabor', 'sabores'] };
const urlImagenReto = (v) => !v ? '' : /^https?:\/\//i.test(v) ? v : ((window.__CP_CONFIG__ || {}).SUPABASE_URL || '') + '/storage/v1/object/public/contenido/' + v;
// Detalle de un reto, tipo «Desafío»: cabecera, plazo, progreso, cómo participar y productos participantes.
window.abrirReto = function(id) {
  const r = ((_misPuntos && _misPuntos.retos) || []).find(x => x.id === id);
  const cont = document.getElementById('rd-cuerpo');
  if (!r || !cont) return;
  const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  cont.innerHTML = '';
  const meta = Number(r.meta) || 0, av = Math.min(Number(r.avance) || 0, meta);
  const hoy = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' }) + 'T12:00:00');
  const dias = Math.round((new Date(String(r.hasta) + 'T12:00:00') - hoy) / 864e5);
  const u = RETO_UNIDAD[r.tipo] || ['', ''];
  const fmt = (n) => r.tipo === 'monto' ? '$' + Number(n).toLocaleString('es-MX') : Number(n).toLocaleString('es-MX');
  const cab = mk('div', 'rd-cab' + (r.imagen ? ' foto' : ''));
  if (r.imagen) { const im = document.createElement('img'); im.src = urlImagenReto(r.imagen); im.alt = ''; cab.appendChild(im); } else { cab.style.minHeight = '120px'; }
  const gana = mk('div', 'rd-gana', 'Gana'); gana.appendChild(mk('b', null, Number(r.bono).toLocaleString('es-MX') + ' pts')); cab.appendChild(gana);
  cont.appendChild(cab);
  cont.appendChild(mk('div', 'rd-tit', r.nombre));
  cont.appendChild(mk('div', 'rd-sub', r.cumplido ? 'Cumplido: ya sumaste ' + Number(r.bono).toLocaleString('es-MX') + ' puntos' : (dias <= 0 ? 'Último día' : dias === 1 ? 'Termina mañana' : 'Termina en ' + dias + ' días')));
  const prog = mk('div', 'rd-prog', 'Progreso del reto '); prog.appendChild(mk('b', null, fmt(av) + ' de ' + fmt(meta) + ' ' + (meta === 1 ? u[0] : u[1])));
  const barra = mk('div', 'club-reto-barra'); barra.style.margin = '6px 16px 0'; const fill = mk('div'); fill.style.width = (meta > 0 ? Math.round(av / meta * 100) : 0) + '%'; if (r.cumplido) fill.style.background = '#4caf50'; barra.appendChild(fill);
  cont.appendChild(prog); cont.appendChild(barra);
  const det = document.createElement('details'); det.className = 'rd-sec'; det.open = true; det.appendChild(mk('summary', null, '¿Cómo participar?'));
  if (r.dinamica) det.appendChild(mk('p', null, r.dinamica));
  const pasos = Array.isArray(r.como_participar) ? r.como_participar : [];
  if (pasos.length) { const ol = document.createElement('ol'); for (const p of pasos) ol.appendChild(mk('li', null, p)); det.appendChild(ol); }
  if (!r.dinamica && !pasos.length) det.appendChild(mk('p', null, r.descripcion || 'Compra y suma. Al llegar a la meta, los puntos se abonan solos.'));
  cont.appendChild(det);
  const sec = mk('div', 'rd-sec'); sec.appendChild(mk('div', 'rd-tit2', 'Productos en el reto'));
  const lista = Array.isArray(r.productos) ? r.productos : [];
  sec.appendChild(mk('div', 'rd-n', lista.length ? lista.length + ' producto' + (lista.length === 1 ? '' : 's') + ' participante' + (lista.length === 1 ? '' : 's') : 'Cuenta cualquier compra de papas'));
  for (const p of lista) {
    const fila = mk('div', 'rd-prod');
    if (p.imagen_url) { const im = document.createElement('img'); im.src = p.imagen_url; im.alt = ''; im.loading = 'lazy'; fila.appendChild(im); } else fila.appendChild(mk('div', 'ph'));
    const n = mk('div', 'n', p.sabor); n.appendChild(mk('small', null, p.presentacion || 'cualquier presentación')); fila.appendChild(n);
    fila.appendChild(mk('span', 'fl', '›'));
    fila.addEventListener('click', () => { navegar('inicio'); try { window.scrollTo(0, 0); } catch (_e) {} });
    sec.appendChild(fila);
  }
  cont.appendChild(sec);
  ir('s-club-reto'); try { window.scrollTo(0, 0); } catch (_e) {}
};
function pintarRetos() {
  const sec = document.getElementById('club-retos'), pista = document.getElementById('club-retos-lista'), puntosEl = document.getElementById('club-retos-puntos');
  if (!sec || !pista) return;
  const retos = _misPuntos && !_misPuntos.error && Array.isArray(_misPuntos.retos) ? _misPuntos.retos : [];
  sec.style.display = retos.length ? '' : 'none';
  pista.innerHTML = ''; if (puntosEl) puntosEl.innerHTML = '';
  const fmt = (r, n) => r.tipo === 'monto' ? '$' + Number(n).toLocaleString('es-MX') : Number(n).toLocaleString('es-MX');
  const hoy = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' }) + 'T12:00:00');
  const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  // Tarjetas tipo «Desafíos» (Premia Juntos+): franja con el nombre, píldoras de bono y plazo, progreso con barra.
  retos.forEach((r, i) => {
    const meta = Number(r.meta) || 0, av = Math.min(Number(r.avance) || 0, meta);
    const dias = Math.round((new Date(String(r.hasta) + 'T12:00:00') - hoy) / 864e5);
    const u = RETO_UNIDAD[r.tipo] || ['', ''];
    const card = mk('div', 'club-reto' + (r.cumplido ? ' cumplido' : ''));
    card.addEventListener('click', () => window.abrirReto(r.id));
    const cab = mk('div', 'club-reto-cab' + (r.imagen ? ' foto' : ''));
    if (r.imagen) { const im = document.createElement('img'); im.src = urlImagenReto(r.imagen); im.alt = ''; im.loading = 'lazy'; cab.appendChild(im); }
    cab.appendChild(mk('b', null, r.nombre)); card.appendChild(cab);
    const cuerpo = mk('div', 'club-reto-cuerpo');
    if (r.descripcion) cuerpo.appendChild(mk('div', 'club-reto-desc', r.descripcion));
    const pills = mk('div', 'club-reto-pills');
    pills.appendChild(mk('span', 'club-reto-pill ' + (r.cumplido ? 'ok' : 'bono'), (r.cumplido ? 'Cumplido, +' : '+') + Number(r.bono).toLocaleString('es-MX') + ' puntos'));
    pills.appendChild(mk('span', 'club-reto-pill', dias <= 0 ? 'Último día' : dias === 1 ? 'Termina mañana' : 'Termina en ' + dias + ' días'));
    cuerpo.appendChild(pills);
    const prog = mk('div', 'club-reto-prog', 'Progreso del reto ');
    prog.appendChild(mk('b', null, fmt(r, av) + ' de ' + fmt(r, meta) + ' ' + (meta === 1 ? u[0] : u[1]) + (r.sabor ? ' de ' + r.sabor : '')));
    cuerpo.appendChild(prog);
    const barra = mk('div', 'club-reto-barra'); const fill = mk('div'); fill.style.width = (meta > 0 ? Math.round(av / meta * 100) : 0) + '%'; barra.appendChild(fill);
    cuerpo.appendChild(barra); card.appendChild(cuerpo); pista.appendChild(card);
    if (puntosEl && retos.length > 1) puntosEl.appendChild(mk('span', i === 0 ? 'on' : ''));
  });
  if (puntosEl && retos.length > 1) {
    pista.onscroll = () => { const i = Math.round(pista.scrollLeft / ((pista.firstChild ? pista.firstChild.offsetWidth : 0) + 10 || 1)); [...puntosEl.children].forEach((d, k) => d.classList.toggle('on', k === i)); };
  }
}
function pintarEquivalencia() {
  const eq = document.getElementById('p-equiv');
  const saldo = _misPuntos && !_misPuntos.error ? Number(_misPuntos.saldo || 0) : Number(puntos || 0);
  if (eq) eq.textContent = _valorPunto > 0 ? `Equivalen a $${(saldo * _valorPunto).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} en producto` : '';
  // Lo que vence en los próximos 30 días (mis_puntos.por_vencer); sin nada por vencer, la línea no se ve.
  const ve = document.getElementById('p-vence');
  const pv = _misPuntos && !_misPuntos.error ? _misPuntos.por_vencer : null;
  const nv = Number(pv?.puntos || 0);
  if (ve) {
    ve.style.display = nv > 0 ? '' : 'none';
    ve.textContent = nv > 0 ? `${nv.toLocaleString('es-MX')} ${nv === 1 ? 'punto vence' : 'puntos vencen'} el ${new Date(pv.fecha).toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City', day: '2-digit', month: '2-digit' })}` : '';
  }
}
window.abrirMovimientos = function() { ir('s-club-movs'); pintarMovimientos(); try { window.scrollTo(0, 0); } catch (_e) {} };
window.volverAlClub = function() { if ((window._navStack || []).length > 1) history.back(); else navegar('premia'); };
window.pintarMovimientos = function() {
  const cont = document.getElementById('club-movs');
  if (!cont) return;
  cont.innerHTML = '';
  const nota = (txt) => { const d = document.createElement('div'); d.style.cssText = 'font-size:0.8rem;font-weight:600;color:var(--suave);text-align:center;padding:24px 0;'; d.textContent = txt; cont.appendChild(d); };
  if (!_misPuntos) { nota('Cargando…'); return; }
  if (_misPuntos.error) { nota(_misPuntos.error); return; }
  const meses = Number(document.getElementById('club-f-periodo')?.value || 3);
  const tipo = document.getElementById('club-f-tipo')?.value || '';
  const desde = meses ? new Date(Date.now() - meses * 30.44 * 864e5) : null;
  const movs = (_misPuntos.movimientos || []).filter(m => (!tipo || m.tipo === tipo) && (!desde || new Date(m.fecha) >= desde));
  if (!movs.length) { nota((_misPuntos.movimientos || []).length ? 'No hay movimientos con estos filtros.' : 'Aún no tienes movimientos. Tus puntos aparecerán aquí con cada compra.'); return; }
  const tz = { timeZone: 'America/Mexico_City' };
  // Canje de un pedido cancelado en validación: todavía no suma al saldo.
  const pend = _misPuntos.pendientes || [];
  if (pend.length && (!tipo || tipo === 'devolucion')) {
    const h = document.createElement('div'); h.className = 'club-mes'; h.textContent = 'En revisión'; cont.appendChild(h);
    for (const d of pend) {
      const fila = document.createElement('div'); fila.className = 'club-mov';
      const linea = document.createElement('div'); linea.className = 'club-mov-fila';
      const tit = document.createElement('div'); tit.className = 'club-mov-tit'; tit.textContent = 'Devolución en revisión';
      const pts = document.createElement('div'); pts.className = 'club-mov-pts'; pts.textContent = Number(d.puntos || 0).toLocaleString('es-MX') + ' pts';
      linea.append(tit, pts);
      const sub = document.createElement('div'); sub.className = 'club-mov-sub';
      sub.textContent = (d.consecutivo ? 'Pedido ' + d.consecutivo + ' cancelado · ' : '') + 'los puntos regresan cuando se valide';
      fila.append(linea, sub); cont.appendChild(fila);
    }
  }
  let mesActual = '';
  for (const m of movs) {
    const f = new Date(m.fecha);
    const mes = f.toLocaleDateString('es-MX', { ...tz, month: 'long', year: 'numeric' });
    if (mes !== mesActual) {
      mesActual = mes;
      const h = document.createElement('div'); h.className = 'club-mes'; h.textContent = mes.charAt(0).toUpperCase() + mes.slice(1); cont.appendChild(h);
    }
    const n = Number(m.puntos || 0);
    const fila = document.createElement('div'); fila.className = 'club-mov';
    const chips = document.createElement('div'); chips.className = 'club-mov-chips';
    const c1 = document.createElement('span'); c1.className = 'club-chip'; c1.textContent = f.toLocaleDateString('es-MX', { ...tz, day: 'numeric', month: 'short' });
    const c2 = document.createElement('span'); c2.className = 'club-chip ' + (n > 0 ? 'gen' : 'neg'); c2.textContent = MIS_PUNTOS_TIPO[m.tipo] || 'Movimiento';
    chips.append(c1, c2);
    const linea = document.createElement('div'); linea.className = 'club-mov-fila';
    const tit = document.createElement('div'); tit.className = 'club-mov-tit';
    tit.textContent = m.tipo === 'generacion' ? 'Compra' : m.tipo === 'reversion' ? 'Pedido cancelado' : m.tipo === 'ajuste' ? 'Reinicio del Club'
                    : m.tipo === 'canje' ? 'Canje de producto' : m.tipo === 'devolucion' ? 'Devolución de canje' : m.tipo === 'vencimiento' ? 'Puntos vencidos' : m.tipo === 'reto' ? 'Reto: ' + String(m.premio || '') : (MIS_PUNTOS_TIPO[m.tipo] || 'Movimiento');
    const pts = document.createElement('div'); pts.className = 'club-mov-pts' + (n > 0 ? ' gen' : '');
    pts.textContent = (n > 0 ? '+ ' : '− ') + Math.abs(n).toLocaleString('es-MX');
    linea.append(tit, pts);
    const sub = document.createElement('div'); sub.className = 'club-mov-sub';
    sub.textContent = [m.consecutivo ? 'Pedido ' + m.consecutivo : '', m.tipo === 'generacion' && Number(m.monto) > 0 ? '$' + Number(m.monto).toLocaleString('es-MX') + ' de producto' : '', m.tipo === 'ajuste' ? 'Reglas nuevas: 1 punto por cada $10' : m.tipo === 'vencimiento' || m.tipo === 'reto' ? String(m.nota || '') : ''].filter(Boolean).join(' · ');
    fila.append(chips, linea, sub);
    cont.appendChild(fila);
  }
};

// ── Crunchy Club: tienda de canje ──
// El precio en puntos lo manda el servidor (canje_catalogo) con la misma fórmula que cobra
// crear_pedido. Las piezas canjeadas viven en el carrito como líneas { canje: true, puntos }.
const CANJE_MAX_PIEZAS = 5;
let _canjeCat = null;
function lineasCanje() { return Object.values(carrito).filter(i => i.canje); }
function puntosCanjeCarrito() { return lineasCanje().reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.puntos) || 0), 0); }
function piezasCanjeCarrito() { return lineasCanje().reduce((s, i) => s + (Number(i.qty) || 0), 0); }
function saldoCanje() { return _misPuntos && !_misPuntos.error ? Number(_misPuntos.saldo || 0) : 0; }
window.abrirTiendaCanje = async function() {
  ir('s-club-canje');
  try { window.scrollTo(0, 0); } catch (_e) {}
  const grid = document.getElementById('tc-grid');
  if (grid) grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--suave);padding:30px 0;font-size:0.85rem;">Cargando…</div>';
  const [cat] = await Promise.all([
    supabaseCall('POST', 'rpc/canje_catalogo', {}).catch(() => null),
    tokenCliente() ? supabaseCall('POST', 'rpc/mis_puntos', { p_token: tokenCliente() }).then(r => { if (r && r.ok) _misPuntos = r; }).catch(() => {}) : Promise.resolve(),
  ]);
  _canjeCat = (cat && cat.ok) ? (cat.productos || []) : null;
  // Si el servidor cambió el precio en puntos, el carrito toma el nuevo.
  if (_canjeCat) for (const i of lineasCanje()) { const p = _canjeCat.find(x => String(x.id) === String(i.idProducto)); if (p) i.puntos = p.puntos; }
  pintarTiendaCanje();
};
window.cambiarCanje = function(id, delta) {
  const p = (_canjeCat || []).find(x => String(x.id) === String(id));
  const key = 'canje-' + id;
  const linea = carrito[key];
  if (delta > 0) {
    if (!p) return;
    if (piezasCanjeCarrito() >= CANJE_MAX_PIEZAS) { mostrarToast('Puedes canjear hasta 5 piezas por pedido'); return; }
    if (saldoCanje() - puntosCanjeCarrito() < p.puntos) { mostrarToast('No te alcanzan los puntos'); return; }
    if (!linea) carrito[key] = { key, idProducto: p.id, sabor: p.sabor, presentacion: p.presentacion, precio: 0, precioOriginal: 0, descuento: 0, gramos: p.gramos, tipoVenta: 'Por Pieza', qty: 0, canje: true, puntos: p.puntos };
    carrito[key].qty += 1;
    try { track('canje_agregado', { sabor: p.sabor, presentacion: p.presentacion, puntos: p.puntos }); } catch (e) {}
  } else if (linea) {
    linea.qty = Math.max(0, linea.qty - 1);
    if (!linea.qty) delete carrito[key];
  }
  actualizarBadge();
  pintarTiendaCanje();
  if (document.getElementById('drawer').classList.contains('open')) renderDrawer();
};
function pintarTiendaCanje() {
  const grid = document.getElementById('tc-grid');
  if (!grid) return;
  const saldo = saldoCanje(), usados = puntosCanjeCarrito(), piezas = piezasCanjeCarrito();
  const disp = saldo - usados;
  const dispEl = document.getElementById('tc-disp'); if (dispEl) dispEl.textContent = disp.toLocaleString('es-MX') + ' pts';
  const totEl = document.getElementById('tc-total'); if (totEl) totEl.textContent = usados.toLocaleString('es-MX');
  const irEl = document.getElementById('tc-ir'); if (irEl) irEl.disabled = !piezas;
  const info = document.getElementById('tc-info');
  if (!_canjeCat) {
    grid.innerHTML = '';
    const d = document.createElement('div'); d.style.cssText = 'grid-column:1/-1;text-align:center;color:var(--suave);padding:30px 0;font-size:0.85rem;';
    d.textContent = !tokenCliente() ? 'Verifica tu número para canjear tus puntos.' : 'No se pudo cargar la tienda de canje.';
    grid.appendChild(d); if (info) info.textContent = ''; return;
  }
  if (info) info.textContent = `Hay ${_canjeCat.length} productos. Canjea hasta ${CANJE_MAX_PIEZAS} piezas por pedido; tu pedido debe llevar al menos un producto comprado.`;
  grid.innerHTML = '';
  for (const p of _canjeCat) {
    const qty = Number(carrito['canje-' + p.id]?.qty || 0);
    const alcanza = disp >= p.puntos && piezas < CANJE_MAX_PIEZAS;
    const card = document.createElement('div');
    card.className = 'tc-card' + (!alcanza && !qty ? ' sin-saldo' : '');
    const img = document.createElement('div'); img.className = 'tc-img';
    if (p.imagen) { const im = document.createElement('img'); im.src = p.imagen; im.alt = p.sabor + ' ' + p.presentacion; im.loading = 'lazy'; img.appendChild(im); }
    else img.innerHTML = saborDot(p.sabor, 40);
    const nom = document.createElement('div'); nom.className = 'tc-nom'; nom.textContent = p.sabor + ' · ' + p.presentacion;
    const pts = document.createElement('div'); pts.className = 'tc-pts'; pts.textContent = Number(p.puntos).toLocaleString('es-MX') + ' ';
    const sm = document.createElement('small'); sm.textContent = 'pts'; pts.appendChild(sm);
    const paso = document.createElement('div'); paso.className = 'tc-paso';
    const menos = document.createElement('button'); menos.type = 'button'; menos.textContent = '−'; menos.disabled = !qty; menos.setAttribute('aria-label', 'Quitar una pieza de ' + nom.textContent); menos.onclick = () => cambiarCanje(p.id, -1);
    const n = document.createElement('span'); n.textContent = qty;
    const mas = document.createElement('button'); mas.type = 'button'; mas.textContent = '+'; mas.disabled = !alcanza; mas.setAttribute('aria-label', 'Canjear una pieza de ' + nom.textContent); mas.onclick = () => cambiarCanje(p.id, 1);
    paso.append(menos, n, mas);
    card.append(img, nom, pts, paso);
    grid.appendChild(card);
  }
}

// ── Panel admin: reglas del Crunchy Club (solo admin estricto, no mostrador) ──
function esAdminEstricto() {
  return esVendedor && String(vendedorInfo?.rol || '').toLowerCase().trim().startsWith('admin');
}

async function renderClubAdminCfg() {
  const cont = document.getElementById('club-admin-cfg');
  if (!cont) return;
  if (!esAdminEstricto()) { cont.style.display = 'none'; cont.innerHTML = ''; return; }
  cont.style.display = 'block';
  cont.innerHTML = '<div style="background:var(--gris);border-radius:14px;padding:14px;margin:12px 16px;color:var(--suave);font-size:0.8rem;">Cargando reglas del club…</div>';
  let cfg;
  try {
    cfg = await supabaseCall('POST', 'rpc/get_lealtad_config', {});
  } catch (e) {
    cont.innerHTML = '<div style="background:var(--gris);border-radius:14px;padding:14px;margin:12px 16px;color:#ff6b6b;font-size:0.8rem;">No se pudieron cargar las reglas.</div>';
    return;
  }
  const g = (cfg && cfg.generacion) || {};
  const r = (cfg && cfg.redencion) || {};
  const inp = (id, val, step) => `<input id="${id}" type="number" inputmode="decimal" step="${step || '0.01'}" value="${val ?? ''}" style="width:100px;background:var(--gris2);border:1px solid var(--gris3);border-radius:6px;padding:5px 8px;color:var(--blanco);font-size:0.8rem;text-align:right;">`;
  const fila = (label, sub, control) => `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px;font-size:0.8rem;color:var(--blanco);">
      <span>${label}${sub ? `<br><span style="color:var(--suave);font-size:0.66rem;">${sub}</span>` : ''}</span>
      ${control}
    </div>`;
  cont.innerHTML = `
    <div style="background:var(--gris);border-radius:14px;padding:14px;margin:12px 16px;">
      <div style="font-size:0.72rem;font-weight:800;color:var(--amarillo);text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;">Reglas del Club (admin)</div>
      ${fila('Puntos por peso', '0.1 = 1 punto por cada $10 de producto, sin envío', inp('cfg-ppp', g.puntos_por_peso, '0.01'))}
      ${fila('Valor del punto al canjear ($)', 'cuánto descuenta 1 punto', inp('cfg-vpm', r.valor_punto_mxn, '0.01'))}
      ${fila('% máx. del pedido con puntos', 'nunca llega a 100%', inp('cfg-pct', r.pct_max_pedido, '1'))}
      ${fila('Pago mínimo en $', 'siempre debe quedar un cobro real', inp('cfg-pmin', r.pago_minimo_mxn, '1'))}
      <button onclick="guardarLealtadCfg()" style="width:100%;background:var(--amarillo);border:none;border-radius:10px;padding:10px;font-weight:800;font-size:0.82rem;color:var(--negro);cursor:pointer;">Guardar reglas</button>
      <div style="font-size:0.64rem;color:var(--suave);margin-top:8px;text-align:center;">La generación aplica al confirmar pago + entrega. La redención usa estos topes.</div>
    </div>`;
}

// Sección "Regalos recibidos" en el historial individual del cliente (kg, no $)
async function pintarRegalosCliente() {
  const lista = document.getElementById('pedidos-lista');
  if (!lista || !clienteActual?.id || Number(clienteActual.id) === 999999) return;
  try {
    // Etapa B: el cliente sale de SU token. Antes el filtro `id_cliente` lo
    // ponía el navegador, así que cualquiera veía los regalos de cualquiera.
    const _rg = await supabaseCall('POST', 'rpc/obtener_regalos_cliente', {
      p_data: { token: tokenParaConsultaCliente(), idCliente: clienteActual.id }
    });
    const regs = (_rg && _rg.ok && Array.isArray(_rg.regalos)) ? _rg.regalos : [];
    if (!Array.isArray(regs) || regs.length === 0) return;
    const lbl = { sampling:'Sampling', regalo:'Regalo', bonificacion:'Bonificación' };
    let html = `<div style="margin-top:18px;margin-bottom:8px;font-size:0.7rem;font-weight:800;color:var(--suave);text-transform:uppercase;letter-spacing:1px;">Regalos recibidos</div>`;
    regs.forEach(r => {
      const f = r.fecha_orden ? new Date(r.fecha_orden).toLocaleDateString('es-MX',{day:'numeric',month:'short',year:'numeric'}) : '—';
      const kg = (Array.isArray(r.ordenes_detalle) ? r.ordenes_detalle.reduce((s,d)=>s+(Number(d.kg_descontado_lote)||0),0) : 0);
      const kgTxt = kg > 0 ? `${kg.toLocaleString('es-MX',{maximumFractionDigits:3})} kg` : '';
      html += `<div class="pedido-card" style="opacity:0.95;">
        <div class="pedido-top">
          <span class="pedido-consec">${lbl[r.tipo_interno]||'Regalo'}</span>
          <span style="font-family:'Archivo',sans-serif;font-size:1.05rem;color:var(--amarillo);">${kgTxt}</span>
        </div>
        <div class="pedido-fecha">${f}${r.consecutivo ? ' · ' + r.consecutivo : ''}</div>
        <div style="font-size:0.68rem;color:var(--suave);margin-top:4px;font-weight:700;">Cortesía · no es compra</div>
      </div>`;
    });
    lista.insertAdjacentHTML('beforeend', html);
  } catch (_e) { /* silencioso: no romper el historial si falla */ }
}

function renderPedidos() {
  // Si es vendedor, usar la vista de vendedor (resumen + cuota + sus pedidos)
  // Puerta compartida: `pedidos` la abren los dos. El panel solo se carga en la rama del vendedor.
  if (esVendedor) {
    cargarPanel()
      .then((p) => p.renderPedidosVendedor())
      .catch(() => avisar({ titulo: 'Panel', cuerpo: 'No se pudo cargar el panel. Revisa tu conexión e inténtalo de nuevo.' }));
    return;
  }

  const lista = document.getElementById('pedidos-lista');
  if (!clienteActual || !window._misPedidos || window._misPedidos.length === 0) {
    lista.innerHTML = '<div style="text-align:center;color:var(--suave);padding:40px 0;font-size:0.9rem;font-weight:600;"><span class="vacio-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg></span>Aún no tienes pedidos registrados</div>';
    pintarRegalosCliente();
    return;
  }
  const pedidos = [...window._misPedidos].sort((a,b)=>new Date(b.fecha)-new Date(a.fecha));
  const ultimo  = pedidos[0];
  lista.innerHTML = `
    <!-- Último pedido destacado -->
    <div onclick="verDetallePedido(${ultimo.id})" style="cursor:pointer;background:linear-gradient(135deg,#1a1200,#2a2000);border:1px solid rgba(255,210,0,0.3);border-radius:16px;padding:16px;margin-bottom:16px;">
      <div style="font-size:0.68rem;font-weight:800;color:var(--amarillo);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Último pedido</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <span style="font-family:'Archivo',sans-serif;font-size:1.1rem;color:var(--amarillo);">${ultimo.consec||'—'}</span>
        <span style="font-family:'Archivo',sans-serif;font-size:1.3rem;color:var(--blanco);">$${ultimo.total||0}</span>
      </div>
      <div style="font-size:0.75rem;color:var(--suave);font-weight:600;">${ultimo.fecha?new Date(ultimo.fecha).toLocaleDateString('es-MX',{weekday:'long',day:'numeric',month:'long'}):'—'}</div>
      <span class="pedido-estatus ${ultimo.estatus==='Entregado'?'entregado':''}" style="margin-top:8px;">${ultimo.estatus||'Pendiente'}</span>
      ${ultimo.estatus==='Entregado' ? `<button onclick="event.stopPropagation(); window.crunchyEncuesta.abrirParaOrden(${ultimo.id})" style="margin-top:10px;width:100%;background:var(--amarillo);color:#222;border:none;border-radius:10px;padding:9px;font-weight:800;font-size:0.78rem;cursor:pointer;">${(window._encuestadas||[]).indexOf(ultimo.id)>=0?'✓ Ya evaluado · editar':'Evaluar este pedido'}</button>` : ''}
      <div style="font-size:0.7rem;color:var(--amarillo);margin-top:8px;font-weight:700;">Ver seguimiento</div>
    </div>
    <!-- Resto de pedidos -->
    ${pedidos.slice(1).map(p => {
      const fecha = p.fecha ? new Date(p.fecha).toLocaleDateString('es-MX',{day:'numeric',month:'short',year:'numeric'}) : '—';
      return `<div class="pedido-card clickable" onclick="verDetallePedido(${p.id})">
        <div class="pedido-top">
          <span class="pedido-consec">${p.consec||'—'}</span>
          <span class="pedido-total">$${p.total||0}</span>
        </div>
        <div class="pedido-fecha">${fecha}</div>
        <span class="pedido-estatus ${p.estatus==='Entregado'?'entregado':''}">${p.estatus||'Pendiente'}</span>
        ${p.estatus==='Entregado' ? `<button onclick="event.stopPropagation(); window.crunchyEncuesta.abrirParaOrden(${p.id})" style="margin-top:8px;width:100%;background:transparent;border:1px solid var(--amarillo);border-radius:8px;padding:7px;color:var(--amarillo);font-weight:800;font-size:0.72rem;cursor:pointer;">${(window._encuestadas||[]).indexOf(p.id)>=0?'✓ Evaluado · editar':'Evaluar'}</button>` : ''}
      </div>`;
    }).join('')}
  `;
  pintarRegalosCliente();
}

function esAdmin() {
  if (!esVendedor) return false;
  const rol = String(vendedorInfo?.rol || '').toLowerCase().trim();
  return rol.startsWith('admin') || rol === 'mostrador';
}

function mostrarNavB2B() {
  const navB2B = document.getElementById('nav-b2b');
  if (navB2B && esAdmin()) navB2B.style.display = 'flex';
}

// ── RESUMEN / DASHBOARD (solo admin): tabla compacta de pedidos ──
function mostrarNavResumen() {
  const nav = document.getElementById('nav-resumen');
  if (nav && esAdmin()) nav.style.display = 'flex';
}


// ══════════════════════════════════
// FLUJO CLIENTE VENDEDOR
// ══════════════════════════════════
let _modoCliente = null; // 'nuevo' | 'existente'

function bloquearCamposCliente(bloqueado) {
  const campos = ['f-nombre','f-tel-cliente','f-cp','f-colonia','f-dir','f-negocio','f-rfc'];
  campos.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.readOnly = bloqueado;
    el.style.opacity = bloqueado ? '0.6' : '1';
    el.style.pointerEvents = bloqueado ? 'none' : 'auto';
  });
}

// ══════════════════════════════════════════════════════════════════
// MODAL: DETALLE DEL PEDIDO + TICKET IMPRIMIBLE
// ══════════════════════════════════════════════════════════════════
let _pedidoActual = null; // { orden, lineas }

window.verDetallePedido = async function(idOrden) {
  // Paso 4 (III), 13 sep 2026: el consumidor no puede leer `obtener_pedido`
  // (exige token de vendedor desde el cierre de lecturas del 3 sep) y veía
  // «Pedido no encontrado». Su detalle es la pantalla de seguimiento, que es
  // pública (get_tracking_pedido acepta id o consecutivo) y ya está rediseñada.
  if (!esVendedor) { abrirTracking(String(idOrden)); return; }
  // El detalle lo pinta el panel. Se carga AQUÍ, antes de tocar `window._vendedoresReparto`:
  // panel.js lo pone a null al evaluarse, así que cargarlo más abajo borraría la lista recién traída.
  let _p;
  try { _p = await cargarPanel(); }
  catch (_e) { avisar({ titulo: 'Panel', cuerpo: 'No se pudo cargar el panel. Revisa tu conexión e inténtalo de nuevo.' }); return; }
  // Abrir drawer
  document.getElementById('overlay-pedido').classList.add('visible');
  document.getElementById('drawer-pedido').classList.add('open');
  document.getElementById('dp-titulo').textContent = 'Pedido';
  document.getElementById('dp-contenido').innerHTML =
    '<div style="text-align:center;color:var(--suave);padding:40px 0;"><span class="loader loader-w"></span> Cargando detalle...</div>';

  try {
    // v2.8: detalle desde Supabase — orden + líneas en 2 queries paralelas
    // Etapa B: un solo RPC trae el pedido y su detalle. Antes eran dos
    // consultas en paralelo que había que unir a mano, con el riesgo de que
    // llegara una y no la otra.
    const _rp = await supabaseCall('POST', 'rpc/obtener_pedido', { p_data: { ref: String(idOrden) } });
    const ordArr = (_rp && _rp.ok && _rp.pedido) ? [_rp.pedido] : [];
    const detArr = (_rp && _rp.ok && Array.isArray(_rp.detalle)) ? _rp.detalle : [];
    if (!Array.isArray(ordArr) || ordArr.length === 0) {
      document.getElementById('dp-contenido').innerHTML =
        '<div style="text-align:center;color:var(--rojo);padding:30px;">Pedido no encontrado</div>';
      return;
    }
    const o = ordArr[0];
    // Mapear orden a formato esperado por el frontend
    const orden = {
      id: o.id, consecutivo: o.consecutivo, canal: o.canal,
      id_cliente: o.id_cliente, nombre_cliente: o.nombre_cliente,
      id_vendedor: o.id_vendedor, nombre_vendedor: o.nombre_vendedor,
      fecha_orden: o.fecha_orden, fecha_entrega: o.fecha_entrega,
      fecha_entrega_real: o.fecha_entrega_real,
      tipo_pago_id: o.tipo_pago_id, tipo_pago: o.tipo_pago,
      estatus_pedido: o.estatus_pedido, estatus_pago: o.estatus_pago,
      subtotal: Number(o.subtotal) || 0, descuento: Number(o.descuento) || 0, total: Number(o.total) || 0,
      notas: o.notas, cupon_codigo: o.cupon_codigo, tipo_interno: o.tipo_interno,
      cp: o.cp, colonia: o.colonia, municipio: o.municipio, estado: o.estado,
      direccion: o.direccion, coordenadas: o.coordenadas, zona_entrega: o.zona_entrega,
    };
    // Si líneas usan id_orden numérico en lugar de consecutivo
    let detalles = Array.isArray(detArr) ? detArr : [];
    if (detalles.length === 0) {
      // Fallback por id_orden numérico
      const _rd2 = await supabaseCall('POST', 'rpc/obtener_detalle_pedidos', { p_data: { ids: [o.id] } });
      const detArr2 = (_rd2 && _rd2.ok) ? _rd2.detalle : [];
      detalles = Array.isArray(detArr2) ? detArr2 : [];
    }
    const lineas = detalles.map(d => ({
      id: d.id,
      id_orden: d.id_orden,
      id_producto: d.id_producto,
      sabor: d.sabor, presentacion: d.presentacion,
      tipo_venta: d.tipo_venta,
      cantidad: Number(d.cantidad) || 0,
      gramos: Number(d.gramos_vendidos) || 0,
      gramos_vendidos: Number(d.gramos_vendidos) || 0,
      precio_unitario: Number(d.precio_unitario) || 0,
      precio_kg: Number(d.precio_kg) || 0,
      subtotal: Number(d.subtotal) || 0,
      descuento: Number(d.descuento) || 0,
      piezas_por_caja: Number(d.piezas_por_caja) || 0,   // caja: «2 cajas de 12 (24 pz)»
    }));
    if (esAdmin() && !window._vendedoresReparto) { try { window._vendedoresReparto = await cargarVendedoresCheckout(); } catch (_e) { window._vendedoresReparto = []; } }
    _pedidoActual = { ok: true, orden, lineas };
    _p.pintarDetallePedido(_pedidoActual);
  } catch(e) {
    document.getElementById('dp-contenido').innerHTML =
      '<div style="text-align:center;color:var(--rojo);padding:30px;">Error: ' + e.message + '</div>';
  }
};

window.cerrarDetallePedido = function() {
  document.getElementById('overlay-pedido').classList.remove('visible');
  document.getElementById('drawer-pedido').classList.remove('open');
};
document.addEventListener('click', function(e) {
  const ovP = document.getElementById('overlay-pedido');
  if (e.target === ovP) cerrarDetallePedido();
});

function mostrarNavCaja() {
  const nav = document.getElementById('nav-caja');
  if (!nav) return;
  // Admin, mostrador y vendedores ven Caja (cada uno ve lo que le corresponde)
  if ((esAdmin && esAdmin()) || esVendedor) {
    nav.style.display = 'flex';
  }
}
const ARMADO_TITULO_BASE = document.title;


// ══════════════════════════════════════════════════════════════════
// PERMISOS DE SECCIONES (v2.5)
// ══════════════════════════════════════════════════════════════════
let _seccionesPermitidas = null;  // ['catalogo','pedidos',...]

const NAV_ITEM_POR_SECCION = {
  catalogo:    'nav-inicio',
  pedidos:     'nav-pedidos',
  premia:      'nav-premia',
  b2b:         'nav-b2b',
  produccion:  'nav-produccion',
  prospeccion: 'nav-prospeccion',
  caja:        'nav-caja',
  gastos:      'nav-gastos',
  jornadas:    'nav-jornadas',
  productos:   'nav-productos',
  cupones:     'nav-cupones',
  resumen:     'nav-resumen',
  armado:      'nav-armado',
  ruta:        'nav-ruta',
  reparto:     'nav-reparto',
  entregas:    'nav-entregas',
  cuenta:      'nav-perfil',
};

async function aplicarPermisosNavbar() {
  // Cargar permisos del usuario actual
  try {
    // Etapa B: se pregunta "¿qué puedo ver YO?", derivado del token, en vez de
    // "¿qué puede ver el vendedor N?". `get_secciones_usuario` recibía
    // idVendedor como parámetro, así que cualquiera podía consultar los
    // permisos de cualquiera. El consumidor no tiene sesión: usa sus defaults.
    const res = esVendedor
      ? await supabaseCall('POST', 'rpc/mis_secciones', { p_token: tokenVendedor() })
      : { ok: true, secciones: ['catalogo','premia','pedidos','cuenta'] };
    if (res && res.ok) {
      _seccionesPermitidas = res.secciones || [];
    } else {
      // Fallback: defaults seguros. Ojo — esto es cosmético: aunque aquí se
      // muestre de más, el servidor niega los RPCs que no correspondan.
      _seccionesPermitidas = esVendedor
        ? ['catalogo','pedidos','prospeccion','gastos','cuenta']
        : ['catalogo','premia','pedidos','cuenta'];
    }
  } catch(e) {
    _seccionesPermitidas = esVendedor
      ? ['catalogo','pedidos','prospeccion','gastos','cuenta']
      : ['catalogo','premia','pedidos','cuenta'];
  }

  // Para admin SIEMPRE mostrar todo (no se restringe). Estricto: el mostrador
  // ve su lista, no toda la barra (esAdmin() lo incluye para otras cosas).
  if (esAdminEstricto()) {
    _seccionesPermitidas = Object.keys(NAV_ITEM_POR_SECCION);
  }

  // Si es mostrador (rol especial), agregar productos y cupones
  if (vendedorInfo && String(vendedorInfo.rol || '').toLowerCase() === 'mostrador') {
    if (_seccionesPermitidas.indexOf('productos') === -1) _seccionesPermitidas.push('productos');
    if (_seccionesPermitidas.indexOf('cupones')   === -1) _seccionesPermitidas.push('cupones');
  }

  // Aplicar visibilidad a cada nav item
  let countVisible = 0;
  Object.entries(NAV_ITEM_POR_SECCION).forEach(([sec, navId]) => {
    const el = document.getElementById(navId);
    if (!el) return;
    if (_seccionesPermitidas.indexOf(sec) >= 0) {
      el.style.display = 'flex';
      countVisible++;
    } else {
      el.style.display = 'none';
    }
  });

  ajustarNavbarScroll();
}

// Distribuir uniforme si hay pocos items (consumidor); desplazable si hay muchos.
// Se decide por lo que hay visible de verdad, y se vuelve a decidir cada vez que
// alguien enciende o apaga un item (mostrarNavProduccion, mostrarNavB2B…).
function ajustarNavbarScroll() {
  const navbar = document.getElementById('navbar');
  if (!navbar) return;
  const visibles = Array.from(navbar.querySelectorAll('.nav-item')).filter(e => e.style.display !== 'none').length;
  navbar.classList.toggle('scrollable', visibles > 5);
}
if (window.MutationObserver) {
  const nb = document.getElementById('navbar');
  if (nb) new MutationObserver(ajustarNavbarScroll).observe(nb, { attributes: true, subtree: true, attributeFilter: ['style'] });
}


// ══════════════════════════════════
// MINI CARRITO
// ══════════════════════════════════
function actualizarMiniCarrito() {
  const items = totalItems();
  const mc = document.getElementById('mini-cart');
  const esInternoModo = (modoVenta === 'interno');

  document.getElementById('mc-qty').textContent = items;
  const lbl = document.getElementById('mc-lbl');
  if (esInternoModo) {
    if (lbl) lbl.textContent = 'Volumen';
    const kg = totalGramos() / 1000;
    document.getElementById('mc-total').textContent = kg.toFixed(2) + ' kg';
  } else {
    if (lbl) lbl.textContent = 'Subtotal';
    document.getElementById('mc-total').textContent = '$' + totalMonto();
  }

  // No mostrar mini carrito en sección de producción
  const enProduccion = document.getElementById('s-produccion')?.classList.contains('active');
  if (items > 0 && !enProduccion) mc.classList.add('visible');
  else mc.classList.remove('visible');
  // También actualizar badge del nav
  document.getElementById('cart-badge').textContent = items;
}

// ══════════════════════════════════════════════════════════════════
// TRACKING DE PEDIDO (cliente) — v2.6
// Accesible vía:
//   - URL ?track=PED-00123 (sin login, abierto)
//   - Click desde "Mis pedidos" propios
// ══════════════════════════════════════════════════════════════════
let _trackingPedidoActual = null;
let _trackingAutoRefresh = null;

window.abrirTracking = function(idOrden) {
  // Mostrar pantalla tracking
  // Apaga TODA pantalla activa, no solo las de navSections: con ?track= y sin
  // sesión, s-welcome quedaba activa encima y tapaba el seguimiento (12 sep 2026).
  document.querySelectorAll('.screen.active').forEach(el => el.classList.remove('active'));
  const sT = document.getElementById('s-tracking');
  if (sT) sT.classList.add('active');
  cargarTracking(idOrden);
};

async function cargarTracking(idOrden) {
  const cont = document.getElementById('tk-contenido');
  if (!cont) return;
  cont.innerHTML = '<div style="text-align:center;color:var(--suave);padding:30px 0;"><span class="loader loader-w"></span> Cargando...</div>';

  try {
    const res = await supabaseCall('POST', 'rpc/get_tracking_pedido', { p_id_orden: String(idOrden) });
    if (!res || !res.ok) {
      cont.innerHTML = `<div style="background:#2d0d0d;border:1px solid var(--rojo);border-radius:12px;padding:18px;text-align:center;">
        <div style="font-family:'Archivo',sans-serif;font-size:1.1rem;color:var(--blanco);">No encontramos ese pedido</div>
        <div style="font-size:0.8rem;color:var(--suave);margin-top:6px;">${(res && res.error) || 'Pedido no encontrado'}. Verifica el código del pedido.</div>
      </div>`;
      return;
    }
    _trackingPedidoActual = res.pedido;
    pintarTracking();

    // Auto-refresh cada 30 segundos
    if (_trackingAutoRefresh) clearInterval(_trackingAutoRefresh);
    _trackingAutoRefresh = setInterval(() => {
      // Solo refresca si la pantalla sigue activa
      const sT = document.getElementById('s-tracking');
      if (sT && sT.classList.contains('active')) {
        cargarTrackingSilencioso(idOrden);
      } else {
        clearInterval(_trackingAutoRefresh);
        _trackingAutoRefresh = null;
      }
    }, 30000);
  } catch(e) {
    cont.innerHTML = `<div style="color:var(--rojo);padding:18px;">Error: ${e.message}</div>`;
  }
}

async function cargarTrackingSilencioso(idOrden) {
  try {
    const res = await supabaseCall('POST', 'rpc/get_tracking_pedido', { p_id_orden: String(idOrden) });
    if (res && res.ok && res.pedido) {
      _trackingPedidoActual = res.pedido;
      pintarTracking();
    }
  } catch(e) { /* silencioso */ }
}

function pintarTracking() {
  const cont = document.getElementById('tk-contenido');
  if (!cont) return;
  const p = _trackingPedidoActual;
  if (!p) return;

  const ESTADOS = ['Recibido','En preparación','En camino','Entregado'];
  const estatusActual = p.estatusCliente;
  const cancelado = estatusActual === 'Cancelado';
  const idxActual = cancelado ? -1 : ESTADOS.indexOf(estatusActual);

  const fechaCorta = (v) => v ? new Date(v).toLocaleString('es-MX', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }) : '';
  const fecha     = p.fecha ? new Date(p.fecha).toLocaleDateString('es-MX', { weekday:'long', day:'numeric', month:'long' }) : '';
  const fechaHora = fechaCorta(p.fecha);
  const fechaReal = fechaCorta(p.fechaEntregaReal);
  const fechaEnt  = p.fechaEntrega ? new Date(p.fechaEntrega).toLocaleDateString('es-MX', { day:'numeric', month:'short' }) : '';

  // El mensaje del estado vive bajo el paso actual, no en un cuadro aparte.
  const mensajes = {
    'Recibido':       'Recibimos tu pedido; pronto empezamos a prepararlo.',
    'En preparación': 'Estamos preparando tus papas.',
    'En camino':      'Tu pedido va en camino.',
    'Entregado':      'Entregado. Gracias por elegirnos.',
  };
  const detalle = (i) => {
    const est = ESTADOS[i];
    if (i === idxActual && mensajes[est]) return mensajes[est];
    if (est === 'Recibido' && fechaHora) return fechaHora;
    if (est === 'Entregado') {
      if (fechaReal) return fechaReal;
      if (fechaEnt && !cancelado) return 'Estimada: ' + fechaEnt;
    }
    return '';
  };

  const CHECK = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  let stepsHTML = '<ol class="tk-pasos">';
  ESTADOS.forEach((est, i) => {
    const hecho  = !cancelado && i < idxActual;
    const actual = !cancelado && i === idxActual;
    const cls = hecho ? 'hecho' : actual ? 'actual' : 'pendiente';
    const det = detalle(i);
    stepsHTML += `<li class="tk-paso ${cls}"${actual ? ' aria-current="step"' : ''}>
      <span class="tk-circulo">${hecho ? CHECK : (i + 1)}</span>
      <span class="tk-texto"><span class="tk-titulo">${est}</span>${det ? `<span class="tk-detalle">${det}</span>` : ''}</span>
    </li>`;
  });
  stepsHTML += '</ol>';
  if (cancelado) stepsHTML += '<div class="tk-cancelado">Este pedido fue cancelado.</div>';

  // Productos, con presentación (el RPC ya la devolvía y no se enseñaba)
  const mxn = (n) => '$' + Number(n || 0).toLocaleString('es-MX');
  let itemsHTML = '';
  if (p.items && p.items.length) {
    itemsHTML = '<div class="tk-bloque"><div class="tk-etq">Productos</div>';
    p.items.forEach(it => {
      const desc = it.modo === 'granel'
        ? `${it.sabor} · ${Number(it.gramos || 0).toLocaleString('es-MX')} g a granel`
        : `${it.cantidad} × ${it.sabor}${it.presentacion ? ' · ' + it.presentacion : ''}`;
      itemsHTML += `<div class="tk-linea"><span>${desc}</span><span class="tk-num">${mxn(it.subtotal)}</span></div>`;
    });
    // v2.7.2: si hay descuento de cupón, mostrar subtotal y descuento por separado
    const huboDesc = (p.descuento && p.descuento > 0) || (p.cuponCodigo && p.subtotal && p.subtotal > p.total);
    if (huboDesc) {
      const subt = p.subtotal && p.subtotal > 0 ? p.subtotal : (p.total + (p.descuento||0));
      const desc = p.descuento && p.descuento > 0 ? p.descuento : (subt - p.total);
      itemsHTML += `<div class="tk-linea tk-sep tk-suave"><span>Subtotal</span><span class="tk-num">${mxn(subt)}</span></div>`;
      itemsHTML += `<div class="tk-linea tk-suave"><span>Cupón ${p.cuponCodigo || ''}</span><span class="tk-num" style="color:var(--blanco);">−${mxn(desc)}</span></div>`;
    }
    itemsHTML += `<div class="tk-linea tk-sep tk-total"><span>Total</span><span class="tk-num">${mxn(p.total)}</span></div></div>`;
  }

  const pagado = String(p.estatusPago || '').toLowerCase().includes('paga');
  const REFRESH = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/></svg>';

  cont.innerHTML = `
    <div class="tk-card">
      <div class="tk-cab">
        <div>
          <div class="tk-folio">${p.consecutivo}</div>
          <div class="tk-fecha">${fecha}</div>
        </div>
        <div class="tk-cab-der">
          <div class="tk-monto">${mxn(p.total)}</div>
          <span class="tk-pago${pagado ? ' ok' : ''}">${pagado ? 'Pagado' : 'Pendiente de pago'}</span>
        </div>
      </div>
      ${stepsHTML}
    </div>
    ${itemsHTML}
    ${p.direccion ? `
      <div class="tk-bloque">
        <div class="tk-etq">Entrega</div>
        <div class="tk-valor">${p.direccion}</div>
        ${p.colonia ? `<div class="tk-suave">${p.colonia} ${p.cp ? '· CP '+p.cp : ''}</div>` : ''}
        ${fechaEnt && !fechaReal ? `<div class="tk-etq" style="margin-top:10px;">Entrega estimada</div><div class="tk-valor">${fechaEnt}</div>` : ''}
      </div>` : ''}
    <button class="tk-btn" onclick="cargarTracking('${p.consecutivo}')">${REFRESH} Actualizar</button>
    <div class="tk-nota">Actualización automática cada 30 s</div>
  `;
}

// Detectar parámetro ?track=XXX al cargar y abrir tracking directo
(function detectarTrackingURL() {
  const url = new URL(window.location.href);
  // ?ir=armado: lo abre la notificación push. Se espera a que la sesión se
  // restaure (intentarRestaurarSesion es asíncrona) y solo si hay vendedor.
  // Mensaje del service worker al tocar una notificación con la app ya abierta
  // (15 sep 2026): enfocar no basta, hay que navegar desde la propia página.
  // Versión nueva (19 sep 2026): el worker sirve index.html desde caché y, si al
  // revalidar en segundo plano bajó uno distinto, manda {versionNueva:true}. Se
  // enseña una barra discreta; solo recarga si se toca «Actualizar». Nunca sola:
  // podría ser en medio de un checkout. Si no se toca, la nueva entra en la
  // siguiente apertura.
  function mostrarBarraVersionNueva() {
    if (document.getElementById('cp-version-nueva')) return;
    // Ocupa el sitio del banner «Instalar»; si está, se quita: actualizar importa más.
    const inst = document.getElementById('cp-ios-install-banner'); if (inst) inst.remove();
    const b = document.createElement('div');
    b.id = 'cp-version-nueva';
    b.setAttribute('role', 'status');
    b.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(80px + env(safe-area-inset-bottom));z-index:300;display:flex;align-items:center;gap:10px;padding:10px 10px 10px 14px;border-radius:14px;background:var(--gris2);color:var(--blanco);border:1px solid var(--amarillo);box-shadow:0 8px 24px rgba(0,0,0,.4);font-family:Inter,sans-serif;font-size:.85rem;';
    b.innerHTML = '<span style="flex:1">Hay una versión nueva de la app</span>' +
      '<button type="button" id="cp-version-actualizar" style="background:var(--amarillo);color:var(--negro);border:0;border-radius:50px;padding:8px 14px;font-weight:800;font-family:inherit;font-size:.82rem;cursor:pointer">Actualizar</button>' +
      '<button type="button" id="cp-version-cerrar" aria-label="Después" style="background:none;border:0;color:var(--suave);font-size:1.3rem;line-height:1;padding:4px 6px;cursor:pointer">×</button>';
    document.body.appendChild(b);
    document.getElementById('cp-version-actualizar').onclick = () => location.reload();
    document.getElementById('cp-version-cerrar').onclick = () => b.remove();
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.ir === 'armado' && esVendedor && typeof navegar === 'function') navegar('armado');
      if (e.data && e.data.versionNueva) mostrarBarraVersionNueva();
    });
  }
  if (url.searchParams.get('ir') === 'armado') {
    window.addEventListener('load', () => {
      setTimeout(() => { if (esVendedor && typeof navegar === 'function') navegar('armado'); }, 1500);
    });
  }
  const trackParam = url.searchParams.get('track');
  if (trackParam) {
    // Esperar a que la app esté lista
    window.addEventListener('load', () => {
      setTimeout(() => abrirTracking(trackParam), 500);
    });
  }
})();

// CSS animación pulse
(function inyectarPulseGlow() {
  if (document.getElementById('cp-pulse-glow-style')) return;
  const style = document.createElement('style');
  style.id = 'cp-pulse-glow-style';
  style.textContent = `
    @keyframes pulse-glow {
      0%, 100% { box-shadow: 0 0 0 0 rgba(255,210,0,0.6); }
      50% { box-shadow: 0 0 0 8px rgba(255,210,0,0); }
    }
  `;
  document.head.appendChild(style);
})();


// ══════════════════════════════════════════════════════════════════
// CUPÓN EN CHECKOUT (v2.7)
// El cupón se valida vs backend, se guarda en _cuponEnCarrito y se
// aplica al confirmar pedido. Se REGISTRA el uso DESPUÉS de confirmar.
// ══════════════════════════════════════════════════════════════════
let _cuponEnCarrito = null; // { codigo, tipo, valor, descuento, descripcion, id }

window.aplicarCuponDesdeCarrito = async function() {
  const codigo = (document.getElementById('cupon-codigo').value || '').toUpperCase().trim();
  const errEl = document.getElementById('cupon-error');
  errEl.style.display = 'none';
  if (!codigo) {
    errEl.textContent = 'Ingresa un código';
    errEl.style.display = 'block';
    return;
  }

  // Datos para validación
  const totalCompra = totalMonto();
  const tel = (clienteActual?.telefono) || (document.getElementById('f-tel-cliente')?.value || '');
  const idCliente = clienteActual?.id || null;
  let segmento = 'consumidor';
  if (clienteActual) {
    const t = String(clienteActual.tipo || '').toLowerCase();
    if (t.includes('tienda') || t.includes('restaurante') || t.includes('abarrotes')) segmento = 'b2b';
  }

  const btn = document.getElementById('cupon-btn-aplicar');
  const orig = btn.textContent;
  btn.textContent = '...';
  btn.disabled = true;

  try {
    // Llamada a la función Postgres validar_cupon vía RPC
    const res = await supabaseCall('POST', 'rpc/validar_cupon', {
      p_codigo: codigo,
      p_telefono: String(tel || '').replace(/\D/g, '').slice(-10) || null,
      p_id_cliente: idCliente || null,
      p_total_compra: totalCompra,
      p_segmento_cliente: segmento,
    });
    if (!res || !res.ok) {
      errEl.textContent = (res && res.error) || 'Cupón inválido';
      errEl.style.display = 'block';
      return;
    }
    _cuponEnCarrito = res.cupon;
    document.getElementById('cupon-input-wrap').style.display = 'none';
    document.getElementById('cupon-aplicado').style.display = 'block';
    document.getElementById('cupon-aplicado-codigo').textContent = _cuponEnCarrito.codigo;
    let descTxt = _cuponEnCarrito.descripcion || '';
    if (!descTxt) {
      if (_cuponEnCarrito.tipo === 'descuento_pct') descTxt = `${_cuponEnCarrito.valor}% de descuento`;
      else if (_cuponEnCarrito.tipo === 'descuento_fijo') descTxt = `$${_cuponEnCarrito.valor} de descuento`;
      else if (_cuponEnCarrito.tipo === 'producto_gratis') descTxt = 'Producto gratis';
      else if (_cuponEnCarrito.tipo === 'envio_gratis') descTxt = 'Envío gratis';
    }
    document.getElementById('cupon-aplicado-desc').textContent = descTxt;
    mostrarToast('Cupón aplicado');
    // Re-pintar drawer para mostrar subtotal/descuento/total
    if (typeof renderDrawer === 'function') renderDrawer();
  } catch(e) {
    errEl.textContent = 'Error: ' + e.message;
    errEl.style.display = 'block';
  } finally {
    btn.textContent = orig;
    btn.disabled = false;
  }
};

window.quitarCuponDelCarrito = function() {
  _cuponEnCarrito = null;
  document.getElementById('cupon-codigo').value = '';
  document.getElementById('cupon-input-wrap').style.display = 'block';
  document.getElementById('cupon-aplicado').style.display = 'none';
  document.getElementById('cupon-error').style.display = 'none';
  if (typeof renderDrawer === 'function') renderDrawer();
};

// Calcular descuento del cupón en moneda. Considera cambios de carrito.
function calcularDescuentoCupon(subtotal) {
  if (!_cuponEnCarrito) return 0;
  if (_cuponEnCarrito.tipo === 'descuento_pct') {
    return Math.round(subtotal * _cuponEnCarrito.valor / 100 * 100) / 100;
  }
  if (_cuponEnCarrito.tipo === 'descuento_fijo') {
    return Math.min(_cuponEnCarrito.valor, subtotal);
  }
  return 0; // producto_gratis y envio_gratis se manejan aparte
}

// v2.10: Calcular si el cupón aplica para descontar envío
function calcularDescuentoEnvio(costoEnvio) {
  if (!_cuponEnCarrito) return 0;
  if (_cuponEnCarrito.tipo === 'envio_gratis' && costoEnvio > 0) {
    return costoEnvio;  // cubre el costo completo
  }
  return 0;
}


window.abrirCoordsEnMapa = function(coords) {
  if (!coords) return;
  const partes = String(coords).split(',').map(s => s.trim());
  if (partes.length < 2) return;
  const url = `https://www.google.com/maps?q=${partes[0]},${partes[1]}`;
  window.open(url, '_blank');
};



if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(err => {
      console.warn('Service Worker no registrado:', err);
    });
  });
}

// Captura el evento de instalación para mostrar nuestro propio botón
let _deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _deferredInstallPrompt = e;
  // Mostrar banner si no se ha cerrado en esta sesión
  if (!sessionStorage.getItem('cp_install_dismissed')) {
    setTimeout(mostrarBannerInstalar, 3000);
  }
});

function mostrarBannerInstalar() {
  if (!_deferredInstallPrompt) return;
  // Evitar duplicados
  if (document.getElementById('cp-install-banner')) return;

  const banner = document.createElement('div');
  banner.id = 'cp-install-banner';
  banner.style.cssText = `
    position:fixed;bottom:80px;left:12px;right:12px;
    background:linear-gradient(135deg,#FFD200,#e6bc00);
    color:#000;border-radius:14px;padding:12px 14px;
    box-shadow:0 8px 24px rgba(0,0,0,0.4);
    z-index:300;display:flex;align-items:center;gap:10px;
    font-family:'Inter',sans-serif;
  `;
  banner.innerHTML = `
    <span style="font-size:1.6rem;" class="ico-solo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><path d="M11 18h2"/></svg></span>
    <div style="flex:1;min-width:0;">
      <div style="font-weight:900;font-size:0.86rem;line-height:1.1;">Instalar Crunchy Paps</div>
      <div style="font-size:0.7rem;font-weight:600;opacity:0.85;">Acceso directo desde tu pantalla</div>
    </div>
    <button id="cp-install-btn" style="background:#000;color:#FFD200;border:none;border-radius:8px;padding:8px 12px;font-family:inherit;font-weight:900;font-size:0.78rem;cursor:pointer;">Instalar</button>
    <button id="cp-install-x" style="background:transparent;border:none;color:#000;font-size:1.2rem;cursor:pointer;padding:4px 8px;">✕</button>
  `;
  document.body.appendChild(banner);
  document.getElementById('cp-install-btn').onclick = async () => {
    if (!_deferredInstallPrompt) return;
    _deferredInstallPrompt.prompt();
    const { outcome } = await _deferredInstallPrompt.userChoice;
    _deferredInstallPrompt = null;
    banner.remove();
    if (outcome === 'accepted') mostrarToast('¡App instalada!');
  };
  document.getElementById('cp-install-x').onclick = () => {
    sessionStorage.setItem('cp_install_dismissed', '1');
    banner.remove();
  };
}

// Para iOS (Safari no soporta beforeinstallprompt): mostrar instrucciones
function detectarIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}
function estaInstalada() {
  return window.matchMedia('(display-mode: standalone)').matches ||
         window.navigator.standalone === true;
}
window.addEventListener('load', () => {
  if (estaInstalada()) return;
  const esIOS     = detectarIOS();
  const esAndroid = /Android/i.test(navigator.userAgent);
  if (!esIOS && !esAndroid) return;
  const dismissKey = esIOS ? 'cp_ios_install_dismissed' : 'cp_android_install_dismissed';
  if (sessionStorage.getItem(dismissKey)) return;
  setTimeout(() => {
    if (estaInstalada()) return;
    // En Android, si el navegador ya ofrece su prompt nativo, ese banner se encarga
    if (esAndroid && _deferredInstallPrompt) return;
    if (document.getElementById('cp-ios-install-banner')) return;
    if (document.getElementById('cp-version-nueva')) return;   // la barra de versión ocupa el mismo sitio
      const banner = document.createElement('div');
      banner.id = 'cp-ios-install-banner';
      banner.style.cssText = `
        position:fixed;bottom:80px;left:12px;right:12px;
        background:linear-gradient(135deg,#FFD200,#e6bc00);
        color:#000;border-radius:14px;padding:12px 14px;
        box-shadow:0 8px 24px rgba(0,0,0,0.4);
        z-index:300;display:flex;align-items:center;gap:10px;
        font-family:'Inter',sans-serif;cursor:pointer;
      `;
      banner.innerHTML = `
        <span style="font-size:1.6rem;" class="ico-solo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><path d="M11 18h2"/></svg></span>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:900;font-size:0.84rem;line-height:1.1;">Instala Crunchy Paps</div>
          <div style="font-size:0.7rem;font-weight:600;opacity:0.85;">Toca para ver cómo →</div>
        </div>
        <button id="cp-ios-x" style="background:transparent;border:none;color:#000;font-size:1.2rem;cursor:pointer;padding:4px 8px;">✕</button>
      `;
      document.body.appendChild(banner);
      banner.addEventListener('click', (e) => {
        if (e.target.id === 'cp-ios-x') return;
        mostrarInstruccionesInstalar();
      });
      document.getElementById('cp-ios-x').onclick = (e) => {
        e.stopPropagation();
        sessionStorage.setItem(dismissKey, '1');
        banner.remove();
      };
  }, 3000);
});

// ══════════════════════════════════════════════════════════════════
// Modal de instrucciones para instalar PWA (iOS y Android)
// ══════════════════════════════════════════════════════════════════
window.mostrarInstruccionesInstalar = function() {
  // Si en Android tenemos el prompt nativo, dispararlo directo
  if (_deferredInstallPrompt) {
    _deferredInstallPrompt.prompt();
    _deferredInstallPrompt.userChoice.then(({outcome}) => {
      if (outcome === 'accepted') mostrarToast('¡App instalada!');
      _deferredInstallPrompt = null;
    });
    return;
  }

  // Crear overlay + modal
  const ov = document.createElement('div');
  ov.id = 'cp-install-modal-ov';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:400;display:flex;align-items:flex-end;justify-content:center;';

  const isIOS = detectarIOS();
  const isAndroid = /Android/i.test(navigator.userAgent);

  let pasos = '';
  if (isIOS) {
    pasos = `
      <div style="background:var(--gris2);border-radius:12px;padding:14px;margin-bottom:8px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="background:var(--amarillo);color:#000;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:0.86rem;flex-shrink:0;">1</div>
          <div style="font-size:0.86rem;color:var(--blanco);font-weight:700;">Toca el botón <span style="display:inline-block;background:#fff;color:#007AFF;border-radius:4px;padding:1px 6px;font-weight:900;">⬆️</span> de Compartir</div>
        </div>
        <div style="font-size:0.74rem;color:var(--suave);margin-top:6px;margin-left:38px;">Está en la barra inferior del navegador (Safari) o arriba a la derecha (Chrome)</div>
      </div>
      <div style="background:var(--gris2);border-radius:12px;padding:14px;margin-bottom:8px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="background:var(--amarillo);color:#000;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:0.86rem;flex-shrink:0;">2</div>
          <div style="font-size:0.86rem;color:var(--blanco);font-weight:700;">Desliza y elige <strong style="color:var(--amarillo);">"Añadir a inicio"</strong></div>
        </div>
        <div style="font-size:0.74rem;color:var(--suave);margin-top:6px;margin-left:38px;">Aparece en el menú entre las opciones</div>
      </div>
      <div style="background:var(--gris2);border-radius:12px;padding:14px;margin-bottom:8px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="background:var(--amarillo);color:#000;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:0.86rem;flex-shrink:0;">3</div>
          <div style="font-size:0.86rem;color:var(--blanco);font-weight:700;">Toca <strong style="color:var(--amarillo);">"Añadir"</strong> arriba a la derecha</div>
        </div>
        <div style="font-size:0.74rem;color:var(--suave);margin-top:6px;margin-left:38px;">El ícono aparecerá en tu pantalla principal</div>
      </div>
    `;
  } else if (isAndroid) {
    pasos = `
      <div style="background:#0d2d0d;border:1px solid #4caf50;border-radius:12px;padding:12px;margin-bottom:10px;font-size:0.78rem;color:#4caf50;">
        ℹ️ Si aún no aparece el banner automático, sigue estos pasos:
      </div>
      <div style="background:var(--gris2);border-radius:12px;padding:14px;margin-bottom:8px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="background:var(--amarillo);color:#000;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:0.86rem;flex-shrink:0;">1</div>
          <div style="font-size:0.86rem;color:var(--blanco);font-weight:700;">Abre el menú <span style="background:#fff;color:#000;padding:1px 6px;border-radius:4px;font-weight:900;">⋮</span> arriba a la derecha</div>
        </div>
      </div>
      <div style="background:var(--gris2);border-radius:12px;padding:14px;margin-bottom:8px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="background:var(--amarillo);color:#000;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:0.86rem;flex-shrink:0;">2</div>
          <div style="font-size:0.86rem;color:var(--blanco);font-weight:700;">Toca <strong style="color:var(--amarillo);">"Instalar app"</strong> o <strong style="color:var(--amarillo);">"Agregar a pantalla de inicio"</strong></div>
        </div>
      </div>
      <div style="background:var(--gris2);border-radius:12px;padding:14px;margin-bottom:8px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="background:var(--amarillo);color:#000;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:0.86rem;flex-shrink:0;">3</div>
          <div style="font-size:0.86rem;color:var(--blanco);font-weight:700;">Confirma <strong style="color:var(--amarillo);">"Instalar"</strong></div>
        </div>
      </div>
    `;
  } else {
    // Desktop
    pasos = `
      <div style="background:var(--gris2);border-radius:12px;padding:14px;margin-bottom:8px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="background:var(--amarillo);color:#000;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:0.86rem;flex-shrink:0;">1</div>
          <div style="font-size:0.86rem;color:var(--blanco);font-weight:700;">Busca el ícono <strong style="color:var(--amarillo);">⊕</strong> en la barra de direcciones</div>
        </div>
      </div>
      <div style="background:var(--gris2);border-radius:12px;padding:14px;margin-bottom:8px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="background:var(--amarillo);color:#000;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:0.86rem;flex-shrink:0;">2</div>
          <div style="font-size:0.86rem;color:var(--blanco);font-weight:700;">Toca <strong style="color:var(--amarillo);">"Instalar"</strong></div>
        </div>
      </div>
    `;
  }

  ov.innerHTML = `
    <div style="background:var(--negro);border-top:4px solid var(--amarillo);border-radius:18px 18px 0 0;width:100%;max-width:480px;max-height:90vh;overflow-y:auto;padding:18px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
        <div style="font-family:'Archivo',sans-serif;font-size:1.3rem;color:var(--amarillo);">INSTALAR LA APP</div>
        <button id="cp-instr-close" style="background:var(--gris3);border:none;border-radius:50%;width:32px;height:32px;color:var(--suave);font-size:1.1rem;cursor:pointer;">✕</button>
      </div>
      <div style="font-size:0.82rem;color:var(--suave);margin-bottom:14px;line-height:1.4;">
        Tendrás Crunchy Paps como una app nativa: ícono en pantalla principal, pantalla completa, acceso rápido sin abrir el navegador.
      </div>
      ${pasos}
      <button id="cp-instr-ok" style="width:100%;background:var(--amarillo);border:none;border-radius:10px;padding:13px;font-family:'Inter',sans-serif;font-weight:900;font-size:0.9rem;color:#000;cursor:pointer;margin-top:6px;">
        Entendido
      </button>
    </div>
  `;
  document.body.appendChild(ov);
  const cerrar = () => ov.remove();
  document.getElementById('cp-instr-close').onclick = cerrar;
  document.getElementById('cp-instr-ok').onclick = cerrar;
  ov.addEventListener('click', e => { if (e.target === ov) cerrar(); });
};


// Logo oficial + carrusel de banners (imágenes en Storage + config JSON).
// Sin archivos subidos: se mantiene el logo de texto y el banner actual.
(function () {
  var BASE = SUPABASE_URL + '/storage/v1/object/public/contenido/';

  // --- Logo en el header (reemplaza el texto si existe el archivo) ---
  try {
    var logoUrl = BASE + 'logo/logo.png';
    var lim = new Image();
    lim.onload = function () {
      document.querySelectorAll('.logo').forEach(function (el) {
        el.innerHTML = '<img src="' + logoUrl + '" alt="Crunchy Paps" style="height:32px;width:auto;display:block;">';
      });
    };
    lim.src = logoUrl;
  } catch (e) {}

  // --- Carrusel de banners ---
  function irAInicioLuego(fn) {
    if (typeof window.navegar === 'function') { try { window.navegar('inicio'); } catch (e) {} }
    setTimeout(fn, 250);
  }
  function aplicarDestinoBanner(b) {
    try { track('banner_click', { img: b.img, destino: b.destino || 'none', sabor: b.sabor || '', presentacion: b.presentacion || '' }); } catch(e) {}
    var dest = b.destino;
    if (!dest) return;
    if (dest === 'producto' && b.productoId != null) {
      irAInicioLuego(function () { if (window.verProducto) window.verProducto(b.productoId); });
      return;
    }
    if (dest === 'catalogo') {
      irAInicioLuego(function () {
        if (b.sabor && window.cambiarSabor) window.cambiarSabor(b.sabor);
        else if (b.presentacion && window.cambiarSabor) window.cambiarSabor('__todos'); // todos los sabores de esa presentación
        if (b.presentacion && window.cambiarPresentacion) window.cambiarPresentacion(b.presentacion);
      });
      return;
    }
    if (typeof window.navegar === 'function') { try { window.navegar(dest); } catch (e) {} }
  }
  function montarCarrusel(banners) {
    // Opción A (12 sep 2026): el carrusel va DEBAJO del saludo, como tarjeta con
    // margen, y ya no sustituye el titular. Si Storage falla, se ve el saludo.
    var ancla = document.querySelector('.banner-cat');
    if (!ancla || !banners.length) return;
    var cont = document.getElementById('bn-wrap');
    if (!cont) { cont = document.createElement('div'); cont.className = 'bn-wrap'; cont.id = 'bn-wrap'; ancla.insertAdjacentElement('afterend', cont); }
    cont.innerHTML = '<div class="bn-carousel"><div class="bn-track" id="bn-track"></div>'
      + (banners.length > 1 ? '<div class="bn-dots" id="bn-dots"></div>' : '') + '</div>';
    var track = document.getElementById('bn-track');
    var dotsWrap = document.getElementById('bn-dots');
    var swiped = false; // distingue deslizar (swipe) de tocar (tap) — evita abrir destino al deslizar
    banners.forEach(function (b, i) {
      var slide = document.createElement('div');
      slide.className = 'bn-slide';
      slide.innerHTML = '<img src="' + BASE + 'banner/' + b.img + '" alt="">';
      if (b.destino) {
        slide.style.cursor = 'pointer';
        slide.addEventListener('click', function () { if (!swiped) aplicarDestinoBanner(b); });
      }
      track.appendChild(slide);
      if (dotsWrap) {
        var d = document.createElement('div');
        d.className = 'bn-dot' + (i === 0 ? ' active' : '');
        dotsWrap.appendChild(d);
      }
    });
    var idx = 0, n = banners.length, timer = null;
    function go(k) {
      idx = (k + n) % n;
      track.style.transform = 'translateX(-' + (idx * 100) + '%)';
      if (dotsWrap) Array.prototype.forEach.call(dotsWrap.children, function (d, i) { d.className = 'bn-dot' + (i === idx ? ' active' : ''); });
    }
    function auto() { if (n > 1) { clearInterval(timer); timer = setInterval(function () { go(idx + 1); }, 5000); } }
    auto();
    var x0 = null;
    track.addEventListener('touchstart', function (e) { x0 = e.touches[0].clientX; swiped = false; }, { passive: true });
    track.addEventListener('touchmove', function (e) {
      if (x0 === null) return;
      if (Math.abs(e.touches[0].clientX - x0) > 10) swiped = true;
    }, { passive: true });
    track.addEventListener('touchend', function (e) {
      if (x0 === null) return;
      var dx = e.changedTouches[0].clientX - x0;
      if (Math.abs(dx) > 40) { swiped = true; go(idx + (dx < 0 ? 1 : -1)); auto(); try{ track('banner_swipe', { dir: dx < 0 ? 'next' : 'prev' }); }catch(e){} }
      x0 = null;
    }, { passive: true });
  }

  function intentarPrincipal() {
    var im = new Image();
    im.onload = function () { montarCarrusel([{ img: 'principal.jpg' }]); };
    im.src = BASE + 'banner/principal.jpg';
  }

  try {
    fetch(BASE + 'banner/banners.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (arr) {
        var ban = (Array.isArray(arr) ? arr : []).filter(function (b) { return b && b.img; });
        if (ban.length) montarCarrusel(ban); else intentarPrincipal();
      })
      .catch(intentarPrincipal);
  } catch (e) {}
})();

// Regreso desde Stripe Checkout (?pago=ok / ?pago=cancel) — confirmación clara y persistente
function quitarPagoCover() { const c = document.getElementById('pago-cover'); if (c) c.remove(); }
function mostrarPagoConfirmado(ok) {
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;padding:24px;';
  const icon = ok ? '' : '';
  const titulo = ok ? '¡Pago confirmado!' : 'Pago no completado';
  const msg = ok
    ? 'Recibimos tu pago y tu pedido quedó registrado. El equipo Crunchy Paps se pondrá en contacto para coordinar la entrega.'
    : 'Tu pago se canceló o no se completó. Tu pedido quedó guardado como pendiente; puedes intentar pagar de nuevo.';
  ov.innerHTML = '<div style="background:#0e0e0e;border:1px solid #222;border-radius:16px;max-width:360px;width:100%;padding:28px 22px;text-align:center;">'
    + '<div style="font-size:3rem;line-height:1;margin-bottom:10px;">' + icon + '</div>'
    + '<div style="font-weight:900;font-size:1.3rem;color:#fff;margin-bottom:8px;">' + titulo + '</div>'
    + '<div style="font-size:0.92rem;color:rgba(255,255,255,0.78);line-height:1.5;margin-bottom:20px;">' + msg + '</div>'
    + '<button id="pago-ok-btn" style="background:#ffd200;color:#111;border:none;border-radius:10px;padding:13px 20px;font-weight:900;font-size:0.95rem;cursor:pointer;width:100%;">Entendido</button>'
    + '</div>';
  document.body.appendChild(ov);
  const b = ov.querySelector('#pago-ok-btn');
  if (b) b.addEventListener('click', function () { ov.remove(); quitarPagoCover(); });
}
(function () {
  try {
    const q = new URLSearchParams(location.search);
    const pago = q.get('pago');
    if (!pago) return;
    history.replaceState({}, '', location.pathname);
    // Cubierta opaca inmediata: oculta el parpadeo del login mientras se restaura la sesión
    if (document.body) {
      const cover = document.createElement('div');
      cover.id = 'pago-cover';
      cover.style.cssText = 'position:fixed;inset:0;z-index:10000;background:#0e0e0e;display:flex;align-items:center;justify-content:center;';
      cover.innerHTML = '<div style="text-align:center;color:#fff;"><div class="loader loader-w" style="margin:0 auto 14px;"></div><div style="font-weight:800;">Confirmando tu pago…</div></div>';
      document.body.appendChild(cover);
    }
    let graciasRaw = null;
    try { graciasRaw = localStorage.getItem('cp_gracias_pendiente'); localStorage.removeItem('cp_gracias_pendiente'); } catch (e) {}
    if (pago === 'ok') {
      // Vaciar SOLO el carrito en la sesión guardada, sin tocar el login (no pedir OTP otra vez)
      try {
        const raw = localStorage.getItem('cp_session');
        if (raw) { const s = JSON.parse(raw); s.carrito = {}; localStorage.setItem('cp_session', JSON.stringify(s)); }
      } catch (e) {}
    }
    setTimeout(function () {
      if (pago === 'ok' && graciasRaw) {
        // Reconstruir la pantalla de ¡Gracias! con el resumen guardado antes del pago
        try {
          const g = JSON.parse(graciasRaw);
          const c = document.getElementById('g-consec'); if (c) c.textContent = g.consec || '—';
          const gv = document.getElementById('g-vendedor'); if (gv) gv.textContent = g.vendedorTxt || '';
          const gp = document.getElementById('g-puntos'); if (gp) gp.textContent = (g.puntos > 0) ? ('+' + g.puntos + ' puntos por tu compra') : '';
          wppUrlPend = { vendedor: g.wppVendedor, bodega: g.wppBodega };
          pintarGraciasB2B(!!g.b2b, !!g.asesor);
          quitarPagoCover();
          const ov = document.getElementById('gracias-overlay'); if (ov) ov.classList.add('visible');
          return;
        } catch (e) {}
      }
      mostrarPagoConfirmado(pago === 'ok');
    }, 700);
  } catch (e) {}
})();

// ════════════════════════════════════════════════════════════════
// Encuesta post-entrega (Friends & Family) — producto + app UX
// Vive dentro del módulo para acceder a supabaseCall() y mostrarToast()
// ════════════════════════════════════════════════════════════════
(function () {
  var estado = { idOrden: null, sabor: '', textura: '', sal: '', recompra: '', appFacilidad: '' };

  function pintarStars(group, val) {
    var cont = document.querySelector('.ffe-stars[data-group="' + group + '"]');
    if (!cont) return;
    cont.querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('ffe-on', Number(b.dataset.val) <= Number(val));
    });
  }
  function pintarPills(group, val) {
    var cont = document.querySelector('.ffe-pills[data-group="' + group + '"]');
    if (!cont) return;
    cont.querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('ffe-on', b.dataset.val === val);
    });
  }

  function resetForm() {
    estado = { idOrden: null, sabor: '', textura: '', sal: '', recompra: '', appFacilidad: '' };
    var m = document.getElementById('ffe-modal');
    if (!m) return;
    m.querySelectorAll('button.ffe-on').forEach(function (b) { b.classList.remove('ffe-on'); });
    var c = document.getElementById('ffe-comentario');
    if (c) c.value = '';
  }

  var ffeModal = document.getElementById('ffe-modal');
  if (ffeModal) {
    ffeModal.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-val]');
      if (!btn) return;
      var grp = btn.parentElement.dataset.group;
      if (!grp) return;
      estado[grp] = btn.dataset.val;
      if (btn.parentElement.classList.contains('ffe-stars')) pintarStars(grp, btn.dataset.val);
      else pintarPills(grp, btn.dataset.val);
    });
  }

  window.crunchyEncuesta = {
    async checarPendiente(telefono) {
      if (!telefono || typeof supabaseCall !== 'function') return;
      try {
        var res = await supabaseCall('POST', 'rpc/obtener_encuesta_pendiente', { p_data: { telefono: String(telefono) } });
        if (res && res.ok && res.pendiente && res.orden) {
          resetForm();
          estado.idOrden = res.orden.id;
          this.abrir();
        }
      } catch (e) { /* silencioso: la encuesta nunca debe romper el flujo */ }
    },
    abrirParaOrden(idOrden) {
      if (!idOrden) return;
      resetForm();
      estado.idOrden = idOrden;
      this.abrir();
    },
    abrir() {
      var m = document.getElementById('ffe-modal');
      if (m) m.classList.add('ffe-open');
    },
    cerrar() {
      var m = document.getElementById('ffe-modal');
      if (m) m.classList.remove('ffe-open');
    },
    async enviar() {
      if (!estado.idOrden) { this.cerrar(); return; }
      var payload = {
        idOrden: String(estado.idOrden),
        sabor: estado.sabor,
        textura: estado.textura,
        sal: estado.sal,
        recompra: estado.recompra,
        appFacilidad: estado.appFacilidad,
        comentario: (document.getElementById('ffe-comentario') || {}).value || '',
        utmCampaign: (function () {
          try {
            var a = (typeof window.cpAtribucion === 'function') ? window.cpAtribucion('last') : {};
            return a.utm_campaign || '';
          } catch (e) { return ''; }
        })()
      };
      try {
        var res = await supabaseCall('POST', 'rpc/guardar_encuesta', { p_data: payload });
        if (res && res.ok) {
          if (typeof mostrarToast === 'function') mostrarToast('¡Gracias por tu feedback!');
        } else {
          if (typeof mostrarToast === 'function') mostrarToast('No se pudo guardar, intenta de nuevo');
        }
      } catch (e) {
        if (typeof mostrarToast === 'function') mostrarToast('No se pudo guardar, intenta de nuevo');
      }
      this.cerrar();
    }
  };
})();


// ── Puente con el panel (cambios/2026-09-19-partir-monolito) ─────────────────
export const N = {
  get ARMADO_TITULO_BASE() { return ARMADO_TITULO_BASE; },
  get CACHE_KEYS() { return CACHE_KEYS; },
  get MAYOREO_MINIMOS() { return MAYOREO_MINIMOS; }, set MAYOREO_MINIMOS(valor) { MAYOREO_MINIMOS = valor; },
  get SALTO() { return SALTO; },
  get WHATSAPP_NUM() { return WHATSAPP_NUM; },
  get _modoCliente() { return _modoCliente; }, set _modoCliente(valor) { _modoCliente = valor; },
  get _pedidoActual() { return _pedidoActual; }, set _pedidoActual(valor) { _pedidoActual = valor; },
  get canalVenta() { return canalVenta; }, set canalVenta(valor) { canalVenta = valor; },
  get carrito() { return carrito; }, set carrito(valor) { carrito = valor; },
  get clienteActual() { return clienteActual; }, set clienteActual(valor) { clienteActual = valor; },
  get esVendedor() { return esVendedor; }, set esVendedor(valor) { esVendedor = valor; },
  get mapsListo() { return mapsListo; }, set mapsListo(valor) { mapsListo = valor; },
  get telefonoVerif() { return telefonoVerif; }, set telefonoVerif(valor) { telefonoVerif = valor; },
  get tipoCliente() { return tipoCliente; }, set tipoCliente(valor) { tipoCliente = valor; },
  get vendedorInfo() { return vendedorInfo; }, set vendedorInfo(valor) { vendedorInfo = valor; },
  abrirVentanaPendiente,
  actualizarBadge,
  bloquearCamposCliente,
  cacheClear,
  cantidadConCajas,
  cerrarVentanaPendiente,
  esAdmin,
  esAdminEstricto,
  guardarSesion,
  initMaps,
  irAWhatsApp,
  irAlCatalogo,
  mostrarToast,
  renderClubAdminCfg,
  renderDrawer,
  saborDot,
  sesionExpirada,
  sheetsCall,
  supabaseCall,
  tokenVendedor,
  totalItems,
};
export let P = null;
export function cargarPanel() { return P ? Promise.resolve(P) : import('./panel.js').then((m) => (P = m)); }

// El <script> vanilla de index.html (pantalla PIN) no es un módulo: necesita el cargador por window.
window.cargarPanel = cargarPanel;

// ── Envoltorios para los window.* del panel que cuelgan de una pantalla COMPARTIDA ──
// `s-pin` (antes de que exista sesión de vendedor) y `s-cuenta` (los cinco botones de vendedor, que
// se pintan mientras la precarga puede seguir en vuelo). Ninguno de estos nombres se EXPORTA desde
// panel.js: solo son `window.X = …`, así que el envoltorio carga y vuelve a leer `window.X`, que para
// entonces ya lo pisó el panel. Las pantallas que cuelgan de estos botones (`s-alta-negocio`,
// `s-ajustar-ubicacion`, `#pin-form`) no necesitan envoltorio: solo se llega a ellas desde aquí.
['verificarPIN', 'focoPIN', 'retrocesoPIN', 'abrirAltaNegocio', 'abrirAjustarUbicacion', 'abrirPermisos', 'abrirCambioPin', 'guardarPinPropio']
  .forEach((nombre) => {
    window[nombre] = function (...args) { return cargarPanel().then(() => window[nombre](...args)); };
  });
