"use strict";

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
let fechaElegida = null;
let puntoElegido = null;    // zona elegida del tramo (índice del pueblo) o null = punto medio
let graficosTiempo = [];   // gráficas del tiempo (se rehacen al cambiar de zona del tramo)
let marcadorTiempo = null; // cuadrado negro del mapa de resultados: dónde se calcula el tiempo

// --- utilidades -------------------------------------------------------------

const CODIGOS_WMO = {
  0: ["", "Despejado"], 1: ["", "Casi despejado"], 2: ["", "Algunas nubes"], 3: ["", "Nublado"],
  45: ["", "Niebla"], 48: ["", "Niebla con escarcha"],
  51: ["", "Llovizna débil"], 53: ["", "Llovizna"], 55: ["", "Llovizna intensa"],
  56: ["", "Llovizna helada"], 57: ["", "Llovizna helada"],
  61: ["", "Lluvia débil"], 63: ["", "Lluvia"], 65: ["", "Lluvia fuerte"],
  66: ["", "Lluvia helada"], 67: ["", "Lluvia helada"],
  71: ["", "Nieve débil"], 73: ["", "Nieve"], 75: ["", "Nieve fuerte"], 77: ["", "Granos de nieve"],
  80: ["", "Chubascos"], 81: ["", "Chubascos"], 82: ["", "Chubascos fuertes"],
  85: ["", "Chubascos de nieve"], 86: ["", "Chubascos de nieve"],
  95: ["", "Tormenta"], 96: ["", "Tormenta con granizo"], 99: ["", "Tormenta con granizo"],
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
  $("filtroTramos").addEventListener("change", () => {
    dibujarTramosMapa();
    if ($("buscar").value) buscar(); else { rellenarRios(); listarPorRio(); }
  });
  $("buscar").addEventListener("input", buscar);
  $("fecha").addEventListener("change", () => $("fecha").value && elegirDia($("fecha").value));

  document.querySelectorAll(".acciones button[data-ir]").forEach((b) => b.addEventListener("click", () => irAPaso(Number(b.dataset.ir))));
  // Los pasos ya hechos de la barra de arriba se pueden pulsar para volver a ellos
  document.querySelectorAll("#progreso button").forEach((b) => b.addEventListener("click", () => {
    if (b.closest("li").classList.contains("hecho")) irAPaso(Number(b.dataset.ir));
  }));
  pintarRecientes();
  pintarDias();
  crearMapaElegir();
  restaurar();
  window.addEventListener("popstate", restaurar);
}

const tienePueblos = (t) => Boolean(t?.puntos?.length);
let ultimoPaso = 1;

// --- navegación e historial (para que Atrás/Adelante del navegador funcionen) ---

// La URL (#…) guarda el paso y lo elegido; cada avance añade una entrada al historial.
// #tramo=P-7&fecha=2026-10-06&punto=2&paso=4 abre directamente la consulta.
function construirHash(paso) {
  const p = new URLSearchParams();
  if (tramoElegido) p.set("tramo", tramoElegido.id);
  if (fechaElegida && paso >= 3) p.set("fecha", fechaElegida);
  if (paso >= 4 && tienePueblos(tramoElegido)) p.set("punto", puntoElegido ?? "medio");
  p.set("paso", String(paso));
  return "#" + p.toString();
}

// Guarda el paso actual: `empujar` añade una entrada nueva (avanzar); si no, la sustituye.
function registrar(paso, empujar) {
  const estado = { paso, tramo: tramoElegido?.id ?? null, fecha: fechaElegida ?? null, punto: puntoElegido };
  if (empujar) history.pushState(estado, "", construirHash(paso));
  else history.replaceState(estado, "", construirHash(paso));
}

// Marca el día elegido (o ninguno) en los botones del paso 2
function marcarDia(fecha) {
  document.querySelectorAll("button.dia").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.fecha === fecha)));
}

// Reconstruye la pantalla desde la URL, sin tocar el historial (al cargar y con Atrás/Adelante)
function restaurar() {
  const e = history.state;
  const h = new URLSearchParams(location.hash.slice(1));
  const t = porId[e?.tramo ?? h.get("tramo")];
  if (!t) return mostrarPaso(1, { foco: false });
  const fecha = e?.fecha ?? h.get("fecha") ?? null;
  const puntoRaw = e?.punto ?? h.get("punto") ?? null;
  const paso = Number(e?.paso ?? h.get("paso")) || (!fecha ? 2 : puntoRaw != null ? 4 : tienePueblos(t) ? 3 : 4);
  mostrarEstado(t, fecha, puntoRaw, paso);
  document.querySelector(".paso:not([hidden])")?.scrollIntoView({ block: "start" });
}

