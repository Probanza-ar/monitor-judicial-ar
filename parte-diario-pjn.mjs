#!/usr/bin/env node
/**
 * parte-diario-pjn.mjs - Parte diario de novedades del Portal PJN por email.
 *
 * Corre desatendido (ej. Programador de tareas de Windows a las 18:00):
 *   1. Abre Chromium headless con un PERFIL PERSISTENTE. Si la sesion del SSO
 *      sigue viva (clave guardada / cookie), entra solo. Si caduco, rellena
 *      usuario y clave del .env en el login de Keycloak (pjn-portal no permite
 *      grant password directo, por eso se usa el navegador real).
 *   2. Captura el Bearer que emite la propia SPA (no persiste credenciales del PJN).
 *   3. Baja el feed /eventos/ de api.pjn.gov.ar, filtra los ultimos N dias.
 *   4. Agrupa por FUERO y por expediente (despachos D / cedulas N), adjunta los
 *      PDF de cada novedad y manda el parte por Gmail SMTP.
 *
 * Requisitos:  npm i puppeteer nodemailer   (en la raiz del repo)
 * Config:      copiar .env.example a .env y completar. El .env NO se commitea.
 *
 * Uso manual (prueba):  node scripts/parte-diario-pjn.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";
import puppeteer from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── .env minimal (sin dependencia extra) ────────────────────────────────────
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

const CFG = {
  pjnUser: process.env.PJN_USER || "",
  pjnPass: process.env.PJN_PASS || "",
  smtpHost: process.env.SMTP_HOST || "smtp.gmail.com",
  smtpPort: Number(process.env.SMTP_PORT || 465),
  smtpUser: process.env.SMTP_USER || "",
  smtpPass: process.env.SMTP_PASS || "",
  mailFrom: process.env.MAIL_FROM || process.env.SMTP_USER || "",
  mailTo: process.env.MAIL_TO || "",
  dias: Number(process.env.DIAS || 1),
  paginas: Number(process.env.PAGINAS || 5),
  profileDir: process.env.PROFILE_DIR || path.resolve(__dirname, ".pjn-profile"),
  headless: (process.env.HEADLESS || "true") !== "false",
  enviarSinNovedades: (process.env.ENVIAR_SIN_NOVEDADES || "true") !== "false",
  adjuntarPdfs: (process.env.ADJUNTAR_PDFS || "true") !== "false",
  maxPdfs: Number(process.env.MAX_PDFS || 25),
  guardarPdfs: (process.env.GUARDAR_PDFS_LOCAL || "true") !== "false",
  carpetaPdfs: process.env.CARPETA_PDFS || path.resolve(__dirname, "pdfs"),
};

// Fecha de hoy en AR como YYYY-MM-DD, para la subcarpeta del dia.
function hoyAR() {
  const p = new Intl.DateTimeFormat("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}

const API = "https://api.pjn.gov.ar";
const HOME_URL = "https://portalpjn.pjn.gov.ar/inicio";
const log = (...a) => console.log(new Date().toISOString(), ...a);

const fmtFecha = (ms) => !ms ? "s/f" : new Intl.DateTimeFormat("es-AR", {
  timeZone: "America/Argentina/Buenos_Aires",
  day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
}).format(new Date(ms));
const letra = (t) => t === "despacho" ? "D" : (t === "cedula" ? "N" : "?");

// Nombres de fuero por prefijo de la clave de expediente (CCC 7336/2021 -> CCC).
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
  return { cod, nombre: FUEROS[cod] || cod };
}

// ─── 1) login + captura de token via navegador real ──────────────────────────
async function obtenerToken() {
  fs.mkdirSync(CFG.profileDir, { recursive: true });
  const browser = await puppeteer.launch({
    headless: CFG.headless ? "new" : false,
    userDataDir: CFG.profileDir,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = (await browser.pages())[0] || (await browser.newPage());
    let token = null;
    page.on("request", (req) => {
      const a = req.headers()["authorization"] || req.headers()["Authorization"];
      if (a && /^Bearer .{20,}/.test(a)) token = a.slice(7);
    });

    await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
    for (let i = 0; i < 15 && !token; i++) await new Promise((r) => setTimeout(r, 1000));

    if (!token && page.url().includes("sso.pjn.gov.ar")) {
      if (!CFG.pjnUser || !CFG.pjnPass) throw new Error("Sesion caducada y faltan PJN_USER/PJN_PASS en .env para re-loguear.");
      log("Sesion caducada: completando login del SSO con credenciales del .env");
      await page.waitForSelector("#username", { timeout: 20000 });
      await page.type("#username", CFG.pjnUser, { delay: 15 });
      await page.type("#password", CFG.pjnPass, { delay: 15 });
      await Promise.all([
        page.click("#kc-login").catch(() => page.keyboard.press("Enter")),
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {}),
      ]);
      for (let i = 0; i < 20 && !token; i++) await new Promise((r) => setTimeout(r, 1000));
    }

    if (!token) throw new Error(`No se capturo el token (URL actual: ${page.url()}). Si pide 2FA/captcha o la clave cambio, revisar.`);
    return token;
  } finally {
    await browser.close().catch(() => {});
  }
}

// ─── 2) feed de eventos ───────────────────────────────────────────────────────
async function traerEventos(token) {
  const items = [];
  let fechaHasta = null;
  for (let p = 0; p < CFG.paginas; p++) {
    let ruta = `${API}/eventos/?page=${p}&pageSize=20&categoria=judicial`;
    if (fechaHasta) ruta += `&fechaHasta=${fechaHasta}`;
    const r = await fetch(ruta, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json, */*" } });
    if (!r.ok) throw new Error(`API /eventos/ HTTP ${r.status} en page ${p}`);
    const j = await r.json();
    const lote = j.items || [];
    if (p === 0 && lote.length) fechaHasta = lote[0].fechaCreacion;
    items.push(...lote);
    if (lote.length < 20) break;
  }
  return items;
}

