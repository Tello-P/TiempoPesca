"use strict";

const COLORES_RIO = { "Carrión": "#2b6cb0", "Esla": "#1f7a5a", "Arlanzón": "#b7791f", "Cea": "#9b2c9b" };
const VIENTO_FUERTE = 25; // km/h: a partir de aquí se resalta la hora

const $ = (id) => document.getElementById(id);
let tramos = [];          // features GeoJSON
let capas = {};           // codigo -> capa Leaflet
let graficos = [];
let mapa;
let meta = {};            // metadatos de la descarga de tramos
let capaConsulta;         // marcadores de la consulta actual (punto de previsión y estación)
let estacionesPorId = {};
let consultaActual = 0;   // para descartar respuestas de consultas anteriores

// --- utilidades -------------------------------------------------------------

const CODIGOS_WMO = {
  0: ["☀️", "Despejado"], 1: ["🌤️", "Casi despejado"], 2: ["⛅", "Parcialmente nuboso"], 3: ["☁️", "Cubierto"],
  45: ["🌫️", "Niebla"], 48: ["🌫️", "Niebla con escarcha"],
  51: ["🌦️", "Llovizna débil"], 53: ["🌦️", "Llovizna"], 55: ["🌧️", "Llovizna intensa"],
  56: ["🌧️", "Llovizna helada"], 57: ["🌧️", "Llovizna helada"],
  61: ["🌦️", "Lluvia débil"], 63: ["🌧️", "Lluvia"], 65: ["🌧️", "Lluvia fuerte"],
  66: ["🌧️", "Lluvia helada"], 67: ["🌧️", "Lluvia helada"],
  71: ["🌨️", "Nieve débil"], 73: ["🌨️", "Nieve"], 75: ["❄️", "Nieve fuerte"], 77: ["🌨️", "Granos de nieve"],
  80: ["🌦️", "Chubascos"], 81: ["🌧️", "Chubascos"], 82: ["⛈️", "Chubascos fuertes"],
  85: ["🌨️", "Chubascos de nieve"], 86: ["🌨️", "Chubascos de nieve"],
  95: ["⛈️", "Tormenta"], 96: ["⛈️", "Tormenta con granizo"], 99: ["⛈️", "Tormenta con granizo"],
};
const wmo = (c) => CODIGOS_WMO[c] || ["", ""];

function cardinal(grados) {
  const dirs = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
  return dirs[Math.round(grados / 45) % 8];
}

// La flecha apunta hacia donde sopla el viento (dirección de procedencia + 180º)
const flecha = (grados) =>
  `<span style="transform: rotate(${grados + 180}deg)" title="Viento del ${cardinal(grados)}">↑</span>`;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (v, dec = 1) => (v == null ? "–" : Number(v).toLocaleString("es-ES", { maximumFractionDigits: dec }));
const hoyISO = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

function colorTexto() {
  return getComputedStyle(document.body).color;
}

// --- carga inicial ----------------------------------------------------------

