/**
 * mev-auth.mjs - Autenticacion y sesion contra la MEV (Mesa de Entradas Virtual, SCBA).
 *
 * La MEV es ASP clasico con sesion por cookie (ASPSESSIONID*). No hay token OAuth:
 * el "login" es un POST de formulario y la sesion vive en cookies + estado server-side.
 *
 * Flujo (confirmado en vivo, jul-2026, ver test/RECON-MEV.md):
 *   POST /loguin.asp?familiadepto=   body: usuario, clave, DeptoRegistrado
 *     DeptoRegistrado: "aa" = TODOS los Deptos; "MO" = Moron; sufijo F = Familia.
 *     Si ok -> pagina POSLoguin.asp (seleccion de jurisdiccion).
 *   POST /POSLoguin.asp              body: TipoDto, DtoJudElegido, TipoF, TipoP, Aceptar
 *     TipoDto: SCJ | LPC (Casacion Penal) | PZ (Justicia de Paz) | CC (Depto Judicial)
 *     TipoF="FF" (Fuero Familia), TipoP="PP" (Fuero Penal): checkboxes, mandar solo si aplican.
 *     La jurisdiccion elegida queda EN LA SESION: para consultar otro depto/fuero
 *     hay que volver a postear POSLoguin.
 *
 * GOTCHAS:
 *   - Timeout de sesion CORTO (~10-15 min de inactividad). Cualquier respuesta que
 *     "rebote" al login se detecta con esSesionCaida() y se re-loguea UNA vez.
 *   - Politica de claves desde 08/2026: expiran cada 90 dias. Si el login responde
 *     pidiendo cambio de clave, el bot alerta (no intenta cambiarla).
 *   - Mandar siempre Referer y User-Agent de navegador; pausar entre requests.
 *
 * Credenciales en .env: MEV_USUARIO, MEV_CLAVE, MEV_DEPTO_REGISTRADO (default "aa").
 */

const BASE = process.env.MEV_BASE || "https://mev.scba.gov.ar";
const TIMEOUT_MS = Number(process.env.MEV_TIMEOUT_MS || 30000);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36";

// ── cookie jar minimo (la MEV usa varias ASPSESSIONIDxxxx) ─────────────────────
const _jar = new Map(); // nombre -> valor

function guardarCookies(res) {
  const sc = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);
  for (const linea of sc) {
    const par = String(linea).split(";")[0];
    const i = par.indexOf("=");
    if (i > 0) _jar.set(par.slice(0, i).trim(), par.slice(i + 1).trim());
  }
}

