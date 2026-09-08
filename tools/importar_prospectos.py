#!/usr/bin/env python3
# tools/importar_prospectos.py — Carga prospectos desde un CSV, por el mismo
# camino que usa la app: el RPC `importar_prospectos_bulk` con sesión de vendedor.
#
#   python tools/importar_prospectos.py datos.csv --revisar     # no escribe nada
#   python tools/importar_prospectos.py datos.csv               # carga de verdad
#
# Entorno (ninguno va en el código):
#   SUPABASE_URL        https://<ref>.supabase.co
#   SUPABASE_KEY        llave publishable (la misma que usa el navegador)
#   CP_VENDEDOR_TEL     teléfono del vendedor con sección `prospeccion`
#   CP_VENDEDOR_PIN     su PIN
#
# POR QUÉ POR EL RPC Y NO DIRECTO A POSTGRES (Abraham, 6 sep 2026)
# Escribir directo sería más rápido, pero duplicaría fuera de la base la regla de
# qué es un duplicado y saltaría el RLS. Yendo por el RPC, si mañana cambia esa
# regla el script la hereda sin tocarlo. El precio es ir por HTTP en lotes.
#
# LO QUE ESTE SCRIPT NO HACE, Y POR QUÉ
# No enriquece los prospectos que ya existen. `actualizar_prospecto` solo admite
# 9 campos —ninguno de los que trae un CSV— y además reasigna `id_vendedor` a
# quien la llama: usarla en lote le quitaría 1.132 prospectos a sus vendedores.
# Así que los duplicados NO se descartan en silencio: salen a un archivo con
# exactamente qué aportaría el CSV que la base no tiene, para decidir con datos.
#
# Sin dependencias: solo biblioteca estándar. En esta máquina no hay entorno
# virtual y añadir pip a un proceso que se corre tres veces al año es deuda.

import argparse
import csv
import json
import os
import re
import sys
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime

# La consola de Windows es cp1252 y no puede imprimir «→» ni las acentuadas: sin
# esto el script REVIENTA al escribir su propio informe, después de haber hecho
# todo el trabajo. Pasó en la primera prueba.
for _flujo in (sys.stdout, sys.stderr):
    try:
        _flujo.reconfigure(encoding="utf-8")
    except (AttributeError, OSError):
        pass

PROD_REF = "xbyzarzyxiugrucyjwfn"
TAM_LOTE = 200  # el RPC recorre el array en un bucle; lotes chicos = errores legibles


# ── Utilidades ──────────────────────────────────────────────────────────────

def sin_acentos(s):
    return "".join(c for c in unicodedata.normalize("NFD", s)
                   if unicodedata.category(c) != "Mn")


# Palabras de relleno que aparecen en encabezados escritos por humanos y no
# aportan nada al significado. Sin esto, «Nombre del negocio» no casa con
# «nombre_negocio» y el script se planta — pasó en la primera prueba.
RELLENO = {"del", "de", "la", "el", "los", "las", "y", "en", "por"}


def clave(s):
    """Normaliza un encabezado: 'Nombre del negocio' -> 'nombre_negocio'."""
    s = sin_acentos((s or "").strip().lower())
    partes = [p for p in re.split(r"[^a-z0-9]+", s) if p and p not in RELLENO]
    return "_".join(partes)


# Alias aceptados por campo. Un CSV de campo no viene con nuestros nombres, y
# hacer que el humano renombre columnas es la forma más segura de que no se use.
ALIAS = {
    "nombre":          ["nombre", "nombre_negocio", "negocio", "razon_social", "name"],
    "tipo":            ["tipo", "tipo_negocio", "giro", "categoria"],
    "telefono":        ["telefono", "tel", "celular", "contacto_telefono", "phone"],
    "direccion":       ["direccion", "domicilio", "address", "direccion_completa"],
    "calle":           ["calle", "street"],
    "colonia":         ["colonia", "col", "barrio", "neighborhood"],
    "codigoPostal":    ["codigo_postal", "cp", "postal", "zip"],
    "municipio":       ["municipio", "alcaldia", "delegacion", "ciudad", "city"],
    "estado":          ["estado", "entidad", "state"],
    "lat":             ["lat", "latitud", "latitude", "y"],
    "lng":             ["lng", "lon", "long", "longitud", "longitude", "x"],
    "score":           ["score", "puntaje", "calificacion", "tier_num"],
    "distanciaMetros": ["distancia_metros", "distancia", "metros", "distance"],
    "ref":             ["ref", "referencia", "referencias"],
    "tierOriginal":    ["tier", "tier_original", "nivel", "clasificacion"],
    "idExterno":       ["id_externo", "id", "external_id", "place_id", "folio"],
}


