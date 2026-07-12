/**
 * eje-auth.mjs - Autenticacion contra el EJE (JusCABA). DOS formas de login, se
 * elige con EJE_LOGIN:
 *
 *   EJE_LOGIN=directo -> Keycloak con CUIT/CUIL + clave LOCAL del EJE (grant_type=
 *     password, realm IOL-CABA, client publico iol-ui). Es el modo IDEAL para un bot
 *     desatendido: una llamada HTTP, sin navegador.
 *       POST {auth}/realms/{realm}/protocol/openid-connect/token
 *       body: grant_type=password, client_id=iol-ui, username=<CUIT>, password=<clave>
 *
 *   EJE_LOGIN=miba -> "Ingresar con miBA" (identidad del GCBA). EJE_USUARIO = email o
 *     CUIL de miBA; EJE_CLAVE = clave de miBA. El bot automatiza ese login con un
 *     navegador headless (perfil persistente) y captura el Bearer que emite la SPA.
 *     OJO desatendido: si miBA muestra captcha/2FA, el login se traba y el parte falla
 *     (queda registrado y dispara la alerta). Conviene el modo directo si tenes clave local.
 *
 *   sin EJE_LOGIN (auto) -> infiere por el formato de EJE_USUARIO: con @ = miBA;
 *     solo numerico (CUIT) = directo.
 *
 * El token es Bearer (~5 min): se cachea y se renueva solo. Sin credenciales, el resto
 * del sistema corre en modo publico (sin causas reservadas; la publica da code 1004).
 *
 * Selectores de las pantallas (login EJE + miBA) capturados en vivo jul-2026.
 */
import { fileURLToPath } from "node:url";

const AUTH_URL = process.env.EJE_AUTH_URL || "https://eje.juscaba.gob.ar/auth";
const REALM = process.env.EJE_REALM || "IOL-CABA";
const CLIENT_ID = process.env.EJE_CLIENT_ID || "iol-ui";
const TIMEOUT_MS = Number(process.env.EJE_TIMEOUT_MS || 25000);
const TOKEN_URL = `${AUTH_URL}/realms/${encodeURIComponent(REALM)}/protocol/openid-connect/token`;
const EJE_UI = "https://eje.juscaba.gob.ar/iol-ui/p/inicio";
const MARGEN_MS = 20000;
const TOKEN_FRESCO_MS = 4 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── modo de login ──────────────────────────────────────────────────────────
const ejeLoginModo = () => (process.env.EJE_LOGIN || "auto").trim().toLowerCase();
const hayUserPass = () => !!(process.env.EJE_USUARIO && process.env.EJE_CLAVE);
const usuarioEsCuit = () => { const u = (process.env.EJE_USUARIO || "").trim(); return /^[\d.\-]+$/.test(u) && u.replace(/\D/g, "").length >= 8; };
const usuarioEsMiba = () => /@/.test((process.env.EJE_USUARIO || "").trim());
const modoDirecto = () => hayUserPass() && (ejeLoginModo() === "directo" || (ejeLoginModo() === "auto" && usuarioEsCuit()));
const modoMiba = () => hayUserPass() && (ejeLoginModo() === "miba" || (ejeLoginModo() === "auto" && usuarioEsMiba()));

export function hayCredenciales() {
  return modoDirecto() || modoMiba();
}

// ─── modo DIRECTO: Keycloak grant_type=password ───────────────────────────────
let _tok = null; // { access, refresh, accessExp, refreshExp }

async function postToken(params) {
  const body = new URLSearchParams({ client_id: CLIENT_ID, ...params }).toString();
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const txt = await r.text().catch(() => "");
  if (!r.ok) {
    let desc = txt.slice(0, 200);
    try { const j = JSON.parse(txt); desc = `${j.error || ""}: ${j.error_description || ""}`.trim(); } catch {}
    const e = new Error(`Keycloak ${r.status} ${desc}`); e.status = r.status; throw e;
  }
  const j = JSON.parse(txt);
  const now = Date.now();
  _tok = {
    access: j.access_token, refresh: j.refresh_token || null,
    accessExp: now + Number(j.expires_in || 300) * 1000,
    refreshExp: now + Number(j.refresh_expires_in || 1800) * 1000,
  };
  return _tok.access;
}

async function tokenDirecto() {
  const now = Date.now();
  if (_tok && _tok.accessExp - MARGEN_MS > now) return _tok.access;
  if (_tok && _tok.refresh && _tok.refreshExp - MARGEN_MS > now) {
    try { return await postToken({ grant_type: "refresh_token", refresh_token: _tok.refresh }); } catch { /* cae a password */ }
  }
  return await postToken({
    grant_type: "password",
    username: String(process.env.EJE_USUARIO).replace(/[^0-9]/g, ""), // CUIT sin guiones
    password: String(process.env.EJE_CLAVE),
  });
}

// ─── modo miBA: auto-login por navegador (Puppeteer) ──────────────────────────
let _browser = null, _page = null;
let _miba = { token: null, ts: 0 };
const PROFILE_DIR = process.env.EJE_PROFILE_DIR || fileURLToPath(new URL("../.eje-profile", import.meta.url));
const ejeHeadless = () => (process.env.EJE_HEADLESS || "true") !== "false"; // bot: headless por defecto
const pageViva = () => !!(_browser && _page && !_page.isClosed());
const mibaFresco = () => _miba.token && Date.now() - _miba.ts < TOKEN_FRESCO_MS;

