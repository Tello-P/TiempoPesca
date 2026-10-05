"use strict";

// Umbrales para el resumen "De un vistazo" (km/h, mm)
const VIENTO = { calma: 10, flojo: 20, moderado: 30 };
const RACHA_FUERTE = 45;
const VIENTO_FUERTE_TABLA = 25; // resaltado en la tabla horaria
const MAX_RECIENTES = 4;
const MAX_RESULTADOS_BUSQUEDA = 40;

const $ = (id) => document.getElementById(id);
let tramos = [];           // propiedades de todos los tramos
let porId = {};            // id único del tramo -> tramo (el código oficial puede repetirse)
let meta = {};
let estacionesPorId = {};
let graficos = [];
let mapa, capaMapa;         // mapa de resultados
let mapaElegir, capaElegir; // mapa del paso 1
let geoTodo = null;         // trazados de todos los tramos
let capasPorId = {};
const geometrias = {};     // provincia -> GeoJSON (se piden al servidor según hace falta)
let consultaActual = 0;    // para descartar respuestas de consultas anteriores
let tramoElegido = null;

// --- utilidades -------------------------------------------------------------

const CODIGOS_WMO = {
  0: ["☀️", "Despejado"], 1: ["🌤️", "Casi despejado"], 2: ["⛅", "Algunas nubes"], 3: ["☁️", "Nublado"],
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

const PUNTOS = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
const PUNTOS_LARGO = ["Norte", "Nordeste", "Este", "Sudeste", "Sur", "Suroeste", "Oeste", "Noroeste"];
const cardinal = (g) => PUNTOS[Math.round(g / 45) % 8];
const cardinalLargo = (g) => PUNTOS_LARGO[Math.round(g / 45) % 8];

// La flecha apunta hacia donde sopla el viento (dirección de procedencia + 180º)
const flecha = (grados) =>
  `<span style="transform: rotate(${grados + 180}deg)" title="Viento del ${cardinalLargo(grados)}">↑</span>`;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (v, dec = 1) => (v == null ? "–" : Number(v).toLocaleString("es-ES", { maximumFractionDigits: dec }));
// Caudal: con dos decimales si es pequeño, para no mostrar "0 m³/s"
const fmtCaudal = (v) => fmt(v, Math.abs(v) < 1 ? 2 : 1);
const normalizar = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const isoLocal = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const sumarDias = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };
const hora = (iso) => (iso ? iso.slice(11, 16) : "–");
const fechaHora = (iso) => (iso ? iso.replace("T", " ") : "–");
// Datos de la confederación de una cuenca (nombre de su SAIH, web...) y cuánto histórico publica
const cuenca = (c) => meta.cuencas?.[c] ?? { saih: `SAIH ${c}`, organismo: `Confederación Hidrográfica del ${c}`, web: "" };
const HISTORICO_CUENCA = {
  "Duero": "unos 35 días, un dato por hora",
  "Tajo": "los últimos 10 días, un dato cada 15 minutos",
  "Miño-Sil": "las últimas 3 semanas, un dato cada 15 minutos (se leen semana a semana)",
  "Cantábrico": "unos 35 días, un dato por hora; el histórico llega con unas horas de retraso, así que se añade el último dato en tiempo real",
  "Ebro": "con clave de su API de datos abiertos, unos 35 días; sin clave, solo el dato actual",
};
// " · río X", salvo que el nombre del tramo ya lo diga
const rioDe = (t) => (normalizar(t.nombr_tram).includes(normalizar(t.rio_mas_a)) ? "" : ` · río ${esc(t.rio_mas_a)}`);

function guardar(clave, valor) { try { localStorage.setItem(clave, JSON.stringify(valor)); } catch { /* sin almacenamiento */ } }
function leer(clave, defecto) { try { return JSON.parse(localStorage.getItem(clave)) ?? defecto; } catch { return defecto; } }

// --- carga inicial ----------------------------------------------------------

async function init() {
  const [datos, estaciones] = await Promise.all([
    fetch("/api/tramos").then((r) => r.json()),
    fetch("/api/estaciones").then((r) => r.json()),
  ]);
  tramos = datos.tramos;
  meta = datos.metadata || {};
  porId = Object.fromEntries(tramos.map((t) => [t.id, t]));
  estacionesPorId = Object.fromEntries(estaciones.map((e) => [e.id, e]));

  const provincias = [...new Set(tramos.map((t) => t.provincia))].sort((a, b) => a.localeCompare(b, "es"));
  $("provincia").insertAdjacentHTML("beforeend", provincias.map((p) => `<option>${esc(p)}</option>`).join(""));

  $("provincia").addEventListener("change", () => { rellenarRios(); listarPorRio(); });
  $("rio").addEventListener("change", listarPorRio);
  $("verTodos").addEventListener("change", () => {
    document.querySelectorAll(".solo-todos").forEach((el) => (el.hidden = !$("verTodos").checked));
    dibujarTramosMapa();
    if ($("buscar").value) buscar(); else { rellenarRios(); listarPorRio(); }
  });
  $("buscar").addEventListener("input", buscar);
  $("fecha").addEventListener("change", () => $("fecha").value && elegirDia($("fecha").value));

  pintarRecientes();
  pintarDias();
  crearMapaElegir();
  aplicarHash();
  window.addEventListener("hashchange", aplicarHash);
}

