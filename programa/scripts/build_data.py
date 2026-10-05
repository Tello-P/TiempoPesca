#!/usr/bin/env python3
"""Genera programa/data/tramos.geojson y programa/data/estaciones.json.

- Tramos: capa oficial "Pesca CyL: tramos de pesca" (WFS de IDECyL, Junta de CyL).
- Estaciones de aforo: listado del SAIH Duero (www.saihduero.es/datos-tiempo-real/risr).
- Pueblos: capa oficial "Núcleos de población" (WFS de IDECyL), para indicar el pueblo
  más cercano al punto donde se pide el tiempo de cada tramo.

A cada tramo se le asigna la estación de aforo del mismo río más cercana
(distancia de la estación a la línea del tramo). Las asignaciones dudosas
se corrigen a mano en OVERRIDES_ESTACION.

Uso: python3 programa/scripts/build_data.py
"""
import json
import math
import re
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

RIOS = ["Carrión", "Esla", "Arlanzón", "Cea"]

WFS_URL = "https://idecyl.jcyl.es/geoserver/pesca/wfs"
SAIH_RISR_URL = "https://www.saihduero.es/datos-tiempo-real/risr"
NUCLEOS_URL = WFS_URL.replace("/pesca/wfs", "/wfs") + "?" + urllib.parse.urlencode({
    "service": "WFS",
    "version": "1.1.0",
    "request": "GetFeature",
    "typename": "entidades:nucleos_cyl_poblaciones",
    "propertyName": "n_pob,n_mun,n_prov,x_25830,y_25830,n_tip_pob,n_tip_ocup",
    "outputFormat": "application/json",
})

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

# codigo_tramo -> id_estacion. Para corregir asignaciones automáticas.
OVERRIDES_ESTACION: dict[str, str] = {}

# Propiedades de la capa oficial que se conservan
CAMPOS = [
    "codigo", "etiqueta", "nombr_tram", "rio_mas_a", "categoria", "modalidad",
    "provincia", "tm", "truchera", "long_km", "lim_superi", "lim_inferi",
    "n_canas", "esp_princ", "per1_pec_i", "per1_pec_f", "per2_pec_i", "per2_pec_f",
    "truch_cm", "truch_cup_", "cebos", "otras_limi", "info_tramo",
]


def http_get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "TiempoPesca/1.0"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return r.read()


def url_wfs() -> str:
    rios = ",".join(f"'{r}'" for r in RIOS)
    params = {
        "service": "WFS",
        "version": "1.1.0",
        "request": "GetFeature",
        "typename": "pesca:pesca_cyl_tramos_v",
        "srsName": "EPSG:4326",
        "outputFormat": "application/json",
        "CQL_FILTER": f"rio_mas_a IN ({rios})",
    }
    return WFS_URL + "?" + urllib.parse.urlencode(params)


def descargar_tramos() -> list[dict]:
    return json.loads(http_get(url_wfs()))["features"]


def descargar_estaciones() -> list[dict]:
    html = http_get(SAIH_RISR_URL).decode("utf-8")
    patron = re.compile(
        r"\{ id: '(EA\d+)', station: '([^']*)', river: '([^']*)', "
        r"lat: ([\d.\-]+), lng: ([\d.\-]+),[^}]*q: '"
    )
    estaciones = {}
    for m in patron.finditer(html):
        id_, nombre, rio, lat, lng = m.groups()
        if rio in RIOS:
            estaciones[id_] = {
                "id": id_,
                "nombre": nombre.rsplit(",", 1)[0].strip(),
                "rio": rio,
                "lat": float(lat),
                "lon": float(lng),
            }
    return list(estaciones.values())


def url_historico_caudal(id_: str) -> str | None:
    """URL del gráfico histórico de caudal de una estación (es fija para cada estación)."""
    html = http_get(f"https://www.saihduero.es/risr/{id_}").decode("utf-8", "replace")
    m = re.search(r"<td>Caudal</td>.*?href=\"(risr/" + re.escape(id_) + r"/historico/[A-Za-z0-9]+)\"", html, re.S)
    return f"https://www.saihduero.es/{m.group(1)}" if m else None


def descargar_pueblos() -> list[dict]:
    """Núcleos principales habitados de CyL con coordenadas [lon, lat]."""
    feats = json.loads(http_get(NUCLEOS_URL))["features"]
    pueblos = []
    for f in feats:
        p = f["properties"]
        if p["n_tip_pob"] != "Núcleo principal" or p["n_tip_ocup"] == "Despoblado":
            continue
        lon, lat = utm30_a_lonlat(p["x_25830"], p["y_25830"])
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

