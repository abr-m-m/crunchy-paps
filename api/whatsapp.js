// ============================================================================
//  Crunchy Paps — Agente de WhatsApp (Meta Cloud API)
//  Vercel Serverless Function · repo: /api/whatsapp.js
//
//  Diseno: cambios/2026-11-12-agente-whatsapp.md
//  Plan:   cambios/2026-11-12-agente-whatsapp-plan.md
//
//  GET  -> verificacion del webhook de Meta (hub.challenge). Meta la hace una
//          vez, al conectar el numero.
//  POST -> mensaje entrante, firmado con X-Hub-Signature-256.
//
//  ENV: WA_VERIFY_TOKEN, WA_APP_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//       WA_TOKEN, WA_PHONE_ID, ANTHROPIC_API_KEY, WA_GRAPH_VERSION (opcional)
//       (las herramientas y WA_VENDEDOR_TOKEN llegan con las tareas 5 a 7)
//
//  NOTA: `npm run validar` NO mira esta carpeta — ninguno de sus tres pasos abre
//  api/. La red de este archivo es `node --check api/whatsapp.js`, y va en cada
//  tarea del plan que lo toque.
// ============================================================================
const { createHmac, timingSafeEqual } = require('crypto');

const WA_VERIFY = process.env.WA_VERIFY_TOKEN;
const WA_SECRET = process.env.WA_APP_SECRET;
const SUPA_URL  = process.env.SUPABASE_URL;
const SUPA_SR   = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Los dos topes viven aqui, no en la base: afinarlos no deberia costar una
// migracion. La funcion wa_entrante los recibe como parametros.
const TOPE_POR_NUMERO = 40;    // mensajes entrantes por numero, en 24 h
const TOPE_GLOBAL     = 400;   // mensajes entrantes de todos, en 24 h

const WA_TOKEN    = process.env.WA_TOKEN;
const WA_PHONE_ID = process.env.WA_PHONE_ID;
// v25.0 es la que usa la documentacion de Meta en noviembre de 2026. Cada version
// vive unos dos anos. Esta en una variable para poder subirla sin tocar codigo, y
// hay que comprobarla contra el endpoint /versions antes de desplegar.
const WA_GRAPH = process.env.WA_GRAPH_VERSION || 'v25.0';

const MODELO = 'claude-opus-5-5';
const MAX_TURNOS = 24;         // turnos de texto que se guardan del hilo
const MAX_SALIDA = 4096;       // una respuesta de WhatsApp es corta: esto es tope, no meta

// ── La puerta ───────────────────────────────────────────────────────────────
// Compara en tiempo constante y NUNCA lanza: una firma con basura devuelve
// false, no un 500. Un 500 le diria a quien esta probando que acerto el formato
// y fallo por otra cosa; un 403 no le dice nada.
function firmaValida(crudo, firma, secreto) {
  if (typeof firma !== 'string' || typeof secreto !== 'string') return false;
  if (!firma || !secreto) return false;
  if (!firma.startsWith('sha256=')) return false;

  const esperada = 'sha256=' + createHmac('sha256', secreto).update(crudo, 'utf8').digest('hex');
  const a = Buffer.from(firma, 'utf8');
  const b = Buffer.from(esperada, 'utf8');
  if (a.length !== b.length) return false;   // timingSafeEqual lanza si difieren
  return timingSafeEqual(a, b);
}

// ── El cuerpo, byte a byte ──────────────────────────────────────────────────
// La firma se calcula sobre los BYTES que mando Meta. Reconstruir el JSON con
// JSON.stringify(req.body) funciona por suerte hasta que Meta cambia un espacio
// o el orden de una clave, y entonces falla sin explicacion. Asi que: el crudo
// o nada.
//
// Si el runtime ya consumio el stream, esto devuelve cadena vacia y la firma
// falla con 403 — que es ruidoso y se ve en el primer POST real, no silencioso.
// El arreglo entonces es apagar el parseo del body, no serializar req.body.
function leerCrudo(req) {
  if (typeof req.rawBody === 'string') return Promise.resolve(req.rawBody);
  if (Buffer.isBuffer(req.rawBody)) return Promise.resolve(req.rawBody.toString('utf8'));
  if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body.toString('utf8'));

  return new Promise((resolve, reject) => {
    let d = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { d += c; });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}