// Pinta el estado (tramo/día/zona/paso) sin registrar nada en el historial
function mostrarEstado(t, fecha, puntoRaw, paso) {
  tramoElegido = t;
  fechaElegida = fecha || null;
  puntoElegido = (puntoRaw == null || puntoRaw === "medio") ? null : puntoRaw;
  recordar(t.id);
  pintarResumen();
  marcarDia(fecha);
  if (paso >= 4) {
    mostrarPaso(4, { foco: false });
    consultar(t, fecha, puntoElegido);
  } else if (paso === 3 && tienePueblos(t)) {
    pintarZonas(t);
    mostrarPaso(3, { foco: false });
  } else {
    mostrarPaso(2, { foco: false });
  }
}

// Saltar a un paso ya hecho (chips «cambiar» y barra de pasos): añade entrada al historial
function irAPaso(n) {
  if (n === 3) pintarZonas(tramoElegido);
  registrar(n, true);
  mostrarPaso(n);
}

// Muestra un solo paso del asistente, actualiza la barra de progreso y lleva el foco a su título
function mostrarPaso(n, { foco = true } = {}) {
  for (let i = 1; i <= 4; i++) $("paso" + i).hidden = i !== n;
  const conZona = tienePueblos(tramoElegido);
  document.querySelectorAll("#progreso li").forEach((li) => {
    const k = Number(li.dataset.paso);
    li.classList.toggle("hecho", k < n);
    li.classList.toggle("saltado", k === 3 && !conZona && n > 2);
    if (k === n) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
    const disponible = k < n && !(k === 3 && !conZona);
    li.classList.toggle("hecho", disponible);
    li.querySelector("button").setAttribute("aria-disabled", String(!disponible && k !== n));
  });
  ultimoPaso = Math.max(ultimoPaso, n);
  if (n === 1 && mapaElegir) {
    // El mapa pudo crearse oculto: recalcula su tamaño y céntralo en el último tramo elegido
    setTimeout(() => {
      mapaElegir.invalidateSize();
      if (tramoElegido) mapaElegir.setView([tramoElegido.lat, tramoElegido.lon], 10, { animate: false });
    }, 0);
  }
  if (foco) {
    const titulo = $("titulo" + n);
    $("paso" + n).scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    titulo?.focus({ preventScroll: true });
    avisar(titulo?.textContent ?? "");
  }
}

function avisar(texto) {
  $("avisos").textContent = "";
  setTimeout(() => ($("avisos").textContent = texto), 50);
}

// Lo ya elegido, como fichas-botón para cambiar cada cosa (tramo, día, zona)
const LAPIZ = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L18.5 9.5a2 2 0 0 0-2.8-2.8L5 17.2z"/><path d="M14 7l3 3"/></svg>`;
function lineaElegido(t, fecha, lugar) {
  const chip = (eti, valor, ir) => `<button class="elegido-chip" data-ir="${ir}" title="Cambiar ${eti}">
      <span class="ec-texto"><span class="ec-eti">${eti}</span><span class="ec-valor">${valor}</span></span>${LAPIZ}</button>`;
  const partes = [chip("tramo", esc(t.nombr_tram), 1)];
  if (fecha) partes.push(chip("día", esc(nombreDia(fecha)), 2));
  if (lugar && tienePueblos(t)) partes.push(chip("zona", esc(lugar.tipo === "pueblo" ? lugar.pueblo.nombre : "punto medio"), 3));
  return partes.join("");
}

function conectarCambios(contenedor) {
  contenedor.querySelectorAll("button[data-ir]").forEach((b) => b.addEventListener("click", () => irAPaso(Number(b.dataset.ir))));
}

function pintarResumen() {
  const t = tramoElegido;
  if (!t) return;
  $("resumen2").innerHTML = lineaElegido(t);
  $("resumen3").innerHTML = lineaElegido(t, fechaElegida);
  conectarCambios($("resumen2"));
  conectarCambios($("resumen3"));
}

// --- mapa para elegir tramo ---------------------------------------------------

