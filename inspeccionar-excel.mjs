#!/usr/bin/env node
/**
 * inspeccionar-excel.mjs - Muestra la estructura del Excel de gestion para
 * confirmar el mapeo antes de activar el write-back.
 *
 * Uso:   node inspeccionar-excel.mjs "D:\\DERECHO\\PartesPJN\\GestionEstudioJuridico_v2.xlsx"
 *        (o define EXCEL_PATH en el .env)
 *
 * Requiere:  npm i exceljs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// .env minimo por si EXCEL_PATH esta ahi.
(function cargarEnv() {
  const p = path.resolve(__dirname, ".env");
  if (!fs.existsSync(p)) return;
  for (const l of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
})();

const ruta = process.argv[2] || process.env.EXCEL_PATH;
if (!ruta) { console.error("Falta la ruta del Excel (argumento o EXCEL_PATH)."); process.exit(1); }
if (!fs.existsSync(ruta)) { console.error("No existe:", ruta); process.exit(1); }

const ExcelJS = (await import("exceljs")).default;
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(ruta);

console.log("Archivo:", ruta);
console.log("Hojas:", wb.worksheets.map((w) => w.name).join(" | "));

for (const ws of wb.worksheets) {
  console.log(`\n===== HOJA: ${ws.name}  (filas ~${ws.rowCount}, cols ~${ws.columnCount}) =====`);
  for (let r = 1; r <= Math.min(3, ws.rowCount || 3); r++) {
    const vals = [];
    ws.getRow(r).eachCell({ includeEmpty: true }, (c, col) => {
      const t = (c.text || "").toString().trim();
      if (t) vals.push(`[col ${col}] ${t}`);
    });
    console.log(` fila ${r}:`, vals.join("  ||  ") || "(vacia)");
  }
}
console.log("\nListo. Pasame esta salida y termino de fijar el mapeo de columnas del write-back.");
