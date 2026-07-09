#!/usr/bin/env node
/**
 * parte-diario-pjn.mjs - Parte diario de novedades del Portal PJN por email.
 *
 * Script UNICO del frente PJN (consolidado jul-2026; antes convivian una v1 y
 * una "v2" separadas y era facil correr por error la version sin modulos).
 * Hace: login por navegador real (Puppeteer + perfil persistente), captura del
 * Bearer, feed /eventos/ de api.pjn.gov.ar, agrupado por fuero, envio por Gmail.
 * Ademas:
 *
 *   1) ALERTA DE FALLA CRITICA: si el script falla (portal caido, token, SMTP,
 *      etc.) manda un mail de aviso en vez de morir en silencio. Ademas escribe
 *      un archivo "ultima-corrida.log" en cada corrida exitosa (heartbeat), para
 *      poder auditar cuando fue la ultima vez que efectivamente corrio.
 *   2) VENTANA POR DIAS HABILES: en vez de una ventana fija de N dias, calcula el
 *      corte hasta el ultimo dia habil (contempla fin de semana y feriados). Un
 *      lunes a la tarde toma tambien lo publicado el viernes. Se puede volver al
 *      modo fijo con MODO_VENTANA=fijo.
 *   3) VALIDACION DE DESCARGA: cada PDF se valida (tamano minimo + firma %PDF) y
 *      se reintenta una vez. Las descargas que fallan se reportan en el parte.
 *   4) PRIORIDAD DE CEDULAS: detecta actuaciones sensibles (traslado, intimacion,
 *      apercibimiento, suspension/reanudacion de plazos, sentencia, caducidad,
 *      audiencia, etc.) y las destaca en un bloque PRIORITARIAS al inicio.
 *   5) MODULOS DE GESTION: engancha lib/cartera.mjs (cartera-pjn.xlsx),
 *      lib/caducidad.mjs (caducidad de instancia CPCCN) y lib/penal.mjs
 *      (inactividad + prescripcion penal), mas los logs CSV de movimientos y causas.
 *
 * No agrega dependencias fuera de puppeteer + nodemailer (+ exceljs opcional
 * para la cartera).
 *
 * Config: copiar .env.example a .env y completar. El .env NO se commitea.
 * Uso manual (prueba):  node parte-diario-pjn.mjs
 *
 * NOTA: verificar siempre en el Portal PJN antes de computar plazos. La firma es
 * del abogado. Este parte es una ayuda de seguimiento, no una notificacion.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";
import puppeteer from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  // Destinatario de las alertas de falla. Si no se define, usa MAIL_TO.
  mailToAlerta: process.env.MAIL_TO_ALERTA || process.env.MAIL_TO || "",
  dias: Number(process.env.DIAS || 1),
  modoVentana: (process.env.MODO_VENTANA || "habil").toLowerCase(), // habil | fijo
  feriados: (process.env.FERIADOS || "").split(",").map((s) => s.trim()).filter(Boolean),
  paginas: Number(process.env.PAGINAS || 5),
  profileDir: process.env.PROFILE_DIR || path.resolve(__dirname, ".pjn-profile"),
  headless: (process.env.HEADLESS || "true") !== "false",
  enviarSinNovedades: (process.env.ENVIAR_SIN_NOVEDADES || "true") !== "false",
  adjuntarPdfs: (process.env.ADJUNTAR_PDFS || "true") !== "false",
  maxPdfs: Number(process.env.MAX_PDFS || 25),
  guardarPdfs: (process.env.GUARDAR_PDFS_LOCAL || "true") !== "false",
  carpetaPdfs: process.env.CARPETA_PDFS || path.resolve(__dirname, "pdfs"),
  pdfMinBytes: Number(process.env.PDF_MIN_BYTES || 1000),
  alertaFalla: (process.env.ALERTA_FALLA || "true") !== "false",
  // Fallback local: donde se escribe ALERTA_CRITICA.txt si no se pudo mandar el
  // mail de falla (red/IP/SMTP caidos). Default: la propia carpeta del repo.
  // Sugerencia: apuntar al Escritorio.
  alertaLocalDir: process.env.ALERTA_LOCAL_DIR || __dirname,
};

// Feriados / dias inhabiles: se combinan los del .env (FERIADOS=...) con un
// feriados.json opcional en la carpeta del repo. Cada entrada puede ser:
//   - una fecha ISO suelta:   "2026-07-09"
//   - un RANGO inclusivo:     "2026-01-01..2026-01-31"  (para feria judicial/receso)
// El rango se expande a fechas individuales. Sirve para la feria de enero, el
// receso de invierno y paros de varios dias, sin listar cada fecha a mano.
function expandirFeriados(lista) {
  const out = new Set();
  const addRango = (a, b) => {
    let cur = new Date(a + "T00:00:00Z");
    const fin = new Date(b + "T00:00:00Z");
    let guarda = 0;
    while (cur <= fin && guarda++ < 400) {
      out.add(cur.toISOString().slice(0, 10));
      cur = new Date(cur.getTime() + 86400000);
    }
  };
  for (const raw of lista) {
    const s = String(raw).trim();
    const rango = s.match(/^(\d{4}-\d{2}-\d{2})\s*\.\.\s*(\d{4}-\d{2}-\d{2})$/);
    if (rango) { addRango(rango[1], rango[2]); continue; }
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) out.add(s);
  }
  return out;
}
(function cargarFeriados() {
  let lista = [...CFG.feriados];
  const p = path.resolve(__dirname, "feriados.json");
  if (fs.existsSync(p)) {
    try {
      const arr = JSON.parse(fs.readFileSync(p, "utf8"));
      if (Array.isArray(arr)) lista.push(...arr.map((s) => String(s).trim()));
    } catch (e) {
      console.error("Aviso: feriados.json invalido, se ignora:", e.message);
    }
  }
  CFG.feriados = Array.from(expandirFeriados(lista));
})();

// Argentina no aplica horario de verano: offset fijo UTC-3.
const AR_OFFSET_HORAS = 3;

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

// ─── ventana temporal por dias habiles ────────────────────────────────────────
// AR midnight de una fecha (Y-M-D) expresado en epoch ms. AR = UTC-3 fijo.
function arMidnightMs(y, m, d) {
  return Date.UTC(y, m - 1, d, AR_OFFSET_HORAS, 0, 0, 0);
}
// Recibe un Date que representa la medianoche AR (03:00 UTC) y dice si es habil.
function esFechaHabil(dMid, feriados) {
  const dow = dMid.getUTCDay(); // 0 dom, 6 sab
  if (dow === 0 || dow === 6) return false;
  const iso = dMid.toISOString().slice(0, 10);
  return !feriados.includes(iso);
}
// Calcula el corte (epoch ms) y una descripcion legible de la ventana.
function calcularCorte() {
  if (CFG.modoVentana === "fijo") {
    const corte = Date.now() - CFG.dias * 24 * 60 * 60 * 1000;
    return { corte, desc: `ultimos ${CFG.dias} dia(s) [modo fijo]` };
  }
  const [y, m, d] = hoyAR().split("-").map(Number);
  let cur = new Date(arMidnightMs(y, m, d)); // medianoche AR de hoy
  // Retroceder hasta el dia habil inmediato anterior.
  do {
    cur = new Date(cur.getTime() - 24 * 60 * 60 * 1000);
  } while (!esFechaHabil(cur, CFG.feriados));
  const corte = cur.getTime();
  const iso = cur.toISOString().slice(0, 10);
  const dias = Math.round((arMidnightMs(y, m, d) - corte) / 86400000);
  return { corte, desc: `desde el ultimo dia habil (${iso} 00:00 AR, ${dias} dia[s] atras) [modo habil]` };
}

// ─── prioridad de actuaciones ─────────────────────────────────────────────────
// Palabras que marcan una actuacion como sensible para el computo de plazos o la
// estrategia, en TODAS las ramas (no solo penal). La deteccion es orientativa: NO
// reemplaza la lectura del despacho. Ante la duda, se prioriza.
const RX_PRIORIDAD = new RegExp(
  "\\b(" + [
    // Comunes a todos los fueros (plazos / notificaciones / recursos)
    "traslad", "intim", "apercib", "caduc", "peren", "suspen", "reanud",
    "sentenc", "resuelv", "resolu", "hace lugar", "rechaz", "deniega", "desestim",
    "audiencia", "vista", "notif", "plazo", "vencimiento", "apel", "recurs",
    "queja", "nulidad", "revoc", "aclarator", "regulac", "honorar", "oficio",
    // Civil y comercial / procesal
    "demanda", "contest", "excepc", "prescrip", "prueb", "pericia", "aleg",
    "ejecut", "subast", "embarg", "inhib", "cautelar", "medida", "rebeld",
    "homologac", "mediacion", "conciliac", "desaloj",
    // Laboral / previsional
    "liquidac", "reajust", "haber", "retroactiv",
    // Familia
    "aliment", "tenenc", "cuota", "regimen de comunicac", "restituc",
    // Concursal / comercial
    "quiebra", "concurso", "verificac", "pronto pago",
    // Contencioso administrativo / tributario
    "multa", "astreinte", "sancion", "recurso jerarquic",
    // Penal
    "prision", "excarcel", "eximicion", "indagatoria", "procesamiento",
    "sobresei", "elevacion a juicio", "requerimiento", "condena", "absol",
  ].join("|") + ")\\w*", "i"
);
function textoEvento(it) {
  const p = it.payload || {};
  return [it.tipo, it.descripcion, it.titulo, it.detalle, it.sintesis,
    p.descripcion, p.detalle, p.titulo, p.tipoEvento, p.sintesis, p.caratulaExpediente]
    .filter(Boolean).join(" | ");
}
// Prioritario si matchea una palabra sensible o si es cedula (efecto notificatorio).
function esPrioritario(it) {
  if (it.tipo === "cedula") return true;
  return RX_PRIORIDAD.test(textoEvento(it));
}
function motivoPrioridad(it) {
  if (it.tipo === "cedula") return "cedula";
  const m = textoEvento(it).match(RX_PRIORIDAD);
  return m ? m[0].toLowerCase() : "";
}
// Heuristica de resolucion adversa/denegatoria. NO baja la prioridad (en penal, si
// hay duda se prioriza): solo agrega una etiqueta para ayudar a triar la lectura.
const RX_NEGATIVA = /\bno\s+(ha|hace)\s+lugar|\brechaz\w*|\bdeniega\w*|\bdesestim\w*|\bno\s+ha\s+lugar/i;
function marcaNegativa(it) {
  return RX_NEGATIVA.test(textoEvento(it));
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
    for (let i = 0; i < 15 && !token; i++) await sleep(1000);

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
      for (let i = 0; i < 20 && !token; i++) await sleep(1000);
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

// ─── 3) descargar PDFs de las novedades (con validacion + reintento) ──────────
async function bajarUnPdf(token, id) {
  for (let intento = 1; intento <= 2; intento++) {
    try {
      const r = await fetch(`${API}/eventos/${id}/pdf`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/pdf, */*" } });
      if (!r.ok) {
        if (intento === 2) return { ok: false, motivo: `HTTP ${r.status}` };
        await sleep(1500); continue;
      }
      const buf = Buffer.from(await r.arrayBuffer());
      const esPdf = buf.length >= 5 && buf.slice(0, 5).toString("latin1") === "%PDF-";
      if (buf.length < CFG.pdfMinBytes || !esPdf) {
        if (intento === 2) return { ok: false, motivo: `archivo invalido (${buf.length} bytes, firmaPDF=${esPdf})` };
        await sleep(1500); continue;
      }
      return { ok: true, buf };
    } catch (e) {
      if (intento === 2) return { ok: false, motivo: e.message };
      await sleep(1500);
    }
  }
  return { ok: false, motivo: "sin resultado" };
}

