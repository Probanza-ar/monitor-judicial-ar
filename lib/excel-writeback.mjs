/**
 * excel-writeback.mjs - Alimenta la hoja MOVIMIENTOS del Excel de gestion con las
 * novedades detectadas por el bot. Generico: sirve para cualquier planilla de
 * causas de cualquier fuero, porque detecta hoja y columnas por NOMBRE de
 * encabezado y cruza por el numero de expediente del PJN.
 *
 * DISENO (segun definicion del estudio):
 *   - El bot es el que alimenta MOVIMIENTOS. Por cada actuacion nueva agrega UNA
 *     fila con: Nro. Causa (clave PJN), Fecha, Descripcion y link al Adjunto.
 *   - La columna "Proximo paso" NO se toca: es la tarea manual de control humano.
 *   - Deduplicacion por id de evento: si la corrida de la manana ya cargo una
 *     novedad, la de la tarde no la repite.
 *
 * SEGURIDAD:
 *   - Por defecto escribe sobre una COPIA (EXCEL_OUT). No toca el maestro salvo
 *     EXCEL_INPLACE=true explicito.
 *   - IMPORTANTE: exceljs, al reescribir, puede no preservar al 100% graficos,
 *     tablas dinamicas o algunos formatos condicionales del DASHBOARD. Por eso el
 *     modo copia es el default: revisar la copia antes de habilitar in-place.
 *
 * Requiere:  npm i exceljs
 *
 * .env:
 *   EXCEL_PATH       ruta del Excel de gestion (dispara el modulo)
 *   EXCEL_OUT        salida (default <EXCEL_PATH>.actualizado.xlsx)
 *   EXCEL_INPLACE    "true" para escribir sobre el maestro (default false)
 *   EXCEL_HOJA_MOV   forzar el nombre de la hoja de movimientos (opcional)
 */
import fs from "node:fs";

const norm = (s) => String(s ?? "")
  .toLowerCase()
  .normalize("NFD").replace(/\p{Diacritic}/gu, "")
  .replace(/\s+/g, " ").trim();

// Nucleo numero/anio del expediente: "CPE 819/2024" -> "819/2024". Sirve para
// deduplicar y comparar claves con o sin prefijo de fuero o sufijo de legajo.
function normExp(s) {
  const m = String(s ?? "").match(/(\d{1,7})\s*\/\s*(\d{2,4})/);
  if (m) return `${m[1]}/${m[2]}`;
  return String(s ?? "").toUpperCase().replace(/\s+/g, "").replace(/[^\dA-Z/]/g, "");
}

const fmtFechaHora = (d) => new Intl.DateTimeFormat("es-AR", {
  timeZone: "America/Argentina/Buenos_Aires",
  day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
}).format(d);

const fileUrl = (p) => "file:///" + String(p).replace(/\\/g, "/").replace(/ /g, "%20");
const tipoLabel = (t) => t === "cedula" ? "Cedula (N)" : (t === "despacho" ? "Despacho (D)" : (t || "actuacion"));

// Hoja de movimientos: forzada por EXCEL_HOJA_MOV, o la primera cuyo nombre sugiera
// movimientos/novedades/bitacora.
function elegirHojaMov(wb) {
  const forzada = process.env.EXCEL_HOJA_MOV;
  if (forzada) {
    const ws = wb.getWorksheet(forzada);
    if (ws) return ws;
    throw new Error(`EXCEL_HOJA_MOV="${forzada}" no existe. Hojas: ${wb.worksheets.map((w) => w.name).join(", ")}`);
  }
  const rx = /movimiento|novedad|bitacora/i;
  const cand = wb.worksheets.find((w) => rx.test(w.name));
  if (!cand) throw new Error(`no encontre una hoja de movimientos. Usar EXCEL_HOJA_MOV. Hojas: ${wb.worksheets.map((w) => w.name).join(", ")}`);
  return cand;
}

// Fila de encabezados: la de mas valores DISTINTOS (una banda de titulo repite el
// mismo texto en todas las columnas).
function hallarHeader(ws) {
  let mejor = { fila: 1, distintos: -1 };
  for (let r = 1; r <= Math.min(8, ws.rowCount || 8); r++) {
    const vals = new Set();
    ws.getRow(r).eachCell({ includeEmpty: false }, (c) => { const t = norm(c.text); if (t) vals.add(t); });
    if (vals.size > mejor.distintos) mejor = { fila: r, distintos: vals.size };
  }
  return mejor.fila;
}

