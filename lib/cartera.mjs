/**
 * cartera.mjs - Registro de causas AUTOCOMPLETADO por el bot (cartera-pjn.xlsx).
 *
 * El bot crea y mantiene este archivo PLANO (sin formato condicional ni graficos,
 * asi exceljs lo puede reescribir sin romper nada). En cada corrida:
 *   - Agrega las causas nuevas que aparecen en el feed.
 *   - Actualiza caratula, fuero y "Ult. Movimiento" de las que ya estan.
 *   - CONSERVA intactas las columnas de gestion que vos completes (Cliente, Abogado,
 *     Fecha Impulso Real, Plazo Meses, Estado, etc.): las lee y las vuelve a escribir.
 *
 * Este es tu registro de causas vivo. Tu GestionEstudioJuridico.xlsx (con dashboards
 * y colores) queda aparte; el bot no lo toca. Caducidad y penal leen este archivo.
 *
 * Requiere: npm i exceljs.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const FUEROS = {
  CIV: "Nac. Civil", COM: "Nac. Comercial", CNT: "Nac. del Trabajo",
  CSS: "Fed. Seguridad Social", CCC: "Nac. Criminal y Correccional",
  CFP: "Fed. Criminal y Correccional", CPE: "Nac. Penal Economico",
  CPF: "Fed. Casacion Penal", CPN: "Nac. Casacion Penal", CAF: "Fed. Cont. Adm.",
  CNE: "Nac. Electoral", CCF: "Fed. Civil y Comercial",
};
function fueroDe(clave) { const m = (clave || "").trim().match(/^([A-Z]{2,4})\b/); const cod = m ? m[1] : "OTROS"; return FUEROS[cod] || cod; }
const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\s+/g, " ").trim();
function normExp(s) { const m = String(s ?? "").match(/(\d{1,7})\s*\/\s*(\d{2,4})/); return m ? `${m[1]}/${m[2]}` : String(s ?? "").toUpperCase().replace(/\s+/g, "").replace(/[^\dA-Z/]/g, ""); }
const fmtDia = (ms) => new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(ms));
function parseFechaAr(s) { const m = String(s || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); if (!m) return null; const a = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]); const d = new Date(a, Number(m[2]) - 1, Number(m[1])); return isNaN(d) ? null : d; }
function txt(cell) { const v = cell && cell.value; if (v == null) return ""; if (typeof v === "object") { if (v.result !== undefined) return String(v.result); if (v.text !== undefined) return String(v.text); } return String(v); }

export function carteraPath() { return process.env.CARTERA_XLSX || fileURLToPath(new URL("../cartera-pjn.xlsx", import.meta.url)); }

const BOT_HEADERS = ["Nro. Causa", "Caratula", "Fuero", "Primera vez", "Ult. Movimiento"];
const GESTION_HEADERS = ["Estado", "Fecha Impulso Real", "Plazo Meses", "Susp Desde", "Susp Hasta", "Prescripcion Anios", "Pena Max Anios", "Fecha Hecho", "Ultimo Acto Interruptivo", "Observaciones"];

const idx = (headers, rx) => headers.findIndex((h) => rx.test(norm(h)));
const idxNro = (headers) => headers.findIndex((h) => /nro|causa|exped/.test(norm(h)));

function agruparFeed(nuevos) {
  const feed = new Map();
  for (const it of nuevos || []) {
    const clave = String(it.payload?.claveExpediente || "").trim(); if (!clave) continue;
    const f = new Date(it.fechaAccion || it.fechaCreacion || Date.now());
    const car = it.payload?.caratulaExpediente || "";
    if (!feed.has(clave)) feed.set(clave, { clave, caratula: car, fuero: fueroDe(clave), min: f, max: f });
    else { const g = feed.get(clave); if (f < g.min) g.min = f; if (f > g.max) g.max = f; if (!g.caratula && car) g.caratula = car; }
  }
  return feed;
}

export async function actualizarCartera({ nuevos }) {
  let ExcelJS; try { ExcelJS = (await import("exceljs")).default; } catch { return { nota: "falta exceljs" }; }
  const p = carteraPath();
  const feed = agruparFeed(nuevos);
  const hNro = "Nro. Causa", hCar = "Caratula", hFue = "Fuero", hPri = "Primera vez", hUlt = "Ult. Movimiento", hEst = "Estado";
  const str = (v) => v == null ? "" : (typeof v === "object" ? (v.result ?? v.text ?? "") : v).toString().trim();
  // Clave = expediente COMPLETO (incluye sub-legajo /TO1/3, /CA1). NO usar normExp aca:
  // colapsaria los legajos del mismo expediente base y perderia filas.
  const keyClave = (s) => str(s).toUpperCase().replace(/\s+/g, " ");

  // Leer existentes como objetos por encabezado (preserva columnas de gestion).
  let headersPrev = [];
  const filas = new Map(); // normExp(nro) -> { [header]: value }
  if (fs.existsSync(p)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(p);
    const ws = wb.worksheets[0];
    if (ws) {
      ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { headersPrev[i - 1] = String(c.text || "").trim(); });
      const iN = headersPrev.findIndex((h) => /nro|causa|exped/.test(norm(h)));
      for (let r = 2; r <= ws.rowCount; r++) {
        const o = {};
        headersPrev.forEach((h, i) => { if (h) o[h] = ws.getRow(r).getCell(i + 1).value; });
        const nro = str(ws.getRow(r).getCell((iN < 0 ? 0 : iN) + 1).value);
        if (nro) filas.set(keyClave(nro), o);
      }
    }
  }

  // Encabezado de salida: Orden + columnas del bot + columnas de gestion que hubiera.
  const base = headersPrev.filter(Boolean).length ? headersPrev : [...BOT_HEADERS, ...GESTION_HEADERS];
  const extras = base.filter((h) => norm(h) !== "orden" && !BOT_HEADERS.some((b) => norm(b) === norm(h)));
  const headers = ["Orden", ...BOT_HEADERS, ...extras];

  // Merge del feed.
  let nuevas = 0, actualizadas = 0;
  for (const [clave, g] of feed) {
    const k = keyClave(clave);
    if (filas.has(k)) {
      const o = filas.get(k);
      const pu = parseFechaAr(str(o[hUlt])); if (!pu || g.max > pu) o[hUlt] = fmtDia(g.max.getTime());
      const pp = parseFechaAr(str(o[hPri])); if (!pp || g.min < pp) o[hPri] = fmtDia(g.min.getTime());
      if (!str(o[hCar])) o[hCar] = g.caratula;
      if (!str(o[hFue])) o[hFue] = g.fuero;
      actualizadas++;
    } else {
      filas.set(k, { [hNro]: g.clave, [hCar]: g.caratula, [hFue]: g.fuero, [hPri]: fmtDia(g.min.getTime()), [hUlt]: fmtDia(g.max.getTime()), [hEst]: "Activa" });
      nuevas++;
    }
  }

  // Ordenar por fuero, luego por numero de expediente.
  const lista = [...filas.values()].sort((a, b) => {
    const fa = str(a[hFue]), fb = str(b[hFue]);
    if (fa !== fb) return fa.localeCompare(fb);
    return str(a[hNro]).localeCompare(str(b[hNro]), undefined, { numeric: true });
  });

  // Reescribir con Orden 1..n.
  const wb2 = new ExcelJS.Workbook();
  const ws2 = wb2.addWorksheet("CAUSAS");
  ws2.addRow(headers);
  ws2.getRow(1).font = { bold: true };
  lista.forEach((o, idx2) => {
    ws2.addRow(headers.map((h) => {
      if (h === "Orden") return idx2 + 1;
      const v = o[h];
      return (v && typeof v === "object" && v.result !== undefined) ? v.result : (v ?? null);
    }));
  });
  await wb2.xlsx.writeFile(p);
  return { nuevas, actualizadas, total: lista.length, archivo: p };
}
