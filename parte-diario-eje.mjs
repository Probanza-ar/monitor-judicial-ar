#!/usr/bin/env node
/**
 * parte-diario-eje.mjs - Parte diario de novedades de JusCABA (EJE) por email.
 *
 * Analogo al parte del Portal PJN, pero para la Justicia de la Ciudad de Buenos
 * Aires. Diferencias de fondo con el PJN:
 *
 *   - JusCABA es CONSULTA PUBLICA (sin login): no hay feed de "tus" novedades. El
 *     bot vigila las causas que figuran en cartera-eje.xlsx (descubiertas por nombre
 *     y depuradas por vos con la columna "Vigilar"). Ver lib/cartera-eje.mjs.
 *   - Por causa, baja las actuaciones y reporta solo las POSTERIORES a la ultima ya
 *     vista (diff contra movimientos-eje.csv). En la primera corrida de una causa
 *     establece la linea de base y solo reporta lo de la ventana reciente.
 *
 * Es un modulo INDEPENDIENTE: corre con su propia tarea programada y su propio mail.
 * Un colega que solo tenga causas en CABA usa solo esto; uno que tenga en ambos
 * corre los dos partes. Comparte el .env con el parte PJN (SMTP, feriados, ventana).
 *
 * Computa dos institutos, ambos ORIENTATIVOS (el abogado confirma y firma):
 *   - Caducidad de instancia CAyT (art. 216/122 Ley 189) -> lib/caducidad-eje.mjs.
 *   - Prescripcion de la accion penal (arts. 62-67 CP) para la cartera PCyF -> lib/
 *     prescripcion-penal-eje.mjs. Es una calculadora asistida: depende de datos que el
 *     abogado carga en la cartera (fecha del hecho, pena maxima, ultima interrupcion).
 *
 * Uso manual (prueba):  node parte-diario-eje.mjs
 * Config: comparte .env con el parte PJN + variables EJE_* (ver .env.eje.example).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";
import { buscarCausas, misCausas, listarActuaciones, actuacionesNuevas, parseDia, descargarPdf } from "./lib/eje-client.mjs";
import { hayCredenciales } from "./lib/eje-auth.mjs";
import { upsertCausas, leerVigiladas, volcarCalculos } from "./lib/cartera-eje.mjs";
import { estadoPrevio, registrarActuaciones } from "./lib/movimientos-eje.mjs";
import { calcularCaducidadEje, renderCaducidadEje } from "./lib/caducidad-eje.mjs";
import { calcularPrescripcionEje, renderPrescripcionEje } from "./lib/prescripcion-penal-eje.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── .env minimal (mismo formato que el parte PJN) ────────────────────────────
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
  smtpHost: process.env.SMTP_HOST || "smtp.gmail.com",
  smtpPort: Number(process.env.SMTP_PORT || 465),
  smtpUser: process.env.SMTP_USER || "",
  smtpPass: process.env.SMTP_PASS || "",
  mailFrom: process.env.MAIL_FROM || process.env.SMTP_USER || "",
  // Destinatario del parte CABA. Si no se define, cae en MAIL_TO (comparte con PJN).
  mailTo: process.env.MAIL_TO_EJE || process.env.MAIL_TO || "",
  mailToAlerta: process.env.MAIL_TO_ALERTA || process.env.MAIL_TO_EJE || process.env.MAIL_TO || "",
  criterios: (process.env.EJE_CRITERIOS || "").split(/[;|]/).map((s) => s.trim()).filter(Boolean),
  descubrir: (process.env.EJE_DESCUBRIR || "true") !== "false",
  descSize: Number(process.env.EJE_DESCUBRIR_SIZE || 30),
  dias: Number(process.env.DIAS || 1),
  modoVentana: (process.env.MODO_VENTANA || "habil").toLowerCase(),
  feriados: (process.env.FERIADOS || "").split(",").map((s) => s.trim()).filter(Boolean),
  enviarSinNovedades: (process.env.ENVIAR_SIN_NOVEDADES || "true") !== "false",
  maxExp: Number(process.env.EJE_MAX_EXP || 500),
  pausaMs: Number(process.env.EJE_PAUSA_MS || 250),
  // PDFs de las novedades: adjuntar al mail y/o guardar copia local por fecha (como el PJN).
  adjuntarPdfs: (process.env.EJE_ADJUNTAR_PDFS || "true") !== "false",
  guardarPdfs: (process.env.EJE_GUARDAR_PDFS_LOCAL || "true") !== "false",
  carpetaPdfs: process.env.EJE_CARPETA_PDFS || path.resolve(__dirname, "pdfs-eje"),
  maxPdfs: Number(process.env.EJE_MAX_PDFS || 20),
  alertaFalla: (process.env.ALERTA_FALLA || "true") !== "false",
  alertaLocalDir: process.env.ALERTA_LOCAL_DIR || __dirname,
};

// Feriados / feria (mismo esquema que el parte PJN: fechas sueltas o rangos a..b).
function expandirFeriados(lista) {
  const out = new Set();
  const addRango = (a, b) => { let cur = new Date(a + "T00:00:00Z"); const fin = new Date(b + "T00:00:00Z"); let g = 0; while (cur <= fin && g++ < 400) { out.add(cur.toISOString().slice(0, 10)); cur = new Date(cur.getTime() + 86400000); } };
  for (const raw of lista) {
    const s = String(raw).trim();
    const r = s.match(/^(\d{4}-\d{2}-\d{2})\s*\.\.\s*(\d{4}-\d{2}-\d{2})$/);
    if (r) { addRango(r[1], r[2]); continue; }
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) out.add(s);
  }
  return out;
}
(function cargarFeriados() {
  let lista = [...CFG.feriados];
  const p = path.resolve(__dirname, "feriados.json");
  if (fs.existsSync(p)) { try { const arr = JSON.parse(fs.readFileSync(p, "utf8")); if (Array.isArray(arr)) lista.push(...arr.map((s) => String(s).trim())); } catch {} }
  CFG.feriados = Array.from(expandirFeriados(lista));
})();

const AR_OFFSET_HORAS = 3;
const log = (...a) => console.log(new Date().toISOString(), ...a);
function hoyAR() {
  const p = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}
function arMidnightMs(y, m, d) { return Date.UTC(y, m - 1, d, AR_OFFSET_HORAS, 0, 0, 0); }
function esFechaHabil(dMid) { const dow = dMid.getUTCDay(); if (dow === 0 || dow === 6) return false; return !CFG.feriados.includes(dMid.toISOString().slice(0, 10)); }
function calcularCorteVentana() {
  if (CFG.modoVentana === "fijo") { const c = Date.now() - CFG.dias * 86400000; return { corte: c, desc: `ultimos ${CFG.dias} dia(s) [modo fijo]` }; }
  const [y, m, d] = hoyAR().split("-").map(Number);
  let cur = new Date(arMidnightMs(y, m, d));
  do { cur = new Date(cur.getTime() - 86400000); } while (!esFechaHabil(cur));
  const corte = cur.getTime();
  const dias = Math.round((arMidnightMs(y, m, d) - corte) / 86400000);
  return { corte, desc: `desde el ultimo dia habil (${cur.toISOString().slice(0, 10)} 00:00 AR, ${dias} dia[s] atras) [modo habil]` };
}

// ─── prioridad de actuaciones (CABA) ──────────────────────────────────────────
const RX_PRIORIDAD = new RegExp("\\b(" + [
  "traslad", "intim", "apercib", "caduc", "peren", "suspen", "reanud", "sentenc",
  "resuelv", "resolu", "hace lugar", "rechaz", "deniega", "desestim", "audiencia",
  "vista", "notif", "cedula", "plazo", "vencimiento", "apel", "recurs", "queja",
  "nulidad", "revoc", "aclarator", "regulac", "honorar", "oficio", "demanda",
  "contest", "excepc", "prescrip", "prueb", "pericia", "aleg", "ejecut", "sentencia de trance",
  "embarg", "inhib", "cautelar", "medida", "intimacion de pago", "mandamiento",
  "liquidac", "multa", "astreinte", "sancion", "amparo",
].join("|") + ")\\w*", "i");

function esPrioritaria(a) { return a.esCedula || RX_PRIORIDAD.test(`${a.codigo} ${a.titulo}`); }
function motivoPrioridad(a) { if (a.esCedula) return "cedula"; const m = `${a.codigo} ${a.titulo}`.match(RX_PRIORIDAD); return m ? m[0].toLowerCase() : ""; }
const RX_NEGATIVA = /\bno\s+ha\s+lugar|\brechaz\w*|\bdeniega\w*|\bdesestim\w*/i;