const ESTILO_TRAMO = {
  truchera: { color: "#1f5fa8", weight: 4, opacity: 0.85, dashArray: null },
  otras: { color: "#b8741a", weight: 4, opacity: 0.85, dashArray: null },
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
        ${esc(t.truchera)}${especiesExoticas(t)}<br>
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

// Filtro "Qué tramos ver": por defecto, todos
const FILTROS = {
  todos: () => true,
  pescables: (t) => t.modalidad !== "Vedado",
  trucheras: (t) => t.truchera === "Aguas trucheras",
  no_trucheras: (t) => t.truchera !== "Aguas trucheras",
};
const visible = (t) => (FILTROS[$("filtroTramos").value] ?? FILTROS.todos)(t);
const especiesExoticas = (t) => (t.zonas_especies?.length
  ? ` · zona de ${[...new Set(t.zonas_especies.map((z) => z.especie.toLowerCase()))].join(" y ")}` : "");

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
  if (!prov) {
    $("listaTramos").innerHTML = `<p class="vacio">Aquí aparecerán los tramos cuando escribas un nombre o elijas una provincia.</p>`;
    resaltarEnMapa([]);
    return;
  }
  if (!rio) {
    // Solo provincia: se listan sus ríos para elegir uno con un toque
    const enProv = tramos.filter((t) => t.provincia === prov && visible(t));
    const cuenta = {};
    enProv.forEach((t) => (cuenta[t.rio_mas_a] = (cuenta[t.rio_mas_a] || 0) + 1));
    const rios = Object.keys(cuenta).sort((a, b) => a.localeCompare(b, "es"));
    $("listaTramos").innerHTML = `<p class="etiqueta">${rios.length} ríos con tramos en ${esc(prov)}. Elige uno:</p>`
      + rios.map((r) => `<button class="rio" data-rio="${esc(r)}"><span class="tramo-nombre">${esc(r)}</span>
          <span class="tramo-info">${cuenta[r]} tramo${cuenta[r] === 1 ? "" : "s"}</span></button>`).join("");
    $("listaTramos").querySelectorAll("button.rio").forEach((b) => b.addEventListener("click", () => {
      $("rio").value = b.dataset.rio;
      listarPorRio();
      $("listaTramos").querySelector("button")?.focus();
    }));
    resaltarEnMapa(enProv);
    return;
  }
  // Ya vienen ordenados de aguas arriba a aguas abajo
  const lista = tramos.filter((t) => t.provincia === prov && t.rio_mas_a === rio && visible(t));
  resaltarEnMapa(lista);
  pintarLista($("listaTramos"), lista, `Tramos del río ${rio} en ${prov}, de arriba abajo:`);
}

function buscar() {
  const q = normalizar($("buscar").value.trim());
  if (q.length < 2) {
    $("listaTramos").innerHTML = `<p class="vacio">Aquí aparecerán los tramos cuando escribas un nombre o elijas una provincia.</p>`;
    resaltarEnMapa([]);
    return;
  }
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
  return `<button class="tramo ${vedado ? "es-vedado" : t.truchera === "Aguas trucheras" ? "" : "no-truchera"}" data-id="${esc(t.id)}">
    <span class="tramo-nombre">${esc(t.nombr_tram)} <small>${rioDe(t)}</small></span>
    <span class="tramo-info">${esc(t.categoria)} · ${vedado ? `<span class="marca-vedado">Vedado</span>` : esc(t.modalidad)}
      · ${t.truchera === "Aguas trucheras" ? "truchera" : "no truchera"}${especiesExoticas(t)}
      · junto a ${esc(t.pueblo?.nombre)} (${esc(t.provincia)})</span>
  </button>`;
}

function pintarLista(contenedor, lista, titulo) {
  contenedor.innerHTML = lista.length
    ? `<p class="etiqueta">${esc(titulo)}</p>` + lista.map(tarjetaTramo).join("")
    : `<p class="etiqueta">No hay tramos que coincidan.${$("filtroTramos").value === "todos" ? "" : " Prueba a elegir «Todos los tramos» en «Qué tramos ver»."}</p>`;
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

function elegirTramo(id) {
  tramoElegido = porId[id];
  fechaElegida = null;
  puntoElegido = null;
  recordar(id);
  pintarResumen();
  marcarDia(null);
  registrar(2, true);
  mostrarPaso(2);
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
    botones.push(`<button class="dia" data-fecha="${iso}" aria-pressed="false"><b>${esc(arriba)}</b><span>${esc(abajo)}</span></button>`);
  }
  $("dias").innerHTML = botones.join("");
  $("dias").querySelectorAll("button.dia").forEach((b) => b.addEventListener("click", () => elegirDia(b.dataset.fecha)));
  $("fecha").max = isoLocal(sumarDias(15));
}

function elegirDia(fecha) {
  if (!tramoElegido) return;
  fechaElegida = fecha;
  puntoElegido = null;
  marcarDia(fecha);
  pintarResumen();
  const t = tramoElegido;
  if (tienePueblos(t)) {
    // Tramo largo: antes del resultado, preguntar por la zona
    pintarZonas(t);
    registrar(3, true);
    return mostrarPaso(3);
  }
  registrar(4, true);
  mostrarPaso(4, { foco: false });
  consultar(t, fecha, null);
}

// Paso 3: lista de pueblos del tramo
function pintarZonas(t) {
  $("guiaZona").textContent = `Este tramo mide ${fmt(t.long_km)} km y el tiempo puede cambiar de un extremo a otro. `
    + `Elige el pueblo más cercano a donde vas a pescar. Los kilómetros se cuentan desde el límite superior del tramo`
    + (t.lim_superi ? ` («${t.lim_superi}»).` : ".");
  $("zonas").innerHTML = `<button class="zona medio" data-n="medio"><span class="tramo-nombre">No lo sé: el punto medio del tramo</span>
      <span class="tramo-info">junto a ${esc(t.pueblo?.nombre)}</span></button>`
    + t.puntos.map((p, i) => `<button class="zona" data-n="${i}"><span class="tramo-nombre">${esc(p.pueblo)}</span>
      <span class="zona-km">km ${fmt(p.km)}</span></button>`).join("");
  $("zonas").querySelectorAll("button.zona").forEach((b) => b.addEventListener("click", () => elegirZona(b.dataset.n === "medio" ? null : b.dataset.n)));
}

