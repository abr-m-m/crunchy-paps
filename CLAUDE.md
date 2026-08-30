# CLAUDE.md — Crunchy Paps

Guía de contexto para Claude Code (y para mí, Abraham) sobre la app de Crunchy Paps.
Última actualización: **13 jun 2026 (Sesión 20)**.

---

## 1. Qué es esto

App web de gestión de negocio para **Crunchy Paps** (papas/snacks saborizados).
Canales: consumidor web, B2B (tiendas), mostrador, eventos. Dueño/admin: **Abraham Miranda**
(id_vendedor=1, rol "Administrador", tel 5540801794).

Dominio producción: **https://crunchypaps.mx**

**Modelo de producción real (clave para entender el inventario):** se produce TODO en base
(Natural) y los sabores se arman **bajo demanda** conforme caen los pedidos. NO se produce una
proporción fija por sabor. Por eso el inventario "real" vive en el **lote** (kg de base), y el
"inventario por sabor" es informativo, no un stock fiable.

## 2. Stack y arquitectura

- **Frontend:** monolito de un solo archivo `index.html` (~14,300 lineas). Tiene 3 bloques `<script>`:
  1. bootstrap en `<head>` (GA4 / UTM / session-id).
  2. script vanilla.
  3. **modulo gigante** (`<script type="module">`) donde viven casi todas las funciones
     (`supabaseCall`, `mostrarToast`, `track`, render de secciones, etc.). **NO son globales**;
     las que se usan desde `onclick=""` se exponen con `window.nombre = ...`.
- **Backend:** Supabase (PostgreSQL). Project ref `xbyzarzyxiugrucyjwfn`.
  - Tablas, RPCs y Edge Functions se administran **en el dashboard de Supabase**, NO en el repo.
  - Edge Functions: `crear-checkout`, `stripe-webhook`.
- **Hosting:** Vercel. **Auto-deploy a produccion en cada `git push`** a `main`.
- **Repo:** `crunchypaps1-boop/crunchy-paps` (publico). Contiene index.html, api/ (incl. sheets.js,
  que tambien maneja OTP), manifest.json, service-worker.js, iconos, vercel.json.
- **PWA:** ya existe service worker, tras un deploy hay que hacer **hard refresh** para ver cambios.
- **Pagos:** Stripe en modo **LIVE** (Checkout hospedado). Claves solo en secrets de Supabase.
- **OTP/SMS:** Twilio via `/api/sheets`.
- **Analytics:** GA4 (`G-JPKV53SK8X`) + tabla propia `eventos_navegacion`.
- **NOTA migración:** Insumos, Consumibles e (históricamente) Inventario Físico todavía usan el
  backend viejo de Google Sheets (`sheetsCall` -> `/api/sheets`). El resto ya está en Supabase.
  Inventario Físico ya migró a Supabase en Sesión 19 (ver abajo). Insumos/Consumibles siguen en Sheets.

## 3. Reglas para Claude Code (IMPORTANTE)

- **NUNCA hacer `git commit` ni `git push` sin mi aprobacion explicita.** Un push despliega
  directo a produccion (clientes reales, pagos reales).
- No hay build ni tests automatizados. **Validacion obligatoria antes de dar por bueno un cambio
  en index.html:**
  1. Balance de `<div>`: contar `<div` vs `</div>`, deben coincidir (hoy **1481/1481**).
  2. Extraer el `<script type="module">` a un `.mjs` y correr `node --check`
     (limpiar imports multilinea y exports antes de validar).
  3. Runtime: `new Function(js)` tras quitar imports/exports.
- Editar con **anclas unicas** (str_replace sobre texto que aparezca una sola vez).
- **Supabase no se toca por CLI**, los cambios de SQL/RPC/tablas se hacen en el dashboard.
  Claude Code puede *escribir* el SQL, pero yo lo pego y ejecuto.
- Por ahora Claude Code se usa en **modo lectura/exploracion** (Windows, instalador nativo).

## 4. Convenciones criticas (no romper)

- **Estatus de pago:** la app MUESTRA `estatus_pago` ('Pendiente'/'Pagado'). `estado_pago` es la
  columna interna de Stripe. El webhook actualiza **ambas**.
- **Estatus de pedido:** valores `'Pendiente' | 'En proceso' | 'En camino' | 'Entregado' | 'Cancelado'`.
  Nacen 'Pendiente' (web/B2B) o ya confirmados (mostrador). "Confirmar" = salir de 'Pendiente'.
- **Pedidos internos:** `tipo_interno <> ''` => se excluyen de ventas, puntos **y del descuento de lote**.
  La condicion estandar para "ventas reales" es `COALESCE(tipo_interno,'') = ''` y `estatus_pedido <> 'Cancelado'`.
- **Cliente 999999** = mostrador interno legado (excluido de puntos). NO es una fila en `clientes`,
  es un centinela que la app escribe en pedidos de mostrador.
- **Consecutivo de pedido:** lo genera el RPC `siguiente_consecutivo()` con
  `nextval('seq_consecutivo_pedido')` + `LPAD(...,5,'0')` => formato **PED-00001** (5 digitos).
- **Sesion:** `cp_session` en localStorage, dura **60 dias**.
- **Carrusel de banners:** reemplaza el contenido de `.banner-cat`; codigo dependiente debe ser null-safe.
- **Navbar:** con mas de 5 items se vuelve scrollable horizontal. Usa `env(safe-area-inset-bottom)`;
  requiere `viewport-fit=cover` en el meta viewport (Sesión 19) para que el inset aplique en iOS.
- **Storage** (bucket `contenido`): sensible a mayusculas/ruta. Nombres en banners.json y valores de
  sabor/presentacion deben coincidir EXACTO con la BD.
- **GA4 User-ID** = solo `cliente.id` opaco.
- **Detalle de pedido (datos):** `tipo_venta` en `ordenes_detalle` toma valores `'Por Pieza'` /
  `'A granel'`; presentaciones `100g/250g/500g/1kg/Granel`. Granel se mide por peso.
- **Ledgers solo-INSERT:** `caja_movimientos` y `lealtad_movimientos` NUNCA se actualizan.

### Convenciones nuevas (Sesión 19)
- **Inventario real = LOTE.** Cada venta confirmada descuenta kg del **lote activo**
  (`lotes_produccion.kilos_vendidos`). `kilos_disponibles` es **columna GENERADA**
  (`kilos_totales - kilos_vendidos`): **NUNCA escribirla**, se recalcula sola.
- **kg de un pedido:** granel = `gramos_vendidos`; pieza = `cantidad * gramos de la presentacion`
  (100/250/500/1000). Las bebidas y otros no-papa suman 0.
- **Inventario por sabor (`vista_inventario`):** informativo, NO es stock fiable (puede salir negativo
  porque la produccion por sabor es 0). No bloquear flujos con sus valores.
- **stock_terminado:** producto YA armado en bolsas (piezas por sabor x presentacion). Es un
  *snapshot por lote*: al guardar se hace DELETE de ese lote + INSERT del conteo nuevo.
- **Metodos de pago (checkout):** Efectivo, Transferencia, Pago en línea (Stripe, id 5).
  **"Tarjeta terminal" (id 2)** solo se muestra a vendedor/mostrador (POS), nunca al consumidor web.
  La lógica de Stripe se basa en el **id 5**, no en el nombre. En **paquetería** solo se permite
  el cobro en línea (`aplicarRestriccionPagoEntrega`).
- **Fecha de entrega:** el editor se muestra a todos; el `min` del input = la fecha sugerida
  (solo se permite esa o **posterior**). `fechaEntregaFinal` usa el valor del input para cualquier usuario.

## 5. Estado actual, que ya esta hecho

- Migracion de catalogo, pedidos, clientes, prospectos, caja, produccion, lealtad, cupones, permisos.
- **Pagos Stripe LIVE** verificados con un cargo real.
- Carrusel de banners + logo; sesion OTP 60 dias; analytics ampliado; permisos por rol/vendedor.

### Sesion 17 (8 jun 2026)
- Base arrancada de cero (respaldos + `vaciado_transaccional.sql`). Prospectos (1,131) conservados.
- Cuotas jun-dic 2026 cargadas. Dashboard v2 (`dashboard_resumen.sql`).

### Sesion 18 (8 jun 2026)
- Motor de puntos reescrito; reglas del Club en `config_produccion` clave `'lealtad'`.
- `crear_pedido` v2 (sin paso 7); trigger `trg_otorgar_puntos` otorga al quedar Pagado+Entregado.
- Panel admin de reglas del Club; fix de navegacion `navegar('premia')`.