// ─── email ────────────────────────────────────────────────────────────────────
function crearTransport() {
  return nodemailer.createTransport({
    host: CFG.smtpHost, port: CFG.smtpPort, secure: CFG.smtpPort === 465,
    auth: { user: CFG.smtpUser, pass: CFG.smtpPass },
    connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 30000,
  });
}

// ─── armado del parte ───────────────────────────────────────────────────────────
// novedades: [{ causa:{cuij,caratula,expId,estado}, act:{...} }]
function armarParte(novedades, ventanaDesc, vigiladas, fallos, caducidad, prescripcion) {
  const porExp = new Map();
  for (const n of novedades) {
    const k = n.causa.cuij || `exp:${n.causa.expId}`;
    if (!porExp.has(k)) porExp.set(k, { causa: n.causa, acts: [] });
    porExp.get(k).acts.push(n.act);
  }
  const prioritarias = novedades.filter((n) => esPrioritaria(n.act));
  const fecha = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "full" }).format(new Date());

  let texto = `Parte diario JusCABA (EJE) - ${fecha}\nVentana: ${ventanaDesc}. ${novedades.length} novedad(es) en ${porExp.size} causa(s). Vigiladas: ${vigiladas}.\n\n`;
  let html = `<h2>Parte diario JusCABA (EJE)</h2><p><b>${fecha}</b><br>Ventana: ${ventanaDesc}. ${novedades.length} novedad(es) en ${porExp.size} causa(s). Causas vigiladas: ${vigiladas}.</p>`;

  if (prioritarias.length) {
    texto += `>>> PRIORITARIAS (${prioritarias.length}) - revisar primero <<<\n`;
    html += `<div style="border:2px solid #1e3a8b;border-radius:4px;padding:8px 10px;margin:10px 0"><b style="color:#1e3a8b">PRIORITARIAS (${prioritarias.length}) - revisar primero</b><ul style="margin:6px 0">`;
    for (const n of prioritarias) {
      const mot = motivoPrioridad(n.act);
      const neg = RX_NEGATIVA.test(`${n.act.codigo} ${n.act.titulo}`) ? " - posible resol. negativa" : "";
      texto += `  [!] ${n.causa.cuij || n.causa.expId} - ${n.causa.caratula} - ${n.act.titulo} (${n.act.fechaFirma}) [${mot}${neg}]\n`;
      html += `<li><b>${n.causa.cuij || n.causa.expId}</b> - ${n.causa.caratula}<br>${n.act.titulo} <span style="color:#1e3a8b">(${n.act.fechaFirma} - ${mot})</span>${neg ? `<span style="color:#b58900"> - posible resol. negativa</span>` : ""}</li>`;
    }
    texto += "\n"; html += "</ul></div>";
  }

  // Caducidad de instancia CAyT (viene precalculada desde main).
  if (caducidad && caducidad.texto) { texto += caducidad.texto + "\n"; html += caducidad.html; }
  // Prescripcion de la accion penal (cartera PCyF).
  if (prescripcion && prescripcion.texto) { texto += prescripcion.texto + "\n"; html += prescripcion.html; }

  if (fallos && fallos.length) {
    // Si fallo casi todo, puede ser una caida general del EJE. NO se declara inhabil
    // automatico (podria ser la red propia): se avisa para que el letrado confirme.
    // Las privadas (1004) fallan siempre: no cuentan para la sospecha de caida general.
    const fallosReales = fallos.filter((f) => !f.privado).length;
    const posibleCaida = fallosReales >= Math.max(3, Math.ceil(vigiladas * 0.5));
    texto += `>>> CAUSAS QUE NO SE PUDIERON CONSULTAR (${fallos.length}) - revisar a mano <<<\n`;
    for (const f of fallos) texto += `  [x] ${f.ref}: ${f.motivo}\n`;
    if (posibleCaida) texto += `  POSIBLE CAIDA GENERAL DEL EJE hoy. Si el TSJ declara el dia inhabil, cargar la fecha en feria-caba.json (inhabilesExcepcionales) para que la caducidad la descuente.\n`;
    texto += "\n";
    html += `<div style="border:1px solid #b58900;border-radius:4px;padding:6px 10px;margin:10px 0;background:#fdf6e3"><b style="color:#b58900">No se pudieron consultar (${fallos.length})</b>${posibleCaida ? ` &mdash; <b>posible caida general del EJE</b>: si el TSJ declara el dia inhabil, cargarlo en feria-caba.json (inhabilesExcepcionales)` : ""}<ul style="margin:6px 0">`;
    for (const f of fallos) html += `<li>${f.ref}: ${f.motivo}</li>`;
    html += "</ul></div>";
  }

  for (const [, { causa, acts }] of porExp) {
    texto += `== ${causa.cuij || "s/CUIJ"} (exp ${causa.expId}) ==\n${causa.caratula}${causa.estado ? " [" + causa.estado + "]" : ""}\n`;
    html += `<h3 style="margin:12px 0 2px">${causa.cuij || "s/CUIJ"} <span style="opacity:.7;font-size:13px">(exp ${causa.expId})</span></h3><div style="color:#555">${causa.caratula}${causa.estado ? ` <b>[${causa.estado}]</b>` : ""}</div><ul>`;
    for (const a of acts) {
      const prio = esPrioritaria(a) ? " [PRIORITARIA]" : "";
      const pdf = a._tienePdf ? "  [PDF adjunto]" : "";
      texto += `  - ${a.fechaFirma} [${a.codigo}] ${a.titulo}${prio}${pdf}${a.firmantes ? " - " + a.firmantes : ""}\n`;
      html += `<li><b>${a.fechaFirma}</b> [${a.codigo}] ${a.titulo}${prio ? ` <span style="color:#1e3a8b">[PRIORITARIA]</span>` : ""}${a._tienePdf ? ` &mdash; <span style="color:#1e7d32">PDF adjunto</span>` : ""}${a.firmantes ? `<br><span style="color:#777;font-size:12px">${a.firmantes}</span>` : ""}</li>`;
    }
    texto += "\n"; html += "</ul>";
  }
  html += `<hr><p style="color:#888;font-size:12px">Generado automaticamente desde la consulta publica de JusCABA. La deteccion de PRIORITARIAS y el computo de caducidad/prescripcion son orientativos y no reemplazan la lectura de la actuacion ni el criterio del abogado. Verificar en el EJE antes de actuar.</p>`;
  return { texto, html, causas: porExp.size, prioritarias: prioritarias.length, caducidadRevision: (caducidad && caducidad.revision) || 0, prescripcionAlerta: (prescripcion && prescripcion.alerta) || 0 };
}

