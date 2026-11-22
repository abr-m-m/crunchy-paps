#!/usr/bin/env python
# -*- coding: utf-8 -*-
# tools/precios-por-canal.py — La propuesta de precios por canal, en Excel vivo.
#
# Uso:  python tools/precios-por-canal.py            (produccion)
#       python tools/precios-por-canal.py --staging
#       npm run precios
#
# QUE HACE. Lee de produccion los HECHOS -el costo completo de cada
# presentacion en tres fechas, los precios de lista de cada canal y el volumen
# que de verdad se vendio- y escribe un libro donde la aritmetica del precio
# vive en FORMULAS, no en numeros pegados:
#
#   mapa-trabajo/Precios-por-canal.xlsx
#
# POR QUE ASI. Abraham pidio que los modelos tengan contraparte en Excel y no
# solo en la app. Un libro con numeros pegados no es un modelo: es una foto. En
# este, mover el precio de la papa en «Parametros» mueve costos, margenes, la
# prueba de esfuerzo y la caida de volumen que cada precio tolera.
#
# LO QUE NO HACE, Y ES LA FRONTERA. No calcula el costo: lo PREGUNTA a
# `costo_sku` y `costo_base_kg` en produccion. Una herramienta que copia la
# logica que mide no mide, repite (regla 63). Lo unico que esta herramienta
# calcula es lo que NO existe todavia en ningun sitio: el precio propuesto.
#
# EL CRITERIO ESTA EN `PARAMETROS`, no escondido en el codigo: el ancla por
# kilo, el factor de cada canal y la escalera por tamanio. Cambiarlos es
# cambiar la propuesta, y el libro se recalcula solo.

from __future__ import annotations

import io
import os
import sys

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SALIDA = os.path.join(RAIZ, 'mapa-trabajo', 'Precios-por-canal.xlsx')

PROD = 'xbyzarzyxiugrucyjwfn'
STG = 'dkwatbsaidlfjqjnfyrk'
REF = STG if '--staging' in sys.argv else PROD

# Las tres fechas no son decorativas: son el minimo, el maximo y el hoy de la
# serie de la papa, que se movio 3.6 veces en seis meses. Un precio que solo
# aguanta la papa de hoy no es un precio, es una apuesta.
F_BARATA, F_CARA, F_HOY = '2026-02-02', '2026-05-31', '2026-11-22'

PRESENTACIONES = [('100g', 0.1), ('250g', 0.25), ('500g', 0.5), ('1kg', 1.0)]
CANALES = [('consumidor', 'precio_consumidor'), ('mostrador', 'precio_mostrador'),
           ('restaurante', 'precio_restaurante'), ('tienda', 'precio_tienda'),
           ('mayorista', 'precio_mayorista')]

AZUL = PatternFill('solid', fgColor='1F3864')
GRIS = PatternFill('solid', fgColor='F2F2F2')
VERDE = PatternFill('solid', fgColor='E2EFDA')
ROJO = PatternFill('solid', fgColor='FCE4E4')
AMBAR = PatternFill('solid', fgColor='FFF2CC')
F_BLANCO = Font(color='FFFFFF', bold=True, size=12)
F_NEG = Font(bold=True)
F_CHICA = Font(size=9, color='595959')


def sql(consulta: str):
    """Lee produccion. Decodifica UTF-8 explicitamente: en Windows, subprocess
    con text=True usa la pagina de codigos del sistema."""
    import subprocess
    ruta = os.path.join(os.environ.get('TEMP', '/tmp'), '_precios_canal.sql')
    io.open(ruta, 'w', encoding='utf-8', newline='\n').write(consulta)
    salida = subprocess.run(
        ['supabase', 'db', 'query', '--linked', '--project-ref', REF, '-f', ruta],
        capture_output=True).stdout.decode('utf-8', 'replace')
    if '{' not in salida:
        return []
    try:
        import json
        return json.loads(salida[salida.index('{'):salida.rindex('}') + 1]).get('rows') or []
    except ValueError:
        return []


