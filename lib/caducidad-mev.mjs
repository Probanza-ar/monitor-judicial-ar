/**
 * caducidad-mev.mjs - Caducidad de instancia en Provincia de Buenos Aires
 * (arts. 310/311/315 CPCC BA, Dec-Ley 7.425/68; 310 y 315 texto Ley 13.986/2009).
 *
 * Reglas desde lib/reglas-plazos.mjs (JURIS.PBA) [VERIFICAR VIGENCIA]:
 *   - Art. 310: 6 meses (1ra/unica instancia); 3 meses (2da/ulterior, justicia de paz,
 *     sumario, sumarisimo, ejecutivo); o el plazo de prescripcion si fuere menor.
 *   - Art. 311 (t. Ley 12.357): corre desde el ultimo acto impulsorio. Computo
 *     conservador: meses corridos con descuento de feria (feria-pba.json) [VERIFICAR].
 *   - Art. 315: NO se declara de plano. INTIMACION PREVIA por unica vez: 5 dias para
 *     manifestar la intencion de continuar y producir actividad util. BIFASICA:
 *       "en curso"   -> no se cumplio el plazo del 310. Avisa al acercarse.
 *       "habilitado" -> plazo cumplido sin impulso: la contraparte puede pedir la
 *                       caducidad (el juzgado intima antes de declarar).
 *       "intimada"   -> cargada "Fecha Notif. Intimacion": corren los 5 dias HABILES
 *                       perentorios del art. 315.
 *
 * Exclusiones automaticas: fuero Penal (rige la prescripcion, no la caducidad) y
 * fuero Laboral (impulso de oficio, Ley 11.653) [VERIFICAR VIGENCIA]. Familia y de
 * Paz COMPUTAN (con el plazo que corresponda). Override manual con "Caducidad
 * Aplica" = SI/NO. A diferencia de CABA, el amparo NO se excluye por defecto
 * (regimen Ley 13.928: proceso sumarisimo) [REVISION NORMATIVA REQUERIDA: criterio
 * jurisprudencial SCBA sobre caducidad en amparo; si se decide excluir, va aca].
 *
 * Es un CALCULADOR de alerta, no una decision. El abogado confirma acto impulsorio,
 * imputabilidad, fechas y excepciones. Lee cartera-mev.xlsx. Requiere exceljs.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { CADUCIDAD, JURIS, plazoCaducidadMeses } from "./reglas-plazos.mjs";

const REGLA = CADUCIDAD[JURIS.PBA];

const DIA_MS = 24 * 60 * 60 * 1000;
const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\s+/g, " ").trim();
const txt = (c) => { const v = c && c.value; if (v == null) return ""; if (typeof v === "object") { if (v.result !== undefined) return String(v.result); if (v.text !== undefined) return String(v.text); return ""; } return String(v); };

const CFG = {
  intimacionDias: Number(process.env.MEV_CADUCIDAD_INTIMACION_DIAS || REGLA.intimacionPrevia.dias), // 5 habiles (art. 315)
  avisoDias: Number(process.env.MEV_CADUCIDAD_AVISO_DIAS || 45),
};

function parseFecha(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) return v;
  if (typeof v === "object" && v.result instanceof Date) return v.result;
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);
  if (m) { const a = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]); const d = new Date(a, Number(m[2]) - 1, Number(m[1])); return isNaN(d) ? null : d; }
  const d = new Date(s); return isNaN(d) ? null : d;
}
function sumarMeses(fecha, meses) {
  const d = new Date(fecha.getTime()); const dia = d.getDate();
  d.setMonth(d.getMonth() + meses); if (d.getDate() < dia) d.setDate(0);
  return d;
}
const isoLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// Feria judicial PBA (SCBA: enero + invierno) + inhabiles excepcionales. feria-pba.json.
function cargarFeriaPba() {
  try {
    const p = fileURLToPath(new URL("../feria-pba.json", import.meta.url));
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const rangos = []; const set = new Set();
    const agregar = (arr) => {
      for (const r of arr || []) {
        const s = String(r).trim();
        const m = s.match(/^(\d{4}-\d{2}-\d{2})\s*\.\.\s*(\d{4}-\d{2}-\d{2})$/);
        if (m) {
          rangos.push({ desde: new Date(m[1] + "T00:00:00"), hasta: new Date(m[2] + "T00:00:00") });
          let cur = new Date(m[1] + "T00:00:00Z"); const fin = new Date(m[2] + "T00:00:00Z"); let g = 0;
          while (cur <= fin && g++ < 400) { set.add(cur.toISOString().slice(0, 10)); cur = new Date(cur.getTime() + DIA_MS); }
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
          rangos.push({ desde: new Date(s + "T00:00:00"), hasta: new Date(s + "T00:00:00") });
          set.add(s);
        }
      }
    };
    agregar(j.ferias);
    agregar(j.inhabilesExcepcionales);
    const cargada = (j.ferias || []).length > 0 || (j.inhabilesExcepcionales || []).length > 0;
    return { rangos, set, descontar: j.descontarEnCaducidad === true, cargada };
  } catch { return { rangos: [], set: new Set(), descontar: false, cargada: false }; }
}
function cargarFeriadosSet() {
  const set = new Set();
  try {
    const p = fileURLToPath(new URL("../feriados.json", import.meta.url));
    const arr = JSON.parse(fs.readFileSync(p, "utf8"));
    for (const raw of arr) {
      const s = String(raw).trim();
      const m = s.match(/^(\d{4}-\d{2}-\d{2})\s*\.\.\s*(\d{4}-\d{2}-\d{2})$/);
      if (m) { let cur = new Date(m[1] + "T00:00:00Z"); const fin = new Date(m[2] + "T00:00:00Z"); let g = 0; while (cur <= fin && g++ < 400) { set.add(cur.toISOString().slice(0, 10)); cur = new Date(cur.getTime() + DIA_MS); } }
      else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) set.add(s);
    }
  } catch { /* solo finde */ }
  return set;
}
const esHabil = (d, fer, feriaSet) => { const dow = d.getDay(); if (dow === 0 || dow === 6) return false; const iso = isoLocal(d); return !fer.has(iso) && !feriaSet.has(iso); };
function proximoHabil(d, fer, feriaSet) { let x = new Date(d.getTime()), g = 0; while (!esHabil(x, fer, feriaSet) && g++ < 90) x = new Date(x.getTime() + DIA_MS); return x; }
function sumarDiasHabiles(fecha, n, fer, feriaSet) {
  let d = new Date(fecha.getTime()), contados = 0, g = 0;
  while (contados < n && g++ < 2000) { d = new Date(d.getTime() + DIA_MS); if (esHabil(d, fer, feriaSet)) contados++; }
  return d;
}
function overlapDias(aIni, aFin, bIni, bFin) { const ini = Math.max(aIni.getTime(), bIni.getTime()); const fin = Math.min(aFin.getTime(), bFin.getTime() + DIA_MS); return Math.max(0, Math.floor((fin - ini) / DIA_MS)); }

