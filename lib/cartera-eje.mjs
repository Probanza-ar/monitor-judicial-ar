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

  // Encabezado: columnas del bot + extras existentes + columnas de gestion faltantes.
  const prev = headersPrev.filter(Boolean);
  const extras = prev.filter((h) => !BOT_HEADERS.some((b) => norm(b) === norm(h)));
  const faltantes = GESTION_HEADERS.filter((g) => !extras.some((e) => norm(e) === norm(g)) && !BOT_HEADERS.some((b) => norm(b) === norm(g)));
  const headers = [...BOT_HEADERS, ...extras, ...faltantes];

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
