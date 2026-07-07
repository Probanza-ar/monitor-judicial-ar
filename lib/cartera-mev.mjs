/**
 * cartera-mev.mjs - Cartera de causas de Provincia de Buenos Aires (MEV/SCBA)
 * en cartera-mev.xlsx.
 *
 * MODO HIBRIDO como el EJE, con una ventaja: la MEV tiene SETS server-side.
 * El bot siembra la cartera desde:
 *   - el set "Lista de Causas con AUTORIZACION" (causas reservadas autorizadas), y/o
 *   - los sets propios del usuario (MEV_SETS), y/o
 *   - busqueda por caratula (MEV_CRITERIOS) en organismos no penales.
 * La columna "Vigilar" depura homonimos igual que en el EJE (NO = no vigilar).
 *
 * Clave de causa: nidCausa + pidJuzgado (el nidCausa es unico por organismo).
 * Archivo PLANO para que exceljs lo reescriba sin romper nada. Requiere exceljs.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\s+/g, " ").trim();
function txt(v) { if (v == null) return ""; if (typeof v === "object") { if (v.result !== undefined) return String(v.result); if (v.text !== undefined) return String(v.text); return ""; } return String(v); }

export function carteraMevPath() { return process.env.CARTERA_MEV_XLSX || fileURLToPath(new URL("../cartera-mev.xlsx", import.meta.url)); }

const BOT_HEADERS = ["NidCausa", "PidJuzgado", "Organismo", "Jurisdiccion", "Fuero", "Caratula", "Estado",
  "Nro Expediente", "Nro Receptoria", "Fecha Inicio", "Ult. Paso", "Detalle Ult. Paso"];
// Columnas de gestion del usuario. Alimentan caducidad-mev.mjs (art. 310/315 CPCC BA)
// y, a futuro, la prescripcion penal (pendiente de modulo propio para PBA).
const GESTION_HEADERS = ["Vigilar", "Ref/Cliente", "Fecha Impulso Real", "Caducidad Meses", "Caducidad Aplica",
  "Fecha Notif. Intimacion", "Delito (art. CP)", "Fecha Hecho", "Pena Max (anios)", "Ultima Interrupcion",
  "Prescripcion Aplica", "Observaciones"];

/**
 * Fuero best-effort desde el ORGANISMO (los nombres del MEV son elocuentes) y la
 * jurisdiccion (si se entro con Fuero Penal / Familia). Orientativo, no vinculante.
 */
export function fueroDeOrganismo(organismo, jurisdiccion = "") {
  const o = norm(`${organismo} ${jurisdiccion}`);
  if (/penal|garant|correccional|casacion|ejecucion penal|responsabilidad penal juvenil|flagrancia/.test(o)) return "Penal";
  if (/trabajo|laboral/.test(o)) return "Laboral";
  if (/familia/.test(o)) return "Familia";
  if (/contencioso/.test(o)) return "Cont. Adm.";
  if (/\bpaz\b/.test(o)) return "Paz";
  if (/civil y comercial|civil|comercial/.test(o)) return "Civil y Comercial";
  return "";
}

const DESCARTAR = new Set(["no", "0", "false", "ignorar", "descartar", "ajena", "homonimo"]);
export function esVigilada(v) { return !DESCARTAR.has(norm(v)); }

const keyDe = (c) => `${String(c.nidCausa).trim()}|${String(c.pidJuzgado || "").trim()}`;

async function leerCarteraObj(ExcelJS, p) {
  let headersPrev = [];
  const filas = new Map();
  if (!fs.existsSync(p)) return { headersPrev, filas, existe: false };
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(p);
  const ws = wb.worksheets[0];
  if (!ws) return { headersPrev, filas, existe: true };
  ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { headersPrev[i - 1] = String(c.text || "").trim(); });
  const iNid = headersPrev.findIndex((h) => /nidcausa|nid causa/.test(norm(h)));
  const iJuz = headersPrev.findIndex((h) => /pidjuzgado|pid juzgado/.test(norm(h)));
  for (let r = 2; r <= ws.rowCount; r++) {
    const o = {};
    headersPrev.forEach((h, i) => { if (h) o[h] = ws.getRow(r).getCell(i + 1).value; });
    const nid = txt(iNid >= 0 ? ws.getRow(r).getCell(iNid + 1).value : "").trim();
    const juz = txt(iJuz >= 0 ? ws.getRow(r).getCell(iJuz + 1).value : "").trim();
    if (nid) filas.set(`${nid}|${juz}`, o);
  }
  return { headersPrev, filas, existe: true };
}

/**
 * Agrega/actualiza causas. causas: [{nidCausa,pidJuzgado,organismo,jurisdiccion,caratula,
 * estado,expediente,receptoria,fechaInicio,ultimoMovimiento:{fecha,descripcion}}].
 * Preserva las columnas de gestion cargadas por el usuario.
 */
