/**
 * eje-client.mjs - Cliente HTTP standalone para la API publica de JusCABA (EJE).
 *
 * Portal: https://eje.juscaba.gob.ar/iol-ui/   API: /iol-api/api/public/*
 * Acceso: consulta publica, sin login ni token. Backend Spring (respuestas tipo Page).
 *
 * El bot corre solo por Task Scheduler, sin el conector MCP: por eso le pega DIRECTO a
 * la API. Endpoints y forma de request calcados del conector juscaba (mcp-legal-ar):
 *
 *   Busqueda   POST /expedientes/lista   (form-urlencoded, UN campo "info")
 *              body: info=<urlencode(JSON.stringify({
 *                        filter: JSON.stringify({identificador:<criterio>}),
 *                        tipoBusqueda:"CAU", page, size }))>
 *              resp: Spring Page { content:[{expId,fechaFavorito}], totalElements }
 *   Encabezado GET  /expedientes/encabezado?expId=  -> { cuij,caratula,numero,anio,
 *              tipoExpediente,estadoAdministrativo,esPrivado(0/1),fechaInicio(ms),sufijo }
 *   UltimaAcc. GET  /expedientes/ultimaAccion?expId= -> { ultimaAccion:{descripcion,fecha(ms),tipo} }
 *   Actuacion. GET  /expedientes/actuaciones?filtro=<JSON>&page=&size=
 *              filtro: { cedulas,escritos,despachos,notas, expId, accesoMinisterios:false,
 *                        fechaNotificacionDesde:null, fechaNotificacionHasta:null }
 *              resp: Page de { actId,codigo,titulo,numero,anio,firmantes,fechaFirma(ms),
 *                              fechaPublicacion(ms), esCedula(0/1), esNota(0/1) }
 *
 * Salida (misma forma que el conector, para no reescribir el resto del sistema).
 *
 * MODO AUTENTICADO (capa nueva): si hay credenciales (EJE_USUARIO/EJE_CLAVE), el
 * cliente pega a la API autenticada (misma ruta SIN /public) con token Bearer de
 * Keycloak (ver eje-auth.mjs). Eso habilita:
 *   - Mis Causas: POST /expedientes/lista con filter {"causas":"1"} -> cartera EXACTA
 *     del letrado (sin homonimos), incluidas las reservadas.
 *   - Actuaciones/encabezado de causas reservadas (penal/PCyF, sensibles), que la
 *     consulta publica rechaza con code 1004.
 * Sin credenciales, cae a modo publico (busqueda por nombre + causas no reservadas).
 * Pisar por .env si hiciera falta: EJE_API_BASE / EJE_API_BASE_PUB.
 */
import { getToken, hayCredenciales } from "./eje-auth.mjs";

