"""Acceso a las fuentes externas: Open-Meteo (tiempo) y las confederaciones (caudal, vía cuencas.py)."""
import json
import threading
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta

import cuencas
from cuencas import ErrorFuente

USER_AGENT = "TiempoPesca/1.0 (uso personal)"

OPEN_METEO_FORECAST = "https://api.open-meteo.com/v1/forecast"
OPEN_METEO_ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"

# Límites de la API de previsión de Open-Meteo (días respecto a hoy)
PREVISION_DIAS_ATRAS = 90
PREVISION_DIAS_ADELANTE = 15

VARIABLES_HORARIAS = [
    "temperature_2m", "precipitation", "precipitation_probability",
    "wind_speed_10m", "wind_gusts_10m", "wind_direction_10m",
    "cloud_cover", "weather_code",
]


# --- caché en memoria ------------------------------------------------------

_cache: dict[str, tuple[float, object]] = {}
_cache_lock = threading.Lock()
_cargando: dict[str, threading.Lock] = {}   # un candado por clave: evita peticiones duplicadas
_refrescando: set[str] = set()


def _cargar(clave: str, funcion):
    inicio = time.time()
    with _cache_lock:
        candado = _cargando.setdefault(clave, threading.Lock())
    with candado:
        # Otro hilo puede haberlo cargado mientras esperábamos el candado
        with _cache_lock:
            hit = _cache.get(clave)
        if hit and hit[0] >= inicio:
            return hit[1]
        valor = funcion()
        with _cache_lock:
            _cache[clave] = (time.time(), valor)
        return valor


def _refrescar_en_segundo_plano(clave: str, funcion):
    with _cache_lock:
        if clave in _refrescando:
            return
        _refrescando.add(clave)

    def tarea():
        try:
            _cargar(clave, funcion)
        except ErrorFuente:
            pass  # se sigue sirviendo el dato anterior
        finally:
            with _cache_lock:
                _refrescando.discard(clave)

    threading.Thread(target=tarea, daemon=True).start()


def cacheado(clave: str, ttl: int, funcion, servir_caducado: bool = False):
    """Devuelve el valor cacheado si tiene menos de `ttl` segundos; si no, lo carga.

    Con `servir_caducado`, un valor caducado se devuelve al momento y se
    actualiza en segundo plano (útil para fuentes lentas como el SAIH).
    """
    with _cache_lock:
        hit = _cache.get(clave)
    if hit:
        if time.time() - hit[0] < ttl:
            return hit[1]
        if servir_caducado:
            _refrescar_en_segundo_plano(clave, funcion)
            return hit[1]
    return _cargar(clave, funcion)


REINTENTOS = 3                       # para errores temporales (sobrecarga, 5xx)
CODIGOS_TEMPORALES = {429, 500, 502, 503, 504}


def http_get(url: str, timeout: int = 30) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for intento in range(REINTENTOS):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in CODIGOS_TEMPORALES and intento < REINTENTOS - 1:
                time.sleep(1.5 * (intento + 1))
                continue
            cuerpo = e.read().decode("utf-8", "replace")[:300]
            raise ErrorFuente(f"HTTP {e.code} en {url.split('?')[0]}: {cuerpo}") from e
        except (urllib.error.URLError, TimeoutError) as e:
            raise ErrorFuente(f"No se pudo conectar con {url.split('?')[0]}: {e}") from e
    raise AssertionError("inalcanzable")


# --- Open-Meteo ------------------------------------------------------------

def _open_meteo(lat: float, lon: float, desde: date, hasta: date, horario: bool) -> tuple[dict, dict]:
    """Devuelve (datos, fuente) donde fuente describe la API y la URL consultadas."""
    hoy = date.today()
    archivo = desde < hoy - timedelta(days=PREVISION_DIAS_ATRAS)
    params = {
        "latitude": lat,
        "longitude": lon,
        "timezone": "Europe/Madrid",
        "start_date": desde.isoformat(),
        "end_date": hasta.isoformat(),
        "wind_speed_unit": "kmh",
    }
    if horario:
        variables = VARIABLES_HORARIAS
        if archivo:  # el archivo no tiene probabilidad de precipitación
            variables = [v for v in variables if v != "precipitation_probability"]
        params["hourly"] = ",".join(variables)
        params["daily"] = "sunrise,sunset"
    else:
        params["daily"] = "precipitation_sum,temperature_2m_max,temperature_2m_min"
    url = (OPEN_METEO_ARCHIVE if archivo else OPEN_METEO_FORECAST) + "?" + urllib.parse.urlencode(params)
    datos = json.loads(http_get(url))
    if datos.get("error"):
        raise ErrorFuente(f"Open-Meteo: {datos.get('reason')}")
    fuente = {
        "api": "archivo" if archivo else "prevision",
        "url": url,
        "celda_lat": datos.get("latitude"),
        "celda_lon": datos.get("longitude"),
        "elevacion": datos.get("elevation"),
    }
    return datos, fuente


