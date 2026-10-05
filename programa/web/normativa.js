"use strict";
// Normativa de pesca de un tramo: interpretar sus fechas y días hábiles, saber si un día
// concreto se puede pescar y dibujar la ficha completa (con la estructura de la ficha oficial).
// Usa esc() y fmt() de app.js.

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto",
  "septiembre", "octubre", "noviembre", "diciembre"];
// Índice de día de JavaScript (0 = domingo). Incluye las erratas que trae la capa oficial.
const DIAS_SEMANA = {
  domingo: 0, lunes: 1, martes: 2, mrtes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6, sanado: 6,
};
const NOMBRE_DIA = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const ORDINALES = { primer: 1, primero: 1, segundo: 2, tercer: 3, tercero: 3, cuarto: 4 };

const sinTildes = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

// "15 de mayo", "01 de enero", "Último sábado de marzo", "Tercer sábado de marzo"... -> Date (o null)
function fechaNormativa(texto, anio) {
  const t = sinTildes(texto);
  let m = t.match(/^(\d{1,2}) de ([a-z]+)$/);
  if (m && MESES.includes(m[2])) return new Date(anio, MESES.indexOf(m[2]), Number(m[1]));
  m = t.match(/^(ultimo|primer|primero|segundo|tercer|tercero|cuarto) ([a-z]+) de ([a-z]+)$/);
  if (m && MESES.includes(m[3]) && m[2] in DIAS_SEMANA) {
    const mes = MESES.indexOf(m[3]);
    const dia = DIAS_SEMANA[m[2]];
    if (m[1] === "ultimo") {
      const d = new Date(anio, mes + 1, 0);
      while (d.getDay() !== dia) d.setDate(d.getDate() - 1);
      return d;
    }
    const d = new Date(anio, mes, 1);
    while (d.getDay() !== dia) d.setDate(d.getDate() + 1);
    d.setDate(d.getDate() + 7 * (ORDINALES[m[1]] - 1));
    return d;
  }
  return null;
}

// Domingo de Pascua (algoritmo de Meeus/Jones/Butcher)
function pascua(anio) {
  const a = anio % 19, b = Math.floor(anio / 100), c = anio % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(anio, mes - 1, dia);
}

const claveDia = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

// Festivos nacionales y de Castilla y León (no incluye los locales de cada pueblo)
function festivos(anio) {
  const p = pascua(anio);
  const relativo = (n) => { const d = new Date(p); d.setDate(d.getDate() + n); return d; };
  const lista = [
    [new Date(anio, 0, 1), "Año Nuevo"], [new Date(anio, 0, 6), "Reyes"],
    [relativo(-3), "Jueves Santo"], [relativo(-2), "Viernes Santo"],
    [new Date(anio, 3, 23), "Día de Castilla y León"], [new Date(anio, 4, 1), "Día del Trabajo"],
    [new Date(anio, 7, 15), "Asunción"], [new Date(anio, 9, 12), "Fiesta Nacional"],
    [new Date(anio, 10, 1), "Todos los Santos"], [new Date(anio, 11, 6), "Constitución"],
    [new Date(anio, 11, 8), "Inmaculada"], [new Date(anio, 11, 25), "Navidad"],
  ];
  return Object.fromEntries(lista.map(([d, n]) => [claveDia(d), n]));
}

// ¿Está `d` entre los textos de inicio y fin? Soporta periodos que cruzan el fin de año.
function dentroDePeriodo(d, ini, fin) {
  if (!ini || !fin) return null;
  const a = fechaNormativa(ini, d.getFullYear());
  let b = fechaNormativa(fin, d.getFullYear());
  if (!a || !b) return null;
  b = new Date(b.getFullYear(), b.getMonth(), b.getDate(), 23, 59);
  if (b < a) return d >= a || d <= b; // cruza el fin de año, p. ej. 16 de octubre - 15 de febrero
  return d >= a && d <= b;
}

const listaDias = (texto) => String(texto ?? "").split(",").map(sinTildes).filter(Boolean);

// ¿Es `d` día hábil según la lista ("Lunes, Martes, ..., Festivo")?
function diaEnLista(d, texto, festivo) {
  const dias = listaDias(texto);
  if (!dias.length) return false;
  if (festivo && dias.includes("festivo")) return true;
  return dias.some((x) => DIAS_SEMANA[x] === d.getDay());
}