function cookieHeader() {
  return [..._jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

export function limpiarSesion() { _jar.clear(); _logueado = false; _jurisActual = null; }

// ── requests con sesion ────────────────────────────────────────────────────────
function headers(extra = {}) {
  const h = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "es-AR,es;q=0.9",
    "Referer": `${BASE}/busqueda.asp`,
    ...extra,
  };
  const c = cookieHeader();
  if (c) h.Cookie = c;
  return h;
}

// La MEV es ASP clasico y responde en Latin-1 (ISO-8859-1). r.text() asume UTF-8 y
// rompe los acentos ("Bahia" -> "Bah?a"). Leemos el buffer y lo decodificamos latin1.
async function leerLatin1(r) {
  const buf = Buffer.from(await r.arrayBuffer());
  return buf.toString("latin1");
}

// GET que devuelve el HTML como texto y actualiza cookies.
export async function getHtml(path) {
  const r = await fetch(`${BASE}${path}`, { headers: headers(), redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
  guardarCookies(r);
  const html = await leerLatin1(r);
  if (!r.ok) throw new Error(`GET ${path} HTTP ${r.status}`);
  return html;
}

// POST form-urlencoded que devuelve el HTML resultante y actualiza cookies.
export async function postForm(path, campos, { referer } = {}) {
  const body = new URLSearchParams(campos).toString();
  const r = await fetch(`${BASE}${path}`, {
    method: "POST", body,
    headers: headers({ "Content-Type": "application/x-www-form-urlencoded", ...(referer ? { Referer: `${BASE}${referer}` } : {}) }),
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  guardarCookies(r);
  const html = await leerLatin1(r);
  if (!r.ok) throw new Error(`POST ${path} HTTP ${r.status}`);
  return html;
}

// ── deteccion de estados ───────────────────────────────────────────────────────
// La MEV no usa codigos HTTP para el estado de sesion: rebota al login con 200.
export function esSesionCaida(html) {
  return /Ingrese los datos del Usuario/i.test(html) && /name=["']?clave["']?/i.test(html);
}

export function esClaveVencida(html) {
  return /cambi[oa]r? (de )?(su )?(contrase|clave)/i.test(html) && /(vencid|expir|obligatori)/i.test(html);
}

export function hayCredenciales() {
  return !!(process.env.MEV_USUARIO && process.env.MEV_CLAVE);
}

// ── login + jurisdiccion ───────────────────────────────────────────────────────
let _logueado = false;
let _jurisActual = null; // clave "TipoDto|DtoJudElegido|FF|PP"

export async function login() {
  if (!hayCredenciales()) throw new Error("faltan MEV_USUARIO / MEV_CLAVE en .env");
  limpiarSesion();
  // GET inicial para sembrar cookies de sesion.
  await getHtml("/loguin.asp");
  const html = await postForm("/loguin.asp?familiadepto=", {
    usuario: String(process.env.MEV_USUARIO),
    clave: String(process.env.MEV_CLAVE),
    DeptoRegistrado: process.env.MEV_DEPTO_REGISTRADO || "aa",
  }, { referer: "/loguin.asp" });
  if (esClaveVencida(html)) {
    const e = new Error("la clave MEV esta vencida o requiere cambio (politica 90 dias): renovarla a mano en mev.scba.gov.ar");
    e.claveVencida = true; throw e;
  }
  if (esSesionCaida(html)) throw new Error("login MEV rechazado: verificar MEV_USUARIO/MEV_CLAVE/MEV_DEPTO_REGISTRADO");
  _logueado = true;
  _jurisActual = null;
  return html;
}

/**
 * Selecciona jurisdiccion (queda en la sesion server-side). jur:
 *   { tipo:"CC", depto:<valor de DtoJudElegido>, familia:false, penal:false }
 *   { tipo:"SCJ" } | { tipo:"LPC" } | { tipo:"PZ" }
 * Devuelve el HTML de busqueda.asp (contiene organismos y sets de esa jurisdiccion).
 */
export async function seleccionarJurisdiccion(jur) {
  if (!_logueado) await login();
  const campos = { TipoDto: jur.tipo || "CC", Aceptar: "Aceptar" };
  if ((jur.tipo || "CC") === "CC") campos.DtoJudElegido = String(jur.depto);
  if (jur.familia) campos.TipoF = "FF";
  if (jur.penal) campos.TipoP = "PP";
  let html = await postForm("/POSLoguin.asp", campos, { referer: "/POSloguin.asp" });
  if (esSesionCaida(html)) { // sesion vencida: re-login UNA vez
    await login();
    html = await postForm("/POSLoguin.asp", campos, { referer: "/POSloguin.asp" });
    if (esSesionCaida(html)) throw new Error("sesion MEV caida aun tras re-login");
  }
  _jurisActual = `${campos.TipoDto}|${campos.DtoJudElegido || ""}|${campos.TipoF || ""}|${campos.TipoP || ""}`;
  return html;
}

export function jurisdiccionActual() { return _jurisActual; }

/**
 * GET con auto-recuperacion de sesion: si el HTML rebota al login, re-loguea,
 * re-selecciona la jurisdiccion vigente y reintenta una vez.
 */
export async function getConSesion(path, jur) {
  let html = await getHtml(path);
  if (esSesionCaida(html)) {
    await login();
    if (jur) await seleccionarJurisdiccion(jur);
    html = await getHtml(path);
    if (esSesionCaida(html)) throw new Error(`sesion MEV caida en ${path} aun tras re-login`);
  }
  return html;
}

export async function postConSesion(path, campos, jur, opts = {}) {
  let html = await postForm(path, campos, opts);
  if (esSesionCaida(html)) {
    await login();
    if (jur) await seleccionarJurisdiccion(jur);
    html = await postForm(path, campos, opts);
    if (esSesionCaida(html)) throw new Error(`sesion MEV caida en ${path} aun tras re-login`);
  }
  return html;
}

export function configAuth() {
  return { base: BASE, conCredenciales: hayCredenciales(), deptoRegistrado: process.env.MEV_DEPTO_REGISTRADO || "aa", jurisdiccion: _jurisActual };
}