function elegirZona(n) {
  const t = tramoElegido;
  const lugar = lugarTiempo(t, n);
  puntoElegido = lugar.n;
  registrar(4, true);
  mostrarPaso(4, { foco: false });
  consultar(t, fechaElegida, lugar.n);
}

// Dónde se pide el tiempo: punto medio del tramo o, en tramos largos, junto a un pueblo
function lugarTiempo(t, n) {
  const p = n != null && n !== "" ? t.puntos?.[Number(n)] : null;
  if (!p) return { tipo: "medio", n: null, lat: t.lat, lon: t.lon, pueblo: t.pueblo };
  return { tipo: "pueblo", n: Number(n), lat: p.lat, lon: p.lon, km: p.km,
    pueblo: { nombre: p.pueblo, municipio: p.municipio, provincia: t.provincia, dist_km: p.dist_km } };
}

// --- paso 3: resultados ---------------------------------------------------------

async function consultar(t, fecha, punto = null) {
  const id = ++consultaActual;
  const lugar = lugarTiempo(t, punto);
  graficos.forEach((g) => g.destroy());
  graficos = [];
  const estacion = estacionesPorId[t.estacion];

  const v = veredictoNormas(t, fecha);
  const leyenda = `<span class="leyenda"><i class="m m-tiempo"></i>donde se calcula el tiempo`
    + (t.puntos?.length ? ` · <i class="m m-pueblo"></i>pueblos del tramo (púlsalos para ver su tiempo)` : ` · <i class="m m-referencia"></i>pueblo de referencia`)
    + (t.estacion ? ` · <i class="m m-estacion"></i>estación de aforo` : "") + `</span>`;
  $("paso4").innerHTML = `
    <div class="encabezado-paso">
      <p class="elegido" id="resumen4">${lineaElegido(t, fecha, lugar)}</p>
      <h1 id="titulo4" tabindex="-1">${esc(t.nombr_tram)}</h1>
      <p class="res-meta">${t.nombr_tram !== t.rio_mas_a ? `Río ${esc(t.rio_mas_a)} · ` : ""}${esc(t.provincia)} · ${esc(nombreDia(fecha))}
        · <span id="vistazoLugar">${esc(textoLugar(lugar))}</span></p>
    </div>

    <div class="veredicto">
      <p class="grande ${v.clase}">${esc(v.texto)}</p>
      <p class="frase"><span id="fraseTiempo">Consultando el tiempo…</span> <span id="fraseRio"></span></p>
    </div>

    <h2 class="solo-lectores">Resumen del día</h2>
    <div class="fichas">
      <div id="fCielo"><p class="cargando">Consultando el tiempo…</p></div>
      <div id="fViento"></div>
      <div id="fLluvia"></div>
      <div id="fTemp"></div>
      <div id="fRio"><p class="cargando">Consultando el río…</p></div>
      <div id="fNormas">${fichaNormasDia(t, fecha)}</div>
    </div>

    <div class="detalles">
      <h2>Más información</h2>
      <p>El mapa del tramo, el tiempo hora a hora, el caudal del río y la normativa completa.</p>
      <section class="seccion-detalle" aria-labelledby="sec1"><h3 id="sec1"><span class="n">1</span>El mapa</h3>
        <div id="mapa" role="region" aria-label="Mapa del tramo"></div>
        <p class="nota">Tramo en azul · ${leyenda}</p></section>
      <section class="seccion-detalle" aria-labelledby="sec2"><h3 id="sec2"><span class="n">2</span>El tiempo hora a hora</h3>
        <div class="bloque" id="bloqueMeteo"><p class="cargando">Consultando el tiempo en Open-Meteo…</p></div></section>
      <section class="seccion-detalle" aria-labelledby="sec3"><h3 id="sec3"><span class="n">3</span>El río</h3>
        <div class="bloque" id="bloqueCaudal">${t.estacion
          ? `<p class="cargando">Consultando el caudal en el ${esc(cuenca(t.cuenca).saih)} (estación ${esc(estacion?.nombre)}).
              Algunas confederaciones tardan hasta un minuto en responder; el tiempo no espera a este dato.</p>`
          : htmlSinCaudal(t)}</div></section>
      <section class="seccion-detalle" aria-labelledby="sec4"><h3 id="sec4"><span class="n">4</span>Las normas</h3>
        ${htmlNormativa(t, fecha)}</section>
    </div>`;
  conectarCambios($("resumen4"));
  $("paso4").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  $("titulo4").focus({ preventScroll: true });
  avisar(`Resultado para ${t.nombr_tram}, ${nombreDia(fecha)}: ${v.texto}. Cargando el tiempo y el río.`);

  pintarMapa(t, estacion, lugar, fecha);

  const pedir = async (ruta, ms) => {
    const r = await fetch(`${ruta}?tramo=${encodeURIComponent(t.id)}&fecha=${fecha}`, { signal: AbortSignal.timeout(ms) });
    const datos = await r.json();
    if (!r.ok) throw new Error(datos.error);
    return datos;
  };
  const mensajeError = (e) => (e.name === "TimeoutError" ? "la fuente no ha respondido a tiempo, prueba de nuevo en un rato." : e.message);

  const meteo = cargarTiempo(t, fecha, lugar);

  if (!t.estacion) {
    $("fRio").innerHTML = ficha("rio", "El río", "Sin datos", "No hay estación de aforo cerca en este río.", "gris");
    return meteo;
  }
  const caudal = pedir("/api/caudal", 150000).then((d) => {
    if (id !== consultaActual) return;
    fichaRio(d.caudal, t);
    $("bloqueCaudal").innerHTML = htmlCaudal({ tramo: t, estacion: d.estacion, caudal: d.caudal });
    if (d.caudal.puntos.length > 1) graficoCaudal(d.caudal);
  }).catch((e) => {
    if (id !== consultaActual) return;
    $("fRio").innerHTML = ficha("rio", "El río", "No disponible",
      (/no tiene datos recientes/.test(e.message)
        ? "La estación de aforo no está dando datos ahora mismo (fuera de servicio o en mantenimiento)."
        : `El ${esc(cuenca(t.cuenca).saih)} no responde ahora mismo.`)
      + `<br><button class="secundario reintentar-rio">Volver a intentarlo</button>`, "gris");
    $("paso4").querySelector(".reintentar-rio")?.addEventListener("click", () => consultar(t, fecha, lugar.n));
    $("bloqueCaudal").innerHTML = `<div class="card"><h3>Caudal</h3>
      <div class="aviso">No se pudo obtener el caudal del ${esc(cuenca(t.cuenca).saih)}: ${esc(mensajeError(e))}</div>
      ${estacion ? fuenteCaudal({ tramo: t, estacion }) : ""}</div>`;
  });

  await Promise.all([meteo, caudal]);
}