/**
 * Qué se puede hacer en el tramo `t` el día `iso` (AAAA-MM-DD).
 * Devuelve { estado: "vedado"|"fuera"|"no_habil"|"sin_muerte"|"con_muerte"|"ambas"|"temporada"|"desconocido",
 *            periodo, festivo, avisoFestivo, cangrejo }
 */
function estadoDia(t, iso) {
  const d = new Date(iso + "T12:00");
  const nombreFestivo = festivos(d.getFullYear())[claveDia(d)] ?? null;
  const res = { festivo: nombreFestivo, cangrejo: estadoCangrejo(t, d, nombreFestivo) };
  if (t.modalidad === "Vedado") return { ...res, estado: "vedado" };

  const periodos = [
    { n: 1, ini: t.per1_pec_i, fin: t.per1_pec_f, sm: t.dp1_pec_sm, cm: t.dp1_pec_cm },
    { n: 2, ini: t.per2_pec_i, fin: t.per2_pec_f, sm: t.dp2_pec_sm, cm: t.dp2_pec_cm },
  ].filter((p) => p.ini && p.fin);
  if (!periodos.length) return { ...res, estado: "desconocido" };

  const resultados = periodos.map((p) => ({ p, dentro: dentroDePeriodo(d, p.ini, p.fin) }));
  if (resultados.every((r) => r.dentro === null)) return { ...res, estado: "desconocido" };
  const activo = resultados.find((r) => r.dentro)?.p;
  if (!activo) return { ...res, estado: "fuera" };

  const sinListas = !listaDias(activo.sm).length && !listaDias(activo.cm).length;
  if (sinListas) return { ...res, estado: "temporada", periodo: activo };
  const sm = diaEnLista(d, activo.sm, nombreFestivo);
  const cm = diaEnLista(d, activo.cm, nombreFestivo);
  // Si el día no es hábil pero la lista incluye festivos, puede que sea festivo local
  const avisoFestivo = !sm && !cm && !nombreFestivo
    && [activo.sm, activo.cm].some((x) => listaDias(x).includes("festivo"));
  const estado = sm && cm ? "ambas" : sm ? "sin_muerte" : cm ? "con_muerte" : "no_habil";
  return { ...res, estado, periodo: activo, avisoFestivo };
}

function estadoCangrejo(t, d, festivo) {
  if (t.ord_cangre !== "Sí" || t.modalidad === "Vedado") return null;
  const periodos = [
    { ini: t.per1_c_i, fin: t.per1_c_f, dias: t.dp1_cang_c },
    { ini: t.per2_c_i, fin: t.per2_c_f, dias: t.dp2_cang_c },
  ].filter((p) => p.ini && p.fin);
  const activo = periodos.find((p) => dentroDePeriodo(d, p.ini, p.fin));
  if (!activo) return "fuera";
  return !listaDias(activo.dias).length || diaEnLista(d, activo.dias, festivo) ? "si" : "no_habil";
}

// --- textos ------------------------------------------------------------------

const minuscula = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const textoPeriodo = (ini, fin) => (ini && fin ? `del ${minuscula(ini)} al ${minuscula(fin)}` : "");

function temporadaTexto(t) {
  const p1 = textoPeriodo(t.per1_pec_i, t.per1_pec_f);
  const p2 = textoPeriodo(t.per2_pec_i, t.per2_pec_f);
  return [p1, p2].filter(Boolean).join(" y ");
}

