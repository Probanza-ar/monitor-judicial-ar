/**
 * movimientos-log.mjs - Registro de novedades del PJN en un CSV aparte.
 *
 * Plan B (seguro): en vez de reescribir el Excel maestro con exceljs -que dana el
 * formato condicional y podria romper graficos-, el bot APENDA cada novedad a
 * movimientos-pjn.csv. El Excel maestro no se toca nunca. Despues se levanta el CSV
 * desde el maestro con Power Query (Datos > Obtener datos > Desde archivo > CSV), que
 * se refresca solo, o se copia a mano a la hoja MOVIMIENTOS.
 *
 * Formato CSV (delimitador ; para Excel es-AR, UTF-8 con BOM):
 *   evento_id;fecha;nro_causa;tipo;prioritaria;descripcion;pdf_local
 *
 * Deduplicacion por evento_id: la corrida de la manana y la de la tarde no duplican.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const DIA_MS = 24 * 60 * 60 * 1000;
const tipoLabel = (t) => t === "cedula" ? "Cedula (N)" : (t === "despacho" ? "Despacho (D)" : (t || "actuacion"));
const fmt = (ms) => new Intl.DateTimeFormat("es-AR", {
  timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
}).format(new Date(ms));

function csvPath() {
  return process.env.MOV_CSV || fileURLToPath(new URL("../movimientos-pjn.csv", import.meta.url));
}
function q(s) { s = String(s ?? ""); return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

function normExp(s) {
  const m = String(s ?? "").match(/(\d{1,7})\s*\/\s*(\d{2,4})/);
  return m ? `${m[1]}/${m[2]}` : String(s ?? "").toUpperCase().replace(/\s+/g, "").replace(/[^\dA-Z/]/g, "");
}
function parseFechaAr(s) {
  const m = String(s || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[ ,]+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const anio = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const d = new Date(anio, Number(m[2]) - 1, Number(m[1]), Number(m[4] || 0), Number(m[5] || 0));
  return isNaN(d) ? null : d;
}

const HEADER = "evento_id;fecha;nro_causa;tipo;prioritaria;descripcion;pdf_local";

export async function registrarMovimientos({ nuevos, guardados, esPrioritario }) {
  if (!nuevos || !nuevos.length) return { agregadas: 0, duplicadas: 0, archivo: null };
  const p = csvPath();
  const pdfPorId = new Map();
  for (const g of guardados || []) if (g.id != null) pdfPorId.set(String(g.id), g.path);

  const yaCargados = new Set();
  const existe = fs.existsSync(p);
  if (existe) {
    for (const linea of fs.readFileSync(p, "utf8").split(/\r?\n/).slice(1)) {
      if (!linea.trim()) continue;
      const id = linea.split(";")[0].replace(/^﻿/, "").replace(/^"|"$/g, "");
      if (id) yaCargados.add(id);
    }
  }

  const filas = [];
  let duplicadas = 0;
  for (const it of nuevos) {
    const id = String(it.id);
    if (yaCargados.has(id)) { duplicadas++; continue; }
    const nro = it.payload?.claveExpediente || "";
    const fecha = fmt(it.fechaAccion || it.fechaCreacion || Date.now());
    const prio = esPrioritario && esPrioritario(it) ? "SI" : "NO";
    const pdf = pdfPorId.get(id) || (it.hasDocument ? "en el Portal (no se pudo bajar)" : "");
    const desc = `Novedad PJN - ${tipoLabel(it.tipo)}`;
    filas.push([id, fecha, nro, tipoLabel(it.tipo), prio, desc, pdf].map(q).join(";"));
    yaCargados.add(id);
  }
  if (!filas.length) return { agregadas: 0, duplicadas, archivo: p };

  let salida = "";
  if (!existe) salida += "﻿" + HEADER + "\r\n";
  salida += filas.join("\r\n") + "\r\n";
  fs.appendFileSync(p, salida);
  return { agregadas: filas.length, duplicadas, archivo: p };
}

// Fecha del ultimo movimiento por causa (para caducidad/penal). Lee el CSV del bot.
export function leerUltimosMovimientos() {
  const map = new Map();
  const p = csvPath();
  if (!fs.existsSync(p)) return map;
  try {
    for (const linea of fs.readFileSync(p, "utf8").split(/\r?\n/).slice(1)) {
      if (!linea.trim()) continue;
      const cols = linea.split(";");
      const fecha = parseFechaAr((cols[1] || "").replace(/^"|"$/g, ""));
      const k = normExp((cols[2] || "").replace(/^"|"$/g, ""));
      if (fecha && k && (!map.has(k) || fecha > map.get(k))) map.set(k, fecha);
    }
  } catch { /* ignore */ }
  return map;
}