const estadoCerrado = (e) => /archiv|termin|finaliz|concluid|sentencia firme|cobrad|desist|caduc|para destruir|destru/i.test(String(e || ""));
// Exclusion por fuero segun reglas-plazos (PBA excluye penal y laboral).
const fueroNoCaduca = (fuero, organismo, jurisdiccion) => {
  const t = norm(`${fuero} ${organismo} ${jurisdiccion}`);
  return /penal|garant|correccional|casacion|flagrancia|responsabilidad penal|trabajo|laboral/.test(t);
};

function elegirHoja(wb) { return wb.worksheets.find((w) => /causa|exped/i.test(w.name)) || wb.worksheets[0]; }
function colDe(ws, headerRow, pred) { let f = null; ws.getRow(headerRow).eachCell({ includeEmpty: false }, (c, i) => { if (f == null && pred(norm(c.text))) f = i; }); return f; }

export async function calcularCaducidadMev() {
  const entrada = process.env.CARTERA_MEV_XLSX || fileURLToPath(new URL("../cartera-mev.xlsx", import.meta.url));
  if (!fs.existsSync(entrada)) return { items: [], nota: "sin cartera-mev.xlsx (correr descubrir-mev.mjs)" };

  let ExcelJS; try { ExcelJS = (await import("exceljs")).default; } catch { return { items: [], nota: "falta exceljs" }; }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(entrada);
  const ws = elegirHoja(wb); if (!ws) return { items: [], nota: "sin hoja de causas" };

  const H = 1;
  const cNid = colDe(ws, H, (x) => x.includes("nidcausa"));
  const cJuz = colDe(ws, H, (x) => x.includes("pidjuzgado"));
  const cOrg = colDe(ws, H, (x) => x.includes("organismo"));
  const cJur = colDe(ws, H, (x) => x.includes("jurisdiccion"));
  const cFue = colDe(ws, H, (x) => x === "fuero");
  const cCar = colDe(ws, H, (x) => x.includes("caratula"));
  const cEst = colDe(ws, H, (x) => x.includes("estado"));
  const cExp = colDe(ws, H, (x) => x.includes("expediente"));
  const cUlt = colDe(ws, H, (x) => x.includes("ult") && x.includes("paso") && !x.includes("detalle"));
  const cImp = colDe(ws, H, (x) => x.includes("impulso"));
  const cMeses = colDe(ws, H, (x) => x.includes("caducidad") && x.includes("mes"));
  const cAplica = colDe(ws, H, (x) => x.includes("caducidad") && x.includes("aplica"));
  const cIntim = colDe(ws, H, (x) => x.includes("intimacion") || (x.includes("notif") && x.includes("intim")));
  const cVig = colDe(ws, H, (x) => x === "vigilar");
  if (!cCar) return { items: [], nota: "cartera-mev.xlsx sin columna Caratula" };

  let ultMov = new Map();
  try { const { estadoPrevio } = await import("./movimientos-mev.mjs"); ultMov = estadoPrevio(); } catch { /* sin log */ }

  const feria = cargarFeriaPba();
  const feriados = cargarFeriadosSet();
  const hoy = new Date();
  const items = [];
  let sinImpulso = 0;

  for (let r = H + 1; r <= (ws.rowCount || H); r++) {
    const row = ws.getRow(r);
    const caratula = cCar ? txt(row.getCell(cCar)) : "";
    const nid = cNid ? txt(row.getCell(cNid)).trim() : "";
    if (!caratula && !nid) continue;
    const juz = cJuz ? txt(row.getCell(cJuz)).trim() : "";
    const organismo = cOrg ? txt(row.getCell(cOrg)) : "";
    const jurisdiccion = cJur ? txt(row.getCell(cJur)) : "";
    const fuero = cFue ? txt(row.getCell(cFue)) : "";
    const estado = cEst ? txt(row.getCell(cEst)) : "";
    const expediente = cExp ? txt(row.getCell(cExp)) : "";
    const vigilar = cVig ? txt(row.getCell(cVig)) : "";
    const aplica = norm(cAplica ? txt(row.getCell(cAplica)) : "");

    if (/^(no|0|false)$/.test(norm(vigilar))) continue;
    if (/^(no|0|false)$/.test(aplica)) continue;
    if (estadoCerrado(estado)) continue;
    const forzarSi = /^(si|1|true)$/.test(aplica);
    if (fueroNoCaduca(fuero, organismo, jurisdiccion) && !forzarSi) continue; // penal/laboral

    let impulso = cImp ? parseFecha(row.getCell(cImp).value) : null;
    const verificado = !!impulso;
    if (!impulso) {
      impulso = cUlt ? parseFecha(row.getCell(cUlt).value) : null;
      const mv = nid ? ultMov.get(`${nid}|${juz}`) : null;
      if (mv && mv.fecha && (!impulso || mv.fecha > impulso)) impulso = mv.fecha;
    }
    if (!impulso) continue;
    if (!verificado) sinImpulso++;

    // Plazo del art. 310 segun tipo de proceso/instancia (organismo + caratula):
    // justicia de paz / ejecutivo / sumario / sumarisimo / 2da instancia = 3 meses.
    const detectado = plazoCaducidadMeses(JURIS.PBA, { texto: `${organismo} ${caratula} ${jurisdiccion}` });
    const meses = (cMeses && Number(String(txt(row.getCell(cMeses))).replace(/[^\d]/g, ""))) || detectado;
    const intimacion = cIntim ? parseFecha(row.getCell(cIntim).value) : null;
    const base = { ref: expediente || `nid ${nid}`, caratula, fuero: fuero || organismo, impulso, verificado, meses, dias: Math.floor((hoy - impulso) / DIA_MS) };

    if (intimacion) {
      // FASE INTIMADA: 5 dias habiles perentorios (art. 315; plazo desde el dia siguiente).
      const venc = proximoHabil(sumarDiasHabiles(intimacion, CFG.intimacionDias, feriados, feria.set), feriados, feria.set);
      const restan = Math.floor((venc - hoy) / DIA_MS);
      items.push({ ...base, fase: "intimada", intimacion, venc, restan, nivel: restan < 0 ? "vencido" : (restan <= 3 ? "urgente" : "preventivo") });
      continue;
    }

    let vencP = sumarMeses(impulso, meses); let feriaDias = 0;
    if (feria.descontar && feria.rangos.length) {
      let extra = -1, g = 0;
      while (g++ < 8) { let fd = 0; for (const f of feria.rangos) fd += overlapDias(impulso, vencP, f.desde, f.hasta); if (fd === extra) break; extra = fd; vencP = new Date(sumarMeses(impulso, meses).getTime() + fd * DIA_MS); feriaDias = fd; }
    }
    const venc = proximoHabil(vencP, feriados, feria.set);
    const restan = Math.floor((venc - hoy) / DIA_MS);

    if (restan < 0) items.push({ ...base, fase: "habilitado", venc, restan, feriaDias, nivel: "habilitado" });
    else if (restan <= CFG.avisoDias) items.push({ ...base, fase: "encurso", venc, restan, feriaDias, nivel: restan <= 15 ? "urgente" : "preventivo" });
  }

  const ordenFase = { intimada: 0, habilitado: 1, encurso: 2 };
  items.sort((a, b) => (ordenFase[a.fase] - ordenFase[b.fase]) || (a.restan - b.restan));
  return { items, sinImpulso, feriaCargada: feria.cargada, descuentaFeria: feria.descontar, nota: null };
}

