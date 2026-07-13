#!/usr/bin/env node
/**
 * agendar.mjs - Asistente para PROGRAMAR los partes diarios (PJN / EJE / MEV) en el
 * sistema operativo. No pide credenciales (eso lo hace configurar.mjs / el .env): solo
 * crea las tareas que disparan cada parte a la hora que elijas.
 *
 * El bot lee las causas y calcula los plazos, y los vuelca al Excel. Pero el Excel no
 * dispara nada: quien corre el parte cada dia es el Programador de tareas de Windows
 * (schtasks) o cron en Mac/Linux. Este script deja esas tareas armadas a tu gusto.
 *
 * Doble clic: agendar.bat. Por consola: node agendar.mjs
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WIN = process.platform === "win32";

// Frentes disponibles: script del parte, base del runner, nombre de tarea, log.
const FRENTES = {
  pjn: { script: "parte-diario-pjn.mjs", runnerBase: "run-parte-pjn", tarea: "ParteDiarioPJN", log: "parte-pjn.log", nombre: "PJN (Nacion)" },
  eje: { script: "parte-diario-eje.mjs", runnerBase: "run-parte-eje", tarea: "ParteDiarioEJE", log: "parte-eje.log", nombre: "EJE (CABA / JusCABA)" },
  mev: { script: "parte-diario-mev.mjs", runnerBase: "run-parte-mev", tarea: "ParteDiarioMEV", log: "parte-mev.log", nombre: "MEV (Provincia de Buenos Aires / SCBA)" },
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q, def = "") => new Promise((res) =>
  rl.question(def ? `${q} [${def}]: ` : `${q}: `, (a) => res((a || "").trim() || def)));

const esHora = (s) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(s);
const normHora = (s) => { const [h, m] = s.split(":"); return `${h.padStart(2, "0")}:${m}`; };
const hhmm = (s) => s.replace(":", "");

// Genera el runner (.bat / .sh) del frente si no existe.
function asegurarRunner(f) {
  const runnerPath = path.join(__dirname, f.runnerBase + (WIN ? ".bat" : ".sh"));
  if (fs.existsSync(runnerPath)) return runnerPath;
  if (WIN) {
    fs.writeFileSync(runnerPath, ["@echo off", `cd /d "%~dp0"`, `node "${f.script}" >> "${f.log}" 2>&1`, ""].join("\r\n"), "utf8");
  } else {
    fs.writeFileSync(runnerPath, ["#!/bin/sh", `cd "$(dirname "$0")"`, `node "${f.script}" >> ${f.log} 2>&1`, ""].join("\n"), "utf8");
    try { fs.chmodSync(runnerPath, 0o755); } catch { /* ignora */ }
  }
  console.log(`  Runner generado: ${path.basename(runnerPath)}`);
  return runnerPath;
}

function crearTareaWin(nombreTarea, hora, runnerPath) {
  // Comando unico (no array) para evitar DEP0190 con shell:true.
  const cmd = `schtasks /Create /SC DAILY /ST ${hora} /TN "${nombreTarea}" /TR "${runnerPath}" /F`;
  const r = spawnSync(cmd, { shell: true, stdio: "pipe", encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || "") };
}
function crearTareaCron(hora, runnerPath) {
  const [h, m] = hora.split(":");
  const cronLine = `${Number(m)} ${Number(h)} * * * "${runnerPath}"`;
  const r = spawnSync("sh", ["-c", `(crontab -l 2>/dev/null | grep -v -F "${runnerPath} #agendar"; echo '${cronLine} #agendar') | crontab -`], { stdio: "pipe", encoding: "utf8" });
  return { ok: r.status === 0, cronLine, out: (r.stdout || "") + (r.stderr || "") };
}

