/* Entrar a las consolas desde cualquier navegador — 27 nov 2026
 *
 * Abraham abrio /promociones en la computadora y leyo «Abre Crunchy Paps,
 * entra con tu telefono y vuelve aqui». Su respuesta: «deberia poder entrar a
 * todo lo de la consola en la computadora, aunque sea con el acceso del login
 * de la app».
 *
 * Y tenia razon dos veces, porque ESTO YA EXISTIA: `retos.html` y
 * `planeador.html` siempre tuvieron su propio telefono + PIN. Las consolas
 * nuevas (promociones, productos, banners, consola, reportar) dejaron de
 * tenerlo y se pusieron a leer la sesion que deja la app, que vive en el
 * localStorage de CADA navegador. En el telefono funciona porque ahi entra; en
 * la computadora no habia entrado nunca.
 *
 * Asi que no se inventa nada: se le da a TODAS el acceso que dos ya tenian, y
 * se escribe UNA vez. Siete copias de un login son siete sitios donde arreglar
 * el mismo fallo, y el que se olvida es el que muerde.
 *
 * DONDE SE GUARDA. En `cp_session`, la misma llave que escribe la app, y no en
 * una llave propia por pagina como hacian retos y planeador. Esa es la
 * diferencia entre entrar una vez y entrar siete: con una sola sesion, un
 * login en esta computadora abre el panel, las consolas y la app.
 *
 * SE FUNDE, NO SE PISA. El objeto de `cp_session` lleva tambien el carrito, los
 * puntos y la identidad de cliente -que dura 60 dias porque rehacerla CUESTA un
 * SMS de Twilio. Aqui solo se tocan los campos del vendedor; lo demas se
 * conserva tal cual. Escribir el objeto entero desde aqui seria tirarle el
 * carrito a alguien por haber entrado a una consola.
 *
 * DOS RELOJES. El privilegio de vendedor dura 12 h (lo decide el servidor y
 * viaja en `tokenExpira`); la identidad de cliente, 60 dias. Cuando cae el
 * primero NO se borra el segundo: `restaurarSesion` en app.js ya hace
 * exactamente eso, y repetirlo mal aqui costaria un SMS.
 *
 * LA PUERTA LA GUARDA EL SERVIDOR. `validar_vendedor_pin` ya trae su propio
 * freno contra la fuerza bruta -5 intentos por ventana de 15 min, bloqueo de
 * 15 min que sube hasta 4 h, por telefono- y es la MISMA funcion que llama la
 * app con la misma llave anon. Dar este login a cinco paginas mas no abre una
 * puerta nueva: usa la que ya estaba, con su cerradura.
 */
