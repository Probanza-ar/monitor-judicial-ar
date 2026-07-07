#!/usr/bin/env node
/**
 * parte-diario-mev.mjs - Parte diario de novedades de la MEV (SCBA, Provincia
 * de Buenos Aires) por email. Tercer frente del sistema (PJN / EJE / MEV).
 *
 * Diferencias de fondo con los otros dos:
 *   - La MEV REQUIERE login siempre (no hay consulta anonima) y es ASP clasico:
 *     el cliente postea formularios y parsea HTML (lib/mev-client.mjs).
 *   - La "cartera" natural son los SETS del portal: el set automatico "Lista de
 *     Causas con AUTORIZACION" (causas reservadas ya autorizadas: penal/familia)
 *     y los sets que armes a mano en "Organizar Mis Sets". El bot los recorre
 *     por cada jurisdiccion configurada (MEV_JURISDICCIONES) y siembra
 *     cartera-mev.xlsx. La columna "Vigilar" depura igual que en el EJE.
 *   - La jurisdiccion (depto judicial + fuero) es estado de SESION del portal:
 *     el bot la re-postea por cada grupo de causas.
 *
 * Plazos: caducidad de instancia PBA (art. 310/315 CPCC BA, bifasica con
 * intimacion de 5 dias habiles) -> lib/caducidad-mev.mjs. Excluye penal y
 * laboral automaticamente. La prescripcion penal PBA es un frente PENDIENTE
 * (el nucleo comun esta en lib/penal-base.mjs).
 *
 * Es un modulo INDEPENDIENTE: mail y tarea propios; comparte .env (SMTP,
 * feriados, ventana). Uso manual (prueba):  node parte-diario-mev.mjs
 * Config: ver .env.mev.example. Verificar siempre en la MEV antes de computar
 * plazos: la firma es del abogado.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";
import { entrarJurisdiccion, causasDeSet, pasosNuevos, parseDia, PAUSA } from "./lib/mev-client.mjs";
import { hayCredenciales } from "./lib/mev-auth.mjs";
import { upsertCausas, leerVigiladas } from "./lib/cartera-mev.mjs";
import { estadoPrevio, registrarPasos } from "./lib/movimientos-mev.mjs";
import { calcularCaducidadMev, renderCaducidadMev } from "./lib/caducidad-mev.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── .env minimal (mismo formato que los otros partes) ────────────────────────
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
  mailTo: process.env.MAIL_TO_MEV || process.env.MAIL_TO || "",
  mailToAlerta: process.env.MAIL_TO_ALERTA || process.env.MAIL_TO_MEV || process.env.MAIL_TO || "",
  jurisdicciones: (process.env.MEV_JURISDICCIONES || "").split(";").map((s) => s.trim()).filter(Boolean),
  dias: Number(process.env.DIAS || 1),
  modoVentana: (process.env.MODO_VENTANA || "habil").toLowerCase(),
  feriados: (process.env.FERIADOS || "").split(",").map((s) => s.trim()).filter(Boolean),
  enviarSinNovedades: (process.env.ENVIAR_SIN_NOVEDADES || "true") !== "false",
  maxExp: Number(process.env.MEV_MAX_EXP || 300),
  pausaMs: Number(process.env.MEV_PAUSA_MS || PAUSA),
  alertaFalla: (process.env.ALERTA_FALLA || "true") !== "false",
  alertaLocalDir: process.env.ALERTA_LOCAL_DIR || __dirname,
};

// "Moron:penal;San Isidro" -> [{clave, depto, penal, familia}]
function parseJurisdicciones(lista) {
  return lista.map((s) => {
    const partes = s.split(":").map((x) => x.trim()).filter(Boolean);
    const depto = partes[0];
    const flags = partes.slice(1).map((x) => x.toLowerCase());
    return { clave: s, depto, penal: flags.includes("penal"), familia: flags.includes("familia") };
  });
}
const JURS = parseJurisdicciones(CFG.jurisdicciones);

// Feriados nacionales + .env (mismo esquema que los otros partes).
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

// ─── prioridad de pasos (PBA, todos los fueros) ───────────────────────────────
const RX_PRIORIDAD = new RegExp("\\b(" + [
  "traslad", "intim", "apercib", "caduc", "peren", "suspen", "reanud", "sentenc",
  "resuelv", "resolu", "hace lugar", "rechaz", "deniega", "desestim", "audiencia",
  "vista", "notif", "cedula", "plazo", "vencimiento", "apel", "recurs", "queja",
  "nulidad", "revoc", "aclarator", "regulac", "honorar", "oficio", "demanda",
  "contest", "excepc", "prescrip", "prueb", "pericia", "aleg", "ejecut", "subast",
  "embarg", "inhib", "cautelar", "medida", "mandamiento", "liquidac", "multa",
  "astreinte", "sancion", "amparo", "veredicto", "elevacion", "requerimiento",
  "indagatoria", "procesamiento", "sobresei", "condena", "absol", "excarcel",
  "prision", "declaracion de puro derecho", "autos para sentencia",
].join("|") + ")\\w*", "i");
const esPrioritario = (p) => RX_PRIORIDAD.test(p.descripcion || "");
const motivoPrioridad = (p) => { const m = (p.descripcion || "").match(RX_PRIORIDAD); return m ? m[0].toLowerCase() : ""; };
const RX_NEGATIVA = /\bno\s+ha\s+lugar|\brechaz\w*|\bdeniega\w*|\bdesestim\w*/i;

