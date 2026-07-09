/**
 * caducidad.mjs - Computo de caducidad de instancia (art. 310/311 CPCCN).
 *
 * Es un CALCULADOR: dada la fecha del ultimo acto impulsorio, el plazo y las
 * suspensiones, devuelve la fecha exacta de caducidad descontando la feria
 * judicial (art. 311). La PRECISION depende de los datos que cargue el abogado;
 * el sistema no decide por si solo cual acto fue impulsorio ni si hubo suspensiones
 * no registradas. El abogado confirma antes de acusar o impulsar.
 *
 * Base normativa (verificada en InfoLEG - CPCCN idNorma 16547, texto actualizado;
 * art. 310 sustituido por Ley 25.488):
 *   Art. 310: 6 meses (1ra/unica instancia); 3 meses (2da/3ra, sumarisimo,
 *     ejecutivo, ejecuciones especiales, incidentes); 1 mes (incidente de caducidad).
 *   Art. 311: se cuentan desde el ultimo acto impulsorio; corren en dias inhabiles
 *     salvo feria judicial; se descuenta el tiempo de suspension/paralizacion.
 *
 * Datos por causa (columnas OPCIONALES en CAUSAS, detectadas por nombre; si no
 * estan, se usa una estimacion y se marca como aproximada):
 *   - "Ultimo impulso" / "Fecha impulso"  -> fecha del ultimo acto impulsorio.
 *   - "Caducidad meses" / "Plazo caducidad"-> plazo en meses (6, 3 o 1).
 *   - "Suspension desde" / "Suspension hasta" -> periodo suspendido a descontar.
 *
 * Fallback sin esas columnas: toma como impulso el ultimo movimiento (de CAUSAS o
 * MOVIMIENTOS) y estima el plazo (6, o 3 si detecta ejecutivo/sumarisimo/incidente/
 * 2da instancia). Igual descuenta feria.
 *
 * Solo LEE el Excel. Requiere: npm i exceljs. Se activa con EXCEL_PATH.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { JURIS, CADUCIDAD, plazoCaducidadMeses } from "./reglas-plazos.mjs";

const norm = (s) => String(s ?? "")
  .toLowerCase()
  .normalize("NFD").replace(/\p{Diacritic}/gu, "")
  .replace(/\s+/g, " ").trim();

function normExp(s) {
  const m = String(s ?? "").match(/(\d{1,7})\s*\/\s*(\d{2,4})/);
  if (m) return `${m[1]}/${m[2]}`;
  return String(s ?? "").toUpperCase().replace(/\s+/g, "").replace(/[^\dA-Z/]/g, "");
}

const DIA_MS = 24 * 60 * 60 * 1000;

function parseFecha(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) return v;
  if (typeof v === "object" && v.result instanceof Date) return v.result;
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);
  if (m) {
    const anio = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const dt = new Date(anio, Number(m[2]) - 1, Number(m[1]));
    return isNaN(dt) ? null : dt;
  }
  const dt = new Date(s);
  return isNaN(dt) ? null : dt;
}

function sumarMeses(fecha, meses) {
  const d = new Date(fecha.getTime());
  const dia = d.getDate();
  d.setMonth(d.getMonth() + meses);
  if (d.getDate() < dia) d.setDate(0);
  return d;
}

// Carga los rangos de feria judicial desde ferias-judiciales.json (en el repo).
function cargarFerias() {
  try {
    const p = fileURLToPath(new URL("../ferias-judiciales.json", import.meta.url));
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const out = [];
    for (const r of j.ferias || []) {
      const m = String(r).match(/^(\d{4}-\d{2}-\d{2})\s*\.\.\s*(\d{4}-\d{2}-\d{2})$/);
      if (m) out.push({ desde: new Date(m[1] + "T00:00:00"), hasta: new Date(m[2] + "T00:00:00") });
    }
    return out;
  } catch { return []; }
}

// Dias inhabiles (fin de semana + feriados) para prorrogar el vencimiento al 1er
// dia habil (art. 124 CPCCN, plazo de gracia). Usa el feriados.json del bot.
function cargarFeriadosSet() {
  const set = new Set();
  try {
    const p = fileURLToPath(new URL("../feriados.json", import.meta.url));
    const arr = JSON.parse(fs.readFileSync(p, "utf8"));
    for (const raw of arr) {
      const s = String(raw).trim();
      const m = s.match(/^(\d{4}-\d{2}-\d{2})\s*\.\.\s*(\d{4}-\d{2}-\d{2})$/);
      if (m) {
        let cur = new Date(m[1] + "T00:00:00Z"); const fin = new Date(m[2] + "T00:00:00Z");
        let g = 0;
        while (cur <= fin && g++ < 400) { set.add(cur.toISOString().slice(0, 10)); cur = new Date(cur.getTime() + DIA_MS); }
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) set.add(s);
    }
  } catch { /* sin feriados: solo se saltean fines de semana */ }
  return set;
}
function isoLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function esHabil(d, feriados) {
  const dow = d.getDay();
  if (dow === 0 || dow === 6) return false;
  return !feriados.has(isoLocal(d));
}
function proximoHabil(d, feriados) {
  let x = new Date(d.getTime()), g = 0;
  while (!esHabil(x, feriados) && g++ < 60) x = new Date(x.getTime() + DIA_MS);
  return x;
}