async function init() {
  $("fecha").value = hoyISO();
  const max = new Date(); max.setDate(max.getDate() + 15);
  $("fecha").max = max.toISOString().slice(0, 10);

  const geo = await (await fetch("/api/tramos")).json();
  tramos = geo.features;
  meta = geo.metadata || {};

  for (const rio of Object.keys(COLORES_RIO)) {
    $("rio").insertAdjacentHTML("beforeend", `<option>${rio}</option>`);
  }

  mapa = L.map("map");
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18, attribution: "© OpenStreetMap",
  }).addTo(mapa);

  // Todas las estaciones de aforo del SAIH en estos ríos, en gris
  const estaciones = await (await fetch("/api/estaciones")).json();
  estacionesPorId = Object.fromEntries(estaciones.map((e) => [e.id, e]));
  for (const e of estaciones) {
    L.circleMarker([e.lat, e.lon], { radius: 4, color: "#555", weight: 1, fillColor: "#999", fillOpacity: 0.8 })
      .bindTooltip(`Estación de aforo ${esc(e.nombre)} (${esc(e.id)})<br>SAIH Duero · río ${esc(e.rio)}`)
      .addTo(mapa);
  }
  capaConsulta = L.layerGroup().addTo(mapa);

  for (const f of tramos) {
    const p = f.properties;
    const capa = L.geoJSON(f, {
      style: { color: COLORES_RIO[p.rio_mas_a], weight: 4, opacity: 0.8, dashArray: p.modalidad === "Vedado" ? "4 6" : null },
    }).bindTooltip(`${esc(p.nombr_tram)} (${esc(p.codigo)})<br>${esc(p.categoria)}`, { sticky: true });
    capa.on("click", () => {
      if (p.modalidad === "Vedado") $("verVedados").checked = true;
      $("rio").value = p.rio_mas_a;
      rellenarTramos();
      $("tramo").value = p.codigo;
      consultar();
    });
    capas[p.codigo] = capa;
  }

  $("rio").addEventListener("change", rellenarTramos);
  $("verVedados").addEventListener("change", rellenarTramos);
  $("tramo").addEventListener("change", () => resaltar($("tramo").value, true));
  $("form").addEventListener("submit", (e) => { e.preventDefault(); consultar(); });

  rellenarTramos();

  // Permite enlazar una consulta: #tramo=P-7&fecha=2026-10-05
  const hash = new URLSearchParams(location.hash.slice(1));
  const desdeHash = tramos.find((f) => f.properties.codigo === hash.get("tramo"));
  if (desdeHash) {
    const p = desdeHash.properties;
    if (p.modalidad === "Vedado") $("verVedados").checked = true;
    $("rio").value = p.rio_mas_a;
    rellenarTramos();
    $("tramo").value = p.codigo;
    if (hash.get("fecha")) $("fecha").value = hash.get("fecha");
    consultar();
  }
}

function tramosVisibles() {
  const rio = $("rio").value;
  const vedados = $("verVedados").checked;
  return tramos.filter((f) =>
    (!rio || f.properties.rio_mas_a === rio) && (vedados || f.properties.modalidad !== "Vedado"));
}

function rellenarTramos() {
  const anterior = $("tramo").value;
  const visibles = tramosVisibles();
  const porRio = {};
  for (const f of visibles) (porRio[f.properties.rio_mas_a] ??= []).push(f.properties);

  $("tramo").innerHTML = Object.entries(porRio).map(([rio, ps]) =>
    `<optgroup label="${esc(rio)}">` +
    ps.map((p) => `<option value="${esc(p.codigo)}">${esc(p.nombr_tram)} · ${esc(p.categoria)} (${esc(p.codigo)})</option>`).join("") +
    `</optgroup>`).join("");
  if (visibles.some((f) => f.properties.codigo === anterior)) $("tramo").value = anterior;

  for (const [cod, capa] of Object.entries(capas)) mapa.removeLayer(capa);
  for (const f of visibles) capas[f.properties.codigo].addTo(mapa);
  const grupo = L.featureGroup(visibles.map((f) => capas[f.properties.codigo]));
  if (visibles.length) mapa.fitBounds(grupo.getBounds(), { padding: [10, 10], animate: false });
  resaltar($("tramo").value, false);
}

function resaltar(codigo, centrar) {
  for (const [cod, capa] of Object.entries(capas)) {
    capa.setStyle({ weight: cod === codigo ? 8 : 4, opacity: cod === codigo ? 1 : 0.6 });
  }
  if (centrar && capas[codigo]) mapa.fitBounds(capas[codigo].getBounds(), { padding: [30, 30], maxZoom: 13, animate: false });
}

// --- consulta ---------------------------------------------------------------

