/**
 * penal.mjs - Frente penal. Dos funciones sobre la hoja CAUSAS (solo lectura):
 *
 *  1) MONITOR DE INACTIVIDAD (siempre activo): marca causas penales activas sin
 *     movimiento hace mas de N dias. Es control de gestion, NO prescripcion: sirve
 *     para que ninguna causa penal se duerma sin que nadie la mire.
 *
 *  2) PRESCRIPCION DE LA ACCION (se activa al cargar columnas): computa la fecha
 *     estimada de prescripcion segun arts. 62/63/67 CP (verificado en InfoLEG, CP
 *     idNorma 16546, texto actualizado; art. 67 sustituido por Ley 27.206).
 *
 * Base normativa:
 *   Art. 62: plazo = maximo de la pena del delito (prision/reclusion temporal),
 *     tope 12 anios, piso 2; 15 anios si perpetua; 5/1 inhabilitacion; 2 multa.
 *   Art. 63: corre desde la medianoche del dia del hecho (o cese si continuo).
 *   Art. 67: interrumpe SOLO: a) otro delito; b) primer llamado a indagatoria;
 *     c) requerimiento de elevacion a juicio; d) auto de citacion a juicio;
 *     e) sentencia condenatoria (aunque no firme). Corre separadamente por delito
 *     y por participe. Hay suspensiones especiales (funcion publica, menores, etc.).
 *
 * LIMITES: la prescripcion penal es delito-dependiente y admite suspensiones que el
 * sistema no puede inferir. Esto es una alerta de gestion; el abogado determina el
 * delito, la pena, los actos interruptivos y las suspensiones, y confirma la fecha.
 *
 * Columnas OPCIONALES en CAUSAS (para el computo de prescripcion):
 *   - "Prescripcion Anios"        -> plazo en anios cargado directo (lo mas seguro).
 *   - "Pena Max Anios"            -> si no hay plazo directo: se usa clamp(pena,2,12).
 *   - "Fecha Hecho"               -> fecha del hecho (art. 63).
 *   - "Ultimo Acto Interruptivo"  -> fecha del ultimo acto del art. 67 inc. b-e.
 *   - "Susp Desde" / "Susp Hasta" -> periodo de suspension a descontar.
 *
 * Requiere: npm i exceljs. Se activa con EXCEL_PATH.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { terminoArt62, articuloDe, parrafoDe, buscarPena, ETIQUETA_PARRAFO } from "./penal-base.mjs";

const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\s+/g, " ").trim();
function normExp(s) {
  const m = String(s ?? "").match(/(\d{1,7})\s*\/\s*(\d{2,4})/);
  return m ? `${m[1]}/${m[2]}` : String(s ?? "").toUpperCase().replace(/\s+/g, "").replace(/[^\dA-Z/]/g, "");
}
const DIA_MS = 24 * 60 * 60 * 1000;

function parseFecha(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) return v;
  if (typeof v === "object" && v.result instanceof Date) return v.result;
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);
  if (m) { const a = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]); const d = new Date(a, Number(m[2]) - 1, Number(m[1])); return isNaN(d) ? null : d; }
  const d = new Date(s); return isNaN(d) ? null : d;
}
function sumarAnios(fecha, anios) { const d = new Date(fecha.getTime()); d.setFullYear(d.getFullYear() + anios); return d; }

function esPenal(fuero, caratula) {
  return /penal|criminal|correccional|casacion penal|s\/ ?inf|\bccc\b|\bcfp\b|\bcpe\b/.test(norm(`${fuero} ${caratula}`));
}
function estadoCerrado(estado) {
  return /archiv|termin|finaliz|concluid|sentencia firme|sobresei|absol|prescri|extingu/i.test(String(estado || ""));
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
function col(ws, h, pred) { let f = null; ws.getRow(h).eachCell({ includeEmpty: false }, (c, i) => { if (f == null && pred(norm(c.text))) f = i; }); return f; }

export async function calcularPenal() {
  const carteraDefault = fileURLToPath(new URL("../cartera-pjn.xlsx", import.meta.url));
  const entrada = process.env.CARTERA_XLSX || (fs.existsSync(carteraDefault) ? carteraDefault : process.env.EXCEL_PATH);
  if (!entrada || !fs.existsSync(entrada)) return { inactividad: [], prescripcion: [], nota: "sin cartera-pjn.xlsx ni EXCEL_PATH" };
  const inactDias = Number(process.env.PENAL_INACTIVIDAD_DIAS || 120);
  const avisoDias = Number(process.env.PENAL_AVISO_DIAS || 90);

  let ExcelJS;
  try { ExcelJS = (await import("exceljs")).default; } catch { return { inactividad: [], prescripcion: [], nota: "falta exceljs" }; }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(entrada);
  const wsC = elegirHoja(wb, /causa|exped/i);
  if (!wsC) return { inactividad: [], prescripcion: [], nota: "sin hoja CAUSAS" };
  const h = hallarHeader(wsC);
  const cNro = col(wsC, h, (x) => (x.includes("causa") || x.includes("exped") || x.includes("nro")) && !x.includes("caratula"));
  const cCar = col(wsC, h, (x) => x.includes("caratula"));
  const cFuero = col(wsC, h, (x) => x.includes("fuero") || x.includes("rama"));
  const cEstado = col(wsC, h, (x) => x.includes("estado"));
  const cUlt = col(wsC, h, (x) => x.includes("ult") && x.includes("mov"));
  const cAnios = col(wsC, h, (x) => x.includes("prescrip") && (x.includes("anio") || x.includes("ano") || x.includes("year")));
  const cPena = col(wsC, h, (x) => x.includes("pena") && x.includes("max"));
  const cHecho = col(wsC, h, (x) => x.includes("hecho"));
  const cInterr = col(wsC, h, (x) => x.includes("interrup"));
  const cSusD = col(wsC, h, (x) => x.includes("susp") && x.includes("desde"));
  const cSusH = col(wsC, h, (x) => x.includes("susp") && x.includes("hasta"));
  const cPjn = col(wsC, h, (x) => x.includes("pjn") && (x.includes("exped") || x.includes("nro") || x.includes("numero")) && !x.includes("mov"));
  const cDelito = col(wsC, h, (x) => x.includes("delito"));
  if (!cNro) return { inactividad: [], prescripcion: [], nota: "sin columna Nro. Causa" };

  // Ultimo movimiento por causa desde MOVIMIENTOS.
  const ultMovMov = new Map();
  const wsM = elegirHoja(wb, /movimiento|novedad|bitacora/i);
  if (wsM) {
    const hM = hallarHeader(wsM);
    const mNro = col(wsM, hM, (x) => x.includes("causa") || x.includes("exped") || x.includes("nro"));
    const mFecha = col(wsM, hM, (x) => x.includes("fecha"));
    if (mNro && mFecha) for (let r = hM + 1; r <= (wsM.rowCount || hM); r++) {
      const k = normExp(wsM.getRow(r).getCell(mNro).text); if (!k) continue;
      const f = parseFecha(wsM.getRow(r).getCell(mFecha).value);
      if (f && (!ultMovMov.has(k) || f > ultMovMov.get(k))) ultMovMov.set(k, f);
    }
  }
  // Sumar el log CSV del bot (Plan B): novedades del PJN registradas por el bot.
  try {
    const { leerUltimosMovimientos } = await import("./movimientos-log.mjs");
    for (const [k, fch] of leerUltimosMovimientos()) if (!ultMovMov.has(k) || fch > ultMovMov.get(k)) ultMovMov.set(k, fch);
  } catch { /* sin CSV */ }

  const hoy = new Date();
  const inactividad = [], prescripcion = [], prescripcionTodas = [], sinTabla = [], detecciones = [];
  for (let r = h + 1; r <= (wsC.rowCount || h); r++) {
    const row = wsC.getRow(r);
    const nro = String(row.getCell(cNro).text || "").trim(); if (!nro) continue;
    const claveMatch = cPjn ? (String(row.getCell(cPjn).text || "").trim() || nro) : nro;
    const caratula = cCar ? String(row.getCell(cCar).text || "").trim() : "";
    const fuero = cFuero ? String(row.getCell(cFuero).text || "").trim() : "";
    const estado = cEstado ? String(row.getCell(cEstado).text || "").trim() : "";
    if (!esPenal(fuero, caratula)) continue;
    if (estadoCerrado(estado)) continue;

    // 1) Inactividad.
    let ult = cUlt ? parseFecha(row.getCell(cUlt).value) : null;
    const desdeMov = ultMovMov.get(normExp(claveMatch));
    if (desdeMov && (!ult || desdeMov > ult)) ult = desdeMov;
    if (ult) {
      const dias = Math.floor((hoy - ult) / DIA_MS);
      if (dias >= inactDias) inactividad.push({ nro, caratula, fuero, ult, dias });
    }

    // 2) Prescripcion (si hay datos).
    let anios = cAnios ? Number(String(row.getCell(cAnios).text).replace(/[^\d]/g, "")) : 0;
    let fteAnios = "cargado";
    if (!anios && cPena) {
      const t = terminoArt62(Number(String(row.getCell(cPena).text).replace(/[^\d.]/g, "")));
      if (t) { anios = t; fteAnios = "de pena max (art. 62, tope 12/piso 2)"; }
    }
    // Articulo/parrafo del CP detectado en la caratula (tabla compartida penal-base). Se
    // detecta SIEMPRE, no solo cuando falta el plazo, para poder volcarlo en "Delito (art.
    // CP)" y que quede auditable que interpreto el sistema en esta corrida.
    const artDet = articuloDe("", caratula);
    const parrDet = artDet ? parrafoDe("", caratula) : "";
    if (!anios && artDet) {
      const tp = buscarPena(artDet, parrDet);
      const t = tp ? terminoArt62(tp.max) : null;
      if (t) {
        anios = t;
        fteAnios = `de tabla (art. ${artDet}${parrDet ? "." + parrDet : ""} CP) [VERIFICAR VIGENCIA]`;
      } else {
        // Antes: la causa se caia del calculo sin ningun aviso. Ahora se informa como
        // articulo detectado pero sin entrada en TABLA_PENAS (o con parrafo sin identificar).
        sinTabla.push({ nro, caratula, fuero, articulo: artDet, parrafo: parrDet || null });
      }
    }
    // Volcado a "Delito (art. CP)": solo si la celda esta vacia, para no pisar una carga
    // manual (del abogado o de una corrida anterior).
    if (artDet && cDelito) {
      const celdaActual = String(row.getCell(cDelito).text || "").trim();
      if (!celdaActual) {
        const etiqueta = parrDet ? ` (${ETIQUETA_PARRAFO[parrDet] || parrDet})` : "";
        detecciones.push({ fila: r, valor: `${artDet}${etiqueta}` });
      }
    }
    const hecho = cHecho ? parseFecha(row.getCell(cHecho).value) : null;
    const interr = cInterr ? parseFecha(row.getCell(cInterr).value) : null;
    const base = interr || hecho;
    if (anios && base) {
      const susD = cSusD ? parseFecha(row.getCell(cSusD).value) : null;
      const susH = cSusH ? parseFecha(row.getCell(cSusH).value) : null;
      let susDias = 0;
      if (susD && susH && susH > susD) susDias = Math.floor((susH - susD) / DIA_MS);
      const prescribe = new Date(sumarAnios(base, anios).getTime() + susDias * DIA_MS);
      const restan = Math.floor((prescribe - hoy) / DIA_MS);
      const nivel = restan < 0 ? "prescripta" : (restan <= 30 ? "urgente" : (restan <= avisoDias ? "preventivo" : "lejano"));
      const it = { nro, caratula, fuero, base, desde: interr ? "ult. acto interruptivo" : "fecha del hecho", anios, fteAnios, prescribe, restan, nivel };
      prescripcionTodas.push(it); // se vuelca a la cartera aunque no este en zona de aviso
      if (restan <= avisoDias) prescripcion.push(it);
    } else {
      // Penal activa sin datos suficientes para computar la prescripcion. Se vuelca una NOTA
      // a la cartera indicando que falta cargar (la fecha del hecho no surge del feed del PJN).
      const falta = [];
      if (!anios) falta.push("Pena Max Anios o Delito");
      if (!base) falta.push("Fecha Hecho o Ultimo Acto Interruptivo");
      prescripcionTodas.push({ nro, caratula, fuero, faltaDato: true, motivo: "faltan datos: " + falta.join(" + ") });
    }
  }

  inactividad.sort((a, b) => b.dias - a.dias);
  prescripcion.sort((a, b) => a.restan - b.restan);
  sinTabla.sort((a, b) => a.nro.localeCompare(b.nro, undefined, { numeric: true }));

  // Volcado de "Delito (art. CP)" detectado. Mismo resguardo que excel-writeback.mjs: por
  // defecto escribe sobre una COPIA (no toca el maestro salvo EXCEL_INPLACE=true), porque
  // exceljs puede no preservar al 100% graficos/formato condicional al reescribir.
  let delito = { detectadas: detecciones.length, salida: null };
  if (detecciones.length && cDelito) {
    try {
      // cartera-pjn.xlsx es el archivo PLANO que mantiene el bot (cartera.mjs): sin dashboards
      // ni graficos, se reescribe entero en cada corrida sin riesgo -> in-place por defecto.
      // Si en cambio se esta leyendo el Excel de gestion del abogado (fallback EXCEL_PATH, con
      // dashboards/formato condicional), se aplica la misma cautela que excel-writeback.mjs:
      // copia por defecto, salvo PENAL_DELITO_INPLACE=true explicito.
      const esCarteraBot = !!process.env.CARTERA_XLSX || entrada === carteraDefault;
      const inplace = (process.env.PENAL_DELITO_INPLACE || (esCarteraBot ? "true" : "false")) === "true";
      const salida = inplace ? entrada : (process.env.EXCEL_OUT || entrada.replace(/\.xlsx$/i, "") + ".actualizado.xlsx");
      for (const d of detecciones) wsC.getRow(d.fila).getCell(cDelito).value = d.valor;
      await wb.xlsx.writeFile(salida);
      delito.salida = salida;
    } catch (e) {
      delito.error = e.message; // no corta el calculo: se informa en la nota, no se pierde el parte
    }
  }

  return { inactividad, prescripcion, prescripcionTodas, sinTabla, delito, nota: null };
}