async function enviar({ texto, html }, novedades, causas, prioritarias, caducidadRevision = 0, prescripcionAlerta = 0, adjuntos = []) {
  const t = crearTransport();
  const fechaCorta = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short" }).format(new Date());
  const prefijo = (prescripcionAlerta ? `[PRESCRIPCION x${prescripcionAlerta}] ` : "") + (caducidadRevision ? `[REVISION CADUCIDAD x${caducidadRevision}] ` : "") + (prioritarias ? `[${prioritarias} PRIORITARIA(S)] ` : "");
  const asunto = `${prefijo}Parte JusCABA ${fechaCorta} - ${novedades} novedad(es) / ${causas} causa(s)`;
  log("Conectando al servidor de correo...");
  await t.sendMail({ from: CFG.mailFrom, to: CFG.mailTo, subject: asunto, text: texto, html, attachments: adjuntos });
  log(`Email enviado a ${CFG.mailTo} (${adjuntos.length} adjunto/s)`);
}

function alertaLocal(err, motivoMailFallo) {
  const fecha = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short", timeStyle: "short" }).format(new Date());
  const contenido = [
    `ALERTA CRITICA - Parte diario JusCABA (EJE)`, `============================================`, ``,
    `La corrida FALLO y ademas NO se pudo enviar el mail de aviso.`,
    `Revisar el EJE (eje.juscaba.gob.ar) A MANO hoy. No asumir que no hay novedades.`, ``,
    `Fecha/hora: ${fecha}`,
    `Error: ${err && err.message ? err.message : String(err)}`,
    `Motivo por el que no salio el mail: ${motivoMailFallo || "n/d"}`,
  ].join("\n");
  try { fs.writeFileSync(path.join(CFG.alertaLocalDir, "ALERTA_CRITICA_EJE.txt"), contenido + "\n"); log("Fallback local escrito."); } catch (e) { log(`No se pudo escribir el fallback local: ${e.message}`); }
  try { for (let i = 0; i < 5; i++) process.stdout.write("\x07"); } catch {}
}

