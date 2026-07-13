/**
 * cartera-eje.mjs - Cartera de causas de CABA (JusCABA/EJE) en cartera-eje.xlsx.
 *
 * MODO HIBRIDO. A diferencia del PJN (que tiene feed autenticado de TUS novedades),
 * JusCABA es consulta publica: hay que decirle al bot que causas mirar. El bot:
 *   - DESCUBRE por nombre/criterio (EJE_CRITERIOS en .env) y agrega cada causa nueva.
 *   - CONSERVA intactas las columnas de gestion que vos cargues.
 *
 * DEPURACION DE HOMONIMOS. La busqueda por apellido trae causas ajenas (ej. una
 * ejecucion fiscal contra otra persona del mismo apellido). Para eso esta la columna
 * "Vigilar": el bot solo arma parte de las filas que NO tengan "NO" ahi. Es decir,
 * una causa recien descubierta se vigila por defecto (Vigilar en blanco); vos le
 * ponés "NO" a las que no son tuyas y desaparecen del parte (quedan en la cartera).
 *
 * Archivo PLANO (sin formato condicional ni graficos) para que exceljs lo reescriba
 * sin romper nada, igual que cartera-pjn.xlsx.
 *
 * Requiere: npm i exceljs.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\s+/g, " ").trim();
function txt(v) { if (v == null) return ""; if (typeof v === "object") { if (v.result !== undefined) return String(v.result); if (v.text !== undefined) return String(v.text); return ""; } return String(v); }

export function carteraEjePath() { return process.env.CARTERA_EJE_XLSX || fileURLToPath(new URL("../cartera-eje.xlsx", import.meta.url)); }

const BOT_HEADERS = ["CUIJ", "ExpId", "Caratula", "Tipo", "Fuero", "Estado", "Fecha Inicio", "Ult. Actuacion", "Detalle Ult. Actuacion"];
// Columnas CALCULADAS por el bot en cada corrida (caducidad CAyT + prescripcion penal). El
// bot las pisa siempre: son derivadas, no las carga el usuario. Van despues de las del bot.
const CALC_HEADERS = ["Caduc. Vence", "Caduc. Dias", "Caduc. Fase", "Caduc. Alerta", "Prescr. Vence", "Prescr. Dias", "Prescr. Alerta", "Plazos Actualizado"];
// Columnas de gestion que carga el usuario. "Fecha Impulso Real" / "Caducidad Meses" /
// "Caducidad Aplica" alimentan el modulo de caducidad (caducidad-eje.mjs).
const GESTION_HEADERS = ["Vigilar", "Ref/Cliente", "Fecha Impulso Real", "Caducidad Meses", "Caducidad Aplica", "Fecha Notif. Intimacion",
  // Prescripcion penal (arts. 62-67 CP). Alimentan prescripcion-penal-eje.mjs.
  "Delito (art. CP)", "Fecha Hecho", "Pena Max (anios)", "Ultima Interrupcion", "Prescripcion Aplica",
  "Observaciones"];

// Fuero CABA best-effort desde el tipo de expediente y la caratula (orientativo, no
// vinculante). El tipo "IPP" (Investigacion Penal Preparatoria) es senal fuerte de penal;
// una caratula "SOBRE <numero>" refiere a un articulo del CP/CC = penal/contravencional
// (a diferencia de "SOBRE AMPARO / EJECUCION FISCAL / EMPLEO PUBLICO", que son CAyT).
function fueroDeCaratula(car, tipo) {
  const t = norm(tipo);
  if (/\bipp\b|penal|contravencional|faltas|flagrancia/.test(t)) return "PCyF";
  const c = norm(car);
  if (/contravencional|faltas|penal/.test(c)) return "PCyF";
  if (/\bsobre\s+\d/.test(c)) return "PCyF"; // "SOBRE 89 - LESIONES", "SOBRE 119", etc.
  if (/ejecucion fiscal|ingresos brutos|abl|regimen simplificado|apremio/.test(c)) return "CAyT (ejec. fiscal)";
  if (/empleo publico|diferencias salariales|amparo|contra gcba|habilitacion|contravencion administrativa/.test(c)) return "CAyT";
  return "";
}

// Articulo/s del delito desde la caratula ("SOBRE 89 - LESIONES" -> "89"). Prefill de la
// columna "Delito (art. CP)" que usa el modulo de prescripcion. El abogado puede corregirlo.
function delitoDeCaratula(car) {
  const m = norm(car).match(/\bsobre\s+(\d{2,3}(?:\s*(?:bis|ter))?)/);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

// Vigilada = la columna Vigilar NO dice explicitamente que se descarte.
const DESCARTAR = new Set(["no", "0", "false", "ignorar", "descartar", "ajena", "homonimo"]);
export function esVigilada(valorVigilar) { return !DESCARTAR.has(norm(valorVigilar)); }

function keyDe(c) { return norm(c.cuij) || `exp:${c.expId}`; }

// Lee la cartera preservando columnas de gestion. Devuelve {headers, filas:Map, existe}.
async function leerCarteraObj(ExcelJS, p) {
  let headersPrev = [];
  const filas = new Map();
  if (!fs.existsSync(p)) return { headersPrev, filas, existe: false };
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(p);
  const ws = wb.worksheets[0];
  if (!ws) return { headersPrev, filas, existe: true };
  ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { headersPrev[i - 1] = String(c.text || "").trim(); });
  const iCuij = headersPrev.findIndex((h) => /cuij/.test(norm(h)));
  const iExp = headersPrev.findIndex((h) => /expid|exp id|exp\b/.test(norm(h)));
  for (let r = 2; r <= ws.rowCount; r++) {
    const o = {};
    headersPrev.forEach((h, i) => { if (h) o[h] = ws.getRow(r).getCell(i + 1).value; });
    const cuij = norm(txt(iCuij >= 0 ? ws.getRow(r).getCell(iCuij + 1).value : ""));
    const exp = txt(iExp >= 0 ? ws.getRow(r).getCell(iExp + 1).value : "");
    const k = cuij || (exp ? `exp:${exp}` : "");
    if (k) filas.set(k, o);
  }
  return { headersPrev, filas, existe: true };
}

/**
 * Agrega/actualiza causas descubiertas. causas: [{cuij,expId,caratula,estado,
 * fechaInicio, ultimaActuacion:{fecha,descripcion}}]. Preserva gestion.
 */