// Ficha "Las normas" del resumen De un vistazo
function fichaNormasDia(t, iso) {
  const e = estadoDia(t, iso);
  const dia = NOMBRE_DIA[new Date(iso + "T12:00").getDay()];
  const enlace = `<br><a href="${esc(t.info_tramo)}" target="_blank">Ver ficha oficial</a>`;
  const temporada = temporadaTexto(t);
  const festivo = e.festivo ? ` (festivo: ${esc(e.festivo)})` : "";
  let valor, detalle, color;
  switch (e.estado) {
    case "vedado":
      return ficha("normas", "Las normas", "Vedado", "En este tramo no se puede pescar nunca." + enlace, "rojo");
    case "fuera":
      [valor, color] = ["Cerrado ese día", "rojo"];
      detalle = `Fuera de temporada. Se puede pescar ${esc(temporada)}.`;
      break;
    case "no_habil":
      [valor, color] = ["Ese día no se pesca", "rojo"];
      detalle = `El ${dia}${festivo} no es día hábil en este tramo.`
        + (e.avisoFestivo ? " Si fuera festivo en el pueblo, sí lo sería: compruébalo." : "");
      break;
    case "sin_muerte":
      [valor, color] = ["Se puede pescar, sin muerte", "verde"];
      detalle = `El ${dia}${festivo} es día hábil <b>sin muerte</b>: hay que devolver los peces al agua.`;
      break;
    case "con_muerte":
      [valor, color] = ["Se puede pescar, con muerte", "verde"];
      detalle = `El ${dia}${festivo} es día hábil <b>con muerte</b>: se pueden sacar peces respetando tallas y cupos.`;
      break;
    case "ambas":
      [valor, color] = ["Se puede pescar", "verde"];
      detalle = `El ${dia}${festivo} es día hábil.`;
      break;
    case "temporada":
      [valor, color] = ["Se puede pescar", "verde"];
      detalle = `Está dentro de la temporada (${esc(temporada)}).`;
      break;
    default:
      [valor, color] = [esc(t.modalidad ?? "Consulta la ficha"), "gris"];
      detalle = temporada ? `Temporada: ${esc(temporada)}.` : "";
  }
  detalle += `<br>${esc(t.categoria)} · ${esc(t.modalidad)}.`;
  if (e.cangrejo === "si") detalle += "<br>Ese día también se puede pescar cangrejo.";
  return ficha("normas", "Las normas", valor, detalle + enlace, color);
}

// --- ficha completa ----------------------------------------------------------

const vacio = (v) => v === null || v === undefined || v === "" || v === "0" || v === 0;
const numeroLimpio = (v) => (/^\d+([.,]0+)?$/.test(String(v)) ? String(Math.round(parseFloat(String(v).replace(",", ".")))) : String(v));

function filaTalla(nombre, talla, cupo) {
  if (talla == null && cupo == null) return "";
  const t = vacio(talla) ? "—" : /^\d+([.,]\d+)?$/.test(String(talla)) ? `${numeroLimpio(talla)} cm` : esc(talla);
  const c = cupo == null ? "—" : String(cupo) === "0" ? "0 (no se pueden sacar)" : esc(numeroLimpio(cupo));
  return `<tr><td>${nombre}</td><td>${t}</td><td>${c}</td></tr>`;
}

function filasInfo(filas) {
  return filas.filter(([, v]) => !vacio(v)).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
}

function htmlPeriodo(n, ini, fin, sm, cm, permisos) {
  if (!ini || !fin) return "";
  const perm = vacio(permisos) ? null : String(permisos) === "Sin pase" ? "Sin pase" : numeroLimpio(permisos);
  return `<div class="periodo"><h4>${n === 1 ? "Periodo hábil" : "Segundo periodo"}: ${esc(textoPeriodo(ini, fin))}</h4>
    <dl class="info">${filasInfo([
      ["Días sin muerte", esc(sm)],
      ["Días con muerte", esc(cm)],
      ["Permisos por día", perm && esc(perm)],
    ])}</dl></div>`;
}