def medir():
    """Los hechos. Cada medida por separado y con un minimo por debajo del cual
    se declara ROTA, nunca «no hay» (regla 31): el 21 nov 2026 un UNION unico
    con una rama mala hizo que el mapa concluyera que no existia NADA."""
    costos = {}
    filas = sql("""
      with f as (select unnest(array['%s','%s','%s']::date[]) d),
           s as (select distinct on (presentacion) id, presentacion
                   from public.productos
                  where activo and presentacion in ('100g','250g','500g','1kg')
                  order by presentacion, id)
      select f.d::text fecha, s.presentacion,
             round(public.costo_sku(s.id, f.d), 4)::text costo,
             round(public.costo_base_kg(f.d), 4)::text base
        from f cross join s order by 1, 2;
    """ % (F_BARATA, F_CARA, F_HOY))
    if len(filas) != 12:
        raise SystemExit(
            '\n  La medida del costo devolvio %d filas y esperaba 12 (3 fechas x 4\n'
            '  presentaciones). La consulta fallo: el libro NO se escribe con un\n'
            '  costo roto, porque todo lo demas cuelga de el.\n' % len(filas))
    base = {}
    for f in filas:
        costos[(f['fecha'], f['presentacion'])] = float(f['costo'])
        base[f['fecha']] = float(f['base'])

    precios, filas = {}, sql("""
      select presentacion,
             min(precio_consumidor)::text  precio_consumidor,
             min(precio_mostrador)::text   precio_mostrador,
             min(precio_restaurante)::text precio_restaurante,
             min(precio_tienda)::text      precio_tienda,
             min(precio_mayorista)::text   precio_mayorista,
             count(distinct precio_consumidor)::text sabores_distintos
        from public.productos
       where activo and coalesce(descontinuado,false) = false
         and presentacion in ('100g','250g','500g','1kg')
       group by presentacion;
    """)
    if len(filas) != 4:
        raise SystemExit('\n  Los precios de lista devolvieron %d filas y esperaba 4.\n' % len(filas))
    for f in filas:
        if f['sabores_distintos'] != '1':
            raise SystemExit(
                '\n  La presentacion %s tiene MAS DE UN precio de consumidor entre sus\n'
                '  sabores. Este libro asume un precio por presentacion: revisalo antes\n'
                '  de usarlo.\n' % f['presentacion'])
        for canal, col in CANALES:
            precios[(f['presentacion'], canal)] = float(f[col])

    # El volumen real, que es lo que decide si una subida importa. Se mide por
    # presentacion y no por canal a proposito: los canales B2B tienen CERO
    # ventas, y la hoja «Medido» lo dice con su propia fila.
    vol = sql("""
      select coalesce(d.presentacion,'(nula)') presentacion,
             coalesce(o.canal,'(nulo)')        canal,
             sum(d.cantidad)::text             piezas,
             round(sum(d.subtotal),2)::text    neto
        from public.ordenes_detalle d join public.ordenes o on o.id = d.id_orden
       where coalesce(o.tipo_interno,'') = '' and o.estatus_pedido <> 'Cancelado'
       group by 1,2 order by 1,2;
    """)
    if not vol:
        raise SystemExit('\n  El volumen vendido devolvio 0 filas. La consulta fallo.\n')
    return costos, base, precios, vol


def cab(ws, titulo, subtitulo, anchos):
    for i, a in enumerate(anchos, start=1):
        ws.column_dimensions[get_column_letter(i)].width = a
    ws['A1'] = titulo
    ws['A1'].font = F_BLANCO
    ws['A1'].fill = AZUL
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=max(len(anchos), 2))
    ws['A2'] = subtitulo
    ws['A2'].font = F_CHICA
    ws['A2'].alignment = Alignment(wrap_text=True, vertical='top')
    ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=max(len(anchos), 2))
    ws.row_dimensions[2].height = 30


def encabezados(ws, fila, titulos):
    for c, t in enumerate(titulos, start=1):
        cel = ws.cell(row=fila, column=c, value=t)
        cel.font = F_NEG
        cel.fill = GRIS
        cel.alignment = Alignment(wrap_text=True, vertical='bottom')
    ws.row_dimensions[fila].height = 30
    return fila + 1


