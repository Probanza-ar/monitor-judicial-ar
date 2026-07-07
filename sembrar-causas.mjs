#!/usr/bin/env node
/**
 * sembrar-causas.mjs - Siembra causas-pjn.csv con TODA la cartera activa, leyendo el
 * feed /eventos/ del PJN hacia atras (por defecto 12 meses). Es la alternativa limpia
 * a scrapear el SCW: captura toda causa que tuvo algun movimiento en el periodo.
 *
 * Se corre UNA VEZ (o cada tanto). Despues el bot diario mantiene la lista al dia.
 *
 * Config .env:  SEED_MESES=12   SEED_MAX_PAGINAS=300
 * Uso:  node sembrar-causas.mjs
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

const API = "https://api.pjn.gov.ar";
const HOME_URL = "https://portalpjn.pjn.gov.ar/inicio";
const profileDir = process.env.PROFILE_DIR || path.resolve(__dirname, ".pjn-profile");
const headless = (process.env.HEADLESS || "true") !== "false";
const MESES = Number(process.env.SEED_MESES || 12);
const MAX_PAG = Number(process.env.SEED_MAX_PAGINAS || 300);
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function obtenerToken() {
  fs.mkdirSync(profileDir, { recursive: true });
  const browser = await puppeteer.launch({ headless: headless ? "new" : false, userDataDir: profileDir, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  try {
    const page = (await browser.pages())[0] || (await browser.newPage());
    let token = null;
    page.on("request", (req) => { const a = req.headers()["authorization"]; if (a && /^Bearer .{20,}/.test(a)) token = a.slice(7); });
    await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
    for (let i = 0; i < 15 && !token; i++) await new Promise((r) => setTimeout(r, 1000));
    if (!token && page.url().includes("sso.pjn.gov.ar")) {
      if (!process.env.PJN_USER || !process.env.PJN_PASS) throw new Error("Sesion caducada y faltan PJN_USER/PJN_PASS en .env");
      await page.waitForSelector("#username", { timeout: 20000 });
      await page.type("#username", process.env.PJN_USER, { delay: 15 });
      await page.type("#password", process.env.PJN_PASS, { delay: 15 });
      await Promise.all([page.click("#kc-login").catch(() => page.keyboard.press("Enter")), page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {})]);
      for (let i = 0; i < 20 && !token; i++) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!token) throw new Error("No se capturo el token");
    return token;
  } finally { await browser.close().catch(() => {}); }
}

async function traerEventosProfundo(token, cutoffMs) {
  const items = [];
  let fechaHasta = null;
  for (let p = 0; p < MAX_PAG; p++) {
    let ruta = `${API}/eventos/?page=${p}&pageSize=20&categoria=judicial`;
    if (fechaHasta) ruta += `&fechaHasta=${fechaHasta}`;
    const r = await fetch(ruta, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json, */*" } });
    if (!r.ok) { log(`page ${p}: HTTP ${r.status}, corto`); break; }
    const j = await r.json();
    const lote = j.items || [];
    if (!lote.length) break;
    if (p === 0) fechaHasta = lote[0].fechaCreacion;
    items.push(...lote);
    const masViejo = lote[lote.length - 1].fechaAccion || lote[lote.length - 1].fechaCreacion || 0;
    if (p % 10 === 0) log(`page ${p}: ${items.length} eventos acumulados...`);
    if (lote.length < 20) break;
    if (masViejo < cutoffMs) break;
  }
  return items;
}

async function main() {
  log(`Sembrando causas de los ultimos ${MESES} meses...`);
  const token = await obtenerToken();
  const cutoff = Date.now() - MESES * 30 * 24 * 60 * 60 * 1000;
  const eventos = await traerEventosProfundo(token, cutoff);
  log(`Eventos leidos: ${eventos.length}`);
  const { registrarCausas } = await import("./lib/causas-log.mjs");
  const r = await registrarCausas({ nuevos: eventos });
  log(`CSV de causas: ${r.nuevas} nueva(s). Total: ${r.total}. Archivo: ${r.archivo}`);

  const { actualizarCartera } = await import("./lib/cartera.mjs");
  const rc = await actualizarCartera({ nuevos: eventos });
  log(`Cartera (xlsx): ${rc.nuevas} nueva(s). Total: ${rc.total}. Archivo: ${rc.archivo}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