// #tramo=P-7&fecha=2026-10-06 abre directamente la consulta
function aplicarHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  const t = porId[h.get("tramo")];
  if (!t) return mostrarPaso(1);
  elegirTramo(t.id, false);
  if (h.get("fecha")) elegirDia(h.get("fecha"), false);
}

function mostrarPaso(n) {
  $("paso2").hidden = n < 2;
  $("paso3").hidden = n < 3;
  $("eleccion").hidden = n >= 2;
  $("elegido").hidden = n < 2;
  $("eleccionDia").hidden = n >= 3;
  $("elegidoDia").hidden = n < 3;
  if (n === 1 && mapaElegir) {
    // El mapa pudo crearse oculto: recalcula su tamaño y céntralo en el último tramo elegido
    setTimeout(() => {
      mapaElegir.invalidateSize();
      if (tramoElegido) mapaElegir.setView([tramoElegido.lat, tramoElegido.lon], 10, { animate: false });
    }, 0);
  }
}

// --- mapa para elegir tramo ---------------------------------------------------

const ESTILO_TRAMO = {
  truchera: { color: "#1f5fa8", weight: 4, opacity: 0.85, dashArray: null },
  otras: { color: "#7a8a85", weight: 4, opacity: 0.85, dashArray: null },
  vedada: { color: "#b42318", weight: 4, opacity: 0.85, dashArray: "6 6" },
};
const tipoTramo = (t) => (t.modalidad === "Vedado" ? "vedada" : t.truchera === "Aguas trucheras" ? "truchera" : "otras");

async function crearMapaElegir() {
  $("mapaElegir").innerHTML = "";
  // Canvas con tolerancia: las líneas se pueden pulsar aunque el dedo no caiga justo encima
  mapaElegir = L.map("mapaElegir", { renderer: L.canvas({ tolerance: 10 }) });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap" }).addTo(mapaElegir);
  mapaElegir.fitBounds(L.latLngBounds(tramos.map((t) => [t.lat, t.lon])), { animate: false });
  try {
    geoTodo = await fetch("/api/geometria").then((r) => r.json());
  } catch {
    $("mapaElegir").insertAdjacentHTML("beforeend", `<p class="aviso">No se ha podido cargar el mapa de tramos.</p>`);
    return;
  }
  dibujarTramosMapa();
}

function dibujarTramosMapa() {
  if (!geoTodo) return;
  if (capaElegir) mapaElegir.removeLayer(capaElegir);
  capasPorId = {};
  capaElegir = L.geoJSON(geoTodo, {
    filter: (f) => porId[f.properties.id] && visible(porId[f.properties.id]),
    style: (f) => ESTILO_TRAMO[tipoTramo(porId[f.properties.id])],
    onEachFeature: (f, capa) => {
      const t = porId[f.properties.id];
      capasPorId[t.id] = capa;
      capa.bindTooltip(`${esc(t.nombr_tram)}${rioDe(t)}`, { sticky: true });
      capa.on("click", (e) => { capa.closeTooltip(); abrirPopupTramo(t, e.latlng); });
    },
  }).addTo(mapaElegir);
}

function abrirPopupTramo(t, latlng) {
  const vedado = t.modalidad === "Vedado";
  const popup = L.popup({ maxWidth: 320 })
    .setLatLng(latlng)
    .setContent(`<div class="popup-tramo">
      <b>${esc(t.nombr_tram)}</b>${rioDe(t)}
      <span class="tramo-info">${esc(t.categoria)} · ${vedado ? `<span class="no-pescar">VEDADO</span>` : esc(t.modalidad)}<br>
        Junto a ${esc(t.pueblo?.nombre)} (${esc(t.provincia)})</span>
      <button>Elegir este tramo</button>
    </div>`)
    .openOn(mapaElegir);
  popup.getElement().querySelector("button").addEventListener("click", () => {
    mapaElegir.closePopup();
    elegirTramo(t.id);
  });
}

// Resalta en el mapa los tramos de la lista (búsqueda o río) y se acerca a ellos
function resaltarEnMapa(lista) {
  if (!capaElegir) return;
  const ids = new Set(lista.map((t) => t.id));
  capaElegir.eachLayer((capa) => {
    const t = porId[capa.feature.properties.id];
    capa.setStyle({ ...ESTILO_TRAMO[tipoTramo(t)], weight: ids.has(t.id) ? 8 : 4, opacity: ids.size && !ids.has(t.id) ? 0.35 : 0.85 });
  });
  const capas = lista.map((t) => capasPorId[t.id]).filter(Boolean);
  if (capas.length) mapaElegir.fitBounds(L.featureGroup(capas).getBounds(), { padding: [30, 30], maxZoom: 13, animate: false });
}

// --- paso 1: tramo ------------------------------------------------------------

const visible = (t) => $("verTodos").checked || (t.truchera === "Aguas trucheras" && t.modalidad !== "Vedado");

function rellenarRios() {
  const prov = $("provincia").value;
  const rios = [...new Set(tramos.filter((t) => t.provincia === prov && visible(t)).map((t) => t.rio_mas_a))]
    .sort((a, b) => a.localeCompare(b, "es"));
  $("rio").disabled = !prov;
  $("rio").innerHTML = prov
    ? `<option value="">Elige el río (${rios.length})</option>` + rios.map((r) => `<option>${esc(r)}</option>`).join("")
    : `<option value="">Primero elige la provincia</option>`;
}

