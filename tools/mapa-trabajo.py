#!/usr/bin/env python
# -*- coding: utf-8 -*-
# tools/mapa-trabajo.py — El mapa de trabajo de Crunchy Paps, en Excel y en pantalla.
#
# Uso:  python tools/mapa-trabajo.py            (produccion)
#       python tools/mapa-trabajo.py --staging
#       npm run mapa-trabajo
#
# QUE HACE. Lee `mapa-trabajo/frentes.json` -lo que ninguna maquina puede medir:
# a que frente pertenece una pieza, que porcentaje lleva, que va primero- y lo
# CONTRASTA contra produccion y contra el repo. Despues escribe:
#
#   mapa-trabajo/Mapa-Crunchy.xlsx     el libro de consulta
#   docs/mapa-trabajo/index.html       el mapa visual
#
# POR QUE SE COMPRUEBA. Un documento que se mantiene vivo a mano acaba
# mintiendo en la direccion mas comoda (regla 1), y en dos dias aparecieron
# cuatro afirmaciones falsas en bitacoras de este proyecto, todas por lo mismo:
# el trabajo se hizo y nadie cerro la nota. Ninguna se detecto leyendo.
#
# Asi que aqui, cada item declara donde vive en un formato que se puede mirar:
#
#   seccion:<clave>   -> ¿esta en el catalogo de `sesion_secciones`?
#   rpc:<nombre>      -> ¿existe esa funcion en produccion?
#   tabla:<nombre>    -> ¿existe esa tabla?
#   cron:<jobname>    -> ¿esta programado ese trabajo?
#   archivo:<ruta>    -> ¿existe ese archivo en el repo?
#   externo:<texto>   -> no se comprueba, y la hoja lo dice.
#
# Si un item dice «hecho» y lo que declara no existe, sale en ROJO en la hoja
# «Comprobado» y el script termina con codigo 1. El mapa no puede afirmar algo
# que la base desmiente.
#
# LO QUE NO HACE: no inventa porcentajes ni prioridades. Eso es criterio, y el
# criterio se escribe en el JSON a mano, con fecha.

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
from datetime import datetime, timezone, timedelta

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FUENTE = os.path.join(RAIZ, 'mapa-trabajo', 'frentes.json')
SALIDA_XLSX = os.path.join(RAIZ, 'mapa-trabajo', 'Mapa-Crunchy.xlsx')
SALIDA_HTML = os.path.join(RAIZ, 'docs', 'mapa-trabajo', 'index.html')

PROD = 'xbyzarzyxiugrucyjwfn'
STG = 'dkwatbsaidlfjqjnfyrk'
REF = STG if '--staging' in sys.argv else PROD

CDMX = timezone(timedelta(hours=-6))
HOY = datetime.now(CDMX).strftime('%Y-%m-%d %H:%M')

# ── paleta: la identidad de Crunchy, en claro para que el Excel sea legible ──
TINTA = '1F3864'
F_TIT = Font(name='Calibri', size=15, bold=True, color='FFFFFF')
F_SUB = Font(name='Calibri', size=9, color='D9E2F3')
F_CAB = Font(name='Calibri', size=10, bold=True, color='FFFFFF')
F_SEC = Font(name='Calibri', size=11, bold=True, color=TINTA)
F_TXT = Font(name='Calibri', size=10)
F_MIN = Font(name='Calibri', size=9, color='7F7F7F')
F_BOLD = Font(name='Calibri', size=10, bold=True)
F_MAL = Font(name='Calibri', size=10, bold=True, color='C00000')

R_TIT = PatternFill('solid', fgColor=TINTA)
R_CAB = PatternFill('solid', fgColor='4472C4')
R_SEC = PatternFill('solid', fgColor='D9E2F3')
R_OK = PatternFill('solid', fgColor='E2EFDA')
R_CURSO = PatternFill('solid', fgColor='FFF2CC')
R_PEND = PatternFill('solid', fgColor='F2F2F2')
R_BLOQ = PatternFill('solid', fgColor='FCE4EC')
R_MAL = PatternFill('solid', fgColor='FFC7CE')

B_FINA = Border(bottom=Side(style='thin', color='BFBFBF'))

