#!/usr/bin/env node
/**
 * descubrir-eje.mjs - Confirma los endpoints de la API de JusCABA y siembra la cartera.
 *
 * Que hace:
 *   1) Autodescubre (o confirma) el endpoint de busqueda y el de actuaciones, y los
 *      cachea en .eje-endpoints.json. Imprime cual quedo.
 *   2) Prueba una busqueda real y lista actuaciones de una causa, para ver que la API
 *      responde y que los campos mapean bien.
 *   3) Si se le pasan criterios (argumentos o EJE_CRITERIOS del .env), siembra
 *      cartera-eje.xlsx con lo que encuentre (modo hibrido; despues depuras con "Vigilar").
 *
 * Uso:
 *   node descubrir-eje.mjs                 -> usa EJE_CRITERIOS del .env (o "GCBA" de prueba)
 *   node descubrir-eje.mjs "Perez Juan"    -> descubre + siembra con ese criterio
 *   node descubrir-eje.mjs --solo-endpoints -> solo confirma endpoints, no siembra
 *
 * Correlo una vez desde tu PowerShell y pega la salida: con eso fijamos los endpoints.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { endpointsEnUso, buscarCausas, misCausas, listarActuaciones, obtenerEncabezado } from "./lib/eje-client.mjs";
import { hayCredenciales } from "./lib/eje-auth.mjs";
import { upsertCausas } from "./lib/cartera-eje.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
(function cargarEnv() {
  const p = path.resolve(__dirname, ".env");
  if (!fs.existsSync(p)) return;
  for (const l of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue;
    let v = m[2]; if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
})();

const args = process.argv.slice(2);
const soloEndpoints = args.includes("--solo-endpoints");
const criteriosArg = args.filter((a) => !a.startsWith("--"));
const criterios = criteriosArg.length ? criteriosArg
  : (process.env.EJE_CRITERIOS || "").split(/[;|]/).map((s) => s.trim()).filter(Boolean);

const linea = (s = "") => console.log(s);

async function main() {
  linea("== Descubrimiento de endpoints JusCABA (EJE) ==\n");
  const criterioPrueba = criterios[0] || "GCBA";

  const ep = endpointsEnUso();
  linea("Endpoints en uso:");
  linea(`  modo   : ${ep.modo}`);
  linea(`  base   : ${ep.base}`);
  linea(`  lista  : ${ep.lista}`);
  linea(`  misCausas: ${ep.misCausas}`);
  linea(`  encab  : ${ep.encab}`);
  linea(`  ultima : ${ep.ultima}`);
  linea(`  acts   : ${ep.acts}`);
  linea("");

  // ─── MODO AUTENTICADO: sembrar desde Mis Causas (cartera exacta, sin homonimos) ──
  if (hayCredenciales()) {
    try {
      const r = await misCausas({ size: 50 });
      linea(`Mis Causas (autenticado): ${r.causas.length} causa(s):`);
      for (const c of r.causas) linea(`  - exp ${c.expId} | ${c.cuij} | ${c.caratula} | ${c.estado} | ult: ${c.ultimaActuacion.fecha} ${c.ultimaActuacion.descripcion}`);
      // Prueba de actuaciones sobre la primera (con token, las reservadas tambien traen).
      if (r.causas[0]) {
        try {
          const a = await listarActuaciones(r.causas[0].expId, { size: 3 });
          linea(`\nActuaciones de exp ${r.causas[0].expId}: ${a.total} total, muestra:`);
          for (const x of a.actuaciones.slice(0, 3)) linea(`  - ${x.fechaFirma} [${x.codigo}] ${x.titulo}${x.esCedula ? " (cedula)" : ""}`);
        } catch (e) { linea(`\nAviso: actuaciones exp ${r.causas[0].expId} fallo: ${e.message}`); }
      }
      const up = await upsertCausas({ causas: r.causas });
      linea(`\nSembrado: cartera ${up.nuevas} nueva(s), ${up.total} total. Archivo: ${up.archivo}`);
      linea("\nListo. Son tus causas exactas (Mis Causas del portal); no hay homonimos que depurar.");
    } catch (e) { linea(`Mis Causas fallo: ${e.message}`); process.exit(1); }
    return;
  }

  // ─── MODO PUBLICO: busqueda por nombre + depuracion de homonimos ─────────────────
  linea("(sin credenciales EJE_USUARIO/EJE_CLAVE -> modo publico, busqueda por nombre)\n");
  try {
    const r = await buscarCausas(criterioPrueba, { size: 3 });
    linea(`Busqueda de prueba "${criterioPrueba}": ${r.total} resultado(s), muestra:`);
    for (const c of r.causas.slice(0, 3)) linea(`  - exp ${c.expId} | ${c.cuij} | ${c.caratula} | ${c.estado} | ult: ${c.ultimaActuacion.fecha} ${c.ultimaActuacion.descripcion}`);
    const candidata = r.causas.find((c) => !c.esPrivado) || r.causas[0];
    if (candidata) {
      try {
        const a = await listarActuaciones(candidata.expId, { size: 3 });
        linea(`\nActuaciones de exp ${candidata.expId}: ${a.total} total, muestra:`);
        for (const x of a.actuaciones.slice(0, 3)) linea(`  - ${x.fechaFirma} [${x.codigo}] ${x.titulo}${x.esCedula ? " (cedula)" : ""}`);
      } catch (e) {
        if (e.privado) linea(`\nAviso: exp ${candidata.expId} es reservado (code 1004); sin login no se ven sus actuaciones. Cargá EJE_USUARIO/EJE_CLAVE para el modo autenticado.`);
        else linea(`\nAviso: actuaciones fallo (${e.message}).`);
      }
    }
    linea("");
  } catch (e) {
    linea(`La prueba de busqueda fallo: ${e.message}`);
    process.exit(1);
  }

  if (soloEndpoints || !criterios.length) {
    linea(soloEndpoints ? "Modo --solo-endpoints: no se siembra la cartera." : "Sin criterios: no se siembra. Pasar un nombre o setear EJE_CRITERIOS en .env.");
    return;
  }

  for (const criterio of criterios) {
    try {
      // Paginacion exhaustiva: recorrer hasta vaciar el indice (no dejar causas afuera).
      let page = 0, total = Infinity, acc = [];
      while (acc.length < total && page < 500) {
        const r = await buscarCausas(criterio, { page, size: 30 });
        total = Number(r.total ?? acc.length);
        acc.push(...r.causas);
        if (r.causas.length < 30) break; page++;
      }
      const up = await upsertCausas({ causas: acc });
      linea(`Sembrado "${criterio}": ${acc.length} encontrada(s); cartera ${up.nuevas} nueva(s), ${up.total} total. Archivo: ${up.archivo}`);
    } catch (e) { linea(`Sembrado "${criterio}" fallo: ${e.message}`); }
  }
  linea("\nListo. Abri cartera-eje.xlsx y poné \"NO\" en la columna Vigilar a las causas ajenas (homonimos).");
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