// Dias de solapamiento entre [aIni,aFin) y [bIni,bFin] (b inclusivo -> +1 dia).
function overlapDias(aIni, aFin, bIni, bFin) {
  const ini = Math.max(aIni.getTime(), bIni.getTime());
  const fin = Math.min(aFin.getTime(), bFin.getTime() + DIA_MS);
  return Math.max(0, Math.floor((fin - ini) / DIA_MS));
}

// Vencimiento = impulso + meses, extendido por los dias de feria y de suspension
// que caen dentro del periodo (esos dias no cuentan). Itera hasta estabilizar.
function computarVencimiento(impulso, meses, ferias, susDesde, susHasta) {
  const base = sumarMeses(impulso, meses);
  let venc = base, extra = -1, guarda = 0;
  while (guarda++ < 8) {
    let feriaDias = 0;
    for (const f of ferias) feriaDias += overlapDias(impulso, venc, f.desde, f.hasta);
    let susDias = 0;
    if (susDesde && susHasta) susDias = overlapDias(impulso, venc, susDesde, susHasta);
    const total = feriaDias + susDias;
    if (total === extra) return { venc, feriaDias, susDias };
    extra = total;
    venc = new Date(base.getTime() + total * DIA_MS);
  }
  return { venc, feriaDias: 0, susDias: 0 };
}