const textoLugar = (lugar) => (lugar.tipo === "pueblo"
  ? `tiempo junto a ${lugar.pueblo.nombre} (km ${fmt(lugar.km)})`
  : `tiempo en el punto medio, junto a ${lugar.pueblo?.nombre ?? "el tramo"}`);
let consultaTiempo = 0;

// Pide el tiempo para un lugar del tramo y rellena el resumen, los detalles y el mapa
function cargarTiempo(t, fecha, lugar) {
  const id = ++consultaTiempo;
  graficosTiempo.forEach((g) => g.destroy());
  graficosTiempo = [];
  ["fViento", "fLluvia", "fTemp"].forEach((f) => { $(f).hidden = false; $(f).innerHTML = ""; });
  $("fCielo").innerHTML = `<p class="cargando-mini">Consultando el tiempo…</p>`;
  if ($("fraseTiempo")) $("fraseTiempo").textContent = "Consultando el tiempo…";
  $("bloqueMeteo").innerHTML = `<p class="cargando">Consultando el tiempo en Open-Meteo…</p>`;
  if ($("vistazoLugar")) $("vistazoLugar").textContent = textoLugar(lugar);
  moverMarcadorTiempo(lugar);

  const punto = lugar.n != null ? `&punto=${lugar.n}` : "";
  return fetch(`/api/meteo?tramo=${encodeURIComponent(t.id)}&fecha=${fecha}${punto}`, { signal: AbortSignal.timeout(60000) })
    .then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error); return d; })
    .then((d) => {
      if (id !== consultaTiempo) return;
      const resumen = fichasMeteo(d.meteo);
      $("fraseTiempo").textContent = resumen;
      avisar(`Tiempo cargado: ${resumen}`);
      $("bloqueMeteo").innerHTML = htmlMeteo(d.meteo, t, lugar);
      graficosMeteo(d.meteo);
    }).catch((e) => {
      if (id !== consultaTiempo) return;
      // Fuera del plazo de previsión el mensaje es útil tal cual; si no, uno sencillo y opción de reintentar
      const fueraDePlazo = /previsión hasta/.test(e.message);
      const motivo = e.name === "TimeoutError" ? "la fuente no ha respondido a tiempo, prueba de nuevo en un rato." : e.message;
      $("fCielo").innerHTML = ficha("cielo", "El tiempo", "No disponible", fueraDePlazo ? esc(e.message)
        : `No se ha podido consultar ahora mismo.<br><button class="secundario reintentar">Volver a intentarlo</button>`, "gris");
      ["fViento", "fLluvia", "fTemp"].forEach((f) => ($(f).hidden = true));
      $("bloqueMeteo").innerHTML = `<div class="aviso">Tiempo: ${esc(motivo)}</div>`;
      $("paso4").querySelector(".reintentar")?.addEventListener("click", () => cargarTiempo(t, fecha, lugar));
    });
}