def hoja_parametros(wb, costos, base):
    """El criterio, editable. Todo lo demas del libro cuelga de aqui."""
    ws = wb.create_sheet('Parámetros')
    cab(ws, 'EL CRITERIO — esto es lo único que se edita a mano',
        'Cambia un número de esta hoja y el libro entero se recalcula. El costo NO está aquí: '
        'se mide en producción (hoja «Medido»), porque el costo es un hecho y esto son decisiones.',
        [44, 14, 70])
    r = encabezados(ws, 4, ['Qué decide', 'Valor', 'Por qué ese número'])

    bloques = [
        ('ANCLA', None, None),
        ('Precio por kilo del canal consumidor', 320,
         'El 100 g a $32 = $320/kg. Es el único precio de la lista de hoy que aguanta '
         'la papa cara (23 % de margen), y es donde está el 73 % de las piezas vendidas.'),
        ('FACTOR POR CANAL — qué paga cada uno respecto al consumidor', None, None),
        ('consumidor', 1.00, 'El ancla.'),
        ('mostrador', 1.00, 'Mismo cliente final, mismo precio. Hoy el mostrador paga MENOS en 500 g.'),
        ('restaurante', 0.88, 'Compra para servir, no para revender. 12 % por el volumen y la recurrencia.'),
        ('tienda', 0.80, 'Tiene que poder revender con su propio margen: a $26 el 100 g, vende a $35-40.'),
        ('mayorista', 0.78, 'Apenas por debajo de la tienda: compra más, pero el costo por kilo no baja con el volumen.'),
        ('ESCALERA POR TAMAÑO — descuento por kilo de la bolsa grande', None, None),
        ('100g', 1.000, 'La referencia.'),
        ('250g', 0.966, 'El costo por kilo del 250 g es 1.7 % menor que el del 100 g. Se devuelve el doble.'),
        ('500g', 0.902, 'Costo 4.9 % menor por kilo. Se devuelve el doble.'),
        ('1kg', 0.870, 'Costo 6.5 % menor por kilo. Se devuelve el doble: 13 % de descuento visible.'),
        ('PRUEBA DE ESFUERZO', None, None),
        ('Base por kilo — papa de hoy', base[F_HOY], 'Medido en producción al %s.' % F_HOY),
        ('Base por kilo — papa cara (31 may)', base[F_CARA],
         'La papa llegó a $36/kg. Ya pasó hace seis meses: no es un escenario, es historia.'),
        ('Base por kilo — papa barata (2 feb)', base[F_BARATA], 'El otro extremo de la serie.'),
        ('CAPACIDAD', None, None),
        ('Kg de base al mes (1 freidor, 11 tandas)', 165.2,
         '11 tandas x 15.02 kg. SUBE AL DOBLE si embolsar no lleva su propio día, y eso '
         'nadie lo ha medido todavía.'),
    ]
    ref = {}
    for nombre, valor, razon in bloques:
        if valor is None:
            cel = ws.cell(row=r, column=1, value=nombre)
            cel.font = F_NEG
            cel.fill = AMBAR
            ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=3)
            r += 1
            continue
        ws.cell(row=r, column=1, value=nombre)
        c = ws.cell(row=r, column=2, value=valor)
        c.font = F_NEG
        c.number_format = '#,##0.00' if valor > 2 else '0.000'
        d = ws.cell(row=r, column=3, value=razon)
        d.alignment = Alignment(wrap_text=True, vertical='top')
        ws.row_dimensions[r].height = 28
        ref[nombre] = 'Parámetros!$B$%d' % r
        r += 1
    return ref


