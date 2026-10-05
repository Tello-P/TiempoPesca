#!/usr/bin/env python3
"""Genera programa/data/tramos.geojson y programa/data/estaciones.json.

- Tramos: capa oficial "Pesca CyL: tramos de pesca" (WFS de IDECyL, Junta de CyL).
- Estaciones de aforo: las de las cinco confederaciones con tramos en CyL (Duero, Tajo,
  Miño-Sil, Cantábrico y Ebro), leídas con programa/app/cuencas.py.
- Pueblos: capa oficial "Núcleos de población" (WFS de IDECyL), para indicar el pueblo
  más cercano al punto donde se pide el tiempo de cada tramo.

Se descargan todos los tramos de Castilla y León. A cada tramo se le asigna una
estación de aforo de su misma cuenca:
  1. la del mismo río más cercana a la línea del tramo (máx. MAX_KM_MISMO_RIO);
  2. si el río no tiene estación, la del río principal de su subcuenca más
     cercana (máx. MAX_KM_RIO_PRINCIPAL), marcada como aproximada.
Lagunas, charcas y canales no llevan estación.
Las asignaciones dudosas se corrigen a mano en OVERRIDES_ESTACION.

Uso: python3 programa/scripts/build_data.py
"""
import json
import math
import re
import sys
import unicodedata
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))
import cuencas  # noqa: E402

MAX_KM_MISMO_RIO = 50       # evita confundir ríos homónimos lejanos
MAX_KM_RIO_PRINCIPAL = 30
SIN_CAUDAL = re.compile(r"^(laguna|lagunas|lago|lagos|charca|charcas|balsa|canal|acequia)\b", re.I)

WFS_URL = "https://idecyl.jcyl.es/geoserver/pesca/wfs"
NUCLEOS_URL = WFS_URL.replace("/pesca/wfs", "/wfs") + "?" + urllib.parse.urlencode({
    "service": "WFS",
    "version": "1.1.0",
    "request": "GetFeature",
    "typename": "entidades:nucleos_cyl_poblaciones",
    "propertyName": "n_pob,n_mun,n_prov,x_25830,y_25830,n_tip_pob,n_tip_ocup",
    "outputFormat": "application/json",
})

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

# id_tramo -> id_estacion. Para corregir asignaciones automáticas.
OVERRIDES_ESTACION: dict[str, str] = {}

# Propiedades de la capa oficial que se conservan
CAMPOS = [
    "codigo", "etiqueta", "nombr_tram", "rio_mas_a", "categoria", "modalidad",
    "provincia", "tm", "truchera", "long_km", "lim_superi", "lim_inferi",
    "n_canas", "esp_princ", "per1_pec_i", "per1_pec_f", "per2_pec_i", "per2_pec_f",
    "truch_cm", "truch_cup_", "cebos", "otras_limi", "info_tramo", "cuenca", "subcuenca",
]


def http_get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "TiempoPesca/1.0"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return r.read()


def url_wfs() -> str:
    params = {
        "service": "WFS",
        "version": "1.1.0",
        "request": "GetFeature",
        "typename": "pesca:pesca_cyl_tramos_v",
        "srsName": "EPSG:4326",
        "outputFormat": "application/json",
    }
    return WFS_URL + "?" + urllib.parse.urlencode(params)


def descargar_tramos() -> list[dict]:
    return json.loads(http_get(url_wfs()))["features"]


def descargar_estaciones() -> tuple[list[dict], dict]:
    """Estaciones de aforo con caudal de todas las cuencas y el resultado por cuenca."""
    todas, resumen = [], {}
    for cuenca, listar in cuencas.LISTAR.items():
        try:
            est = listar()
            resumen[cuenca] = f"{len(est)} estaciones"
            todas += est
        except cuencas.ErrorFuente as e:
            resumen[cuenca] = f"ERROR: {e}"
        print(f"  {cuenca}: {resumen[cuenca]}")
    return todas, resumen


def normalizar(nombre: str) -> str:
    """'Tera (Soria)' -> 'tera'; 'Río Sil' -> 'sil'; quita tildes, paréntesis y prefijos."""
    nombre = re.sub(r"\(.*?\)", "", nombre or "")
    nombre = unicodedata.normalize("NFKD", nombre).encode("ascii", "ignore").decode().strip().lower()
    return re.sub(r"^(rio|riu|arroyo|ayo\.?|regato|rivera|ribera)\s+(de\s+(la\s+|los\s+|las\s+)?|del\s+)?", "", nombre).strip()