async function descargarPdfs(token, nuevos) {
  const fallos = [];    // { id, clave, motivo }
  const guardados = []; // { claveOriginal, path } - ruta local por PDF, para el Excel
  if (!CFG.adjuntarPdfs && !CFG.guardarPdfs) return { adjuntos: [], fallos, guardados };
  const conDoc = nuevos.filter((it) => it.hasDocument).slice(0, CFG.maxPdfs);
  const adjuntos = [];

  let dir = null;
  if (CFG.guardarPdfs && conDoc.length) {
    dir = path.join(CFG.carpetaPdfs, hoyAR());
    fs.mkdirSync(dir, { recursive: true });
  }

  for (const it of conDoc) {
    const claveOriginal = it.payload?.claveExpediente || "";
    const clave = (claveOriginal || "exp").replace(/[^\w.-]+/g, "_");
    const res = await bajarUnPdf(token, it.id);
    if (!res.ok) {
      log(`PDF evento ${it.id} (${clave}): FALLO - ${res.motivo}`);
      fallos.push({ id: it.id, clave, motivo: res.motivo });
      continue;
    }
    const filename = `${clave}_${letra(it.tipo)}_${it.id}.pdf`;
    if (dir) {
      const full = path.join(dir, filename);
      fs.writeFileSync(full, res.buf);
      guardados.push({ claveOriginal, id: it.id, path: full });
    }
    if (CFG.adjuntarPdfs) adjuntos.push({ filename, content: res.buf });
  }

  if (dir) log(`PDFs guardados en: ${dir}`);
  if (CFG.adjuntarPdfs) log(`PDFs adjuntados al mail: ${adjuntos.length}`);
  if (fallos.length) log(`PDFs con problema de descarga: ${fallos.length}`);
  return { adjuntos, fallos, guardados };
}