// ─── email / alertas ──────────────────────────────────────────────────────────
function crearTransport() {
  return nodemailer.createTransport({
    host: CFG.smtpHost, port: CFG.smtpPort, secure: CFG.smtpPort === 465,
    auth: { user: CFG.smtpUser, pass: CFG.smtpPass },
    connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 30000,
  });
}

function armarParte(novedades, ventanaDesc, vigiladas, fallos, caducidad) {
  const porCausa = new Map();
  for (const n of novedades) {
    const k = n.causa.key;
    if (!porCausa.has(k)) porCausa.set(k, { causa: n.causa, pasos: [] });
    porCausa.get(k).pasos.push(n.paso);
  }
  const prioritarias = novedades.filter((n) => esPrioritario(n.paso));
  const fecha = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "full" }).format(new Date());

  let texto = `Parte diario MEV - SCBA (Provincia de Buenos Aires) - ${fecha}\nVentana: ${ventanaDesc}. ${novedades.length} novedad(es) en ${porCausa.size} causa(s). Vigiladas: ${vigiladas}.\n\n`;
  let html = `<h2>Parte diario MEV - SCBA (Provincia de Buenos Aires)</h2><p><b>${fecha}</b><br>Ventana: ${ventanaDesc}. ${novedades.length} novedad(es) en ${porCausa.size} causa(s). Causas vigiladas: ${vigiladas}.</p>`;

  if (prioritarias.length) {
    texto += `>>> PRIORITARIAS (${prioritarias.length}) - revisar primero <<<\n`;
    html += `<div style="border:2px solid #1e3a8b;border-radius:4px;padding:8px 10px;margin:10px 0"><b style="color:#1e3a8b">PRIORITARIAS (${prioritarias.length}) - revisar primero</b><ul style="margin:6px 0">`;
    for (const n of prioritarias) {
      const mot = motivoPrioridad(n.paso);
      const neg = RX_NEGATIVA.test(n.paso.descripcion || "") ? " - posible resol. negativa" : "";
      texto += `  [!] ${n.causa.expedienteRef} - ${n.causa.caratula} - ${n.paso.descripcion} (${n.paso.fechaHora || n.paso.fecha}) [${mot}${neg}]\n`;
      html += `<li><b>${n.causa.expedienteRef}</b> - ${n.causa.caratula}<br>${n.paso.descripcion} <span style="color:#1e3a8b">(${n.paso.fechaHora || n.paso.fecha} - ${mot})</span>${neg ? `<span style="color:#b58900"> - posible resol. negativa</span>` : ""}</li>`;
    }
    texto += "\n"; html += "</ul></div>";
  }

  if (caducidad && caducidad.texto) { texto += caducidad.texto + "\n"; html += caducidad.html; }

  if (fallos && fallos.length) {
    const posibleCaida = fallos.length >= Math.max(3, Math.ceil(vigiladas * 0.5));
    texto += `>>> CAUSAS QUE NO SE PUDIERON CONSULTAR (${fallos.length}) - revisar a mano <<<\n`;
    for (const f of fallos) texto += `  [x] ${f.ref}: ${f.motivo}\n`;
    if (posibleCaida) texto += `  POSIBLE CAIDA GENERAL DE LA MEV hoy (o clave vencida: la MEV fuerza cambio cada 90 dias). Si la SCBA declara el dia inhabil, cargar la fecha en feria-pba.json (inhabilesExcepcionales).\n`;
    texto += "\n";
    html += `<div style="border:1px solid #b58900;border-radius:4px;padding:6px 10px;margin:10px 0;background:#fdf6e3"><b style="color:#b58900">No se pudieron consultar (${fallos.length})</b>${posibleCaida ? ` &mdash; <b>posible caida general de la MEV</b> (o clave vencida, cambio forzado cada 90 dias). Si la SCBA declara inhabil, cargarlo en feria-pba.json` : ""}<ul style="margin:6px 0">`;
    for (const f of fallos) html += `<li>${f.ref}: ${f.motivo}</li>`;
    html += "</ul></div>";
  }

  for (const [, { causa, pasos }] of porCausa) {
    texto += `== ${causa.expedienteRef} (${causa.jurisdiccion || "s/jur"}) ==\n${causa.caratula}${causa.estado ? " [" + causa.estado + "]" : ""}\n`;
    html += `<h3 style="margin:12px 0 2px">${causa.expedienteRef} <span style="opacity:.7;font-size:13px">(${causa.jurisdiccion || "s/jur"})</span></h3><div style="color:#555">${causa.caratula}${causa.estado ? ` <b>[${causa.estado}]</b>` : ""}${causa.organismo ? `<br><span style="font-size:12px">${causa.organismo}</span>` : ""}</div><ul>`;
    for (const p of pasos) {
      const prio = esPrioritario(p) ? " [PRIORITARIA]" : "";
      const firm = p.firmado ? " (firmado)" : "";
      texto += `  - ${p.fechaHora || p.fecha} ${p.descripcion}${prio}${firm}\n`;
      html += `<li><b>${p.fechaHora || p.fecha}</b> ${p.descripcion}${prio ? ` <span style="color:#1e3a8b">[PRIORITARIA]</span>` : ""}${firm}</li>`;
    }
    texto += "\n"; html += "</ul>";
  }
  html += `<hr><p style="color:#888;font-size:12px">Generado automaticamente desde la MEV (mev.scba.gov.ar). Los datos de la MEV son de caracter referencial (asi lo aclara la propia SCBA). La deteccion de PRIORITARIAS y el computo de caducidad son orientativos y no reemplazan la lectura de la actuacion ni el criterio del abogado. Verificar en la MEV antes de actuar.</p>`;
  return { texto, html, causas: porCausa.size, prioritarias: prioritarias.length, caducidadRevision: (caducidad && caducidad.revision) || 0 };
}