### Sesion 19 (10 jun 2026) — Producción, inventario por lote, pagos y PWA
**Contexto:** primer día de operación real (F&F). Se registró el primer lote (`LOTE-20260608-01`,
16.63 kg) y los primeros pedidos.

1. **Fix "Cargando…" infinito en Producción.** `renderProduccion()` tenía un `return` temprano
   cuando `vista_inventario` venía vacía, que dejaba colgadas Historial de lotes, Próxima producción
   y Resumen del día. Se convirtió en `if/else` para que el resto siempre renderice.
2. **Verificación de esquema:** `vista_inventario` (7 cols) y `produccion_diaria`
   (incl. `fecha_siguiente`, `activo`) coinciden con el código. Sin segundo bug.
3. **Reorden de pestañas de Producción** a: **Lotes · Inv. Físico · Inventario · Insumos · Consumibles**.
   El "Inventario disponible por sabor" salió de la pestaña Lotes a su propia pestaña (`prod-tab-invdisp`,
   tab id `invdisp`).
4. **Inventario Físico → Supabase (Opción A).** `guardarInventarioFisico()` ahora escribe en la nueva
   tabla **`stock_terminado`** (antes llamaba al Sheets viejo). Al elegir un lote carga el conteo previo.
5. **Descuento del lote por venta confirmada (reconciliación bidireccional, Opción A).**
   SQL en `produccion_descuento_lote.sql` (v3). Confirmar→descuenta; cancelar/regresar a Pendiente→
   devuelve; re-confirmar→re-descuenta. Idempotente, por línea. Cubre **web/B2B** (trigger en `ordenes`
   al cambiar estatus) y **mostrador** (trigger en `ordenes_detalle` al insertar líneas).
6. **Informe (sección Resumen):** se agregaron tarjetas **Lote activo** y **Inventario restante**
   (prom. kg/día, días que alcanza, fecha sugerida de producción), client-side (`cargarResumenProduccion`).
7. **Se removió "Resumen del día"** de la pestaña Lotes → reemplazado por **Estadísticas de lotes**
   (lotes, producido/vendido histórico, promedio por lote, % agotamiento de lotes cerrados).
8. **Fecha de entrega editable por el consumidor** (antes solo vendedor); min = fecha sugerida.
9. **Pagos:** se quitó "Tarjeta" suelta (se confundía con Stripe) y se reintrodujo como
   **"Tarjeta terminal"** solo en POS. Paquetería fuerza cobro en línea.
10. **iOS:** `viewport-fit=cover` en el meta viewport — el navbar deja de invadir la zona del gesto
    de inicio (Siri/Home indicator).
11. **Android:** banner proactivo de instalación (paridad con iOS), abre el modal de instrucciones.

### Sesión 20 (13 jun 2026) — OTP por email, informe (presentaciones/PDF/inventario), recordatorios de pago SMS
**Contexto:** operación real en curso. Dos problemas del lanzamiento F&F: (a) el OTP de confirmación
no llegaba a clientes nuevos; (b) confusión con el registro de Inventario Físico.

1. **Inventario Físico — no era bug.** Los datos SÍ se guardaban en `stock_terminado`; se estaba
   revisando la tabla vieja `inventario_fisico` (ya no se usa) y además el dispositivo corría una
   versión cacheada de la PWA. Se blindó `guardarInventarioFisico()`: relee de la BD y solo confirma
   "Guardado: N líneas" si realmente quedó; si falla, muestra el error real de PostgREST. Se agregó un
   **sello de versión visible** (`build 13-jun-2026 · s19`) en la tarjeta de Inv. Físico para verificar
   despliegues a simple vista.
2. **Pestaña "Inventario" → resumen de solo lectura** (`renderResumenInventario(elId, incluirLote)`).
   Reemplazó el "inventario por sabor fantasma" (que mostraba negativos sin sentido). Ahora muestra
   **Lote activo** (kg producido/vendido/disponible) + **último conteo de `stock_terminado`** por
   sabor×presentación con **semáforo de frescura** (🟢 hoy/ayer · 🟡 2-5 días · 🔴 más viejo / sin
   conteo de este lote). `renderProduccion()` se hizo null-safe ante la ausencia de `#prod-tabla`.
3. **Decisión de gestión de inventario (importante):** el inventario real/automático es el **lote en kg**
   (cada venta confirmada lo descuenta solo, sin requerir disciplina del operador). `stock_terminado` es
   una **foto manual periódica** que **NO** se auto-decrementa por venta (eso crearía falsos negativos en
   el modelo bajo demanda); su antigüedad se muestra siempre con el semáforo. Conteo físico = tarea
   ocasional (al cerrar lote), no diaria.
4. **Informe diario enriquecido.** Se agregó el resumen de inventario al informe (`#resumen-stock`).
   El texto de **"📋 Compartir"** (`copiarResumenDia`) ahora incluye **Top presentaciones**
   (`top_presentaciones`) además de sabores, y un bloque de **inventario** (lote disponible kg + embolsado
   + frescura), cacheado en `window._invResumenTxt` para que el copiado al portapapeles no falle por el
   `await`. Botón nuevo **📄 PDF** (`descargarInformePDF`) que abre una vista imprimible y deja
   "Guardar como PDF". (El botón verde "Enviar resumen por WhatsApp" usa el backend y el sandbox; NO se tocó.)
5. **OTP por EMAIL (canal alterno confiable).** Diagnóstico: el OTP por SMS de `sheets.js` guarda el
   código **en memoria** (`Map`), frágil en serverless (la verificación puede caer en otra instancia y
   "perder" el código). Además, el resumen/algunos envíos salían por el **Sandbox de WhatsApp** de Twilio
   (error **63015** = el sandbox solo entrega a números que se "unieron"; **63016** = fuera de ventana 24h).
   Solución: endpoint nuevo **`/api/otp-email`** que **genera y verifica** el código en Supabase (tabla
   **`otp_codigos`**, hash sha256, TTL 10 min, máx 5 intentos, anti-spam 30s) y lo envía con **Resend**
   desde `no-reply@crunchypaps.mx` (dominio verificado en Resend con DNS de Cloudflare: DKIM `resend._domainkey`,
   SPF MX/TXT `send`, DMARC `_dmarc`). La identidad sigue siendo el **teléfono**; la respuesta `{ok, verificado}`
   es idéntica a la de Twilio, así el post-verify del frontend no cambia. Frontend: selector "Recíbelo por
   correo" en el login, `window._otpCanal` enruta enviar/verificar/reenviar. **Probado y funcionando.**
6. **Recordatorios de PAGO por SMS (automático + manual).** Endpoint **`/api/recordatorios-pago`**:
   detecta pedidos **pendientes de pago** (`estatus_pago != 'Pagado'`, no `Cancelado`, no interno) creados
   hace **+24h**, no recordados en **48h**, **máx 3** por pedido; resuelve el teléfono desde **`clientes`**
   por `id_cliente` (¡`ordenes` NO guarda teléfono!); envía SMS vía Twilio (`TWILIO_PHONE`) y registra en
   `ordenes` (`ultimo_recordatorio_pago`, `recordatorios_pago_enviados`). Params: `dry=1` (simula),
   `force=1` (manual, ignora ventanas), `solo=PED-XXXX|id` (uno). Auth con **`CRON_SECRET`** (Bearer del
   cron o `?secret=`). Cron en **`vercel.json`**: `0 17 * * *` = **11:00 CDMX** (ventana flexible de 1h en
   Hobby). UI admin en el Informe (**"💸 Recordatorios de pago"**): lista pendientes y permite enviar uno o
   todos; el secreto se guarda una vez en `localStorage` (`cp_cron_secret`), no en el bundle. **SMS a México
   confirmado funcionando** con `TWILIO_PHONE`.
7. **Resumen automático de WhatsApp:** pendiente de apagar su **trigger por tiempo en Google Apps Script**
   (`dispararResumenDiario` / `enviarResumenDiario`); depende del sandbox y falla. El resumen se comparte
   manual por "📋 Compartir" / PDF.

**Aprendizajes / convenciones nuevas (Sesión 20):**
- `ordenes`: la fecha de creación es **`fecha_orden`** (NO `fecha_creacion`); el folio es **`consecutivo`**
  (`PED-#####`); **no tiene columna de teléfono** → el teléfono vive en `clientes.telefono` vía `id_cliente`.
