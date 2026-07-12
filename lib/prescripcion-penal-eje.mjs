/**
 * prescripcion-penal-eje.mjs - Prescripcion de la ACCION penal (arts. 62-67 CP).
 *
 * Para la cartera PENAL del EJE (fuero PCyF: causas IPP por delitos del Codigo Penal
 * de competencia transferida a la CABA). La caducidad de instancia (art. 216 CCAyT) NO
 * aplica en penal; el instituto extintivo por inaccion es la PRESCRIPCION de la accion.
 *
 * Base normativa (Codigo Penal, Ley 11.179; texto actualizado verificado en InfoLEG,
 * norma 16546) [VERIFICAR VIGENCIA]:
 *   - Art. 62: plazos de prescripcion de la accion.
 *       inc.1  perpetua ................................ 15 anios
 *       inc.2  reclusion/prision temporal ............. maximo de la pena, TOPE 12, PISO 2
 *       inc.3  inhabilitacion perpetua ................. 5 anios
 *       inc.4  inhabilitacion temporal ................. 1 anio
 *       inc.5  multa ................................... 2 anios
 *   - Art. 63: corre desde la medianoche del dia del hecho (o del cese, si es continuo).
 *   - Art. 67: SUSPENSION (cuestiones prejudiciales; funcion publica; y -clave aca- mientras
 *     la victima sea MENOR de edad en delitos 119, 120, 125, 125bis, 128, 129 in fine, 130
 *     parr. 2/3, 145bis, 145ter). INTERRUPCION taxativa ("secuela de juicio"):
 *       a) comision de otro delito
 *       b) primer llamado a indagatoria
 *       c) requerimiento de elevacion a juicio
 *       d) auto de citacion a juicio o equivalente
 *       e) sentencia condenatoria (aunque no este firme)
 *     Corre/suspende/interrumpe por separado para cada delito y participe.
 *
 * QUE AUTOMATIZA y QUE NO:
 *   - Pena maxima: AUTO desde el articulo del CP (tabla interna, prefill [VERIFICAR VIGENCIA]).
 *   - Ultima interrupcion (art. 67): AUTO-DETECTADA escaneando las actuaciones del expediente
 *     por titulo (indagatoria/intimacion del hecho, requerimiento de juicio, citacion a juicio,
 *     sentencia). Es un ASISTENTE heuristico -marcado [AUTO, CONFIRMAR]-: puede fallar o tomar
 *     una absolutoria por condenatoria. El dato manual en la cartera SIEMPRE tiene prioridad.
 *   - Fecha del hecho: NO se puede sacar de forma confiable (esta en el texto de la denuncia/
 *     requerimiento, no en datos estructurados). Queda manual; si falta, se usa la interrupcion
 *     auto o, en ultimo caso, la Fecha Inicio del expediente como PROXY (sobreestima el riesgo).
 * Es una CALCULADORA ASISTIDA: la determinacion del acto interruptivo, la suspension y el
 * computo definitivo son del abogado.
 *
 * Columnas de cartera-eje.xlsx que lee:
 *   "Delito (art. CP)"     -> articulo/s del CP (ej. "89", "119 1", "128"). Prefill de tabla.
 *   "Fecha Hecho"          -> fecha de comision (art. 63). Si falta, usa Fecha Inicio como
 *                             PROXY con aviso (sobreestima el riesgo: el hecho suele ser antes).
 *   "Pena Max (anios)"     -> maximo de la pena en anios. Si falta, tabla interna [VERIFICAR].
 *   "Ultima Interrupcion"  -> fecha del ultimo acto interruptivo (secuela de juicio). Reinicia.
 *   "Prescripcion Aplica"  -> SI/NO override manual.
 *
 * Requiere: npm i exceljs.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { norm, parseFecha, sumarAnios, terminoArt62, articuloDe, parrafoDe, buscarPena, detectarInterrupcion, detectarCierre } from "./penal-base.mjs";

const DIA_MS = 24 * 60 * 60 * 1000;
const txt = (c) => { const v = c && c.value; if (v == null) return ""; if (typeof v === "object") { if (v.result !== undefined) return String(v.result); if (v.text !== undefined) return String(v.text); return ""; } return String(v); };

const CFG = {
  avisoDias: Number(process.env.EJE_PRESCRIPCION_AVISO_DIAS || 180), // avisa a 6 meses del venc.
};

// Nucleo penal (tabla de penas, termino art. 62, deteccion de interrupcion/cierre) importado
// de penal-base.mjs (compartido con el bot del PJN y el futuro SCBA).
const estadoCerrado = (e) => /archiv|sobresei|prescri|extingu|absol|conden.*firme|rebeld.*archiv/i.test(String(e || ""));

function elegirHoja(wb) { return wb.worksheets.find((w) => /causa|exped/i.test(w.name)) || wb.worksheets[0]; }
function colDe(ws, headerRow, pred) { let f = null; ws.getRow(headerRow).eachCell({ includeEmpty: false }, (c, i) => { if (f == null && pred(norm(c.text))) f = i; }); return f; }

// opts.fetchActuaciones(expId) -> Promise<[{titulo,codigo,fechaFirma,...}]>: si se pasa, el
// modulo detecta solo la ultima interrupcion (art. 67) de las causas sin dato manual.
export async function calcularPrescripcionEje(opts = {}) {
  const fetchActuaciones = typeof opts.fetchActuaciones === "function" ? opts.fetchActuaciones : null;
  const def = fileURLToPath(new URL("../cartera-eje.xlsx", import.meta.url));
  const entrada = process.env.CARTERA_EJE_XLSX || def;
  if (!fs.existsSync(entrada)) return { items: [], nota: "sin cartera-eje.xlsx" };

  let ExcelJS; try { ExcelJS = (await import("exceljs")).default; } catch { return { items: [], nota: "falta exceljs" }; }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(entrada);
  const ws = elegirHoja(wb); if (!ws) return { items: [], nota: "sin hoja de causas" };

  const H = 1;
  const cCuij = colDe(ws, H, (x) => x === "cuij");
  const cExp = colDe(ws, H, (x) => x.includes("expid") || x === "exp");
  const cCar = colDe(ws, H, (x) => x.includes("caratula"));
  const cTipo = colDe(ws, H, (x) => x === "tipo");
  const cFue = colDe(ws, H, (x) => x === "fuero");
  const cEst = colDe(ws, H, (x) => x.includes("estado"));
  const cIni = colDe(ws, H, (x) => x.includes("fecha") && x.includes("inicio"));
  const cVig = colDe(ws, H, (x) => x === "vigilar");
  const cDelito = colDe(ws, H, (x) => x.includes("delito"));
  const cHecho = colDe(ws, H, (x) => x.includes("fecha") && x.includes("hecho"));
  const cPena = colDe(ws, H, (x) => x.includes("pena") && x.includes("max"));
  const cInterr = colDe(ws, H, (x) => x.includes("interrupcion"));
  const cAplica = colDe(ws, H, (x) => x.includes("prescripcion") && x.includes("aplica"));
  if (!cCar) return { items: [], nota: "cartera-eje.xlsx sin columna Caratula" };

  const hoy = new Date();
  const items = [];
  const todas = []; // computados (con venc) aunque sean lejanos -> para volcar a la cartera
  let sinDatos = 0;

  for (let r = H + 1; r <= (ws.rowCount || H); r++) {
    const row = ws.getRow(r);
    const caratula = txt(row.getCell(cCar));
    const expId = cExp ? txt(row.getCell(cExp)).trim() : "";
    if (!caratula && !expId) continue;
    const cuij = cCuij ? txt(row.getCell(cCuij)) : "";
    const tipo = cTipo ? txt(row.getCell(cTipo)) : "";
    const fuero = cFue ? txt(row.getCell(cFue)) : "";
    const estado = cEst ? txt(row.getCell(cEst)) : "";
    const vigilar = cVig ? txt(row.getCell(cVig)) : "";
    const aplica = norm(cAplica ? txt(row.getCell(cAplica)) : "");

    if (/^(no|0|false)$/.test(norm(vigilar))) continue;
    if (/^(no|0|false)$/.test(aplica)) continue;                 // excluida a mano

    // Solo penal (PCyF). Si no fue marcada Aplica=SI, exigir senal penal.
    const esPenal = /pcyf|penal|contravencional|faltas|\bipp\b/.test(norm(`${fuero} ${tipo}`)) || /\bsobre\s+\d/.test(norm(caratula));
    const forzar = /^(si|1|true)$/.test(aplica);
    if (!esPenal && !forzar) continue;
    // Estado cerrado (archivado/sobreseido/etc.) se excluye salvo override "Aplica = SI":
    // una causa archivada puede seguir siendo util para articular o descartar prescripcion.
    if (estadoCerrado(estado) && !forzar) continue;

    const delito = cDelito ? txt(row.getCell(cDelito)) : "";
    const art = articuloDe(delito, caratula);
    const parr = parrafoDe(delito, caratula);
    const ref = cuij || `exp ${expId}`;
    const idc = { cuij, expId }; // clave para volcar el computo a la cartera

    // Pena maxima: columna cargada > tabla interna (prefill, por articulo+parrafo) > desconocida.
    // Articulos desagregados por parrafo (119) sin parrafo identificado quedan "desconocida"
    // (buscarPena devuelve null a proposito) en vez de tomar silenciosamente el 1er parrafo.
    let penaMax = cPena ? Number(String(txt(row.getCell(cPena))).replace(",", ".").replace(/[^\d.]/g, "")) : NaN;
    let penaFuente = "cargada";
    const tp = buscarPena(art, parr);
    if (!Number.isFinite(penaMax) || penaMax <= 0) {
      if (tp) { penaMax = tp.max; penaFuente = "tabla"; }
      else { penaMax = NaN; penaFuente = art ? "sin entrada en tabla (cargar Pena Max a mano)" : "desconocida"; }
    }
    const menorVictima = (tp && tp.menor) || false;

    // Base del computo: ultima interrupcion (reinicia, art. 67) o fecha del hecho (art. 63).
    const interr = cInterr ? parseFecha(row.getCell(cInterr).value) : null;
    let hecho = cHecho ? parseFecha(row.getCell(cHecho).value) : null;
    // Escaneo de actuaciones (una sola vez): detecta cierre (extincion/sobreseimiento/condena/
    // suspension) e interrupcion (art. 67). El cierre se lee de las actuaciones porque el
    // "estado" del EJE suele estar desactualizado.
    let autoInterr = null, cierre = null;
    if (fetchActuaciones && expId) {
      try {
        const acts = await fetchActuaciones(expId);
        cierre = detectarCierre(acts);
        if (!interr) autoInterr = detectarInterrupcion(acts);
      } catch { /* sigue con hecho/proxy */ }
    }
    // Con evento terminal detectado y sin override, la prescripcion no es el riesgo: se informa
    // como causa cerrada (a confirmar) en vez de alertar un vencimiento.
    if (cierre && !forzar) {
      items.push({ ref, caratula, art, fase: "cerrada", cierre });
      continue;
    }
    let baseFuente = interr ? "interrupcion" : (autoInterr ? "interrupcion-auto" : (hecho ? "hecho" : ""));
    let base = interr || (autoInterr && autoInterr.fecha) || hecho;
    // Sin fecha del hecho ni interrupcion: proxy con Fecha Inicio del expediente (sobreestima).
    if (!base && cIni) { base = parseFecha(row.getCell(cIni).value); if (base) baseFuente = "inicio-proxy"; }

    const termino = terminoArt62(penaMax);
    const faltaDato = !Number.isFinite(penaMax) || !base || !termino;
    if (faltaDato) {
      sinDatos++;
      const falta = [];
      if (!Number.isFinite(penaMax) || !termino) falta.push("Pena Max (anios) o Delito (art. CP)");
      if (!base) falta.push("Fecha Hecho o Ultima Interrupcion");
      const it = { ref, ...idc, caratula, art, fase: "incompleto", penaMax, penaFuente, base, baseFuente, autoInterr, menorVictima, termino, faltaDato: true, motivo: "faltan datos: " + falta.join(" + ") };
      todas.push(it); // se vuelca a la cartera como nota de que falta cargar
      items.push(it);
      continue;
    }

    const venc = sumarAnios(base, termino);
    const restan = Math.floor((venc - hoy) / DIA_MS);
    const nivel = restan < 0 ? "prescripto" : (restan <= CFG.avisoDias ? (restan <= 60 ? "urgente" : "preventivo") : "lejano");
    const it = { ref, ...idc, caratula, art, fase: "computado", penaMax, penaFuente, base, baseFuente, autoInterr, menorVictima, termino, venc, restan, nivel };
    todas.push(it); // se vuelca a la cartera aunque el vencimiento sea lejano
    if (nivel === "lejano") continue; // el mail no satura con vencimientos lejanos
    items.push(it);
  }

  const ordFase = { computado: 0, incompleto: 1, cerrada: 2 };
  const ordNivel = { prescripto: 0, urgente: 1, preventivo: 2 };
  items.sort((a, b) => (ordFase[a.fase] - ordFase[b.fase]) || ((ordNivel[a.nivel] ?? 9) - (ordNivel[b.nivel] ?? 9)) || ((a.restan ?? 0) - (b.restan ?? 0)));
  return { items, todas, sinDatos, nota: null };
}