def descargar_pueblos() -> list[dict]:
    """Núcleos principales habitados de CyL con coordenadas [lon, lat]."""
    feats = json.loads(http_get(NUCLEOS_URL))["features"]
    pueblos = []
    for f in feats:
        p = f["properties"]
        if p["n_tip_pob"] != "Núcleo principal" or p["n_tip_ocup"] == "Despoblado":
            continue
        lon, lat = cuencas.utm_a_lonlat(p["x_25830"], p["y_25830"], 30)
        pueblos.append({"nombre": p["n_pob"], "municipio": p["n_mun"], "provincia": p["n_prov"],
                        "lon": lon, "lat": lat})
    return pueblos


def pueblo_cercano(punto: list[float], pueblos: list[dict]) -> dict:
    mejor = min(pueblos, key=lambda q: dist_km(punto, [q["lon"], q["lat"]]))
    return {
        "nombre": mejor["nombre"],
        "municipio": mejor["municipio"],
        "provincia": mejor["provincia"],
        "lat": round(mejor["lat"], 5),
        "lon": round(mejor["lon"], 5),
        "dist_km": round(dist_km(punto, [mejor["lon"], mejor["lat"]]), 1),
    }


# --- geometría -------------------------------------------------------------

def lineas(geom: dict) -> list[list[list[float]]]:
    if geom["type"] == "LineString":
        return [geom["coordinates"]]
    if geom["type"] == "MultiLineString":
        return geom["coordinates"]
    raise ValueError(geom["type"])


def dist_km(a: list[float], b: list[float]) -> float:
    """Distancia aproximada (equirectangular) entre [lon, lat]."""
    lat = math.radians((a[1] + b[1]) / 2)
    dx = math.radians(b[0] - a[0]) * math.cos(lat)
    dy = math.radians(b[1] - a[1])
    return 6371 * math.hypot(dx, dy)


def simplificar(pts: list[list[float]], tol: float) -> list[list[float]]:
    """Douglas-Peucker en grados (suficiente para dibujar)."""
    if len(pts) < 3:
        return pts
    (x1, y1), (x2, y2) = pts[0], pts[-1]
    dx, dy = x2 - x1, y2 - y1
    norm = math.hypot(dx, dy) or 1e-12
    idx, dmax = 0, 0.0
    for i in range(1, len(pts) - 1):
        x, y = pts[i]
        d = abs(dy * x - dx * y + x2 * y1 - y2 * x1) / norm
        if d > dmax:
            idx, dmax = i, d
    if dmax <= tol:
        return [pts[0], pts[-1]]
    return simplificar(pts[: idx + 1], tol)[:-1] + simplificar(pts[idx:], tol)


def punto_medio(partes: list[list[list[float]]]) -> list[float]:
    """Punto situado a mitad de longitud del tramo (sobre la línea)."""
    segs = [(a, b, dist_km(a, b)) for p in partes for a, b in zip(p, p[1:])]
    total = sum(s[2] for s in segs)
    if total == 0:
        return partes[0][0]
    acc = 0.0
    for a, b, d in segs:
        if acc + d >= total / 2:
            t = (total / 2 - acc) / d if d else 0
            return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
        acc += d
    return segs[-1][1]


def dist_a_linea(p: list[float], partes: list[list[list[float]]]) -> float:
    return min(dist_km(p, v) for parte in partes for v in parte)


# --- construcción ----------------------------------------------------------

def _mas_cercana(rio: str, partes, medio, estaciones, max_km: float):
    candidatas = []
    for e in estaciones:
        if not e["rio"] or normalizar(e["rio"]) != normalizar(rio):
            continue
        d = dist_a_linea([e["lon"], e["lat"]], partes)
        if d <= max_km:
            candidatas.append((e, d))
    if not candidatas:
        return None
    # Primero la más cercana a la línea; a igualdad (varias dentro del tramo),
    # la más cercana al punto medio.
    e, d = min(candidatas, key=lambda c: (round(c[1]), dist_km([c[0]["lon"], c[0]["lat"]], medio)))
    return e, d


def asignar_estacion(p: dict, partes, medio, estaciones) -> dict:
    """Devuelve {estacion, estacion_dist_km, estacion_tipo}."""
    nada = {"estacion": None, "estacion_dist_km": None, "estacion_tipo": None}
    if SIN_CAUDAL.match(p["rio_mas_a"] or ""):
        return nada
    estaciones = [e for e in estaciones if e["cuenca"] == p["cuenca"]]
    hit = _mas_cercana(p["rio_mas_a"], partes, medio, estaciones, MAX_KM_MISMO_RIO)
    tipo = "mismo_rio"
    if not hit and p.get("subcuenca") and normalizar(p["subcuenca"]) != normalizar(p["rio_mas_a"]):
        hit = _mas_cercana(p["subcuenca"], partes, medio, estaciones, MAX_KM_RIO_PRINCIPAL)
        tipo = "rio_principal"
    if not hit:
        return nada
    e, d = hit
    return {"estacion": e["id"], "estacion_dist_km": round(d, 1), "estacion_tipo": tipo}


