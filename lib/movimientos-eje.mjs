/**
 * movimientos-eje.mjs - Registro de actuaciones de JusCABA en movimientos-eje.csv.
 *
 * Dos funciones:
 *   estadoPrevio()          -> Map(expId -> {actId, fecha:Date}) con la actuacion mas
 *                              reciente ya registrada por expediente. Es el "corte"
 *                              para el diff: solo se reporta lo posterior.
 *   registrarActuaciones()  -> apenda las actuaciones nuevas (dedup por act_id).
 *
 * Formato CSV (delimitador ; , UTF-8 con BOM):
 *   act_id;fecha;cuij;exp_id;codigo;titulo;prioritaria;firmantes
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export function csvEjePath() { return process.env.MOV_EJE_CSV || fileURLToPath(new URL("../movimientos-eje.csv", import.meta.url)); }
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
  const m = String(s || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[ ,]+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const a = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const d = new Date(a, Number(m[2]) - 1, Number(m[1]), Number(m[4] || 0), Number(m[5] || 0));
  return isNaN(d) ? null : d;
}

const HEADER = "act_id;fecha;cuij;exp_id;codigo;titulo;prioritaria;firmantes";

// Lee el CSV y arma el estado previo (ultima actuacion por expId) + set de act_id ya vistos.
function leerCsv() {
  const p = csvEjePath();
  const vistos = new Set();
  const ultimoPorExp = new Map(); // expId(string) -> { actId, fecha:Date }
  if (!fs.existsSync(p)) return { vistos, ultimoPorExp };
  const lineas = fs.readFileSync(p, "utf8").split(/\r?\n/).slice(1);
  for (const linea of lineas) {
    if (!linea.trim()) continue;
    const c = parseCsvLine(linea);
    const actId = (c[0] || "").replace(/^﻿/, "").trim();
    if (!actId) continue;
    vistos.add(actId);
    const exp = (c[3] || "").trim();
    const fecha = parseDia(c[1]);
    if (exp) {
      const prev = ultimoPorExp.get(exp);
      if (!prev || (fecha && (!prev.fecha || fecha > prev.fecha))) ultimoPorExp.set(exp, { actId, fecha: fecha || prev?.fecha || null });
    }
  }
  return { vistos, ultimoPorExp };
}

export function estadoPrevio() { return leerCsv().ultimoPorExp; }

/**
 * Apenda actuaciones nuevas. items: [{actId,fecha,cuij,expId,codigo,titulo,prioritaria,firmantes}].
 * Dedup por actId contra lo ya registrado.
 */
export async function registrarActuaciones(items) {
  if (!items || !items.length) return { agregadas: 0, duplicadas: 0, archivo: null };
  const p = csvEjePath();
  const { vistos } = leerCsv();
  const existe = fs.existsSync(p);

  const filas = [];
  let duplicadas = 0;
  for (const it of items) {
    const id = String(it.actId);
    if (!id || vistos.has(id)) { duplicadas++; continue; }
    filas.push([id, it.fecha || "", it.cuij || "", it.expId ?? "", it.codigo || "", it.titulo || "", it.prioritaria ? "SI" : "NO", it.firmantes || ""].map(q).join(";"));
    vistos.add(id);
  }
  if (!filas.length) return { agregadas: 0, duplicadas, archivo: p };

  let salida = "";
  if (!existe) salida += "﻿" + HEADER + "\r\n";
  salida += filas.join("\r\n") + "\r\n";
  fs.appendFileSync(p, salida);
  return { agregadas: filas.length, duplicadas, archivo: p };
}
