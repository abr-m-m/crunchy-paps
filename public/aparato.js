/*
 * El codigo del aparato — 27 nov 2026
 *
 * Abraham, al ver que la lista de sesiones solo decia «Android · Chrome»:
 * «¿el PIN que registra del aparato? ¿Id del aparato? ¿modelo? ¿marca?».
 *
 * Lo que un navegador deja leer es su user-agent y nada mas. Un IMEI, un numero
 * de serie o un id de aparato NO se pueden leer desde una web, y esta bien que
 * no se pueda. Asi que el aparato se bautiza: aqui se genera un codigo al azar
 * la primera vez que se entra en ese telefono, se guarda ahi, y el dueño le
 * pone nombre desde la consola.
 *
 * NO ES UNA HUELLA NI PRETENDE SERLO. Borrar los datos del navegador lo
 * reinicia y el aparato vuelve a aparecer sin nombre. Eso es una caracteristica
 * y no un fallo: un aparato que aparece sin nombre es justo el que hay que
 * mirar.
 *
 * ESTA EN UN SOLO ARCHIVO A PROPOSITO. Lo cargan las siete consolas, la pantalla
 * del agente, el radar y la app. Si cada una generara el suyo, dos copias con
 * distinta llave o distinto formato harian aparecer el MISMO telefono dos veces
 * en la lista, que es justo lo contrario de lo que esto sirve.
 *
 * El formato lo exige el servidor (`registrar_aparato`): ^[a-z0-9]{8,32}$. Un id
 * que no lo cumpla se ignora en silencio alla, asi que de este lado no hay una
 * segunda copia de esa regla.
 */
(function () {
  var LLAVE = 'cp_aparato';

  window.cpAparato = function () {
    try {
      var v = localStorage.getItem(LLAVE);
      if (v && /^[a-z0-9]{8,32}$/.test(v)) return v;

      // `crypto` es lo bueno; el `Math.random` de abajo es solo para que un
      // navegador viejo no se quede sin entrar. Esto NO es un codigo de acceso
      // -el token de sesion lo sigue dando el servidor-, asi que aqui un id
      // adivinable no abre ninguna puerta (regla 46: eso vale para los codigos
      // de acceso, y este no lo es).
      var n = '';
      if (window.crypto && crypto.getRandomValues) {
        var b = new Uint8Array(8);
        crypto.getRandomValues(b);
        for (var i = 0; i < b.length; i++) n += ('0' + b[i].toString(36)).slice(-2);
      } else {
        while (n.length < 16) n += Math.random().toString(36).slice(2);
      }
      n = n.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16);
      if (n.length < 8) return null;
      localStorage.setItem(LLAVE, n);
      return n;
    } catch (e) {
      // Navegacion privada o datos bloqueados: se entra igual y la sesion
      // aparece como «sin registrar». Decirlo es mejor que no dejar entrar.
      return null;
    }
  };
})();