// ── Supabase ────────────────────────────────────────────────────────────────
// El mismo helper que api/recordatorios-pago.js:36. Copiado a proposito y no
// extraido a un modulo: cada archivo de api/ es autocontenido en este proyecto.
async function supa(path, method, body, prefer) {
  const r = await fetch(SUPA_URL + '/rest/v1/' + path, {
    method,
    headers: {
      apikey: SUPA_SR,
      Authorization: 'Bearer ' + SUPA_SR,
      'Content-Type': 'application/json',
      Prefer: prefer || 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let data; try { data = JSON.parse(txt); } catch { data = txt; }
  return { ok: r.ok, status: r.status, data };
}

// El UNICO punto por donde una prueba puede sustituir el transporte de la
// cotizacion. Existe porque la llave de servicio no se puede obtener del CLI de
// Supabase -solo entrega las legacy, apagadas el 18 sep 2026, y trunca las
// nuevas-, asi que sin esto la parte del dinero no se puede probar en local sin
// meter un secreto en el disco.
//
// Lo que compra: la prueba puede ESPIAR con que `p_nivel` se llama al servidor,
// que es exactamente la propiedad de D6 y se ve mejor espiando la llamada que
// mirando el total.
//
// Y se cierra con llave en produccion: en Vercel, llamarlo lanza. Un gancho de
// pruebas que en produccion sigue abierto no es un gancho, es una puerta.
// (se exporta al final del archivo: `module.exports = handler` reemplaza el objeto
// entero, asi que cualquier cosa colgada de module.exports ANTES de esa linea se
// pierde sin avisar. node --check no lo ve y comprobar-libres.mjs tampoco.)
let transporte = (...a) => supa(...a);
function usarTransporteDePrueba(f) {
  if (process.env.VERCEL) throw new Error('el transporte de prueba no se sustituye en produccion');
  transporte = typeof f === 'function' ? f : ((...a) => supa(...a));
}

// ── Los topes ───────────────────────────────────────────────────────────────
// Registra el mensaje que entra y dice si cabe. El conteo y el registro van en
// la misma llamada (wa_entrante), asi que no hay hueco entre contar y registrar.
async function registrarEntrante(telefono, texto) {
  const r = await supa('rpc/wa_entrante', 'POST', {
    p_telefono: telefono,
    p_texto: texto,
    p_tope_numero: TOPE_POR_NUMERO,
    p_tope_global: TOPE_GLOBAL,
  });
  // Si la base no contesta, se para. Un contador que falla abierto no es un tope:
  // justo el dia que Supabase va lento seria el dia sin limite de gasto.
  if (!r.ok || !r.data || typeof r.data.permitido !== 'boolean') {
    console.error('wa: wa_entrante no contesto', r.status, JSON.stringify(r.data).slice(0, 300));
    return { permitido: false, motivo: 'sin_base' };
  }
  return r.data;
}

// ── El mensaje que manda Meta ───────────────────────────────────────────────
// Meta tambien manda acuses de entrega y lecturas, que vienen sin `messages`.
// Devuelve null cuando no hay nada que atender.
function sacarMensaje(cuerpo) {
  try {
    const v = cuerpo.entry[0].changes[0].value;
    const m = v.messages && v.messages[0];
    if (!m) return null;
    return {
      id: m.id,
      telefono: m.from,
      tipo: m.type,
      texto: m.type === 'text' ? m.text.body : '',
      nombrePerfil: (v.contacts && v.contacts[0] && v.contacts[0].profile
        && v.contacts[0].profile.name) || '',
    };
  } catch {
    return null;
  }
}

// ── El hilo ─────────────────────────────────────────────────────────────────
// Se guardan SOLO los turnos de texto, no las llamadas a herramientas. Dos
// razones: un historial con un tool_use sin su tool_result al lado lo rechaza la
// API, y podar por la mitad de un par es facilisimo; y lo que el agente necesita
// recordar de un mensaje al siguiente ("te cotice 6 cajas en $1,240") esta en su
// propio texto. Antes de crear un pedido vuelve a cotizar de todas formas.
function podarHilo(hilo, maxTurnos) {
  if (!Array.isArray(hilo)) return [];
  const n = Math.max(0, Number(maxTurnos) || 0);
  let p = hilo.slice(-n);
  // La API rechaza un historial que empiece por el asistente. Si el corte cayo
  // ahi, se tira uno mas: mejor un turno menos que un 400 en cada mensaje.
  while (p.length && p[0].role !== 'user') p = p.slice(1);
  return p;
}

async function leerHilo(telefono) {
  const r = await supa(
    `wa_conversaciones?select=hilo,bloqueado&telefono=eq.${encodeURIComponent(telefono)}`, 'GET');
  const fila = r.ok && Array.isArray(r.data) ? r.data[0] : null;
  return {
    hilo: podarHilo(fila && fila.hilo, MAX_TURNOS),
    bloqueado: Boolean(fila && fila.bloqueado),
  };
}

async function guardarHilo(telefono, hilo) {
  const r = await supa('wa_conversaciones', 'POST', {
    telefono,
    hilo: podarHilo(hilo, MAX_TURNOS),
    actualizado_en: new Date().toISOString(),
  }, 'resolution=merge-duplicates,return=minimal');
  if (!r.ok) console.error('wa: no se pudo guardar el hilo', r.status);
}

async function registrarSaliente(telefono, texto, herramientas, tokens) {
  const r = await supa('wa_mensajes', 'POST', {
    telefono, direccion: 'sale', texto,
    herramientas: herramientas || null,
    tokens: tokens || null,
  }, 'return=minimal');
  // Que falle el registro no impide contestarle al cliente, pero no se traga en
  // silencio: sin esta fila, lo que dijo el agente no existe en ningun sitio.
  if (!r.ok) console.error('wa: no se pudo registrar la salida', r.status);
}

// Quien puede levantar un pedido se decide por el NIVEL, no por el flag
// aprobado_b2b. Los dos campos pueden contradecirse y de hecho se contradicen:
// el 14 nov 2026, el primer mensaje real llego de un cliente con
// tipo_id = 1 (Consumidor) y aprobado_b2b = true, y el agente le ofrecio
// levantarle un pedido. wa_identidad ya hacia lo correcto -devolvia
// nivel: 'consumidor'-; el error era mio, por mirar el flag en vez del nivel.
const NIVELES_QUE_PIDEN = ['tienda', 'restaurante', 'mayorista'];
function puedePedir(id) {
  return NIVELES_QUE_PIDEN.includes(String(id && id.nivel || '').toLowerCase());
}

// ── El prompt ───────────────────────────────────────────────────────────────
// El nivel de precio entra como DATO YA RESUELTO por el servidor. El modelo no
// lo elige y no tiene ninguna herramienta para cambiarlo (D6 del diseno).
function sistema(id) {
  return [
    'Eres el asistente de WhatsApp de Crunchy Paps: papas y snacks saborizados, en CDMX.',
    'Hablas espanol de Mexico. Breve y directo, sin emoji. Si te preguntan, di que eres un asistente.',
    '',
    id.esCliente
      ? `Escribe ${id.nombre}. Nivel de precio: ${id.nivel}.`
      : 'Escribe alguien que no esta en la base. Tratalo como consumidor.',
    '',
    puedePedir(id)
      ? 'Es una tienda aprobada: puedes cotizar y levantar su pedido. Antes de crearlo, el cliente '
        + 'tiene que CONFIRMAR el total con sus palabras; no lo des por confirmado porque te haya '
        + 'dicho que sabores quiere. El pedido queda PENDIENTE de que Abraham lo confirme, y eso se '
        + 'lo dices siempre al cerrarlo.'
      : 'NO puedes crear pedidos para esta persona. Para comprar, mandale https://crunchypaps.mx',
    '',
    // Esta linea existe porque cotizar_linea solo aplica el precio de caja si la
    // cantidad es MULTIPLO EXACTO de la caja. Sin decirselo, el agente ofrece
    // "12 piezas por $x la caja de 6" y el servidor cobra otra cosa.
    NIVELES_CON_CAJA.includes(id.nivel)
      ? 'Si el catalogo trae caja3, caja6 o caja12, ese precio SOLO aplica a multiplos exactos de esa caja y de un solo sabor: 12 piezas con caja de 6 son 2 cajas, pero 7 piezas se cobran por pieza.'
      : 'Esta persona no compra por caja: cotiza siempre por pieza.',
    '',
    'Tus herramientas son tu unica fuente de datos:',
    '- catalogo: productos y precios. Usala ANTES de decir cualquier precio o de afirmar que un sabor existe.',
    '- fecha_entrega: cuando le toca la entrega a quien escribe.',
    '- mis_pedidos: sus ultimos pedidos, con folio y estatus.',
    '- cotizar: el total de una lista de lineas.',
    puedePedir(id)
      ? '- crear_pedido: lo registra. Solo despues de cotizar Y de que el cliente confirme ese total.'
      : '',
    '',
    // El modelo suma bien casi siempre, y ese "casi" es el problema: 12 x 27 lo
    // hace de memoria sin llamar a nada, y el dia que falle nadie lo revisa.
    'NUNCA calcules un total tu. Ni una multiplicacion, ni una suma, ni un redondeo, ni "mas o',
    'menos". Aunque sea una sola bolsa y la cuenta sea obvia: el total sale de cotizar o no se dice.',
    'Si no has llamado a cotizar, no tienes total.',
    '',
    'NUNCA inventes precios, sabores, existencias ni fechas. Si una herramienta falla, dilo:',
    'es mejor decir "no lo pude comprobar" que dar un dato que puede estar mal.',
    'Si no tienes herramienta para lo que piden, dilo y ofrece pasarlo con Abraham.',
    'No prometas nada que no puedas comprobar.',
  ].join('\n');
}

// ── El modelo ───────────────────────────────────────────────────────────────
// El cliente se construye al usarlo, no al cargar el modulo: sin
// ANTHROPIC_API_KEY el constructor lanza, y eso tumbaria hasta las pruebas que
// solo tocan podarHilo().
let _anthropic = null;
function anthropic() {
  if (!_anthropic) {
    const Anthropic = require('@anthropic-ai/sdk');
    _anthropic = new Anthropic();
  }
  return _anthropic;
}

// ── Las herramientas de lectura ─────────────────────────────────────────────
// Lista blanca cerrada: el modelo solo puede hacer lo que esta aqui. Nada de SQL
// libre, y ninguna escribe (tarea 7 trae la primera que escribe).
//
// El NIVEL de precio no es un parametro de ninguna herramienta: lo cierra el
// closure desde wa_identidad. Si fuera parametro, el modelo podria pedir precio
// de mayorista para un consumidor.
const COLUMNA_PRECIO = {
  consumidor: 'precio_consumidor',
  tienda: 'precio_tienda',
  restaurante: 'precio_restaurante',
  mayorista: 'precio_mayorista',
};

// REGLA DE ORO: el precio, y el si-se-puede-vender, los decide `cotizar_linea` en
// el servidor. Lo de abajo es una COPIA de sus reglas, y se copia por una sola
// razon: el catalogo trae las 35 filas de golpe, y cotizarlas una por una en cada
// mensaje serian 35 llamadas. Lo que impide que la copia se separe del original NO
// es la buena voluntad: es `tools/probar-wa-catalogo.mjs`, que cotiza producto por
// producto contra la base de verdad y falla si el catalogo ofrece algo que el
// servidor no cobra, o si esconde algo que si cobraria. Regla 63: una copia que
// nadie compara no mide, repite.
//
// Las tres reglas copiadas, textuales de cotizar_linea:
//   presentacion = 'Granel' or tipo_venta = 2   -> granel_no_soportado
//   mayorista: coalesce(nullif(precio_mayorista, 0), precio_tienda)
//   precio de caja: solo si nivel in ('tienda','mayorista') Y mod(cantidad, caja) = 0
//
// Y UNA REGLA PROPIA, que el servidor no tiene: un producto a $0 no se ofrece.
// `cotizar_linea` lo cotiza (0 no es null: devuelve ok:true con subtotal 0), pero
// decirle a un cliente "Natural a granel, $0" por WhatsApp es peor que no
// mencionarlo. Hoy son los 6 granel, que ya salen por la primera regla; esta es
// el seguro para el dia que una pieza se quede sin precio de su canal.
const NIVELES_CON_CAJA = ['tienda', 'mayorista'];

function clasificarProducto(p, nivel, col) {
  if (p.presentacion === 'Granel' || Number(p.tipo_venta) === 2) return { fuera: 'granel' };

  let precio = p[col];
  if (nivel === 'mayorista' && !Number(precio)) precio = p.precio_tienda;
  if (precio === null || precio === undefined) return { fuera: 'sin_precio' };
  if (!Number(precio)) return { fuera: 'precio_en_cero' };

  // Las cajas se omiten enteras si el nivel no las puede usar. Mandarlas igual
  // haria que el agente le ofreciera a un restaurante un precio de caja que
  // cotizar_linea nunca le va a cobrar.
  const cajas = NIVELES_CON_CAJA.includes(nivel)
    ? { caja3: p.precio_caja_3 || null, caja6: p.precio_caja_6 || null, caja12: p.precio_caja_12 || null }
    : null;

  return { precio, cajas };
}

// ── Cotizar ─────────────────────────────────────────────────────────────────
// LA REGLA QUE NO SE NEGOCIA (D6 del diseno): el total lo suma el SERVIDOR. El
// modelo dice que lineas quiere, y nada mas. No multiplica, no suma, no redondea,
// y el `nivel` que decide el precio no le pasa ni por delante: entra aqui como
// argumento, resuelto por wa_identidad desde el telefono que Meta ya verifico.
//
// Una sola implementacion, usada por la herramienta `cotizar` y -en la tarea 7-
// por `crear_pedido`. Si fueran dos, el total que ve el cliente y el que se
// escribe en la base podrian separarse, y nadie lo notaria hasta la factura.
//
// El modelo aporta TRES datos por linea: idProducto, cantidad y caja. Ni sabor ni
// presentacion, aunque el plan los pedia: el servidor los devuelve, asi que
// pedirlos solo anade sitios donde el modelo puede equivocarse sin que se note.
// De hecho sale mejor asi: si el modelo pide el id equivocado, lee "Natural" en
// la respuesta y se da cuenta antes de decirselo al cliente.
const MAX_LINEAS = 20;
const MAX_PIEZAS_LINEA = 2000;   // 2000 piezas de 100 g son 200 kg: un lote entero

async function cotizarLineas(lineas, nivel) {
  if (!Array.isArray(lineas) || !lineas.length) return { ok: false, error: 'sin_lineas' };
  if (lineas.length > MAX_LINEAS) return { ok: false, error: 'demasiadas_lineas' };

  for (const l of lineas) {
    const n = Number(l && l.cantidad);
    if (!Number.isFinite(n) || n <= 0 || n !== Math.trunc(n)) {
      return { ok: false, error: 'cantidad_invalida', linea: l };
    }
    if (n > MAX_PIEZAS_LINEA) return { ok: false, error: 'cantidad_enorme', linea: l };
  }

  // Un mismo producto en dos lineas se rechaza en vez de sumarse solo: juntarlas
  // por mi cuenta cambiaria lo que el cliente pidio sin que nadie lo dijera.
  const ids = lineas.map((l) => Number(l.idProducto));
  if (new Set(ids).size !== ids.length) return { ok: false, error: 'producto_repetido' };

  // En PARALELO, no en serie como decia el plan: veinte llamadas encadenadas son
  // unos dos segundos de reloj dentro de un webhook que Meta reintenta si tarda,
  // y un reintento cuesta otro mensaje. Son lecturas puras: el orden no importa,
  // y Promise.all conserva el de la lista.
  const rs = await Promise.all(lineas.map((l) => transporte('rpc/cotizar_linea', 'POST', {
    p_id_producto: Number(l.idProducto),
    p_nivel: nivel,
    p_cantidad: Number(l.cantidad),
    p_caja: Number(l.caja || 0),
  })));

  const detalle = [];
  let total = 0;
  for (let i = 0; i < rs.length; i++) {
    const r = rs[i];
    if (!r.ok || !r.data || r.data.ok !== true) {
      // El status se REGISTRA. Sin esto, un 401 por una llave caducada y un
      // producto que de verdad no se puede vender se ven exactamente igual desde
      // fuera: "no_cotiza". Paso media hora con eso el 14 nov 2026.
      if (!r.ok) console.error('wa: cotizar_linea no contesto', r.status,
        JSON.stringify(r.data).slice(0, 200));
      return {
        ok: false,
        error: (r.data && r.data.error) || (r.ok ? 'no_cotiza' : 'base_' + r.status),
        linea: lineas[i],
      };
    }
    // Solo lo que devolvio el servidor. Nada de `{ ...l, ...r.data }`: lo que
    // dijo el modelo no entra en el detalle que la tarea 7 va a escribir.
    detalle.push(r.data);
    total += Number(r.data.subtotal || 0);
  }

  return { ok: true, total: Math.round(total * 100) / 100, detalle };
}

// ── Crear el pedido ─────────────────────────────────────────────────────────
// LA CREDENCIAL ESTA PENDIENTE DE DECISION, y es la unica pieza que falta aqui.
// `crear_pedido` exige `token` -> resolver_sesion_vendedor -> sesiones_vendedor
// con `expira_en > now()`, y esas sesiones duran DOCE HORAS (medido el 14 nov
// 2026 en produccion: 4 sesiones en total, cero vivas, la ultima caducada en
// octubre). O sea que WA_VENDEDOR_TOKEN como variable fija en Vercel funciona
// media jornada y despues devuelve `sesion_requerida` para siempre. El plan daba
// esa linea por hecha; es la misma trampa del token de Meta de ayer.
//
// Mientras se decide, esto manda la variable igual: cambiar de opcion es cambiar
// esta linea y nada mas, y la prueba no depende de ella -comprueba el PAYLOAD que
// sale, que es donde estan los dos fallos que de verdad importan-.
//
// El pedido nace 'Pendiente' porque lo decide `crear_pedido` para todo canal que
// no sea mostrador: aqui no se elige, se hereda.
function credencialDelAgente() {
  return process.env.WA_VENDEDOR_TOKEN || '';
}

// `cotizar_linea` devuelve `piezasPorCaja`; `crear_pedido` lee `caja`. NO son la
// misma clave, y el plan pasaba el detalle tal cual. Con eso, toda linea por caja
// se habria cobrado por pieza: 72 piezas a 28 son 2,016 en vez de los 1,800 de 6
// cajas. No se habria cobrado de mas -el cuadre de crear_pedido tolera $1 y habria
// saltado `precio_cambiado`- pero NINGUN pedido por caja se habria podido crear
// jamas, que es justo lo que pide un tendero. Se traduce aqui, en un sitio.
function detalleParaPedido(detalle) {
  return detalle.map((d) => ({ ...d, caja: Number(d.piezasPorCaja) || 0 }));
}

async function crearPedidoConfirmado(entrada, id) {
  // El permiso lo decide el NIVEL, no el flag aprobado_b2b. El plan decia
  // `if (!id.aprobadoB2B)`, que es exactamente el bug del 14 nov: hay clientes
  // con tipo_id = 1 y aprobado_b2b = true, y a esos el agente les habria
  // levantado un pedido a precio de consumidor.
  if (!puedePedir(id)) {
    return 'Esta persona no es una tienda aprobada: NO puedes crear pedidos. '
      + 'Mandale https://crunchypaps.mx para que compre ahi.';
  }

  const fecha = String((entrada && entrada.fechaEntrega) || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    return 'La fecha de entrega tiene que ser AAAA-MM-DD. Llama a fecha_entrega y usa esa.';
  }

  // SE VUELVE A COTIZAR AQUI, con el nivel del servidor. Lo que el modelo haya
  // dicho antes en la conversacion no se usa: el hilo guarda texto, y un texto
  // que dice "son $1,800" no es un precio, es un recuerdo.
  const c = await cotizarLineas((entrada && entrada.lineas) || [], id.nivel);
  if (!c.ok) return `NO crees el pedido ni digas que quedo hecho. No pude cotizar (${c.error}).`;

  const r = await transporte('rpc/crear_pedido', 'POST', {
    p_data: {
      token: credencialDelAgente(),   // UNICO sitio donde aparece. Regla 38.
      tipoCliente: id.nivel,          // de wa_identidad. NUNCA del modelo. D6.
      idCliente: id.idCliente,
      nombreCliente: id.nombre,
      telefono: id.telefono,
      canal: 'whatsapp',
      metodoEntrega: 'domicilio',
      fechaEntrega: fecha,
      tipoPagoId: 1,
      tipoPago: 'Efectivo',
      notas: '[wa] ' + String((entrada && entrada.notas) || '').slice(0, 300),
      total: c.total,
      productos: detalleParaPedido(c.detalle),
      // El id del mensaje de Meta: si Meta reintenta el webhook, la clave es la
      // misma y crear_pedido devuelve el pedido que ya existe en vez de otro.
      idempotencyKey: 'wa-' + id.telefono + '-' + id.idMensaje,
    },
  });

  const j = r.data;
  if (!r.ok || !j) {
    console.error('wa: crear_pedido no contesto', r.status, JSON.stringify(j).slice(0, 300));
    return 'NO le digas que el pedido quedo hecho. No pude registrarlo; dile que Abraham le confirma.';
  }

  if (j.ok === false) {
    if (j.error === 'precio_cambiado') {
      // NO se reintenta solo con el total corregido: seria cobrarle algo que no
      // vio. Se le dice y se le vuelve a preguntar. Regla 11.
      return `El precio cambio: ahora son $${j.totalCorrecto}, no $${c.total}. `
        + 'Diselo al cliente con los dos numeros y pregunta si lo confirma asi. NO lo des por hecho.';
    }
    if (j.error === 'sesion_requerida') {
      // El caso de los doce meses... o de las doce horas. Se registra para que en
      // Vercel se vea la causa, y al cliente no se le cuenta el problema interno.
      console.error('wa: credencial del agente invalida o caducada');
      return 'NO le digas que quedo hecho. Dile que se lo pasas a Abraham para confirmarlo.';
    }
    return `NO le digas que quedo hecho. El pedido no se pudo crear (${j.error}).`;
  }

  if (j.duplicado === true) {
    return `Ese pedido ya estaba creado: ${j.consecutivo}. No lo crees otra vez; confirmaselo.`;
  }

  return `Pedido ${j.consecutivo} creado por $${c.total}, para entregar el ${fecha}. `
    + 'Queda PENDIENTE de que Abraham lo confirme, y eso hay que decirselo al cliente.';
}

// ── La lista blanca, por identidad ──────────────────────────────────────────
// Deja de ser una constante: lo que el agente PUEDE hacer depende de quien
// escribe, y se decide en el servidor antes de armar la peticion. Un permiso que
// se le pide al modelo en el prompt no es un permiso (regla 35): lo que no esta
// en esta lista no existe para el, no es que exista y se niegue.
//
// Hoy las cuatro son de lectura y las tiene todo el mundo. La estructura se monta
// ahora porque la tarea 7 (crear_pedido, que escribe) y las herramientas de
// negocio para Abraham y el equipo se cuelgan exactamente de aqui.
function herramientasPara(id) {
  const lista = [
  {
    name: 'catalogo',
    description: 'Productos de Crunchy Paps con el precio que le toca a quien escribe. '
      + 'Usala SIEMPRE antes de decir un precio o afirmar que algo existe. Nunca cites precios de memoria.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        busca: { type: 'string', description: 'Filtra por sabor. Cadena vacia para traer todo.' },
      },
      required: ['busca'],
      additionalProperties: false,
    },
  },
  {
    name: 'fecha_entrega',
    description: 'La fecha de entrega que le corresponde a quien escribe, segun su ruta y la hora limite.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'mis_pedidos',
    description: 'Los ultimos pedidos de quien escribe, con folio, fecha, estatus y total.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'cotizar',
    description: 'Suma una lista de lineas con los precios del servidor y devuelve el total. '
      + 'Usala SIEMPRE antes de decir un total, aunque sea una sola linea y la cuenta te parezca facil. '
      + 'NUNCA multipliques ni sumes tu: el precio y el total los pone el servidor.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        lineas: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_LINEAS,
          items: {
            type: 'object',
            properties: {
              idProducto: { type: 'integer', description: 'El id tal como lo dio la herramienta catalogo. No lo adivines.' },
              cantidad: { type: 'integer', description: 'PIEZAS, no cajas. Seis cajas de 12 son 72 piezas.' },
              caja: { type: 'integer', description: 'Piezas por caja: 3, 6 o 12. Cero si va por pieza.' },
            },
            required: ['idProducto', 'cantidad', 'caja'],
            additionalProperties: false,
          },
        },
      },
      required: ['lineas'],
      additionalProperties: false,
    },
  },
  ];

  // AQUI se cierra el permiso de escribir. Para un consumidor, `crear_pedido` no
  // existe: no le llega en la peticion, asi que no es que el modelo "decida no
  // usarla". Un permiso que vive en una frase del prompt no es un permiso
  // (regla 35), y esta es la primera herramienta que escribe en la base.
  if (puedePedir(id)) {
    lista.push({
      name: 'crear_pedido',
      description: 'Crea el pedido en el sistema. Usala SOLO cuando ya cotizaste y el cliente '
        + 'confirmo ese total con sus palabras. El pedido queda PENDIENTE de que Abraham lo '
        + 'confirme, y eso se le dice al cliente. No la uses para "apartar" ni para probar.',
      strict: true,
      input_schema: {
        type: 'object',
        properties: {
          lineas: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_LINEAS,
            description: 'Las MISMAS lineas que cotizaste y el cliente confirmo.',
            items: {
              type: 'object',
              properties: {
                idProducto: { type: 'integer', description: 'El id tal como lo dio catalogo.' },
                cantidad: { type: 'integer', description: 'PIEZAS, no cajas. Seis cajas de 12 son 72 piezas.' },
                caja: { type: 'integer', description: 'Piezas por caja: 3, 6 o 12. Cero si va por pieza.' },
              },
              required: ['idProducto', 'cantidad', 'caja'],
              additionalProperties: false,
            },
          },
          fechaEntrega: {
            type: 'string',
            description: 'AAAA-MM-DD. La que dio fecha_entrega, o una POSTERIOR que el cliente pidio.',
          },
          notas: { type: 'string', description: 'Lo que el cliente pidio aparte. Cadena vacia si no hay.' },
        },
        required: ['lineas', 'fechaEntrega', 'notas'],
        additionalProperties: false,
      },
    });
  }

  return lista;
}

