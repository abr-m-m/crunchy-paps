/* La marca de agua de la app de pruebas — 27 nov 2026
 *
 * Abraham pidio una app de staging para ver lo que ve un consumidor, una
 * tienda, un restaurante o un mayorista. En cuanto existe una segunda app que
 * se ve IGUAL que la buena, hace falta algo que diga cual es cual: dos pestañas
 * abiertas y un pedido de prueba acaba en la base real, o peor, uno real se da
 * por hecho porque se hizo en la de mentira.
 *
 * QUE DECIDE QUE SE VEA. No el servidor donde vive la pagina —el despliegue de
 * produccion del proyecto de pruebas tambien se llama «production» para
 * Vercel—, sino DE QUE BASE salen los datos. `ES_PRUEBAS` lo calcula
 * `/api/config.js` negando el ref de produccion.
 *
 * POR QUE UNA PASTILLA Y NO UNA BANDA. Una banda arriba obliga a empujar el
 * cuerpo de la pagina, y esta app tiene pantallas a altura completa con su
 * propio scroll: el remedio seria peor. La pastilla flota, no mueve nada y
 * lleva `pointer-events:none`, asi que no puede tapar un boton.
 */
(function () {
  'use strict';
  try {
    var cfg = window.__CP_CONFIG__ || {};
    if (!cfg.ES_PRUEBAS) return;

    function poner() {
      if (document.getElementById('cp-pruebas')) return;
      var d = document.createElement('div');
      d.id = 'cp-pruebas';
      d.textContent = 'PRUEBAS · datos de mentira';
      d.setAttribute('role', 'status');
      d.setAttribute('style', [
        // ARRIBA A LA DERECHA, y no abajo al centro, que fue el primer intento:
        // ahi caia justo encima de la barra de navegacion de la app y tapaba
        // las etiquetas. Tocar seguia funcionando -lleva `pointer-events:none`-
        // pero una marca que estorba la leen una vez y luego la ignoran.
        'position:fixed', 'right:8px',
        'top:calc(6px + env(safe-area-inset-top))',
        'z-index:2147483647', 'pointer-events:none',
        'background:#E5B312', 'color:#1A1714',
        'font:700 11px/1 Inter,system-ui,sans-serif', 'letter-spacing:.08em',
        'padding:7px 12px', 'border-radius:999px',
        'box-shadow:0 2px 10px rgba(0,0,0,.25)', 'white-space:nowrap'
      ].join(';'));
      document.body.appendChild(d);
    }

    if (document.body) poner();
    else document.addEventListener('DOMContentLoaded', poner);
  } catch (e) { /* una marca de agua nunca debe tumbar la pagina */ }
})();