async function enviar({ texto, html }, novedades, causas, prioritarias, caducidadRevision = 0) {
  const t = crearTransport();
  const fechaCorta = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short" }).format(new Date());
  const prefijo = (caducidadRevision ? `[REVISION CADUCIDAD x${caducidadRevision}] ` : "") + (prioritarias ? `[${prioritarias} PRIORITARIA(S)] ` : "");
  const asunto = `${prefijo}Parte MEV ${fechaCorta} - ${novedades} novedad(es) / ${causas} causa(s)`;
  log("Conectando al servidor de correo...");
  await t.sendMail({ from: CFG.mailFrom, to: CFG.mailTo, subject: asunto, text: texto, html });
  log(`Email enviado a ${CFG.mailTo}`);
}

function alertaLocal(err, motivoMailFallo) {
  const fecha = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short", timeStyle: "short" }).format(new Date());
  const contenido = [
    `ALERTA CRITICA - Parte diario MEV (SCBA)`, `=========================================`, ``,
    `La corrida FALLO y ademas NO se pudo enviar el mail de aviso.`,
    `Revisar la MEV (mev.scba.gov.ar) A MANO hoy. No asumir que no hay novedades.`, ``,
    `Fecha/hora: ${fecha}`,
    `Error: ${err && err.message ? err.message : String(err)}`,
    `Motivo por el que no salio el mail: ${motivoMailFallo || "n/d"}`,
  ].join("\n");
  try { fs.writeFileSync(path.join(CFG.alertaLocalDir, "ALERTA_CRITICA_MEV.txt"), contenido + "\n"); log("Fallback local escrito."); } catch (e) { log(`No se pudo escribir el fallback local: ${e.message}`); }
  try { for (let i = 0; i < 5; i++) process.stdout.write("\x07"); } catch {}
}