async function correrHerramienta(nombre, entrada, id) {
  if (nombre === 'catalogo') {
    const col = COLUMNA_PRECIO[id.nivel] || COLUMNA_PRECIO.consumidor;
    // `descontinuado` se filtra ademas de `activo`: cotizar_linea rechaza los
    // descontinuados, asi que ofrecerlos seria prometer algo que no se puede cobrar.
    // El resto del filtrado va en clasificarProducto, con su prueba cruzada.
    //
    // precio_tienda entra SIEMPRE en el select aunque no sea la columna del nivel,
    // porque el mayorista cae a ella cuando su precio es 0. Sin repetirla: para
    // nivel tienda, `col` ya es esa.
    const cols = [...new Set(['id', 'sabor', 'presentacion', 'gramos', 'tipo_venta',
      col, 'precio_tienda', 'precio_caja_3', 'precio_caja_6', 'precio_caja_12'])].join(',');
    let q = `productos?select=${cols}`
      + '&activo=eq.true&descontinuado=not.eq.true&order=orden.asc&limit=60';
    const busca = String((entrada && entrada.busca) || '').trim();
    if (busca) q += `&sabor=ilike.*${encodeURIComponent(busca)}*`;
    const r = await supa(q, 'GET');
    if (!r.ok) return 'No pude leer el catalogo. Dile que lo intentas en un momento y no inventes precios.';
    const filas = [];
    for (const p of (Array.isArray(r.data) ? r.data : [])) {
      const c = clasificarProducto(p, id.nivel, col);
      if (c.fuera) continue;
      filas.push({
        id: p.id, sabor: p.sabor, presentacion: p.presentacion, gramos: p.gramos,
        precio: c.precio, ...(c.cajas || {}),
      });
    }
    if (!filas.length) return 'No hay productos que coincidan con esa busqueda.';
    return JSON.stringify({ nivelDePrecio: id.nivel, productos: filas });
  }

  if (nombre === 'fecha_entrega') {
    const r = await supa('rpc/obtener_fecha_entrega', 'POST', { p_data: { telefono: id.telefono } });
    if (!r.ok || !r.data) return 'No pude calcular la fecha de entrega.';
    // OJO: `fechaDisplay` viene en espanglish ("Tuesday 17 de November"), asi que
    // NO se le pasa al modelo: diria eso tal cual a un cliente. Se manda la fecha
    // en ISO y el `msg`, que si esta bien escrito en espanol.
    return JSON.stringify({ fecha: r.data.fecha, explicacion: r.data.msg });
  }

  if (nombre === 'cotizar') {
    const c = await cotizarLineas((entrada && entrada.lineas) || [], id.nivel);
    if (!c.ok) {
      // El error se traduce a una INSTRUCCION, no a un codigo. "granel_no_soportado"
      // le deja al modelo inventarse que hacer; "quita esa linea" no.
      const comoSalir = {
        sin_lineas: 'No mandaste ninguna linea. Pregunta que quiere y cuanto.',
        demasiadas_lineas: `No puedo cotizar mas de ${MAX_LINEAS} lineas de golpe. Pidele que lo parta en dos pedidos.`,
        producto_repetido: 'Mandaste el mismo producto dos veces. Juntalo en una sola linea con la cantidad sumada y vuelve a cotizar.',
        cantidad_invalida: 'Una cantidad no es un numero entero de piezas. Corrigela y vuelve a cotizar.',
        cantidad_enorme: `Son mas de ${MAX_PIEZAS_LINEA} piezas en una linea. Eso lo tiene que ver Abraham: dile que se lo pasas.`,
        granel_no_soportado: 'Por aqui no se vende granel, solo bolsas. Ofrecele presentaciones de 100, 250, 500 g o 1 kg.',
        producto_no_disponible: 'Ese producto no esta disponible. Vuelve a mirar el catalogo y ofrece otro.',
      };
      const salida = comoSalir[c.error] || `No pude cotizar (${c.error}). Dile que no se lo pudiste calcular y que Abraham le confirma.`;
      return 'NO le des ningun total al cliente. ' + salida;
    }
    return JSON.stringify({ nivelDePrecio: id.nivel, total: c.total, lineas: c.detalle });
  }

  if (nombre === 'crear_pedido') return crearPedidoConfirmado(entrada, id);

  if (nombre === 'mis_pedidos') {
    if (!id.idCliente) return 'Esta persona no tiene pedidos: no esta registrada como cliente.';
    const r = await supa(
      'ordenes?select=consecutivo,fecha_orden,fecha_entrega,estatus_pedido,estatus_pago,total'
      + `&id_cliente=eq.${encodeURIComponent(id.idCliente)}&order=id.desc&limit=5`, 'GET');
    if (!r.ok) return 'No pude leer los pedidos.';
    if (!Array.isArray(r.data) || !r.data.length) return 'Todavia no tiene ningun pedido.';
    return JSON.stringify(r.data);
  }

  return 'Esa herramienta no existe.';
}