async function consultar() {
  const codigo = $("tramo").value;
  const fecha = $("fecha").value;
  if (!codigo || !fecha) return;
  const id = ++consultaActual;
  resaltar(codigo, true);
  history.replaceState(null, "", `#tramo=${encodeURIComponent(codigo)}&fecha=${fecha}`);

  graficos.forEach((g) => g.destroy());
  graficos = [];
  const t = tramos.find((f) => f.properties.codigo === codigo).properties;
  const estacion = estacionesPorId[t.estacion];
  const fechaTxt = new Date(fecha + "T12:00").toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  // La cabecera y la normativa son datos locales: se pintan al momento.
  // El tiempo y el caudal se rellenan cada uno cuando llega su respuesta.
  $("resultado").innerHTML = `
    <div class="card">
      <h2>${esc(t.nombr_tram)} <span class="sub">(${esc(t.codigo)})</span></h2>
      <p class="sub">Río ${esc(t.rio_mas_a)} · ${esc(t.tm)} (${esc(t.provincia)}) · ${fechaTxt}</p>
      <div class="badges">
        <span class="badge">${esc(t.categoria)}</span>
        <span class="badge ${t.modalidad === "Vedado" ? "vedado" : t.modalidad === "Sin Muerte" ? "sinmuerte" : ""}">${esc(t.modalidad)}</span>
        <span class="badge">${esc(t.truchera)}</span>
        <span class="badge">${fmt(t.long_km)} km</span>
      </div>
      ${fuenteTramo()}
    </div>
    <div id="bloqueMeteo" class="bloque">
      <p class="cargando">Consultando el tiempo en Open-Meteo…</p>
    </div>
    <div id="bloqueCaudal" class="bloque">
      <p class="cargando">Consultando el caudal en el SAIH Duero${estacion ? ` (estación ${esc(estacion.nombre)})` : ""}…<br>
        <small>Si el SAIH va lento puede tardar hasta un minuto la primera vez; el tiempo no espera a este dato.</small></p>
    </div>
    ${htmlInfoTramo(t)}`;
  marcarConsulta(t, estacion);

  const pedir = async (ruta, ms) => {
    const r = await fetch(`${ruta}?tramo=${encodeURIComponent(codigo)}&fecha=${fecha}`, { signal: AbortSignal.timeout(ms) });
    const datos = await r.json();
    if (!r.ok) throw new Error(datos.error);
    return datos;
  };
  const mensajeError = (e) => (e.name === "TimeoutError" ? "la fuente no ha respondido a tiempo, prueba de nuevo en un rato." : e.message);

  const meteo = pedir("/api/meteo", 60000).then((d) => {
    if (id !== consultaActual) return;
    $("bloqueMeteo").innerHTML = htmlMeteo(d.meteo, t);
    graficosMeteo(d.meteo);
  }).catch((e) => {
    if (id === consultaActual) $("bloqueMeteo").innerHTML = `<div class="aviso">Tiempo: ${esc(mensajeError(e))}</div>`;
  });

  const caudal = pedir("/api/caudal", 150000).then((d) => {
    if (id !== consultaActual) return;
    $("bloqueCaudal").innerHTML = htmlCaudal({ tramo: t, estacion: d.estacion, caudal: d.caudal });
    if (d.caudal.puntos.length) graficoCaudal(d.caudal);
  }).catch((e) => {
    if (id !== consultaActual) return;
    $("bloqueCaudal").innerHTML = `<div class="card"><h3>Caudal</h3>
      <div class="aviso">No se pudo obtener el caudal del SAIH Duero: ${esc(mensajeError(e))}</div>
      ${estacion ? fuenteCaudal({ tramo: t, estacion }) : ""}</div>`;
  });

  await Promise.all([meteo, caudal]);
}

// Dibuja en el mapa el punto donde se pide el tiempo y la estación de aforo usada
function marcarConsulta(t, estacion) {
  capaConsulta.clearLayers();
  const punto = [t.lat, t.lon];
  L.marker(punto, { icon: L.divIcon({ className: "icono-mapa", html: "🌤️", iconSize: [24, 24] }) })
    .bindTooltip(`Punto de previsión del tiempo (punto medio del tramo)<br>junto a ${esc(t.pueblo?.nombre ?? "")}`)
    .addTo(capaConsulta);
  if (t.pueblo) {
    L.marker([t.pueblo.lat, t.pueblo.lon], { icon: L.divIcon({ className: "icono-mapa", html: "🏠", iconSize: [24, 24] }) })
      .bindTooltip(esc(t.pueblo.nombre), { permanent: true, direction: "right", offset: [10, 0] })
      .addTo(capaConsulta);
  }
  if (estacion) {
    const e = estacion;
    L.marker([e.lat, e.lon], { icon: L.divIcon({ className: "icono-mapa", html: "💧", iconSize: [24, 24] }) })
      .bindTooltip(`Estación de aforo usada: ${esc(e.nombre)} (${esc(e.id)})`)
      .addTo(capaConsulta);
    L.polyline([punto, [e.lat, e.lon]], { color: "#555", weight: 2, dashArray: "4 6" }).addTo(capaConsulta);
    mapa.fitBounds(L.latLngBounds([punto, [e.lat, e.lon]]).extend(capas[t.codigo].getBounds()), { padding: [30, 30], maxZoom: 13, animate: false });
  }
}