function cambiarZona(t, fecha, n) {
  const lugar = lugarTiempo(t, n);
  puntoElegido = lugar.n;
  if ($("resumen4")) { $("resumen4").innerHTML = lineaElegido(t, fecha, lugar); conectarCambios($("resumen4")); }
  registrar(4, false);   // sigue siendo el paso 4: sustituye la entrada, no crea una nueva
  avisar(`Mostrando el ${textoLugar(lugar)}`);
  cargarTiempo(t, fecha, lugar);
}

// --- "De un vistazo" ------------------------------------------------------------

// color: verde (bien), ambar (regular), rojo (mal), gris (sin datos / informativo)
const ESTADOS = { verde: "bien", ambar: "atención", rojo: "mal", gris: "" };

// Dibujos de línea para cada apartado (decorativos: el estado va escrito, no solo en el icono)
const svgIcono = (cuerpo) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${cuerpo}</svg>`;
const ICONOS = {
  cielo: svgIcono(`<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.2 4.2l1.5 1.5M18.3 18.3l1.5 1.5M2 12h2M20 12h2M4.2 19.8l1.5-1.5M18.3 5.7l1.5-1.5"/>`),
  viento: svgIcono(`<path d="M3 8h9a2.5 2.5 0 1 0-2.5-2.5"/><path d="M3 13h13a2.5 2.5 0 1 1-2.5 2.5"/><path d="M3 18h7"/>`),
  lluvia: svgIcono(`<path d="M7.5 15a4 4 0 0 1 .4-8 5 5 0 0 1 9.3 1.3A3.3 3.3 0 0 1 16.5 15z"/><path d="M9 18l-1 3M13 18l-1 3M17 18l-1 3"/>`),
  temperatura: svgIcono(`<path d="M14 14.8V5a2 2 0 1 0-4 0v9.8a4 4 0 1 0 4 0z"/><path d="M12 9v5.3"/>`),
  rio: svgIcono(`<path d="M3 7c2.5-2 4.5 2 7 0s4.5-2 7 0"/><path d="M3 12c2.5-2 4.5 2 7 0s4.5-2 7 0"/><path d="M3 17c2.5-2 4.5 2 7 0s4.5-2 7 0"/>`),
  normas: svgIcono(`<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/><path d="M10 13l1.8 1.8L15 11"/>`),
};

// Una fila del resumen, con su dibujo. El estado va escrito, no solo en color o icono.
function ficha(icono, titulo, valor, detalle, color) {
  const estado = ESTADOS[color] ? `<span class="fr-estado">· ${ESTADOS[color]}</span>` : "";
  return `<div class="fila-resumen ${color}">
    <div class="fr-icono">${ICONOS[icono] ?? ""}</div>
    <div class="fr-titulo">${esc(titulo)}</div>
    <div class="fr-valor">${valor}${estado}</div>
    ${detalle ? `<div class="fr-detalle">${detalle}</div>` : ""}
  </div>`;
}

// Índices de las horas con luz (de amanecer a anochecer)
function horasDeLuz(m) {
  const ini = Number(hora(m.sol.amanecer).slice(0, 2));
  const fin = Number(hora(m.sol.anochecer).slice(0, 2));
  return m.horas.time.map((t, i) => [Number(t.slice(11, 13)), i]).filter(([h]) => h >= ini && h <= fin).map(([, i]) => i);
}

function fichasMeteo(m) {
  const h = m.horas;
  const idx = horasDeLuz(m);
  const enLuz = (arr) => idx.map((i) => arr[i]).filter((v) => v != null);

  // Cielo: el estado más frecuente durante el día (el código WMO más alto si empatan)
  const cuenta = {};
  enLuz(h.weather_code).forEach((c) => (cuenta[c] = (cuenta[c] || 0) + 1));
  const codigo = Number(Object.entries(cuenta).sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 0);
  const [, desc] = wmo(codigo);
  $("fCielo").innerHTML = ficha("cielo", "El cielo", esc(desc || "–"),
    `Amanece a las ${hora(m.sol.amanecer)} y anochece a las ${hora(m.sol.anochecer)}`, "gris");

  // Viento (horas de luz): solo las cifras
  const vientos = enLuz(h.wind_speed_10m);
  const rachas = enLuz(h.wind_gusts_10m);
  const vmax = Math.max(...vientos);
  const rmax = Math.max(...rachas);
  const dirs = enLuz(h.wind_direction_10m);
  // Dirección dominante: media vectorial de las horas con luz
  const sx = dirs.reduce((s, d) => s + Math.sin(d * Math.PI / 180), 0);
  const cx = dirs.reduce((s, d) => s + Math.cos(d * Math.PI / 180), 0);
  const dirMedia = (Math.atan2(sx, cx) * 180 / Math.PI + 360) % 360;
  $("fViento").innerHTML = ficha("viento", "El viento", `Hasta ${fmt(vmax, 0)} km/h`,
    `Del ${cardinalLargo(dirMedia)}. Rachas de hasta ${fmt(rmax, 0)} km/h.`, "gris");

  // Lluvia (horas de luz): solo las cifras
  const lluvia = enLuz(h.precipitation);
  const total = lluvia.reduce((s, v) => s + v, 0);
  const probs = h.precipitation_probability ? enLuz(h.precipitation_probability) : [];
  const pmax = probs.length ? Math.max(...probs) : null;
  const horasLluvia = idx.filter((i) => (h.precipitation[i] ?? 0) >= 0.2).map((i) => hora(h.time[i]));
  let det = pmax != null ? `Probabilidad máxima: ${pmax}%.` : "";
  if (total >= 0.2 && horasLluvia.length) det += ` Entre las ${horasLluvia[0]} y las ${horasLluvia[horasLluvia.length - 1]}.`;
  const nocturna = h.precipitation.reduce((s, v) => s + (v ?? 0), 0) - total;
  if (nocturna >= 0.2) det += `<br>De noche: ${fmt(nocturna)} mm.`;
  $("fLluvia").innerHTML = ficha("lluvia", "La lluvia", `${fmt(total)} mm`, det, "gris");

  // Temperatura: solo las cifras
  const r = m.resumen;
  $("fTemp").innerHTML = ficha("temperatura", "La temperatura", `De ${fmt(r.temp_min, 0)} a ${fmt(r.temp_max, 0)} grados`, "", "gris");

  return `${desc || "Tiempo"} · hasta ${fmt(vmax, 0)} km/h · ${fmt(total)} mm · de ${fmt(r.temp_min, 0)} a ${fmt(r.temp_max, 0)} grados.`;
}