// ─── 4) armar el parte (bloque prioritarias + agrupado por fuero) ─────────────
function armarParte(nuevos, ventanaDesc, fallos, caducidad, penal) {
  const prioritarias = nuevos.filter(esPrioritario);

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
  let texto = `Parte diario Portal PJN - ${fechaHoy}\nVentana: ${ventanaDesc}. ${nuevos.length} evento(s) en ${porFuero.size} fuero(s).\n\n`;
  let html = `<h2>Parte diario Portal PJN</h2><p><b>${fechaHoy}</b><br>Ventana: ${ventanaDesc}. ${nuevos.length} evento(s).</p>`;

  // Bloque PRIORITARIAS al inicio.
  if (prioritarias.length) {
    texto += `>>> PRIORITARIAS (${prioritarias.length}) - revisar primero <<<\n`;
    html += `<div style="border:2px solid #8b1e1e;border-radius:4px;padding:8px 10px;margin:10px 0"><b style="color:#8b1e1e">PRIORITARIAS (${prioritarias.length}) - revisar primero</b><ul style="margin:6px 0">`;
    for (const it of prioritarias) {
      const pl = it.payload || {};
      const clave = pl.claveExpediente || "s/clave";
      const mot = motivoPrioridad(it);
      const neg = marcaNegativa(it) ? " - posible resol. negativa/denegatoria" : "";
      texto += `  [!] ${clave} - ${pl.caratulaExpediente || ""} - [${letra(it.tipo)}] ${fmtFecha(it.fechaAccion)} (${mot}${neg})\n`;
      html += `<li><b>${clave}</b> - ${pl.caratulaExpediente || ""} - [${letra(it.tipo)}] ${fmtFecha(it.fechaAccion)} <span style="color:#8b1e1e">(${mot})</span>${neg ? `<span style="color:#b58900"> - posible resol. negativa</span>` : ""}</li>`;
    }
    texto += "\n"; html += "</ul></div>";
  }

  // Alerta de caducidad de instancia (viene precalculada desde main).
  if (caducidad && caducidad.texto) {
    texto += caducidad.texto + "\n";
    html += caducidad.html;
  }

  // Frente penal: inactividad + prescripcion (viene precalculado desde main).
  if (penal && penal.texto) {
    texto += penal.texto + "\n";
    html += penal.html;
  }

  // Reporte de descargas fallidas (auditoria).
  if (fallos && fallos.length) {
    texto += `>>> DESCARGAS CON PROBLEMA (${fallos.length}) - bajar a mano del Portal <<<\n`;
    for (const f of fallos) texto += `  [x] ${f.clave} - evento ${f.id}: ${f.motivo}\n`;
    texto += "\n";
    html += `<div style="border:1px solid #b58900;border-radius:4px;padding:6px 10px;margin:10px 0;background:#fdf6e3"><b style="color:#b58900">Descargas con problema (${fallos.length})</b> - bajar a mano del Portal<ul style="margin:6px 0">`;
    for (const f of fallos) html += `<li>${f.clave} - evento ${f.id}: ${f.motivo}</li>`;
    html += "</ul></div>";
  }

  for (const [cod, { nombre, exps }] of porFuero) {
    texto += `################  ${nombre} (${cod})  ################\n\n`;
    html += `<h2 style="background:#8b1e1e;color:#fff;padding:4px 8px;margin:16px 0 6px;border-radius:3px">${nombre} <span style="opacity:.7">(${cod})</span></h2>`;
    for (const [clave, { caratula, eventos }] of exps) {
      texto += `== ${clave} ==\n${caratula}\n`;
      html += `<h3 style="margin:12px 0 2px">${clave}</h3><div style="color:#555">${caratula}</div><ul>`;
      for (const it of eventos) {
        const prio = esPrioritario(it) ? " [PRIORITARIA]" : "";
        const pdf = it.hasDocument ? `  [PDF: evento ${it.id}]` : "";
        texto += `  - [${letra(it.tipo)}] ${fmtFecha(it.fechaAccion)}${prio}${pdf}\n`;
        html += `<li>[<b>${letra(it.tipo)}</b>] ${fmtFecha(it.fechaAccion)}${prio ? ` <span style="color:#8b1e1e">[PRIORITARIA]</span>` : ""}${it.hasDocument ? ` &mdash; PDF adjunto` : ""}</li>`;
      }
      texto += "\n"; html += "</ul>";
    }
  }
  html += `<hr><p style="color:#888;font-size:12px">Generado automaticamente. La deteccion de PRIORITARIAS es orientativa y no reemplaza la lectura del despacho. Verificar en el Portal PJN antes de computar plazos. La firma es del abogado.</p>`;
  return { texto, html, fueros: porFuero.size, prioritarias: prioritarias.length, revisionCaducidad: (caducidad && caducidad.revision) || 0 };
}