def hoja_medido(wb, costos, base, precios, vol):
    """Los hechos, sin una sola formula. La hoja que delata si el libro miente."""
    ws = wb.create_sheet('Medido')
    cab(ws, 'LO QUE SE MIDIÓ EN PRODUCCIÓN — ningún número de esta hoja se escribió a mano',
        'El costo sale de `costo_sku` y `costo_base_kg`; los precios, de `productos`; el volumen, '
        'de las ventas reales (sin internos, sin cancelados). Si esta hoja está mal, todo el libro está mal.',
        [18, 14, 14, 14, 13, 13, 13, 13, 13])
    r = encabezados(ws, 4, ['Presentación', 'Costo hoy', 'Costo papa cara',
                            'Costo papa barata', 'Consumidor', 'Mostrador',
                            'Restaurante', 'Tienda', 'Mayorista'])
    fila_costo = {}
    for pres, _kg in PRESENTACIONES:
        ws.cell(row=r, column=1, value=pres).font = F_NEG
        for c, v in enumerate([costos[(F_HOY, pres)], costos[(F_CARA, pres)],
                               costos[(F_BARATA, pres)]], start=2):
            cel = ws.cell(row=r, column=c, value=v)
            cel.number_format = '"$"#,##0.00'
        for c, canal in enumerate(['consumidor', 'mostrador', 'restaurante',
                                   'tienda', 'mayorista'], start=5):
            cel = ws.cell(row=r, column=c, value=precios[(pres, canal)])
            cel.number_format = '"$"#,##0.00'
        fila_costo[pres] = r
        r += 1

    r += 1
    ws.cell(row=r, column=1, value='BASE POR KILO (sin empaque)').font = F_NEG
    r += 1
    for etq, f in [('hoy (%s)' % F_HOY, F_HOY), ('papa cara (%s)' % F_CARA, F_CARA),
                   ('papa barata (%s)' % F_BARATA, F_BARATA)]:
        ws.cell(row=r, column=1, value=etq)
        cel = ws.cell(row=r, column=2, value=base[f])
        cel.number_format = '"$"#,##0.00'
        r += 1

    r += 1
    ws.cell(row=r, column=1, value='VOLUMEN REAL VENDIDO — y aquí está la sorpresa').font = F_NEG
    ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=9)
    r += 1
    r = encabezados(ws, r, ['Presentación', 'Canal', 'Piezas', 'Neto'])
    for v in vol:
        ws.cell(row=r, column=1, value=v['presentacion'])
        ws.cell(row=r, column=2, value=v['canal'])
        ws.cell(row=r, column=3, value=float(v['piezas']))
        cel = ws.cell(row=r, column=4, value=float(v['neto']))
        cel.number_format = '"$"#,##0.00'
        r += 1
    r += 1
    nota = ws.cell(row=r, column=1, value=(
        'NINGUNA venta a tienda, restaurante ni mayorista. Los canales son web, '
        'vendedor y mostrador: los tres venden al consumidor final. El precio B2B '
        'no es un precio que haya que defender ante clientes que ya lo pagan — '
        'es una decisión sobre un canal que todavía no existe. Y 0 de 183 líneas '
        'usaron precio por caja.'))
    nota.font = F_NEG
    nota.alignment = Alignment(wrap_text=True, vertical='top')
    ws.merge_cells(start_row=r, start_column=1, end_row=r + 2, end_column=9)
    return fila_costo