- **Vercel:** las env vars aplican solo a **deploys nuevos**; un "Redeploy" de un deployment **viejo** NO
  trae el código reciente. Verificar siempre que producción apunte al commit correcto.
- **Auth de query en serverless:** leer con `req.query` (o parsear `req.url` con `URL`), **no**
  `req.url.includes(...)`, y recortar espacios del secreto en ambos lados.
- **Service worker:** ya es network-first y **no cachea HTML**; si un cambio "no aparece", es despliegue
  o caché HTTP del dispositivo, no el SW (reinstalar la PWA no arregla un deploy que no ocurrió).
- **Arquitectura backend confirmada:** `sheets.js` (Vercel) hace de proxy/Twilio y reenvía las demás
  acciones a un **Google Apps Script** (capa de Google Sheets). El `resumen_diario` y otras lógicas viven
  en el Apps Script; los triggers por tiempo se administran ahí, no en Vercel.

### Archivos nuevos (Sesión 20)
- **`/api/otp-email.js`** + **`otp_codigos.sql`** — OTP por email (Resend + Supabase, RLS bloqueada, service-role).
- **`/api/recordatorios-pago.js`** + **`recordatorios_pago_schema.sql`** — recordatorios de pago SMS;
  el SQL agrega `ultimo_recordatorio_pago`, `recordatorios_pago_enviados` e índice a `ordenes`.
- **`vercel.json`** — ahora incluye `"crons"` (`/api/recordatorios-pago`, `0 17 * * *`).

### Pendientes que dejó la Sesión 20
- [ ] Apagar el trigger por tiempo del resumen automático de WhatsApp en Apps Script.
- [ ] **WhatsApp Producción (Meta):** registrar sender en Twilio + Business Verification + plantillas
      **Utility** (recordatorio de pago, confirmación). Al aprobarse, cambiar `enviarSMS` por envío con
      `ContentSid`; la lógica de detonado, el registro y la UI manual quedan igual.
- [ ] (Opcional) Migrar también el OTP por teléfono de SMS-en-memoria a algo persistente, o unificar con
      el flujo de email.

### Archivos SQL (estado)
1–7. (Sesiones 17–18, ya descritos arriba).
8. **`produccion_descuento_lote.sql` (v3)** — Sesión 19. Parte 1 (`stock_terminado` + RLS),
   Parte 2 (reconciliador + triggers), Parte 3 (backfill opcional, una sola vez). Re-ejecutable.

---

### Sesión 21 (14 jun 2026) — Copy SMS editable, kárdex de lote, opt-in marketing, gating B2B con doble coordenada

**Contexto:** confirmado que el motor de inventario v3 repone al cancelar (probado por Abraham:
confirmar pedido descuenta, cancelar repone). Sesión enfocada en 5 frentes priorizados por dificultad.

**Hecho:**
- **#5 Cancelados (cerrado):** el trigger v3 YA repone al cancelar; el mensaje del frontend decía
  lo contrario ("NO repone") → corregido. Regla mental: confirmado→cancelado devuelve kg; Pendiente
  nunca confirmado→cancelado no devuelve nada (nunca descontó). Fase 2 opcional (elegir no-reponer) NO hecha.
- **Copy editable del SMS** de recordatorios: botón "✏️ Mensaje" en el Informe; plantilla en tabla
  `app_config` (clave `recordatorio_pago_sms`), placeholders `{nombre} {folio} {total} {link}`.
  Endpoint `/api/recordatorios-pago` extendido con acciones `get_copy`/`guardar_copy` (POST, secret-auth,
  upsert vía service role). **Desplegado por Abraham.**
- **Kárdex de lote (Nivel A):** tarjeta "📒 Kárdex de lote" en el Informe (admin). Selector de lote +
  tabla estilo libro contable: apertura (producido) y un renglón por pedido (fecha, folio, cliente,
  sabor/presentación, kg −, saldo corrido) ordenado por fecha. Cuadre ✓ contra disponible. Lee de
  `lotes_produccion` + `ordenes_detalle` (`id_lote_descontado`, `kg_descontado_lote`) + `ordenes`.
  **Limitación:** muestra consumo vigente; cancelados no aparecen (guardas se ceran al reponer).
  **Nivel B pendiente** (tabla `movimientos_lote` inmutable con histórico de cancelaciones).
- **#1 Opt-in marketing:** casilla explícita en checkout ("Quiero recibir promociones… 🌶️"). Persistencia
  vía RPC `set_opt_in_promos` (security definer, solo opt-in afirmativo). Columnas en `clientes`:
  `acepta_promos`, `acepta_promos_fecha`, `acepta_promos_origen`. La casilla **se oculta** si el cliente
  ya aceptó (RPC `get_opt_in_promos`). Opt-out (BAJA) pendiente para después.
- **#2 B2B — gating Opción 3 + captura obligatoria (probado parcialmente):** una tienda/restaurante
  NO ve catálogo hasta ser **aprobada** (evita que un consumidor espíe precios de mayoreo).
  - Nueva pantalla `s-datos-tienda`: nombre negocio + dirección + ubicación. Reescrita `s-pendiente`
    a "Validando tu tienda — pronto precios de mayoreo" (se quitó "comprar como consumidor").
  - `elegirTipoNuevo` (tienda) → manda al formulario. Login de cliente B2B → `enrutarTrasLoginB2B`:
    aprobada→catálogo; sin datos→formulario; completa-no-aprobada→s-pendiente.
  - RPC `get_estado_tienda` (security definer): `{aprobado, completo, tipo_id}`. Completo = nombre +
    dirección + coordenadas.
  - **Doble coordenada:** `coordenadas` = ENTREGA (pin arrastrable que ajusta el tendero sobre el mapa,
    geocodificado de la dirección); `coordenadas_gps` = GPS capturado **en silencio** al abrir el form
    (validación). Persisten por separado (RPC `set_coordenadas_gps`). En el panel B2B: botones
    "Ver en Maps (entrega)" + "📡 GPS" + **badge de distancia** GPS↔entrega (✓ verde ≤150m, ⚠ ámbar
    ≤500m, rojo >500m) vía helper `distanciaCoords` (haversine). Tarjeta B2B además: nombre vacío
    manejado, botón "💬 Contactar" (wa.me), aviso "Sin ubicación capturada".
  - **Probado por Abraham (con "Abarrotes prueba"):** formulario → validando → aprobar → catálogo B2B ✓.
    Falta probar el rediseño de doble-coordenada/mapa (mañana).
  - **Las 2 tiendas reales sin datos (IDs 14, 29):** al volver a entrar caen directo al formulario.

**Archivos nuevos/cambiados (Sesión 21):**
- `index.html` — todos los cambios anteriores. Validado 1552/1552 divs + `node --check` OK.
- `/api/recordatorios-pago.js` — + acciones de copy editable.
- `app_config.sql` — tabla key-value de textos (copy SMS). **Ejecutado.**
- `opt_in_promos.sql` — columnas opt-in + RPCs `set_opt_in_promos` / `get_opt_in_promos`.
- `b2b_datos_tienda.sql` — RPC `get_estado_tienda`, columna `coordenadas_gps`, RPC `set_coordenadas_gps`.

**Pendientes que dejó la Sesión 21:**
- [ ] **Probar mañana** el flujo B2B con doble coordenada (mapa arrastrable + distancia GPS en panel).
- [ ] Desplegar (si no se ha hecho): `opt_in_promos.sql`, `b2b_datos_tienda.sql`, e `index.html`.
- [ ] **#3 Analytics/UTMs/eventos** (siguiente tema): leer GA4 (propiedad a396811991p540248681),
      confirmar si los UTMs jalaron, dónde ver eventos taggeados; evaluar visual ad-hoc.
- [ ] **#4 Campañas de Instagram** (estratégico): capitalizar acceso admin en Meta para dar visibilidad.
- [ ] Datos B2B adicionales post-aprobación (opcional): dueño, tel. alterno, RFC, CURP.
- [ ] Opt-out (BAJA) de marketing.
- [ ] Kárdex Nivel B (movimientos_lote inmutable).
- [ ] **Candado real de precios B2B en backend** (hoy el gating es de frontend; precios B2B deberían
      servirse solo a clientes aprobados vía RLS/RPC para blindar de usuarios técnicos).