def main():
    DATA_DIR.mkdir(exist_ok=True)
    print("Descargando estaciones de aforo de las confederaciones...")
    estaciones, resumen_cuencas = descargar_estaciones()
    print("Descargando tramos de IDECyL...")
    feats = descargar_tramos()
    print(f"  {len(feats)} tramos")
    print("Descargando núcleos de población de IDECyL...")
    pueblos = descargar_pueblos()
    print(f"  {len(pueblos)} pueblos")

    salida = []
    vistos: dict[str, int] = {}
    for f in feats:
        p = f["properties"]
        # La capa oficial repite algún código en tramos distintos: el id añade una letra
        # a partir de la segunda aparición (BU-AAL-124, BU-AAL-124-b...)
        n = vistos[p["codigo"]] = vistos.get(p["codigo"], 0) + 1
        id_tramo = p["codigo"] if n == 1 else f"{p['codigo']}-{chr(ord('a') + n - 1)}"
        if p["cuenca"] == "Tera":  # error de la capa: el Tera es de la cuenca del Duero
            p["cuenca"] = "Duero"
        partes = lineas(f["geometry"])
        medio = punto_medio(partes)
        asignacion = asignar_estacion(p, partes, medio, estaciones)
        if id_tramo in OVERRIDES_ESTACION:
            asignacion.update(estacion=OVERRIDES_ESTACION[id_tramo], estacion_tipo="manual")
        simpl = [
            [[round(x, 5), round(y, 5)] for x, y in simplificar(parte, 0.0003)]
            for parte in partes
        ]
        props = {"id": id_tramo, **{k: p.get(k) for k in CAMPOS}}
        props.update(
            lat=round(medio[1], 5),
            lon=round(medio[0], 5),
            pueblo=pueblo_cercano(medio, pueblos),
            **asignacion,
        )
        salida.append({
            "type": "Feature",
            "properties": props,
            "geometry": {"type": "MultiLineString", "coordinates": simpl},
        })

    # Solo se guardan las estaciones usadas. Las del Duero, con la URL fija de su histórico.
    usadas = {f["properties"]["estacion"] for f in salida} - {None}
    estaciones = [e for e in estaciones if e["id"] in usadas]
    duero = [e for e in estaciones if e["cuenca"] == "Duero"]
    print(f"Buscando el histórico de {len(duero)} estaciones del SAIH Duero (puede ir lento)...")
    cuencas.completar_duero(duero)

    # Orden: provincia, río y de aguas arriba a aguas abajo (aprox. por latitud)
    salida.sort(key=lambda f: (f["properties"]["provincia"], normalizar(f["properties"]["rio_mas_a"]),
                               -f["properties"]["lat"]))

    (DATA_DIR / "tramos.geojson").write_text(
        json.dumps({
            "type": "FeatureCollection",
            "metadata": {
                "generado": datetime.now().strftime("%Y-%m-%dT%H:%M"),
                "cuencas": cuencas.CUENCAS,
                "estaciones_por_cuenca": resumen_cuencas,
                "max_km_mismo_rio": MAX_KM_MISMO_RIO,
                "max_km_rio_principal": MAX_KM_RIO_PRINCIPAL,
                "fuente_tramos": url_wfs(),
                "fuente_pueblos": NUCLEOS_URL,
                "overrides_estacion": OVERRIDES_ESTACION,
            },
            "features": salida,
        }, ensure_ascii=False),
        encoding="utf-8",
    )
    (DATA_DIR / "estaciones.json").write_text(
        json.dumps(estaciones, ensure_ascii=False, indent=1), encoding="utf-8"
    )

    (DATA_DIR / "asignaciones.tsv").write_text(
        "id\tprovincia\trio\ttramo\tcuenca\testacion\ttipo\tdist_km\tpueblo\tpueblo_km\n" + "".join(
            f"{p['id']}\t{p['provincia']}\t{p['rio_mas_a']}\t{p['nombr_tram']}\t{p['cuenca']}\t"
            f"{p['estacion'] or ''}\t{p['estacion_tipo'] or ''}\t{'' if p['estacion_dist_km'] is None else p['estacion_dist_km']}\t"
            f"{p['pueblo']['nombre']}\t{p['pueblo']['dist_km']}\n"
            for p in (f["properties"] for f in salida)),
        encoding="utf-8",
    )
    tipos = {}
    for f in salida:
        clave = f["properties"]["estacion_tipo"] or f"sin estación ({f['properties']['cuenca']})"
        tipos[clave] = tipos.get(clave, 0) + 1
    print(f"\n{len(salida)} tramos. Caudal: {tipos}")
    print(f"Detalle de asignaciones para revisar: {DATA_DIR / 'asignaciones.tsv'}")
    print(f"Escrito {DATA_DIR / 'tramos.geojson'} y {DATA_DIR / 'estaciones.json'}")


if __name__ == "__main__":
    main()