def hoja_decision(wb, ref, fila_costo):
    """La propuesta. Todo formula: el precio propuesto, los margenes y la caida
    de volumen que tolera salen del ancla, el canal y la escalera."""
    ws = wb.create_sheet('Decisión', 0)
    cab(ws, 'PRECIOS POR CANAL — la propuesta',
        'El precio propuesto = ancla por kilo x factor del canal x escalera del tamaño x kilos, '
        'redondeado al peso. «Tolera» es cuánto volumen puede caer y seguir ganando lo mismo que hoy: '
        'si cae menos que eso, la subida gana aunque pierdas clientes.',
        [13, 7, 12, 12, 11, 12, 13, 12, 11, 13, 13, 13])
    r = 4
    for canal, _col in CANALES:
        cel = ws.cell(row=r, column=1, value=canal.upper())
        cel.font = F_NEG
        cel.fill = AMBAR
        ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=12)
        r += 1
        r = encabezados(ws, r, ['Presentación', 'kg', 'Costo hoy', 'Costo papa cara',
                                'Precio hoy', 'Margen hoy', 'Margen papa cara',
                                'PROPUESTO', 'Sube', 'Margen hoy', 'Margen papa cara',
                                'Tolera caída de'])
        for pres, kg in PRESENTACIONES:
            fc = fila_costo[pres]
            col_precio = {'consumidor': 'E', 'mostrador': 'F', 'restaurante': 'G',
                          'tienda': 'H', 'mayorista': 'I'}[canal]
            ws.cell(row=r, column=1, value=pres).font = F_NEG
            ws.cell(row=r, column=2, value=kg).number_format = '0.00'
            ws.cell(row=r, column=3, value='=Medido!B%d' % fc).number_format = '"$"#,##0.00'
            ws.cell(row=r, column=4, value='=Medido!C%d' % fc).number_format = '"$"#,##0.00'
            ws.cell(row=r, column=5, value='=Medido!%s%d' % (col_precio, fc)).number_format = '"$"#,##0.00'
            ws.cell(row=r, column=6, value='=IF(E%d=0,"",(E%d-C%d)/E%d)' % (r, r, r, r)).number_format = '0.0%'
            ws.cell(row=r, column=7, value='=IF(E%d=0,"",(E%d-D%d)/E%d)' % (r, r, r, r)).number_format = '0.0%'
            ws.cell(row=r, column=8, value='=ROUND(%s*%s*%s*B%d,0)'
                    % (ref['Precio por kilo del canal consumidor'], ref[canal],
                       ref[pres], r)).number_format = '"$"#,##0'
            ws.cell(row=r, column=8).font = F_NEG
            ws.cell(row=r, column=8).fill = VERDE
            ws.cell(row=r, column=9, value='=IF(E%d=0,"",H%d/E%d-1)' % (r, r, r)).number_format = '+0%;-0%'
            ws.cell(row=r, column=10, value='=(H%d-C%d)/H%d' % (r, r, r)).number_format = '0.0%'
            ws.cell(row=r, column=11, value='=(H%d-D%d)/H%d' % (r, r, r)).number_format = '0.0%'
            # Tolera = 1 - (gana hoy por pieza / gana con el precio nuevo). Si lo
            # de hoy es <= 0, cualquier subida gana: no hay caida que tolerar,
            # hay una perdida que para.
            ws.cell(row=r, column=12, value=(
                '=IF(OR(E%d=0,E%d-C%d<=0),"la de hoy pierde",1-(E%d-C%d)/(H%d-C%d))'
                % (r, r, r, r, r, r, r))).number_format = '0%'
            ws.cell(row=r, column=12).font = F_NEG
            for c in (6, 7, 10, 11):
                ws.cell(row=r, column=c).fill = ROJO if c in (6, 7) else VERDE
            r += 1
        r += 1

    ws.cell(row=r, column=1, value='GRANEL — $220/kg para todos los canales, y es el 31 % por debajo '
                                   'del 100 g por kilo. Cuesta la base pelada: no lleva bolsa ni etiqueta.').font = F_NEG
    ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=12)
    r += 1
    r = encabezados(ws, r, ['', 'kg', 'Costo hoy', 'Costo papa cara', 'Precio hoy',
                            'Margen hoy', 'Margen papa cara', 'PROPUESTO', 'Sube',
                            'Margen hoy', 'Margen papa cara', 'Tolera caída de'])
    ws.cell(row=r, column=1, value='Granel (1 kg)').font = F_NEG
    ws.cell(row=r, column=2, value=1).number_format = '0.00'
    ws.cell(row=r, column=3, value='=%s' % ref['Base por kilo — papa de hoy']).number_format = '"$"#,##0.00'
    ws.cell(row=r, column=4, value='=%s' % ref['Base por kilo — papa cara (31 may)']).number_format = '"$"#,##0.00'
    ws.cell(row=r, column=5, value=220).number_format = '"$"#,##0.00'
    ws.cell(row=r, column=6, value='=(E%d-C%d)/E%d' % (r, r, r)).number_format = '0.0%'
    ws.cell(row=r, column=7, value='=(E%d-D%d)/E%d' % (r, r, r)).number_format = '0.0%'
    # El mismo precio por kilo que la bolsa de 1 kg, al peso: «un kilo cuesta lo
    # mismo, en bolsa o a granel». El granel deja algo mas de margen porque no
    # lleva bolsa ni etiqueta, y eso es correcto -quien trae su bote se ahorra
    # el empaque, no el trabajo-.
    ws.cell(row=r, column=8, value='=ROUND(%s*%s,0)'
            % (ref['Precio por kilo del canal consumidor'], ref['1kg'])).number_format = '"$"#,##0'
    ws.cell(row=r, column=8).font = F_NEG
    ws.cell(row=r, column=8).fill = VERDE
    ws.cell(row=r, column=9, value='=H%d/E%d-1' % (r, r)).number_format = '+0%;-0%'
    ws.cell(row=r, column=10, value='=(H%d-C%d)/H%d' % (r, r, r)).number_format = '0.0%'
    ws.cell(row=r, column=11, value='=(H%d-D%d)/H%d' % (r, r, r)).number_format = '0.0%'
    ws.cell(row=r, column=12, value='=1-(E%d-C%d)/(H%d-C%d)' % (r, r, r, r)).number_format = '0%'
    return ws


