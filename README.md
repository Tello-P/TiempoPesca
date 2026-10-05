# TiempoPesca

Web local para consultar el tiempo y el caudal en los tramos de pesca de los ríos
**Carrión, Esla, Arlanzón y Cea** (Castilla y León).

Eliges un tramo (en la lista o en el mapa) y un día, y muestra:

- **Viento por horas**: velocidad, rachas y dirección.
- **Temperatura y lluvia por horas**, y la lluvia acumulada en los 7 días previos.
- **Caudal** de la estación de aforo asignada al tramo: la semana que termina en ese día o,
  si el día es futuro, los últimos 7 días con su tendencia.
- **Normativa del tramo**: límites, periodo hábil, cebos, cupo y enlace a la ficha oficial.

## Cómo usarlo

Solo hace falta **Python 3.10 o superior**; no hay que instalar nada más. Hace falta conexión a internet para
descargar el tiempo, el caudal y el mapa.

1. Descarga el proyecto: botón verde **Code → Download ZIP** en GitHub, y descomprímelo.
2. Abre la carpeta y haz **doble clic** en el lanzador de tu sistema:

| Sistema | Lanzador | Si no tienes Python |
|---|---|---|
| Windows | `Iniciar-Windows.bat` | Instálalo desde [python.org](https://www.python.org/downloads/) marcando **«Add python.exe to PATH»**. El lanzador abre la página de descarga si no lo encuentra. |
| Linux | `Iniciar-Linux.sh` | Suele venir instalado. Si no: `sudo apt install python3` (o el equivalente de tu distribución). |

Se abre una ventana con el servidor y el navegador con la web. **Para apagarla, cierra esa ventana.**

En Linux, si al hacer doble clic se abre el archivo en un editor, haz clic derecho → *Ejecutar como programa*
o lánzalo desde una terminal con `./Iniciar-Linux.sh`. En Windows, si aparece el aviso de SmartScreen,
pulsa *Más información → Ejecutar de todas formas*.

Si el puerto 8000 está ocupado, se usa el siguiente libre. Las consultas se pueden enlazar:
`http://localhost:8000/#tramo=P-7&fecha=2026-10-06`.

### Estructura

```
TiempoPesca/
├── Iniciar-Windows.bat     ← doble clic en Windows
├── Iniciar-Linux.sh        ← doble clic en Linux
├── README.md
└── programa/
    ├── app/                servidor local (Python, sin dependencias)
    ├── web/                interfaz: mapa, gráficas y página «¿Cómo funciona?»
    ├── data/               tramos, estaciones y pueblos ya descargados
    └── scripts/            script para regenerar los datos
```

Para arrancarlo a mano: `python3 programa/app/server.py [puerto] [--abrir]`.

## Fuentes de datos

| Dato | Fuente | Notas |
|---|---|---|
| Tramos | [IDECyL – Pesca CyL: tramos de pesca](https://idecyl.jcyl.es/geonetwork/srv/api/records/SPAGOBCYLMNADTSAMPZP) (WFS) | Capa oficial con geometría y normativa |
| Caudal | [SAIH Duero](https://www.saihduero.es/datos-tiempo-real/risr) | Histórico horario de unos 35 días |
| Tiempo | [Open-Meteo](https://open-meteo.com) | Previsión a 15 días; archivo para fechas antiguas |
| Pueblo de referencia | IDECyL – Núcleos de población (WFS) | Pueblo habitado más cercano al punto de previsión |

El tiempo se pide para las **coordenadas del punto medio de cada tramo**. Como referencia, se indica el
**pueblo más cercano** a ese punto, sacado de la capa oficial de núcleos de población de la Junta (IDECyL).

En la propia web, cada bloque de resultados lleva un recuadro **«Fuente»** con enlaces a los datos originales
de esa consulta: la URL de Open-Meteo, la celda y su altitud, y la página e histórico de la estación del SAIH.
Además, la página **«¿Cómo funciona?»** (`programa/web/como-funciona.html`) explica cada dato y lista la estación
asignada a cada tramo.

## Regenerar los datos de tramos

La normativa cambia cada temporada. Para descargar de nuevo los tramos y las estaciones:

```bash
python3 programa/scripts/build_data.py
```

El script asigna a cada tramo la estación de aforo **del mismo río** más cercana y muestra la
lista para revisarla. Si alguna asignación no convence (por ejemplo, por un afluente o una presa
entre el tramo y la estación), se corrige en `OVERRIDES_ESTACION` dentro del script.

Para añadir ríos, basta con ampliar `RIOS` en `programa/scripts/build_data.py` y en `COLORES_RIO` en `programa/web/app.js`.

## Limitaciones

- No existe previsión pública de caudal: para días futuros se muestran los últimos 7 días.
- El SAIH solo publica unos 35 días de histórico, así que en fechas más antiguas no hay caudal.
- En tramos muy largos, como embalses, el tiempo del punto medio puede no representar todo el tramo.
- Consulta siempre la normativa oficial antes de pescar.
