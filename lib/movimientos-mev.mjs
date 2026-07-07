/**
 * movimientos-mev.mjs - Registro de pasos procesales de la MEV en movimientos-mev.csv.
 *
 * Mismo contrato que movimientos-eje.mjs:
 *   estadoPrevio()        -> Map(key -> {pasoId, fecha:Date}) con el paso mas reciente
 *                            ya registrado por causa (key = "nidCausa|pidJuzgado").
 *   registrarPasos()      -> apenda pasos nuevos (dedup por paso_id).
 *
 * paso_id = "nidCausa:nPosi" (el nPosi es el id interno del paso en la MEV; se
 * prefija con la causa por las dudas de que no sea globalmente unico).
 *
 * CSV (delimitador ; , UTF-8 con BOM):
 *   paso_id;fecha;nid_causa;pid_juzgado;descripcion;prioritaria;firmado
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export function csvMevPath() { return process.env.MOV_MEV_CSV || fileURLToPath(new URL("../movimientos-mev.csv", import.meta.url)); }
function q(s) { s = String(s ?? ""); return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function parseCsvLine(line) {
  const out = []; let cur = "", inq = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inq) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inq = false; } else cur += ch; }
    else { if (ch === '"') inq = true; else if (ch === ";") { out.push(cur); cur = ""; } else cur += ch; }
  }
  out.push(cur);
  return out;
}
function parseDia(s) {
  const m = String(s || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const a = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const d = new Date(a, Number(m[2]) - 1, Number(m[1]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
  return isNaN(d) ? null : d;
}

const HEADER = "paso_id;fecha;nid_causa;pid_juzgado;descripcion;prioritaria;firmado";

function leerCsv() {
  const p = csvMevPath();
  const vistos = new Set();
  const ultimoPorCausa = new Map(); // "nid|juz" -> { pasoId, nPosi, fecha:Date }
  if (!fs.existsSync(p)) return { vistos, ultimoPorCausa };
  const lineas = fs.readFileSync(p, "utf8").split(/\r?\n/).slice(1);
  for (const linea of lineas) {
    if (!linea.trim()) continue;
    const c = parseCsvLine(linea);
    const pasoId = (c[0] || "").replace(/^﻿/, "").trim();
    if (!pasoId) continue;
    vistos.add(pasoId);
    const key = `${(c[2] || "").trim()}|${(c[3] || "").trim()}`;
    const fecha = parseDia(c[1]);
    if (key !== "|") {
      const prev = ultimoPorCausa.get(key);
      if (!prev || (fecha && (!prev.fecha || fecha > prev.fecha))) {
        ultimoPorCausa.set(key, { pasoId, nPosi: pasoId.split(":").pop(), fecha: fecha || prev?.fecha || null });
      }
    }
  }
  return { vistos, ultimoPorCausa };
}

export function estadoPrevio() { return leerCsv().ultimoPorCausa; }

/**
 * Apenda pasos nuevos. items: [{nPosi,fecha,nidCausa,pidJuzgado,descripcion,prioritaria,firmado}].
 */
export async function registrarPasos(items) {
  if (!items || !items.length) return { agregadas: 0, duplicadas: 0, archivo: null };
  const p = csvMevPath();
  const { vistos } = leerCsv();
  const existe = fs.existsSync(p);

  const filas = [];
  let duplicadas = 0;
  for (const it of items) {
    const id = `${it.nidCausa}:${it.nPosi}`;
    if (!it.nPosi || vistos.has(id)) { duplicadas++; continue; }
    filas.push([id, it.fecha || "", it.nidCausa || "", it.pidJuzgado || "", it.descripcion || "", it.prioritaria ? "SI" : "NO", it.firmado ? "SI" : "NO"].map(q).join(";"));
    vistos.add(id);
  }
  if (!filas.length) return { agregadas: 0, duplicadas, archivo: p };

  let salida = "";
  if (!existe) salida += "﻿" + HEADER + "\r\n";
  salida += filas.join("\r\n") + "\r\n";
  fs.appendFileSync(p, salida);
  return { agregadas: filas.length, duplicadas, archivo: p };
}