- [ ] (de antes) Apagar trigger por tiempo del resumen WhatsApp en Apps Script; WhatsApp Producción/Meta.

---

### Sesión 22 (26 jun 2026) — Opt-in en "Mi cuenta", 5 mejoras UX de pedidos, motor de internos, prospectos y métrica de regalos

**Contexto:** sesión larga operando en producción. Surgieron mejoras de UX y, sobre todo, una
corrección de fondo del motor de inventario (los internos SÍ consumen lote) y nuevas analíticas.

**Hecho (todo validado: div balance 1594/1594 + `node --check` OK al cierre):**

- **Opt-in editable desde "Mi cuenta"** (además del checkout): tarjeta "🌶️ Promociones" con switch.
  Carga el estado actual (`get_opt_in_promos`), activa/desactiva (`set_opt_in_promos`). Funciones
  `cargarPromosPerfil` / `togglePromosPerfil` / `pintarSwitchPromos` (en `renderCuenta`). Oculto para
  vendedores. **`set_opt_in_promos` actualizado para REVOCAR al desmarcar** → resuelve el opt-out (BAJA).

- **#3 Vendedor ≠ teléfono del cliente:** aviso inmediato (rojo) al teclear su propio número en
  `f-tel-cliente` (`validarTelClienteVsVendedor`) + candado al confirmar en `confirmarPedido`.

- **#2 "📋 Reenviar resumen":** botón en la tarjeta de pedido del vendedor (`enviarResumenPedidoWpp`):
  trae `ordenes_detalle`, arma resumen itemizado con total, estado de pago y link de seguimiento, abre wa.me.

- **#4 Entrega A (carrito):**
  - **Aviso fuera de CDMX** (caso Tlaxcala): si CP fuera de 01000–16999 y paquetería, advertencia ámbar
    "el costo de envío puede variar / puede requerir pago adicional / el total se ajusta y se cobra antes
    de enviar". Helpers `esFueraCDMX` / `avisoEnvioCDMX` / `repintarInfoEntrega`; `f-cp` re-pinta al cambiar.
  - **Secciones numeradas** (sin reordenar el DOM, bajo riesgo): ① Cliente · ② Entrega · ③ Dirección ·
    ④ Pago · ⑤ Fecha. Encabezados DENTRO de cada sección (se ocultan con ella). **Renumeración dinámica**
    (`renumerarSecciones`, ids `secnum-*`): un pedido interno muestra 1·2·3·4 sin huecos (omite Entrega).
  - **#4 Entrega B (reorder físico del carrito): DIFERIDO** (riesgo en checkout vivo, requiere prueba en vivo).

- **#5 (cerrado, sin dev):** regla de recordatorios = `estatus_pago ≠ Pagado` + no cancelado + no interno
  + ≥24h desde creado + <3 recordatorios + ≥48h entre ellos; corre 11:00 CDMX. (NO es por "En proceso".)

- **BUG corregido — contacto Crunchy bloqueaba pedidos internos:** la validación exigía contacto en
  `coordinar`+consumidor sin excluir internos/vendedor. Fix en `actualizarChecklistFaltantes`:
  `_esInterno = (modoVenta === 'interno') || _pedidoInterno.tipo` y `&& !esVendedor`. (Primer intento
  falló por depender de que el motivo ya estuviera elegido; `modoVenta` es la señal confiable.)

- **Puntos en internos (frontend):** la pantalla de ¡Gracias! ya NO muestra "+N puntos" en internos
  (`ptosGanados = esPedidoInterno ? 0 : ...`). Confirmado que el trigger de BD ya excluía internos (no había
  movimiento en `lealtad_movimientos`).

- **CORRECCIÓN DE FONDO — los pedidos internos SÍ consumen lote.** Regla de negocio corregida por Abraham:
  sampling/regalo/etc. no generan ingreso ni puntos, pero SÍ consumen kg físicos. El motor v3 los excluía
  (`v_debe ... and tipo_interno=''`). **Patch `lote_incluir_internos.sql`**: `fn_reconciliar_pedido` ahora
  descuenta/repone también los internos (se quitó la exclusión). Kárdex ya los incluía (lee por
  `id_lote_descontado`/`kg_descontado_lote`); se les añadió etiqueta (🎁 Sampling · cliente). PED-00045 se
  reconcilió y aparece en el kárdex.
  - **NOTA — descuadre vivo pendiente:** `LOTE-20260608-01` con `kilos_disponibles = −7.80` (sobrevendido).
    Causa: el motor asigna SIEMPRE al lote activo más nuevo (`order by fecha desc limit 1`); con dos lotes
    activos conviviendo, descuadra. **La cura es el #1 (asignación manual de lote por pedido).**

- **Sampling/Regalo/Bonificación → PROSPECTO enlazado** (a persona NUEVA, con teléfono):
  `prospecto_sampling.sql` (columnas `origen`/`id_orden_origen`/`consecutivo_origen` + RPC
  `registrar_prospecto_desde_interno` con dedup por teléfono). En `confirmarPedido`, tras crear el pedido,
  crea el prospecto si `esPedidoInterno && !clienteActual?.id` y tipo ∈ {sampling,regalo,bonificacion}.
  Probado: Monica Guerrero (PED-00046) → prospecto id 1132 enlazado. Cliente existente NO crea prospecto
  (usa su id real, no 999999); tampoco suma a compras/puntos.

- **Nuevo tipo interno "➕ Bonificación"** (junto a Sampling/Regalo). Solo frontend (dos listas TIPOS +
  label kárdex + tipos que crean prospecto).

- **Métrica "🎁 Regalos vs Ventas" (Informe, admin):** `metricas_regalo.sql` (RPC `metricas_regalo_mes`).
  "Regalo" = sampling+regalo+bonificacion. Dos razones del mes en curso: **% volumen** (regalo_kg/ventas_kg)
  y **% dinero** (regalo_mxn = Σ subtotales de línea / ventas_mxn = Σ total). Desglose por cliente (top 20).
  Tarjeta `regalos-card` con selector de mes; `cargarMetricaRegalo`. Umbrales de color (verde<5 / ámbar≤10 /
  rojo) ajustables. **Hallazgo:** el `subtotal` de línea conserva el precio de catálogo aun en internos
  (solo el total del pedido es $0), por eso la métrica de dinero es exacta.

- **Regalos en historial individual del cliente:** sección "🎁 Regalos recibidos" en `renderPedidos`
  (`pintarRegalosCliente`, fetch aparte por `id_cliente` + embed de `ordenes_detalle` para kg). Solo cliente
  real (no 999999). Muestra tipo + kg + fecha/folio, "Cortesía · no es compra".

**Archivos nuevos/cambiados (Sesión 22):**
- `index.html` — todos los cambios anteriores. 1594/1594 divs, `node --check` OK.
- `lote_incluir_internos.sql` — internos consumen lote (`fn_reconciliar_pedido` sin exclusión). **Re-ejecutable.**
- `prospecto_sampling.sql` — columnas de enlace + RPC `registrar_prospecto_desde_interno`. **Re-ejecutable.**
- `metricas_regalo.sql` — RPC `metricas_regalo_mes`. **Re-ejecutable.**
- `opt_in_promos.sql` — actualizado: `set_opt_in_promos` ahora revoca al desmarcar. **Re-correr.**

**Orden de despliegue (todo re-ejecutable):**
`lote_incluir_internos.sql` → `prospecto_sampling.sql` → `metricas_regalo.sql` → (`opt_in_promos.sql`,
`b2b_datos_tienda.sql` si faltaban) → subir `index.html`.

**Pendientes de validación (Abraham, en cola):**
- [ ] Flujo B2B con doble coordenada (mapa arrastrable + distancia GPS en panel).
- [ ] Opt-in con consumidor real (casilla en checkout) + switch de promos en "Mi cuenta".
- [ ] Métrica de regalos, prospecto desde sampling, y regalos en historial (correr SQL + subir HTML primero).

**Pendientes que dejó la Sesión 22:**
- [ ] **#1 — Asignación manual de lote por pedido** (toca el motor; es la cura del `−7.80`). EL GRANDE.
- [ ] **#4 Entrega B** — reorder físico del carrito (con prueba en vivo).
- [ ] Diagnóstico del `−7.80` (qué pedidos cargaron al `LOTE-20260608-01`).
- [ ] Instagram: Jocelyn debe cambiar el correo de recuperación del IG (sigue siendo el suyo) al del negocio
      + 2FA; luego Abraham hace el handshake en business.facebook.com (en incógnito) → Control total.