function instalarCaptura(page) {
  page.on("request", (req) => {
    try {
      if (!req.url().includes("juscaba.gob.ar/iol-api")) return;
      const a = req.headers()["authorization"] || req.headers()["Authorization"];
      if (a && /^Bearer .{20,}/.test(a)) _miba = { token: a.slice(7), ts: Date.now() };
    } catch {}
  });
  page.on("response", async (res) => {
    try {
      if (!/\/openid-connect\/token\b/.test(res.url())) return;
      const j = await res.json();
      if (j && j.access_token) _miba = { token: j.access_token, ts: Date.now() };
    } catch {}
  });
}
async function abrirNavegador() {
  const { default: puppeteer } = await import("puppeteer");
  const fs = await import("node:fs");
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  _browser = await puppeteer.launch({
    headless: ejeHeadless() ? "new" : false,
    userDataDir: PROFILE_DIR,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  _page = (await _browser.pages())[0] || (await _browser.newPage());
  instalarCaptura(_page);
}
async function leerTokenStorage() {
  if (!pageViva()) return null;
  try {
    return await _page.evaluate(() => {
      const scan = (s) => { for (let i = 0; i < s.length; i++) { const k = s.key(i), v = s.getItem(k); if (!v) continue; if (/access_token/i.test(k) && v.length > 40 && !/[{}]/.test(v)) return v; if (/"access_token"/.test(v)) { try { const o = JSON.parse(v); if (o.access_token) return o.access_token; } catch {} } } return null; };
      return scan(window.localStorage) || scan(window.sessionStorage);
    });
  } catch { return null; }
}
// Auto-login por miBA. Con perfil persistente, si la sesion vive entra solo (headless);
// si cae al login, completa el form de miBA con EJE_USUARIO/EJE_CLAVE.
async function tokenMiba() {
  if (pageViva() && mibaFresco()) return _miba.token;
  if (pageViva()) { const t = await leerTokenStorage(); if (t) { _miba = { token: t, ts: Date.now() }; return t; } }
  if (!pageViva()) await abrirNavegador();
  try { await _page.goto(EJE_UI, { waitUntil: "domcontentloaded", timeout: 90000 }); } catch {}
  for (let i = 0; i < 8 && !mibaFresco(); i++) await sleep(1000); // sesion del perfil?
  if (mibaFresco()) return _miba.token;
  try {
    // Menu de usuario -> "Iniciar Sesion" (dropdown-item, vive en el DOM aunque cerrado).
    await _page.waitForSelector(".dropdown-item", { timeout: 15000 });
    await Promise.all([
      _page.evaluate(() => { const it = [...document.querySelectorAll(".dropdown-item, button, a")].find((e) => /iniciar sesi/i.test(e.textContent || "")); if (it) it.click(); }),
      _page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {}),
    ]);
    // Pantalla Keycloak del EJE -> "Ingresar con miBA".
    await _page.waitForSelector('a[href*="broker/miba"]', { timeout: 20000 });
    await Promise.all([
      _page.click('a[href*="broker/miba"]'),
      _page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {}),
    ]);
    // Pantalla de miBA (login.buenosaires.gob.ar): email/CUIL + clave.
    await _page.waitForSelector("#email", { timeout: 20000 });
    await _page.type("#email", String(process.env.EJE_USUARIO), { delay: 15 });
    await _page.type("#password-text-field", String(process.env.EJE_CLAVE), { delay: 15 });
    await Promise.all([
      _page.click("#login").catch(() => _page.keyboard.press("Enter")),
      _page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {}),
    ]);
    for (let i = 0; i < 25 && !mibaFresco(); i++) await sleep(1000);
  } catch { /* captcha/2FA o form distinto */ }
  if (!mibaFresco()) { const t = await leerTokenStorage(); if (t) _miba = { token: t, ts: Date.now() }; }
  if (!_miba.token) throw new Error("No se pudo autenticar por miBA (posible captcha/2FA de miBA). Usar EJE_LOGIN=directo con CUIT si tenes clave local del EJE.");
  return _miba.token;
}

// ─── API publica del modulo ───────────────────────────────────────────────────
// Devuelve un access_token vigente segun el modo, o null (modo publico).
export async function getToken() {
  if (modoDirecto()) return tokenDirecto();
  if (modoMiba()) return tokenMiba();
  return null;
}

export async function loginFresco() {
  _tok = null; _miba = { token: null, ts: 0 };
  return getToken();
}

export async function cerrarNavegador() {
  try { if (_browser) await _browser.close(); } catch {}
  _browser = null; _page = null; _miba = { token: null, ts: 0 };
}

export function configAuth() {
  return {
    tokenUrl: TOKEN_URL, realm: REALM, clientId: CLIENT_ID,
    modo: modoDirecto() ? "directo (CUIT + clave EJE)" : (modoMiba() ? "miBA (auto-login navegador)" : "publico"),
    conCredenciales: hayCredenciales(),
  };
}