// ─── 5) email ─────────────────────────────────────────────────────────────────
function crearTransport() {
  return nodemailer.createTransport({
    host: CFG.smtpHost, port: CFG.smtpPort, secure: CFG.smtpPort === 465,
    auth: { user: CFG.smtpUser, pass: CFG.smtpPass },
    connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 30000,
  });
}

async function enviar({ texto, html }, adjuntos, nuevos, fueros, prioritarias, revisionCaducidad = 0) {
  const t = crearTransport();
  const fechaCorta = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short" }).format(new Date());
  const prefijo = (revisionCaducidad ? `[REVISION CADUCIDAD x${revisionCaducidad}] ` : "") + (prioritarias ? `[${prioritarias} PRIORITARIA(S)] ` : "");
  const asunto = `${prefijo}Parte PJN ${fechaCorta} - ${nuevos} novedad(es) / ${fueros} fuero(s)`;
  log("Conectando al servidor de correo para enviar...");
  await t.sendMail({ from: CFG.mailFrom, to: CFG.mailTo, subject: asunto, text: texto, html, attachments: adjuntos });
  log(`Email enviado a ${CFG.mailTo} (${adjuntos.length} adjunto/s)`);
}

// Fallback local: si no se pudo mandar el mail de falla (red/IP/SMTP caidos), deja
// un rastro imposible de pasar por alto: archivo ALERTA_CRITICA.txt + beep de consola.
function alertaLocal(err, motivoMailFallo) {
  const fecha = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short", timeStyle: "short" }).format(new Date());
  const contenido = [
    `ALERTA CRITICA - Parte diario Portal PJN`,
    `=========================================`,
    ``,
    `La corrida FALLO y ademas NO se pudo enviar el mail de aviso.`,
    `Revisar el Portal PJN A MANO hoy mismo. No asumir que no hay novedades.`,
    ``,
    `Fecha/hora: ${fecha}`,
    `Error de la corrida: ${err && err.message ? err.message : String(err)}`,
    `Motivo por el que no salio el mail: ${motivoMailFallo || "n/d"}`,
  ].join("\n");
  try {
    const dest = path.join(CFG.alertaLocalDir, "ALERTA_CRITICA.txt");
    fs.writeFileSync(dest, contenido + "\n");
    log(`Fallback local escrito en: ${dest}`);
  } catch (e3) {
    log(`Tampoco se pudo escribir el fallback local: ${e3.message}`);
  }
  // Beep de consola (suena si corre en una terminal visible; inocuo si no).
  try { for (let i = 0; i < 5; i++) process.stdout.write("\x07"); } catch {}
}

