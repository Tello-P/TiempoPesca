"""Lectura de caudales de las confederaciones hidrográficas con tramos en Castilla y León.

Cada confederación publica sus datos de una forma distinta. Para cada una hay:
  - listar_<cuenca>()          -> estaciones de aforo con caudal (se usa al generar los datos)
  - serie_<cuenca>(estacion)   -> [(datetime en hora peninsular, m³/s), ...] ordenada

Una estación es un dict con: id ("cuenca:codigo"), cuenca, codigo, nombre, rio, lat, lon,
url_publica (página para personas) y los datos propios de su fuente en "extra".

Ninguna de estas webs tiene una API pública documentada salvo la del Ebro (que pide clave);
el resto se leen igual que las lee su propia web. Si una cambia su diseño, hay que ajustar
aquí solo la función de esa cuenca.
"""
import csv
import html
import io
import json
import math
import os
import re
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from pathlib import Path

USER_AGENT = "Mozilla/5.0 (TiempoPesca; uso personal)"
REINTENTOS = 3
CODIGOS_TEMPORALES = {429, 500, 502, 503, 504}
CONFIG = Path(__file__).resolve().parent.parent / "config.json"

# La web del SAIH Ebro no envía el certificado intermedio de la FNMT; se incluye aquí
# para poder verificar su HTTPS sin desactivar la seguridad.
_CTX = ssl.create_default_context()
_CTX.load_verify_locations(Path(__file__).resolve().parent / "certificados" / "fnmt_ac_componentes_informaticos.pem")

CUENCAS = {
    "Duero": {"organismo": "Confederación Hidrográfica del Duero", "saih": "SAIH Duero",
              "web": "https://www.saihduero.es"},
    "Tajo": {"organismo": "Confederación Hidrográfica del Tajo", "saih": "SAIH Tajo",
             "web": "https://saihtajo.chtajo.es"},
    "Miño-Sil": {"organismo": "Confederación Hidrográfica del Miño-Sil", "saih": "SAIH Miño-Sil",
                 "web": "https://saih.chminosil.es"},
    "Cantábrico": {"organismo": "Confederación Hidrográfica del Cantábrico", "saih": "SAI Cantábrico",
                   "web": "https://visor.saichcantabrico.es"},
    "Ebro": {"organismo": "Confederación Hidrográfica del Ebro", "saih": "SAIH Ebro",
             "web": "https://www.saihebro.com"},
}


class ErrorFuente(Exception):
    pass


# --- utilidades -------------------------------------------------------------------