// --- bloques "Fuente" -------------------------------------------------------

const fechaHora = (iso) => (iso ? iso.replace("T", " ") : "–");

function textoPueblo(pu) {
  if (!pu) return "";
  const muni = pu.municipio && pu.municipio !== pu.nombre ? `${esc(pu.municipio)}, ` : "";
  return `<b>${esc(pu.nombre)}</b> (${muni}${esc(pu.provincia)})`;
}

function bloqueFuente(resumen, detalle) {
  return `<div class="fuente">
    <div><strong>Fuente:</strong> ${resumen}</div>
    <details><summary>¿Cómo se obtiene este dato?</summary>${detalle}</details>
  </div>`;
}

function fuenteTramo() {
  return bloqueFuente(
    `capa oficial <a href="https://idecyl.jcyl.es/geonetwork/srv/api/records/SPAGOBCYLMNADTSAMPZP" target="_blank">«Pesca CyL: tramos de pesca»</a>
     de la Junta de Castilla y León (IDECyL), descargada el ${fechaHora(meta.generado)}.`,
    `<p>El trazado, la categoría, la modalidad y la normativa del tramo vienen tal cual de la capa oficial,
     que recoge los tramos declarados en la Orden Anual de Pesca. Se descarga con
     <code>scripts/build_data.py</code> (<a href="${esc(meta.fuente_tramos)}" target="_blank">consulta WFS usada</a>).</p>
     <p>Si la Junta cambia la normativa a mitad de temporada, esta web no se entera hasta que se vuelvan a descargar los datos.</p>`);
}

function fuenteMeteo(m, t) {
  const f = m.fuente;
  const prevision = f.api === "prevision";
  return bloqueFuente(
    `<a href="https://open-meteo.com" target="_blank">Open-Meteo</a>,
     ${prevision ? "API de previsión" : "API de archivo histórico"}, para el punto medio del tramo junto a ${textoPueblo(t.pueblo)} ·
     <a href="${esc(f.url)}" target="_blank">ver datos originales (JSON)</a> · consultado ${fechaHora(f.consultado)}.`,
    `<p><b>Dónde:</b> el tiempo se pide para las coordenadas del <b>punto medio del tramo</b>
     (${t.lat}, ${t.lon}), marcado con 🌤️ en el mapa, y no para el centro del pueblo. El pueblo más cercano a ese punto
     es ${textoPueblo(t.pueblo)}, a ${fmt(t.pueblo?.dist_km)} km (🏠 en el mapa); se indica como referencia y sale de la capa oficial
     de núcleos de población de la Junta (IDECyL). Open-Meteo devuelve la celda de su malla más cercana:
     ${f.celda_lat}, ${f.celda_lon}, a <b>${fmt(f.elevacion, 0)} m</b> de altitud.</p>
     <p><b>Qué modelo:</b> ${prevision
        ? `para fechas desde hace unos 3 meses hasta 15 días vista se usa la previsión, que elige automáticamente los
           modelos meteorológicos más adecuados para la zona y el plazo (por ejemplo, Météo-France AROME/ARPEGE, DWD ICON o ECMWF).
           En días pasados recientes devuelve lo que pronosticaron los modelos para esas horas, no observaciones de estaciones.`
        : `para fechas de hace más de unos 3 meses se usa el archivo histórico, basado en reanálisis
           (ERA5 de Copernicus/ECMWF y similares). Es una reconstrucción del tiempo pasado, no la medición de una estación,
           y no incluye probabilidad de lluvia.`}</p>
     <p><b>Variables:</b> temperatura a 2 m, viento medio y rachas a 10 m (km/h), dirección del viento (de dónde viene),
     precipitación (mm/hora), probabilidad de precipitación y nubosidad. Las horas son hora local peninsular.
     La «lluvia 7 días previos» es la suma de la precipitación diaria de los 7 días anteriores
     (<a href="${esc(f.url_previos)}" target="_blank">datos</a>).</p>
     <p><b>Limitaciones:</b> la malla tiene resolución de kilómetros, así que en valles encajados el viento real puede
     diferir bastante (encauzamientos, brisas de valle). Cuanto más lejana es la fecha, menos fiable es la previsión.</p>`);
}

