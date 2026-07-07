/**
 * causas-log.mjs - Lista de causas autogenerada desde el feed del PJN.
 *
 * Mantiene causas-pjn.csv con una fila por expediente que aparece en el feed:
 * numero, caratula, fuero, primera vez visto y ultimo movimiento. Asi no tipeas
 * cada expediente a mano: tu Excel levanta este CSV por Power Query y vos solo le
 * agregas la capa de gestion (cliente, honorarios, Fecha Impulso Real, etc.).
 *
 * NO toca el Excel maestro. Reescribe su propio CSV (dato plano, sin formato).
 *
 * Limite: el feed solo muestra expedientes CON novedad. La lista se va completando
 * a medida que las causas se mueven; no trae de una toda la cartera historica.
 *
 * Formato (delimitador ; , UTF-8 con BOM):
 *   nro_causa;caratula;fuero;primera_vez;ultimo_movimiento
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
function fueroDe(clave) {
  const m = (clave || "").trim().match(/^([A-Z]{2,4})\b/);
  const cod = m ? m[1] : "OTROS";
  return FUEROS[cod] || cod;
}

const fmtDia = (ms) => new Intl.DateTimeFormat("es-AR", {
  timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "numeric",
}).format(new Date(ms));
function parseFechaAr(s) {
  const m = String(s || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  const anio = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const d = new Date(anio, Number(m[2]) - 1, Number(m[1]));
  return isNaN(d) ? null : d;
}

function csvPath() { return process.env.CAUSAS_CSV || fileURLToPath(new URL("../causas-pjn.csv", import.meta.url)); }
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

const HEADER = "nro_causa;caratula;fuero;primera_vez;ultimo_movimiento";

export async function registrarCausas({ nuevos }) {
  if (!nuevos || !nuevos.length) return { nuevas: 0, actualizadas: 0, total: 0, archivo: null };
  const p = csvPath();

  // Cargar existentes.
  const map = new Map(); // clave -> { nro, caratula, fuero, primera, ultimo:Date }
  if (fs.existsSync(p)) {
    for (const linea of fs.readFileSync(p, "utf8").split(/\r?\n/).slice(1)) {
      if (!linea.trim()) continue;
      const c = parseCsvLine(linea);
      const nro = (c[0] || "").replace(/^﻿/, "").trim();
      if (!nro) continue;
      map.set(nro, { nro, caratula: c[1] || "", fuero: c[2] || "", primera: c[3] || "", ultimo: parseFechaAr(c[4]) });
    }
  }

  // Agrupar el lote por clave, con la fecha de evento mas antigua y mas reciente.
  const porClave = new Map();
  for (const it of nuevos) {
    const clave = String(it.payload?.claveExpediente || "").trim();
    if (!clave) continue;
    const f = new Date(it.fechaAccion || it.fechaCreacion || Date.now());
    const car = it.payload?.caratulaExpediente || "";
    if (!porClave.has(clave)) porClave.set(clave, { car, min: f, max: f });
    else { const g = porClave.get(clave); if (f < g.min) g.min = f; if (f > g.max) g.max = f; if (!g.car && car) g.car = car; }
  }

  let nuevas = 0, actualizadas = 0;
  for (const [clave, g] of porClave) {
    if (map.has(clave)) {
      const e = map.get(clave);
      if (!e.ultimo || g.max > e.ultimo) e.ultimo = g.max;
      const primPrev = parseFechaAr(e.primera);
      if (!primPrev || g.min < primPrev) e.primera = fmtDia(g.min.getTime()); // la mas antigua conocida
      if (!e.caratula && g.car) e.caratula = g.car;
      if (!e.fuero) e.fuero = fueroDe(clave);
      actualizadas++;
    } else {
      map.set(clave, { nro: clave, caratula: g.car, fuero: fueroDe(clave), primera: fmtDia(g.min.getTime()), ultimo: g.max });
      nuevas++;
    }
  }

  const filas = [...map.values()].sort((a, b) => (b.ultimo?.getTime() || 0) - (a.ultimo?.getTime() || 0));
  let out = "﻿" + HEADER + "\r\n";
  for (const e of filas) {
    out += [e.nro, e.caratula, e.fuero, e.primera, e.ultimo ? fmtDia(e.ultimo.getTime()) : ""].map(q).join(";") + "\r\n";
  }
  fs.writeFileSync(p, out);
  return { nuevas, actualizadas, total: filas.length, archivo: p };
}