function listarPorRio() {
  $("buscar").value = "";
  const prov = $("provincia").value;
  const rio = $("rio").value;
  if (!prov || !rio) {
    $("listaTramos").innerHTML = "";
    resaltarEnMapa(prov ? tramos.filter((t) => t.provincia === prov && visible(t)) : []);
    return;
  }
  // Ya vienen ordenados de aguas arriba a aguas abajo
  const lista = tramos.filter((t) => t.provincia === prov && t.rio_mas_a === rio && visible(t));
  resaltarEnMapa(lista);
  pintarLista($("listaTramos"), lista, `Tramos del río ${rio} en ${prov}, de arriba abajo:`);
}

function buscar() {
  const q = normalizar($("buscar").value.trim());
  if (q.length < 2) { $("listaTramos").innerHTML = ""; resaltarEnMapa([]); return; }
  $("provincia").value = "";
  rellenarRios();
  const palabras = q.split(/\s+/);
  const lista = tramos.filter((t) => {
    if (!visible(t)) return false;
    const texto = normalizar([t.nombr_tram, t.rio_mas_a, t.pueblo?.nombre, t.tm, t.provincia, t.codigo].join(" "));
    return palabras.every((p) => texto.includes(p));
  });
  const titulo = lista.length > MAX_RESULTADOS_BUSQUEDA
    ? `${lista.length} tramos encontrados; se muestran los ${MAX_RESULTADOS_BUSQUEDA} primeros. Escribe algo más para afinar:`
    : `${lista.length} tramo${lista.length === 1 ? "" : "s"} encontrado${lista.length === 1 ? "" : "s"}:`;
  pintarLista($("listaTramos"), lista.slice(0, MAX_RESULTADOS_BUSQUEDA), titulo);
  resaltarEnMapa(lista);
}

function tarjetaTramo(t) {
  const vedado = t.modalidad === "Vedado";
  return `<button class="tramo ${vedado ? "es-vedado" : ""}" data-id="${esc(t.id)}">
    <span class="tramo-nombre">${esc(t.nombr_tram)} <small>${rioDe(t)}</small></span>
    <span class="tramo-info">${esc(t.categoria)} · ${vedado ? "<b>VEDADO</b>" : esc(t.modalidad)}
      · junto a ${esc(t.pueblo?.nombre)} (${esc(t.provincia)})</span>
  </button>`;
}

function pintarLista(contenedor, lista, titulo) {
  contenedor.innerHTML = lista.length
    ? `<p class="etiqueta">${esc(titulo)}</p>` + lista.map(tarjetaTramo).join("")
    : `<p class="etiqueta">No hay tramos que coincidan.${$("verTodos").checked ? "" : " Prueba a marcar «Mostrar también aguas no trucheras»."}</p>`;
  contenedor.querySelectorAll("button.tramo").forEach((b) => b.addEventListener("click", () => elegirTramo(b.dataset.id)));
}

function pintarRecientes() {
  const lista = leer("tp_recientes", []).map((c) => porId[c]).filter(Boolean);
  $("recientes").hidden = !lista.length;
  if (lista.length) pintarLista($("listaRecientes"), lista, "");
  $("listaRecientes").querySelector(".etiqueta")?.remove();
}

function recordar(id) {
  guardar("tp_recientes", [id, ...leer("tp_recientes", []).filter((c) => c !== id)].slice(0, MAX_RECIENTES));
}

function elegirTramo(id, actualizarHash = true) {
  const t = porId[id];
  tramoElegido = t;
  recordar(id);
  $("elegido").innerHTML = `
    <div><span class="etiqueta">Tramo elegido:</span>
      <b>${esc(t.nombr_tram)}</b>${rioDe(t)} · junto a ${esc(t.pueblo?.nombre)} (${esc(t.provincia)})</div>
    <button class="secundario" id="cambiarTramo">Cambiar de tramo</button>`;
  $("cambiarTramo").addEventListener("click", () => { history.replaceState(null, "", location.pathname); pintarRecientes(); mostrarPaso(1); });
  if (actualizarHash) history.replaceState(null, "", `#tramo=${encodeURIComponent(id)}`);
  mostrarPaso(2);
  $("paso2").scrollIntoView({ behavior: "smooth", block: "start" });
}

// --- paso 2: día --------------------------------------------------------------

function nombreDia(iso) {
  const hoy = isoLocal(new Date());
  if (iso === hoy) return "Hoy";
  if (iso === isoLocal(sumarDias(1))) return "Mañana";
  if (iso === isoLocal(sumarDias(-1))) return "Ayer";
  const d = new Date(iso + "T12:00");
  const txt = d.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" });
  return txt.charAt(0).toUpperCase() + txt.slice(1);
}

function pintarDias() {
  const botones = [];
  for (let i = 0; i <= 6; i++) {
    const d = sumarDias(i);
    const iso = isoLocal(d);
    const arriba = i === 0 ? "Hoy" : i === 1 ? "Mañana" : d.toLocaleDateString("es-ES", { weekday: "long" });
    const abajo = d.toLocaleDateString("es-ES", { day: "numeric", month: "short" });
    botones.push(`<button class="dia" data-fecha="${iso}"><b>${esc(arriba)}</b><span>${esc(abajo)}</span></button>`);
  }
  $("dias").innerHTML = botones.join("");
  $("dias").querySelectorAll("button.dia").forEach((b) => b.addEventListener("click", () => elegirDia(b.dataset.fecha)));
  $("fecha").max = isoLocal(sumarDias(15));
}

