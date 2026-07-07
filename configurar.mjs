#!/usr/bin/env node
/**
 * configurar.mjs - Asistente interactivo para dejar listo el parte diario del PJN.
 *
 * Pregunta los datos, escribe el .env, genera el .bat de ejecucion y (opcional)
 * agenda la tarea de las 18:00 en Windows. Pensado para correr con doble clic
 * via configurar.bat. No hay que editar archivos a mano.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, ".env");
const batPath = path.join(__dirname, "run-parte-pjn.bat");
const scriptRel = "parte-diario-pjn.mjs";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q, def = "") => new Promise((res) =>
  rl.question(def ? `${q} [${def}]: ` : `${q}: `, (a) => res((a || "").trim() || def)));

// Pregunta con entrada oculta (para contrasenas).
function askSecret(q) {
  return new Promise((res) => {
    process.stdout.write(`${q}: `);
    const onData = (ch) => {
      const s = ch.toString();
      if (s === "\n" || s === "\r" || s === "") { process.stdin.removeListener("data", onData); }
    };
    process.stdin.on("data", onData);
    const orig = rl._writeToOutput?.bind(rl);
    rl._writeToOutput = () => rl.output.write("*");
    rl.question("", (a) => { rl._writeToOutput = orig; process.stdout.write("\n"); res(a.trim()); });
  });
}

async function main() {
  console.log("\n=== Configuracion del parte diario del Portal PJN ===\n");
  console.log("Te voy a pedir unos datos. Se guardan solo en tu maquina (archivo .env local).\n");

  console.log("--- Gmail (desde donde sale y a donde llega el parte) ---");
  console.log("Necesitas una CONTRASENA DE APLICACION de Google (no tu clave normal).");
  console.log("Se genera en: Cuenta de Google > Seguridad > Contrasenas de aplicacion.");
  console.log("(requiere tener activada la verificacion en 2 pasos)\n");
  const smtpUser = await ask("Tu direccion de Gmail");
  const smtpPass = await ask("Contrasena de aplicacion de Gmail (16 letras, se ve al pegarla)");
  const mailTo = await ask("A que casilla llega el parte (Enter = tu mismo Gmail)", smtpUser);

  console.log("\n--- Portal PJN (para re-loguear si la sesion caduca) ---");
  const pjnUser = await ask("Usuario del PJN");
  const pjnPass = await ask("Clave del PJN (se ve al escribirla)");

  console.log("\n--- Opciones ---");
  const dias = await ask("Ventana en dias (1 = ultimas 24hs)", "1");
  const sinNov = (await ask("Mandar mail aunque NO haya novedades? (s/n)", "s")).toLowerCase().startsWith("s") ? "true" : "false";
  const pdfs = (await ask("Adjuntar los PDF de cada novedad al mail? (s/n)", "s")).toLowerCase().startsWith("s") ? "true" : "false";
  const guardar = (await ask("Guardar tambien los PDF en una carpeta local (una por dia)? (s/n)", "s")).toLowerCase().startsWith("s") ? "true" : "false";
  let carpeta = "";
  if (guardar === "true") {
    console.log("  Podes poner cualquier ruta, incluso en otro disco. Ejemplo: D:\\DERECHO\\PartesPJN");
    console.log("  Adentro se crea una subcarpeta por dia sola (ej. D:\\DERECHO\\PartesPJN\\2026-07-02).");
    carpeta = await ask("Carpeta base para los PDF (Enter = carpeta 'pdfs' del programa)");
  }

  const env = [
    `PJN_USER=${pjnUser}`,
    `PJN_PASS=${pjnPass}`,
    `SMTP_HOST=smtp.gmail.com`,
    `SMTP_PORT=465`,
    `SMTP_USER=${smtpUser}`,
    `SMTP_PASS=${smtpPass}`,
    `MAIL_FROM=${smtpUser}`,
    `MAIL_TO=${mailTo}`,
    `DIAS=${dias}`,
    `PAGINAS=5`,
    `ENVIAR_SIN_NOVEDADES=${sinNov}`,
    `ADJUNTAR_PDFS=${pdfs}`,
    `MAX_PDFS=25`,
    `GUARDAR_PDFS_LOCAL=${guardar}`,
    (carpeta ? `CARPETA_PDFS=${carpeta}` : `# CARPETA_PDFS=`),
    `HEADLESS=true`,
    "",
  ].join("\r\n");
  fs.writeFileSync(envPath, env, "utf8");
  console.log(`\nOK. Datos guardados en ${envPath}`);

  // Ejecutable segun sistema operativo.
  const win = process.platform === "win32";
  let runnerPath;
  if (win) {
    runnerPath = path.join(__dirname, "run-parte-pjn.bat");
    fs.writeFileSync(runnerPath, [
      "@echo off",
      `cd /d "%~dp0"`,
      `node "${scriptRel}" >> "parte-pjn.log" 2>&1`,
      "",
    ].join("\r\n"), "utf8");
  } else {
    runnerPath = path.join(__dirname, "run-parte-pjn.sh");
    fs.writeFileSync(runnerPath, [
      "#!/bin/sh",
      `cd "$(dirname "$0")"`,
      `node "${scriptRel}" >> parte-pjn.log 2>&1`,
      "",
    ].join("\n"), "utf8");
    try { fs.chmodSync(runnerPath, 0o755); } catch { /* ignora */ }
  }
  console.log(`Ejecutable generado: ${runnerPath}`);

  // Programacion a las 18:00.
  const agendar = (await ask("\nAgendo la tarea de las 18:00 ahora? (s/n)", "s")).toLowerCase().startsWith("s");
  if (agendar && win) {
    const r = spawnSync("schtasks", ["/Create", "/SC", "DAILY", "/ST", "18:00", "/TN", "ParteDiarioPJN", "/TR", `"${runnerPath}"`, "/F"], { shell: true, stdio: "inherit" });
    console.log(r.status === 0
      ? "\nTarea 'ParteDiarioPJN' agendada a las 18:00 (Programador de tareas)."
      : "\nNo se pudo agendar solo. Crea la tarea a mano apuntando a:\n  " + runnerPath);
  } else if (agendar && !win) {
    const cronLine = `0 18 * * * "${runnerPath}"`;
    const r = spawnSync("sh", ["-c", `(crontab -l 2>/dev/null | grep -v -F "${runnerPath}"; echo '${cronLine}') | crontab -`], { stdio: "inherit" });
    console.log(r.status === 0
      ? `\nAgendado en cron a las 18:00:\n  ${cronLine}\n(Para verlo: crontab -l)`
      : `\nNo se pudo agendar solo. Corre 'crontab -e' y pega esta linea:\n  ${cronLine}`);
  } else {
    console.log("\nListo. Para agendarla despues, apunta el programador (Tareas en Windows, cron en Mac/Linux) a:\n  " + runnerPath);
  }

  console.log("\nPrimera prueba recomendada: en el .env pone HEADLESS=false y corre una vez");
  console.log("para loguearte a mano y que Chromium guarde la sesion. Despues volve a HEADLESS=true.\n");
  rl.close();
}

main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