async function enviarAlertaFalla(err) {
  if (!CFG.alertaFalla) return;
  if (!CFG.smtpUser || !CFG.smtpPass || !CFG.mailToAlerta) { alertaLocal(err, "faltan datos SMTP/MAIL_TO"); return; }
  try {
    const t = crearTransport();
    const fecha = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short", timeStyle: "short" }).format(new Date());
    const extra = err && err.claveVencida ? " CLAVE MEV VENCIDA: renovarla a mano en mev.scba.gov.ar (la MEV fuerza cambio cada 90 dias)." : "";
    await t.sendMail({
      from: CFG.mailFrom, to: CFG.mailToAlerta,
      subject: `[FALLA] Parte MEV ${fecha} - la corrida NO se completo`,
      text: [`El parte diario de la MEV (SCBA) NO se genero.`, ``, `Fecha/hora: ${fecha}`, `Error: ${err && err.message ? err.message : String(err)}`, ``, `Accion: entrar a mev.scba.gov.ar a mano y revisar.${extra}`, `Causas posibles: MEV caida, clave vencida (cambio forzado cada 90 dias), cambio del HTML del portal, o corte de red.`].join("\n"),
    });
    log(`Alerta de falla enviada a ${CFG.mailToAlerta}`);
  } catch (e2) { alertaLocal(err, `fallo el envio del mail: ${e2.message}`); }
}

function registrarCorrida(resumen) {
  try { fs.appendFileSync(path.resolve(__dirname, "ultima-corrida-mev.log"), `${new Date().toISOString()} | OK | ${resumen}\n`); } catch {}
  try { const a = path.join(CFG.alertaLocalDir, "ALERTA_CRITICA_MEV.txt"); if (fs.existsSync(a)) fs.unlinkSync(a); } catch {}
}