def http(url: str, datos: dict | bytes | None = None, cabeceras: dict | None = None,
         timeout: int = 60, opener=None) -> bytes:
    """GET (o POST si hay datos) con reintentos ante errores temporales."""
    if isinstance(datos, dict):
        datos = urllib.parse.urlencode(datos).encode()
    req = urllib.request.Request(url, data=datos, headers={"User-Agent": USER_AGENT, **(cabeceras or {})})
    abrir = opener.open if opener else (lambda r, timeout: urllib.request.urlopen(r, timeout=timeout, context=_CTX))
    for intento in range(REINTENTOS):
        try:
            with abrir(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in CODIGOS_TEMPORALES and intento < REINTENTOS - 1:
                time.sleep(1.5 * (intento + 1))
                continue
            cuerpo = e.read().decode("utf-8", "replace")[:200].strip()
            raise ErrorFuente(f"HTTP {e.code} en {url.split('?')[0]}: {cuerpo}") from e
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if intento < REINTENTOS - 1:
                time.sleep(1.5 * (intento + 1))
                continue
            raise ErrorFuente(f"No se pudo conectar con {url.split('?')[0]}: {e}") from e
    raise AssertionError("inalcanzable")


def texto_html(h: str) -> str:
    h = re.sub(r"<script.*?</script>|<style.*?</style>", " ", h, flags=re.S | re.I)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", h))).strip()


def num(s: str) -> float:
    """'1.234,5' o '1234.5' -> float."""
    s = s.strip()
    if "," in s:
        s = s.replace(".", "").replace(",", ".")
    return float(s)


def utm_a_lonlat(x: float, y: float, huso: int = 30) -> tuple[float, float]:
    """ETRS89 / UTM (hemisferio norte) a (lon, lat). Fórmulas estándar de Krüger."""
    a, f, k0 = 6378137.0, 1 / 298.257222101, 0.9996
    e2 = f * (2 - f)
    ep2 = e2 / (1 - e2)
    x -= 500000.0
    mu = (y / k0) / (a * (1 - e2 / 4 - 3 * e2**2 / 64 - 5 * e2**3 / 256))
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
    return math.degrees(lon) + (huso * 6 - 183), math.degrees(lat)


def _ultimo_domingo(anio: int, mes: int) -> date:
    d = date(anio, mes + 1, 1) - timedelta(days=1) if mes < 12 else date(anio, 12, 31)
    return d - timedelta(days=(d.weekday() + 1) % 7)


def utc_a_peninsular(t: datetime) -> datetime:
    """Hora UTC -> hora peninsular española (sin depender de tzdata, que falta en Windows)."""
    ini = datetime.combine(_ultimo_domingo(t.year, 3), datetime.min.time()) + timedelta(hours=1)
    fin = datetime.combine(_ultimo_domingo(t.year, 10), datetime.min.time()) + timedelta(hours=1)
    return t + timedelta(hours=2 if ini <= t < fin else 1)


def rio_de(nombre: str) -> str:
    """'ALBERCHE EN NAVALUENGA' -> 'ALBERCHE'; quita prefijos 'RIO'."""
    rio = re.split(r"\s+EN\s+", nombre.strip(), maxsplit=1, flags=re.I)[0]
    return re.sub(r"^(R[IÍ]O|RIU)\s+", "", rio, flags=re.I).strip()


def estacion(cuenca: str, codigo: str, nombre: str, rio: str, lon: float, lat: float,
             url_publica: str, **extra) -> dict:
    return {"id": f"{cuenca}:{codigo}", "cuenca": cuenca, "codigo": codigo, "nombre": nombre,
            "rio": rio, "lat": round(lat, 6), "lon": round(lon, 6), "url_publica": url_publica,
            "extra": extra}


def leer_config() -> dict:
    try:
        cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        cfg = {}
    # En Vercel (y otros despliegues) la clave del Ebro llega por variable de entorno.
    clave = os.environ.get("EBRO_APIKEY", "").strip()
    if clave and not cfg.get("ebro_apikey"):
        cfg["ebro_apikey"] = clave
    return cfg


# --- Duero: www.saihduero.es -------------------------------------------------------

DUERO = "https://www.saihduero.es"


def listar_duero() -> list[dict]:
    h = http(f"{DUERO}/datos-tiempo-real/risr").decode("utf-8", "replace")
    patron = re.compile(r"\{ id: '(EA\d+)', station: '([^']*)', river: '([^']*)', "
                        r"lat: ([\d.\-]+), lng: ([\d.\-]+),[^}]*q: '")
    res = {}
    for codigo, nombre, rio, lat, lon in patron.findall(h):
        res[codigo] = estacion("Duero", codigo, nombre.rsplit(",", 1)[0].strip(), rio,
                               float(lon), float(lat), f"{DUERO}/risr/{codigo}")
    return list(res.values())


def completar_duero(estaciones: list[dict]):
    """Añade la URL (fija) del histórico de caudal; se hace solo con las estaciones usadas
    porque cuesta una petición por estación."""
    def una(e):
        e["extra"]["url_historico"] = url_historico_duero(e)
    _en_paralelo(una, estaciones)


def url_historico_duero(e: dict) -> str:
    p = http(e["url_publica"], timeout=90).decode("utf-8", "replace")
    m = re.search(r"<td>Caudal</td>.*?href=\"(risr/" + re.escape(e["codigo"]) + r"/historico/[A-Za-z0-9]+)\"", p, re.S)
    if not m:
        raise ErrorFuente(f"La estación {e['codigo']} no publica caudal en el SAIH Duero.")
    return f"{DUERO}/{m.group(1)}"


def serie_duero(e: dict) -> tuple[list, str]:
    url = e["extra"].get("url_historico") or url_historico_duero(e)
    h = http(url, timeout=90).decode("utf-8", "replace")
    serie = [(datetime(int(a), int(mo), int(d), int(hh), int(mi)), float(v))
             for d, mo, a, hh, mi, v in re.findall(r'\{d:"(\d{2})/(\d{2})/(\d{4}) (\d{2}):(\d{2})", v:(-?[\d.]+)\}', h)]
    return serie, url


# --- Tajo: saihtajo.chtajo.es ------------------------------------------------------

TAJO = "https://saihtajo.chtajo.es"


def listar_tajo() -> list[dict]:
    aforos = json.loads(http(f"{TAJO}/search-aforosenrio"))["response"]["results"]
    urls = {r["id"]: r["url"] for r in json.loads(http(f"{TAJO}/search", {"search": ""}))["response"]["results"]}
    res = []

    def una(a):
        if a["id"] not in urls:
            return
        d = json.loads(http(f"{TAJO}/{urls[a['id']]}"))["response"]
        senal = next((s for s in d.get("senales", []) if "CAUDAL" in s.get("nombre", "").upper()
                      and s.get("unidad", "").startswith("m3")), None)
        if not senal or not d.get("utm"):
            return
        lon, lat = utm_a_lonlat(float(d["utm"]["x"]), float(d["utm"]["y"]), int(d["utm"].get("huso") or 30))
        res.append(estacion("Tajo", a["id"], d["nombre"].title(), rio_de(d["nombre"]).title(), lon, lat,
                            TAJO, url_grafico=f"{TAJO}/{senal['url']}", senal=senal["nombre"]))
    _en_paralelo(una, aforos)
    return res


def serie_tajo(e: dict) -> tuple[list, str]:
    url = e["extra"]["url_grafico"]  # gráfico de los últimos 10 días, un dato cada 15 min
    d = json.loads(http(url, timeout=90))["response"]
    serie = [(datetime.strptime(v["tiempo"], "%d/%m/%Y %H:%M"), float(v["valor"]))
             for v in d["senal"]["valores"] if v.get("valor") is not None]
    return serie, url


# --- Miño-Sil: saih.chminosil.es ---------------------------------------------------

MINOSIL = "https://saih.chminosil.es/index.php?url="
# Su web falla sin Accept-Language y necesita mantener la cookie de sesión
_CAB_MS = {"Accept-Language": "es-ES,es"}


_sesion_ms = {"opener": None, "desde": 0.0}
_sesion_ms_lock = threading.Lock()


def _opener_minosil():
    """Sesión con cookie que ya ha pasado por un mapa: sin eso, la web redirige al mapa
    en vez de mostrar fichas o datos. Se reutiliza 10 minutos."""
    with _sesion_ms_lock:
        if _sesion_ms["opener"] is None or time.time() - _sesion_ms["desde"] > 600:
            op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()),
                                             urllib.request.HTTPSHandler(context=_CTX))
            http(f"{MINOSIL}/datos/mapas/mapa:H1/area:HID/acc:0", cabeceras=_CAB_MS, opener=op)
            _sesion_ms.update(opener=op, desde=time.time())
        return _sesion_ms["opener"]