export function renderPenal({ inactividad, prescripcion, sinTabla }) {
  if ((!inactividad || !inactividad.length) && (!prescripcion || !prescripcion.length) && (!sinTabla || !sinTabla.length)) return null;
  const f = (d) => new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
  let texto = "", html = "";

  if (prescripcion && prescripcion.length) {
    const et = { prescripta: "PRESCRIPTA?", urgente: "URGENTE", preventivo: "preventivo" };
    texto += `>>> PENAL - PRESCRIPCION DE LA ACCION - ${prescripcion.length} causa(s) (arts. 62/63/67 CP) <<<\n`;
    html += `<div style="border:2px solid #8b1e1e;border-radius:4px;padding:8px 10px;margin:10px 0;background:#fdf0f0"><b style="color:#8b1e1e">PENAL - Prescripcion de la accion - ${prescripcion.length} causa(s) (arts. 62/63/67 CP)</b><ul style="margin:6px 0">`;
    for (const it of prescripcion) {
      const restanTxt = it.restan < 0 ? `plazo cumplido hace ${-it.restan} dia(s)` : `faltan ${it.restan} dia(s)`;
      const conc = it.fteAnios.includes("pena max") ? " [VERIFICAR CONCURSO art. 55: en concurso real el plazo NO se topea en 12]" : "";
      texto += `  [${et[it.nivel]}] ${it.nro} - ${it.caratula} | ${it.anios} anios (${it.fteAnios}) desde ${f(it.base)} (${it.desde}) | prescribe ~${f(it.prescribe)} - ${restanTxt}${conc}\n`;
      html += `<li>[<b>${et[it.nivel]}</b>] <b>${it.nro}</b> - ${it.caratula}<br><span style="color:#555">${it.anios} anios (${it.fteAnios}) desde ${f(it.base)} (${it.desde}) &middot; prescribe ~<b>${f(it.prescribe)}</b> &middot; ${restanTxt}</span>${conc ? `<br><b style="color:#8b1e1e">Verificar concurso (art. 55): en concurso real el plazo no se topea en 12 anios; cargar "Prescripcion Anios" a mano.</b>` : ""}</li>`;
    }
    texto += `  ATENCION: computo POR EXPEDIENTE. En pluralidad de imputados la prescripcion corre separadamente para cada participe (art. 67 CP, Ley 25.990 [VERIFICAR VIGENCIA] / t. Ley 27.206): verificar la situacion individual de cada asistido.\n`;
    texto += `  La comision de un nuevo delito tambien interrumpe (art. 67 inc. a) y es ajena a la bitacora del PJN: se controla por el RNR. No se detectan suspensiones especiales (funcion publica, victima menor, suspension de juicio a prueba art. 76 ter). El abogado confirma delito, pena, actos interruptivos y suspensiones.\n`;
    html += `</ul><div style="color:#8b1e1e;font-size:12px"><b>ATENCION - computo por expediente.</b> En pluralidad de imputados la prescripcion corre separadamente para cada participe (art. 67 CP): verificar la situacion individual de cada asistido.</div>`;
    html += `<div style="color:#888;font-size:12px">La comision de un nuevo delito interrumpe (art. 67 inc. a) y es ajena al PJN: control por RNR. No se detectan suspensiones especiales (funcion publica, victima menor, suspension de juicio a prueba - art. 76 ter). Verificar delito, pena, actos interruptivos y suspensiones antes de plantear o resistir la prescripcion.</div></div>`;
  }

  if (inactividad && inactividad.length) {
    texto += `>>> PENAL - INACTIVIDAD (control de gestion, NO es prescripcion) - ${inactividad.length} causa(s) <<<\n`;
    html += `<div style="border:1px solid #888;border-radius:4px;padding:6px 10px;margin:10px 0"><b>PENAL - Inactividad (control de gestion, NO es prescripcion) - ${inactividad.length} causa(s)</b><ul style="margin:6px 0">`;
    for (const it of inactividad) {
      texto += `  [ ] ${it.nro} - ${it.caratula} | sin movimiento hace ${it.dias} dia(s) (ult. ${f(it.ult)})\n`;
      html += `<li><b>${it.nro}</b> - ${it.caratula} &middot; sin movimiento hace ${it.dias} dia(s) (ult. ${f(it.ult)})</li>`;
    }
    texto += "\n";
    html += `</ul><div style="color:#888;font-size:12px">Alerta de gestion: causa penal sin movimiento registrado. No implica prescripcion; revisar el estado real en el Portal.</div></div>`;
  }

  if (sinTabla && sinTabla.length) {
    // Antes esto se perdia en silencio: articulo detectado pero sin entrada en TABLA_PENAS
    // (o con parrafo sin identificar, ej. 119 sin especificar cual). No se computa
    // prescripcion para estas causas hasta cargar el dato a mano o precisar el parrafo.
    texto += `>>> PENAL - SIN DATO DE PENA (art. detectado sin entrada en tabla) - ${sinTabla.length} causa(s) <<<\n`;
    html += `<div style="border:1px solid #b58900;border-radius:4px;padding:6px 10px;margin:10px 0;background:#fdf6e3"><b style="color:#b58900">PENAL - Sin dato de pena (articulo detectado sin entrada en tabla) - ${sinTabla.length} causa(s)</b><ul style="margin:6px 0">`;
    for (const it of sinTabla) {
      const artTxt = `art. ${it.articulo}${it.parrafo ? "." + it.parrafo : " (parrafo sin identificar)"}`;
      texto += `  [ ] ${it.nro} - ${it.caratula} | ${artTxt} - cargar "Pena Max Anios" o "Prescripcion Anios" a mano, o precisar el parrafo en "Delito (art. CP)"\n`;
      html += `<li><b>${it.nro}</b> - ${it.caratula} &middot; ${artTxt} &middot; cargar "Pena Max Anios" o "Prescripcion Anios" a mano, o precisar el parrafo en "Delito (art. CP)"</li>`;
    }
    texto += "\n";
    html += `</ul><div style="color:#888;font-size:12px">No se computa prescripcion para estas causas hasta completar el dato de pena.</div></div>`;
  }
  return { texto, html };
}