function fichaRio(c, t) {
  if (!c.puntos.length) {
    $("fRio").innerHTML = ficha("rio", "El río", "Sin datos", esc(c.nota), "gris");
    return;
  }
  if (c.fuente?.solo_actual) {
    $("fRio").innerHTML = ficha("rio", "El río", `${fmtCaudal(c.ultimo.valor)} m³/s`,
      `Dato de las ${hora(c.ultimo.fecha)}. El ${esc(cuenca(t.cuenca).saih)} solo deja ver el dato actual.
       <a href="como-funciona.html#ebro">Cómo verlo completo</a>`, "gris");
    return;
  }
  const tend = { subiendo: "subiendo", bajando: "bajando", estable: "estable" }[c.tendencia] ?? "–";
  const aprox = t.estacion_tipo === "rio_principal"
    ? `<br>Medido en el río ${esc(estacionesPorId[t.estacion]?.rio)}, no en este.` : "";
  if ($("fraseRio")) $("fraseRio").textContent = "";
  $("fRio").innerHTML = ficha("rio", "El río", `${fmtCaudal(c.ultimo.valor)} m³/s`,
    `Dato de las ${hora(c.ultimo.fecha)}. Lo normal estos días, unos ${fmtCaudal(c.mediana_historico)} m³/s. `
    + `Tendencia 24 h: ${tend}.` + aprox, "gris");
}

// --- mapa -----------------------------------------------------------------------

function moverMarcadorTiempo(lugar) {
  if (!marcadorTiempo) return;
  marcadorTiempo.setLatLng([lugar.lat, lugar.lon]);
  marcadorTiempo.unbindTooltip().bindTooltip(lugar.tipo === "pueblo"
    ? `Tiempo junto a ${esc(lugar.pueblo.nombre)} (km ${fmt(lugar.km)})` : "Aquí se calcula el tiempo (punto medio del tramo)");
}