def meteo_dia(lat: float, lon: float, dia: date) -> dict:
    """Tiempo por horas del día indicado + lluvia de los 7 días previos."""
    hoy = date.today()
    if dia > hoy + timedelta(days=PREVISION_DIAS_ADELANTE):
        raise ErrorFuente(
            f"Solo hay previsión hasta {PREVISION_DIAS_ADELANTE} días vista "
            f"({(hoy + timedelta(days=PREVISION_DIAS_ADELANTE)).isoformat()})."
        )
    ttl = 1800 if dia >= hoy - timedelta(days=1) else 86400
    clave = f"meteo:{lat}:{lon}:{dia}"

    def cargar():
        horas, fuente = _open_meteo(lat, lon, dia, dia, horario=True)
        previos_ini = dia - timedelta(days=7)
        diario, fuente_previos = _open_meteo(lat, lon, previos_ini, dia - timedelta(days=1), horario=False)
        fuente["url_previos"] = fuente_previos["url"]
        fuente["consultado"] = datetime.now().strftime("%Y-%m-%dT%H:%M")
        sol = {"amanecer": horas["daily"]["sunrise"][0], "anochecer": horas["daily"]["sunset"][0]}
        return {"horas": horas["hourly"], "sol": sol, "dias_previos": diario["daily"], "fuente": fuente}

    datos = cacheado(clave, ttl, cargar)
    h = datos["horas"]
    viento = [v for v in h["wind_speed_10m"] if v is not None]
    rachas = [v for v in h["wind_gusts_10m"] if v is not None]
    temps = [v for v in h["temperature_2m"] if v is not None]
    lluvia = [v for v in h["precipitation"] if v is not None]
    prob = [v for v in h.get("precipitation_probability", []) if v is not None]
    resumen = {
        "temp_min": min(temps) if temps else None,
        "temp_max": max(temps) if temps else None,
        "lluvia_mm": round(sum(lluvia), 1) if lluvia else None,
        "prob_lluvia_max": max(prob) if prob else None,
        "viento_medio": round(sum(viento) / len(viento), 1) if viento else None,
        "viento_max": max(viento) if viento else None,
        "racha_max": max(rachas) if rachas else None,
    }
    previos = datos["dias_previos"]
    lluvia_previa = sum(v for v in previos["precipitation_sum"] if v is not None)
    return {
        "horas": h,
        "resumen": resumen,
        "dias_previos": previos,
        "lluvia_7d_previos_mm": round(lluvia_previa, 1),
        "sol": datos["sol"],
        "fuente": datos["fuente"],
    }


# --- Caudal (todas las confederaciones) -------------------------------------

def serie_caudal(estacion: dict) -> dict:
    """Serie de caudal (m³/s) de la estación y la URL de origen, cacheada 30 minutos.

    Si el dato tiene más de 30 minutos se sirve igualmente y se actualiza en segundo
    plano: algunas webs (el SAIH Duero, Miño-Sil) tardan 20 s o más en responder.
    """
    def cargar():
        serie, url = cuencas.serie(estacion)
        return {"serie": serie, "url_datos": url, "consultado": datetime.now().strftime("%Y-%m-%dT%H:%M")}

    return cacheado(f"caudal:{estacion['id']}", 1800, cargar, servir_caducado=True)


def caudal_semana(estacion: dict, dia: date) -> dict:
    """Caudal de la semana que termina en `dia`; si `dia` es futuro, últimos 7 días."""
    datos = serie_caudal(estacion)
    serie = datos["serie"]
    fuente = {
        "url_estacion": estacion["url_publica"],
        "url_datos": datos["url_datos"],
        "historico_desde": serie[0][0].strftime("%Y-%m-%dT%H:%M"),
        "historico_hasta": serie[-1][0].strftime("%Y-%m-%dT%H:%M"),
        "consultado": datos["consultado"],
        # Ebro sin clave de su API: solo se conoce el valor actual
        "solo_actual": len(serie) == 1,
    }
    hoy = date.today()
    if dia >= hoy:
        fin = serie[-1][0]
        nota = ("Fecha futura: no existe previsión de caudal, se muestran los últimos 7 días."
                if dia > hoy else "Últimos 7 días hasta la lectura más reciente.")
    else:
        fin = datetime.combine(dia, datetime.max.time())
        nota = "Semana que termina el día seleccionado."
    ini = fin - timedelta(days=7)
    puntos = [(t, v) for t, v in serie if ini <= t <= fin]
    if not puntos:
        disponible = serie[0][0].date().isoformat()
        return {"puntos": [], "nota": f"La confederación solo publica datos desde {disponible}.", "fuente": fuente}

    valores = [v for _, v in puntos]
    ultimo_t, ultimo_v = puntos[-1]
    # Tendencia: media de las últimas 24 h frente a las 24 h anteriores
    ult24 = [v for t, v in puntos if t > ultimo_t - timedelta(hours=24)]
    prev24 = [v for t, v in puntos if ultimo_t - timedelta(hours=48) < t <= ultimo_t - timedelta(hours=24)]
    tendencia = None
    if ult24 and prev24:
        m1, m0 = sum(ult24) / len(ult24), sum(prev24) / len(prev24)
        cambio = (m1 - m0) / m0 if m0 else 0
        tendencia = "subiendo" if cambio > 0.1 else "bajando" if cambio < -0.1 else "estable"

    # Estado: el caudal de referencia (último dato, o media de la semana si es pasada)
    # comparado con la mediana de todo el histórico disponible (de 10 a 35 días según la fuente)
    todos = sorted(v for _, v in serie)
    mediana = todos[len(todos) // 2]
    referencia = ultimo_v if dia >= hoy else sum(valores) / len(valores)
    relacion = referencia / mediana if mediana and len(serie) > 24 else None
    if relacion is None:
        estado = None
    elif relacion > 1.5:
        estado = "alto"
    elif relacion < 0.6:
        estado = "bajo"
    else:
        estado = "normal"
    return {
        "puntos": [[t.strftime("%Y-%m-%dT%H:%M"), v] for t, v in puntos],
        "ultimo": {"fecha": ultimo_t.strftime("%Y-%m-%dT%H:%M"), "valor": ultimo_v},
        "media": round(sum(valores) / len(valores), 2),
        "min": min(valores),
        "max": max(valores),
        "tendencia": tendencia,
        "mediana_historico": round(mediana, 2),
        "estado": estado,
        "nota": nota,
        "fuente": fuente,
    }