def mapear_encabezados(campos):
    """Devuelve {nuestro_campo: nombre_real_de_columna} para lo que aparezca."""
    disponibles = {clave(c): c for c in campos}
    mapa = {}
    for nuestro, alias in ALIAS.items():
        for a in alias:
            if a in disponibles:
                mapa[nuestro] = disponibles[a]
                break
    return mapa


def limpiar(v):
    return (v or "").strip()


def normalizar_telefono(v):
    """10 dígitos. Tolera +52, 52 delante, espacios, guiones y paréntesis."""
    d = re.sub(r"\D", "", limpiar(v))
    if len(d) == 12 and d.startswith("52"):
        d = d[2:]
    elif len(d) == 11 and d.startswith("1"):
        d = d[1:]
    return d if len(d) == 10 else ""


def a_float(v):
    try:
        return float(str(v).strip().replace(",", "."))
    except (TypeError, ValueError):
        return None


# ── Lectura y validación del CSV ────────────────────────────────────────────

def leer_csv(ruta):
    # utf-8-sig se come el BOM que mete Excel y que si no convierte la primera
    # columna en '﻿nombre', que luego no casa con ningún alias.
    with open(ruta, newline="", encoding="utf-8-sig") as f:
        muestra = f.read(8192)
        f.seek(0)
        try:
            dialecto = csv.Sniffer().sniff(muestra, delimiters=",;\t|")
        except csv.Error:
            dialecto = csv.excel  # una sola columna, o separador raro: coma por defecto
        return list(csv.DictReader(f, dialect=dialecto))


def preparar(fila, mapa, n_linea):
    """Devuelve (registro, motivo_de_rechazo). Uno de los dos es None."""
    g = lambda k: limpiar(fila.get(mapa[k])) if k in mapa else ""

    nombre = g("nombre")
    if not nombre:
        return None, "sin nombre de negocio"

    lat, lng = a_float(g("lat")), a_float(g("lng"))
    if lat is None or lng is None:
        return None, "sin coordenadas válidas"

    # Heurística del importador de la app (index.html:12900): rangos de México.
    # Latitud 14–33, longitud −120 a −86. Si vienen al revés, se enderezan en vez
    # de rechazar la fila: es un error de exportación muy común y recuperable.
    invertidas = False
    if abs(lat) > 60 and abs(lng) < 60:
        lat, lng = lng, lat
        invertidas = True
    if not (14 <= lat <= 33) or not (-120 <= lng <= -86):
        return None, f"coordenadas fuera de México (lat={lat}, lng={lng})"

    tel = normalizar_telefono(g("telefono"))
    if g("telefono") and not tel:
        return None, f"teléfono no son 10 dígitos: «{g('telefono')}»"

    score = 3
    s = a_float(g("score"))
    if s is not None and 1 <= s <= 5:
        score = int(s)

    cp = re.sub(r"\D", "", g("codigoPostal"))
    cp = cp.zfill(5)[:5] if cp else ""

    dist = a_float(g("distanciaMetros")) or 0

    return {
        "_linea": n_linea,
        "_invertidas": invertidas,
        # Estas claves son EXACTAMENTE las que espera el RPC (ver
        # 20260916000000_arreglar_columnas_fantasma.sql). No inventar nombres.
        "nombre": nombre,
        "tipo": g("tipo") or "Tienda / Abarrotes",
        "telefono": tel,
        "direccion": g("direccion"),
        "calle": g("calle"),
        "colonia": g("colonia"),
        "codigoPostal": cp,
        "municipio": g("municipio"),
        "estado": g("estado"),
        "lat": lat,
        "lng": lng,
        "score": score,
        "distanciaMetros": dist,
        "ref": g("ref"),
        "tierOriginal": g("tierOriginal"),
        "idExterno": g("idExterno"),
    }, None