(function () {
  'use strict';

  var LLAVE = 'cp_session';

  function cfg() {
    var c = window.__CP_CONFIG__ || {};
    return { url: c.SUPABASE_URL || '', key: c.SUPABASE_ANON_KEY || '' };
  }

  function leer() {
    try { return JSON.parse(localStorage.getItem(LLAVE) || 'null') || null; }
    catch (e) { return null; }
  }

  // El token de vendedor VIVO, o ''. Un token caducado es lo mismo que no
  // tenerlo: el servidor lo va a rechazar igual, y enseñar la consola para que
  // falle en la primera llamada es peor que pedir el PIN.
  function token() {
    var s = leer();
    var v = s && (s.vendedorInfo || s.vendedor);
    if (!v || !v.token) return '';
    if (v.tokenExpira && Date.now() > new Date(v.tokenExpira).getTime()) return '';
    if (s.expira && Date.now() > s.expira) return '';
    return v.token;
  }

  function quien() {
    var s = leer();
    var v = s && (s.vendedorInfo || s.vendedor);
    return v && v.nombre ? String(v.nombre).split(' ')[0] : 'tú';
  }

  // Funde la parte de vendedor en la sesion que ya haya. Todo lo que no se
  // nombra aqui -carrito, puntos, clienteToken- se queda como estaba.
  function guardar(tel, r) {
    var s = leer() || {};
    var v = r.vendedor || {};
    s.esVendedor = true;
    s.tipoCliente = 'vendedor';
    s.telefonoVerif = tel;
    s.vendedorInfo = {
      id: v.id, nombre: v.nombre, telefono: v.telefono, email: v.email, rol: v.rol,
      direccionPuntoVenta: v.direccionPuntoVenta, cpPuntoVenta: v.cpPuntoVenta,
      token: r.token || '', tokenExpira: r.expiraEn || null
    };
    // Solo se pone si no habia: la identidad de cliente dura 60 dias y no es
    // asunto de esta pantalla acortarla ni alargarla.
    if (!s.expira) s.expira = Date.now() + 60 * 24 * 60 * 60 * 1000;
    try { localStorage.setItem(LLAVE, JSON.stringify(s)); } catch (e) {}
  }

  // Suelta SOLO el privilegio de vendedor. La identidad de cliente sobrevive,
  // por la misma razon de siempre: rehacerla cuesta dinero.
  function salir() {
    var s = leer();
    if (!s) return;
    s.esVendedor = false;
    s.vendedorInfo = null;
    if (s.tipoCliente === 'vendedor') s.tipoCliente = 'consumidor';
    try { localStorage.setItem(LLAVE, JSON.stringify(s)); } catch (e) {}
  }

  function nodo(tag, txt, estilo) {
    var e = document.createElement(tag);
    if (txt != null) e.textContent = txt;
    if (estilo) e.setAttribute('style', estilo);
    return e;
  }

  var CAMPO = 'width:100%;max-width:280px;padding:10px 12px;border-radius:10px;' +
    'border:1px solid var(--linea,#d9d4cb);background:var(--papel,#fff);color:inherit;' +
    'font-family:inherit;font-size:1rem;font-weight:600;min-height:44px';
  var BOTON = 'min-height:44px;padding:10px 18px;border-radius:10px;border:0;cursor:pointer;' +
    'background:var(--tinta,#1A1714);color:var(--papel,#fff);font-family:inherit;' +
    'font-weight:700;font-size:.9rem';

  /* Monta la caja de entrada dentro de `donde` y llama a `alEntrar(token)`.
   * Si ya hay sesion viva no pinta nada y llama directo: entrar una vez vale
   * para todas las consolas de este navegador durante 12 h. */
  function montar(donde, alEntrar) {
    var caja = typeof donde === 'string' ? document.getElementById(donde) : donde;
    if (!caja) return;
    var t = token();
    if (t) { caja.hidden = true; caja.style.display = 'none'; alEntrar(t); return; }

    caja.hidden = false;
    caja.style.display = '';
    caja.replaceChildren();

    caja.appendChild(nodo('p', 'Entra con tu teléfono y el PIN de la app.',
      'font-size:.86rem;color:var(--tinta2,#56524C);margin-bottom:10px'));

    var tel = nodo('input', null, CAMPO);
    tel.type = 'tel'; tel.inputMode = 'numeric'; tel.placeholder = 'Teléfono';
    tel.setAttribute('aria-label', 'Teléfono'); tel.autocomplete = 'tel';

    var pin = nodo('input', null, CAMPO);
    pin.type = 'password'; pin.inputMode = 'numeric'; pin.placeholder = 'PIN';
    pin.setAttribute('aria-label', 'PIN'); pin.maxLength = 10;
    pin.autocomplete = 'current-password';

    var btn = nodo('button', 'Entrar', BOTON);
    btn.type = 'button';

    var err = nodo('p', '', 'font-size:.82rem;color:var(--mal-tx,#8C1114);min-height:1.2em;margin-top:8px;font-weight:600');

    var fila = nodo('div', null, 'display:flex;gap:8px;flex-wrap:wrap;align-items:center');
    fila.append(tel, pin, btn);
    caja.append(fila, err);

    async function entrar() {
      var c = cfg();
      var t10 = tel.value.replace(/\D/g, '');
      if (!c.url || !c.key) { err.textContent = 'No cargó la configuración. Recarga la página.'; return; }
      if (t10.length < 10 || pin.value.length < 4) {
        err.textContent = 'Teléfono de 10 dígitos y PIN de al menos 4.';
        return;
      }
      err.textContent = '';
      btn.disabled = true; btn.textContent = 'Entrando…';
      var r = null;
      try {
        var resp = await fetch(c.url + '/rest/v1/rpc/validar_vendedor_pin', {
          method: 'POST',
          headers: { apikey: c.key, authorization: 'Bearer ' + c.key, 'content-type': 'application/json' },
          body: JSON.stringify({ p_data: { telefono: t10, pin: pin.value,
            userAgent: navigator.userAgent, aparatoId: window.cpAparato ? window.cpAparato() : null } })
        });
        r = await resp.json();
        if (Array.isArray(r)) r = r[0];
      } catch (e) { r = null; }
      btn.disabled = false; btn.textContent = 'Entrar';

      if (!r || !r.token) {
        // El mensaje del servidor manda: es el que sabe si quedan intentos o si
        // el telefono esta bloqueado y cuántos minutos faltan.
        err.textContent = (r && r.error) || 'No se pudo entrar. Revisa el teléfono y el PIN.';
        pin.value = ''; pin.focus();
        return;
      }
      guardar(t10, r);
      caja.hidden = true; caja.style.display = 'none';
      alEntrar(r.token);
    }

    btn.addEventListener('click', entrar);
    [tel, pin].forEach(function (i) {
      i.addEventListener('keydown', function (e) { if (e.key === 'Enter') entrar(); });
    });
    setTimeout(function () { tel.focus(); }, 60);
  }

  /* `recordar` es para las dos consolas que ya tenian su propio formulario
   * -retos y planeador-: conservan su pantalla de entrada y solo delegan DONDE
   * se guarda, para que un login valga en todas. */
  window.CPEntrar = {
    token: token, quien: quien, montar: montar, salir: salir, recordar: guardar
  };
})();
