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
import { entrarJurisdiccion, causasDeSet, listarDeptos, endpointsEnUso, PAUSA } from "./lib/mev-client.mjs";
import { hayCredenciales, configAuth, login } from "./lib/mev-auth.mjs";
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

// Modo AUTO: barre los 23 departamentos x fuero (civil / familia / penal). Usa el
// valor numerico de DtoJudElegido (evita resolver por nombre) y arma una clave legible.
async function jurisdiccionesAuto() {
  await login();
  const deptos = await listarDeptos();
  if (!deptos.length) throw new Error("no se pudieron listar los departamentos (POSloguin vino vacio)");
  // La clave se guarda como jurisdiccion en la cartera y debe ser RE-PARSEABLE por
  // el parte (formato "Depto:penal" / "Depto:familia" / "Depto"), no una etiqueta libre.
  const jurs = [];
  for (const d of deptos) {
    jurs.push({ clave: d.nombre, depto: d.valor });
    jurs.push({ clave: `${d.nombre}:familia`, depto: d.valor, familia: true });
    jurs.push({ clave: `${d.nombre}:penal`, depto: d.valor, penal: true });
  }
  return jurs;
}

async function main() {
  console.log("Config auth:", configAuth());
  console.log("Endpoints:", endpointsEnUso());
  if (!hayCredenciales()) { console.error("\nFaltan MEV_USUARIO/MEV_CLAVE en .env. La MEV no tiene consulta anonima."); process.exit(1); }

  const rawJur = (process.env.MEV_JURISDICCIONES || "").trim();
  const auto = rawJur === "" || rawJur.toLowerCase() === "auto";
  let jurs;
  if (auto) {
    console.log("\nMODO AUTO: barriendo todos los departamentos x fuero (esto tarda un poco)...");
    jurs = await jurisdiccionesAuto();
    console.log(`  ${jurs.length} jurisdicciones a recorrer.`);
  } else {
    jurs = parseJurisdicciones(rawJur.split(";").map((s) => s.trim()).filter(Boolean));
  }

  const pausa = Number(process.env.MEV_PAUSA_MS || PAUSA);
  let totalSembradas = 0, totalCausas = 0, jurConCausas = 0, i = 0;
  const conCausas = [];
  for (const jur of jurs) {
    i++;
    if (!auto) console.log(`\n=== Jurisdiccion: ${jur.clave} ===`);
    else process.stdout.write(`\r  [${i}/${jurs.length}] ${jur.clave.padEnd(34).slice(0, 34)}`);
    try {
      await sleep(pausa);
      const { organismos, sets } = await entrarJurisdiccion(jur);
      if (!auto) {
        console.log(`  Organismos disponibles: ${organismos.length}`);
        console.log(`  Sets: ${sets.length ? sets.map((s) => `${s.nombre} (nidset ${s.nidset})`).join(" | ") : "(ninguno)"}`);
      }
      const orgPorJuz = new Map(organismos.map((o) => [o.valor.trim(), o.nombre]));
      let causasJur = 0;
      for (const set of sets) {
        await sleep(pausa);
        const r = await causasDeSet(jur, set.nidset);
        if (r.sinResultados) { if (!auto) console.log(`    Set "${set.nombre}": sin causas en esta jurisdiccion.`); continue; }
        causasJur += r.causas.length;
        if (!auto) {
          console.log(`    Set "${set.nombre}": ${r.causas.length} causa(s)${r.total != null ? ` (total ${r.total})` : ""}`);
          for (const c of r.causas.slice(0, 10)) console.log(`      - ${c.expediente || c.nidCausa} | ${c.caratula} | ${c.estado} | ult: ${c.ultimoMovimiento.fecha} ${c.ultimoMovimiento.descripcion}`);
        }
        const causas = r.causas.map((c) => ({ ...c, jurisdiccion: jur.clave, organismo: orgPorJuz.get(String(c.pidJuzgado).trim()) || "" }));
        const up = await upsertCausas({ causas });
        totalSembradas += up.nuevas || 0;
        if (!auto) console.log(`      -> cartera: ${up.nuevas || 0} nueva(s), ${up.total || 0} total.`);
      }
      if (causasJur > 0) {
        totalCausas += causasJur; jurConCausas++; conCausas.push({ clave: jur.clave, causasJur });
        if (auto) process.stdout.write(`\r  [${i}/${jurs.length}] ${jur.clave}: ${causasJur} causa(s)\n`);
      }
    } catch (e) {
      if (auto) process.stdout.write(`\r  [${i}/${jurs.length}] ${jur.clave}: ERROR ${e.message}\n`);
      else console.error(`  ERROR en ${jur.clave}: ${e.message}`);
      if (e.claveVencida) { console.error("\n  >>> La clave MEV esta vencida: renovarla a mano en mev.scba.gov.ar (cambio forzado cada 90 dias)."); break; }
    }
  }
  if (auto) {
    process.stdout.write("\r".padEnd(60) + "\r");
    console.log(`\nJurisdicciones con causas (${jurConCausas}):`);
    for (const j of conCausas.sort((a, b) => b.causasJur - a.causasJur)) console.log(`  - ${j.clave}: ${j.causasJur}`);
    console.log(`\nSugerencia: para el parte diario, poné en MEV_JURISDICCIONES solo esas jurisdicciones`);
    console.log(`(formato Depto[:penal][:familia], separadas por ";"), así el bot no barre las 69 cada dia.`);
  }
  console.log(`\nListo. ${totalCausas} causa(s) vistas, ${totalSembradas} nueva(s) sembrada(s) en cartera-mev.xlsx. Depura con "Vigilar"=NO.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