def listar_minosil() -> list[dict]:
    op = _opener_minosil()
    tags = {}
    for zona in range(1, 9):
        h = http(f"{MINOSIL}/datos/mapas/mapa:H{zona}/area:HID/acc:0", cabeceras=_CAB_MS, opener=op).decode("latin-1")
        for tag in re.findall(r"graficas/tag:([AN]\d{3}_ACQRIO\d)", h):
            tags.setdefault(tag[:4], tag)
    res = []

    def una(item):
        codigo, tag = item
        t = texto_html(http(f"{MINOSIL}/datos/ficha/estacion:{codigo}/area:HID", cabeceras=_CAB_MS,
                            opener=_opener_minosil()).decode("latin-1"))
        m = re.search(r"Huso X Y Z (\d+) ([\d.]+) ([\d.]+)", t)
        n = re.search(r"Nombre: (.+?) Río: (.+?) Municipio:", t)
        if not m or not n:
            return
        lon, lat = utm_a_lonlat(float(m.group(2)), float(m.group(3)), int(m.group(1)))
        res.append(estacion("Miño-Sil", codigo, n.group(1).title(), n.group(2).title(), lon, lat,
                            f"{MINOSIL}/datos/ficha/estacion:{codigo}/area:HID", tag=tag))
    _en_paralelo(una, list(tags.items()))
    return res


