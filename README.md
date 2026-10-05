# TiempoPesca

Web local para consultar el tiempo y el caudal en **todos los tramos de pesca de Castilla y León**
(los 2.354 tramos de la capa oficial de la Junta: trucheros, no trucheros y vedados).

Pensada para que la use cualquiera, en tres pasos:

1. **¿Dónde vas a pescar?** Pulsas el río en el mapa de tramos, o lo buscas por río, pueblo o nombre,
   o eliges provincia y río. Tus últimos tramos quedan a mano para volver a ellos.
2. **¿Qué día?** Botones grandes: Hoy, Mañana, Miércoles…
3. **De un vistazo:** un resumen con colores (verde, ámbar, rojo) del cielo, el viento, la lluvia,
   la temperatura, el estado del río y las normas. Debajo, todos los detalles:

- **Viento por horas**: velocidad, rachas y dirección.
- **Temperatura y lluvia por horas**, y la lluvia acumulada en los 7 días previos.
- **Caudal** de la estación de aforo asignada al tramo: la semana que termina en ese día o,
  si el día es futuro, los últimos 7 días con su tendencia.
- **Si ese día se puede pescar** en el tramo (temporada, día hábil, sin muerte o con muerte, festivos).
- **Normativa completa**, como en la ficha oficial: periodos y días hábiles, permisos, tallas y cupos de todas las especies,
  cebos, cañas, aparatos de flotación, cangrejo y zonas de carpa y black-bass.
- **Mapa** del tramo con el pueblo de referencia y la estación de aforo.

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
| Caudal | [SAIH Duero](https://www.saihduero.es), [SAIH Tajo](https://saihtajo.chtajo.es), [SAIH Miño-Sil](https://saih.chminosil.es), [SAI Cantábrico](https://visor.saichcantabrico.es), [SAIH Ebro](https://www.saihebro.com) | De 10 a 35 días de histórico según la confederación. El Ebro, solo el dato actual salvo que se configure su clave |
| Tiempo | [Open-Meteo](https://open-meteo.com) | Previsión a 15 días; archivo para fechas antiguas |
| Pueblo de referencia | IDECyL – Núcleos de población (WFS) | Pueblo habitado más cercano al punto de previsión |

El tiempo se pide para las **coordenadas del punto medio de cada tramo**. Como referencia, se indica el
**pueblo más cercano** a ese punto, sacado de la capa oficial de núcleos de población de la Junta (IDECyL).

En la propia web, cada bloque de resultados lleva un recuadro **«Fuente»** con enlaces a los datos originales
de esa consulta: la URL de Open-Meteo, la celda y su altitud, y la página y los datos originales de la estación de aforo.
Además, la página **«¿Cómo funciona?»** (`programa/web/como-funciona.html`) explica cada dato y lista la estación
asignada a cada tramo.

## Regenerar los datos de tramos

La normativa cambia cada temporada. Para descargar de nuevo los tramos y las estaciones:

```bash
python3 programa/scripts/build_data.py
```

Tarda unos minutos. A cada tramo de la cuenca del Duero le asigna una estación de aforo:

1. la **del mismo río** más cercana (máximo 50 km);
2. si no hay, la del **río principal de su subcuenca** (máximo 30 km), marcada como aproximada;
3. si tampoco, o es una laguna o un canal, se queda sin caudal.

El resultado queda en `programa/data/asignaciones.tsv` para revisarlo. Si alguna asignación no convence
(por ejemplo, por un afluente o una presa entre el tramo y la estación), se corrige en `OVERRIDES_ESTACION`
dentro del script.

La capa oficial repite algún código de tramo en tramos distintos; internamente cada tramo tiene un `id`
único (el código, más una letra a partir de la segunda aparición: `BU-AAL-124-b`).

## Histórico del Ebro (opcional)

El SAIH Ebro solo da el histórico de caudal a usuarios registrados (es gratis):

1. Regístrate en <https://www.saihebro.com/usuarios/registro> y escribe en «Observaciones» que quieres
   acceder a la API de Open Data.
2. Cuando te den la clave, copia `programa/config.ejemplo.json` como `programa/config.json` y pega la clave
   en `"ebro_apikey"`. Ese fichero no se sube a git.
3. Cierra y vuelve a abrir la web.

## Limitaciones

- **Arroyos sin estación**: muchos ríos pequeños no tienen ninguna estación de aforo y no existe un dato medido de su
  caudal. Se probó el modelo europeo GloFAS y se descartó porque no distingue ríos pequeños (en Saldaña daba 0,09 m³/s
  con el Carrión llevando 7,9).
- **Ebro sin clave**: su API de históricos exige registro. Sin clave se muestra solo el dato actual (ver abajo).
- Ninguna confederación salvo el Ebro tiene API pública documentada: se leen los mismos datos que sus webs. Si una
  cambia su web, hay que ajustar su función en `programa/app/cuencas.py`.
- No existe previsión pública de caudal: para días futuros se muestran los últimos 7 días.
- Las confederaciones publican de 10 a 35 días de histórico; en fechas más antiguas no hay caudal.
- En tramos muy largos, como embalses, el tiempo del punto medio puede no representar todo el tramo.
- Consulta siempre la normativa oficial antes de pescar.
