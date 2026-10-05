"""Función serverless de Vercel para las rutas /api/* de TiempoPesca.

Reutiliza la misma lógica que el servidor local (programa/app/server.py): aquí solo
se enrutan las peticiones de la API; los archivos estáticos los sirve el CDN de Vercel
(ver vercel.json). A diferencia del servidor local, no hay precarga en segundo plano:
cada caudal se pide bajo demanda y la caché solo vive mientras la función está caliente.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlparse

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ / "programa" / "app"))

import server  # carga los datos y expone responder_api (no arranca ningún servidor)


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        url = urlparse(self.path)
        respuesta = server.responder_api(url.path, parse_qs(url.query))
        if respuesta is None:
            respuesta = (404, json.dumps({"error": f"Ruta desconocida: {url.path}"}, ensure_ascii=False))
        codigo, cuerpo = respuesta
        datos = cuerpo.encode("utf-8") if isinstance(cuerpo, str) else cuerpo
        self.send_response(codigo)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(datos)))
        self.end_headers()
        self.wfile.write(datos)

    def log_message(self, *args):
        pass