def serie_minosil(e: dict, semanas: int = 3) -> tuple[list, str]:
    """Cada página de 'datos numéricos' es una semana (historia:0 la actual, 1 la anterior...)."""
    op = _opener_minosil()
    tag = e["extra"]["tag"]
    puntos = {}
    for k in range(semanas):
        url = f"{MINOSIL}/datos/graficas_numeros/tag:{tag}/historia:{k}"
        t = texto_html(http(url, datos=b"", cabeceras=_CAB_MS, opener=op, timeout=90).decode("latin-1"))
        for f, v in re.findall(r"(\d{2}/\d{2}/\d{4} \d{2}:\d{2}) (-?[\d.,]+)", t):
            puntos[datetime.strptime(f, "%d/%m/%Y %H:%M")] = num(v)
    return sorted(puntos.items()), f"{MINOSIL}/datos/graficas/tag:{tag}"


# --- Cantábrico: visor.saichcantabrico.es ----------------------------------------------

CANTABRICO = "https://visor.saichcantabrico.es/wp-admin/admin-ajax.php"
_CAB_CANT = {"Referer": "https://visor.saichcantabrico.es/descarga-de-historicos/"}


def _json_wp(datos: dict) -> dict:
    # WordPress antepone líneas en blanco a la respuesta
    return json.loads(http(CANTABRICO, datos, _CAB_CANT).decode("utf-8", "replace").strip())


def listar_cantabrico() -> list[dict]:
    d = _cincominutal_cantabrico()
    res = []
    for f in d["data"]["features"]:
        p = f["properties"]
        if "caudal" not in (p.get("parametros_medidos") or "") or not p.get("Cod_Roea"):
            continue
        res.append(estacion("Cantábrico", p["Cod_Roea"], p["nombre"], p.get("rio") or "",
                            float(p["lon"]), float(p["lat"]), "https://visor.saichcantabrico.es/",
                            cod_roea=p["Cod_Roea"]))
    return res