// ─── main ─────────────────────────────────────────────────────────────────────
async function main() {
  for (const [k, v] of Object.entries({ SMTP_USER: CFG.smtpUser, SMTP_PASS: CFG.smtpPass, MAIL_TO: CFG.mailTo })) {
    if (!v) throw new Error(`Falta ${k} en .env`);
  }
  if (!hayCredenciales()) throw new Error("Faltan MEV_USUARIO/MEV_CLAVE en .env (la MEV no tiene consulta anonima)");
  if (!JURS.length) throw new Error("Falta MEV_JURISDICCIONES en .env (ej: Moron:penal;San Isidro)");

  // 1) Siembra: por cada jurisdiccion, recorrer TODOS los sets (incluye el set
  //    automatico "Lista de Causas con AUTORIZACION") y volcar a cartera-mev.xlsx.
  const orgPorJuz = new Map(); // pidJuzgado -> nombre de organismo (para la cartera)
  for (const jur of JURS) {
    try {
      const { organismos, sets } = await entrarJurisdiccion(jur);
      for (const o of organismos) orgPorJuz.set(o.valor.trim(), o.nombre);
      log(`Jurisdiccion "${jur.clave}": ${organismos.length} organismo(s), ${sets.length} set(s).`);
      for (const set of sets) {
        await sleep(CFG.pausaMs);
        const r = await causasDeSet(jur, set.nidset);
        if (r.sinResultados) { log(`  Set "${set.nombre}": sin causas en esta jurisdiccion.`); continue; }
        const causas = r.causas.map((c) => ({
          ...c, jurisdiccion: jur.clave,
          organismo: orgPorJuz.get(String(c.pidJuzgado).trim()) || "",
        }));
        const up = await upsertCausas({ causas });
        log(`  Set "${set.nombre}": ${causas.length} causa(s); cartera ${up.nuevas || 0} nueva(s), ${up.total || 0} total.`);
      }
    } catch (e) { log(`Jurisdiccion "${jur.clave}" fallo en siembra: ${e.message}`); }
  }

  // 2) Causas a vigilar.
  const { causas: vigiladas, nota } = await leerVigiladas();
  if (nota) log(`Cartera MEV: ${nota}`);
  log(`Causas vigiladas: ${vigiladas.length}`);
  if (!vigiladas.length) {
    log("No hay causas vigiladas. Pedir autorizaciones en la MEV o armar sets, y correr descubrir-mev.mjs.");
    if (CFG.enviarSinNovedades) await enviar(armarParte([], "sin causas vigiladas", 0, [], null), 0, 0, 0);
    registrarCorrida("0 vigiladas");
    return;
  }

  // 3) Diff de pasos por causa, agrupado por jurisdiccion (la MEV la exige en sesion).
  const { corte: corteVentana, desc } = calcularCorteVentana();
  const prev = estadoPrevio();
  const novedades = [];     // { causa, paso }
  const paraRegistrar = []; // filas CSV
  const fallos = [];

  const porJur = new Map();
  for (const c of vigiladas.slice(0, CFG.maxExp)) {
    const k = c.jurisdiccion || JURS[0].clave;
    if (!porJur.has(k)) porJur.set(k, []);
    porJur.get(k).push(c);
  }

  for (const [jurClave, causas] of porJur) {
    const jur = JURS.find((j) => j.clave === jurClave) || parseJurisdicciones([jurClave])[0];
    try { await entrarJurisdiccion(jur); }
    catch (e) { for (const c of causas) fallos.push({ ref: c.expedienteRef || c.nidCausa, motivo: `jurisdiccion "${jurClave}": ${e.message}` }); continue; }

    for (const c of causas) {
      c.expedienteRef = c.caratula ? `${c.nidCausa}` : c.nidCausa; // fallback
      try {
        const corte = prev.get(`${c.nidCausa}|${c.pidJuzgado}`) || null;
        const { ficha, nuevos } = await pasosNuevos(jur, c, corte);
        c.expedienteRef = ficha.expediente || c.nidCausa;
        c.caratula = c.caratula || ficha.caratula;
        c.estado = ficha.estado || c.estado;
        let reportables = nuevos;
        let baseline = [];
        if (!corte) {
          // Primera corrida: linea de base. Reporta solo lo de la ventana; registra
          // todos los pasos visibles para no repetirlos despues.
          baseline = ficha.pasos;
          reportables = ficha.pasos.filter((p) => { const f = parseDia(p.fechaHora || p.fecha); return f && f.getTime() >= corteVentana; });
        }
        for (const p of reportables) novedades.push({ causa: c, paso: p });
        for (const p of [...reportables, ...baseline]) {
          paraRegistrar.push({
            nPosi: p.nPosi, fecha: p.fechaHora || p.fecha, nidCausa: c.nidCausa, pidJuzgado: c.pidJuzgado,
            descripcion: p.descripcion, prioritaria: esPrioritario(p), firmado: p.firmado,
          });
        }
      } catch (e) {
        fallos.push({ ref: c.expedienteRef || c.nidCausa, motivo: e.message });
        log(`Causa ${c.nidCausa} fallo: ${e.message}`);
      }
      await sleep(CFG.pausaMs);
    }
  }

  log(`Novedades en la ventana: ${novedades.length}; ${fallos.length} causa(s) con error.`);

  if (novedades.length === 0 && !fallos.length && !CFG.enviarSinNovedades) {
    log("Sin novedades y ENVIAR_SIN_NOVEDADES=false: no se envia correo.");
    await registrarPasos(paraRegistrar);
    registrarCorrida("0 novedades, sin envio");
    return;
  }

  // Caducidad de instancia PBA (lee cartera-mev.xlsx; independiente de las novedades).
  let caducidadRender = null;
  try {
    const cad = await calcularCaducidadMev();
    if (cad.nota) log(`Caducidad MEV: ${cad.nota}`);
    else if (cad.items.length) log(`Caducidad MEV: ${cad.items.length} causa(s) en zona/riesgo; ${cad.sinImpulso || 0} sin impulso verificado`);
    caducidadRender = renderCaducidadMev(cad);
  } catch (e) { log(`Caducidad MEV omitida: ${e.message}`); }

  const parte = armarParte(novedades, desc, vigiladas.length, fallos, caducidadRender);
  await enviar(parte, novedades.length, parte.causas, parte.prioritarias, parte.caducidadRevision);

  // Registrar despues del mail (si el mail falla, no se marca visto y se reintenta).
  const rc = await registrarPasos(paraRegistrar);
  log(`Log MOVIMIENTOS MEV (CSV): ${rc.agregadas} nueva(s), ${rc.duplicadas} ya cargada(s).`);
  registrarCorrida(`${novedades.length} novedades, ${parte.prioritarias} prioritarias, ${fallos.length} errores`);
}

main().then(() => process.exit(0)).catch(async (e) => {
  console.error("ERROR:", e.message);
  await enviarAlertaFalla(e);
  process.exit(1);
});