def utm30_a_lonlat(x: float, y: float) -> tuple[float, float]:
    """ETRS89 / UTM 30N (EPSG:25830) a [lon, lat] (fórmulas estándar de Krüger)."""
    a, f, k0 = 6378137.0, 1 / 298.257222101, 0.9996
    e2 = f * (2 - f)
    ep2 = e2 / (1 - e2)
    x -= 500000.0
    m = y / k0
    mu = m / (a * (1 - e2 / 4 - 3 * e2**2 / 64 - 5 * e2**3 / 256))
    e1 = (1 - math.sqrt(1 - e2)) / (1 + math.sqrt(1 - e2))
    phi1 = (mu + (3 * e1 / 2 - 27 * e1**3 / 32) * math.sin(2 * mu)
            + (21 * e1**2 / 16 - 55 * e1**4 / 32) * math.sin(4 * mu)
            + (151 * e1**3 / 96) * math.sin(6 * mu)
            + (1097 * e1**4 / 512) * math.sin(8 * mu))
    n1 = a / math.sqrt(1 - e2 * math.sin(phi1) ** 2)
    t1 = math.tan(phi1) ** 2
    c1 = ep2 * math.cos(phi1) ** 2
    r1 = a * (1 - e2) / (1 - e2 * math.sin(phi1) ** 2) ** 1.5
    d = x / (n1 * k0)
    lat = phi1 - (n1 * math.tan(phi1) / r1) * (
        d**2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1**2 - 9 * ep2) * d**4 / 24
        + (61 + 90 * t1 + 298 * c1 + 45 * t1**2 - 252 * ep2 - 3 * c1**2) * d**6 / 720)
    lon = (d - (1 + 2 * t1 + c1) * d**3 / 6
           + (5 - 2 * c1 + 28 * t1 - 3 * c1**2 + 8 * ep2 + 24 * t1**2) * d**5 / 120) / math.cos(phi1)
    return math.degrees(lon) - 3.0, math.degrees(lat)


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

def asignar_estacion(rio: str, partes, medio, estaciones) -> tuple[str | None, float | None]:
    candidatas = [e for e in estaciones if e["rio"] == rio]
    if not candidatas:
        return None, None
    # Primero la más cercana a la línea; a igualdad (varias dentro del tramo),
    # la más cercana al punto medio.
    def clave(e):
        p = [e["lon"], e["lat"]]
        return (round(dist_a_linea(p, partes), 0), dist_km(p, medio))
    mejor = min(candidatas, key=clave)
    return mejor["id"], round(dist_a_linea([mejor["lon"], mejor["lat"]], partes), 1)


def main():
    DATA_DIR.mkdir(exist_ok=True)
    print("Descargando estaciones del SAIH Duero...")
    estaciones = descargar_estaciones()
    print(f"  {len(estaciones)} estaciones de aforo; buscando su histórico (el SAIH puede ir lento)...")
    with ThreadPoolExecutor(max_workers=4) as pool:
        for e, url in zip(estaciones, pool.map(url_historico_caudal, (e["id"] for e in estaciones))):
            e["url_historico"] = url
            if not url:
                print(f"  Aviso: {e['id']} {e['nombre']} no publica caudal")
    print("Descargando tramos de IDECyL...")
    feats = descargar_tramos()
    print(f"  {len(feats)} tramos")
    print("Descargando núcleos de población de IDECyL...")
    pueblos = descargar_pueblos()
    print(f"  {len(pueblos)} pueblos")

    salida = []
    for f in feats:
        p = f["properties"]
        partes = lineas(f["geometry"])
        medio = punto_medio(partes)
        est, dist = asignar_estacion(p["rio_mas_a"], partes, medio, estaciones)
        est = OVERRIDES_ESTACION.get(p["codigo"], est)
        simpl = [
            [[round(x, 5), round(y, 5)] for x, y in simplificar(parte, 0.0002)]
            for parte in partes
        ]
        props = {k: p.get(k) for k in CAMPOS}
        props.update(
            lat=round(medio[1], 5),
            lon=round(medio[0], 5),
            estacion=est,
            estacion_dist_km=dist,
            pueblo=pueblo_cercano(medio, pueblos),
        )
        salida.append({
            "type": "Feature",
            "properties": props,
            "geometry": {"type": "MultiLineString", "coordinates": simpl},
        })

    # Orden: río y de aguas arriba a aguas abajo (aprox. por latitud del punto medio)
    salida.sort(key=lambda f: (f["properties"]["rio_mas_a"], -f["properties"]["lat"]))

    (DATA_DIR / "tramos.geojson").write_text(
        json.dumps({
            "type": "FeatureCollection",
            "metadata": {
                "generado": datetime.now().strftime("%Y-%m-%dT%H:%M"),
                "rios": RIOS,
                "fuente_tramos": url_wfs(),
                "fuente_estaciones": SAIH_RISR_URL,
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

    nombres = {e["id"]: e["nombre"] for e in estaciones}
    print("\nAsignación tramo -> estación (revisar):")
    for f in salida:
        p = f["properties"]
        print(f"  {p['rio_mas_a']:9} {p['codigo']:12} {p['nombr_tram'][:30]:30} -> "
              f"{p['estacion']} {nombres.get(p['estacion'], '-')[:25]:25} ({p['estacion_dist_km']} km) "
              f"| tiempo junto a {p['pueblo']['nombre']} ({p['pueblo']['dist_km']} km)")
    print(f"\nEscrito {DATA_DIR / 'tramos.geojson'} y {DATA_DIR / 'estaciones.json'}")


if __name__ == "__main__":
    main()