export function renderPrescripcionEje(res) {
  if (!res || !res.items || !res.items.length) return null;
  const items = res.items;
  const f = (d) => d ? new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "numeric" }).format(d) : "-";
  const computados = items.filter((it) => it.fase === "computado");
  const incompletos = items.filter((it) => it.fase === "incompleto");
  const cerradas = items.filter((it) => it.fase === "cerrada");

  const baseTxt = { interrupcion: "desde ultima interrupcion (cargada)", "interrupcion-auto": "desde interrupcion AUTO-detectada", hecho: "desde fecha del hecho", "inicio-proxy": "desde inicio del expte (PROXY, revisar)" };
  const autoNota = (it) => (it.baseFuente === "interrupcion-auto" && it.autoInterr) ? ` [AUTO, CONFIRMAR: ${it.autoInterr.tipo} - "${it.autoInterr.titulo}"]` : "";

  const lineaComp = (it) => {
    const susp = it.menorVictima ? " · [SUSPENSION POSIBLE si victima menor, art. 67]" : "";
    const penaNota = it.penaFuente === "tabla" ? " [pena de tabla, VERIFICAR VIGENCIA]" : (it.penaFuente === "cargada" ? "" : "");
    if (it.nivel === "prescripto") {
      return { txt: `[POSIBLE PRESCRIPCION OPERADA] ${it.ref} - ${it.caratula} | art. ${it.art || "?"} | termino ${it.termino}a${penaNota} | vencio ${f(it.venc)} (hace ${-it.restan} dia[s], ${baseTxt[it.baseFuente] || "?"})${autoNota(it)}${susp}`,
        html: `<li>[<b style="color:#8b1e1e">POSIBLE PRESCRIPCION OPERADA</b>] <b>${it.ref}</b> - ${it.caratula}<br><span style="color:#555">art. ${it.art || "?"} · termino ${it.termino} anios${penaNota} · vencio <b>${f(it.venc)}</b> (hace ${-it.restan} dia[s], ${baseTxt[it.baseFuente] || "?"})${autoNota(it)}${susp}</span></li>` };
    }
    const et = it.nivel === "urgente" ? "URGENTE" : "preventivo";
    return { txt: `[${et}] ${it.ref} - ${it.caratula} | art. ${it.art || "?"} | termino ${it.termino}a${penaNota} | vence ${f(it.venc)} - faltan ${it.restan} dia(s) (${baseTxt[it.baseFuente] || "?"})${autoNota(it)}${susp}`,
      html: `<li>[<b>${et}</b>] <b>${it.ref}</b> - ${it.caratula}<br><span style="color:#555">art. ${it.art || "?"} · termino ${it.termino} anios${penaNota} · vence <b>${f(it.venc)}</b> · faltan ${it.restan} dia(s) (${baseTxt[it.baseFuente] || "?"})${autoNota(it)}${susp}</span></li>` };
  };
  const lineaInc = (it) => {
    const faltan = [];
    if (!Number.isFinite(it.penaMax)) faltan.push("Pena Max (anios) o Delito (art. CP)");
    if (!it.base) faltan.push("Fecha Hecho o Ultima Interrupcion");
    return { txt: `[DATOS FALTANTES] ${it.ref} - ${it.caratula} | art. ${it.art || "?"} | falta: ${faltan.join(", ")}`,
      html: `<li>[<b style="color:#b58900">DATOS FALTANTES</b>] <b>${it.ref}</b> - ${it.caratula}<br><span style="color:#555">art. ${it.art || "?"} · falta cargar: ${faltan.join(", ")}</span></li>` };
  };
  const lineaCerr = (it) => {
    const c = it.cierre || {};
    return { txt: `[CAUSA CERRADA?] ${it.ref} - ${it.caratula} | ${c.tipo || "evento terminal"} el ${f(c.fecha)} ("${c.titulo || ""}") - CONFIRMAR; prescripcion no computada`,
      html: `<li>[<b style="color:#555">CAUSA CERRADA?</b>] <b>${it.ref}</b> - ${it.caratula}<br><span style="color:#777">${c.tipo || "evento terminal"} el <b>${f(c.fecha)}</b> ("${c.titulo || ""}") - CONFIRMAR; no se computa prescripcion</span></li>` };
  };

  // Si solo hay causas con evento terminal (nada que alertar), nota compacta y neutra.
  if (!computados.length && !incompletos.length && cerradas.length) {
    let t = `>>> PRESCRIPCION PENAL - sin alertas; ${cerradas.length} causa(s) con evento terminal detectado (CONFIRMAR) <<<\n`;
    let h = `<div style="border:1px solid #ccc;border-radius:4px;padding:6px 10px;margin:10px 0"><b style="color:#555">Prescripcion penal - sin alertas &middot; ${cerradas.length} causa(s) con evento terminal detectado (CONFIRMAR)</b><ul style="margin:6px 0">`;
    for (const it of cerradas) { const l = lineaCerr(it); t += "  " + l.txt + "\n"; h += l.html; }
    h += `</ul><div style="color:#777;font-size:12px">Eventos leidos de las actuaciones (extincion, sobreseimiento, condena, suspension del proceso a prueba). El "estado" del EJE puede estar desactualizado. Confirmar en el expediente.</div></div>`;
    return { texto: t, html: h, incompletos: 0, alerta: 0 };
  }

  let texto = `>>> PRESCRIPCION DE LA ACCION PENAL - ${computados.length} con computo${incompletos.length ? ` (+${incompletos.length} sin datos)` : ""}${cerradas.length ? ` (+${cerradas.length} cerrada[s]?)` : ""} (arts. 62-67 CP [VERIFICAR VIGENCIA]) <<<\n`;
  let html = `<div style="border:2px solid #8b1e1e;border-radius:4px;padding:8px 10px;margin:10px 0;background:#fbf0f0"><b style="color:#8b1e1e">PRESCRIPCION DE LA ACCION PENAL - ${computados.length} causa(s) con computo${incompletos.length ? ` &middot; ${incompletos.length} sin datos` : ""}${cerradas.length ? ` &middot; ${cerradas.length} cerrada(s)?` : ""} (arts. 62-67 CP)</b><ul style="margin:6px 0">`;
  for (const it of computados) { const l = lineaComp(it); texto += "  " + l.txt + "\n"; html += l.html; }
  for (const it of incompletos) { const l = lineaInc(it); texto += "  " + l.txt + "\n"; html += l.html; }
  for (const it of cerradas) { const l = lineaCerr(it); texto += "  " + l.txt + "\n"; html += l.html; }

  texto += "\n";
  texto += `  Computo: termino art. 62 (perpetua 15a; temporal = pena maxima, tope 12 / piso 2a; inhab. 5/1a; multa 2a) desde la fecha del hecho (art. 63) o el ultimo acto interruptivo (art. 67). Interrupcion TAXATIVA: indagatoria, requerimiento de elevacion, citacion a juicio, sentencia. Suspension mientras la victima sea menor en delitos sexuales (art. 67).\n`;
  texto += `  Es ORIENTATIVO. El abogado confirma la fecha del hecho, la pena maxima vigente del tipo, el ultimo acto interruptivo (secuela de juicio) y la suspension antes de articular o resistir la prescripcion.\n`;
  if (res.sinDatos) texto += `  Cargar en cartera-eje.xlsx: "Delito (art. CP)", "Fecha Hecho", "Pena Max (anios)" y "Ultima Interrupcion" para pasar de estimado a computo.\n`;

  html += `</ul><div style="color:#555;font-size:12px"><b>Computo:</b> termino art. 62 (perpetua 15a; temporal = pena maxima, <b>tope 12 / piso 2 anios</b>; inhab. 5/1a; multa 2a) desde la fecha del hecho (art. 63) o el ultimo acto interruptivo (art. 67). Interrupcion <b>taxativa</b>: indagatoria, requerimiento de elevacion, citacion a juicio, sentencia condenatoria. Suspension mientras la victima sea menor en delitos sexuales.<br><b>Es orientativo:</b> el abogado confirma fecha del hecho, pena maxima vigente, ultimo acto interruptivo y suspension antes de actuar. Las penas de la tabla interna estan marcadas [VERIFICAR VIGENCIA].</div></div>`;
  const alerta = computados.filter((it) => it.nivel === "prescripto" || it.nivel === "urgente").length;
  return { texto, html, incompletos: incompletos.length, alerta };
}