RELLENO_ESTADO = {
    'hecho': R_OK, 'en curso': R_CURSO, 'pendiente': R_PEND,
    'bloqueado': R_BLOQ, 'descartado': R_PEND,
}


def sql(consulta: str):
    """Lee produccion. Decodifica UTF-8 explicitamente: en Windows, subprocess
    con text=True usa la pagina de codigos del sistema y deja «dueño» como
    «dueÃ±o» -ya casi llego asi una funcion a produccion el 21 nov 2026-."""
    ruta = os.path.join(os.environ.get('TEMP', '/tmp'), '_mapa_trabajo.sql')
    io.open(ruta, 'w', encoding='utf-8', newline='\n').write(consulta)
    salida = subprocess.run(
        ['supabase', 'db', 'query', '--linked', '--project-ref', REF, '-f', ruta],
        capture_output=True).stdout.decode('utf-8', 'replace')
    if '{' not in salida:
        return []
    try:
        return json.loads(salida[salida.index('{'):salida.rindex('}') + 1]).get('rows') or []
    except ValueError:
        return []


def medir():
    """Lo que de verdad hay, ahora mismo. Nada de esto se escribe a mano.

    CADA MEDIDA VA EN SU PROPIA CONSULTA, y no en un UNION grande, por una
    razon que costo una corrida: la primera version las unia todas y una de
    las ramas nombraba una funcion que no existe. Postgres rechazo la consulta
    ENTERA, `sql()` devolvio una lista vacia, y el mapa concluyo que no existia
    NINGUNA de las 76 piezas -incluidas `crear_pedido` y la tabla `rutas`-.

    Una comprobacion que no puede decirte que no llego a comprobar no
    comprueba nada (regla 31). De ahi las dos defensas de abajo: cada medida
    por separado, y un minimo por debajo del cual el resultado se declara
    ROTO en vez de leerse como «no hay»."""
    hay = {'rpc': set(), 'tabla': set(), 'cron': set(), 'seccion': set()}
    medidas = [
        ('rpc', 50, """select p.proname nombre from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace where n.nspname='public'"""),
        ('tabla', 20, """select table_name nombre from information_schema.tables
             where table_schema='public' and table_type='BASE TABLE'
             union all select table_name from information_schema.views
             where table_schema='public'"""),
        ('cron', 0, "select jobname nombre from cron.job"),
    ]
    for clase, minimo, consulta in medidas:
        filas = sql(consulta)
        for f in filas:
            if f.get('nombre'):
                hay[clase].add(f['nombre'])
        if len(hay[clase]) < minimo:
            raise SystemExit(
                '\n  La medida «%s» devolvio %d filas y no puede ser: la consulta fallo.\n'
                '  El mapa NO se escribe con una medida rota -diria que nada existe-.\n'
                % (clase, len(hay[clase])))

    # El catalogo de secciones vive en la constante `todas` de `sesion_secciones`,
    # que es donde lo pone el proyecto. Se lee de ahi y no de una lista propia:
    # una herramienta que copia lo que mide, repite (regla 63).
    cuerpo = sql("""select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.proname='sesion_secciones'""")
    src = cuerpo[0].get('prosrc', '') if cuerpo else ''
    if 'todas constant' in src:
        # Se corta DESPUES de `array[`, no despues de `todas constant`: si no,
        # el primer elemento se queda pegado a «text[] := array[» y `catalogo`
        # -la primera seccion de la app- salia como inexistente. Un error que
        # solo afecta al primero de una lista es de los que se leen por encima.
        trozo = src.split('todas constant', 1)[1]
        trozo = trozo.split('array[', 1)[1].split(']', 1)[0]
        hay['seccion'] = {t.strip().strip("'") for t in trozo.split(',') if "'" in t}
    if len(hay['seccion']) < 10:
        raise SystemExit(
            '\n  No pude leer el catalogo de secciones de `sesion_secciones`.\n'
            '  Sin el, toda pieza que diga `seccion:` saldria como inexistente.\n')

    cifras = sql("""
      select 'Clientes' q, count(*)::text v from clientes
      union all select 'Prospectos', count(*)::text from prospectos
      union all select 'Productos activos', count(*)::text from productos where activo
      union all select 'Pedidos', count(*)::text from ordenes
      union all select 'Líneas de pedido', count(*)::text from ordenes_detalle
      union all select 'Líneas costeadas', count(*)::text from ordenes_detalle where costo_unitario is not null
      union all select 'Vendedores activos', count(*)::text from vendedores where activo
      union all select 'Rutas', count(*)::text from rutas
      union all select 'Retos', count(*)::text from retos
      union all select 'Premios cargados', count(*)::text from premios
      union all select 'Gastos capturados', count(*)::text from gastos
      union all select 'Movimientos de puntos', count(*)::text from lealtad_movimientos
      union all select 'Costo por kg de base', coalesce(public.costo_base_kg(current_date)::text,'(sin costear)')
      union all select 'Funciones en public', count(*)::text from pg_proc p
                 join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
      union all select 'Tablas', count(*)::text from information_schema.tables
                 where table_schema='public' and table_type='BASE TABLE';
    """)
    return hay, [(f['q'], f['v']) for f in cifras]


