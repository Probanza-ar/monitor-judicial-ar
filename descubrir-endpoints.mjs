#!/usr/bin/env node
/**
 * descubrir-endpoints.mjs (v2) - Diagnostico interactivo. Abre el Portal PJN VISIBLE
 * y registra todas las llamadas a api.pjn.gov.ar mientras vos navegas. Sirve para
 * descubrir el endpoint que lista los expedientes vinculados al letrado.
 *
 * La lista NO se carga en el inicio: hay que entrar a la seccion de expedientes /
 * consultas. Por eso este diagnostico te da tiempo para navegar a mano.
 *
 * Ademas guarda el CUERPO de las respuestas JSON (por si la lista viene en
 * /usuario/info-inicial u otro endpoint), en endpoints-descubiertos.txt.
 *
 * Uso:  node descubrir-endpoints.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

(function cargarEnv() {
  const p = path.resolve(__dirname, ".env");
  if (!fs.existsSync(p)) return;
  for (const l of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
})();

const HOME_URL = "https://portalpjn.pjn.gov.ar/inicio";
const profileDir = process.env.PROFILE_DIR || path.resolve(__dirname, ".pjn-profile");
const SEGUNDOS = Number(process.env.DIAG_SEGUNDOS || 90);
const log = (...a) => console.log(...a);

const vistos = new Map();  // "METODO url_base" -> { status, tipo }
const cuerpos = new Map(); // url -> body (truncado)

async function main() {
  const browser = await puppeteer.launch({
    headless: false, // SIEMPRE visible: tenes que navegar vos.
    userDataDir: profileDir,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--start-maximized"],
  });
  try {
    const page = (await browser.pages())[0] || (await browser.newPage());

    page.on("request", (req) => {
      const u = req.url();
      if (!u.includes("api.pjn.gov.ar")) return;
      const clave = `${req.method()} ${u.split("?")[0]}${u.includes("?") ? " (con parametros)" : ""}`;
      if (!vistos.has(clave)) vistos.set(clave, { status: "?", tipo: "?" });
    });
    page.on("response", async (res) => {
      const u = res.url();
      if (!u.includes("api.pjn.gov.ar")) return;
      const met = res.request().method();
      const tipo = (res.headers()["content-type"] || "").split(";")[0];
      const clave = `${met} ${u.split("?")[0]}${u.includes("?") ? " (con parametros)" : ""}`;
      vistos.set(clave, { status: res.status(), tipo });
      if (met === "GET" && tipo.includes("json") && !cuerpos.has(u)) {
        try { cuerpos.set(u, (await res.text()).slice(0, 1200)); } catch { /* ignore */ }
      }
    });

    log("Abriendo el Portal PJN...");
    await page.goto(HOME_URL, { waitUntil: "networkidle2", timeout: 90000 }).catch(() => {});

    if (page.url().includes("sso.pjn.gov.ar") && process.env.PJN_USER && process.env.PJN_PASS) {
      log("Logueando...");
      await page.waitForSelector("#username", { timeout: 20000 }).catch(() => {});
      await page.type("#username", process.env.PJN_USER, { delay: 15 }).catch(() => {});
      await page.type("#password", process.env.PJN_PASS, { delay: 15 }).catch(() => {});
      await Promise.all([
        page.click("#kc-login").catch(() => page.keyboard.press("Enter")),
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }).catch(() => {}),
      ]);
    }

    log("\n=======================================================================");
    log("  AHORA NAVEGA VOS en la ventana del navegador que se abrio:");
    log("  entra a la seccion que muestra la LISTA DE TUS EXPEDIENTES / CAUSAS");
    log("  (menu tipo 'Expedientes', 'Mis causas', 'Consultas', 'Seguimiento').");
    log(`  Tenes ${SEGUNDOS} segundos. Voy registrando todo lo que pida el portal.`);
    log("=======================================================================\n");

    for (let i = SEGUNDOS; i > 0; i -= 10) {
      await new Promise((r) => setTimeout(r, 10000));
      log(`  ...quedan ${i - 10}s (segui navegando)`);
    }

    let salida = "ENDPOINTS de api.pjn.gov.ar detectados:\n\n";
    salida += [...vistos.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => `[${v.status}] ${v.tipo}   ${k}`).join("\n");
    salida += "\n\n\nMUESTRA DEL CONTENIDO (primeros 1200 chars por endpoint JSON):\n";
    for (const [u, body] of cuerpos) salida += `\n----- ${u}\n${body}\n`;

    fs.writeFileSync(path.resolve(__dirname, "endpoints-descubiertos.txt"), salida);
    log("\nGuardado en endpoints-descubiertos.txt. Pegame ESE archivo completo.");
  } finally {
    await browser.close().catch(() => {});
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