- [ ] (de antes) Kárdex Nivel B (movimientos_lote inmutable), candado real precios B2B en backend, analytics/UTMs.

---

---

### Sesión 23 (28 jun 2026) — Alta B2B sin fricción, alta liderada por vendedor, mayorista completo (segmento + precios + mínimos editables)

Sesión enfocada en destrabar el alta de clientes B2B (abarrotes) y habilitar el canal mayorista de punta a punta.

**Quick fix — el alta B2B autoservicio ya no se bloquea por ubicación.**
- Caso real diagnosticado: "Abarrotes Don sebas" (`5517308186`) llenó nombre + dirección pero el geocodificador no resolvió "Galicia" (calle sin número) → mensaje *"No encontramos esa dirección"* → bloqueo. En `clientes` quedó un stub basura (id 45, Consumidor, vacío).
- Fix en `guardarDatosTienda`: orden de respaldo pin del mapa → geocodificación → **GPS silencioso** → y si nada, **guarda igual** con aviso suave. La ubicación exacta se confirma al validar. Notificación WhatsApp maneja el caso sin coords. `coordStr` protegido contra null.
- Principio: un lead difuso al que puedes llamar > un lead perdido. El panel admin ya avisa "⚠️ Sin ubicación capturada".

**Alta B2B liderada por el VENDEDOR (en sitio, sin venta).**
- Nueva pantalla `s-alta-negocio` + botón "🏪 Dar de alta negocio (B2B)" en Mi cuenta (solo vendedores).
- Captura: tipo (Tienda / Restaurante / **Mayorista**), teléfono del cliente (candado: ≠ teléfono del vendedor), nombre, dirección, y **GPS del vendedor** ("📡 Usar mi ubicación actual") como ubicación de entrega.
- Guarda vía `registrar_o_actualizar_cliente` con `aprobadoB2B=false` (**pendiente de aprobación admin**, por decisión de Abraham). Notifica al equipo por WhatsApp.
- Mayorista (`tipo_id=4`) agregado a la detección B2B del panel admin (antes solo 2 y 3 → un mayorista nunca se habría podido aprobar).
- Funciones: `abrirAltaNegocio`, `setTipoAltaNegocio`, `usarGpsAltaNegocio`, `guardarAltaNegocio`.

**Ajustar ubicación después del alta (vendedor en sitio).**
- Nueva pantalla `s-ajustar-ubicacion` + botón "📍 Ajustar ubicación de un cliente" en Mi cuenta (vendedores).
- Flujo: busca por teléfono → **confirma nombre del cliente** → captura GPS estando ahí → guarda.
- RPC `set_ubicacion_cliente` actualiza **SOLO coordenadas** (y `coordenadas_gps`) → cero riesgo de borrar otros campos. RPC `buscar_cliente_telefono` para la confirmación.
- Funciones: `abrirAjustarUbicacion`, `buscarClienteUbicacion`, `usarGpsAjuste`, `guardarAjusteUbicacion`. SQL: `ubicacion_cliente.sql`.

**Anti-desviación de datos (1b).**
- Candado de teléfono (vendedor ≠ cliente) ya existente previene "consumidor con teléfono del vendedor" en altas nuevas.
- Aviso suave nuevo `chequearDirVsPuntoVenta`: en el alta por vendedor, si la dirección/CP del cliente coincide con el punto de venta del vendedor (`vendedorInfo.direccionPuntoVenta`/`cpPuntoVenta`), muestra aviso ámbar "pon la dirección del cliente, no la tuya". No bloquea. Es heurístico (compara texto), no infalible.

**Canal MAYORISTA / DISTRIBUIDOR (`tipo_id=4`) — completo.**
- Precio diferenciado: columna `precio_mayorista` en `productos` (`precio_mayorista.sql`). `getPrecio` elige mayorista con **puente a precio de tienda** mientras esté en 0/NULL.
- Mapeo de tipo: mayorista → `tipoCliente='mayorista'` (canal propio) + gating B2B (catálogo solo si aprobado).
- Selector de canal del vendedor: botón "📦 Mayorista" (`setCanalVenta` incluye mayorista) + chip de referencia de precio.
- `seleccionarCliente`: validación canal↔tipo refactorizada con `canalCorrecto` (maneja mayorista limpio).
- Normalización de producto (Supabase + bebidas) lee `precio_mayorista`.
- **Precios:** `precios_por_presentacion.sql` (plantilla para fijar las 5 columnas de precio por presentación) + en `precio_mayorista.sql` un UPDATE temporal `precio_tienda * 0.90`.

**Mínimos de mayoreo — EDITABLES desde admin (sin tocar código).**
- Regla: mínimo de compra **por presentación, sumando sabores** (ej. 10 en total de 100g, mezclados). Elegido por Abraham.
- Validación `validarMinimosMayoreo` (solo canal mayorista): agrupa carrito por presentación, suma qty, compara contra mínimo. Aviso en vivo en el carrito (`min-msg`) + **candado en `confirmarPedido`** (no deja confirmar bajo el mínimo, dice cuánto falta).
- Editables sin código (a petición de Abraham — el precio de la papa fluctúa): viven en `config_produccion` clave `'mayoreo'`. Panel admin "📦 Mínimos de mayoreo" (espejo del panel de lealtad, en la pantalla del Club). `MAYOREO_MINIMOS` ahora es `let`, cargado al arranque vía `cargarMayoreoCfg`.
- SQL: `mayoreo_config.sql` (RPCs `get_mayoreo_config`/`set_mayoreo_config` + siembra default). Esquema confirmado `config_produccion(clave, valor, descripcion, fecha_actualizacion)`. Funciones front: `renderMayoreoAdminCfg`, `guardarMayoreoCfg`.

**Archivos nuevos (Sesión 23):** `ubicacion_cliente.sql`, `precio_mayorista.sql`, `precios_por_presentacion.sql`, `mayoreo_config.sql`.

**Orden de despliegue Sesión 23:** `mayoreo_config.sql` → `precio_mayorista.sql` y/o `precios_por_presentacion.sql` → `ubicacion_cliente.sql` → subir `index.html`. (Verificar índice único/PK en `config_produccion.clave` para el ON CONFLICT.)

**Validaciones pendientes de Abraham (Sesión 23):** desplegar SQL + index.html; reintentar alta de "Abarrotes Don sebas" (`5517308186`); probar alta por vendedor (3 tipos), ajuste de ubicación, aviso anti-desviación, canal mayorista con precio, mínimos de mayoreo (carrito + checkout + panel admin editable). Fijar precios reales de mayorista mañana.

**Aprendizajes clave (Sesión 23):**
- El alta B2B autoservicio para tienditas estaba **al revés**: pedirle al tendero ajustar un pin es la fricción donde se cae el alta. El canal real es el vendedor tocando puertas → alta liderada por vendedor.
- Mayorista = revendedor/distribuidor: precio más bajo por volumen, **ojo con conflicto de canal** (que no reviente precios revendiendo a tiendas que ya atiendes directo).
- El modelo de precios ya estaba hecho para diferenciar por columna → sumar mayorista fue barato.
- NO duplicar catálogo para mayoreo (dos fuentes de verdad = deuda): reglas de mínimo por presentación sobre el mismo catálogo.
- Config que cambia seguido (mínimos de mayoreo, por fluctuación del precio de la papa) debe vivir en `config_produccion`, no en código.

**Pendientes que dejó la Sesión 23:**
- [ ] Fijar precios reales de `precio_mayorista` (Abraham, mañana).
- [ ] Si mayoristas compran a granel (por kg), la regla de mínimos por pieza no aplica → ajustar.
- [ ] (sigue) #1 asignación manual de lote (`−7.80`), #4 Entrega B, Instagram (Jocelyn).

---

### Sesión 24 (5 jul 2026) — Checkout auditado y corregido, back de navegación, corrección de lotes, candado y herramienta de reasignación