def medir_pendientes(datos):
    """La OTRA direccion, y es la que fallo primero.

    `comprobar()` solo atrapa un sentido: el mapa dice «hecho» y no existe. El
    22 nov 2026 fallo el sentido contrario -el que este proyecto repite-: el
    mapa decia que recostear el pasado estaba PENDIENTE, con el margen
    historico en 32 %, y produccion ya tenia el costo completo y leia 9.2 %.
    Nadie cerro la nota. Casi corri un UPDATE masivo sobre una tabla de dinero
    para no cambiar nada.

    Asi que un item pendiente puede declarar EL HECHO que dejaria de ser cierto
    en cuanto el trabajo se haga, y el mapa falla si ese hecho ya cambio:

        "sigue_pendiente": "<SQL que devuelve una fila, columna `pendiente`>"
        "sigue_pendiente_sin_archivo": "<ruta que aun NO debe existir>"

    Es un HECHO suelto -una cuenta, una existencia-, nunca una copia de la
    logica que mide: una herramienta que copia lo que mide, repite (regla 63).
    Y una comprobacion que no contesta se declara ROTA, no «sigue pendiente»
    (regla 31): callar es como se cuelan las notas viejas."""
    veredictos = {}
    for f in datos['frentes']:
        for it in f['items']:
            if it['estado'] not in ('pendiente', 'en curso', 'bloqueado'):
                continue
            ruta = it.get('sigue_pendiente_sin_archivo')
            if ruta:
                existe = os.path.exists(os.path.join(RAIZ, ruta))
                veredictos[(f['clave'], it['nombre'])] = (
                    ('YA ESTÁ HECHO' if existe else 'sigue pendiente'),
                    '%s %s' % (ruta, 'EXISTE' if existe else 'no existe todavía'))
                continue
            consulta = it.get('sigue_pendiente')
            if not consulta:
                continue
            filas = sql(consulta)
            if not filas or 'pendiente' not in filas[0]:
                veredictos[(f['clave'], it['nombre'])] = (
                    'COMPROBACIÓN ROTA',
                    'la consulta no devolvió una columna `pendiente`')
                continue
            sigue = filas[0]['pendiente'] in (True, 't', 'true', 'True')
            veredictos[(f['clave'], it['nombre'])] = (
                ('sigue pendiente' if sigue else 'YA ESTÁ HECHO'),
                'el hecho declarado dice %s' % ('que falta' if sigue else 'QUE YA SE HIZO'))
    return veredictos


def comprobar(item, hay):
    """Devuelve (veredicto, detalle). El veredicto es lo que decide el color."""
    vive = (item.get('vive_en') or '').strip()
    if not vive:
        return 'sin declarar', 'El item no dice dónde vive'
    if ':' not in vive:
        return 'sin declarar', vive
    clase, valor = vive.split(':', 1)
    valor = valor.strip()
    if clase == 'externo':
        return 'no se comprueba', valor
    if clase == 'archivo':
        existe = os.path.exists(os.path.join(RAIZ, valor))
        return ('existe' if existe else 'NO EXISTE'), valor
    if clase in ('rpc', 'tabla', 'cron', 'seccion'):
        existe = valor in hay.get(clase, set())
        return ('existe' if existe else 'NO EXISTE'), '%s %s' % (clase, valor)
    return 'sin declarar', vive