function fuenteCaudal(d) {
  const e = d.estacion;
  const f = d.caudal?.fuente;
  const ajuste = (meta.overrides_estacion || {})[d.tramo.codigo];
  return bloqueFuente(
    `<a href="https://www.saihduero.es" target="_blank">SAIH Duero</a> (Confederación Hidrográfica del Duero),
     estación <a href="https://www.saihduero.es/risr/${esc(e.id)}" target="_blank">${esc(e.nombre)} (${esc(e.id)})</a>
     ${f ? ` · <a href="${esc(f.url_historico)}" target="_blank">gráfico histórico original</a> · consultado ${fechaHora(f.consultado)}` : ""}.`,
    `<p><b>Por qué esta estación:</b> ${ajuste
        ? "se asignó a mano a este tramo."
        : `es la estación de aforo del SAIH <b>en el mismo río</b> (${esc(e.rio)}) más cercana al tramo:
           está a ${fmt(d.tramo.estacion_dist_km)} km de su punto más próximo. Se marca con 💧 en el mapa.`}
     Si entre el tramo y la estación hay una presa o entra un afluente importante, el caudal en el tramo puede ser distinto.</p>
     <p><b>Qué se muestra:</b> la serie horaria de caudal (m³/s) que publica la estación. Si el día elegido es hoy o futuro,
     se muestran los últimos 7 días (no existe previsión pública de caudal); si es pasado, los 7 días que terminan ese día.
     La tendencia compara la media de las últimas 24 h con la de las 24 h anteriores (más de un ±10 % = sube o baja).</p>
     <p><b>Limitaciones:</b> son datos en tiempo real, provisionales y sin validar.
     El SAIH solo publica unos 35 días de histórico${f ? ` (ahora mismo, del ${fechaHora(f.historico_desde)} al ${fechaHora(f.historico_hasta)})` : ""}.
     Los aforos que hay a la salida de los embalses reflejan los desembalses, que pueden cambiar de un día para otro.</p>`);
}