function htmlNormativa(t, iso) {
  const vedado = t.modalidad === "Vedado";
  const e = iso ? estadoDia(t, iso) : null;
  let html = `<div class="card normativa">`;

  html += `<dl class="info">${filasInfo([
    ["Desde", esc(t.lim_superi)],
    ["Hasta", esc(t.lim_inferi)],
    ["Longitud", t.long_km ? `${fmt(t.long_km)} km` : null],
    ["Categoría", esc(t.categoria)],
    ["Modalidad", esc(t.modalidad)],
    ["Tipo de aguas", esc(t.truchera)],
    ["Especie principal", esc(t.esp_princ)],
    ["Otras especies", esc(t.esp_secund)],
    ["Plan de pesca", t.plan_pesca && esc(t.plan_pesca.replace(/^Si$/, "Sí"))],
  ])}</dl>`;

  if (vedado) {
    html += `<div class="aviso">Tramo vedado (refugio de pesca): no se puede pescar en ningún momento.</div>`;
  } else {
    html += `<h4 class="seccion">Cuándo se puede pescar</h4>`;
    if (e?.festivo) html += `<p class="nota">El día elegido es festivo (${esc(e.festivo)}): cuenta como «Festivo» en los días hábiles.</p>`;
    html += htmlPeriodo(1, t.per1_pec_i, t.per1_pec_f, t.dp1_pec_sm, t.dp1_pec_cm, t.n_per_dia_)
      + htmlPeriodo(2, t.per2_pec_i, t.per2_pec_f, t.dp2_pec_sm, t.dp2_pec_cm, t.n_per_di_2);

    const filas = [
      filaTalla("Trucha común", t.truch_cm, t.truch_cup_),
      filaTalla("Barbos", t.barbo_cm, t.barb_cup_d),
      filaTalla("Boga, madrilla, bordallo, cacho, gobio, piscardo", t.cipr_ib_cm, t.ci_cup_dia),
      filaTalla("Carpín", t.carpin_cm, t.carp_cup_d),
      filaTalla("Tenca", t.tenca_cm, t.tenca_cup_),
      filaTalla("Hucho", t.hucho_cm, t.hucho_cup_),
      filaTalla("Especies exóticas invasoras", t.exo_inv_cm, t.eei_cup_di),
    ].join("");
    if (filas) {
      html += `<h4 class="seccion">Tallas mínimas y cupos (por pescador y día)</h4>
        <div class="tabla-wrap"><table class="tabla-normas"><thead><tr><th>Especie</th><th>Talla mínima</th><th>Cupo</th></tr></thead>
        <tbody>${filas}</tbody></table></div>`;
    }

    const cebos = filasInfo([
      ["Días con muerte: permitidos", esc(t.cys_dcm_pe)],
      ["Días con muerte: prohibidos", esc(t.cys_dcm_pr)],
      ["Días sin muerte", esc(t.cebos_sm)],
    ]);
    if (cebos) html += `<h4 class="seccion">Cebos y señuelos</h4><dl class="info">${cebos}</dl>`;

    html += `<h4 class="seccion">Otras normas</h4><dl class="info">${filasInfo([
      ["Número de cañas", vacio(t.n_canas) ? null : esc(t.n_canas)],
      ["Pesca desde aparato de flotación", esc(t.apar_flota)],
      ["Otras limitaciones", esc(t.otras_limi)],
    ])}</dl>`;
  }

  if (t.zonas_especies?.length) {
    html += `<h4 class="seccion">Especies exóticas</h4><p>Este tramo está en una zona donde se permite la pesca de
      ${t.zonas_especies.map((z) => `<b>${esc(z.especie.toLowerCase())}</b> («${esc(z.zona)}»)`).join(" y ")}.</p>`;
  }

  if (t.ord_cangre === "Sí" && !vedado) {
    html += `<h4 class="seccion">Cangrejo rojo y señal</h4><dl class="info">${filasInfo([
      ["Periodo", esc(textoPeriodo(t.per1_c_i, t.per1_c_f))],
      ["Días", esc(t.dp1_cang_c)],
      ["Segundo periodo", esc(textoPeriodo(t.per2_c_i, t.per2_c_f))],
      ["Días (2º periodo)", esc(t.dp2_cang_c)],
      ["Cebos permitidos", esc(t.ceb_c_perm)],
      ["Cebos prohibidos", esc(t.ceb_c_prh)],
      ["Reteles", esc(t.n_reteles)],
      ["Diámetro de los reteles", esc(t.diametro)],
      ["Calado de los reteles", esc(t.calado_ret)],
    ])}</dl>`;
  }

  html += `<p>Puede no reflejar cambios posteriores: consulta la
      <a href="${esc(t.info_tramo)}" target="_blank">ficha oficial del tramo en pescacastillayleon.es</a>.</p>
    ${fuenteTramo()}
  </div>`;
  return html;
}

// Frase grande del resultado: { texto, clase: "bien" | "ojo" | "mal" }
function veredictoNormas(t, iso) {
  const e = estadoDia(t, iso);
  const dia = NOMBRE_DIA[new Date(iso + "T12:00").getDay()];
  switch (e.estado) {
    case "vedado": return { texto: "Tramo vedado: aquí no se puede pescar.", clase: "mal" };
    case "fuera": return { texto: "Ese día está cerrado: fuera de temporada.", clase: "mal" };
    case "no_habil": return { texto: `El ${dia} no se puede pescar en este tramo.`, clase: "mal" };
    case "sin_muerte": return { texto: "Se puede pescar, sin muerte.", clase: "bien" };
    case "con_muerte": return { texto: "Se puede pescar, con muerte.", clase: "bien" };
    case "ambas":
    case "temporada": return { texto: "Se puede pescar.", clase: "bien" };
    default: return { texto: "Consulta la ficha oficial para saber si se puede pescar.", clase: "ojo" };
  }
}