const B_PUB = process.env.EJE_API_BASE_PUB || "https://eje.juscaba.gob.ar/iol-api/api/public";
const B_AUTH = process.env.EJE_API_BASE || "https://eje.juscaba.gob.ar/iol-api/api";
const TIMEOUT_MS = Number(process.env.EJE_TIMEOUT_MS || 25000);
const HDRS = {
  "Accept": "application/json",
  "Referer": "https://eje.juscaba.gob.ar/iol-ui/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Delay entre requests para no saturar el firewall del Consejo de la Magistratura CABA.
const PAUSA = Number(process.env.EJE_PAUSA_MS || 150);

// Base a usar por defecto: autenticada si hay credenciales, publica si no.
function baseDefault() { return hayCredenciales() ? B_AUTH : B_PUB; }

// Headers con Bearer cuando corresponde. authObligatoria fuerza el token (Mis Causas).
async function headers({ auth = hayCredenciales() } = {}) {
  const h = { ...HDRS };
  if (auth) { const t = await getToken(); if (t) h.Authorization = "Bearer " + t; }
  return h;
}

// GET con query params (?k=v...). Devuelve JSON o tira error con el status.
// opts.base fuerza la base; opts.auth fuerza (o no) el Bearer.
async function getJson(path, params = {}, opts = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) qs.set(k, String(v));
  const base = opts.base || baseDefault();
  const url = `${base}${path}${qs.toString() ? "?" + qs.toString() : ""}`;
  const r = await fetch(url, { headers: await headers(opts), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) {
    const b = (await r.text().catch(() => "")).slice(0, 160);
    // code 1004 = "El usuario no tiene acceso": expediente reservado. En modo publico
    // pasa con causas sensibles; con token, no deberia (salvo que no seas parte).
    if (b.includes('"code":"1004"')) {
      const e = new Error("expediente reservado: sin acceso a sus actuaciones (code 1004)");
      e.privado = true; throw e;
    }
    throw new Error(`GET ${path} HTTP ${r.status}${b ? " " + b : ""}`);
  }
  return r.json();
}

// ─── helpers de mapeo ───────────────────────────────────────────────────────────
const diaAr = (d) => new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
function epochADmy(ms) {
  if (ms == null || ms === "") return "";
  const n = Number(ms); if (!Number.isFinite(n)) return "";
  const d = new Date(n); return isNaN(d.getTime()) ? "" : diaAr(d);
}

// ─── busqueda ───────────────────────────────────────────────────────────────────
// POST generico a /expedientes/lista con un objeto "info". base/auth configurables.
async function postLista(info, { base, auth } = {}) {
  const body = "info=" + encodeURIComponent(JSON.stringify(info));
  const b = base || baseDefault();
  const r = await fetch(`${b}/expedientes/lista`, {
    method: "POST", body,
    headers: { ...(await headers({ auth })), "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) { const t = (await r.text().catch(() => "")).slice(0, 160); throw new Error(`lista HTTP ${r.status}${t ? " " + t : ""}`); }
  const data = await r.json();
  const ids = (data.content || []).map((c) => c.expId).filter((x) => x != null);
  return { ids, total: data.totalElements ?? ids.length };
}

// Busqueda por nombre/criterio. Siempre contra la API PUBLICA (busca todo el indice;
// no requiere token). Devuelve solo expIds.
async function listaExpIds(criterio, { page = 0, size = 10 } = {}) {
  const info = { filter: JSON.stringify({ identificador: String(criterio) }), tipoBusqueda: "CAU", page, size };
  return postLista(info, { base: B_PUB, auth: false });
}

// Mis Causas: cartera EXACTA del letrado logueado (filter {"causas":"1"}). Requiere
// credenciales; pega a la API autenticada con Bearer. Devuelve expIds + total.
async function listaMisCausasIds({ page = 0, size = 50, orden = "reciente" } = {}) {
  const info = { filter: JSON.stringify({ causas: "1" }), tipoBusqueda: "CAU", page, size, orden };
  return postLista(info, { base: B_AUTH, auth: true });
}

export async function obtenerEncabezado(expId) {
  const enc = await getJson("/expedientes/encabezado", { expId });
  return {
    expId: Number(expId), cuij: enc.cuij || "", caratula: enc.caratula || "",
    tipoExpediente: enc.tipoExpediente || "", numero: enc.numero ?? null, anio: enc.anio ?? null,
    estado: enc.estadoAdministrativo || "", esPrivado: enc.esPrivado === 1,
    fechaInicio: epochADmy(enc.fechaInicio),
  };
}

export async function obtenerUltimaAccion(expId) {
  try {
    const ua = await getJson("/expedientes/ultimaAccion", { expId });
    const a = ua && ua.ultimaAccion ? ua.ultimaAccion : null;
    return a ? { descripcion: a.descripcion ?? a.titulo ?? "", fecha: epochADmy(a.fecha), tipo: a.tipo || "" } : { descripcion: "", fecha: "", tipo: "" };
  } catch { return { descripcion: "", fecha: "", tipo: "" }; }
}

// Enriquece una lista de expIds con encabezado + ultima accion.
async function enriquecer(ids, pausaMs) {
  const causas = [];
  for (const expId of ids) {
    try {
      const enc = await obtenerEncabezado(expId);
      const ua = await obtenerUltimaAccion(expId);
      causas.push({ ...enc, ultimaActuacion: ua });
    } catch (e) { causas.push({ expId, cuij: "", caratula: `[error al enriquecer: ${e.message}]`, ultimaActuacion: { descripcion: "", fecha: "", tipo: "" } }); }
    await sleep(pausaMs);
  }
  return causas;
}

// Busca causas por nombre/criterio (API publica) y (por defecto) enriquece.
export async function buscarCausas(criterio, { page = 0, size = 10, enriquecer: enr = true, pausaMs = PAUSA } = {}) {
  const { ids, total } = await listaExpIds(criterio, { page, size });
  if (!enr) return { causas: ids.map((expId) => ({ expId })), total, page, size };
  return { causas: await enriquecer(ids, pausaMs), total, page, size };
}

// Mis Causas del letrado logueado (cartera exacta). Recorre todas las paginas.
// Requiere credenciales; si no hay, tira error claro.
export async function misCausas({ size = 50, orden = "reciente", enriquecer: enr = true, pausaMs = PAUSA } = {}) {
  if (!hayCredenciales()) throw new Error("Mis Causas requiere credenciales (EJE_USUARIO/EJE_CLAVE en .env)");
  let page = 0, total = Infinity, ids = [];
  while (ids.length < total && page < 200) {
    const r = await listaMisCausasIds({ page, size, orden });
    total = Number(r.total ?? ids.length);
    ids.push(...r.ids);
    if (r.ids.length < size) break;
    page++;
  }
  if (!enr) return { causas: ids.map((expId) => ({ expId })), total: ids.length };
  return { causas: await enriquecer(ids, pausaMs), total: ids.length };
}

// ─── actuaciones ────────────────────────────────────────────────────────────────
function mapActuacion(a) {
  return {
    actId: a.actId, codigo: a.codigo || "", titulo: a.titulo || "",
    numero: a.numero ?? null, anio: a.anio ?? null, firmantes: a.firmantes || "",
    fechaFirma: epochADmy(a.fechaFirma), fechaPublicacion: epochADmy(a.fechaPublicacion),
    esCedula: a.esCedula === 1, esNota: a.esNota === 1,
  };
}

export async function listarActuaciones(expId, { page = 0, size = 20 } = {}) {
  const filtro = JSON.stringify({
    cedulas: true, escritos: true, despachos: true, notas: true,
    expId: Number(expId), accesoMinisterios: false,
    fechaNotificacionDesde: null, fechaNotificacionHasta: null,
  });
  const data = await getJson("/expedientes/actuaciones", { filtro, page, size });
  const items = (data.content || []).map(mapActuacion).filter((a) => a.actId != null);
  return { actuaciones: items, total: data.totalElements ?? items.length, page, size };
}

export async function ultimaActuacion(expId) {
  const { actuaciones } = await listarActuaciones(expId, { page: 0, size: 1 });
  return actuaciones[0] || null;
}

// Actuaciones nuevas: posteriores a un corte { actId, fecha:Date } (o null en 1a corrida).
export async function actuacionesNuevas(expId, corte, { maxPaginas = 5, size = 20 } = {}) {
  const nuevas = [];
  const cutId = corte?.actId != null ? String(corte.actId) : null;
  const cutMs = corte?.fecha instanceof Date ? corte.fecha.getTime() : null;
  for (let p = 0; p < maxPaginas; p++) {
    if (p > 0) await sleep(PAUSA);
    const { actuaciones } = await listarActuaciones(expId, { page: p, size });
    if (!actuaciones.length) break;
    let corto = false;
    for (const a of actuaciones) {
      if (cutId) { if (String(a.actId) === cutId) { corto = true; break; } }
      else if (cutMs) { const f = parseDia(a.fechaFirma || a.fechaPublicacion); if (f && f.getTime() <= cutMs) { corto = true; break; } }
      nuevas.push(a);
    }
    if (corto || actuaciones.length < size) break;
  }
  return nuevas;
}

export function parseDia(s) {
  const m = String(s || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[ ,]+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const a = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const d = new Date(a, Number(m[2]) - 1, Number(m[1]), Number(m[4] || 0), Number(m[5] || 0));
  return isNaN(d) ? null : d;
}

// ─── descarga de PDF de una actuacion ────────────────────────────────────────
// Endpoint calcado de juscaba.js: GET /expedientes/actuaciones/pdf?datos=<JSON>.
// Usa la base y el Bearer por defecto (autenticado si hay credenciales -> tambien baja
// los PDF de causas reservadas). Valida firma %PDF y reintenta una vez.
// Muchas actuaciones de mero tramite NO tienen documento: en ese caso devuelve ok:false
// (el que llama lo saltea, no es un error a reportar).
export async function descargarPdf({ actId, expId, esNota = false }) {
  const datos = JSON.stringify({ actId: Number(actId), expId: Number(expId), esNota: !!esNota, cedulaId: null, cedulaIndexada: false, ministerios: false });
  const url = `${baseDefault()}/expedientes/actuaciones/pdf?datos=${encodeURIComponent(datos)}`;
  for (let intento = 1; intento <= 2; intento++) {
    try {
      const h = await headers(); h.Accept = "application/pdf, */*";
      const r = await fetch(url, { headers: h, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length >= 1000 && buf.slice(0, 5).toString("latin1") === "%PDF-") return { ok: true, buf };
        if (intento === 2) return { ok: false, motivo: `sin PDF valido (${buf.length} bytes)` };
      } else if (intento === 2) {
        return { ok: false, motivo: `HTTP ${r.status}` };
      }
    } catch (e) {
      if (intento === 2) return { ok: false, motivo: e.name === "TimeoutError" ? "timeout" : e.message };
    }
    await sleep(PAUSA);
  }
  return { ok: false, motivo: "sin resultado" };
}

export function endpointsEnUso() {
  return {
    modo: hayCredenciales() ? "AUTENTICADO (Mis Causas + reservadas)" : "PUBLICO (busqueda por nombre)",
    base: baseDefault(),
    lista: "POST /expedientes/lista (info=)",
    misCausas: hayCredenciales() ? 'POST /expedientes/lista filter={"causas":"1"}' : "(requiere credenciales)",
    encab: "GET /expedientes/encabezado",
    ultima: "GET /expedientes/ultimaAccion",
    acts: "GET /expedientes/actuaciones (filtro=)",
  };
}