// ── El bucle ────────────────────────────────────────────────────────────────
// A mano y no con el toolRunner del SDK, a proposito: el runner devuelve el uso
// de la ULTIMA vuelta, y aqui hace falta sumar entrada y salida de TODAS para
// poder calcular el gasto de verdad. Tambien deja registrar que herramientas se
// usaron, que es lo que se guarda en `wa_mensajes.herramientas`.
const MAX_VUELTAS = 6;

async function responder(id, texto, hilo) {
  const mensajes = [...hilo, { role: 'user', content: texto }];
  const usadas = [];
  let entrada = 0, salida = 0;

  for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
    const r = await anthropic().beta.messages.create({
      model: MODELO,
      max_tokens: MAX_SALIDA,
      system: [{ type: 'text', text: sistema(id), cache_control: { type: 'ephemeral' } }],
      messages: mensajes,
      tools: herramientasPara(id),
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
    });

    entrada += (r.usage && r.usage.input_tokens) || 0;
    salida  += (r.usage && r.usage.output_tokens) || 0;

    // stop_reason se mira ANTES de leer content: en una negativa el contenido no
    // es la respuesta que el cliente espera.
    if (r.stop_reason === 'refusal') {
      return { texto: 'Eso no lo puedo resolver por aqui. Le aviso a Abraham para que te escriba.',
               entrada, salida, usadas, negada: true };
    }

    if (r.stop_reason !== 'tool_use') {
      const dicho = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      return {
        texto: dicho || 'Perdon, no te entendi. Me lo puedes decir de otra forma?',
        entrada, salida, usadas, negada: false,
      };
    }

    mensajes.push({ role: 'assistant', content: r.content });

    // Todos los resultados van en UN solo mensaje de usuario. Partirlos en varios
    // le ensena al modelo a dejar de pedir herramientas en paralelo.
    const resultados = [];
    for (const b of r.content.filter((x) => x.type === 'tool_use')) {
      usadas.push(b.name);
      let out;
      try {
        out = await correrHerramienta(b.name, b.input, id);
      } catch (e) {
        console.error('wa: herramienta fallo', b.name, e && e.message);
        out = 'Esa consulta fallo. No inventes el dato: dile que no lo pudiste comprobar.';
      }
      resultados.push({ type: 'tool_result', tool_use_id: b.id, content: String(out) });
    }
    mensajes.push({ role: 'user', content: resultados });
  }

  // Se acabaron las vueltas sin respuesta. Mejor decirlo que colgar la llamada.
  console.warn('wa: se agotaron las vueltas de herramientas', { usadas });
  return {
    texto: 'Se me complico consultar eso. Dejame avisarle a Abraham y te escribe.',
    entrada, salida, usadas, negada: false,
  };
}