async function enviarAlertaFalla(err) {
  if (!CFG.alertaFalla) return;
  if (!CFG.smtpUser || !CFG.smtpPass || !CFG.mailToAlerta) { alertaLocal(err, "faltan datos SMTP/MAIL_TO"); return; }
  try {
    const t = crearTransport();
    const fecha = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short", timeStyle: "short" }).format(new Date());
    await t.sendMail({
      from: CFG.mailFrom, to: CFG.mailToAlerta,
      subject: `[FALLA] Parte JusCABA ${fecha} - la corrida NO se completo`,
      text: [`El parte diario de JusCABA (EJE) NO se genero.`, ``, `Fecha/hora: ${fecha}`, `Error: ${err && err.message ? err.message : String(err)}`, ``, `Accion: entrar al EJE a mano y revisar. Causas posibles: API caida, cambio de endpoint (ver .eje-endpoints.json / descubrir-eje.mjs), o corte de red.`].join("\n"),
    });
    log(`Alerta de falla enviada a ${CFG.mailToAlerta}`);
  } catch (e2) { alertaLocal(err, `fallo el envio del mail: ${e2.message}`); }
}

function registrarCorrida(resumen) {
  try { fs.appendFileSync(path.resolve(__dirname, "ultima-corrida-eje.log"), `${new Date().toISOString()} | OK | ${resumen}\n`); } catch {}
  try { const a = path.join(CFG.alertaLocalDir, "ALERTA_CRITICA_EJE.txt"); if (fs.existsSync(a)) fs.unlinkSync(a); } catch {}
}