**Checkout — diagrama + matriz por tipo de cliente** (consumidor/tienda/restaurante/mayorista) generados desde el código real. Hallazgos y fixes:
- `TIPO_LABELS` y `MINIMOS` sin 'mayorista' → header "undefined" a mayoristas. Corregido (+ pantalla "pendiente de aprobación").
- **Bug Don Sebas (causa raíz):** el pre-llenado del cliente loggeado nunca llenaba `f-negocio` → el checklist bloqueaba a TODO B2B loggeado con "Falta: Nombre del establecimiento". Corregido (`clienteActual.negocio || nombre`); checklist y placeholder ahora incluyen mayorista.
- **Colonia en `*` (condición de carrera):** el prefill esperaba 1.2s fijos antes de seleccionar colonia; en redes lentas el combo seguía vacío. Nuevo helper `seleccionarColoniaCuandoCargue` (reintenta cada 300ms hasta ~8s) aplicado en cliente loggeado Y en `seleccionarCliente` (vendedor).
- **`tipoIdMap` sin mayorista** en `confirmarPedido` → un mayorista que ordenaba se DEGRADABA a Consumidor (tipoId 1). Corregido ('Mayorista / Distribuidor'/'Mayorista'/'mayorista' → 4).
- **Puntos: mayorista excluido.** Frontend (`ptosGanados = 0` si canal mayorista) + trigger (`lealtad_excluir_mayorista.sql`, cuerpo real de `otorgar_puntos_al_confirmar` obtenido de Abraham vía `pg_get_functiondef` + guard doble: `canal='mayorista'` O `clientes.tipo_id=4`).
- **Paquetería:** el candado ya existía (entrega-wrap oculto para no-consumidor, fuerza coordinar) — la matriz inicial lo pintó mal y se corrigió. Se agregó defensa extra en `actualizarEstadoPaqueteria` + mensaje post-pedido B2B en pantalla gracias ("🚚 Envía tu pedido a tu vendedor / reparto").
- **Sobrescritura de dirección detectada:** `confirmarPedido` upserta al cliente con la dirección del formulario → un envío puntual a otra dirección REEMPLAZA la principal. Es hoy el único mecanismo de actualización (sirve para "ajustar"), pero motiva la **multi-dirección** (tabla `clientes_direcciones` + selector en checkout, EN FILA, diseño acordado: backfill principal, chips 🏢/🏠, "nueva" agrega sin tocar principal, pedido deja de sobrescribir).

**Navegación:**
- **Back del teléfono:** wrapper global sobre `ir()`/`navegar()` con pila + `history.pushState`/popstate; el back retrocede dentro de la app (cierra el drawer primero si está abierto); en raíz sale (estándar PWA).
- **Bug de pantallas encimadas** (screenshot de Abraham): `navegar()` no apagaba pantallas fuera de `navSections` (s-alta-negocio quedaba activa sobre el catálogo). Fix en la raíz: `navegar` apaga toda `.screen.active` ajena. Los "← Volver" de alta-negocio y ajustar-ubicación ahora regresan a Mi cuenta.
- **Ajustar ubicación:** búsqueda por NOMBRE o teléfono con resultados en vivo (debounce 350ms, mín 3 chars, hasta 8 coincidencias clicables). RPC `buscar_clientes_ubicacion` en `ubicacion_cliente_v2.sql`.

**Inventario / lotes (el arco grande):**
- **Diagnóstico del −7.80 con datos reales:** motor internamente consistente (líneas = kilos_vendidos al gramo). Causa: lotes físicos registrados DÍAS después de usarse (22-jun entró el 26; 16-jun entró el 30) → el motor siguió descontando del 8-jun. Cronología reconstruida: lote 8-jun se agotó en PED-00028; PED-00032→00041 (7.95 kg) fueron el sobregiro.
- **Segundo hallazgo:** lotes 16-jun y 30-jun con kilos ×1000 (17,375 y 12,915 = coma de miles tragada). Confirmado por Abraham: reales 17.375 y 12.915.
- **`correccion_lotes.sql`** (aplicado ✓): transacción con `session_replication_role='replica'`, corrige kilos, reasigna PED-00032/33/35/36 → LOTE-20260616-01 y PED-00037/38/39/40/41 → LOTE-20260622-01, recalcula `kilos_vendidos` desde líneas. APRENDIZAJE DE ESQUEMA: **`kilos_disponibles` es columna GENERADA** (primer intento falló con 428C9; nunca escribirla).
- **Fix de captura de lote:** input acepta coma decimal + guardia >200 kg (confirm anti-toneladas) + **vista previa en vivo** ("✓ = 12 kg 915 g" / rojo si toneladas). Báscula de Abraham lee kg y gramos → el campo único con preview es la solución definitiva (NO dos campos kg+g: doble superficie de error).
- **Fecha de lote un día antes** (UTC→CDMX): helper `fechaSoloDia` (ancla a T12:00) aplicado en la card de lote.
- **Herramienta #1 — Reasignar lote de un pedido (admin):** botón "📦 Lote del pedido" en la card (solo `esAdminEstricto`), panel inline con lote actual + selector de últimos 12 lotes con disponibilidad, RPC `reasignar_lote_pedido` (`reasignar_lote.sql`): mueve TODAS las líneas y recalcula `kilos_vendidos` solo de lotes afectados. Decisiones: pedido completo (no por línea), permite lotes Cerrados (correcciones históricas). Probado por Abraham ✓.
- **Cierre con ajuste (`cierre_lotes_ajuste.sql`):** los 4 lotes físicamente vacíos (confirmado) → merma auditada en `notas`, `kilos_totales=kilos_vendidos` (disponible generada → 0), estatus Cerrado. **Dato de negocio: 27.85 kg (46% de la producción) salieron SIN registro en 3 semanas.** Regla desde hoy: kilo que sale = pedido (real o interno). Advertencia: "Producido total" en estadísticas ahora muestra lo vendido; el real vive en notas.
- **`candado_lote_activo.sql`:** `fn_reconciliar_pedido` ya NO hace return silencioso sin lote activo → `RAISE EXCEPTION '⛔ No hay LOTE ACTIVO…'`. Confirmar un pedido sin lote registrado es imposible (protege los 6.10 kg pendientes durante los días sin producción).
- **Kárdex transversal:** opción "📚 Todos los lotes (pedido → lote)" en el selector del kárdex: lista cada pedido con su(s) lote(s), kg y etiqueta de interno.

**Consultas de visibilidad entregadas:** kg vendidos (separando venta real vs internos, excluyendo cancelados) y versión con pendientes derivados por presentación (validada: 38.88 total = 32.78 descontados + 6.10 pendientes; los 0.245 de diferencia vs lotes = el sampling interno ✓).

**Archivos nuevos (Sesión 24):** `lealtad_excluir_mayorista.sql`, `ubicacion_cliente_v2.sql`, `correccion_lotes.sql` (aplicado), `cierre_lotes_ajuste.sql`, `reasignar_lote.sql`, `candado_lote_activo.sql`.

**Orden de despliegue Sesión 24 (lo no aplicado):** `cierre_lotes_ajuste.sql` (si no corrió) → `candado_lote_activo.sql` → `reasignar_lote.sql` → `ubicacion_cliente_v2.sql` → `lealtad_excluir_mayorista.sql` → subir `index.html`.

**Reglas operativas nuevas:**
1. Registrar el lote ANTES de la primera venta del día de producción (el candado lo fuerza).
2. Todo kilo que sale sin venta = pedido interno (sampling/consumo/merma) — alimenta Regalos vs Ventas.
3. NO confirmar los 6.10 kg pendientes hasta registrar el lote nuevo (~2 días; el candado frena el error).

**Pendientes que dejó la Sesión 24:**
- [ ] Multi-dirección para consumidor (diseño acordado, siguiente construcción grande).
- [ ] Cerrar el hilo báscula: resuelto (campo único + preview). ✓
- [ ] (sigue) #4 Entrega B, Instagram (Jocelyn), premios del Club, editar_pedido, QA iPhone.


---

## 6. ROADMAP, proximos pasos


### Bloqueantes para salir de Friends & Family
- [ ] QA end-to-end en iPhone (consumidor + tendero + admin).
- [ ] Completar imagenes del catalogo.
- [ ] Cargar premios del Crunchy Club (tabla `premios` VACIA).
- [ ] Confirmar que Stripe habilito depositos a CLABE.
- [ ] Observar la proxima factura de Twilio.
- [ ] Aviso de privacidad / terminos.
- [ ] Revision de seguridad RLS antes de abrir al publico.

### Edición de pedidos — `editar_pedido` (PRIORIDAD, Sesión 19)
Hoy NO se pueden editar líneas de un pedido; solo cambiar estatus. Caso real: cancelar 1 de 2 ítems.
Diseño propuesto (el inventario ya está preparado por el diseño por-línea):
- [ ] Trigger `DELETE` en `ordenes_detalle` que **devuelva** los kg de la línea borrada al lote
      (espejo del de INSERT, usando `id_lote_descontado`).
