/**
 * prescripcion-penal-mev.mjs - Prescripcion de la ACCION penal (arts. 62-67 CP)
 * para la cartera PENAL de la MEV (SCBA, Provincia de Buenos Aires).
 *
 * El Codigo Penal es NACIONAL: rige igual en Nacion, CABA y Provincia. En el fuero
 * penal provincial la caducidad de instancia (art. 310 CPCC BA) NO aplica; el
 * instituto extintivo por inaccion es la PRESCRIPCION de la accion. Este modulo es
 * el analogo provincial de prescripcion-penal-eje.mjs: misma logica, mismo nucleo
 * compartido (penal-base.mjs), distinta cartera (cartera-mev.xlsx) y distinta
 * deteccion de fuero (organismos penales de la SCBA en vez del PCyF de CABA).
 *
 * Base normativa (CP Ley 11.179; texto actualizado InfoLEG norma 16546; art. 67 t.
 * Ley 27.206) [VERIFICAR VIGENCIA]. Ver detalle y arts. 62-67 en penal-base.mjs /
 * reglas-plazos.mjs. Nota provincial: el procedimiento penal PBA (Ley 11.922 y
 * mod.) regula la secuela; los actos interruptivos del art. 67 CP son los mismos
 * (indagatoria/declaracion del imputado art. 308 CPP BA, requerimiento de
 * elevacion a juicio, citacion a juicio, sentencia).
 *
 * QUE AUTOMATIZA y QUE NO: identico al modulo del EJE.
 *   - Pena maxima: AUTO desde el articulo del CP (tabla penal-base, prefill [VERIFICAR]).
 *   - Ultima interrupcion (art. 67): AUTO-detectable escaneando los pasos procesales
 *     de la MEV, SI el parte provee un fetchPasos(causa). Marcado [AUTO, CONFIRMAR].
 *     El dato manual de la cartera SIEMPRE tiene prioridad.
 *   - Fecha del hecho: manual (no esta en datos estructurados de la MEV). Si falta, se
 *     usa la Fecha Inicio del expediente como PROXY (sobreestima el riesgo).
 * Es una CALCULADORA ASISTIDA: el acto interruptivo, la suspension y el computo
 * definitivo son del abogado.
 *
 * Columnas de cartera-mev.xlsx que lee (mismas que la cartera EJE):
 *   "Delito (art. CP)", "Fecha Hecho", "Pena Max (anios)", "Ultima Interrupcion",
 *   "Prescripcion Aplica" (SI/NO override). Requiere exceljs.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { norm, parseFecha, sumarAnios, terminoArt62, articuloDe, TABLA_PENAS, detectarInterrupcion, detectarCierre } from "./penal-base.mjs";

const DIA_MS = 24 * 60 * 60 * 1000;
const txt = (c) => { const v = c && c.value; if (v == null) return ""; if (typeof v === "object") { if (v.result !== undefined) return String(v.result); if (v.text !== undefined) return String(v.text); return ""; } return String(v); };

const CFG = {
  avisoDias: Number(process.env.MEV_PRESCRIPCION_AVISO_DIAS || 180), // avisa a 6 meses del venc.
};

// Fuero penal PBA por fuero/organismo. Los organismos penales de la SCBA: Juzgado/Camara
// de Garantias, Garantias del Joven, Tribunal/Juzgado en lo Correccional, Tribunal Oral
// Criminal, Ejecucion Penal, Responsabilidad Penal Juvenil, Casacion Penal, UFI/Fiscalia.
function esFueroPenal(fuero, organismo) {
  return /penal|garant|correccional|criminal|ejecucion penal|responsabilidad penal|casacion penal|\bufi\b|fiscal|flagrancia|juicio abreviado/.test(norm(`${fuero} ${organismo}`));
}
const estadoCerrado = (e) => /archiv|sobresei|prescri|extingu|absol|conden.*firme|para destruir|destru/i.test(String(e || ""));

// Mapea un paso procesal de la MEV al shape que espera penal-base ({titulo, codigo, fechaFirma}).
const pasoAActuacion = (p) => ({ titulo: p.descripcion || "", codigo: "", fechaFirma: p.fechaHora || p.fecha || "" });

function elegirHoja(wb) { return wb.worksheets.find((w) => /causa|exped/i.test(w.name)) || wb.worksheets[0]; }
function colDe(ws, headerRow, pred) { let f = null; ws.getRow(headerRow).eachCell({ includeEmpty: false }, (c, i) => { if (f == null && pred(norm(c.text))) f = i; }); return f; }

// opts.fetchPasos(causa) -> Promise<[{descripcion,fecha,fechaHora}]>: si se pasa, el modulo
// detecta cierre y ultima interrupcion (art. 67) de las causas sin dato manual.
export async function calcularPrescripcionMev(opts = {}) {
  const fetchPasos = typeof opts.fetchPasos === "function" ? opts.fetchPasos : null;
  const entrada = process.env.CARTERA_MEV_XLSX || fileURLToPath(new URL("../cartera-mev.xlsx", import.meta.url));
  if (!fs.existsSync(entrada)) return { items: [], nota: "sin cartera-mev.xlsx" };

  let ExcelJS; try { ExcelJS = (await import("exceljs")).default; } catch { return { items: [], nota: "falta exceljs" }; }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(entrada);
  const ws = elegirHoja(wb); if (!ws) return { items: [], nota: "sin hoja de causas" };

  const H = 1;
  const cNid = colDe(ws, H, (x) => x.includes("nidcausa"));
  const cJuz = colDe(ws, H, (x) => x.includes("pidjuzgado"));
  const cOrg = colDe(ws, H, (x) => x.includes("organismo"));
  const cFue = colDe(ws, H, (x) => x === "fuero");
  const cCar = colDe(ws, H, (x) => x.includes("caratula"));
  const cEst = colDe(ws, H, (x) => x.includes("estado"));
  const cExp = colDe(ws, H, (x) => x.includes("expediente"));
  const cIni = colDe(ws, H, (x) => x.includes("fecha") && x.includes("inicio"));
  const cVig = colDe(ws, H, (x) => x === "vigilar");
  const cDelito = colDe(ws, H, (x) => x.includes("delito"));
  const cHecho = colDe(ws, H, (x) => x.includes("fecha") && x.includes("hecho"));
  const cPena = colDe(ws, H, (x) => x.includes("pena") && x.includes("max"));
  const cInterr = colDe(ws, H, (x) => x.includes("interrupcion"));
  const cAplica = colDe(ws, H, (x) => x.includes("prescripcion") && x.includes("aplica"));
  if (!cCar) return { items: [], nota: "cartera-mev.xlsx sin columna Caratula" };

  const hoy = new Date();
  const items = [];
  let sinDatos = 0;

  for (let r = H + 1; r <= (ws.rowCount || H); r++) {
    const row = ws.getRow(r);
    const caratula = txt(row.getCell(cCar));
    const nid = cNid ? txt(row.getCell(cNid)).trim() : "";
    if (!caratula && !nid) continue;
    const pidJuzgado = cJuz ? txt(row.getCell(cJuz)).trim() : "";
    const organismo = cOrg ? txt(row.getCell(cOrg)) : "";
    const fuero = cFue ? txt(row.getCell(cFue)) : "";
    const estado = cEst ? txt(row.getCell(cEst)) : "";
    const expediente = cExp ? txt(row.getCell(cExp)) : "";
    const vigilar = cVig ? txt(row.getCell(cVig)) : "";
    const aplica = norm(cAplica ? txt(row.getCell(cAplica)) : "");

    if (/^(no|0|false)$/.test(norm(vigilar))) continue;
    if (/^(no|0|false)$/.test(aplica)) continue;                 // excluida a mano

    const forzar = /^(si|1|true)$/.test(aplica);
    if (!esFueroPenal(fuero, organismo) && !forzar) continue;    // solo penal
    if (estadoCerrado(estado) && !forzar) continue;

    const delito = cDelito ? txt(row.getCell(cDelito)) : "";
    const art = articuloDe(delito, caratula);
    const ref = expediente || `nid ${nid}`;

    // Pena maxima: columna cargada > tabla interna (prefill) > desconocida.
    let penaMax = cPena ? Number(String(txt(row.getCell(cPena))).replace(",", ".").replace(/[^\d.]/g, "")) : NaN;
    let penaFuente = "cargada";
    if (!Number.isFinite(penaMax) || penaMax <= 0) {
      const t = TABLA_PENAS[art];
      if (t) { penaMax = t.max; penaFuente = "tabla"; }
      else { penaMax = NaN; penaFuente = "desconocida"; }
    }
    const menorVictima = (TABLA_PENAS[art] && TABLA_PENAS[art].menor) || false;

    const interr = cInterr ? parseFecha(row.getCell(cInterr).value) : null;
    let hecho = cHecho ? parseFecha(row.getCell(cHecho).value) : null;

    // Escaneo de pasos (una vez, si el parte lo provee): detecta cierre e interrupcion.
    let autoInterr = null, cierre = null;
    if (fetchPasos && nid) {
      try {
        const pasos = await fetchPasos({ nidCausa: nid, pidJuzgado });
        const acts = (pasos || []).map(pasoAActuacion);
        cierre = detectarCierre(acts);
        if (!interr) autoInterr = detectarInterrupcion(acts);
      } catch { /* sigue con hecho/proxy */ }
    }
    if (cierre && !forzar) { items.push({ ref, caratula, art, fase: "cerrada", cierre }); continue; }

    let baseFuente = interr ? "interrupcion" : (autoInterr ? "interrupcion-auto" : (hecho ? "hecho" : ""));
    let base = interr || (autoInterr && autoInterr.fecha) || hecho;
    if (!base && cIni) { base = parseFecha(row.getCell(cIni).value); if (base) baseFuente = "inicio-proxy"; }

    const termino = terminoArt62(penaMax);
    const faltaDato = !Number.isFinite(penaMax) || !base || !termino;
    if (faltaDato) {
      sinDatos++;
      items.push({ ref, caratula, art, fase: "incompleto", penaMax, penaFuente, base, baseFuente, autoInterr, menorVictima, termino });
      continue;
    }

    const venc = sumarAnios(base, termino);
    const restan = Math.floor((venc - hoy) / DIA_MS);
    const nivel = restan < 0 ? "prescripto" : (restan <= CFG.avisoDias ? (restan <= 60 ? "urgente" : "preventivo") : "lejano");
    if (nivel === "lejano") continue;
    items.push({ ref, caratula, art, fase: "computado", penaMax, penaFuente, base, baseFuente, autoInterr, menorVictima, termino, venc, restan, nivel });
  }

  const ordFase = { computado: 0, incompleto: 1, cerrada: 2 };
  const ordNivel = { prescripto: 0, urgente: 1, preventivo: 2 };
  items.sort((a, b) => (ordFase[a.fase] - ordFase[b.fase]) || ((ordNivel[a.nivel] ?? 9) - (ordNivel[b.nivel] ?? 9)) || ((a.restan ?? 0) - (b.restan ?? 0)));
  return { items, sinDatos, nota: null };
}

