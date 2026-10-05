#!/usr/bin/env python3
"""Servidor local de TiempoPesca.

Uso: python3 programa/app/server.py [puerto] [--abrir]   ->  http://localhost:8000

--abrir  abre el navegador al arrancar (lo usan los lanzadores).
Si el puerto está ocupado, prueba con los siguientes.
"""
import sys

if sys.version_info < (3, 10):
    sys.exit("TiempoPesca necesita Python 3.10 o superior. Descárgalo en https://www.python.org/downloads/")

import errno
import json
import os
import threading
import time
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

# Todas las fechas ("hoy", caché, pasado/futuro) van en hora peninsular. En servidores
# como Vercel el reloj es UTC; aquí se fija a Europe/Madrid. (En Windows no hay tzset: se
# ignora y se usa la hora del sistema, que ya es la local del usuario.)
os.environ["TZ"] = "Europe/Madrid"
if hasattr(time, "tzset"):
    time.tzset()

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fuentes  # noqa: E402

RAIZ = Path(__file__).resolve().parent.parent
WEB_DIR = RAIZ / "web"
DATA_DIR = RAIZ / "data"

_GEO = json.loads((DATA_DIR / "tramos.geojson").read_text(encoding="utf-8"))
TRAMOS = {f["properties"]["id"]: f["properties"] for f in _GEO["features"]}
ESTACIONES = {e["id"]: e for e in json.loads((DATA_DIR / "estaciones.json").read_text(encoding="utf-8"))}

# Lista ligera para los menús (sin geometría) y trazados agrupados por provincia para el mapa
TRAMOS_JSON = json.dumps({"metadata": _GEO["metadata"], "tramos": list(TRAMOS.values())}, ensure_ascii=False)
_por_provincia: dict[str, list] = {}
for _f in _GEO["features"]:
    _por_provincia.setdefault(_f["properties"]["provincia"], []).append(
        {"type": "Feature", "properties": {"id": _f["properties"]["id"]}, "geometry": _f["geometry"]})
GEOMETRIAS = {prov: json.dumps({"type": "FeatureCollection", "features": fs})
              for prov, fs in _por_provincia.items()}
# Todas juntas, para el mapa de elegir tramo
GEOMETRIAS[""] = json.dumps({"type": "FeatureCollection",
                             "features": [f for fs in _por_provincia.values() for f in fs]})
del _GEO, _por_provincia

# El tiempo (Open-Meteo, rápido) y el caudal (las confederaciones, a veces muy lentas) se
# piden por separado para que la web muestre cada cosa en cuanto llega.

def consulta_meteo(tramo: dict, dia: date, q: dict) -> dict:
    """Tiempo en el punto medio del tramo o, si se pide `punto=N`, junto al pueblo N del tramo."""
    puntos = tramo.get("puntos") or []
    try:
        n = int(q.get("punto", [""])[0])
    except ValueError:
        n = None
    if n is not None and 0 <= n < len(puntos):
        punto = puntos[n]
        return {"meteo": fuentes.meteo_dia(punto["lat"], punto["lon"], dia), "punto": n}
    return {"meteo": fuentes.meteo_dia(tramo["lat"], tramo["lon"], dia), "punto": None}


def consulta_caudal(tramo: dict, dia: date, q: dict) -> dict:
    estacion = ESTACIONES.get(tramo["estacion"])
    if not estacion:
        raise fuentes.ErrorFuente("Este tramo no tiene estación de aforo asignada.")
    caudal = fuentes.caudal_semana(estacion, dia)
    return {"estacion": estacion, "caudal": caudal}


CONSULTAS = {"/api/meteo": consulta_meteo, "/api/caudal": consulta_caudal}


