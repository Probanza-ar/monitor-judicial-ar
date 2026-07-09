/**
 * caducidad-eje.mjs - Caducidad de instancia JUDICIAL del fuero CAyT de la CABA.
 *
 * Base normativa (fuente unica: reglas-plazos.mjs; corregido jul-2026 contra
 *   argentina.gob.ar, Ley 6.402):
 *   Codigo Contencioso Administrativo y Tributario CABA, Ley 189, texto consolidado
 *   por Ley 6.347 [VERIFICAR VIGENCIA - confirmar consolidacion posterior]:
 *     - Arts. 260/261: 6 meses de inactividad por causa imputable al ACTOR (1ra inst.) ->
 *       el tribunal intima (art. 265, t. Ley 6.402); dentro de 5 dias habiles el actor
 *       debe acreditar la prosecucion; si no, se declara la caducidad de oficio (art. 266)
 *       y se archiva. NO opera en procesos colectivos ni con interes publico/social/de
 *       tercero.
 *     - Computo en dias habiles judiciales para la intimacion (art. 136 Ley 189, t.c. Ley
 *       6.764, VERIFICADO texto literal juristeca.jusbaires.gob.ar jul-2026: 'dias habiles
 *       todos los del anio, con excepcion de los que determine el Reglamento que dicte el
 *       Consejo de la Magistratura'; el caracter perentorio de los plazos esta en el art. 139,
 *       no en el 137 como se cito antes sin verificar). Feria e inhabiles se descuentan
 *       (feria-caba.json descontarEnCaducidad = true).
 *
 * CADUCIDAD BIFASICA. Cumplir los 6 meses NO fulmina la instancia: habilita la etapa de
 * intimacion. El modulo distingue tres fases por causa:
 *   - "en curso"   : todavia no se cumplieron los 6 meses. Avisa al acercarse.
 *   - "habilitado" : pasaron los 6 meses sin impulso -> HABILITADO PARA INTIMAR.
 *   - "intimada"   : cargada "Fecha Notif. Intimacion" -> corre la cuenta PERENTORIA de
 *                    30 dias habiles (art. 216 + 122). Vencida sin acreditar prosecucion,
 *                    procede acusar/declarar la caducidad.
 *
 * OJO: esto es lo JUDICIAL (CAyT). La caducidad ADMINISTRATIVA de la LPA (DNU 1.510/97,
 * 60+30 dias) es otra cosa y NO la ve el EJE.
 *
 * Es un CALCULADOR de alerta, no una decision: que el acto sea imputable al actor, si la
 * causa esta exceptuada (amparo/colectivo/interes publico) y las fechas las confirma el
 * abogado. Segun a quien represente, es riesgo (actor) u oportunidad de acusarla (demandado).
 *
 * Lee cartera-eje.xlsx (via CARTERA_EJE_XLSX). Requiere: npm i exceljs.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { CADUCIDAD, JURIS } from "./reglas-plazos.mjs";

// Regla CABA CAyT (Ley 189 art. 216/122) desde la fuente unica de reglas.
const REGLA = CADUCIDAD[JURIS.CABA_CAYT];

const DIA_MS = 24 * 60 * 60 * 1000;
const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\s+/g, " ").trim();
const txt = (c) => { const v = c && c.value; if (v == null) return ""; if (typeof v === "object") { if (v.result !== undefined) return String(v.result); if (v.text !== undefined) return String(v.text); return ""; } return String(v); };

const CFG = {
  meses: Number(process.env.EJE_CADUCIDAD_MESES || REGLA.plazos.default),
  intimacionDias: Number(process.env.EJE_CADUCIDAD_INTIMACION_DIAS || REGLA.intimacionPrevia.dias),
  avisoDias: Number(process.env.EJE_CADUCIDAD_AVISO_DIAS || 45),
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

// Feria CABA (propia, NO la de la CSJN). feria-caba.json.
function cargarFeriaCaba() {
  try {
    const p = fileURLToPath(new URL("../feria-caba.json", import.meta.url));
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const rangos = []; const set = new Set();
    // Suma feria anual + inhabiles excepcionales (asuetos ad-hoc del TSJ). Acepta rango
    // 'YYYY-MM-DD..YYYY-MM-DD' o fecha suelta 'YYYY-MM-DD'. Todo cuenta como inhabil.
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
// Suma n dias HABILES desde el dia siguiente (regla general: el plazo corre desde el dia
// siguiente a la notificacion). Para la cuenta perentoria del art. 265 (t. Ley 6.402),
// hoy 5 dias habiles - ver CFG.intimacionDias, no hardcodear el numero aqui.
function sumarDiasHabiles(fecha, n, fer, feriaSet) {
  let d = new Date(fecha.getTime()), contados = 0, g = 0;
  while (contados < n && g++ < 2000) { d = new Date(d.getTime() + DIA_MS); if (esHabil(d, fer, feriaSet)) contados++; }
  return d;
}
function overlapDias(aIni, aFin, bIni, bFin) { const ini = Math.max(aIni.getTime(), bIni.getTime()); const fin = Math.min(aFin.getTime(), bFin.getTime() + DIA_MS); return Math.max(0, Math.floor((fin - ini) / DIA_MS)); }

const estadoCerrado = (e) => /archiv|termin|finaliz|concluid|sentencia firme|cobrad|desist|caduc/i.test(String(e || ""));
// La caducidad de instancia del art. 216 es del fuero CAyT. NO aplica a penal ni
// contravencional (fuero PCyF), que tienen sus propios institutos (prescripcion, etc.).
// Se excluye por: tipo IPP/penal, fuero PCyF, o caratula "SOBRE <art. CP/CC>" (numero).
const fueroNoCaduca = (fuero, caratula, tipo) => {
  const meta = norm(`${fuero} ${tipo}`);
  if (/pcyf|penal|contravencional|faltas|\bipp\b|flagrancia/.test(meta)) return true;
  const c = norm(caratula);
  if (/pcyf|penal|contravencional|faltas/.test(c)) return true;
  if (/\bsobre\s+\d/.test(c)) return true; // "SOBRE 89 - LESIONES", "SOBRE 119", etc.
  return false;
};
// Amparo (Ley 2145 CABA): la jurisprudencia CAyT rechaza la caducidad de instancia por
// incompatibilidad con el resguardo de derechos. Se excluye por defecto (heuristica por
// caratula); el usuario puede forzar la inclusion con "Caducidad Aplica" = SI.
const esAmparo = (caratula) => /\bamparo\b/.test(norm(caratula));

function elegirHoja(wb) { return wb.worksheets.find((w) => /causa|exped/i.test(w.name)) || wb.worksheets[0]; }
function colDe(ws, headerRow, pred) { let f = null; ws.getRow(headerRow).eachCell({ includeEmpty: false }, (c, i) => { if (f == null && pred(norm(c.text))) f = i; }); return f; }

export async function calcularCaducidadEje() {
  const def = fileURLToPath(new URL("../cartera-eje.xlsx", import.meta.url));
  const entrada = process.env.CARTERA_EJE_XLSX || def;
  if (!fs.existsSync(entrada)) return { items: [], nota: "sin cartera-eje.xlsx (correr descubrir-eje.mjs)" };

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
  const cUlt = colDe(ws, H, (x) => x.includes("ult") && x.includes("actuacion") && !x.includes("detalle"));
  const cImp = colDe(ws, H, (x) => x.includes("impulso"));
  const cMeses = colDe(ws, H, (x) => x.includes("caducidad") && x.includes("mes"));
  const cAplica = colDe(ws, H, (x) => x.includes("caducidad") && x.includes("aplica"));
  const cIntim = colDe(ws, H, (x) => x.includes("intimacion") || (x.includes("notif") && x.includes("intim")));
  const cVig = colDe(ws, H, (x) => x === "vigilar");
  if (!cCar) return { items: [], nota: "cartera-eje.xlsx sin columna Caratula" };

  let ultMov = new Map();
  try { const { estadoPrevio } = await import("./movimientos-eje.mjs"); ultMov = estadoPrevio(); } catch { /* sin log */ }

  const feria = cargarFeriaCaba();
  const feriados = cargarFeriadosSet();
  const hoy = new Date();
  const items = [];
  let sinImpulso = 0, excluidosAmparo = 0;

  for (let r = H + 1; r <= (ws.rowCount || H); r++) {
    const row = ws.getRow(r);
    const caratula = cCar ? txt(row.getCell(cCar)) : "";
    const expId = cExp ? txt(row.getCell(cExp)).trim() : "";
    if (!caratula && !expId) continue;
    const cuij = cCuij ? txt(row.getCell(cCuij)) : "";
    const tipo = cTipo ? txt(row.getCell(cTipo)) : "";
    const fuero = cFue ? txt(row.getCell(cFue)) : "";
    const estado = cEst ? txt(row.getCell(cEst)) : "";
    const vigilar = cVig ? txt(row.getCell(cVig)) : "";
    const aplica = norm(cAplica ? txt(row.getCell(cAplica)) : "");

    if (/^(no|0|false)$/.test(norm(vigilar))) continue;      // no vigilada
    if (/^(no|0|false)$/.test(aplica)) continue;             // excluida a mano
    if (estadoCerrado(estado)) continue;
    if (fueroNoCaduca(fuero, caratula, tipo)) continue;      // penal/contravencional (PCyF)
    const forzarSi = /^(si|1|true)$/.test(aplica);
    if (esAmparo(caratula) && !forzarSi) { excluidosAmparo++; continue; } // amparo -> excluido salvo override

    // Impulso: fecha cargada (verificada) o ultimo movimiento (estimado).
    let impulso = cImp ? parseFecha(row.getCell(cImp).value) : null;
    const verificado = !!impulso;
    if (!impulso) {
      impulso = cUlt ? parseFecha(row.getCell(cUlt).value) : null;
      const mv = expId ? ultMov.get(String(expId)) : null;
      if (mv && mv.fecha && (!impulso || mv.fecha > impulso)) impulso = mv.fecha;
    }
    if (!impulso) continue;
    if (!verificado) sinImpulso++;

    const meses = (cMeses && Number(String(txt(row.getCell(cMeses))).replace(/[^\d]/g, ""))) || CFG.meses;
    const intimacion = cIntim ? parseFecha(row.getCell(cIntim).value) : null;
    const base = { ref: cuij || `exp ${expId}`, caratula, fuero, impulso, verificado, meses, dias: Math.floor((hoy - impulso) / DIA_MS) };

    if (intimacion) {
      // FASE INTIMADA: cuenta perentoria de CFG.intimacionDias dias habiles (art. 265,
      // t. Ley 6.402 - hoy 5 dias, ver REGLA.intimacionPrevia en reglas-plazos.mjs).
      const venc = proximoHabil(sumarDiasHabiles(intimacion, CFG.intimacionDias, feriados, feria.set), feriados, feria.set);
      const restan = Math.floor((venc - hoy) / DIA_MS);
      items.push({ ...base, fase: "intimada", intimacion, venc, restan, nivel: restan < 0 ? "vencido" : (restan <= 10 ? "urgente" : "preventivo") });
      continue;
    }

    // Vencimiento de los 6 meses (feria descontada si esta activa y cargada). Prorroga habil.
    let venc6 = sumarMeses(impulso, meses); let feriaDias = 0;
    if (feria.descontar && feria.rangos.length) {
      let extra = -1, g = 0;
      while (g++ < 8) { let fd = 0; for (const f of feria.rangos) fd += overlapDias(impulso, venc6, f.desde, f.hasta); if (fd === extra) break; extra = fd; venc6 = new Date(sumarMeses(impulso, meses).getTime() + fd * DIA_MS); feriaDias = fd; }
    }
    const venc = proximoHabil(venc6, feriados, feria.set);
    const restan = Math.floor((venc - hoy) / DIA_MS);

    if (restan < 0) {
      // FASE HABILITADO: pasaron los 6 meses sin intimacion cargada.
      items.push({ ...base, fase: "habilitado", venc, restan, feriaDias, nivel: "habilitado" });
    } else if (restan <= CFG.avisoDias) {
      // FASE EN CURSO: se acerca el vencimiento de los 6 meses.
      items.push({ ...base, fase: "encurso", venc, restan, feriaDias, nivel: restan <= 15 ? "urgente" : "preventivo" });
    }
  }

  // Orden: intimada primero (perentorio), luego habilitado, luego en curso; por restante.
  const ordenFase = { intimada: 0, habilitado: 1, encurso: 2 };
  items.sort((a, b) => (ordenFase[a.fase] - ordenFase[b.fase]) || (a.restan - b.restan));
  return { items, sinImpulso, excluidosAmparo, feriaCargada: feria.cargada, descuentaFeria: feria.descontar, nota: null };
}