function elegirDia(fecha, actualizarHash = true) {
  if (!tramoElegido) return;
  $("elegidoDia").innerHTML = `
    <div><span class="etiqueta">Día:</span> <b>${esc(nombreDia(fecha))}</b>
      ${["Hoy", "Mañana", "Ayer"].includes(nombreDia(fecha)) ? `<span class="sub">(${esc(new Date(fecha + "T12:00").toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" }))})</span>` : ""}</div>
    <button class="secundario" id="cambiarDia">Cambiar de día</button>`;
  $("cambiarDia").addEventListener("click", () => mostrarPaso(2));
  if (actualizarHash) history.replaceState(null, "", `#tramo=${encodeURIComponent(tramoElegido.id)}&fecha=${fecha}`);
  mostrarPaso(3);
  consultar(tramoElegido, fecha);
}

// --- paso 3: resultados ---------------------------------------------------------

async function consultar(t, fecha) {
  const id = ++consultaActual;
  graficos.forEach((g) => g.destroy());
  graficos = [];
  const estacion = estacionesPorId[t.estacion];

  $("paso3").innerHTML = `
    <div class="card vistazo">
      <h2>De un vistazo</h2>
      <p class="sub">${esc(t.nombr_tram)}${rioDe(t)} · ${esc(nombreDia(fecha))}</p>
      <div class="fichas">
        <div class="ficha" id="fCielo"><p class="cargando-mini">Consultando el tiempo…</p></div>
        <div class="ficha" id="fViento"></div>
        <div class="ficha" id="fLluvia"></div>
        <div class="ficha" id="fTemp"></div>
        <div class="ficha" id="fRio"><p class="cargando-mini">Consultando el río…</p></div>
        <div class="ficha" id="fNormas">${fichaNormas(t)}</div>
      </div>
    </div>
    <h2 class="titulo-detalles">Más detalles</h2>
    <div id="bloqueMeteo" class="bloque"><p class="cargando">Consultando el tiempo en Open-Meteo…</p></div>
    <div id="bloqueCaudal" class="bloque">${t.estacion
      ? `<p class="cargando">Consultando el caudal en el ${esc(cuenca(t.cuenca).saih)} (estación ${esc(estacion?.nombre)})…<br>
          <small>Algunas confederaciones tardan hasta un minuto en responder; el tiempo no espera a este dato.</small></p>`
      : htmlSinCaudal(t)}</div>
    <div class="card"><h3>Mapa del tramo</h3><div id="mapa"></div>
      <p class="nota leyenda">Tramo en azul · 🌤️ punto donde se calcula el tiempo · 🏠 pueblo de referencia${t.estacion ? " · 💧 estación de aforo" : ""}</p>
    </div>
    ${htmlInfoTramo(t)}`;
  $("paso3").scrollIntoView({ behavior: "smooth", block: "start" });

  pintarMapa(t, estacion);

  const pedir = async (ruta, ms) => {
    const r = await fetch(`${ruta}?tramo=${encodeURIComponent(t.id)}&fecha=${fecha}`, { signal: AbortSignal.timeout(ms) });
    const datos = await r.json();
    if (!r.ok) throw new Error(datos.error);
    return datos;
  };
  const mensajeError = (e) => (e.name === "TimeoutError" ? "la fuente no ha respondido a tiempo, prueba de nuevo en un rato." : e.message);

  const meteo = pedir("/api/meteo", 60000).then((d) => {
    if (id !== consultaActual) return;
    fichasMeteo(d.meteo);
    $("bloqueMeteo").innerHTML = htmlMeteo(d.meteo, t);
    graficosMeteo(d.meteo);
  }).catch((e) => {
    if (id !== consultaActual) return;
    // Fuera del plazo de previsión el mensaje es útil tal cual; si no, uno sencillo y opción de reintentar
    const fueraDePlazo = /previsión hasta/.test(e.message);
    $("fCielo").innerHTML = ficha("⚠️", "El tiempo", "No disponible", fueraDePlazo ? esc(e.message)
      : `No se ha podido consultar ahora mismo.<br><button class="secundario reintentar">Volver a intentarlo</button>`, "gris");
    ["fViento", "fLluvia", "fTemp"].forEach((f) => ($(f).hidden = true));
    $("bloqueMeteo").innerHTML = `<div class="aviso">Tiempo: ${esc(mensajeError(e))}</div>`;
    $("paso3").querySelector(".reintentar")?.addEventListener("click", () => consultar(t, fecha));
  });

  if (!t.estacion) {
    $("fRio").innerHTML = ficha("🏞️", "El río", "Sin datos", "No hay estación de aforo cerca en este río.", "gris");
    return meteo;
  }
  const caudal = pedir("/api/caudal", 150000).then((d) => {
    if (id !== consultaActual) return;
    fichaRio(d.caudal, t);
    $("bloqueCaudal").innerHTML = htmlCaudal({ tramo: t, estacion: d.estacion, caudal: d.caudal });
    if (d.caudal.puntos.length > 1) graficoCaudal(d.caudal);
  }).catch((e) => {
    if (id !== consultaActual) return;
    $("fRio").innerHTML = ficha("🏞️", "El río", "No disponible",
      (/no tiene datos recientes/.test(e.message)
        ? "La estación de aforo no está dando datos ahora mismo (fuera de servicio o en mantenimiento)."
        : `El ${esc(cuenca(t.cuenca).saih)} no responde ahora mismo.`)
      + `<br><button class="secundario reintentar-rio">Volver a intentarlo</button>`, "gris");
    $("paso3").querySelector(".reintentar-rio")?.addEventListener("click", () => consultar(t, fecha));
    $("bloqueCaudal").innerHTML = `<div class="card"><h3>Caudal</h3>
      <div class="aviso">No se pudo obtener el caudal del ${esc(cuenca(t.cuenca).saih)}: ${esc(mensajeError(e))}</div>
      ${estacion ? fuenteCaudal({ tramo: t, estacion }) : ""}</div>`;
  });

  await Promise.all([meteo, caudal]);
}

// --- "De un vistazo" ------------------------------------------------------------

// color: verde (bien), ambar (regular), rojo (mal), gris (sin datos / informativo)
function ficha(icono, titulo, valor, detalle, color) {
  return `<div class="ficha-cont ${color}">
    <div class="ficha-icono">${icono}</div>
    <div><div class="ficha-titulo">${esc(titulo)}</div>
      <div class="ficha-valor">${valor}</div>
      <div class="ficha-detalle">${detalle}</div></div>
  </div>`;
}

// Índices de las horas con luz (de amanecer a anochecer)
function horasDeLuz(m) {
  const ini = Number(hora(m.sol.amanecer).slice(0, 2));
  const fin = Number(hora(m.sol.anochecer).slice(0, 2));
  return m.horas.time.map((t, i) => [Number(t.slice(11, 13)), i]).filter(([h]) => h >= ini && h <= fin).map(([, i]) => i);
}

function franjaMenosViento(m, idx) {
  // Ventana de 3 horas seguidas (con luz) con menos viento medio
  const v = m.horas.wind_speed_10m;
  let mejor = null;
  for (let k = 0; k + 2 < idx.length; k++) {
    const tramo = idx.slice(k, k + 3);
    if (tramo[2] - tramo[0] !== 2) continue;
    const media = tramo.reduce((s, i) => s + (v[i] ?? 99), 0) / 3;
    if (!mejor || media < mejor.media) mejor = { media, ini: tramo[0], fin: tramo[2] };
  }
  return mejor;
}

function fichasMeteo(m) {
  const h = m.horas;
  const idx = horasDeLuz(m);
  const enLuz = (arr) => idx.map((i) => arr[i]).filter((v) => v != null);

  // Cielo: el estado más frecuente durante el día (el código WMO más alto si empatan)
  const cuenta = {};
  enLuz(h.weather_code).forEach((c) => (cuenta[c] = (cuenta[c] || 0) + 1));
  const codigo = Number(Object.entries(cuenta).sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 0);
  const [ico, desc] = wmo(codigo);
  $("fCielo").innerHTML = ficha(ico || "🌤️", "El cielo", esc(desc || "–"),
    `Amanece a las ${hora(m.sol.amanecer)} y anochece a las ${hora(m.sol.anochecer)}`, "gris");

  // Viento
  const vientos = enLuz(h.wind_speed_10m);
  const rachas = enLuz(h.wind_gusts_10m);
  const vmax = Math.max(...vientos);
  const rmax = Math.max(...rachas);
  const dirs = enLuz(h.wind_direction_10m);
  // Dirección dominante: media vectorial de las horas con luz
  const sx = dirs.reduce((s, d) => s + Math.sin(d * Math.PI / 180), 0);
  const cx = dirs.reduce((s, d) => s + Math.cos(d * Math.PI / 180), 0);
  const dirMedia = (Math.atan2(sx, cx) * 180 / Math.PI + 360) % 360;
  let nivel, color;
  if (vmax < VIENTO.calma) [nivel, color] = ["Casi en calma", "verde"];
  else if (vmax < VIENTO.flojo) [nivel, color] = ["Flojo", "verde"];
  else if (vmax < VIENTO.moderado) [nivel, color] = ["Moderado", "ambar"];
  else [nivel, color] = ["Fuerte", "rojo"];
  if (rmax >= RACHA_FUERTE && color === "verde") color = "ambar";
  const franja = franjaMenosViento(m, idx);
  $("fViento").innerHTML = ficha("💨", "El viento", nivel,
    `${vmax >= VIENTO.calma ? `Del ${cardinalLargo(dirMedia)}. ` : ""}Hasta ${fmt(vmax, 0)} km/h, rachas de ${fmt(rmax, 0)} km/h.`
    + (franja && vmax >= VIENTO.flojo ? `<br>Menos viento de ${hora(h.time[franja.ini])} a ${hora(h.time[franja.fin])}.` : ""),
    color);

  // Lluvia (en horas de luz)
  const lluvia = enLuz(h.precipitation);
  const total = lluvia.reduce((s, v) => s + v, 0);
  const probs = h.precipitation_probability ? enLuz(h.precipitation_probability) : [];
  const pmax = probs.length ? Math.max(...probs) : null;
  const horasLluvia = idx.filter((i) => (h.precipitation[i] ?? 0) >= 0.2).map((i) => hora(h.time[i]));
  let txt, colorLl, det;
  if (total < 0.2 && (pmax == null || pmax < 30)) {
    [txt, colorLl] = ["No se espera lluvia", "verde"];
    det = pmax != null ? `Probabilidad máxima: ${pmax}%.` : "";
  } else if (total < 0.2) {
    [txt, colorLl] = ["Puede caer alguna gota", "ambar"];
    det = `Probabilidad de hasta el ${pmax}%.`;
  } else if (total < 3) {
    [txt, colorLl] = ["Algo de lluvia", "ambar"];
    det = `${fmt(total)} mm en total` + (horasLluvia.length ? `, sobre todo hacia las ${horasLluvia.slice(0, 3).join(", ")}.` : ".");
  } else {
    [txt, colorLl] = ["Lluvia", "rojo"];
    det = `${fmt(total)} mm en total` + (horasLluvia.length ? `, de ${horasLluvia[0]} a ${horasLluvia[horasLluvia.length - 1]}.` : ".");
  }
  const nocturna = h.precipitation.reduce((s, v) => s + (v ?? 0), 0) - total;
  if (nocturna >= 0.2) det += `<br>De noche: ${fmt(nocturna)} mm.`;
  if (m.lluvia_7d_previos_mm >= 20) det += `<br>Ha llovido bastante la semana anterior (${fmt(m.lluvia_7d_previos_mm, 0)} mm).`;
  $("fLluvia").innerHTML = ficha("🌧️", "La lluvia", txt, det, colorLl);

  // Temperatura
  const r = m.resumen;
  const colorT = r.temp_max >= 30 || r.temp_min <= 0 ? "ambar" : "verde";
  let detT = "";
  if (r.temp_min <= 0) detT = "Helada al amanecer: abrígate bien.";
  else if (r.temp_min < 6) detT = "Fresco a primera hora.";
  else if (r.temp_max >= 30) detT = "Mucho calor en las horas centrales.";
  $("fTemp").innerHTML = ficha("🌡️", "La temperatura", `De ${fmt(r.temp_min, 0)} a ${fmt(r.temp_max, 0)} grados`, detT, colorT);
}

function fichaRio(c, t) {
  if (!c.puntos.length) {
    $("fRio").innerHTML = ficha("🏞️", "El río", "Sin datos", esc(c.nota), "gris");
    return;
  }
  if (c.fuente?.solo_actual) {
    $("fRio").innerHTML = ficha("🏞️", "El río", `${fmtCaudal(c.ultimo.valor)} m³/s ahora`,
      `Dato de las ${hora(c.ultimo.fecha)}. El ${esc(cuenca(t.cuenca).saih)} solo deja ver el dato actual, así que no se
       puede decir si va alto o bajo. <a href="como-funciona.html#ebro">Cómo verlo completo</a>`, "gris");
    return;
  }
  const estados = {
    alto: ["Más alto de lo normal", "rojo"],
    normal: ["Normal", "verde"],
    bajo: ["Más bajo de lo normal", "ambar"],
  };
  const [txt, color] = estados[c.estado] ?? ["–", "gris"];
  const tend = { subiendo: "y subiendo", bajando: "y bajando", estable: "y estable" }[c.tendencia] ?? "";
  const aprox = t.estacion_tipo === "rio_principal"
    ? `<br><i>Aproximado: medido en el río ${esc(estacionesPorId[t.estacion]?.rio)}, no en este.</i>` : "";
  $("fRio").innerHTML = ficha("🏞️", "El río", `${txt} ${tend}`,
    `Ahora ${fmtCaudal(c.ultimo.valor)} m³/s; lo normal estos días, unos ${fmtCaudal(c.mediana_historico)} m³/s.` + aprox,
    c.tendencia === "subiendo" && color === "verde" ? "ambar" : color);
}

function fichaNormas(t) {
  if (t.modalidad === "Vedado") {
    return ficha("⛔", "Las normas", "Vedado", "En este tramo no se puede pescar.", "rojo");
  }
  const minus = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
  const temporada = [t.per1_pec_i, t.per1_pec_f].filter(Boolean).map(minus).join(" al ");
  const segunda = [t.per2_pec_i, t.per2_pec_f].filter(Boolean).map(minus).join(" al ");
  return ficha("📋", "Las normas", esc(t.modalidad === "Sin Muerte" ? "Sin muerte" : t.modalidad),
    `${esc(t.categoria)}.` + (temporada ? `<br>Temporada: del ${esc(temporada)}${segunda ? ` y del ${esc(segunda)}` : ""}.` : "")
    + `<br><a href="${esc(t.info_tramo)}" target="_blank">Ver ficha oficial</a>`, "gris");
}

// --- mapa -----------------------------------------------------------------------

async function pintarMapa(t, estacion) {
  if (mapa) mapa.remove();
  mapa = L.map("mapa", { scrollWheelZoom: false });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap" }).addTo(mapa);
  capaMapa = L.featureGroup().addTo(mapa);
  mapa.setView([t.lat, t.lon], 12);

  const punto = [t.lat, t.lon];
  const icono = (html) => L.divIcon({ className: "icono-mapa", html, iconSize: [24, 24] });
  L.marker(punto, { icon: icono("🌤️") }).bindTooltip("Aquí se calcula el tiempo (punto medio del tramo)").addTo(capaMapa);
  if (t.pueblo) {
    L.marker([t.pueblo.lat, t.pueblo.lon], { icon: icono("🏠") })
      .bindTooltip(esc(t.pueblo.nombre), { permanent: true, direction: "right", offset: [10, 0] }).addTo(capaMapa);
  }
  if (estacion) {
    L.marker([estacion.lat, estacion.lon], { icon: icono("💧") })
      .bindTooltip(`Estación de aforo: ${esc(estacion.nombre)}`).addTo(capaMapa);
    L.polyline([punto, [estacion.lat, estacion.lon]], { color: "#555", weight: 2, dashArray: "4 6" }).addTo(capaMapa);
  }

  try {
    geometrias[t.provincia] ??= geoTodo
      ? { features: geoTodo.features.filter((f) => porId[f.properties.id]?.provincia === t.provincia) }
      : await fetch(`/api/geometria?provincia=${encodeURIComponent(t.provincia)}`).then((r) => r.json());
  } catch { return; }
  const geo = geometrias[t.provincia];
  const delRio = geo.features.filter((f) => porId[f.properties.id]?.rio_mas_a === t.rio_mas_a);
  L.geoJSON({ type: "FeatureCollection", features: delRio.filter((f) => f.properties.id !== t.id) },
    { style: { color: "#888", weight: 3, opacity: 0.6 } })
    .eachLayer((l) => l.bindTooltip(esc(porId[l.feature.properties.id].nombr_tram)))
    .addTo(capaMapa);
  const propio = L.geoJSON(geo.features.find((f) => f.properties.id === t.id), { style: { color: "#1f5fa8", weight: 7 } })
    .addTo(capaMapa);
  const limites = propio.getBounds().extend(punto);
  if (estacion) limites.extend([estacion.lat, estacion.lon]);
  mapa.fitBounds(limites, { padding: [30, 30], maxZoom: 13, animate: false });
}

// --- detalles: tiempo, caudal, normativa ----------------------------------------------

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
     <code>programa/scripts/build_data.py</code> (<a href="${esc(meta.fuente_tramos)}" target="_blank">consulta WFS usada</a>).</p>
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
     precipitación (mm/hora), probabilidad de precipitación, nubosidad y horas de amanecer y anochecer. Las horas son hora local peninsular.
     La «lluvia 7 días previos» es la suma de la precipitación diaria de los 7 días anteriores
     (<a href="${esc(f.url_previos)}" target="_blank">datos</a>).</p>
     <p><b>Resumen «De un vistazo»:</b> se calcula solo con las horas de luz. Viento: casi en calma por debajo de
     ${VIENTO.calma} km/h, flojo hasta ${VIENTO.flojo}, moderado hasta ${VIENTO.moderado} y fuerte por encima;
     rachas de ${RACHA_FUERTE} km/h o más lo marcan en ámbar. Lluvia: «no se espera» si suma menos de 0,2 mm y la probabilidad
     no pasa del 30 %; «algo de lluvia» hasta 3 mm; «lluvia» por encima.</p>
     <p><b>Limitaciones:</b> la malla tiene resolución de kilómetros, así que en valles encajados el viento real puede
     diferir bastante (encauzamientos, brisas de valle). Cuanto más lejana es la fecha, menos fiable es la previsión.</p>`);
}

function fuenteCaudal(d) {
  const e = d.estacion;
  const f = d.caudal?.fuente;
  const t = d.tramo;
  let porque;
  if (t.estacion_tipo === "manual") porque = "se asignó a mano a este tramo.";
  else if (t.estacion_tipo === "rio_principal") {
    porque = `el río ${esc(t.rio_mas_a)} no tiene estación de aforo cerca, así que se usa la del <b>río principal de su
      subcuenca</b> (${esc(e.rio)}) más cercana, a ${fmt(t.estacion_dist_km)} km. <b>Es solo una referencia</b>:
      el caudal de un afluente es mucho menor, pero suele subir y bajar a la vez.`;
  } else {
    porque = `es la estación de aforo de la confederación <b>en el mismo río</b> (${esc(e.rio)}) más cercana al tramo:
      está a ${fmt(t.estacion_dist_km)} km de su punto más próximo. Se marca con 💧 en el mapa.
      Si entre el tramo y la estación hay una presa o entra un afluente importante, el caudal en el tramo puede ser distinto.`;
  }
  return bloqueFuente(
    `<a href="${esc(cuenca(e.cuenca).web)}" target="_blank">${esc(cuenca(e.cuenca).saih)}</a> (${esc(cuenca(e.cuenca).organismo)}),
     estación <a href="${esc(e.url_publica)}" target="_blank">${esc(e.nombre)} (${esc(e.codigo)})</a>
     ${f ? ` · <a href="${esc(f.url_datos)}" target="_blank">datos originales</a> · consultado ${fechaHora(f.consultado)}` : ""}.`,
    `<p><b>Por qué esta estación:</b> ${porque}</p>
     <p><b>Qué se muestra:</b> la serie horaria de caudal (m³/s) que publica la estación. Si el día elegido es hoy o futuro,
     se muestran los últimos 7 días (no existe previsión pública de caudal); si es pasado, los 7 días que terminan ese día.
     La tendencia compara la media de las últimas 24 h con la de las 24 h anteriores (más de un ±10 % = sube o baja).
     «Normal», «alto» o «bajo» compara el último dato (o la media de la semana, si es pasada) con la mediana de todo el
     histórico disponible: más de 1,5 veces es alto y menos de 0,6 veces es bajo.</p>
     <p><b>Limitaciones:</b> son datos en tiempo real, provisionales y sin validar.
     Esta confederación publica ${esc(HISTORICO_CUENCA[e.cuenca] ?? "un histórico corto")}${f && !f.solo_actual ? ` (ahora mismo, del ${fechaHora(f.historico_desde)} al ${fechaHora(f.historico_hasta)})` : ""}.
     Los aforos que hay a la salida de los embalses reflejan los desembalses, que pueden cambiar de un día para otro.</p>`);
}

function htmlSinCaudal(t) {
  const c = cuenca(t.cuenca);
  return `<div class="card"><h3>Caudal</h3>
    <p>No hay ninguna estación de aforo del ${esc(c.saih)} en este río ni en su río principal a menos de
      ${meta.max_km_rio_principal ?? 30} km, o se trata de una laguna o un canal. Muchos arroyos no tienen ninguna
      estación que mida su caudal.</p>
    ${c.web ? `<p class="nota">Puedes ver las estaciones de la cuenca en la <a href="${esc(c.web)}" target="_blank">web del ${esc(c.saih)}</a>.</p>` : ""}
  </div>`;
}

function htmlMeteo(m, t) {
  const r = m.resumen;
  const h = m.horas;
  const filas = h.time.map((ti, i) => {
    const [ico, desc] = wmo(h.weather_code[i]);
    const fuerte = (h.wind_gusts_10m[i] ?? 0) >= VIENTO_FUERTE_TABLA * 1.4 || (h.wind_speed_10m[i] ?? 0) >= VIENTO_FUERTE_TABLA;
    return `<tr class="${fuerte ? "fuerte" : ""}">
      <td>${ti.slice(11, 16)}</td>
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
        · a ${fmt(m.fuente.elevacion, 0)} m de altitud</p>
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
      <details>
        <summary><h3>Tabla hora a hora</h3></summary>
        <div class="tabla-wrap"><table>
          <thead><tr><th>Hora</th><th></th><th>Temp</th><th>Viento</th><th>Racha</th><th>Dirección</th><th>Lluvia mm</th>
            ${h.precipitation_probability ? "<th>Prob.</th>" : ""}<th>Nubes</th></tr></thead>
          <tbody>${filas}</tbody>
        </table></div>
        <p class="nota">Resaltadas las horas con viento de ${VIENTO_FUERTE_TABLA} km/h o más, o rachas de ${VIENTO_FUERTE_TABLA * 1.4} km/h o más.
          La flecha indica hacia dónde sopla el viento; la letra, de dónde viene.</p>
      </details>
    </div>
    <div class="card">
      <h3>Origen de los datos del tiempo</h3>
      ${fuenteMeteo(m, t)}
    </div>`;
}

function htmlCaudal(d) {
  const c = d.caudal;
  const e = d.estacion;
  const enlace = `<a href="${esc(e.url_publica)}" target="_blank">${esc(e.nombre)} (${esc(e.codigo)})</a>`;
  if (!c.puntos.length) return `<div class="card"><h3>Caudal</h3><p class="sub">Estación ${enlace}</p><div class="aviso">${esc(c.nota)}</div>${fuenteCaudal(d)}</div>`;
  if (c.fuente?.solo_actual) {
    return `<div class="card"><h3>Caudal del río (m³/s)</h3>
      <p class="sub">Estación ${enlace} · a ${fmt(d.tramo.estacion_dist_km)} km del tramo · río ${esc(e.rio)}</p>
      <div class="kpis"><div class="kpi"><div class="v">${fmt(c.ultimo.valor, 2)}</div><div class="l">Dato actual (${fechaHora(c.ultimo.fecha)})</div></div></div>
      <div class="aviso">El ${esc(cuenca(e.cuenca).saih)} solo publica en abierto el dato actual. Para ver los últimos días,
        la tendencia y si va alto o bajo hace falta una clave gratuita de su API: <a href="como-funciona.html#ebro">cómo conseguirla</a>.</div>
      ${fuenteCaudal(d)}</div>`;
  }
  const tend = { subiendo: "↗ subiendo", bajando: "↘ bajando", estable: "→ estable" }[c.tendencia] ?? "–";
  const aviso = d.tramo.estacion_tipo === "rio_principal"
    ? `<div class="aviso">Este río no tiene estación de aforo cerca: se muestra la del río ${esc(e.rio)}, como referencia.</div>` : "";
  return `
    <div class="card">
      <h3>Caudal del río (m³/s)</h3>
      <p class="sub">Estación ${enlace} · a ${fmt(d.tramo.estacion_dist_km)} km del tramo · río ${esc(e.rio)}</p>
      ${aviso}
      <div class="kpis">
        <div class="kpi"><div class="v">${fmt(c.ultimo.valor, 2)}</div><div class="l">Último dato (${fechaHora(c.ultimo.fecha)})</div></div>
        <div class="kpi"><div class="v">${fmt(c.media, 2)}</div><div class="l">Media 7 días</div></div>
        <div class="kpi"><div class="v">${fmt(c.mediana_historico, 2)}</div><div class="l">Lo normal estos días (mediana)</div></div>
        <div class="kpi"><div class="v">${tend}</div><div class="l">Tendencia (24 h)</div></div>
      </div>
      <div class="grafico" style="margin-top:12px"><canvas id="gCaudal"></canvas></div>
      <p class="nota">${esc(c.nota)}</p>
      ${fuenteCaudal(d)}
    </div>`;
}

function htmlInfoTramo(t) {
  const filas = [
    ["Desde", t.lim_superi],
    ["Hasta", t.lim_inferi],
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
      <p>Puede no reflejar cambios posteriores: consulta la
        <a href="${esc(t.info_tramo)}" target="_blank">ficha oficial del tramo en pescacastillayleon.es</a>.</p>
      ${fuenteTramo()}
    </div>`;
}

// --- gráficos ---------------------------------------------------------------

function opcionesBase() {
  Chart.defaults.color = getComputedStyle(document.body).color;
  Chart.defaults.borderColor = "rgba(127,127,127,.2)";
  Chart.defaults.font.size = 14;
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
        tooltip: { callbacks: { afterBody: (it) => `Viene del ${cardinalLargo(h.wind_direction_10m[it[0].dataIndex])}` } },
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