// Sinonimos por fuero para el matching (CADUCIDAD[..].excluyeFueros solo guarda el nombre
// canonico del fuero, no sus variantes de caratula/fuero). La LISTA de fueros excluidos se
// lee de reglas-plazos.mjs (fuente unica): si mañana cambia alli, esta funcion se entera
// sola. Antes la lista estaba hardcodeada aca tambien (doble mantenimiento).
const SINONIMOS_FUERO = {
  penal: /penal|criminal|correccional|casacion penal|s\/ ?inf/,
  laboral: /laboral|trabajo|\bcnt\b/,
};
function fueroExcluido(fuero, caratula) {
  const t = norm(`${fuero} ${caratula}`);
  for (const nombre of CADUCIDAD[JURIS.NACION].excluyeFueros || []) {
    const rx = SINONIMOS_FUERO[nombre];
    if (rx && rx.test(t)) return nombre;
  }
  return null;
}
function estadoCerrado(estado) {
  return /archiv|termin|finaliz|concluid|sentencia firme|cobrad|desist|caduc/i.test(String(estado || ""));
}
// Sucesiones y procesos de jurisdiccion voluntaria: la aplicacion de la caducidad de
// instancia por ausencia de contradictorio NO es pacifica en doctrina/jurisprudencia
// (el fundamento del instituto -sancion al abandono bilateral- no calza igual sin
// contraparte). No se excluyen del barrido -un incidente dentro del expediente si
// tiene contradictorio- pero se marcan para revision en vez de escalar como una causa
// contenciosa comun. [REVISION NORMATIVA REQUERIDA: jurisprudencia de Camara Civil
// sobre caducidad en sucesiones/incidentes no aportada].
// Lista ampliada a las figuras de jurisdiccion voluntaria mas comunes en civil,
// comercial y familia (no solo sucesiones/carta de ciudadania). Se agrega por
// caratula tipica; el mismo caveat aplica a todas: no hay unanimidad sobre si
// corre la caducidad sin contradictorio, y un incidente dentro del expediente
// (oposicion, tercero interesado, etc.) puede tener contradictorio real.
const RX_VOLUNTARIO = new RegExp(
  "\\b(" + [
    "carta de ciudadania", "jurisdiccion voluntaria", "informacion sumaria",
    "declaratoria de herederos", "rectificacion de partida", "inscripcion de nacimiento",
    "inscripcion de matrimonio", "inscripcion de defuncion", "reinscripcion",
    "ausencia con presuncion de fallecimiento", "simple ausencia",
    "tutela", "curatela", "guarda con fines de adopcion", "guarda preadoptiva", "adopcion",
    "autorizacion judicial", "venia judicial", "mensura", "deslinde",
    "protocolizacion", "rubrica de libros", "apertura de testamento",
    "discernimiento de tutela", "discernimiento de curatela", "nombramiento de tutor",
    "nombramiento de curador", "copia de titulo", "reconstruccion de expediente",
  ].join("|") + ")", "i"
);
function detectarTipoProceso(caratula, obs) {
  const t = norm(`${caratula} ${obs}`);
  if (/sucesi[o]n|sucesorio/.test(t)) return "sucesorio";
  if (RX_VOLUNTARIO.test(t)) return "voluntario";
  return null;
}
// Plazo en meses segun tipo/instancia. Regla NACION (CPCCN art. 310) desde reglas-plazos.mjs
// (fuente unica para los 3 fueros); no se hardcodea el numero aca.
// La caratula es donde CASI SIEMPRE figura el tipo de proceso ("SUMARISIMO", "EJECUTIVO"):
// antes no entraba en el texto analizado, asi que ninguna causa detectaba el plazo de 3
// meses por caratula y todo caia al default de 6 (el doble del plazo real).
function plazoEstimado(fuero, estado, obs, caratula) {
  return plazoCaducidadMeses(JURIS.NACION, { texto: `${fuero} ${caratula} ${estado} ${obs}` });
}

function elegirHoja(wb, rx) { return wb.worksheets.find((w) => rx.test(w.name)); }
function hallarHeader(ws) {
  let mejor = { fila: 1, distintos: -1 };
  for (let r = 1; r <= Math.min(8, ws.rowCount || 8); r++) {
    const vals = new Set();
    ws.getRow(r).eachCell({ includeEmpty: false }, (c) => { const t = norm(c.text); if (t) vals.add(t); });
    if (vals.size > mejor.distintos) mejor = { fila: r, distintos: vals.size };
  }
  return mejor.fila;
}
function col(ws, filaHeader, pred) {
  let found = null;
  ws.getRow(filaHeader).eachCell({ includeEmpty: false }, (c, i) => { if (found == null && pred(norm(c.text))) found = i; });
  return found;
}