async function pintarMapa(t, estacion, lugar, fecha) {
  if (mapa) mapa.remove();
  mapa = L.map("mapa", { scrollWheelZoom: false });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap" }).addTo(mapa);
  capaMapa = L.featureGroup().addTo(mapa);
  mapa.setView([t.lat, t.lon], 12);

  const punto = [t.lat, t.lon];
  const forma = (clase, tam) => L.divIcon({ className: "marcador", html: `<i class="m ${clase}"></i>`, iconSize: [tam, tam] });
  marcadorTiempo = L.marker([lugar.lat, lugar.lon], { icon: forma("m-tiempo", 18), zIndexOffset: 1000 }).addTo(capaMapa);
  moverMarcadorTiempo(lugar);
  // Pueblos a lo largo del tramo: al pulsarlos se pide su tiempo
  (t.puntos ?? []).forEach((p, i) => {
    L.marker([p.lat, p.lon], { icon: forma("m-pueblo", 14) })
      .bindTooltip(`${esc(p.pueblo)} · km ${fmt(p.km)}<br>Pulsa para ver el tiempo aquí`)
      .on("click", () => cambiarZona(t, fecha, i))
      .addTo(capaMapa);
  });
  if (t.pueblo && !t.puntos?.length) {
    L.marker([t.pueblo.lat, t.pueblo.lon], { icon: forma("m-referencia", 14) })
      .bindTooltip(esc(t.pueblo.nombre), { permanent: true, direction: "right", offset: [10, 0] }).addTo(capaMapa);
  }
  if (estacion) {
    L.marker([estacion.lat, estacion.lon], { icon: forma("m-estacion", 14) })
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

function fuenteMeteo(m, t, lugar) {
  const f = m.fuente;
  const prevision = f.api === "prevision";
  return bloqueFuente(
    `<a href="https://open-meteo.com" target="_blank">Open-Meteo</a>,
     ${prevision ? "API de previsión" : "API de archivo histórico"}, ${lugar.tipo === "pueblo"
        ? `para el río junto a ${textoPueblo(lugar.pueblo)}, km ${fmt(lugar.km)} del tramo`
        : `para el punto medio del tramo junto a ${textoPueblo(t.pueblo)}`} ·
     <a href="${esc(f.url)}" target="_blank">ver datos originales (JSON)</a> · consultado ${fechaHora(f.consultado)}.`,
    `<p><b>Dónde:</b> ${lugar.tipo === "pueblo"
        ? `el tiempo se pide para el <b>punto del río más cercano a ${textoPueblo(lugar.pueblo)}</b> (${lugar.lat}, ${lugar.lon}),
           a ${fmt(lugar.pueblo.dist_km)} km del pueblo y en el kilómetro ${fmt(lugar.km)} del tramo contando desde su límite de
           arriba. Está marcado con un cuadrado negro en el mapa. Los pueblos del tramo son los núcleos habitados (capa oficial de la Junta) que
           están a menos de ${meta.puntos_tramo?.max_km_pueblo_rio ?? 2} km del río.`
        : `el tiempo se pide para las coordenadas del <b>punto medio del tramo</b> (${t.lat}, ${t.lon}), marcado con un cuadrado negro en el
           mapa, y no para el centro del pueblo. El pueblo más cercano a ese punto es ${textoPueblo(t.pueblo)}, a
           ${fmt(t.pueblo?.dist_km)} km (círculo negro en el mapa); se indica como referencia y sale de la capa oficial de núcleos de
           población de la Junta (IDECyL).${t.puntos?.length ? " En este tramo largo puedes elegir arriba el pueblo más cercano a donde vas a pescar." : ""}`}
     Open-Meteo devuelve la celda de su malla más cercana:
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
     <p><b>Resumen «De un vistazo»:</b> el viento máximo, las rachas, la lluvia total y las temperaturas se calculan
     solo con las horas de luz (de amanecer a anochecer); la lluvia de noche se indica aparte.</p>
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
      está a ${fmt(t.estacion_dist_km)} km de su punto más próximo. Se marca con un rombo azul en el mapa.
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

function htmlMeteo(m, t, lugar) {
  const r = m.resumen;
  const h = m.horas;
  const filas = h.time.map((ti, i) => {
    const [ico, desc] = wmo(h.weather_code[i]);
    const fuerte = (h.wind_gusts_10m[i] ?? 0) >= VIENTO_FUERTE_TABLA * 1.4 || (h.wind_speed_10m[i] ?? 0) >= VIENTO_FUERTE_TABLA;
    return `<tr class="${fuerte ? "fuerte" : ""}">
      <td>${ti.slice(11, 16)}</td>
      <td>${esc(desc)}</td>
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
      <h3>Tiempo junto a ${esc(lugar.pueblo?.nombre ?? "el tramo")}</h3>
      <p class="sub">${lugar.tipo === "pueblo"
        ? `Previsión para el río junto a ${textoPueblo(lugar.pueblo)}, km ${fmt(lugar.km)} del tramo`
        : `Previsión para el punto medio del tramo, a ${fmt(t.pueblo?.dist_km)} km de ${textoPueblo(t.pueblo)}`}
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
          <thead><tr><th>Hora</th><th>Cielo</th><th>Temp</th><th>Viento</th><th>Racha</th><th>Dirección</th><th>Lluvia mm</th>
            ${h.precipitation_probability ? "<th>Prob.</th>" : ""}<th>Nubes</th></tr></thead>
          <tbody>${filas}</tbody>
        </table></div>
        <p class="nota">Resaltadas las horas con viento de ${VIENTO_FUERTE_TABLA} km/h o más, o rachas de ${VIENTO_FUERTE_TABLA * 1.4} km/h o más.
          La flecha indica hacia dónde sopla el viento; la letra, de dónde viene.</p>
      </details>
    </div>
    <div class="card">
      <h3>Origen de los datos del tiempo</h3>
      ${fuenteMeteo(m, t, lugar)}
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

// --- gráficos ---------------------------------------------------------------

function opcionesBase() {
  Chart.defaults.color = getComputedStyle(document.body).color;
  Chart.defaults.borderColor = "rgba(127,127,127,.2)";
  Chart.defaults.font.size = 14;
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  return { responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false } };
}

function graficosMeteo(m) {
  const h = m.horas;
  const etiquetas = h.time.map((t) => t.slice(11, 16));

  graficosTiempo.push(new Chart($("gViento"), {
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

  graficosTiempo.push(new Chart($("gTemp"), {
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