def serie_cantabrico(e: dict, dias: int = 35) -> tuple[list, str]:
    """Descarga de históricos: caudal horario medio (parámetro 3, frecuencia 2, tipo 4), en UTC."""
    hoy = date.today()
    datos = {"action": "ddh_descargar_historico", "cod_roea": e["extra"]["cod_roea"],
             "id_frecuencia": 2, "id_parametro": 3, "tipo_dato": 4,
             "fechaInicio": (hoy - timedelta(days=dias)).isoformat(),
             "fechaFin": (hoy + timedelta(days=1)).isoformat(), "tipoArchivo": "csv"}
    texto = http(CANTABRICO, datos, _CAB_CANT, timeout=90).decode("utf-8", "replace").strip()
    if texto.startswith("{"):
        raise ErrorFuente(f"SAI Cantábrico: {json.loads(texto).get('data')}")
    serie = []
    for fila in csv.reader(io.StringIO(texto), delimiter=";"):
        if len(fila) >= 2 and re.match(r"\d{4}-\d{2}-\d{2}", fila[1]):
            serie.append((utc_a_peninsular(datetime.strptime(fila[1][:16], "%Y-%m-%d %H:%M")), num(fila[0])))
    # El histórico horario llega con horas de retraso: se añade el último dato cincominutal
    try:
        actual = next(f["properties"] for f in _cincominutal_cantabrico()["data"]["features"]
                      if f["properties"].get("Cod_Roea") == e["extra"]["cod_roea"])
        if actual.get("caudal") is not None and actual.get("fecha_caudal"):
            t = datetime.strptime(actual["fecha_caudal"][:16], "%Y-%m-%d %H:%M")
            if not serie or t > serie[-1][0]:
                serie.append((t, float(actual["caudal"])))
    except (ErrorFuente, StopIteration, ValueError, KeyError):
        pass
    return serie, "https://visor.saichcantabrico.es/descarga-de-historicos/"


_cinco_cache = {"datos": None, "desde": 0.0}


def _cincominutal_cantabrico() -> dict:
    if _cinco_cache["datos"] is None or time.time() - _cinco_cache["desde"] > 300:
        _cinco_cache.update(datos=_json_wp({"action": "peticion_cincominutal", "tipo": "todas"}), desde=time.time())
    return _cinco_cache["datos"]


# --- Ebro: www.saihebro.com ----------------------------------------------------------

EBRO = "https://www.saihebro.com"


def _zonas_ebro() -> list[str]:
    h = http(f"{EBRO}/tiempo-real/mapa-aforos-HG-toda-la-cuenca").decode("utf-8", "replace")
    return sorted(set(re.findall(r"mapa-aforos-(?:H\d+|ST\d+)-[a-z0-9-]+", h)))


def _datos_zona_ebro(slug: str) -> tuple[dict, list[dict]]:
    """Devuelve ({codigo: datos de la estación}, [señales de caudal con su valor actual])."""
    d = json.loads(http(f"{EBRO}/api/mapa/getDatosMapa?slug={slug}"))
    remotas = {x["CW_REMOTA_TXT"]: x for x in d.get("DATOS", [])}
    caudales = []
    for a in re.findall(r"<a [^>]*>", d.get("TABLA", "")):
        etiqueta = re.search(r"aria-label='Gráfica señal \d+, (CAUDAL [^']*?), Valor actual (-?[\d.,]+) m³/s, "
                             r"Fecha valor ([\d\- :]+)'", a)
        tag = re.search(r"grafica-senal-([A-Z0-9]+)-", a)
        if etiqueta and tag:
            caudales.append({"tag": tag.group(1), "descripcion": etiqueta.group(1),
                             "valor": num(etiqueta.group(2)), "fecha": etiqueta.group(3).strip()})
    paginas = dict(re.findall(r"href='(/tiempo-real/estacion-aforos-([A-Z0-9]+)-[^']*)'", d.get("TABLA", "")))
    for x in remotas.values():
        x["_pagina"] = next((p for p, c in paginas.items() if c == x["CW_REMOTA_TXT"]), None)
    return remotas, caudales


def listar_ebro() -> list[dict]:
    res = {}
    for slug in _zonas_ebro():
        remotas, caudales = _datos_zona_ebro(slug)
        for c in caudales:
            codigo = c["tag"][:4]
            r = remotas.get(codigo)
            if codigo in res or not r or not r.get("LR_UTM_X"):
                continue
            lon, lat = utm_a_lonlat(float(r["LR_UTM_X"]), float(r["LR_UTM_Y"]), 30)
            nombre = re.sub(r"^CAUDAL\s+", "", c["descripcion"]).title()
            res[codigo] = estacion("Ebro", codigo, nombre, rio_de(nombre).title(), lon, lat,
                                   EBRO + (r["_pagina"] or "/tiempo-real/mapa-aforos-HG-toda-la-cuenca"),
                                   tag=c["tag"], zona=slug)
    return list(res.values())