export async function calcularCaducidad() {
  const carteraDefault = fileURLToPath(new URL("../cartera-pjn.xlsx", import.meta.url));
  const entrada = process.env.CARTERA_XLSX || (fs.existsSync(carteraDefault) ? carteraDefault : process.env.EXCEL_PATH);
  if (!entrada || !fs.existsSync(entrada)) return { items: [], nota: "sin cartera-pjn.xlsx ni EXCEL_PATH" };
  const avisoDias = Number(process.env.CADUCIDAD_AVISO_DIAS || 45);
  const mesesDefault = Number(process.env.CADUCIDAD_MESES_DEFAULT || 6);

  let ExcelJS;
  try { ExcelJS = (await import("exceljs")).default; }
  catch { return { items: [], nota: "falta exceljs" }; }

  const ferias = cargarFerias();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(entrada);

  const wsC = elegirHoja(wb, /causa|exped/i);
  if (!wsC) return { items: [], nota: "sin hoja CAUSAS" };
  const h = hallarHeader(wsC);
  const cNro = col(wsC, h, (x) => (x.includes("causa") || x.includes("exped") || x.includes("nro")) && !x.includes("caratula"));
  const cCar = col(wsC, h, (x) => x.includes("caratula"));
  const cFuero = col(wsC, h, (x) => x.includes("fuero") || x.includes("rama"));
  const cEstado = col(wsC, h, (x) => x.includes("estado"));
  const cUlt = col(wsC, h, (x) => x.includes("ult") && x.includes("mov"));
  const cObs = col(wsC, h, (x) => x.includes("observ"));
  // Columnas opcionales para computo preciso:
  const cImpulso = col(wsC, h, (x) => x.includes("impulso"));
  const cMeses = col(wsC, h, (x) => (x.includes("mes") && (x.includes("caducidad") || x.includes("plazo"))) || x.includes("plazo caduc"));
  const cSusD = col(wsC, h, (x) => x.includes("susp") && x.includes("desde"));
  const cSusH = col(wsC, h, (x) => x.includes("susp") && x.includes("hasta"));
  // Columna con el numero real del PJN (para cruzar con el CSV de movimientos).
  const cPjn = col(wsC, h, (x) => x.includes("pjn") && (x.includes("exped") || x.includes("nro") || x.includes("numero")) && !x.includes("mov"));
  if (!cNro || (!cUlt && !cImpulso)) return { items: [], nota: `faltan columnas en ${wsC.name}` };

  // Ultimo movimiento por causa desde MOVIMIENTOS (para el fallback de impulso).
  const ultMovMov = new Map();
  const wsM = elegirHoja(wb, /movimiento|novedad|bitacora/i);
  if (wsM) {
    const hM = hallarHeader(wsM);
    const mNro = col(wsM, hM, (x) => x.includes("causa") || x.includes("exped") || x.includes("nro"));
    const mFecha = col(wsM, hM, (x) => x.includes("fecha"));
    if (mNro && mFecha) {
      for (let r = hM + 1; r <= (wsM.rowCount || hM); r++) {
        const k = normExp(wsM.getRow(r).getCell(mNro).text);
        if (!k) continue;
        const f = parseFecha(wsM.getRow(r).getCell(mFecha).value);
        if (f && (!ultMovMov.has(k) || f > ultMovMov.get(k))) ultMovMov.set(k, f);
      }
    }
  }
  // Sumar el log CSV del bot (Plan B): ahi quedan registradas las novedades del PJN.
  try {
    const { leerUltimosMovimientos } = await import("./movimientos-log.mjs");
    for (const [k, fch] of leerUltimosMovimientos()) if (!ultMovMov.has(k) || fch > ultMovMov.get(k)) ultMovMov.set(k, fch);
  } catch { /* sin CSV */ }

  const feriadosSet = cargarFeriadosSet();
  const hoy = new Date();
  const items = [];
  let sinImpulso = 0; // causas civiles activas cuyo impulso es solo estimado
  let sinAplicabilidad = 0; // sucesiones/voluntarias: aplicabilidad de la caducidad en revision
  for (let r = h + 1; r <= (wsC.rowCount || h); r++) {
    const row = wsC.getRow(r);
    const nro = String(row.getCell(cNro).text || "").trim();
    if (!nro) continue;
    // Clave de cruce con el CSV: el numero real del PJN si esta cargado, si no el Nro. Causa.
    const claveMatch = cPjn ? (String(row.getCell(cPjn).text || "").trim() || nro) : nro;
    const caratula = cCar ? String(row.getCell(cCar).text || "").trim() : "";
    const fuero = cFuero ? String(row.getCell(cFuero).text || "").trim() : "";
    const estado = cEstado ? String(row.getCell(cEstado).text || "").trim() : "";
    const obs = cObs ? String(row.getCell(cObs).text || "").trim() : "";
    if (estadoCerrado(estado)) continue;
    if (fueroExcluido(fuero, caratula)) continue;
    const tipoProceso = detectarTipoProceso(caratula, obs);

    // Impulso: columna cargada (verificado) o ultimo movimiento (estimado).
    let impulso = cImpulso ? parseFecha(row.getCell(cImpulso).value) : null;
    let impulsoVerificado = !!impulso;
    if (!impulso) {
      impulso = parseFecha(row.getCell(cUlt)?.value);
      const desdeMov = ultMovMov.get(normExp(claveMatch));
      if (desdeMov && (!impulso || desdeMov > impulso)) impulso = desdeMov;
    }
    if (!impulso) continue;
    if (!impulsoVerificado) sinImpulso++;

    // Plazo: columna cargada o estimacion por tipo/fuero.
    let meses = cMeses ? Number(String(row.getCell(cMeses).text).replace(/[^\d]/g, "")) : 0;
    let ftePlazo = "cargado";
    if (!meses) { meses = plazoEstimado(fuero, estado, obs, caratula) || mesesDefault; ftePlazo = "estimado"; }

    const susDesde = cSusD ? parseFecha(row.getCell(cSusD).value) : null;
    const susHasta = cSusH ? parseFecha(row.getCell(cSusH).value) : null;

    const { venc, feriaDias, susDias } = computarVencimiento(impulso, meses, ferias, susDesde, susHasta);
    // Prorroga al primer dia habil si el vencimiento cae inhabil (art. 124 CPCCN).
    const vencHabil = proximoHabil(venc, feriadosSet);
    const prorrogado = vencHabil.getTime() !== venc.getTime();
    const restan = Math.floor((vencHabil - hoy) / DIA_MS);
    const dias = Math.floor((hoy - impulso) / DIA_MS);
    if (restan > avisoDias) continue;

    const nivel = restan < 0 ? "vencido" : (restan <= 15 ? "urgente" : "preventivo");
    if (tipoProceso) sinAplicabilidad++;
    items.push({ nro, caratula, fuero, impulso, dias, meses, ftePlazo, impulsoVerificado, feriaDias, susDias, venc: vencHabil, prorrogado, restan, nivel, tipoProceso });
  }

  items.sort((a, b) => a.restan - b.restan);
  return { items, sinImpulso, sinAplicabilidad, nota: null, ferias: ferias.length };
}