function mapearColumnas(ws, filaHeader) {
  const headers = {};
  ws.getRow(filaHeader).eachCell({ includeEmpty: false }, (c, col) => { headers[col] = norm(c.text); });
  const buscar = (pred) => {
    for (const [col, h] of Object.entries(headers)) if (pred(h)) return Number(col);
    return null;
  };
  const colNro = buscar((h) => h.includes("causa") || h.includes("exped") || h.includes("nro"));
  const colFecha = buscar((h) => h === "fecha" || h.includes("fecha"));
  const colDesc = buscar((h) => h.includes("descrip") || h.includes("movimiento") || h.includes("detalle"));
  const colAdj = buscar((h) => h.includes("adjunt") || h.includes("link") || h.includes("pdf"));
  return { colNro, colFecha, colDesc, colAdj };
}

// Primera fila vacia (sin Nro. Causa) despues del encabezado, para no dejar huecos.
function primeraFilaVacia(ws, filaHeader, colNro) {
  let r = filaHeader + 1;
  const tope = (ws.rowCount || filaHeader) + 5000;
  while (r <= tope) {
    const t = String(ws.getRow(r).getCell(colNro).text || "").trim();
    if (!t) return r;
    r++;
  }
  return r;
}

export async function actualizarExcel({ nuevos, guardados, esPrioritario }) {
  let ExcelJS;
  try {
    ExcelJS = (await import("exceljs")).default;
  } catch {
    throw new Error("falta la libreria exceljs. Instalar con: npm i exceljs");
  }

  const entrada = process.env.EXCEL_PATH;
  if (!entrada || !fs.existsSync(entrada)) throw new Error(`EXCEL_PATH no encontrado: ${entrada}`);
  const inplace = (process.env.EXCEL_INPLACE || "false") === "true";
  const salida = inplace ? entrada : (process.env.EXCEL_OUT || entrada.replace(/\.xlsx$/i, "") + ".actualizado.xlsx");

  if (!nuevos || nuevos.length === 0) return { agregadas: 0, duplicadas: 0, salida: null };

  // Mapa id de evento -> ruta local del PDF.
  const pdfPorId = new Map();
  for (const g of guardados || []) if (g.id != null) pdfPorId.set(String(g.id), g.path);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(entrada);
  const ws = elegirHojaMov(wb);
  const filaHeader = hallarHeader(ws);
  const { colNro, colFecha, colDesc, colAdj } = mapearColumnas(ws, filaHeader);
  if (!colNro || !colFecha || !colDesc) {
    throw new Error(`no pude mapear columnas en "${ws.name}" (header fila ${filaHeader}). Nro=${colNro} Fecha=${colFecha} Desc=${colDesc}. Revisar con inspeccionar-excel.mjs.`);
  }

  // Deduplicacion: junto los ids de evento ya presentes (marcados como "evento NNN"
  // en la descripcion de filas anteriores).
  const yaCargados = new Set();
  for (let r = filaHeader + 1; r <= (ws.rowCount || filaHeader); r++) {
    const txt = String(ws.getRow(r).getCell(colDesc).text || "");
    const m = txt.match(/evento\s+(\d+)/i);
    if (m) yaCargados.add(m[1]);
  }

  let fila = primeraFilaVacia(ws, filaHeader, colNro);
  let agregadas = 0, duplicadas = 0;
  for (const it of nuevos) {
    const id = String(it.id);
    if (yaCargados.has(id)) { duplicadas++; continue; }
    const nroCausa = it.payload?.claveExpediente || "";
    const fecha = it.fechaAccion || it.fechaCreacion || Date.now();
    const prio = esPrioritario && esPrioritario(it) ? " [PRIORITARIA]" : "";
    const desc = `Novedad PJN - ${tipoLabel(it.tipo)}${prio} - evento ${id}`;

    const row = ws.getRow(fila);
    row.getCell(colNro).value = nroCausa;
    const cFecha = row.getCell(colFecha);
    cFecha.value = new Date(fecha);
    cFecha.numFmt = "dd/mm/yyyy hh:mm";
    row.getCell(colDesc).value = desc;
    if (colAdj) {
      const p = pdfPorId.get(id);
      if (p) {
        const c = row.getCell(colAdj);
        c.value = { text: "Ver PDF", hyperlink: fileUrl(p) };
        c.font = { color: { argb: "FF0563C1" }, underline: true };
      } else {
        row.getCell(colAdj).value = "PDF no disponible - revisar en el Portal";
      }
    }
    row.commit?.();
    yaCargados.add(id);
    agregadas++;
    fila++;
  }

  if (agregadas > 0) await wb.xlsx.writeFile(salida);
  return { agregadas, duplicadas, salida: agregadas > 0 ? salida : null, hoja: ws.name };
}