def cab(ws, titulo, subtitulo, anchos):
    ws.sheet_view.showGridLines = False
    ancho = len(anchos)
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=ancho)
    c = ws.cell(row=1, column=1, value='  ' + titulo)
    c.fill, c.font = R_TIT, F_TIT
    c.alignment = Alignment(vertical='center')
    ws.row_dimensions[1].height = 30
    ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=ancho)
    c = ws.cell(row=2, column=1, value='  ' + subtitulo)
    c.fill, c.font = R_TIT, F_SUB
    for i in range(1, ancho + 1):
        ws.cell(row=1, column=i).fill = R_TIT
        ws.cell(row=2, column=i).fill = R_TIT
        ws.column_dimensions[get_column_letter(i)].width = anchos[i - 1]
    ws.freeze_panes = 'A5'


def encabezados(ws, fila, titulos):
    for i, t in enumerate(titulos, start=1):
        c = ws.cell(row=fila, column=i, value=t)
        c.fill, c.font = R_CAB, F_CAB
        c.alignment = Alignment(vertical='center', wrap_text=True)
    ws.row_dimensions[fila].height = 24
    return fila + 1


def escribir(ws, fila, valores, relleno=None, fuente=None, wrap=()):
    for i, v in enumerate(valores, start=1):
        c = ws.cell(row=fila, column=i, value=v)
        c.font = fuente or F_TXT
        c.border = B_FINA
        c.alignment = Alignment(vertical='top', wrap_text=(i in wrap))
        if relleno:
            c.fill = relleno
    return fila + 1