def hoja_techo(wb, ref, fila_costo, vol):
    """Que gana el negocio al mes si el freidor va lleno, antes y despues. Con
    la mezcla REAL de lo vendido, no con una mezcla inventada."""
    ws = wb.create_sheet('Techo del freidor')
    cab(ws, 'EL TECHO: qué gana un mes lleno, con la mezcla que de verdad se vendió',
        'El freidor da 165.2 kg de base al mes con 11 tandas. Esta hoja reparte esos kilos con la '
        'misma mezcla de presentaciones que tuvo jun-sep 2026 y compara lo que dejan los precios de '
        'hoy contra los propuestos. No supone que la demanda crece: supone la misma mezcla.',
        [16, 12, 11, 15, 15, 16, 16])

    piezas = {}
    for v in vol:
        p = v['presentacion']
        if p in dict(PRESENTACIONES):
            piezas[p] = piezas.get(p, 0.0) + float(v['piezas'])

    r = encabezados(ws, 4, ['Presentación', 'Piezas jun-sep', 'kg de base',
                            '% de los kg', 'kg del mes lleno',
                            'Gana hoy (consumidor)', 'Gana propuesto'])
    primera = r
    for pres, kg in PRESENTACIONES:
        n = piezas.get(pres, 0.0)
        ws.cell(row=r, column=1, value=pres).font = F_NEG
        ws.cell(row=r, column=2, value=n)
        ws.cell(row=r, column=3, value=n * kg).number_format = '#,##0.00'
        r += 1
    ultima = r - 1
    for fila in range(primera, ultima + 1):
        i = fila - primera
        pres, kg = PRESENTACIONES[i]
        # Fila de ese tamanio en el bloque «consumidor» de Decisión: 4 es el
        # titulo del canal, 5 los encabezados, 6 el primer tamanio. Con `5 + i`
        # -el primer intento- el 100 g apuntaba a los ENCABEZADOS y daba
        # #¡VALOR!, y cada tamanio leia los numeros del anterior. Lo delato
        # Excel al recalcular, no el generador: openpyxl escribe la formula sin
        # evaluarla, asi que un libro de formulas no se cierra hasta verlo
        # calculado en una hoja de verdad (regla 58).
        fdec = 6 + i
        ws.cell(row=fila, column=4,
                value='=C%d/SUM($C$%d:$C$%d)' % (fila, primera, ultima)).number_format = '0.0%'
        ws.cell(row=fila, column=5,
                value='=D%d*%s' % (fila, ref['Kg de base al mes (1 freidor, 11 tandas)'])
                ).number_format = '#,##0.00'
        ws.cell(row=fila, column=6,
                value="=E%d/%s*('Decisión'!E%d-'Decisión'!C%d)" % (fila, kg, fdec, fdec)
                ).number_format = '"$"#,##0'
        ws.cell(row=fila, column=7,
                value="=E%d/%s*('Decisión'!H%d-'Decisión'!C%d)" % (fila, kg, fdec, fdec)
                ).number_format = '"$"#,##0'
    r = ultima + 1
    ws.cell(row=r, column=1, value='TOTAL del mes').font = F_NEG
    for c in (6, 7):
        cel = ws.cell(row=r, column=c,
                      value='=SUM(%s%d:%s%d)' % (get_column_letter(c), primera,
                                                 get_column_letter(c), ultima))
        cel.font = F_NEG
        cel.fill = VERDE
        cel.number_format = '"$"#,##0'
    r += 1
    cel = ws.cell(row=r, column=1, value='Diferencia')
    cel.font = F_NEG
    cel = ws.cell(row=r, column=7, value='=G%d/F%d-1' % (r - 1, r - 1))
    cel.font = F_NEG
    cel.number_format = '+0%;-0%'
    r += 2
    nota = ws.cell(row=r, column=1, value=(
        'Y la otra palanca, que no es de precio: si embolsar NO lleva su propio día, las '
        'tandas pasan de 11 a 22 y todo esto se DUPLICA. Ese dato se mide con una jornada '
        'y un reloj, no con una migración, y vale más que cualquier ajuste de precio.'))
    nota.font = F_NEG
    nota.alignment = Alignment(wrap_text=True, vertical='top')
    ws.merge_cells(start_row=r, start_column=1, end_row=r + 2, end_column=7)


def main():
    costos, base, precios, vol = medir()
    wb = Workbook()
    wb.remove(wb.active)
    ref = hoja_parametros(wb, costos, base)
    fila_costo = hoja_medido(wb, costos, base, precios, vol)
    hoja_decision(wb, ref, fila_costo)
    hoja_techo(wb, ref, fila_costo, vol)
    wb._sheets.sort(key=lambda s: ['Decisión', 'Parámetros', 'Medido',
                                   'Techo del freidor'].index(s.title))
    os.makedirs(os.path.dirname(SALIDA), exist_ok=True)
    wb.save(SALIDA)
    print('\n  %s' % SALIDA)
    print('  Leído de %s. El costo NO se calcula aquí: se pregunta a `costo_sku`.\n'
          % ('PRODUCCIÓN' if REF == PROD else 'staging'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