export async function upsertCausas({ causas }) {
  let ExcelJS; try { ExcelJS = (await import("exceljs")).default; } catch { return { nota: "falta exceljs (npm i exceljs)" }; }
  const p = carteraEjePath();
  const { headersPrev, filas } = await leerCarteraObj(ExcelJS, p);

  const H = { cuij: "CUIJ", exp: "ExpId", car: "Caratula", tipo: "Tipo", fue: "Fuero", est: "Estado", ini: "Fecha Inicio", ult: "Ult. Actuacion", det: "Detalle Ult. Actuacion", vig: "Vigilar", del: "Delito (art. CP)" };
  const set = (o, h, v) => { if (v != null && String(v).trim() !== "") o[h] = v; };
  const setSiVacio = (o, h, v) => { if (!txt(o[h]) && v != null && String(v).trim() !== "") o[h] = v; };

  let nuevas = 0, actualizadas = 0;
  for (const c of causas || []) {
    if (c.expId == null && !c.cuij) continue;
    const k = keyDe(c);
    const ua = c.ultimaActuacion || {};
    if (filas.has(k)) {
      const o = filas.get(k);
      set(o, H.car, txt(o[H.car]) ? txt(o[H.car]) : c.caratula);
      set(o, H.tipo, c.tipoExpediente || txt(o[H.tipo])); // el bot manda el tipo (IPP, etc.)
      // Recalcular fuero con tipo + caratula (pisa el vacio; respeta lo que cargo el usuario).
      set(o, H.fue, txt(o[H.fue]) ? txt(o[H.fue]) : fueroDeCaratula(c.caratula || txt(o[H.car]), c.tipoExpediente || txt(o[H.tipo])));
      o[H.est] = c.estado || o[H.est];
      set(o, H.ini, txt(o[H.ini]) ? txt(o[H.ini]) : c.fechaInicio);
      if (ua.fecha) o[H.ult] = ua.fecha;
      if (ua.descripcion) o[H.det] = ua.descripcion;
      if (c.expId != null) o[H.exp] = c.expId;
      setSiVacio(o, H.del, delitoDeCaratula(c.caratula || txt(o[H.car]))); // no pisa lo que cargo el usuario
      actualizadas++;
    } else {
      filas.set(k, {
        [H.cuij]: c.cuij || "", [H.exp]: c.expId ?? "", [H.car]: c.caratula || "",
        [H.tipo]: c.tipoExpediente || "",
        [H.fue]: fueroDeCaratula(c.caratula || "", c.tipoExpediente || ""), [H.est]: c.estado || "", [H.ini]: c.fechaInicio || "",
        [H.ult]: ua.fecha || "", [H.det]: ua.descripcion || "",
        [H.vig]: "", // en blanco = se vigila; el usuario pone "NO" a los homonimos.
        [H.del]: delitoDeCaratula(c.caratula || ""), // prefill del articulo del delito (penal).
      });
      nuevas++;
    }
  }

  // Encabezado: columnas del bot + calculadas + extras existentes + columnas de gestion faltantes.
  const conocidas = [...BOT_HEADERS, ...CALC_HEADERS];
  const prev = headersPrev.filter(Boolean);
  const extras = prev.filter((h) => !conocidas.some((b) => norm(b) === norm(h)));
  const faltantes = GESTION_HEADERS.filter((g) => !extras.some((e) => norm(e) === norm(g)) && !conocidas.some((b) => norm(b) === norm(g)));
  const headers = [...BOT_HEADERS, ...CALC_HEADERS, ...extras, ...faltantes];

  // Completar Fuero (orientativo) si quedo vacio en alguna fila.
  for (const o of filas.values()) {
    if (!txt(o[H.fue])) { const f = fueroDeCaratula(txt(o[H.car])); if (f) o[H.fue] = f; }
  }

  // Ordenar por estado luego caratula.
  const lista = [...filas.values()].sort((a, b) => txt(a[H.car]).localeCompare(txt(b[H.car])));
  const wb2 = new ExcelJS.Workbook();
  const ws2 = wb2.addWorksheet("CAUSAS CABA");
  ws2.addRow(headers);
  ws2.getRow(1).font = { bold: true };
  for (const o of lista) {
    ws2.addRow(headers.map((h) => { const v = o[h]; return (v && typeof v === "object" && v.result !== undefined) ? v.result : (v ?? null); }));
  }
  await wb2.xlsx.writeFile(p);
  return { nuevas, actualizadas, total: lista.length, archivo: p };
}