def main():
    datos = json.load(io.open(FUENTE, encoding='utf-8'))
    hay, cifras = medir()
    pendientes = medir_pendientes(datos)
    wb = Workbook()
    problemas = []

    # ── 1. RESUMEN ──────────────────────────────────────────────────────────
    ws = wb.active
    ws.title = 'Resumen'
    cab(ws, 'MAPA DE TRABAJO — CRUNCHY PAPS',
        'Generado el %s contra %s. No se edita a mano: se edita mapa-trabajo/frentes.json y se corre `npm run mapa-trabajo`.'
        % (HOY, 'PRODUCCIÓN' if REF == PROD else 'staging'),
        [7, 34, 11, 11, 11, 11, 52])
    r = encabezados(ws, 4, ['Frente', 'Nombre', 'Avance', 'Hecho', 'En curso', 'Pendiente', 'Lo siguiente'])
    for f in datos['frentes']:
        items = f['items']
        avance = round(sum(i.get('avance', 0) for i in items) / max(len(items), 1))
        cuenta = lambda e: sum(1 for i in items if i['estado'] == e)
        abiertos = sorted([i for i in items if i['estado'] != 'hecho' and i.get('prioridad')],
                          key=lambda i: i['prioridad'])
        r = escribir(ws, r, [f['clave'], f['nombre'], avance / 100.0,
                             cuenta('hecho'), cuenta('en curso'),
                             cuenta('pendiente') + cuenta('bloqueado'),
                             abiertos[0]['nombre'] if abiertos else '— nada abierto'],
                     RELLENO_ESTADO.get(f['estado'], R_PEND), wrap=(7,))
        ws.cell(row=r - 1, column=3).number_format = '0 %'
        ws.cell(row=r - 1, column=2).font = F_BOLD
    r += 1
    c = ws.cell(row=r, column=1, value='LO QUE HAY HOY, MEDIDO')
    c.font, c.fill = F_SEC, R_SEC
    r += 1
    for q, v in cifras:
        r = escribir(ws, r, [None, q, v])

    # ── 2. FRENTES ──────────────────────────────────────────────────────────
    ws = wb.create_sheet('Frentes')
    cab(ws, 'LOS FRENTES', 'Qué persigue cada uno y con qué se mide.', [7, 30, 56, 46, 12])
    r = encabezados(ws, 4, ['Frente', 'Nombre', 'Objetivo', 'Cómo se mide', 'Estado'])
    for f in datos['frentes']:
        r = escribir(ws, r, [f['clave'], f['nombre'], f['objetivo'], f.get('metrica', ''), f['estado']],
                     RELLENO_ESTADO.get(f['estado'], R_PEND), wrap=(3, 4))

    # ── 3. INVENTARIO ───────────────────────────────────────────────────────
    ws = wb.create_sheet('Inventario')
    cab(ws, 'TODO LO CONSTRUIDO', 'Una fila por pieza. «Visible» dice si es una pantalla o un motor.',
        [7, 46, 15, 11, 9, 9, 34, 42, 30])
    r = encabezados(ws, 4, ['Frente', 'Pieza', 'Tipo de trabajo', 'Estado', 'Avance',
                            'Visible', 'Dónde vive', 'Nota', 'Documento'])
    for f in datos['frentes']:
        for i in f['items']:
            r = escribir(ws, r, [f['clave'], i['nombre'], i['tipo'], i['estado'],
                                 i.get('avance', 0) / 100.0,
                                 'pantalla' if i.get('visible') else 'motor',
                                 i.get('vive_en', ''), i.get('nota', ''), i.get('doc', '')],
                         RELLENO_ESTADO.get(i['estado'], R_PEND), wrap=(2, 8))
            ws.cell(row=r - 1, column=5).number_format = '0 %'

    # ── 4. LO QUE SIGUE ─────────────────────────────────────────────────────
    ws = wb.create_sheet('Lo que sigue')
    cab(ws, 'LO QUE SIGUE, EN ORDEN', 'Solo lo que no está hecho, ordenado por prioridad. El orden es criterio, no cálculo.',
        [9, 7, 46, 15, 9, 11, 42, 40])
    r = encabezados(ws, 4, ['Prioridad', 'Frente', 'Pieza', 'Tipo', 'Avance', 'Estado',
                            'Bloqueado por', 'Nota'])
    abiertos = []
    for f in datos['frentes']:
        for i in f['items']:
            if i['estado'] != 'hecho':
                abiertos.append((i.get('prioridad', 999), f['clave'], i))
    for p, clave, i in sorted(abiertos, key=lambda x: x[0]):
        r = escribir(ws, r, [p if p != 999 else '—', clave, i['nombre'], i['tipo'],
                             i.get('avance', 0) / 100.0, i['estado'],
                             i.get('bloqueado_por', ''), i.get('nota', '')],
                     RELLENO_ESTADO.get(i['estado'], R_PEND), wrap=(3, 7, 8))
        ws.cell(row=r - 1, column=5).number_format = '0 %'

    # ── 5. CONECTORES ───────────────────────────────────────────────────────
    ws = wb.create_sheet('Conectores')
    cab(ws, 'CON QUÉ ESTÁ CONECTADA LA APP',
        'El libro de consulta. Los VALORES de los secretos no están aquí ni en ningún archivo del repo: el repo es público.',
        [22, 38, 30, 34, 24, 12, 40])
    r = encabezados(ws, 4, ['Servicio', 'Para qué', 'Dominio / identificador',
                            'Dónde vive la configuración', 'Dónde vive el secreto', 'Estado', 'Nota'])
    for c_ in datos['conectores']:
        relleno = {'activo': R_OK, 'parcial': R_CURSO, 'bloqueado': R_BLOQ,
                   'a retirar': R_CURSO, 'retirado': R_PEND}.get(c_['estado'], R_PEND)
        r = escribir(ws, r, [c_['servicio'], c_['para'], c_['dominio'], c_['config'],
                             c_['secreto'], c_['estado'], c_.get('nota', '')],
                     relleno, wrap=(2, 7))
    r += 1
    c = ws.cell(row=r, column=1, value='Las cuentas, el 2FA y la cadena de identidad están en ACCESOS.md. Aquí solo va la conexión técnica.')
    c.font = F_MIN

    # ── 6. MODELOS ──────────────────────────────────────────────────────────
    ws = wb.create_sheet('Modelos')
    cab(ws, 'LOS MODELOS Y SUS DOS CARAS',
        'Cada cálculo vive en la app Y tiene contraparte en Excel. Si las dos no dan lo mismo, una miente.',
        [30, 48, 28, 34, 34, 34])
    r = encabezados(ws, 4, ['Modelo', 'Qué calcula', 'En la app', 'En Excel', 'De qué se alimenta', 'Calibrado contra'])
    for m in datos['modelos']:
        r = escribir(ws, r, [m['nombre'], m['calcula'], m['en_la_app'], m['en_excel'],
                             m['entradas'], m['calibrado']], R_OK, wrap=(2, 6))

    # ── 7. COSTOS (la contraparte viva del modelo) ──────────────────────────
    ws = wb.create_sheet('Costos')
    cab(ws, 'COSTO Y MARGEN, HOY',
        'Leído de la base al generar. Las celdas de margen son FÓRMULAS: cambia un precio y recalcula.',
        [14, 13, 13, 13, 12, 12, 12, 12, 12, 12])
    filas = sql("""
      select p.presentacion, max(p.gramos) gramos,
             round(max(public.costo_sku(p.id, current_date)), 2) costo,
             max(p.precio_tienda) t, max(p.precio_mayorista) my,
             max(p.precio_restaurante) re, max(p.precio_consumidor) co
        from productos p
       where p.activo and public.costo_sku(p.id, current_date) is not null
       group by p.presentacion order by max(p.gramos);
    """)
    r = encabezados(ws, 4, ['Presentación', 'Gramos', 'Costo', 'Tienda', 'Mayorista',
                            'Restaurante', 'Consumidor', 'M. tienda', 'M. mayorista', 'M. consumidor'])
    primera = r
    for f in filas:
        n = lambda k: (float(f[k]) if f.get(k) not in (None, '') else None)
        r = escribir(ws, r, [f['presentacion'], n('gramos'), n('costo'),
                             n('t'), n('my'), n('re'), n('co')])
        for col in (3, 4, 5, 6, 7):
            ws.cell(row=r - 1, column=col).number_format = '"$"#,##0.00'
        # Formulas vivas: el Excel tiene que poder jugarse, no solo leerse.
        for col, precio in ((8, 'D'), (9, 'E'), (10, 'G')):
            c = ws.cell(row=r - 1, column=col,
                        value='=IF({p}{f}=0,"",1-$C{f}/{p}{f})'.format(p=precio, f=r - 1))
            c.number_format = '0.0 %'
            c.border = B_FINA
            c.font = F_TXT
    r += 1
    c = ws.cell(row=r, column=1, value='El costo incluye papa, aceite, gas, otros insumos, MANO DE OBRA, bolsa y etiqueta. '
                                       'La bolsa es un techo declarado por Abraham (25 oct 2026), no una medida.')
    c.font = F_MIN
    r += 2
    c = ws.cell(row=r, column=1, value='MARGEN YA VENDIDO (del costo congelado el día de cada pedido)')
    c.font, c.fill = F_SEC, R_SEC
    r += 1
    margen = sql("""
      select canal, count(*) lineas, round(sum(neto),2) neto, round(sum(costo),2) costo,
             public.pct_margen(sum(costo), sum(neto)) pct
        from public.margen_lineas(null, null) where not sin_costo
       group by canal order by sum(neto) desc;
    """)
    r = encabezados(ws, r, ['Canal', 'Líneas', 'Neto', 'Costo', 'Margen %'])
    for f in margen:
        num = lambda k: (float(f[k]) if f.get(k) not in (None, '') else None)
        r = escribir(ws, r, [f['canal'], f['lineas'], num('neto'), num('costo'),
                             (num('pct') or 0) / 100.0])
        ws.cell(row=r - 1, column=5).number_format = '0.0 %'
        for col in (3, 4):
            ws.cell(row=r - 1, column=col).number_format = '"$"#,##0.00'
    if not margen:
        r = escribir(ws, r, ['(sin líneas costeadas)', None, None, None, None])

    # ── 8. COMPROBADO ───────────────────────────────────────────────────────
    ws = wb.create_sheet('Comprobado')
    cab(ws, 'LO QUE SE COMPROBÓ CONTRA LA BASE',
        'Esta hoja existe para que el mapa no pueda mentir, en LOS DOS SENTIDOS: '
        'que no diga hecho lo que no existe, y que no diga pendiente lo que ya se hizo.',
        [7, 46, 11, 34, 18, 44])
    r = encabezados(ws, 4, ['Frente', 'Pieza', 'Dice', 'Declara vivir en', 'Veredicto', 'Detalle'])
    for f in datos['frentes']:
        for i in f['items']:
            veredicto, detalle = comprobar(i, hay)
            mal = (veredicto == 'NO EXISTE' and i['estado'] in ('hecho', 'en curso'))
            if mal:
                problemas.append('%s · %s · dice «%s» y %s'
                                 % (f['clave'], i['nombre'], i['estado'], detalle))
            # El sentido contrario manda sobre el de existencia: una pieza
            # pendiente suele vivir en una tabla que SI existe (el refresco
            # vive en `productos_bebidas`), asi que la existencia no dice nada
            # de si el trabajo esta hecho. El hecho declarado si.
            atras = pendientes.get((f['clave'], i['nombre']))
            if atras:
                veredicto, detalle = atras
                if veredicto != 'sigue pendiente':
                    mal = True
                    problemas.append('%s · %s · dice «%s» y %s'
                                     % (f['clave'], i['nombre'], i['estado'], detalle))
            r = escribir(ws, r, [f['clave'], i['nombre'], i['estado'],
                                 i.get('vive_en', ''), veredicto, detalle],
                         R_MAL if mal else (R_OK if veredicto == 'existe' else R_PEND),
                         F_MAL if mal else F_TXT, wrap=(2, 6))

    os.makedirs(os.path.dirname(SALIDA_XLSX), exist_ok=True)
    wb.save(SALIDA_XLSX)

    # ── El mapa visual ──────────────────────────────────────────────────────
    escribir_html(datos, cifras, problemas)

    print('\n  %s' % SALIDA_XLSX)
    print('  %s' % SALIDA_HTML)
    total = sum(len(f['items']) for f in datos['frentes'])
    hechos = sum(1 for f in datos['frentes'] for i in f['items'] if i['estado'] == 'hecho')
    print('\n  %d frentes · %d piezas · %d hechas (%d %%)'
          % (len(datos['frentes']), total, hechos, round(hechos * 100 / total)))
    if problemas:
        print('\n  %d AFIRMACIONES QUE LA BASE DESMIENTE:' % len(problemas))
        for p in problemas:
            print('    · %s' % p)
        print('\n  El mapa y la base no cuentan lo mismo. Corrige frentes.json.')
        return 1
    print('  Ninguna afirmación del mapa contradice a la base.\n')
    return 0