// ─── 3) descargar PDFs de las novedades ───────────────────────────────────────
async function descargarPdfs(token, nuevos) {
  if (!CFG.adjuntarPdfs && !CFG.guardarPdfs) return [];
  const conDoc = nuevos.filter((it) => it.hasDocument).slice(0, CFG.maxPdfs);
  const adjuntos = [];

  // Carpeta del dia (una nueva por dia): <CARPETA_PDFS>/<YYYY-MM-DD>/
  let dir = null;
  if (CFG.guardarPdfs && conDoc.length) {
    dir = path.join(CFG.carpetaPdfs, hoyAR());
    fs.mkdirSync(dir, { recursive: true });
  }

  for (const it of conDoc) {
    try {
      const r = await fetch(`${API}/eventos/${it.id}/pdf`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/pdf, */*" } });
      if (!r.ok) { log(`PDF evento ${it.id}: HTTP ${r.status}, salteado`); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      const clave = (it.payload?.claveExpediente || "exp").replace(/[^\w.-]+/g, "_");
      const filename = `${clave}_${letra(it.tipo)}_${it.id}.pdf`;
      if (dir) fs.writeFileSync(path.join(dir, filename), buf);
      if (CFG.adjuntarPdfs) adjuntos.push({ filename, content: buf });
    } catch (e) { log(`PDF evento ${it.id}: ${e.message}`); }
  }

  if (dir) log(`PDFs guardados en: ${dir}`);
  if (CFG.adjuntarPdfs) log(`PDFs adjuntados al mail: ${adjuntos.length}`);
  return adjuntos;
}

// ─── 4) armar el parte (agrupado por fuero -> expediente) ─────────────────────
function armarParte(nuevos) {
  // fuero -> { nombre, exps: Map(clave -> {caratula, eventos}) }
  const porFuero = new Map();
  for (const it of nuevos) {
    const pl = it.payload || {};
    const clave = pl.claveExpediente || "s/clave";
    const f = fueroDe(clave);
    if (!porFuero.has(f.cod)) porFuero.set(f.cod, { nombre: f.nombre, exps: new Map() });
    const exps = porFuero.get(f.cod).exps;
    if (!exps.has(clave)) exps.set(clave, { caratula: pl.caratulaExpediente || "", eventos: [] });
    exps.get(clave).eventos.push(it);
  }

  const fechaHoy = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "full" }).format(new Date());
  let texto = `Parte diario Portal PJN - ${fechaHoy}\nVentana: ultimos ${CFG.dias} dia(s). ${nuevos.length} evento(s) en ${porFuero.size} fuero(s).\n\n`;
  let html = `<h2>Parte diario Portal PJN</h2><p><b>${fechaHoy}</b><br>Ventana: ultimos ${CFG.dias} dia(s). ${nuevos.length} evento(s).</p>`;

  for (const [cod, { nombre, exps }] of porFuero) {
    texto += `################  ${nombre} (${cod})  ################\n\n`;
    html += `<h2 style="background:#8b1e1e;color:#fff;padding:4px 8px;margin:16px 0 6px;border-radius:3px">${nombre} <span style="opacity:.7">(${cod})</span></h2>`;
    for (const [clave, { caratula, eventos }] of exps) {
      texto += `== ${clave} ==\n${caratula}\n`;
      html += `<h3 style="margin:12px 0 2px">${clave}</h3><div style="color:#555">${caratula}</div><ul>`;
      for (const it of eventos) {
        const pdf = it.hasDocument ? `  [PDF adjunto: evento ${it.id}]` : "";
        texto += `  - [${letra(it.tipo)}] ${fmtFecha(it.fechaAccion)}${pdf}\n`;
        html += `<li>[<b>${letra(it.tipo)}</b>] ${fmtFecha(it.fechaAccion)}${it.hasDocument ? ` &mdash; PDF adjunto` : ""}</li>`;
      }
      texto += "\n"; html += "</ul>";
    }
  }
  html += `<hr><p style="color:#888;font-size:12px">Generado automaticamente. Los PDF van adjuntos. Verificar en el Portal PJN antes de computar plazos. La firma es del abogado.</p>`;
  return { texto, html, fueros: porFuero.size };
}

// ─── 5) email ─────────────────────────────────────────────────────────────────
async function enviar({ texto, html }, adjuntos, nuevos, fueros) {
  const t = nodemailer.createTransport({
    host: CFG.smtpHost, port: CFG.smtpPort, secure: CFG.smtpPort === 465,
    auth: { user: CFG.smtpUser, pass: CFG.smtpPass },
    // No colgar para siempre si un antivirus (ej. Avast Mail Shield) o un firewall
    // intercepta el SMTP: fallar rapido con error claro en vez de quedar esperando.
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 30000,
  });
  const fechaCorta = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short" }).format(new Date());
  const asunto = `Parte PJN ${fechaCorta} - ${nuevos} novedad(es) / ${fueros} fuero(s)`;
  log("Conectando al servidor de correo para enviar...");
  await t.sendMail({ from: CFG.mailFrom, to: CFG.mailTo, subject: asunto, text: texto, html, attachments: adjuntos });
  log(`Email enviado a ${CFG.mailTo} (${adjuntos.length} adjunto/s)`);
}

// ─── main ─────────────────────────────────────────────────────────────────────
async function main() {
  for (const [k, v] of Object.entries({ SMTP_USER: CFG.smtpUser, SMTP_PASS: CFG.smtpPass, MAIL_TO: CFG.mailTo })) {
    if (!v) throw new Error(`Falta ${k} en .env`);
  }
  log("Iniciando login/captura de token del Portal PJN");
  const token = await obtenerToken();
  log("Token capturado; bajando feed /eventos");
  const items = await traerEventos(token);

  const corte = Date.now() - CFG.dias * 24 * 60 * 60 * 1000;
  const nuevos = items.filter((it) => (it.fechaAccion || it.fechaCreacion || 0) >= corte);
  log(`Novedades en la ventana: ${nuevos.length}`);

  if (nuevos.length === 0 && !CFG.enviarSinNovedades) {
    log("Sin novedades y ENVIAR_SIN_NOVEDADES=false: no se envia correo.");
    return;
  }

  const adjuntos = await descargarPdfs(token, nuevos);
  const parte = armarParte(nuevos);
  await enviar(parte, adjuntos, nuevos.length, parte.fueros);
}

main().then(() => process.exit(0)).catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