- [ ] Trigger `UPDATE` en `ordenes_detalle` que ajuste la diferencia al cambiar `cantidad`.
- [ ] UI/permisos: solo pedidos "jóvenes" (no Entregado, no Stripe-pagado); rastro `actualizado_por`;
      recálculo atómico de total + puntos + caja (asientos compensatorios).
- [ ] Reversa de puntos al cancelar/reembolsar un pedido ya premiado.

### OTIF (On-Time In-Full) — instrumentación (Sesión 19)
- [ ] **Fase 1 — On-Time %:** comparar `ordenes.fecha_entrega_real` vs `ordenes.fecha_entrega`
      (prometida). Definir regla para mostrador (entrega inmediata = on-time auto).
- [ ] **Fase 2 — In-Full:** requiere tracking de completitud por línea (se habilita con `editar_pedido`).
      OTIF real = On-Time **e** In-Full. Proxy temporal: "entregado y nunca modificado/cancelado".

### Crunchy Club
- [ ] Redención en checkout (RPC por construir; topes ya en config).
- [ ] Segmentación (hoy `todos_iguales`).

### Otros (post-lanzamiento)
- [ ] Ticket descargable (PDF). Combos de producto. Dashboard Fase 3. CMS-lite de banners.
      OTP por correo. Supabase Pro. Limpiar negativos del inventario por sabor (vive en RPCs
      `crear_pedido`/`actualizar_estatus_pedido`, fuera del repo).

---

## 7. Tablas clave de Supabase (resumen)

`ordenes` (cabecera) · `ordenes_detalle` (líneas; + cols Sesión 19: `kg_descontado_lote numeric`,
`id_lote_descontado text` — guard por línea del descuento de lote) ·
`clientes` · `prospectos` · `vendedores` · `cuotas_vendedor` ·
`config_secciones` · `config_produccion` (incl. clave 'lealtad') ·
`produccion_diaria` (id_lote, sabor, kilos_*, `fecha_siguiente`, `activo`) · `lotes_produccion`
(`kilos_disponibles` es GENERADA) · `vista_inventario` (vista por sabor, informativa) ·
**`stock_terminado`** (NUEVA — id, id_lote text, sabor, presentacion, piezas, gramos_unitarios,
fecha, registrado_por, fecha_creacion; RLS lectura/escritura anon+auth) ·
`inventario_fisico` (legado: reconciliación en kg; la app ya NO la usa, usa `stock_terminado`) ·
`insumos` · `uso_insumos` · `gastos` · `gastos_insumos` · `caja_*` · `lealtad_movimientos` ·
`canjes_historial` · `premios` (VACIA) · `cupones` / `cupones_uso` · `productos` / `productos_bebidas` ·
`zonas_vendedor` · `jornadas` · `encuestas` · `eventos_navegacion`.

> Nota: `ordenes` tiene dos columnas vestigiales `kg_descontado_lote` / `id_lote_descontado` de un
> intento previo; el control real vive en `ordenes_detalle`. Se pueden DROP sin afectar nada.

### RPCs / Triggers relevantes
`crear_pedido` (v2) · `siguiente_consecutivo` · `dashboard_resumen` (v2) ·
`get/set_lealtad_config` · `trg_otorgar_puntos` (puntos al Pagado+Entregado) ·
`obtener_fecha_entrega` (fecha sugerida de entrega) · `registrar_produccion_sabor` ·
**Sesión 19:** `fn_reconciliar_pedido(bigint)` (descuenta/devuelve kg del lote según estatus,
por línea, idempotente) · `trg_reconciliar_lote()` (trigger común) · triggers
`trg_ordenes_reconciliar` (AFTER UPDATE OF estatus_pedido ON ordenes) y
`trg_detalle_reconciliar` (AFTER INSERT ON ordenes_detalle).

---

## 8. Arquitectura: ruta del monolito a módulos (+ multi-plataforma)

Esta sección es para que **Claude Code** entienda el terreno antes de proponer/ejecutar cambios
estructurales. Objetivo: poder evolucionar el frontend de `index.html` monolítico a una base
**segmentada**, de forma **incremental y reversible**, sin romper producción.

### 8.1 Principio rector
El **backend de Supabase es el contrato estable** (REST + RPCs + Edge Functions). El frontend es
solo un cliente. Toda la segmentación es refactor de frontend; **no se toca el contrato del backend**.
Este desacople es también lo que habilitaría, en el futuro, otros clientes (app nativa, kiosko, etc.).

### 8.2 Estado actual (para Claude Code)
- Un solo `index.html` (~14,300 líneas): HTML + CSS inline + 3 `<script>`.
- El grueso de la lógica vive en el `<script type="module">`; lo invocado desde `onclick=""` se
  expone con `window.fn = ...`.
- Dominios funcionales identificables dentro del módulo: `supabaseCall`/infra, auth/sesión,
  catálogo, carrito/checkout, pedidos, **producción** (lotes, inventario, físico), lealtad (Club),
  B2B, prospectos, caja, gastos, jornadas, dashboards/resumen, PWA/instalación, helpers de UI.
- Rituales de validación vigentes (sección 3) que CUALQUIER refactor debe seguir manteniendo
  hasta que exista build+tests: balance de `<div>`, `node --check`, anclas únicas, no `push` sin OK.

### 8.3 Migración propuesta (incremental, no-rompe-nada)
La meta NO es reescribir: es **partir el fuente** manteniendo **idéntico el artefacto desplegado**.

- **Fase 0 — Build sin cambiar el deploy.** Introducir un bundler (Vite o esbuild) que tome fuentes
  separadas y emita **un solo `index.html`** equivalente al actual, que es lo que sube a Vercel.
  El deploy y el runtime no cambian; solo cambia *cómo se escribe* el fuente. Aquí se agrega
  por fin `lint` + `node --check` automático en el build, reemplazando la validación manual.
- **Fase 1 — Extraer el módulo gigante a ES modules por dominio.** Un archivo por dominio
  (p. ej. `src/produccion.js`, `src/checkout.js`, `src/supabase.js`…). Un `entry.js` importa todo y
  re-expone las funciones que el HTML usa vía `window.*` (preserva compatibilidad con `onclick=""`).
  Migrar **un dominio a la vez**, validando tras cada uno.
- **Fase 2 — Separar CSS y plantillas.** Sacar el CSS a archivos; trocear las grandes secciones de
  HTML en parciales/componentes (Web Components nativos o plantillas) que el build re-ensambla.
- **Fase 3 (opcional) — Framework ligero.** Solo si el dolor lo justifica (no por moda). Si se hace,
  que sea por dominio y detrás de feature flags, nunca un big-bang.

**Guardarraíles:**
1. Cada fase deja el sitio funcionando y desplegable; si algo falla, se revierte el commit.
2. No cambiar nombres de tablas/columnas/RPCs ni el formato de los payloads (contrato Supabase).
3. Mantener `window.*` para los `onclick` hasta migrarlos a listeners.
4. Reemplazar la validación manual por CI (lint+typecheck+tests) en la Fase 0, no después.

### 8.4 Hacia React (web) y React Native (app nativa)
El destino natural de la segmentación es **React**: para web (React + Vite) y, sobre todo, para
**app nativa con React Native / Expo** (iOS + Android desde una base de código). React reutiliza
TODO el conocimiento del backend porque el contrato de datos no cambia.

- **Lo que se conserva 100%:** el backend Supabase. Existe `@supabase/supabase-js` oficial que corre
  igual en React web y en React Native. Las tablas, RPCs (`crear_pedido`, `fn_reconciliar_pedido`,
  `dashboard_resumen`, etc.), RLS y Edge Functions (`crear-checkout`, `stripe-webhook`) se quedan tal cual.
- **Lo que se reescribe:** únicamente la capa de presentación/interacción (los `onclick`, el DOM,
  el CSS inline) pasa a componentes React con estado/hooks. La lógica de negocio del módulo gigante
  se traslada a funciones/hooks (`useCatalogo`, `useCheckout`, `useProduccion`…) que internamente
  llaman al cliente de Supabase.
- **Reutilización web ⇄ nativo:** mantener la lógica (data + reglas) en módulos **agnósticos de UI**
  permite compartirla entre el cliente web React y la app React Native; solo difieren los componentes
  visuales (DOM vs componentes nativos). Esto es exactamente lo que habilita la sección 8.3.