def escribir_html(datos, cifras, problemas):
    """El mapa visual. Mismo contenido, de un vistazo."""
    COLOR = {'hecho': '#2e7d32', 'en curso': '#f9a825', 'pendiente': '#616161',
             'bloqueado': '#c62828', 'descartado': '#424242'}
    partes = []
    for f in datos['frentes']:
        items = f['items']
        avance = round(sum(i.get('avance', 0) for i in items) / max(len(items), 1))
        abiertos = sorted([i for i in items if i['estado'] != 'hecho' and i.get('prioridad')],
                          key=lambda i: i['prioridad'])
        filas = ''.join(
            '<li class="it" style="--c:%s"><span class="n">%s</span>'
            '<span class="t">%s</span><span class="v">%s</span>'
            '<span class="p">%d%%</span></li>'
            % (COLOR.get(i['estado'], '#616161'), esc(i['nombre']), esc(i['tipo']),
               'pantalla' if i.get('visible') else 'motor', i.get('avance', 0))
            for i in items)
        partes.append(
            '<section class="fr"><header><span class="cl">%s</span>'
            '<h2>%s</h2><div class="bar"><i style="width:%d%%"></i></div>'
            '<span class="pc">%d%%</span></header>'
            '<p class="ob">%s</p>'
            '<p class="sig">Lo siguiente: <b>%s</b></p>'
            '<ul>%s</ul></section>'
            % (f['clave'], esc(f['nombre']), avance, avance, esc(f['objetivo']),
               esc(abiertos[0]['nombre']) if abiertos else 'nada abierto', filas))

    cif = ''.join('<div class="cf"><b>%s</b><span>%s</span></div>' % (esc(v), esc(q))
                  for q, v in cifras)
    aviso = ''
    if problemas:
        aviso = ('<div class="mal"><b>%d afirmaciones que la base desmiente.</b> '
                 'El mapa dice que algo está hecho y no está: %s</div>'
                 % (len(problemas), esc(' · '.join(problemas))))

    html = """<!doctype html>
<html lang="es" data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mapa de trabajo — Crunchy Paps</title>
<style>
 :root{--bg:#0e0e0e;--sup:#1a1a1a;--bor:#2e2e2e;--tx:#FAFAFA;--su:#888;--ac:#FFD200}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--tx);
      font:400 16px/1.5 Inter,system-ui,-apple-system,sans-serif;padding:0 20px 80px}
 .wrap{max-width:1100px;margin:0 auto}
 h1{font-size:2rem;font-weight:400;margin:32px 0 4px}
 .sub{color:var(--su);font-size:.875rem;margin:0 0 24px}
 .cifras{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:32px}
 .cf{background:var(--sup);border:1px solid var(--bor);border-radius:16px;
     padding:10px 14px;min-width:110px}
 .cf b{display:block;font-size:1.25rem;font-weight:600}
 .cf span{font-size:.6875rem;color:var(--su);text-transform:uppercase;letter-spacing:.06em}
 .mal{background:#3a1212;border:1px solid #c62828;border-radius:16px;
      padding:14px;margin-bottom:24px;font-size:.875rem}
 .fr{background:var(--sup);border:1px solid var(--bor);border-radius:16px;
     padding:16px;margin-bottom:16px}
 .fr header{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
 .cl{background:var(--ac);color:#0e0e0e;border-radius:999px;width:28px;height:28px;
     display:grid;place-items:center;font-weight:600;font-size:.875rem;flex:0 0 auto}
 .fr h2{font-size:1.25rem;font-weight:400;margin:0;flex:1 1 auto}
 .bar{flex:1 1 140px;height:6px;background:#2e2e2e;border-radius:999px;overflow:hidden}
 .bar i{display:block;height:100%;background:var(--ac)}
 .pc{font-size:.875rem;color:var(--su);min-width:40px;text-align:right}
 .ob{color:var(--su);font-size:.875rem;margin:10px 0 2px}
 .sig{font-size:.875rem;margin:0 0 12px}
 .fr ul{list-style:none;margin:0;padding:0}
 .it{display:flex;align-items:baseline;gap:10px;padding:9px 0;
     border-bottom:1px solid var(--bor);font-size:.875rem}
 .it::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--c);flex:0 0 auto}
 .n{flex:1 1 auto}
 .t,.v{color:var(--su);font-size:.75rem;white-space:nowrap}
 .v{opacity:.65}
 .p{color:var(--su);font-size:.75rem;min-width:36px;text-align:right}
 footer{color:var(--su);font-size:.75rem;margin-top:32px;line-height:1.7}
 @media(max-width:600px){.t,.v{display:none}}
</style></head><body><div class="wrap">
<h1>Mapa de trabajo</h1>
<p class="sub">Crunchy Paps · generado el __HOY__ contra __REF__ ·
 se regenera con <code>npm run mapa-trabajo</code></p>
<div class="cifras">__CIFRAS__</div>
__AVISO__
__FRENTES__
<footer>Esta página se GENERA de <code>mapa-trabajo/frentes.json</code>. No se edita a mano.<br>
Lo que se puede comprobar no se escribe: se mide contra la base y, si el mapa afirma algo
que la base desmiente, sale arriba en rojo y el generador falla.</footer>
</div></body></html>"""
    html = (html.replace('__HOY__', HOY)
                .replace('__REF__', 'producción' if REF == PROD else 'staging')
                .replace('__CIFRAS__', cif)
                .replace('__AVISO__', aviso)
                .replace('__FRENTES__', ''.join(partes)))
    os.makedirs(os.path.dirname(SALIDA_HTML), exist_ok=True)
    io.open(SALIDA_HTML, 'w', encoding='utf-8', newline='\n').write(html)


def esc(t):
    return (str(t).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))


if __name__ == '__main__':
    sys.exit(main())