// ─── main ─────────────────────────────────────────────────────────────────────
async function main() {
  for (const [k, v] of Object.entries({ SMTP_USER: CFG.smtpUser, SMTP_PASS: CFG.smtpPass, MAIL_TO: CFG.mailTo })) {
    if (!v) throw new Error(`Falta ${k} en .env`);
  }

  // 1) Siembra de cartera-eje.xlsx.
  if (hayCredenciales()) {
    // Modo AUTENTICADO: cartera EXACTA del letrado (Mis Causas), incluidas reservadas.
    // No hay homonimos que depurar: son las causas donde figuras como parte/letrado.
    try {
      const r = await misCausas({ size: 50, pausaMs: CFG.pausaMs });
      const up = await upsertCausas({ causas: r.causas });
      log(`Mis Causas (autenticado): ${r.causas.length} causa(s); cartera ${up.nuevas} nueva(s), ${up.total} total.`);
    } catch (e) { log(`Mis Causas fallo: ${e.message}`); }
  } else if (CFG.descubrir && CFG.criterios.length) {
    // Modo PUBLICO (sin credenciales): descubrimiento hibrido por nombre/criterio.
    for (const criterio of CFG.criterios) {
      try {
        // Paginacion exhaustiva hasta vaciar el indice (que no queden causas afuera).
        let page = 0, total = Infinity, acumuladas = [];
        while (acumuladas.length < total && page < 500) {
          const r = await buscarCausas(criterio, { page, size: CFG.descSize });
          total = Number(r.total ?? acumuladas.length);
          acumuladas.push(...r.causas);
          if (r.causas.length < CFG.descSize) break;
          page++; await sleep(CFG.pausaMs);
        }
        const up = await upsertCausas({ causas: acumuladas });
        log(`Descubrimiento "${criterio}": ${acumuladas.length} causa(s); cartera ${up.nuevas} nueva(s), ${up.total} total.`);
      } catch (e) { log(`Descubrimiento "${criterio}" fallo: ${e.message}`); }
    }
  } else {
    log("Siembra omitida (sin credenciales ni EJE_CRITERIOS). Se vigila lo que ya este en cartera-eje.xlsx.");
  }

  // 2) Causas a vigilar.
  const { causas: vigiladas, nota } = await leerVigiladas();
  if (nota) log(`Cartera EJE: ${nota}`);
  log(`Causas vigiladas: ${vigiladas.length}`);
  if (!vigiladas.length) {
    log("No hay causas vigiladas. Sembrar con descubrir-eje.mjs o cargar CUIJ/ExpId en cartera-eje.xlsx.");
    if (CFG.enviarSinNovedades) { await enviar(armarParte([], "sin causas vigiladas", 0, []), 0, 0, 0); }
    registrarCorrida("0 vigiladas");
    return;
  }

  // 3) Diff de actuaciones por causa.
  const { corte: corteVentana, desc } = calcularCorteVentana();
  const prev = estadoPrevio();
  const novedades = [];   // { causa, act }
  const paraRegistrar = []; // filas del CSV
  const fallos = [];      // { ref, motivo }

  const lote = vigiladas.slice(0, CFG.maxExp);
  for (const c of lote) {
    try {
      const lastSeen = prev.get(String(c.expId));
      let acts = [];
      let baseline = [];
      if (lastSeen) {
        acts = await actuacionesNuevas(c.expId, lastSeen, { maxPaginas: 5, size: 20 });
      } else {
        // Primera vez: linea de base. Solo se reporta lo de la ventana reciente,
        // pero se registran TODAS las de la primera pagina para no repetir despues.
        const r = await listarActuaciones(c.expId, { page: 0, size: 20 });
        baseline = r.actuaciones;
        acts = baseline.filter((a) => { const f = parseDia(a.fechaFirma || a.fechaPublicacion); return f && f.getTime() >= corteVentana; });
      }
      for (const a of acts) novedades.push({ causa: c, act: a });
      // Registrar en CSV: lo reportado + la linea de base (dedup por actId adentro).
      for (const a of [...acts, ...baseline]) {
        paraRegistrar.push({
          actId: a.actId, fecha: a.fechaFirma || a.fechaPublicacion, cuij: c.cuij, expId: c.expId,
          codigo: a.codigo, titulo: a.titulo, prioritaria: esPrioritaria(a), firmantes: a.firmantes,
        });
      }
    } catch (e) {
      // Privadas (code 1004): fallan SIEMPRE por consulta publica; se marcan aparte
      // para no disparar la heuristica de caida general del EJE.
      fallos.push({ ref: `${c.cuij || c.expId}`, motivo: e.privado ? "privado/reservado (1004): sin actuaciones por consulta publica; si es ajena, Vigilar=NO" : e.message, privado: !!e.privado });
      log(`Causa ${c.cuij || c.expId} fallo: ${e.message}`);
    }
    await sleep(CFG.pausaMs);
  }

  log(`Novedades en la ventana: ${novedades.length} (en ${new Set(novedades.map((n) => n.causa.expId)).size} causa[s]); ${fallos.length} causa(s) con error.`);

  if (novedades.length === 0 && !fallos.length && !CFG.enviarSinNovedades) {
    log("Sin novedades y ENVIAR_SIN_NOVEDADES=false: no se envia correo.");
    await registrarActuaciones(paraRegistrar);
    registrarCorrida("0 novedades, sin envio");
    return;
  }

  // 3b) PDFs de las novedades: adjuntar al mail + guardar copia local por fecha.
  const adjuntos = [];
  if ((CFG.adjuntarPdfs || CFG.guardarPdfs) && novedades.length) {
    let dir = null;
    if (CFG.guardarPdfs) { dir = path.join(CFG.carpetaPdfs, hoyAR()); try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { log(`No se pudo crear carpeta de PDFs: ${e.message}`); dir = null; } }
    let guardados = 0, sinDoc = 0;
    for (const n of novedades) {
      if (!CFG.guardarPdfs && adjuntos.length >= CFG.maxPdfs) break; // ya no hace falta bajar mas
      const a = n.act;
      let res;
      try { res = await descargarPdf({ actId: a.actId, expId: n.causa.expId, esNota: a.esNota }); }
      catch (e) { res = { ok: false, motivo: e.message }; }
      if (!res.ok) { sinDoc++; continue; } // mero tramite sin PDF o error puntual: se saltea
      a._tienePdf = true;
      const nombre = `${(n.causa.cuij || "exp" + n.causa.expId).replace(/[^\w.-]+/g, "_")}_${a.actId}.pdf`;
      if (dir) { try { fs.writeFileSync(path.join(dir, nombre), res.buf); guardados++; } catch (e) { log(`No se pudo guardar ${nombre}: ${e.message}`); } }
      if (CFG.adjuntarPdfs && adjuntos.length < CFG.maxPdfs) adjuntos.push({ filename: nombre, content: res.buf });
      await sleep(CFG.pausaMs);
    }
    log(`PDFs EJE: ${guardados} guardado(s)${dir ? " en " + dir : ""}, ${adjuntos.length} adjuntado(s), ${sinDoc} sin documento/error.`);
  }

  // Caducidad de instancia CAyT (lee cartera-eje.xlsx; independiente de las novedades).
  let caducidadRender = null, caducidadTodas = [], prescripcionTodas = [];
  try {
    const cad = await calcularCaducidadEje();
    if (cad.nota) log(`Caducidad EJE: ${cad.nota}`);
    else if (cad.items.length) log(`Caducidad EJE: ${cad.items.length} causa(s) en zona/riesgo; ${cad.sinImpulso || 0} sin impulso verificado`);
    caducidadTodas = cad.todas || [];
    caducidadRender = renderCaducidadEje(cad);
  } catch (e) { log(`Caducidad EJE omitida: ${e.message}`); }

  // Prescripcion de la accion penal (arts. 62-67 CP; lee cartera-eje.xlsx). Para la
  // cartera penal (PCyF), donde la caducidad de instancia no aplica.
  let prescripcionRender = null;
  try {
    // Buscador de actuaciones para que el modulo detecte solo la ultima interrupcion (art. 67).
    const fetchActs = async (expId) => {
      const all = [];
      for (let p = 0; p < 10; p++) {
        const r = await listarActuaciones(expId, { page: p, size: 50 });
        if (!r.actuaciones.length) break;
        all.push(...r.actuaciones);
        if (r.actuaciones.length < 50) break;
        await sleep(CFG.pausaMs);
      }
      return all;
    };
    const pre = await calcularPrescripcionEje({ fetchActuaciones: fetchActs });
    if (pre.nota) log(`Prescripcion penal: ${pre.nota}`);
    else if (pre.items.length) log(`Prescripcion penal: ${pre.items.length} causa(s) en zona/riesgo; ${pre.sinDatos || 0} sin datos completos`);
    prescripcionTodas = pre.todas || [];
    prescripcionRender = renderPrescripcionEje(pre);
  } catch (e) { log(`Prescripcion penal omitida: ${e.message}`); }

  // Volcar los plazos calculados (caducidad + prescripcion) a cartera-eje.xlsx, para que
  // cada causa muestre en su fila el vencimiento, los dias restantes y la alerta.
  try {
    const vc = await volcarCalculos({ caducidad: caducidadTodas, prescripcion: prescripcionTodas });
    if (vc.nota) log(`Plazos en cartera EJE: ${vc.nota}`);
    else log(`Plazos volcados a cartera-eje: ${vc.escritas} fila(s) con computo.`);
  } catch (e) { log(`Volcado de plazos EJE omitido: ${e.message}`); }

  const parte = armarParte(novedades, desc, vigiladas.length, fallos, caducidadRender, prescripcionRender);
  await enviar(parte, novedades.length, parte.causas, parte.prioritarias, parte.caducidadRevision, parte.prescripcionAlerta, adjuntos);

  // Registrar despues del mail (si el mail falla, no marcamos como visto y se reintenta).
  const rc = await registrarActuaciones(paraRegistrar);
  log(`Log MOVIMIENTOS EJE (CSV): ${rc.agregadas} nueva(s), ${rc.duplicadas} ya cargada(s).`);
  registrarCorrida(`${novedades.length} novedades, ${parte.prioritarias} prioritarias, ${fallos.length} errores`);
}

main().then(() => process.exit(0)).catch(async (e) => {
  console.error("ERROR:", e.message);
  await enviarAlertaFalla(e);
  process.exit(1);
});
