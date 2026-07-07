#!/usr/bin/env node
/**
 * descubrir-mev.mjs - Diagnostico + siembra manual de la cartera MEV (SCBA).
 *
 * Corre una vez (o cuando quieras revisar el estado): loguea, recorre las
 * jurisdicciones de MEV_JURISDICCIONES, lista sus sets y las causas de cada
 * uno, y siembra cartera-mev.xlsx. Sirve para confirmar credenciales/endpoints
 * antes de programar el parte, y para ver que trae cada set.
 *
 * Uso:  node descubrir-mev.mjs
 * Config: ver .env.mev.example (MEV_USUARIO, MEV_CLAVE, MEV_JURISDICCIONES).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { entrarJurisdiccion, causasDeSet, endpointsEnUso, PAUSA } from "./lib/mev-client.mjs";
import { hayCredenciales, configAuth } from "./lib/mev-auth.mjs";
import { upsertCausas } from "./lib/cartera-mev.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(function cargarEnv() {
  const envPath = path.resolve(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const linea of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
})();

function parseJurisdicciones(lista) {
  return lista.map((s) => {
    const partes = s.split(":").map((x) => x.trim()).filter(Boolean);
    return { clave: s, depto: partes[0], penal: partes.slice(1).map((x) => x.toLowerCase()).includes("penal"), familia: partes.slice(1).map((x) => x.toLowerCase()).includes("familia") };
  });
}

async function main() {
  console.log("Config auth:", configAuth());
  console.log("Endpoints:", endpointsEnUso());
  if (!hayCredenciales()) { console.error("\nFaltan MEV_USUARIO/MEV_CLAVE en .env. La MEV no tiene consulta anonima."); process.exit(1); }

  const jurs = parseJurisdicciones((process.env.MEV_JURISDICCIONES || "").split(";").map((s) => s.trim()).filter(Boolean));
  if (!jurs.length) { console.error("\nFalta MEV_JURISDICCIONES en .env (ej: Moron:penal;San Isidro)"); process.exit(1); }

  const pausa = Number(process.env.MEV_PAUSA_MS || PAUSA);
  let totalSembradas = 0;
  for (const jur of jurs) {
    console.log(`\n=== Jurisdiccion: ${jur.clave} ===`);
    try {
      const { organismos, sets } = await entrarJurisdiccion(jur);
      console.log(`  Organismos disponibles: ${organismos.length}`);
      console.log(`  Sets: ${sets.length ? sets.map((s) => `${s.nombre} (nidset ${s.nidset})`).join(" | ") : "(ninguno)"}`);
      const orgPorJuz = new Map(organismos.map((o) => [o.valor.trim(), o.nombre]));
      for (const set of sets) {
        await sleep(pausa);
        const r = await causasDeSet(jur, set.nidset);
        if (r.sinResultados) { console.log(`    Set "${set.nombre}": sin causas en esta jurisdiccion.`); continue; }
        console.log(`    Set "${set.nombre}": ${r.causas.length} causa(s)${r.total != null ? ` (total ${r.total})` : ""}`);
        for (const c of r.causas.slice(0, 10)) console.log(`      - ${c.expediente || c.nidCausa} | ${c.caratula} | ${c.estado} | ult: ${c.ultimoMovimiento.fecha} ${c.ultimoMovimiento.descripcion}`);
        const causas = r.causas.map((c) => ({ ...c, jurisdiccion: jur.clave, organismo: orgPorJuz.get(String(c.pidJuzgado).trim()) || "" }));
        const up = await upsertCausas({ causas });
        totalSembradas += up.nuevas || 0;
        console.log(`      -> cartera: ${up.nuevas || 0} nueva(s), ${up.total || 0} total.`);
      }
    } catch (e) {
      console.error(`  ERROR en ${jur.clave}: ${e.message}`);
      if (e.claveVencida) console.error("  >>> La clave MEV esta vencida: renovarla a mano en mev.scba.gov.ar (cambio forzado cada 90 dias).");
    }
  }
  console.log(`\nListo. ${totalSembradas} causa(s) nueva(s) sembrada(s). Depura homonimos con la columna "Vigilar" (=NO) en cartera-mev.xlsx.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