// ── La salida ───────────────────────────────────────────────────────────────
// MEXICO: WhatsApp entrega el `from` de un numero mexicano como 52 + 1 + diez
// digitos (13 en total), pero el numero canonico —el que esta en la agenda, en
// la lista de destinatarios de prueba y en `clientes`— es 52 + diez (12). Si se
// contesta al de 13, Meta responde:
//
//   (#131030) Recipient phone number not in allowed list
//
// y el agente parece mudo: redacta la respuesta y nadie la recibe. Se vio el
// 14 nov 2026 con el primer mensaje real, llegado desde 5215540801794.
//
// Solo se toca el caso de Mexico. Otros paises con la misma mania —Argentina
// mete un 9— se arreglan cuando aparezcan, no antes.
function normalizarDestino(telefono) {
  const d = String(telefono || '').replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('521')) return '52' + d.slice(3);
  return d;
}

async function enviarWA(telefono, texto) {
  const destino = normalizarDestino(telefono);
  const r = await fetch(`https://graph.facebook.com/${WA_GRAPH}/${WA_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: destino,
      type: 'text',
      text: { body: String(texto).slice(0, 4000) },
    }),
  });
  if (!r.ok) {
    // Un catch vacio aqui dejaria al cliente esperando sin rastro de por que.
    const detalle = await r.text().catch(() => '');
    console.error('wa: envio fallo', r.status, detalle.slice(0, 500));
    return false;
  }
  // Meta acusa que ACEPTO el mensaje, no que lo entrego. No se promete mas.
  return true;
}

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    const q = req.query || {};
    if (q['hub.mode'] === 'subscribe' && WA_VERIFY && q['hub.verify_token'] === WA_VERIFY) {
      return res.status(200).send(q['hub.challenge']);
    }
    return res.status(403).send('no');
  }

  if (req.method !== 'POST') return res.status(405).json({ ok: false });

  let crudo;
  try {
    crudo = await leerCrudo(req);
  } catch (e) {
    console.error('wa: no se pudo leer el cuerpo', e && e.message);
    return res.status(403).json({ ok: false });
  }

  if (!firmaValida(crudo, req.headers['x-hub-signature-256'], WA_SECRET)) {
    // Sin detalle en la respuesta, con detalle en el registro.
    console.warn('wa: firma invalida', {
      bytes: crudo ? crudo.length : 0,
      traeFirma: Boolean(req.headers['x-hub-signature-256']),
      haySecreto: Boolean(WA_SECRET),
    });
    return res.status(403).json({ ok: false });
  }

  let cuerpo;
  try {
    cuerpo = JSON.parse(crudo);
  } catch {
    console.warn('wa: cuerpo firmado pero no es JSON');
    return res.status(200).json({ ok: true });   // firmado por Meta: no se discute
  }

  const msg = sacarMensaje(cuerpo);
  // Sin mensaje es un acuse de entrega o de lectura. 200 y a otra cosa: si no se
  // acusa recibo, Meta reintenta, y el reintento cuesta lo mismo que un mensaje.
  if (!msg) return res.status(200).json({ ok: true });

  const tope = await registrarEntrante(msg.telefono, msg.texto);
  if (!tope.permitido) {
    // Se calla. No se le contesta "te pasaste del limite" porque esa respuesta
    // tambien cuesta, y quien esta dando lata seguiria escribiendo.
    console.warn('wa: tope alcanzado', { motivo: tope.motivo, cuenta: tope.cuenta });
    return res.status(200).json({ ok: true, tope: tope.motivo });
  }

  // Identidad: el `from` del webhook ya prueba posesion del numero, asi que el
  // nivel de precio sale de aqui y NUNCA del modelo ni del cliente (D6).
  const ident = (await supa('rpc/wa_identidad', 'POST', { p_telefono: msg.telefono })).data;
  if (!ident || ident.ok !== true) {
    console.error('wa: wa_identidad no contesto', JSON.stringify(ident).slice(0, 200));
    await enviarWA(msg.telefono, 'Ahorita no puedo consultar tus datos. Intenta en un momento.');
    return res.status(200).json({ ok: true });
  }
  const id = { ...ident, telefono: msg.telefono, idMensaje: msg.id };

  const { hilo, bloqueado } = await leerHilo(msg.telefono);
  if (bloqueado) {
    console.warn('wa: conversacion bloqueada', msg.telefono);
    return res.status(200).json({ ok: true, bloqueado: true });
  }

  // De momento solo texto. Un audio o una foto no se ignoran —hay alguien del
  // otro lado— pero tampoco se inventan: se dice lo que hay.
  if (msg.tipo !== 'text' || !msg.texto) {
    const aviso = 'Por aqui solo leo mensajes de texto. Me lo escribes?';
    await enviarWA(msg.telefono, aviso);
    await registrarSaliente(msg.telefono, aviso, null, 0);
    return res.status(200).json({ ok: true });
  }

  let salida;
  try {
    salida = await responder(id, msg.texto, hilo);
  } catch (e) {
    console.error('wa: el modelo fallo', e && e.message);
    await enviarWA(msg.telefono, 'Se me trabo el sistema. Lo intento de nuevo en un momento.');
    return res.status(200).json({ ok: true, error: 'modelo' });
  }

  // El resultado del envio se GUARDA. Antes la fila `sale` se escribia pasara
  // lo que pasara, asi que leerla parecia prueba de que el cliente recibio algo
  // y no lo era: el 14 nov hubo tres respuestas redactadas y cero entregadas,
  // con la fila puesta igual. Regla 14: el "hecho" de una herramienta no es
  // evidencia de que la accion ocurriera.
  const entregado = await enviarWA(msg.telefono, salida.texto);
  // `tokens` guarda la SUMA, por compatibilidad con lo ya escrito; el reparto va
  // aparte, porque entrada y salida cuestan distinto (4 y 20 dolares por millon)
  // y con el total sumado el gasto solo se puede estimar, no calcular.
  await registrarSaliente(msg.telefono, salida.texto, {
    entregado,
    usadas: salida.usadas,
    entrada: salida.entrada,
    salida: salida.salida,
  }, (salida.entrada || 0) + (salida.salida || 0));
  await guardarHilo(msg.telefono, [
    ...hilo,
    { role: 'user', content: msg.texto },
    { role: 'assistant', content: salida.texto },
  ]);

  // Meta reintenta si no recibe un 200 rapido, y un reintento es otro mensaje.
  return res.status(200).json({ ok: true });
};

module.exports.firmaValida = firmaValida;
module.exports.leerCrudo = leerCrudo;
module.exports.sacarMensaje = sacarMensaje;
module.exports.podarHilo = podarHilo;
module.exports.sistema = sistema;
module.exports.MAX_TURNOS = MAX_TURNOS;
module.exports.normalizarDestino = normalizarDestino;
module.exports.puedePedir = puedePedir;
module.exports.herramientasPara = herramientasPara;
module.exports.COLUMNA_PRECIO = COLUMNA_PRECIO;
module.exports.NIVELES_CON_CAJA = NIVELES_CON_CAJA;
module.exports.clasificarProducto = clasificarProducto;
module.exports.cotizarLineas = cotizarLineas;
module.exports.detalleParaPedido = detalleParaPedido;
module.exports.crearPedidoConfirmado = crearPedidoConfirmado;
module.exports.correrHerramienta = correrHerramienta;
module.exports.usarTransporteDePrueba = usarTransporteDePrueba;
module.exports.MAX_LINEAS = MAX_LINEAS;
module.exports.MAX_PIEZAS_LINEA = MAX_PIEZAS_LINEA;