// Aviso de falla critica. Best-effort: si el propio SMTP es el que falla, cae al
// fallback local (archivo + beep) para no quedar en silencio total.
async function enviarAlertaFalla(err) {
  if (!CFG.alertaFalla) return;
  if (!CFG.smtpUser || !CFG.smtpPass || !CFG.mailToAlerta) {
    log("No se pudo mandar alerta de falla por mail: faltan datos SMTP/MAIL_TO_ALERTA. Uso fallback local.");
    alertaLocal(err, "faltan datos SMTP/MAIL_TO_ALERTA");
    return;
  }
  try {
    const t = crearTransport();
    const fecha = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short", timeStyle: "short" }).format(new Date());
    const texto = [
      `El parte diario del Portal PJN NO se genero correctamente.`,
      ``,
      `Fecha/hora: ${fecha}`,
      `Error: ${err && err.message ? err.message : String(err)}`,
      ``,
      `Accion sugerida: entrar al Portal PJN a mano y revisar novedades del dia.`,
      `Posibles causas: portal caido, sesion caducada (relogueo), 2FA/captcha, o corte de red.`,
    ].join("\n");
    await t.sendMail({
      from: CFG.mailFrom, to: CFG.mailToAlerta,
      subject: `[FALLA] Parte PJN ${fecha} - la corrida NO se completo`,
      text: texto,
    });
    log(`Alerta de falla enviada a ${CFG.mailToAlerta}`);
  } catch (e2) {
    log(`No se pudo enviar la alerta de falla por mail: ${e2.message}. Uso fallback local.`);
    alertaLocal(err, `fallo el envio del mail: ${e2.message}`);
  }
}