function htmlMeteo(m, t) {
  const r = m.resumen;
  const h = m.horas;
  const filas = h.time.map((t, i) => {
    const [ico, desc] = wmo(h.weather_code[i]);
    const fuerte = (h.wind_gusts_10m[i] ?? 0) >= VIENTO_FUERTE * 1.4 || (h.wind_speed_10m[i] ?? 0) >= VIENTO_FUERTE;
    return `<tr class="${fuerte ? "fuerte" : ""}">
      <td>${t.slice(11, 16)}</td>
      <td title="${esc(desc)}">${ico}</td>
      <td>${fmt(h.temperature_2m[i])}º</td>
      <td>${fmt(h.wind_speed_10m[i], 0)}</td>
      <td>${fmt(h.wind_gusts_10m[i], 0)}</td>
      <td class="flecha">${h.wind_direction_10m[i] != null ? flecha(h.wind_direction_10m[i]) + " " + cardinal(h.wind_direction_10m[i]) : "–"}</td>
      <td>${fmt(h.precipitation[i])}</td>
      ${h.precipitation_probability ? `<td>${fmt(h.precipitation_probability[i], 0)}%</td>` : ""}
      <td>${fmt(h.cloud_cover[i], 0)}%</td>
    </tr>`;
  }).join("");

  return `
    <div class="card">
      <h3>Tiempo junto a ${esc(t.pueblo?.nombre ?? "el tramo")}</h3>
      <p class="sub">Previsión para el punto medio del tramo, a ${fmt(t.pueblo?.dist_km)} km de ${textoPueblo(t.pueblo)}
        · celda del modelo a ${fmt(m.fuente.elevacion, 0)} m de altitud</p>
      <div class="kpis">
        <div class="kpi"><div class="v">${fmt(r.temp_min)}º / ${fmt(r.temp_max)}º</div><div class="l">Temp. mín / máx</div></div>
        <div class="kpi"><div class="v">${fmt(r.viento_medio, 0)} km/h</div><div class="l">Viento medio</div></div>
        <div class="kpi"><div class="v">${fmt(r.racha_max, 0)} km/h</div><div class="l">Racha máxima</div></div>
        <div class="kpi"><div class="v">${fmt(r.lluvia_mm)} mm</div><div class="l">Lluvia del día${r.prob_lluvia_max != null ? ` · prob. máx ${r.prob_lluvia_max}%` : ""}</div></div>
        <div class="kpi"><div class="v">${fmt(m.lluvia_7d_previos_mm)} mm</div><div class="l">Lluvia 7 días previos</div></div>
      </div>
    </div>
    <div class="card">
      <h3>Viento por horas (km/h)</h3>
      <div class="grafico"><canvas id="gViento"></canvas></div>
    </div>
    <div class="card">
      <h3>Temperatura y lluvia por horas</h3>
      <div class="grafico"><canvas id="gTemp"></canvas></div>
    </div>
    <div class="card">
      <h3>Detalle horario</h3>
      <div class="tabla-wrap"><table>
        <thead><tr><th>Hora</th><th></th><th>Temp</th><th>Viento</th><th>Racha</th><th>Dirección</th><th>Lluvia mm</th>
          ${h.precipitation_probability ? "<th>Prob.</th>" : ""}<th>Nubes</th></tr></thead>
        <tbody>${filas}</tbody>
      </table></div>
      <p class="nota">Resaltadas las horas con viento ≥ ${VIENTO_FUERTE} km/h o rachas ≥ ${VIENTO_FUERTE * 1.4} km/h.
        La flecha indica hacia dónde sopla el viento; la letra, de dónde viene.</p>
    </div>
    <div class="card">
      <h3>Origen de los datos del tiempo</h3>
      ${fuenteMeteo(m, t)}
    </div>`;
}

function htmlCaudal(d) {
  const c = d.caudal;
  const e = d.estacion;
  if (!e) return "";
  const enlace = `<a href="https://www.saihduero.es/risr/${esc(e.id)}" target="_blank">${esc(e.nombre)} (${esc(e.id)})</a>`;
  if (!c) return `<div class="card"><h3>Caudal</h3><p class="sub">Estación ${enlace}: sin datos.</p>${fuenteCaudal(d)}</div>`;
  if (!c.puntos.length) return `<div class="card"><h3>Caudal</h3><p class="sub">Estación ${enlace}</p><div class="aviso">${esc(c.nota)}</div>${fuenteCaudal(d)}</div>`;
  const tend = { subiendo: "↗ subiendo", bajando: "↘ bajando", estable: "→ estable" }[c.tendencia] ?? "–";
  return `
    <div class="card">
      <h3>Caudal (m³/s)</h3>
      <p class="sub">Estación ${enlace} · a ${fmt(d.tramo.estacion_dist_km)} km del tramo · río ${esc(e.rio)}</p>
      <div class="kpis">
        <div class="kpi"><div class="v">${fmt(c.ultimo.valor, 2)}</div><div class="l">Último dato (${c.ultimo.fecha.replace("T", " ")})</div></div>
        <div class="kpi"><div class="v">${fmt(c.media, 2)}</div><div class="l">Media 7 días</div></div>
        <div class="kpi"><div class="v">${fmt(c.min, 2)} – ${fmt(c.max, 2)}</div><div class="l">Mín – máx</div></div>
        <div class="kpi"><div class="v">${tend}</div><div class="l">Tendencia (24 h)</div></div>
      </div>
      <div class="grafico" style="margin-top:12px"><canvas id="gCaudal"></canvas></div>
      <p class="nota">${esc(c.nota)}</p>
      ${fuenteCaudal(d)}
    </div>`;
}