export async function upsertCausas({ causas }) {
  let ExcelJS; try { ExcelJS = (await import("exceljs")).default; } catch { return { nota: "falta exceljs (npm i exceljs)" }; }
  const p = carteraMevPath();
  const { headersPrev, filas } = await leerCarteraObj(ExcelJS, p);

  const H = { nid: "NidCausa", juz: "PidJuzgado", org: "Organismo", jur: "Jurisdiccion", fue: "Fuero", car: "Caratula",
    est: "Estado", exp: "Nro Expediente", rec: "Nro Receptoria", ini: "Fecha Inicio", ult: "Ult. Paso", det: "Detalle Ult. Paso", vig: "Vigilar" };
  const setSiVacio = (o, h, v) => { if (!txt(o[h]) && v != null && String(v).trim() !== "") o[h] = v; };

  let nuevas = 0, actualizadas = 0;
  for (const c of causas || []) {
    if (!c || c.nidCausa == null) continue;
    const k = keyDe(c);
    const um = c.ultimoMovimiento || {};
    if (filas.has(k)) {
      const o = filas.get(k);
      setSiVacio(o, H.car, c.caratula);
      setSiVacio(o, H.org, c.organismo);
      setSiVacio(o, H.jur, c.jurisdiccion);
      setSiVacio(o, H.fue, fueroDeOrganismo(c.organismo || txt(o[H.org]), c.jurisdiccion || txt(o[H.jur])));
      if (c.estado) o[H.est] = c.estado;
      setSiVacio(o, H.exp, c.expediente);
      setSiVacio(o, H.rec, c.receptoria);
      setSiVacio(o, H.ini, c.fechaInicio);
      if (um.fecha) o[H.ult] = um.fecha;
      if (um.descripcion) o[H.det] = um.descripcion;
      actualizadas++;
    } else {
      filas.set(k, {
        [H.nid]: String(c.nidCausa), [H.juz]: String(c.pidJuzgado || ""), [H.org]: c.organismo || "",
        [H.jur]: c.jurisdiccion || "", [H.fue]: fueroDeOrganismo(c.organismo || "", c.jurisdiccion || ""),
        [H.car]: c.caratula || "", [H.est]: c.estado || "", [H.exp]: c.expediente || "",
        [H.rec]: c.receptoria || "", [H.ini]: c.fechaInicio || "",
        [H.ult]: um.fecha || "", [H.det]: um.descripcion || "",
        [H.vig]: "", // en blanco = vigilada; "NO" = homonimo/ajena.
      });
      nuevas++;
    }
  }

  const prev = headersPrev.filter(Boolean);
  const extras = prev.filter((h) => !BOT_HEADERS.some((b) => norm(b) === norm(h)));
  const faltantes = GESTION_HEADERS.filter((g) => !extras.some((e) => norm(e) === norm(g)) && !BOT_HEADERS.some((b) => norm(b) === norm(g)));
  const headers = [...BOT_HEADERS, ...extras, ...faltantes];

  const lista = [...filas.values()].sort((a, b) => txt(a["Caratula"]).localeCompare(txt(b["Caratula"])));
  const wb2 = new ExcelJS.Workbook();
  const ws2 = wb2.addWorksheet("CAUSAS PBA");
  ws2.addRow(headers);
  ws2.getRow(1).font = { bold: true };
  for (const o of lista) ws2.addRow(headers.map((h) => { const v = o[h]; return (v && typeof v === "object" && v.result !== undefined) ? v.result : (v ?? null); }));
  await wb2.xlsx.writeFile(p);
  return { nuevas, actualizadas, total: lista.length, archivo: p };
}

/**
 * Causas a vigilar (Vigilar != NO). Devuelve [{key,nidCausa,pidJuzgado,organismo,
 * jurisdiccion,fuero,caratula,estado,ultPasoFecha}].
 */
export async function leerVigiladas() {
  let ExcelJS; try { ExcelJS = (await import("exceljs")).default; } catch { return { causas: [], nota: "falta exceljs" }; }
  const p = carteraMevPath();
  const { filas, existe } = await leerCarteraObj(ExcelJS, p);
  if (!existe) return { causas: [], nota: "cartera-mev.xlsx todavia no existe (correr descubrir-mev.mjs)" };
  const out = [];
  for (const [k, o] of filas) {
    if (!esVigilada(txt(o["Vigilar"]))) continue;
    const nid = txt(o["NidCausa"]).trim();
    if (!nid) continue;
    out.push({
      key: k, nidCausa: nid, pidJuzgado: txt(o["PidJuzgado"]).trim(),
      organismo: txt(o["Organismo"]), jurisdiccion: txt(o["Jurisdiccion"]), fuero: txt(o["Fuero"]),
      caratula: txt(o["Caratula"]), estado: txt(o["Estado"]), ultPasoFecha: txt(o["Ult. Paso"]),
    });
  }
  return { causas: out, archivo: p };
}