// ─── volcado de plazos calculados a cartera-eje.xlsx ──────────────────────────
// Escribe en cada fila el vencimiento de caducidad (art. 216 CAyT) y de prescripcion penal.
// Se llama con los arrays "todas" (no solo las en riesgo). Match por CUIJ / exp:ExpId.
const fmtDiaD = (d) => d instanceof Date && !isNaN(d) ? new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "numeric" }).format(d) : "";
const faseCaducEje = { intimada: "INTIMADA", habilitado: "HABILITADO", encurso: "en curso" };
const alertaCaducEje = { vencido: "PERENTORIO VENCIDO", urgente: "URGENTE", preventivo: "preventivo", habilitado: "HABILITADO PARA INTIMAR", lejano: "en termino" };
const alertaPrescrEje = { prescripto: "POSIBLE PRESCRIPCION OPERADA", urgente: "URGENTE", preventivo: "preventivo", lejano: "en termino" };
function keyDeCalc(it) { return norm(it.cuij) || (it.expId != null && String(it.expId).trim() ? `exp:${String(it.expId).trim()}` : ""); }

export async function volcarCalculos({ caducidad = [], prescripcion = [] } = {}) {
  let ExcelJS; try { ExcelJS = (await import("exceljs")).default; } catch { return { nota: "falta exceljs" }; }
  const p = carteraEjePath();
  if (!fs.existsSync(p)) return { nota: "sin cartera-eje.xlsx" };
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(p);
  const ws = wb.worksheets[0];
  if (!ws) return { nota: "sin hoja" };

  const headers = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { headers[i - 1] = String(c.text || "").trim(); });
  const iCuij = headers.findIndex((h) => /cuij/.test(norm(h)));
  const iExp = headers.findIndex((h) => /expid|exp id|exp\b/.test(norm(h)));
  if (iCuij < 0 && iExp < 0) return { nota: "cartera-eje sin CUIJ/ExpId" };
  for (const h of CALC_HEADERS) if (!headers.some((x) => norm(x) === norm(h))) { headers.push(h); ws.getRow(1).getCell(headers.length).value = h; }
  ws.getRow(1).font = { bold: true };
  const ci = (name) => headers.findIndex((h) => norm(h) === norm(name)) + 1;
  const cCadV = ci("Caduc. Vence"), cCadD = ci("Caduc. Dias"), cCadF = ci("Caduc. Fase"), cCadA = ci("Caduc. Alerta");
  const cPreV = ci("Prescr. Vence"), cPreD = ci("Prescr. Dias"), cPreA = ci("Prescr. Alerta"), cAct = ci("Plazos Actualizado");
  // Columnas de entrada penal: el bot las auto-completa (marca [auto]) SOLO si estan vacias,
  // con el delito/pena que dedujo de la caratula. Lo cargado a mano NUNCA se pisa.
  const ciBusca = (pred) => headers.findIndex((h) => pred(norm(h))) + 1;
  const cDelito = ciBusca((x) => x.includes("delito"));
  const cPenaMax = ciBusca((x) => x.includes("pena") && x.includes("max"));

  const mCad = new Map(); for (const it of caducidad) { const k = keyDeCalc(it); if (k) mCad.set(k, it); }
  const mPre = new Map(); for (const it of prescripcion) { const k = keyDeCalc(it); if (k) mPre.set(k, it); }
  const hoyTxt = fmtDiaD(new Date());

  let escritas = 0;
  for (let r = 2; r <= ws.rowCount; r++) {
    const cuij = iCuij >= 0 ? norm(txt(ws.getRow(r).getCell(iCuij + 1).value)) : "";
    const exp = iExp >= 0 ? txt(ws.getRow(r).getCell(iExp + 1).value).trim() : "";
    const k = cuij || (exp ? `exp:${exp}` : "");
    if (!k) continue;
    const cad = mCad.get(k), pre = mPre.get(k);
    const row = ws.getRow(r);
    row.getCell(cCadV).value = cad ? fmtDiaD(cad.venc) : "";
    row.getCell(cCadD).value = cad ? cad.restan : "";
    row.getCell(cCadF).value = cad ? (faseCaducEje[cad.fase] || cad.fase || "") : "";
    row.getCell(cCadA).value = cad ? (alertaCaducEje[cad.nivel] || cad.nivel || "") : "";
    // Prescripcion: con computo -> fecha/dias/alerta; sin datos suficientes -> nota de que falta.
    row.getCell(cPreV).value = (pre && !pre.faltaDato) ? fmtDiaD(pre.venc) : "";
    row.getCell(cPreD).value = (pre && !pre.faltaDato) ? pre.restan : "";
    row.getCell(cPreA).value = pre ? (pre.faltaDato ? pre.motivo : (alertaPrescrEje[pre.nivel] || pre.nivel || "")) : "";
    // Auto-completar delito y pena deducidos de la caratula, solo en celdas vacias.
    if (pre && pre.art && cDelito && !txt(row.getCell(cDelito).value).trim()) {
      row.getCell(cDelito).value = `${pre.art} [auto]`;
    }
    if (pre && cPenaMax && Number.isFinite(pre.penaMax) && pre.penaFuente === "tabla" && !txt(row.getCell(cPenaMax).value).trim()) {
      row.getCell(cPenaMax).value = pre.penaMax;
    }
    row.getCell(cAct).value = (cad || pre) ? hoyTxt : "";
    if (cad || pre) escritas++;
  }
  await wb.xlsx.writeFile(p);
  return { escritas, archivo: p };
}

// Devuelve las causas a vigilar (Vigilar != NO). [{key,cuij,expId,caratula,estado,ultActFecha}]
export async function leerVigiladas() {
  let ExcelJS; try { ExcelJS = (await import("exceljs")).default; } catch { return { causas: [], nota: "falta exceljs" }; }
  const p = carteraEjePath();
  const { filas, existe } = await leerCarteraObj(ExcelJS, p);
  if (!existe) return { causas: [], nota: "cartera-eje.xlsx todavia no existe (correr descubrir-eje.mjs)" };
  const out = [];
  for (const [k, o] of filas) {
    if (!esVigilada(txt(o["Vigilar"]))) continue;
    const expId = txt(o["ExpId"]).trim();
    if (!expId) continue;
    out.push({
      key: k, cuij: txt(o["CUIJ"]), expId: /^\d+$/.test(expId) ? Number(expId) : expId,
      caratula: txt(o["Caratula"]), estado: txt(o["Estado"]),
      ultActFecha: txt(o["Ult. Actuacion"]),
    });
  }
  return { causas: out, archivo: p };
}