async function main() {
  console.log("\n=== Agendar los partes diarios (PJN / EJE / MEV) ===\n");
  console.log("Programa el disparo diario de cada parte a la hora que quieras. No pide claves.");
  console.log("Requisito: cada frente ya tiene que estar configurado en el .env.\n");

  // 1) Que frentes.
  console.log("Frentes: pjn, eje, mev");
  const sel = (await ask("Cuales agendar (coma, o 'todos')", "todos")).toLowerCase();
  const claves = sel === "todos" || sel === "todo"
    ? Object.keys(FRENTES)
    : sel.split(/[,\s]+/).map((s) => s.trim()).filter((s) => FRENTES[s]);
  if (!claves.length) { console.log("No elegiste ningun frente valido. Salgo."); rl.close(); return; }

  // 2) Frecuencia + horarios (iguales para todos los frentes elegidos).
  console.log("\nFrecuencia:");
  console.log("  1 = una vez al dia");
  console.log("  2 = dos veces (manana y tarde)");
  console.log("  3 = horarios a medida (los que vos pongas)");
  const modo = await ask("Opcion", "1");
  let horas = [];
  if (modo === "2") {
    const am = normHora(await ask("Hora de la manana (HH:MM)", "08:00"));
    const pm = normHora(await ask("Hora de la tarde (HH:MM)", "18:00"));
    horas = [am, pm];
  } else if (modo === "3") {
    const raw = await ask("Horarios separados por coma (ej: 08:00,13:00,19:30)", "08:00,18:00");
    horas = raw.split(",").map((s) => s.trim()).filter(Boolean).map(normHora);
  } else {
    horas = [normHora(await ask("Hora (HH:MM)", "18:00"))];
  }
  const invalidas = horas.filter((h) => !esHora(h));
  if (invalidas.length) { console.log(`Horario invalido: ${invalidas.join(", ")}. Usa formato HH:MM (24hs).`); rl.close(); return; }
  horas = [...new Set(horas)];

  // 3) Resumen y confirmacion.
  console.log("\nVoy a crear estas tareas diarias:");
  for (const k of claves) for (const h of horas) console.log(`  - ${FRENTES[k].nombre}  ->  ${h}`);
  const ok = (await ask("\nConfirmas? (s/n)", "s")).toLowerCase().startsWith("s");
  if (!ok) { console.log("Cancelado. No se creo ninguna tarea."); rl.close(); return; }

  // 4) Crear.
  console.log("");
  let creadas = 0, fallidas = 0;
  for (const k of claves) {
    const f = FRENTES[k];
    const runnerPath = asegurarRunner(f);
    for (const h of horas) {
      const nombreTarea = horas.length > 1 ? `${f.tarea}_${hhmm(h)}` : f.tarea;
      if (WIN) {
        const r = crearTareaWin(nombreTarea, h, runnerPath);
        if (r.ok) { creadas++; console.log(`  OK  ${nombreTarea} @ ${h}`); }
        else { fallidas++; console.log(`  FALLO  ${nombreTarea} @ ${h}: ${r.out.trim().split("\n").pop()}`); }
      } else {
        const r = crearTareaCron(h, runnerPath);
        if (r.ok) { creadas++; console.log(`  OK  cron ${r.cronLine}`); }
        else { fallidas++; console.log(`  FALLO cron @ ${h}: ${r.out.trim()}`); }
      }
    }
  }

  console.log(`\nListo. ${creadas} tarea(s) creada(s)${fallidas ? `, ${fallidas} con error` : ""}.`);
  if (WIN) {
    console.log("Verlas/editarlas: abri 'Programador de tareas' o corre  schtasks /Query /TN ParteDiarioMEV");
    console.log("Borrar una:  schtasks /Delete /TN ParteDiarioMEV /F");
    if (fallidas) console.log("Si fallo por permisos, corre este script (o agendar.bat) como Administrador.");
  } else {
    console.log("Verlas: crontab -l   |   Editarlas/borrarlas: crontab -e (las lineas terminan en '#agendar').");
  }
  console.log("");
  rl.close();
}

main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