# ── Cliente del RPC ─────────────────────────────────────────────────────────

class Api:
    def __init__(self, url, llave):
        self.url, self.llave = url.rstrip("/"), llave

    def rpc(self, fn, cuerpo):
        datos = json.dumps(cuerpo).encode("utf-8")
        pet = urllib.request.Request(
            f"{self.url}/rest/v1/rpc/{fn}", data=datos, method="POST",
            headers={"apikey": self.llave, "Authorization": f"Bearer {self.llave}",
                     "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(pet, timeout=120) as r:
                return json.loads(r.read().decode("utf-8") or "null")
        except urllib.error.HTTPError as e:
            # Se devuelve el cuerpo: PostgREST explica el porqué ahí, y perderlo
            # es cómo un fallo se convierte en «no sé, dio error».
            return {"ok": False, "_http": e.code,
                    "_cuerpo": e.read().decode("utf-8", "replace")[:400]}


# ── Programa ────────────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser(description="Importa prospectos desde un CSV.")
    p.add_argument("csv", help="archivo CSV de entrada")
    p.add_argument("--revisar", action="store_true",
                   help="analiza y escribe los informes, pero NO carga nada")
    p.add_argument("--produccion", action="store_true",
                   help="permite apuntar a producción (si no, aborta)")
    p.add_argument("--salida", default=None,
                   help="carpeta para los informes (por defecto, junto al CSV)")
    args = p.parse_args()

    url = os.environ.get("SUPABASE_URL", "")
    llave = os.environ.get("SUPABASE_KEY", "")
    tel_v = os.environ.get("CP_VENDEDOR_TEL", "")
    pin_v = os.environ.get("CP_VENDEDOR_PIN", "")
    if not (url and llave and tel_v and pin_v):
        sys.exit("Faltan SUPABASE_URL, SUPABASE_KEY, CP_VENDEDOR_TEL o CP_VENDEDOR_PIN.")

    # Mismo guardarraíl que probar-rls.mjs y probar-perfiles.mjs: esto ESCRIBE.
    if PROD_REF in url and not args.produccion and not args.revisar:
        sys.exit("ABORTADO: apunta a PRODUCCIÓN y este script escribe.\n"
                 "Corre primero con --revisar, y si de verdad es lo que quieres, --produccion.")

    base = args.salida or os.path.dirname(os.path.abspath(args.csv))
    sello = datetime.now().strftime("%Y%m%d-%H%M%S")
    ruta_rech = os.path.join(base, f"rechazos-{sello}.csv")
    ruta_enri = os.path.join(base, f"ya-existen-{sello}.csv")

    filas = leer_csv(args.csv)
    if not filas:
        sys.exit("El CSV no tiene filas.")
    mapa = mapear_encabezados(filas[0].keys())
    if "nombre" not in mapa:
        sys.exit(f"No encuentro una columna de nombre. Columnas: {list(filas[0].keys())}")

    print(f"\n  Archivo: {args.csv}")
    print(f"  Filas: {len(filas)}")
    print(f"  Columnas reconocidas: {', '.join(sorted(mapa))}")
    ignoradas = [c for c in filas[0].keys() if c not in mapa.values()]
    if ignoradas:
        print(f"  Columnas IGNORADAS: {', '.join(ignoradas)}")

    buenas, rechazos, invertidas = [], [], 0
    for i, fila in enumerate(filas, start=2):  # 2 = primera línea de datos
        reg, motivo = preparar(fila, mapa, i)
        if motivo:
            rechazos.append({"linea": i, "motivo": motivo, **fila})
        else:
            invertidas += reg.pop("_invertidas")
            buenas.append(reg)

    print(f"\n  Válidas: {len(buenas)} · Rechazadas: {len(rechazos)}"
          + (f" · Coordenadas enderezadas: {invertidas}" if invertidas else ""))

    api = Api(url, llave)
    ses = api.rpc("validar_vendedor_pin", {"p_data": {"telefono": tel_v, "pin": pin_v}})
    token = ses.get("token") if isinstance(ses, dict) else None
    if not token:
        sys.exit(f"Sin sesión de vendedor: {json.dumps(ses)[:300]}")

    # ── Quién ya está: se pregunta ANTES de cargar, para poder informar de los
    # duplicados en vez de que el RPC los cuente y se pierda qué traían.
    conocidos, off = set(), 0
    while True:
        r = api.rpc("obtener_prospectos", {"p_data": {"token": token, "limit": 2000, "offset": off}})
        lote = (r or {}).get("prospectos") or []
        for x in lote:
            t = normalizar_telefono(x.get("contacto_telefono"))
            if t:
                conocidos.add(t)
        if len(lote) < 2000:
            break
        off += 2000
    print(f"  Prospectos ya en la base: {len(conocidos)} con teléfono")

    nuevos = [r for r in buenas if not r["telefono"] or r["telefono"] not in conocidos]
    repes = [r for r in buenas if r["telefono"] and r["telefono"] in conocidos]
    print(f"  A cargar: {len(nuevos)} · Ya existen: {len(repes)}")

    # ── Informes, SIEMPRE, incluso en --revisar: son el entregable ──────────
    if rechazos:
        with open(ruta_rech, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, fieldnames=list(rechazos[0].keys()))
            w.writeheader(); w.writerows(rechazos)
        print(f"  → rechazos: {ruta_rech}")
    if repes:
        with open(ruta_enri, "w", newline="", encoding="utf-8-sig") as f:
            campos = [k for k in repes[0] if not k.startswith("_")]
            w = csv.DictWriter(f, fieldnames=campos, extrasaction="ignore")
            w.writeheader(); w.writerows(repes)
        print(f"  → ya existen (candidatos a enriquecer): {ruta_enri}")

    if args.revisar:
        print("\n  --revisar: no se cargó nada. Quita la bandera para hacerlo.\n")
        return 0

    # ── Carga por lotes ────────────────────────────────────────────────────
    creados = duplicados = 0
    errores = []
    for i in range(0, len(nuevos), TAM_LOTE):
        lote = nuevos[i:i + TAM_LOTE]
        payload = [{k: v for k, v in r.items() if not k.startswith("_")} for r in lote]
        r = api.rpc("importar_prospectos_bulk",
                    {"p_data": {"token": token, "prospectos": payload}})
        # Se mira lo que VUELVE, no que responda 200 (CLAUDE.md §4). Desde
        # 20260916000000 este RPC devuelve ok:false si no creó nada y hubo errores.
        if not isinstance(r, dict) or not r.get("ok"):
            print(f"  ✗ lote {i // TAM_LOTE + 1}: {json.dumps(r)[:300]}")
            errores.append(r)
            continue
        creados += r.get("creados", 0)
        duplicados += r.get("duplicados", 0)
        for e in (r.get("errores") or []):
            errores.append(e)
        print(f"  lote {i // TAM_LOTE + 1}/{-(-len(nuevos) // TAM_LOTE)}: "
              f"+{r.get('creados', 0)} creados, {r.get('duplicados', 0)} dup")

    # Se distingue «ya existía» (filtrado aquí, ni se envió) de «duplicado» (lo
    # detectó el RPC en la misma tanda). Un informe que mezcla las dos hace
    # pensar que no pasó nada cuando en realidad hay 3 fichas que enriquecer.
    print(f"\n  RESULTADO: {creados} creados · {len(repes)} ya existían · "
          f"{duplicados} duplicados dentro del envío · {len(errores)} errores · "
          f"{len(rechazos)} rechazados antes de enviar")
    if errores:
        # Los errores del RPC son objetos {item, error}: se aplanan a texto, que
        # es justo lo que la pantalla NO hacía («[object Object]»).
        with open(ruta_rech.replace("rechazos-", "errores-servidor-"), "w",
                  newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f); w.writerow(["error", "item"])
            for e in errores:
                if isinstance(e, dict):
                    w.writerow([e.get("error", json.dumps(e)[:200]),
                                json.dumps(e.get("item", ""), ensure_ascii=False)[:500]])
                else:
                    w.writerow([str(e)[:200], ""])
        print(f"  → errores del servidor: {ruta_rech.replace('rechazos-', 'errores-servidor-')}")
    print()
    return 1 if errores else 0


if __name__ == "__main__":
    sys.exit(main())
