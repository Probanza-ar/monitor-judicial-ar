/**
 * eje-auth.mjs - Autenticacion contra Keycloak del EJE (JusCABA).
 *
 * El portal del litigante usa Keycloak (OIDC). Config confirmada contra
 * GET /iol-api/api/public/ui/configuracion/keycloak:
 *   { realm:"IOL-CABA", resource:"iol-ui", public-client:true,
 *     auth-server-url:"https://eje.juscaba.gob.ar/auth", ssl-required:"external" }
 *
 * Al ser cliente publico con "direct access grants" habilitados, se obtiene el
 * token con grant_type=password (usuario = CUIT del letrado, sin guiones).
 *   POST {auth}/realms/{realm}/protocol/openid-connect/token
 *   body (form): grant_type=password, client_id=iol-ui, username=<CUIT>, password=<clave>
 *   resp: { access_token, refresh_token, expires_in(~300s), refresh_expires_in }
 *
 * El token es Bearer y vence a los ~5 min: se cachea y se renueva solo (por
 * refresh_token mientras siga vigente; si no, nuevo password grant).
 *
 * Credenciales: EJE_USUARIO (CUIT) y EJE_CLAVE en el .env. Sin ellas, el resto
 * del sistema corre en modo publico (sin acceso a causas reservadas).
 *
 * IMPORTANTE: las causas reservadas (penal/PCyF, o civiles con datos sensibles)
 * SOLO se ven con este token. La consulta publica devuelve code 1004 en ellas.
 */
const AUTH_URL = process.env.EJE_AUTH_URL || "https://eje.juscaba.gob.ar/auth";
const REALM = process.env.EJE_REALM || "IOL-CABA";
const CLIENT_ID = process.env.EJE_CLIENT_ID || "iol-ui";
const TIMEOUT_MS = Number(process.env.EJE_TIMEOUT_MS || 25000);
const TOKEN_URL = `${AUTH_URL}/realms/${encodeURIComponent(REALM)}/protocol/openid-connect/token`;

// Margen para renovar antes del vencimiento real (no apurar el ultimo segundo).
const MARGEN_MS = 20000;

let _tok = null; // { access, refresh, accessExp, refreshExp }

export function hayCredenciales() {
  return !!(process.env.EJE_USUARIO && process.env.EJE_CLAVE);
}

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
    const e = new Error(`Keycloak ${r.status} ${desc}`);
    e.status = r.status;
    throw e;
  }
  const j = JSON.parse(txt);
  const now = Date.now();
  _tok = {
    access: j.access_token,
    refresh: j.refresh_token || null,
    accessExp: now + Number(j.expires_in || 300) * 1000,
    refreshExp: now + Number(j.refresh_expires_in || 1800) * 1000,
  };
  return _tok.access;
}

// Devuelve un access_token vigente, renovando si hace falta. Null si no hay credenciales.
export async function getToken() {
  if (!hayCredenciales()) return null;
  const now = Date.now();
  if (_tok && _tok.accessExp - MARGEN_MS > now) return _tok.access;
  // Intentar refresh si el refresh_token sigue vivo.
  if (_tok && _tok.refresh && _tok.refreshExp - MARGEN_MS > now) {
    try { return await postToken({ grant_type: "refresh_token", refresh_token: _tok.refresh }); }
    catch { /* cae a password grant */ }
  }
  return await postToken({
    grant_type: "password",
    username: String(process.env.EJE_USUARIO).replace(/[^0-9]/g, ""), // CUIT sin guiones
    password: String(process.env.EJE_CLAVE),
  });
}

// Fuerza un login limpio (descarta cache). Util para diagnostico.
export async function loginFresco() {
  _tok = null;
  return getToken();
}

export function configAuth() {
  return { tokenUrl: TOKEN_URL, realm: REALM, clientId: CLIENT_ID, conCredenciales: hayCredenciales() };
}