**Ruta recomendada (no big-bang):**
1. **Hacer primero la segmentación 8.3** (Fase 0–2). Sin eso, migrar a React es reescribir a ciegas.
   Con la lógica ya en módulos por dominio y la capa de datos aislada, React consume esos módulos.
2. **Definir el contrato de datos como fuente de verdad:** documentar tipos (idealmente TypeScript)
   de cada tabla/RPC. Ese paquete de tipos lo comparten web y nativo.
3. **Cliente web React (React + Vite)** primero, migrando un dominio a la vez detrás de feature flags;
   convive con el monolito durante la transición (rutas o subdominios separados).
4. **App nativa con Expo (React Native)** reutilizando la lógica/datos ya extraída. Diferencias a
   resolver propias de nativo:
   - **Pagos:** Stripe Checkout (web hospedado) en nativo se reemplaza por el **Stripe React Native SDK**
     (PaymentSheet). El `stripe-webhook` del backend no cambia.
   - **OTP/SMS:** sigue vía el endpoint actual (`/api/sheets`/Twilio) o se migra a Supabase Auth phone.
   - **PWA → nativo:** lo que hoy es "instalar como PWA" deja de aplicar; pasa a build de tienda
     (App Store / Play). Notificaciones, cámara (escáner de códigos), geolocalización usan APIs nativas.
   - **Service worker / offline:** se reemplaza por caché/estado nativo (React Query + almacenamiento).
- **Pendiente con Abraham:** decidir alcance del nativo (¿toda la app, o primero el cliente consumidor;
  el panel de admin/producción puede quedarse en web?) y si la web también migra a React o se mantiene
  el monolito hasta tener el nativo.

### 8.5 Orden sugerido de trabajo estructural
1. Fase 0 (build que emite el mismo index.html) — máximo valor, mínimo riesgo.
2. Extraer `supabase.js` + un dominio piloto (sugerido: **producción**, ya está bien acotado),
   dejando la lógica **agnóstica de UI**.
3. Resto de dominios, uno por uno + tipos del contrato de datos (TypeScript).
4. Cliente **React web** sobre esos módulos; luego **React Native/Expo** reutilizando la lógica.

---

## 9. Plan de redes sociales y atracción de clientes (Sesión 22)

> Objetivo: convertir alcance en redes en **clientes y prospectos rastreables**, apalancando lo que ya
> tenemos (app con cupones, lealtad, sampling→prospecto, y la métrica de Regalos vs Ventas).

### 9.0 BLOQUEANTE (paso 0, sin esto no hay ejecución)
- **Recuperar el control del Instagram `@crunchy.papsmx`.** Hoy bloqueado: el correo de recuperación sigue
  siendo el de Jocelyn. Acción: Jocelyn cambia el correo del IG → correo del negocio + 2FA; luego Abraham
  hace el handshake en business.facebook.com (en incógnito) → Control total. **Hasta aquí, todo lo demás espera.**
- En paralelo (no bloqueado): optimizar el perfil de Facebook, preparar contenido, definir cupones de campaña.

### 9.1 Posicionamiento (el "por qué Crunchy")
- **Qué nos hace distintos:** papas saborizadas artesanales, **sabores intensos** (Feroz, Habanero, Queso
  Jalapeño) y **hechas por lote / al momento** (frescura real, no industrial). Marca local CDMX.
- **Tono:** picante, juguetón, directo. Antojo + personalidad. Nada corporativo.
- **Promesa:** "el antojo crujiente que pica como te gusta".

### 9.2 Pilares de contenido (qué se publica)
1. **Antojo/producto** — beauty shots, ASMR del crunch, primeros planos. (Vende el deseo.)
2. **Detrás de cámara** — producción por lote, sazonado, frescura. (Construye confianza/artesanal.)
3. **Sabores/educación** — "¿cuál pica más?", maridajes, retos de picor. (Engagement + descubrimiento.)
4. **UGC / clientes** — reposts, testimonios, clientes disfrutando. (Prueba social.)
5. **Promo / Club** — cupones, lealtad, novedades. (Conversión directa, SIEMPRE con link rastreable.)
6. **Local / CDMX** — dónde encontrarnos, eventos, mostrador. (Atrae cercanía geográfica.)

### 9.3 Formatos y cadencia (realista, sostenible > ambiciosa)
- **Reels = prioridad de alcance** (3–4/semana): crunch ASMR, retos de picor, "un día haciendo papas".
- **Stories diario** (cercanía): encuestas de sabor, detrás de cámara, cuenta regresiva de lotes.
- **Carruseles** (1–2/semana): educación de sabores, cómo pedir, el Club explicado.
- **Colaboración / UGC destacado**: 1/semana mínimo.
- Regla: **constancia > perfección**. Mejor 3 reels imperfectos a la semana que 1 perfecto al mes.

### 9.4 Tácticas de atracción (alcance → cliente rastreable)
- **Cupón de bienvenida** como imán: "sígueme + primer pedido con código IG10" → cupón rastreable en la app.
- **Sampling como contenido + lead:** cada sampling YA crea un prospecto enlazado (Sesión 22). Grabar el
  sampling = contenido orgánico + lead capturado. Doble retorno.
- **Microinfluencers locales de comida CDMX:** pago en producto (= un "regalo"/bonificación **medible** con la
  métrica de Regalos vs Ventas). Empezar con 3–5 cuentas chicas pero con comunidad real y local.
- **Giveaways con mecánica de etiquetar** (sigue + etiqueta a 2 + comparte en story) → crecimiento + UGC.
- **Programa de referidos** apalancando el Crunchy Club (puntos por traer un amigo).
- **UGC incentivado:** "publica tu Crunchy y te repostamos / puntos del Club".

### 9.5 Conexión redes → app (NUESTRA VENTAJA, no improvisar)
- **UTMs en CADA link** (bio, post, campaña) → medir en **GA4** (pendiente de instrumentar, ver roadmap).
- **Link in bio → web con cupón** rastreable por campaña.
- **Cada campaña = su propio cupón** → saber exactamente qué post/influencer trajo ventas.
- **Costo de las colaboraciones (producto regalado) = medible** con la métrica Regalos vs Ventas por cliente/
  influencer. Esto cierra el círculo: sabemos el CAC real de cada colaboración, no a ciegas.

### 9.6 Específico por plataforma
- **Instagram:** Reels (alcance), Stories (cercanía), colaboraciones, etiquetas de producto (shopping si aplica),
  hashtags locales (#CDMX #antojosCDMX #papasartesanales). Es el canal principal para antojo visual.
- **Facebook:** grupos locales de CDMX (compra-venta, foodies de zona), Marketplace, eventos, comunidad/reseñas.
  Mejor para B2B (tiendas/restaurantes) y para alcance por zona geográfica. Cross-postear Reels.

### 9.7 Métricas (lo que importa, no los likes)
- **Vanidad (secundario):** seguidores, likes.
- **Lo que de verdad importa:** clics a bio (por UTM), **cupones canjeados por canal/campaña**, prospectos
  nuevos generados, **conversión sampling→cliente** (ya rastreable vía `prospectos.origen` + ventas reales),
  y **CAC por campaña** (gasto/producto regalado ÷ clientes nuevos atribuidos).
- Revisión: tablero simple mensual cruzando GA4 (UTMs) + cupones de la app + métrica de regalos.

### 9.8 Lo que NO hacer (honestidad de asesor)
- No comprar seguidores (mata el alcance orgánico y ensucia la métrica).
- No postear sin link rastreable / sin UTM (es regalar alcance sin saber si convierte).
- No depender solo de orgánico para B2C de impulso; el orgánico construye marca, los cupones convierten.
- No arrancar la inversión en colaboraciones ANTES de tener GA4/UTMs + cupones por campaña listos (medir primero).

### 9.9 Orden sugerido (quick wins → plays mayores)
1. **Recuperar IG** (bloqueante) + optimizar bio/perfil IG y FB con link+cupón de bienvenida.
2. **Instrumentar GA4/UTMs** (ya en roadmap) — sin esto medimos a ciegas.
3. **Cadencia base** (reels + stories) durante 4 semanas + 1 giveaway.
4. **3–5 microinfluencers locales** pagados en producto (medir CAC con la métrica de regalos).
5. **Programa de referidos** en el Club + UGC incentivado.
6. Escalar lo que el tablero diga que convierte; cortar lo que no.