export function renderPrescripcionMev(res) {
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
    const penaNota = it.penaFuente === "tabla" ? " [pena de tabla, VERIFICAR VIGENCIA]" : "";
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

  if (!computados.length && !incompletos.length && cerradas.length) {
    let t = `>>> PRESCRIPCION PENAL PBA - sin alertas; ${cerradas.length} causa(s) con evento terminal detectado (CONFIRMAR) <<<\n`;
    let h = `<div style="border:1px solid #ccc;border-radius:4px;padding:6px 10px;margin:10px 0"><b style="color:#555">Prescripcion penal PBA - sin alertas &middot; ${cerradas.length} causa(s) con evento terminal detectado (CONFIRMAR)</b><ul style="margin:6px 0">`;
    for (const it of cerradas) { const l = lineaCerr(it); t += "  " + l.txt + "\n"; h += l.html; }
    h += `</ul><div style="color:#777;font-size:12px">Eventos leidos de los pasos procesales (extincion, sobreseimiento, condena, suspension del proceso a prueba). El "estado" de la MEV puede estar desactualizado. Confirmar en el expediente.</div></div>`;
    return { texto: t, html: h, incompletos: 0, alerta: 0 };
  }

  let texto = `>>> PRESCRIPCION DE LA ACCION PENAL (PBA) - ${computados.length} con computo${incompletos.length ? ` (+${incompletos.length} sin datos)` : ""}${cerradas.length ? ` (+${cerradas.length} cerrada[s]?)` : ""} (arts. 62-67 CP [VERIFICAR VIGENCIA]) <<<\n`;
  let html = `<div style="border:2px solid #8b1e1e;border-radius:4px;padding:8px 10px;margin:10px 0;background:#fbf0f0"><b style="color:#8b1e1e">PRESCRIPCION DE LA ACCION PENAL (PBA) - ${computados.length} causa(s) con computo${incompletos.length ? ` &middot; ${incompletos.length} sin datos` : ""}${cerradas.length ? ` &middot; ${cerradas.length} cerrada(s)?` : ""} (arts. 62-67 CP)</b><ul style="margin:6px 0">`;
  for (const it of computados) { const l = lineaComp(it); texto += "  " + l.txt + "\n"; html += l.html; }
  for (const it of incompletos) { const l = lineaInc(it); texto += "  " + l.txt + "\n"; html += l.html; }
  for (const it of cerradas) { const l = lineaCerr(it); texto += "  " + l.txt + "\n"; html += l.html; }

  texto += "\n";
  texto += `  Computo: termino art. 62 (perpetua 15a; temporal = pena maxima, tope 12 / piso 2a; inhab. 5/1a; multa 2a) desde la fecha del hecho (art. 63) o el ultimo acto interruptivo (art. 67). Interrupcion TAXATIVA: declaracion del imputado (art. 308 CPP BA)/indagatoria, requerimiento de elevacion, citacion a juicio, sentencia. Suspension mientras la victima sea menor en delitos sexuales (art. 67).\n`;
  texto += `  Es ORIENTATIVO. El abogado confirma la fecha del hecho, la pena maxima vigente del tipo, el ultimo acto interruptivo y la suspension antes de articular o resistir la prescripcion.\n`;
  if (res.sinDatos) texto += `  Cargar en cartera-mev.xlsx: "Delito (art. CP)", "Fecha Hecho", "Pena Max (anios)" y "Ultima Interrupcion" para pasar de estimado a computo.\n`;

  html += `</ul><div style="color:#555;font-size:12px"><b>Computo:</b> termino art. 62 (perpetua 15a; temporal = pena maxima, <b>tope 12 / piso 2 anios</b>; inhab. 5/1a; multa 2a) desde la fecha del hecho (art. 63) o el ultimo acto interruptivo (art. 67). Interrupcion <b>taxativa</b>: declaracion del imputado/indagatoria, requerimiento de elevacion, citacion a juicio, sentencia condenatoria. Suspension mientras la victima sea menor en delitos sexuales.<br><b>Es orientativo:</b> el abogado confirma fecha del hecho, pena maxima vigente, ultimo acto interruptivo y suspension antes de actuar. Las penas de la tabla interna estan marcadas [VERIFICAR VIGENCIA].</div></div>`;
  const alerta = computados.filter((it) => it.nivel === "prescripto" || it.nivel === "urgente").length;
  return { texto, html, incompletos: incompletos.length, alerta };
}