export function renderCaducidadEje(res) {
  if (!res || !res.items || !res.items.length) return null;
  const items = res.items;
  const f = (d) => new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
  const revision = items.filter((it) => !it.verificado).length;
  const intimadas = items.filter((it) => it.fase === "intimada").length;

  const lineaItem = (it) => {
    if (it.fase === "intimada") {
      const r = it.restan < 0 ? `PLAZO PERENTORIO VENCIDO hace ${-it.restan} dia(s)` : `perentorio vence en ${it.restan} dia habil(es)`;
      return { txt: `[INTIMADA] ${it.ref} - ${it.caratula} | intimacion ${f(it.intimacion)} | ${CFG.intimacionDias} dias habiles vencen ${f(it.venc)} - ${r}`,
        html: `<li>[<b style="color:#8b1e1e">INTIMADA</b>] <b>${it.ref}</b> - ${it.caratula}<br><span style="color:#555">intimacion ${f(it.intimacion)} &middot; ${CFG.intimacionDias} dias habiles vencen <b>${f(it.venc)}</b> &middot; <b>${r}</b></span></li>` };
    }
    if (it.fase === "habilitado") {
      const est = it.verificado ? "" : " (ult. mov. estimado)";
      return { txt: `[HABILITADO PARA INTIMAR] ${it.ref} - ${it.caratula} | 6 meses cumplidos el ${f(it.venc)} (hace ${-it.restan} dia[s] sin impulso${est})`,
        html: `<li>[<b style="color:#b58900">HABILITADO PARA INTIMAR</b>] <b>${it.ref}</b> - ${it.caratula}<br><span style="color:#555">6 meses cumplidos el <b>${f(it.venc)}</b> &middot; hace ${-it.restan} dia(s) sin impulso${est}</span>${it.verificado ? "" : `<br><b style="color:#8b1e1e">Sin "Fecha Impulso Real": el ultimo movimiento puede no ser impulso imputable al actor.</b>`}</li>` };
    }
    const et = it.nivel === "urgente" ? "URGENTE" : "preventivo";
    const est = it.verificado ? "" : " (estimado)";
    return { txt: `[${et}] ${it.ref} - ${it.caratula} | ult. mov. ${f(it.impulso)}${est} | ${it.meses}m vencen ${f(it.venc)} - faltan ${it.restan} dia(s)`,
      html: `<li>[<b>${et}</b>] <b>${it.ref}</b> - ${it.caratula}<br><span style="color:#555">ult. mov. ${f(it.impulso)}${est} &middot; ${it.meses} meses vencen <b>${f(it.venc)}</b> &middot; faltan ${it.restan} dia(s)</span>${it.verificado ? "" : `<br><b style="color:#8b1e1e">Sin "Fecha Impulso Real" cargada.</b>`}</li>` };
  };

  let texto = `>>> CADUCIDAD DE INSTANCIA CAyT - ${items.length} causa(s)${intimadas ? ` (${intimadas} INTIMADA/S)` : ""} (arts. 260/265/266 Ley 189, t. Ley 6.402 [VERIFICAR VIGENCIA]) <<<\n`;
  let html = `<div style="border:2px solid #b58900;border-radius:4px;padding:8px 10px;margin:10px 0;background:#fdf6e3"><b style="color:#1e3a8b">CADUCIDAD DE INSTANCIA CAyT - ${items.length} causa(s)${intimadas ? ` &middot; ${intimadas} INTIMADA/S` : ""} (arts. 260/265/266 Ley 189, t. Ley 6.402)</b><ul style="margin:6px 0">`;
  for (const it of items) { const l = lineaItem(it); texto += "  " + l.txt + "\n"; html += l.html; }
  texto += "\n";
  texto += `  Fases: EN CURSO (faltan dias para los ${CFG.meses} meses) -> HABILITADO PARA INTIMAR (6 meses cumplidos) -> INTIMADA (cargar "Fecha Notif. Intimacion": corre el perentorio de ${CFG.intimacionDias} dias habiles, art. 265 Ley 189 t. Ley 6.402). Solo cuenta la inactividad imputable al ACTOR.\n`;
  texto += `  Excluidos por defecto: amparos (Ley 2145 [VERIFICAR VIGENCIA]${res.excluidosAmparo ? `, ${res.excluidosAmparo} en esta cartera` : ""}), procesos colectivos e interes publico. Para forzar el computo en una causa: "Caducidad Aplica" = SI.\n`;
  if (!res.feriaCargada) texto += `  [REVISION NORMATIVA REQUERIDA] feria-caba.json sin rangos: el descuento de feria del art. 122 esta activado pero no hay fechas cargadas. Cargar la feria judicial CABA.\n`;
  if (res.sinImpulso) texto += `  ATENCION: ${res.sinImpulso} causa(s) sin "Fecha Impulso Real"; reloj estimado sobre el ultimo movimiento.\n`;
  texto += `  Confirmar el acto impulsorio, su imputabilidad al actor, la fecha de intimacion y las excepciones antes de acusar o impulsar.\n`;

  html += `</ul><div style="color:#555;font-size:12px"><b>Fases:</b> EN CURSO &rarr; HABILITADO PARA INTIMAR (6 meses) &rarr; INTIMADA (cargar "Fecha Notif. Intimacion" &rarr; perentorio de ${CFG.intimacionDias} dias habiles, art. 265 Ley 189 t. Ley 6.402 [VERIFICAR VIGENCIA]). Solo cuenta la inactividad imputable al ACTOR.<br><b>Excluidos por defecto:</b> amparos (Ley 2145 [VERIFICAR VIGENCIA]${res.excluidosAmparo ? `, ${res.excluidosAmparo} aqui` : ""}), colectivos e interes publico; forzar con "Caducidad Aplica" = SI.`;
  if (!res.feriaCargada) html += `<br><b style="color:#8b1e1e">[REVISION NORMATIVA REQUERIDA]</b> feria-caba.json sin rangos: descuento de feria activo pero sin fechas. Cargar la feria judicial CABA.`;
  if (res.sinImpulso) html += `<br><b>Atencion:</b> ${res.sinImpulso} causa(s) sin "Fecha Impulso Real"; reloj estimado.`;
  html += `<br>El abogado confirma el acto impulsorio, su imputabilidad, la fecha de intimacion y las excepciones antes de actuar.</div></div>`;
  return { texto, html, revision };
}