export function renderCaducidadMev(res) {
  if (!res || !res.items || !res.items.length) return null;
  const items = res.items;
  const f = (d) => new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
  const revision = items.filter((it) => !it.verificado).length;
  const intimadas = items.filter((it) => it.fase === "intimada").length;

  const lineaItem = (it) => {
    if (it.fase === "intimada") {
      const r = it.restan < 0 ? `PLAZO PERENTORIO VENCIDO hace ${-it.restan} dia(s)` : `perentorio vence en ${it.restan} dia(s)`;
      return { txt: `[INTIMADA] ${it.ref} - ${it.caratula} | intimacion ${f(it.intimacion)} | ${CFG.intimacionDias} dias habiles vencen ${f(it.venc)} - ${r}`,
        html: `<li>[<b style="color:#8b1e1e">INTIMADA</b>] <b>${it.ref}</b> - ${it.caratula}<br><span style="color:#555">intimacion ${f(it.intimacion)} &middot; ${CFG.intimacionDias} dias habiles vencen <b>${f(it.venc)}</b> &middot; <b>${r}</b></span></li>` };
    }
    if (it.fase === "habilitado") {
      const est = it.verificado ? "" : " (ult. mov. estimado)";
      return { txt: `[PLAZO CUMPLIDO] ${it.ref} - ${it.caratula} | ${it.meses} meses cumplidos el ${f(it.venc)} (hace ${-it.restan} dia[s] sin impulso${est}) - riesgo de pedido de caducidad / intimacion art. 315`,
        html: `<li>[<b style="color:#b58900">PLAZO CUMPLIDO</b>] <b>${it.ref}</b> - ${it.caratula}<br><span style="color:#555">${it.meses} meses cumplidos el <b>${f(it.venc)}</b> &middot; hace ${-it.restan} dia(s) sin impulso${est} &middot; riesgo de pedido de caducidad / intimacion art. 315</span>${it.verificado ? "" : `<br><b style="color:#8b1e1e">Sin "Fecha Impulso Real": el ultimo paso puede no ser impulso imputable al actor.</b>`}</li>` };
    }
    const et = it.nivel === "urgente" ? "URGENTE" : "preventivo";
    const est = it.verificado ? "" : " (estimado)";
    return { txt: `[${et}] ${it.ref} - ${it.caratula} | ult. mov. ${f(it.impulso)}${est} | ${it.meses}m vencen ${f(it.venc)} - faltan ${it.restan} dia(s)`,
      html: `<li>[<b>${et}</b>] <b>${it.ref}</b> - ${it.caratula}<br><span style="color:#555">ult. mov. ${f(it.impulso)}${est} &middot; ${it.meses} meses vencen <b>${f(it.venc)}</b> &middot; faltan ${it.restan} dia(s)</span>${it.verificado ? "" : `<br><b style="color:#8b1e1e">Sin "Fecha Impulso Real" cargada.</b>`}</li>` };
  };

  let texto = `>>> CADUCIDAD DE INSTANCIA PBA - ${items.length} causa(s)${intimadas ? ` (${intimadas} INTIMADA/S)` : ""} (art. 310/315 CPCC BA, Ley 13.986 [VERIFICAR VIGENCIA]) <<<\n`;
  let html = `<div style="border:2px solid #b58900;border-radius:4px;padding:8px 10px;margin:10px 0;background:#fdf6e3"><b style="color:#1e3a8b">CADUCIDAD DE INSTANCIA PBA - ${items.length} causa(s)${intimadas ? ` &middot; ${intimadas} INTIMADA/S` : ""} (art. 310/315 CPCC BA)</b><ul style="margin:6px 0">`;
  for (const it of items) { const l = lineaItem(it); texto += "  " + l.txt + "\n"; html += l.html; }
  texto += "\n";
  texto += `  Plazos art. 310: 6 meses (1ra/unica instancia); 3 meses (2da instancia, justicia de paz, sumario, sumarisimo, ejecutivo); o la prescripcion si fuere menor [el bot NO computa esa variante: confirmarla a mano]. Fases: EN CURSO -> PLAZO CUMPLIDO -> INTIMADA (cargar "Fecha Notif. Intimacion": corren ${CFG.intimacionDias} dias habiles perentorios, art. 315). Solo cuenta la inactividad imputable al ACTOR.\n`;
  texto += `  Excluidos automaticos: fuero Penal (rige prescripcion) y Laboral (impulso de oficio, Ley 11.653 [VERIFICAR VIGENCIA]). Amparo NO se excluye por defecto [REVISION NORMATIVA REQUERIDA: criterio SCBA]. Overrides: "Caducidad Aplica" = SI/NO.\n`;
  if (!res.feriaCargada) texto += `  [REVISION NORMATIVA REQUERIDA] feria-pba.json sin rangos: cargar la feria judicial de la SCBA (enero e invierno) para el descuento del computo.\n`;
  if (res.sinImpulso) texto += `  ATENCION: ${res.sinImpulso} causa(s) sin "Fecha Impulso Real"; reloj estimado sobre el ultimo paso.\n`;
  texto += `  Confirmar acto impulsorio, imputabilidad al actor, fecha de intimacion y excepciones antes de acusar o impulsar.\n`;

  html += `</ul><div style="color:#555;font-size:12px"><b>Plazos art. 310:</b> 6 meses (1ra/unica) &middot; 3 meses (2da, paz, sumario, sumarisimo, ejecutivo) &middot; o la prescripcion si fuere menor (confirmar a mano). <b>Fases:</b> EN CURSO &rarr; PLAZO CUMPLIDO &rarr; INTIMADA (${CFG.intimacionDias} dias habiles perentorios, art. 315 [VERIFICAR VIGENCIA]).<br><b>Excluidos:</b> Penal y Laboral (Ley 11.653). Amparo computa por defecto [REVISION NORMATIVA REQUERIDA]. Overrides con "Caducidad Aplica".`;
  if (!res.feriaCargada) html += `<br><b style="color:#8b1e1e">[REVISION NORMATIVA REQUERIDA]</b> feria-pba.json sin rangos: cargar la feria SCBA.`;
  if (res.sinImpulso) html += `<br><b>Atencion:</b> ${res.sinImpulso} causa(s) sin "Fecha Impulso Real"; reloj estimado.`;
  html += `<br>El abogado confirma el acto impulsorio, su imputabilidad, la fecha de intimacion y las excepciones antes de actuar.</div></div>`;
  return { texto, html, revision };
}