function htmlInfoTramo(t) {
  const filas = [
    ["Límite superior", t.lim_superi],
    ["Límite inferior", t.lim_inferi],
    ["Periodo hábil", [t.per1_pec_i, t.per1_pec_f].filter(Boolean).join(" – ")],
    ["2º periodo", [t.per2_pec_i, t.per2_pec_f].filter(Boolean).join(" – ")],
    ["Especie principal", t.esp_princ],
    ["Cebos", t.cebos],
    ["Cupo trucha", t.truch_cup_ ? `${t.truch_cup_} (talla ${t.truch_cm} cm)` : null],
    ["Otras limitaciones", t.otras_limi],
  ].filter(([, v]) => v);
  return `
    <div class="card">
      <h3>Normativa del tramo</h3>
      <dl class="info">${filas.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
      <div class="fuente"><strong>Fuente:</strong> capa oficial de tramos de pesca de la Junta (IDECyL), descargada el ${fechaHora(meta.generado)}.
        Puede no reflejar cambios posteriores: consulta la
        <a href="${esc(t.info_tramo)}" target="_blank">ficha oficial del tramo en pescacastillayleon.es</a>.</div>
    </div>`;
}

// --- gráficos ---------------------------------------------------------------

function opcionesBase() {
  const c = colorTexto();
  Chart.defaults.color = c;
  Chart.defaults.borderColor = "rgba(127,127,127,.2)";
  return { responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false } };
}

function graficosMeteo(m) {
  const h = m.horas;
  const etiquetas = h.time.map((t) => t.slice(11, 16));

  graficos.push(new Chart($("gViento"), {
    type: "line",
    data: {
      labels: etiquetas,
      datasets: [
        { label: "Viento", data: h.wind_speed_10m, borderColor: "#2b6cb0", backgroundColor: "rgba(43,108,176,.15)", fill: true, tension: .3 },
        { label: "Rachas", data: h.wind_gusts_10m, borderColor: "#c53030", borderDash: [5, 4], tension: .3, pointRadius: 0 },
      ],
    },
    options: {
      ...opcionesBase(),
      scales: { y: { beginAtZero: true, title: { display: true, text: "km/h" } } },
      plugins: {
        tooltip: { callbacks: { afterBody: (it) => `Dirección: ${cardinal(h.wind_direction_10m[it[0].dataIndex])}` } },
      },
    },
  }));

  graficos.push(new Chart($("gTemp"), {
    data: {
      labels: etiquetas,
      datasets: [
        { type: "line", label: "Temperatura (ºC)", data: h.temperature_2m, borderColor: "#dd6b20", tension: .3, yAxisID: "y" },
        { type: "bar", label: "Lluvia (mm)", data: h.precipitation, backgroundColor: "rgba(43,108,176,.6)", yAxisID: "y1" },
      ],
    },
    options: {
      ...opcionesBase(),
      scales: {
        y: { position: "left", title: { display: true, text: "ºC" } },
        y1: { position: "right", beginAtZero: true, suggestedMax: 2, grid: { drawOnChartArea: false }, title: { display: true, text: "mm" } },
      },
    },
  }));
}

function graficoCaudal(c) {
  graficos.push(new Chart($("gCaudal"), {
    type: "line",
    data: {
      labels: c.puntos.map(([t]) => {
        const d = new Date(t);
        return d.toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit" }) + " " + t.slice(11, 16);
      }),
      datasets: [{ label: "Caudal (m³/s)", data: c.puntos.map(([, v]) => v), borderColor: "#1f7a5a", backgroundColor: "rgba(31,122,90,.15)", fill: true, pointRadius: 0, tension: .2 }],
    },
    options: {
      ...opcionesBase(),
      scales: { x: { ticks: { maxTicksLimit: 8 } }, y: { beginAtZero: true, title: { display: true, text: "m³/s" } } },
    },
  }));
}

init();