export function renderCaducidad(items, sinImpulso = 0, sinAplicabilidad = 0) {
  if (!items || !items.length) return null;
  const f = (d) => new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
  const et = { vencido: "VENCIDO", urgente: "URGENTE", preventivo: "preventivo" };
  const revision = items.filter((it) => !it.impulsoVerificado).length;
  const etTipoProceso = { sucesorio: "proceso sucesorio", voluntario: "proceso de jurisdiccion voluntaria" };

  let texto = `>>> CADUCIDAD DE INSTANCIA - ${items.length} causa(s) en riesgo (art. 310/311 CPCCN) <<<\n`;
  let html = `<div style="border:2px solid #b58900;border-radius:4px;padding:8px 10px;margin:10px 0;background:#fdf6e3"><b style="color:#8b1e1e">CADUCIDAD DE INSTANCIA - ${items.length} causa(s) en riesgo (art. 310/311 CPCCN)</b><ul style="margin:6px 0">`;
  for (const it of items) {
    const restanTxt = it.restan < 0 ? `VENCIDA hace ${-it.restan} dia(s)` : `faltan ${it.restan} dia(s)`;
    const desc = it.feriaDias || it.susDias ? ` | descuenta ${it.feriaDias}d feria${it.susDias ? " + " + it.susDias + "d susp." : ""}` : "";
    const grac = it.prorrogado ? " (prorrogado al 1er dia habil - primeras 2 hs de gracia, art. 124 CPCCN)" : "";
    // Escalada: sucesion/voluntaria = aplicabilidad en revision (no es un contencioso comun,
    // la doctrina discute si corre la caducidad sin contradictorio); sin acto impulsorio
    // verificado = revision requerida. Ambas priman sobre el nivel ordinario.
    const etiqueta = it.tipoProceso ? "VERIFICAR APLICABILIDAD" : (it.impulsoVerificado ? et[it.nivel] : "REVISION REQUERIDA");
    const notas = [];
    if (it.tipoProceso) notas.push(`${etTipoProceso[it.tipoProceso]}: la caducidad por ausencia de contradictorio no es pacifica en doctrina/jurisprudencia [REVISION NORMATIVA REQUERIDA: jurisprudencia de Camara Civil no aportada] - verificar si hay incidente contradictorio abierto (oposicion, exclusion de heredero, herencia vacante) antes de descartar el plazo`);
    if (!it.impulsoVerificado) notas.push("causa sin acto impulsorio verificado (el ultimo movimiento puede no interrumpir la caducidad)");
    const nota = notas.length ? " -- " + notas.join(" | ") : "";
    texto += `  [${etiqueta}] ${it.nro} - ${it.caratula} | impulso ${f(it.impulso)}${it.impulsoVerificado ? "" : " (estimado)"} | plazo ${it.meses}m (${it.ftePlazo}) vence ${f(it.venc)}${grac}${desc} - ${restanTxt}${nota}\n`;
    const color = it.tipoProceso ? "#0b5394" : (it.impulsoVerificado ? "#555" : "#8b1e1e");
    const htmlNotas = [];
    if (it.tipoProceso) htmlNotas.push(`<b>${etTipoProceso[it.tipoProceso]}:</b> aplicabilidad de la caducidad en revision (no pacifica sin contradictorio); verificar incidentes.`);
    if (!it.impulsoVerificado) htmlNotas.push("<b>Sin acto impulsorio verificado:</b> el ultimo movimiento puede no interrumpir la caducidad.");
    html += `<li>[<b>${etiqueta}</b>] <b>${it.nro}</b> - ${it.caratula}<br><span style="color:${color}">impulso ${f(it.impulso)}${it.impulsoVerificado ? "" : " <i>(estimado)</i>"} &middot; plazo ${it.meses} meses (${it.ftePlazo}) &middot; vence <b>${f(it.venc)}</b>${grac}${desc} &middot; ${restanTxt}${htmlNotas.length ? "<br>" + htmlNotas.join("<br>") : ""}</span></li>`;
  }
  texto += "\n";
  if (sinImpulso > 0) {
    texto += `  ATENCION: ${sinImpulso} causa(s) civil(es) activa(s) sin "Ultimo impulso" cargado. El reloj puede estar peor que lo que muestra. Cargar la fecha del acto impulsorio real.\n`;
  }
  if (sinAplicabilidad > 0) {
    texto += `  ATENCION: ${sinAplicabilidad} causa(s) sucesoria(s)/de jurisdiccion voluntaria marcada(s) "VERIFICAR APLICABILIDAD": la caducidad de instancia por ausencia de contradictorio no es unanime en doctrina/jurisprudencia. No se excluyen del barrido; confirmar si corresponde aplicar el instituto o si hay incidente contradictorio abierto.\n`;
  }
  texto += `  Litisconsorcio (art. 312 CPCCN): el impulso por o contra un colitigante beneficia a los demas. El computo es por expediente y por el ultimo acto registrado; verificar actos dirigidos a otros sujetos que no figuren en la solapa.\n`;
  texto += `  Confirmar el acto impulsorio, las suspensiones y la fecha antes de acusar o impulsar.\n`;

  html += `</ul>`;
  if (sinImpulso > 0) {
    html += `<div style="color:#8b1e1e;font-size:12px;margin:4px 0"><b>Atencion:</b> ${sinImpulso} causa(s) civil(es) activa(s) sin "Ultimo impulso" cargado. El reloj puede estar peor que lo que muestra; cargar la fecha del acto impulsorio real.</div>`;
  }
  if (sinAplicabilidad > 0) {
    html += `<div style="color:#0b5394;font-size:12px;margin:4px 0"><b>Atencion:</b> ${sinAplicabilidad} causa(s) sucesoria(s)/de jurisdiccion voluntaria marcada(s) "VERIFICAR APLICABILIDAD": la caducidad por ausencia de contradictorio no es unanime en doctrina/jurisprudencia. No se excluyen del barrido; confirmar aplicabilidad o incidente contradictorio abierto.</div>`;
  }
  html += `<div style="color:#888;font-size:12px"><b>Litisconsorcio (art. 312 CPCCN):</b> el impulso por o contra un colitigante beneficia a los demas. El computo es por expediente y por el ultimo acto registrado; verificar actos dirigidos a otros sujetos que no figuren en la solapa principal.<br>Computo art. 310/311 CPCCN con descuento de feria y prorroga al dia habil. El abogado confirma la fecha antes de actuar.</div></div>`;
  return { texto, html, revision, aplicabilidad: sinAplicabilidad };
}