def responder_api(ruta: str, query: dict) -> tuple[int, str] | None:
    """Resuelve una ruta /api/*. Devuelve (código, cuerpo JSON) o None si no es una ruta de API.

    La usan tanto el servidor local (Handler) como la función serverless de Vercel.
    """
    if ruta == "/api/tramos":
        return 200, TRAMOS_JSON
    if ruta == "/api/geometria":
        provincia = query.get("provincia", [""])[0]
        if provincia not in GEOMETRIAS:
            return 404, json.dumps({"error": f"Provincia desconocida: {provincia}"}, ensure_ascii=False)
        return 200, GEOMETRIAS[provincia]
    if ruta == "/api/estaciones":
        return 200, json.dumps(list(ESTACIONES.values()), ensure_ascii=False)
    if ruta in CONSULTAS:
        try:
            id_tramo = query["tramo"][0]
            dia = date.fromisoformat(query["fecha"][0])
        except (KeyError, ValueError):
            return 400, json.dumps({"error": "Parámetros: tramo=ID&fecha=AAAA-MM-DD"})
        tramo = TRAMOS.get(id_tramo)
        if not tramo:
            return 404, json.dumps({"error": f"Tramo desconocido: {id_tramo}"}, ensure_ascii=False)
        try:
            resultado = CONSULTAS[ruta](tramo, dia, query)
        except fuentes.ErrorFuente as e:
            return 502, json.dumps({"error": str(e)}, ensure_ascii=False)
        return 200, json.dumps(resultado, ensure_ascii=False)
    return None


def precargar_caudales():
    """Descarga en segundo plano el caudal de todas las estaciones al arrancar."""
    def una(e):
        try:
            fuentes.serie_caudal(e)
            return True
        except fuentes.ErrorFuente as err:
            print(f"  Aviso: sin caudal para {e['id']} ({err})")
            return False

    def tarea():
        inicio = time.time()
        with ThreadPoolExecutor(max_workers=4) as pool:  # sin saturar a las confederaciones
            ok = sum(pool.map(una, ESTACIONES.values()))
        print(f"Caudales precargados: {ok}/{len(ESTACIONES)} estaciones en {time.time() - inicio:.0f} s")

    threading.Thread(target=tarea, daemon=True).start()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def _json(self, codigo: int, cuerpo: str | bytes):
        datos = cuerpo.encode("utf-8") if isinstance(cuerpo, str) else cuerpo
        self.send_response(codigo)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(datos)))
        self.end_headers()
        self.wfile.write(datos)

    def do_GET(self):
        url = urlparse(self.path)
        respuesta = responder_api(url.path, parse_qs(url.query))
        if respuesta is not None:
            return self._json(*respuesta)
        return super().do_GET()

    def log_message(self, fmt, *args):
        if "/api/" in self.path:
            super().log_message(fmt, *args)


class Servidor(ThreadingHTTPServer):
    # En Windows, SO_REUSEADDR permite abrir un puerto ya ocupado; ahí se desactiva
    # para que un segundo arranque use otro puerto en vez de chocar con el primero.
    allow_reuse_address = sys.platform != "win32"
    daemon_threads = True


def crear_servidor(puerto: int, intentos: int = 20) -> ThreadingHTTPServer:
    for p in range(puerto, puerto + intentos):
        try:
            return Servidor(("127.0.0.1", p), Handler)
        except OSError as e:
            if e.errno not in (errno.EADDRINUSE, getattr(errno, "WSAEADDRINUSE", -1), 10048):
                raise
    sys.exit(f"No hay ningún puerto libre entre {puerto} y {puerto + intentos - 1}.")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    abrir = "--abrir" in sys.argv
    servidor = crear_servidor(int(args[0]) if args else 8000)
    url = f"http://localhost:{servidor.server_address[1]}"
    print(f"TiempoPesca funcionando en {url}  ({len(TRAMOS)} tramos)")
    print("Para apagarlo, cierra esta ventana o pulsa Ctrl+C.")
    print(f"Precargando caudales de {len(ESTACIONES)} estaciones de aforo en segundo plano (puede tardar)...")
    precargar_caudales()
    if abrir:
        webbrowser.open(url)
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