// Heartbeat: deja registro de la ultima corrida exitosa.
function registrarCorrida(resumen) {
  try {
    const linea = `${new Date().toISOString()} | OK | ${resumen}\n`;
    fs.appendFileSync(path.resolve(__dirname, "ultima-corrida.log"), linea);
  } catch (e) {
    log(`No se pudo escribir el heartbeat: ${e.message}`);
  }
  // Limpiar una alerta local de una corrida anterior fallida, ya superada.
  try {
    const alerta = path.join(CFG.alertaLocalDir, "ALERTA_CRITICA.txt");
    if (fs.existsSync(alerta)) fs.unlinkSync(alerta);
  } catch {}
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

  const { corte, desc } = calcularCorte();
  log(`Ventana: ${desc} (corte ${new Date(corte).toISOString()})`);
  const nuevos = items.filter((it) => (it.fechaAccion || it.fechaCreacion || 0) >= corte);
  log(`Novedades en la ventana: ${nuevos.length}`);

  if (nuevos.length === 0 && !CFG.enviarSinNovedades) {
    log("Sin novedades y ENVIAR_SIN_NOVEDADES=false: no se envia correo.");
    registrarCorrida("0 novedades, sin envio");
    return;
  }

  const { adjuntos, fallos, guardados } = await descargarPdfs(token, nuevos);

  // Cartera autocompletada: el bot agrega/actualiza causas en cartera-pjn.xlsx,
  // conservando las columnas de gestion que carga el usuario.
  try {
    const { actualizarCartera } = await import("./lib/cartera.mjs");
    const rcar = await actualizarCartera({ nuevos });
    if (rcar.nota) log(`Cartera: ${rcar.nota}`);
    else log(`Cartera (xlsx): ${rcar.nuevas} nueva(s), ${rcar.total} en total.${rcar.archivo ? " Archivo: " + rcar.archivo : ""}`);
  } catch (e) {
    log(`Cartera omitida: ${e.message}`);
  }

  // Alerta de caducidad de instancia (lee cartera-pjn.xlsx).
  let caducidadRender = null;
  {
    try {
      const { calcularCaducidad, renderCaducidad } = await import("./lib/caducidad.mjs");
      const cad = await calcularCaducidad();
      if (cad.nota) log(`Caducidad: ${cad.nota}`);
      if (cad.items.length) log(`Caducidad: ${cad.items.length} causa(s) en riesgo; ${cad.sinImpulso || 0} sin impulso verificado`);
      caducidadRender = renderCaducidad(cad.items, cad.sinImpulso || 0);
    } catch (e) {
      log(`Caducidad omitida: ${e.message}`);
    }
  }

  // Frente penal: monitor de inactividad + prescripcion (lee cartera-pjn.xlsx).
  let penalRender = null;
  {
    try {
      const { calcularPenal, renderPenal } = await import("./lib/penal.mjs");
      const pen = await calcularPenal();
      if (pen.nota) log(`Penal: ${pen.nota}`);
      if (pen.inactividad.length || pen.prescripcion.length) log(`Penal: ${pen.prescripcion.length} prescripcion, ${pen.inactividad.length} inactividad`);
      if (pen.sinTabla && pen.sinTabla.length) log(`Penal: ${pen.sinTabla.length} causa(s) con articulo detectado sin dato de pena (revisar)`);
      if (pen.delito && pen.delito.detectadas) {
        if (pen.delito.error) log(`Penal: no se pudo volcar "Delito (art. CP)" (${pen.delito.detectadas} deteccion[es]): ${pen.delito.error}`);
        else if (pen.delito.salida) log(`Penal: "Delito (art. CP)" completado en ${pen.delito.detectadas} fila(s). Archivo: ${pen.delito.salida}`);
      }
      penalRender = renderPenal(pen);
    } catch (e) {
      log(`Penal omitido: ${e.message}`);
    }
  }

  const parte = armarParte(nuevos, desc, fallos, caducidadRender, penalRender);
  await enviar(parte, adjuntos, nuevos.length, parte.fueros, parte.prioritarias, parte.revisionCaducidad);
  registrarCorrida(`${nuevos.length} novedades, ${parte.prioritarias} prioritarias, ${adjuntos.length} PDFs, ${fallos.length} descargas fallidas`);

  // Registro de novedades en CSV aparte (Plan B seguro: NO reescribe el Excel maestro,
  // asi no se dana el formato condicional ni los graficos). Va DESPUES del mail.
  try {
    const { registrarMovimientos } = await import("./lib/movimientos-log.mjs");
    const rc = await registrarMovimientos({ nuevos, guardados, esPrioritario });
    log(`Log MOVIMIENTOS (CSV): ${rc.agregadas} nueva(s), ${rc.duplicadas} ya cargada(s).${rc.archivo ? " Archivo: " + rc.archivo : ""}`);
  } catch (e) {
    log(`Log CSV de movimientos omitido: ${e.message}`);
  }

  // Lista de causas autogenerada desde el feed (numero, caratula, fuero, ult. mov.).
  try {
    const { registrarCausas } = await import("./lib/causas-log.mjs");
    const rl = await registrarCausas({ nuevos });
    log(`Lista de causas (CSV): ${rl.nuevas} nueva(s), ${rl.total} en total.${rl.archivo ? " Archivo: " + rl.archivo : ""}`);
  } catch (e) {
    log(`Lista de causas omitida: ${e.message}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error("ERROR:", e.message);
    await enviarAlertaFalla(e);
    process.exit(1);
  });