def serie_ebro(e: dict) -> tuple[list, str]:
    """Con clave de la API de datos abiertos del SAIH Ebro, histórico; sin ella, solo el valor actual."""
    clave = leer_config().get("ebro_apikey", "").strip()
    tag = e["extra"]["tag"]
    if clave:
        inicio = (datetime.now() - timedelta(days=35)).strftime("%d/%m/%Y")
        url = f"{EBRO}/datos/apiopendata?senal={tag}&inicio={urllib.parse.quote(inicio)}&apikey={clave}"
        serie = _leer_api_ebro(http(url, timeout=90).decode("utf-8", "replace"))
        if serie:
            return serie, f"{EBRO}/datos/apiopendata?senal={tag}"
    _, caudales = _datos_zona_ebro(e["extra"]["zona"])
    c = next((c for c in caudales if c["tag"] == tag), None)
    if not c:
        raise ErrorFuente(f"El SAIH Ebro no publica ahora el caudal de {e['nombre']}.")
    return [(datetime.strptime(c["fecha"][:16], "%Y-%m-%d %H:%M"), c["valor"])], e["url_publica"]


def _leer_api_ebro(texto: str) -> list:
    """La respuesta de la API del Ebro no está documentada públicamente: se buscan pares
    fecha/valor en el JSON devuelto, sea cual sea su anidamiento."""
    try:
        datos = json.loads(texto)
    except ValueError:
        return []
    serie = []

    def recorrer(x):
        if isinstance(x, dict):
            claves = {k.lower(): v for k, v in x.items()}
            f = next((claves[k] for k in claves if "fecha" in k or k in ("time", "date", "tiempo")), None)
            v = next((claves[k] for k in claves if "valor" in k or k in ("value", "v")), None)
            if f is not None and v is not None:
                try:
                    serie.append((_fecha_flexible(str(f)), float(str(v).replace(",", "."))))
                    return
                except ValueError:
                    pass
            for y in x.values():
                recorrer(y)
        elif isinstance(x, list):
            for y in x:
                recorrer(y)
    recorrer(datos)
    return sorted(serie)


def _fecha_flexible(s: str) -> datetime:
    for formato in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(s[:19], formato)
        except ValueError:
            continue
    raise ValueError(s)


# --- común ------------------------------------------------------------------------

LISTAR = {"Duero": listar_duero, "Tajo": listar_tajo, "Miño-Sil": listar_minosil,
          "Cantábrico": listar_cantabrico, "Ebro": listar_ebro}
SERIE = {"Duero": serie_duero, "Tajo": serie_tajo, "Miño-Sil": serie_minosil,
         "Cantábrico": serie_cantabrico, "Ebro": serie_ebro}


def serie(e: dict) -> tuple[list, str]:
    """Serie de caudal de cualquier estación: ([(datetime, m³/s)], url de origen)."""
    try:
        puntos, url = SERIE[e["cuenca"]](e)
    except (KeyError, ValueError, IndexError) as err:
        raise ErrorFuente(f"{CUENCAS[e['cuenca']]['saih']}: formato de datos inesperado ({err}).") from err
    if not puntos:
        raise ErrorFuente(f"{CUENCAS[e['cuenca']]['saih']} no tiene datos recientes de {e['nombre']}.")
    return sorted(puntos), url


def _en_paralelo(funcion, elementos, hilos: int = 4):
    with ThreadPoolExecutor(max_workers=hilos) as pool:
        for fut in [pool.submit(funcion, x) for x in elementos]:
            try:
                fut.result()
            except ErrorFuente as err:
                print(f"  Aviso: {err}")
