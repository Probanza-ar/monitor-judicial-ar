/**
 * mev-client.mjs - Cliente standalone de la MEV (Mesa de Entradas Virtual, SCBA).
 *
 * La MEV NO tiene API JSON: es ASP server-rendered. Este cliente postea los
 * formularios reales y parsea el HTML. Endpoints confirmados en vivo (jul-2026,
 * detalle en test/RECON-MEV.md):
 *
 *   POST /Busqueda.asp        radio=xCa|xNc|xNr|xSb|xNs + JuzgadoElegido/caratula/
 *                             NCausa/Set/SetNovedades/Desde/Hasta/TipoCausa
 *   GET  /MuestraCausas.asp   ?radio&pagina&pOrden&pOrdenAD   (paginado del listado)
 *   GET  /resultados.asp      ?nidset&sFechaDesde&sFechaHasta&pOrden&pOrdenAD
 *                             (causas de un set; con fechas = NOVEDADES -> feed del parte)
 *   GET  /procesales.asp      ?nidCausa&pidJuzgado            (ficha + pasos procesales)
 *   GET  /proveido.asp        ?pidJuzgado&sCodi&nPosi&sFile=a&MT=  (texto del paso)
 *
 * Identificadores: causa = nidCausa + pidJuzgado (organismo "GAMxxxx", CON padding
 * de espacios a 8 chars). Paso = nPosi. La jurisdiccion (depto + fuero) es estado
 * de SESION server-side: se setea con mev-auth.seleccionarJurisdiccion() antes de
 * consultar, y las causas penales/familia solo aparecen en el set de autorizadas
 * ("Lista de Causas con AUTORIZACION"), consultable unicamente por set.
 *
 * Todo el parseo es best-effort sobre HTML viejo (tablas anidadas): los selectores
 * son regex ancladas en los href reales. Si la SCBA cambia el HTML, ajustar aca.
 */
import { getConSesion, postConSesion, seleccionarJurisdiccion, login, hayCredenciales } from "./mev-auth.mjs";

const PAUSA = Number(process.env.MEV_PAUSA_MS || 400); // MEV es viejito: no apurarlo
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { PAUSA };

// ── helpers de parseo ──────────────────────────────────────────────────────────
function decodeEntities(s) {
  return String(s || "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/\s+/g, " ").trim();
}
function sinTags(html) { return decodeEntities(String(html || "").replace(/<[^>]*>/g, " ")); }

/**
 * Parsea los <option> de un <select> de la MEV. El portal emite HTML roto: los
 * options salen SIN comillas en value, con el texto envuelto en <Hn> y SIN cerrar
 * </option>. Ej real: <option value=19 <H6>Moron</H6><option value=24 <H6>San Isidro</H6>
 * Devuelve [{ valor, nombre }] (valor sin trimear: los organismos llevan padding).
 */
function parseOptionsMEV(selInner) {
  const s = String(selInner || "");
  const out = [];
  // 1) Formato malformado tipico: value=XX ... <Hn>Texto</Hn>
  const rxH = /<option\b[^>]*?\bvalue=["']?([^"'>\s]+)["']?[^>]*?<[hH]\d>([\s\S]*?)<\/[hH]\d>/gi;
  for (const m of s.matchAll(rxH)) { const nombre = sinTags(m[2]); if (nombre) out.push({ valor: m[1], nombre }); }
  if (out.length) return out;
  // 2) Estandar con cierre </option>.
  const rxStd = /<option\b[^>]*value=["']([^"']*)["'][^>]*>([\s\S]*?)<\/option>/gi;
  for (const m of s.matchAll(rxStd)) { const nombre = sinTags(m[2]); if (nombre) out.push({ valor: m[1], nombre }); }
  if (out.length) return out;
  // 3) Ultra-fallback: value + texto hasta el proximo <option o el cierre </select>.
  const rxLoose = /<option\b[^>]*?\bvalue=["']?([^"'>\s]+)["']?[^>]*>?([\s\S]*?)(?=<option\b|<\/select)/gi;
  for (const m of s.matchAll(rxLoose)) { const nombre = sinTags(m[2]); if (nombre) out.push({ valor: m[1], nombre }); }
  return out;
}

export function parseDia(s) {
  const m = String(s || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const a = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const d = new Date(a, Number(m[2]) - 1, Number(m[1]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
  return isNaN(d) ? null : d;
}

// dd/mm/aaaa para los campos Desde/Hasta (la MEV acepta d/m/aaaa).
export function fmtDia(d) {
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
}

// ── jurisdicciones y organismos ────────────────────────────────────────────────
/**
 * Lee POSloguin.asp y devuelve los departamentos judiciales disponibles:
 * [{ nombre, valor }] (valor = DtoJudElegido). Requiere sesion.
 */
export async function listarDeptos() {
  const html = await getConSesion("/POSloguin.asp");
  const sel = html.match(/<select[^>]*name=["']?DtoJudElegido["']?[^>]*>([\s\S]*?)<\/select>/i);
  if (!sel) return [];
  return parseOptionsMEV(sel[1]);
}

// Resuelve un nombre de depto ("Moron", "San Isidro") a su valor DtoJudElegido.
export async function resolverDepto(nombre) {
  const target = String(nombre).toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").trim();
  const deptos = await listarDeptos();
  const hit = deptos.find((d) => d.nombre.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").includes(target));
  if (!hit) throw new Error(`depto judicial "${nombre}" no encontrado en POSloguin (hay: ${deptos.map((d) => d.nombre).join(", ")})`);
  return hit.valor;
}

/**
 * Entra a una jurisdiccion y devuelve lo que ofrece su busqueda.asp:
 * { organismos:[{nombre,valor}], sets:[{nombre,nidset}] }
 * jur: { depto:<valor o nombre>, penal?:bool, familia?:bool, tipo?:"CC"|"SCJ"|"LPC"|"PZ" }
 */
export async function entrarJurisdiccion(jur) {
  const j = { ...jur, tipo: jur.tipo || "CC" };
  if (j.tipo === "CC" && j.depto && !/^\d+$/.test(String(j.depto))) j.depto = await resolverDepto(j.depto);
  const html = await seleccionarJurisdiccion(j);
  return { jur: j, ...parseBusquedaForm(html) };
}

function parseBusquedaForm(html) {
  const organismos = [];
  const selJuz = html.match(/<select[^>]*name=["']?JuzgadoElegido["']?[^>]*>([\s\S]*?)<\/select>/i);
  if (selJuz) for (const o of parseOptionsMEV(selJuz[1])) organismos.push({ nombre: o.nombre, valor: o.valor }); // valor con padding, no trimear
  const sets = [];
  for (const selName of ["Set", "SetNovedades"]) {
    const sel = html.match(new RegExp(`<select[^>]*name=["']?${selName}["']?[^>]*>([\\s\\S]*?)<\\/select>`, "i"));
    if (!sel) continue;
    for (const o of parseOptionsMEV(sel[1])) {
      const nidset = String(o.valor).trim();
      if (/^\d+$/.test(nidset) && o.nombre && !sets.some((s) => s.nidset === nidset)) sets.push({ nombre: o.nombre, nidset });
    }
  }
  return { organismos, sets };
}

// ── listados de causas (MuestraCausas / resultados) ───────────────────────────
/**
 * Parsea un listado (MuestraCausas.asp o resultados.asp) y devuelve
 * { causas:[{nidCausa,pidJuzgado,caratula,estado,receptoria,expediente,fechaInicio,
 *            ultimoMovimiento:{fecha,descripcion}}], total, sinResultados, excedeLimite }
 */
export function parseListado(html) {
  const out = { causas: [], total: null, sinResultados: false, excedeLimite: false };
  if (/exceden el l/i.test(html) && /1000/.test(html)) out.excedeLimite = true;
  if (/contiene Expedientes de otra Jurisdicci/i.test(html) || /no tiene Expedientes cargad/i.test(html)) out.sinResultados = true;
  const tot = html.match(/Total Expedientes\s*:?\s*(\d+)/i);
  if (tot) out.total = Number(tot[1]);

  // Cada causa = anchor a procesales.asp. El resto de la fila se toma del <tr> contenedor.
  const filas = html.split(/<tr/i);
  for (const fila of filas) {
    const a = fila.match(/href=["']?procesales\.asp\?nidCausa=(\d+)&(?:amp;)?pidJuzgado=([^"'&\s]+)["']?[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const causa = {
      nidCausa: a[1],
      pidJuzgado: decodeURIComponent(a[2]),
      caratula: sinTags(a[3]).replace(/\s*-\s*$/, ""),
      estado: "", receptoria: "", expediente: "", fechaInicio: "",
      ultimoMovimiento: { fecha: "", descripcion: "" },
    };
    // Resto de la fila (y la siguiente, porque el layout usa dos <tr> por causa).
    const idx = filas.indexOf(fila);
    const cuerpo = sinTags(fila + " " + (filas[idx + 1] || ""));
    const nums = [...cuerpo.matchAll(/\b([A-Z]{1,3})\s*-\s*(\d{1,6})\s*-\s*(\d{2,4})\b/g)];
    if (nums[0]) causa.receptoria = `${nums[0][1]} - ${nums[0][2]} - ${nums[0][3]}`;
    if (nums[1]) causa.expediente = `${nums[1][1]} - ${nums[1][2]} - ${nums[1][3]}`;
    const est = cuerpo.match(/\b(EN LETRA|A DESPACHO|FUERA DE LETRA[^0-9]*?|PARALIZAD[OA]|ARCHIVAD[OA][^0-9]*?)\b/i);
    if (est) causa.estado = est[1].trim();
    const fechas = [...cuerpo.matchAll(/\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/g)].map((m) => m[1]);
    if (fechas.length) causa.fechaInicio = fechas[0];
    // Ultimo movimiento: link a proveido con texto "dd/mm/aaaa - DESCRIPCION"
    const um = (fila + (filas[idx + 1] || "")).match(/href=["']?proveido\.asp[^>]*>([\s\S]*?)<\/a>/i);
    if (um) {
      const t = sinTags(um[1]);
      const mm = t.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})\s*-\s*(.+)/);
      if (mm) causa.ultimoMovimiento = { fecha: mm[1], descripcion: mm[2].trim() };
      else causa.ultimoMovimiento = { fecha: "", descripcion: t };
    }
    if (!out.causas.some((c) => c.nidCausa === causa.nidCausa)) out.causas.push(causa);
  }
  return out;
}

// Paginas siguientes de un listado: sigue los links "Siguiente".
function linkSiguiente(html) {
  const m = html.match(/<a[^>]*href=["']?((?:MuestraCausas|resultados)\.asp[^"'>\s]*)["']?[^>]*>\s*Siguiente/i);
  return m ? "/" + decodeEntities(m[1]).replace(/^\//, "") : null;
}

async function listadoCompleto(htmlPrimera, jur, { maxPaginas = 30 } = {}) {
  let html = htmlPrimera;
  const acumulado = parseListado(html);
  let pag = 1;
  let next = linkSiguiente(html);
  while (next && pag < maxPaginas) {
    await sleep(PAUSA);
    html = await getConSesion(next, jur);
    const p = parseListado(html);
    for (const c of p.causas) if (!acumulado.causas.some((x) => x.nidCausa === c.nidCausa)) acumulado.causas.push(c);
    next = linkSiguiente(html);
    pag++;
  }
  return acumulado;
}

/**
 * Busqueda por caratula en un organismo (solo jurisdicciones no penales).
 * jur ya debe estar activa (entrarJurisdiccion). organismo = valor JuzgadoElegido CON padding.
 */
export async function buscarPorCaratula(jur, organismo, criterio, { estado = "Am", maxPaginas = 30 } = {}) {
  const html = await postConSesion("/Busqueda.asp", {
    OpcionBusqueda: "", busca: "", JuzgadoElegido: organismo,
    radio: "xCa", caratula: String(criterio), NCausa: "", NInterno: "",
    TipoCausa: estado, Buscar: "Buscar",
  }, jur, { referer: "/busqueda.asp" });
  return listadoCompleto(html, jur, { maxPaginas });
}

/** Todas las causas de un set (sin filtro de fechas). */
export async function causasDeSet(jur, nidset, { maxPaginas = 30 } = {}) {
  const html = await getConSesion(`/resultados.asp?nidset=${encodeURIComponent(nidset)}&sFechaDesde=&sFechaHasta=&pOrden=xCa&pOrdenAD=Asc`, jur);
  return listadoCompleto(html, jur, { maxPaginas });
}

/**
 * NOVEDADES de un set entre fechas (Date o "d/m/aaaa"): el feed del parte diario.
 * Devuelve las causas del set que registran movimientos en el rango.
 */
export async function novedadesDeSet(jur, nidset, desde, hasta, { maxPaginas = 30 } = {}) {
  const d = desde instanceof Date ? fmtDia(desde) : String(desde);
  const h = hasta instanceof Date ? fmtDia(hasta) : String(hasta);
  const html = await getConSesion(
    `/resultados.asp?nidset=${encodeURIComponent(nidset)}&sFechaDesde=${encodeURIComponent(d)}&sFechaHasta=${encodeURIComponent(h)}&pOrden=xCa&pOrdenAD=Asc`, jur);
  return listadoCompleto(html, jur, { maxPaginas });
}

// ── ficha y pasos procesales ───────────────────────────────────────────────────
/**
 * Ficha de una causa + pasos procesales.
 * Devuelve { caratula, fechaInicio, receptoria, expediente, estado,
 *            pasos:[{nPosi,fecha,fechaHora,descripcion,firmado}] } (pasos: mas reciente primero).
 */
export async function obtenerFicha(jur, nidCausa, pidJuzgado) {
  const html = await getConSesion(`/procesales.asp?nidCausa=${encodeURIComponent(nidCausa)}&pidJuzgado=${encodeURIComponent(pidJuzgado)}`, jur);
  const ficha = { nidCausa: String(nidCausa), pidJuzgado, caratula: "", fechaInicio: "", receptoria: "", expediente: "", estado: "", pasos: [] };
  const car = html.match(/Car[aá]tula\s*:?\s*<\/[^>]+>([\s\S]*?)<\/(td|tr)/i) || html.match(/Car[aá]tula\s*:?\s*([\s\S]*?)<\/(td|tr)/i);
  if (car) ficha.caratula = sinTags(car[1]);
  const fi = html.match(/Fecha inicio\s*:?\s*<\/[^>]+>?\s*([\s\S]*?)<\/(td|tr)/i);
  if (fi) ficha.fechaInicio = (sinTags(fi[1]).match(/\d{1,2}\/\d{1,2}\/\d{2,4}/) || [""])[0];
  const re = html.match(/Recepto[rí]+a\s*:?\s*<\/[^>]+>?\s*([\s\S]*?)<\/(td|tr)/i);
  if (re) ficha.receptoria = sinTags(re[1]);
  const ex = html.match(/N[º°]? de Expediente\s*:?\s*<\/[^>]+>?\s*([\s\S]*?)<\/(td|tr)/i);
  if (ex) ficha.expediente = sinTags(ex[1]);
  const es = html.match(/Estado\s*:?\s*<\/[^>]+>?\s*([\s\S]*?)<\/(td|tr)/i);
  if (es) ficha.estado = sinTags(es[1]);

  // Pasos: anchors a proveido.asp; fecha/hora en la misma fila.
  for (const fila of html.split(/<tr/i)) {
    const a = fila.match(/href=["']?proveido\.asp\?[^"'>]*nPosi=(\d+)[^"'>]*["']?[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const cuerpo = sinTags(fila);
    const f = cuerpo.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?))?/);
    ficha.pasos.push({
      nPosi: a[1],
      fecha: f ? f[1] : "",
      fechaHora: f ? `${f[1]}${f[2] ? " " + f[2] : ""}` : "",
      descripcion: sinTags(a[2]),
      firmado: /firmad/i.test(fila),
    });
  }
  return ficha;
}

/** Texto completo de un paso (proveido). */
export async function obtenerProveido(jur, pidJuzgado, nidCausa, nPosi) {
  const html = await getConSesion(
    `/proveido.asp?pidJuzgado=${encodeURIComponent(pidJuzgado)}&sCodi=${encodeURIComponent(nidCausa)}&nPosi=${encodeURIComponent(nPosi)}&sFile=a&MT=`, jur);
  const out = { nPosi: String(nPosi), referencias: {}, texto: "" };
  const refs = [["fechaEscrito", /Fecha del Escrito\s*<\/[^>]+>?\s*([\s\S]*?)<\/(td|tr)/i],
    ["firmadoPor", /Firmado por\s*<\/[^>]+>?\s*([\s\S]*?)<\/(td|tr)/i],
    ["nroPresentacion", /Nro\.? Presentaci[oó]n Electr[oó]nica\s*<\/[^>]+>?\s*([\s\S]*?)<\/(td|tr)/i],
    ["observacion", /Observaci[oó]n\s*<\/[^>]+>?\s*([\s\S]*?)<\/(td|tr)/i]];
  for (const [k, rx] of refs) { const m = html.match(rx); if (m) out.referencias[k] = sinTags(m[1]); }
  const tx = html.match(/Texto del Prove[ií]do([\s\S]*)$/i);
  if (tx) {
    out.texto = sinTags(tx[1].replace(/-{3,}[^<]*seleccione desde aqu[ií][^<]*-{3,}/i, ""))
      .replace(/\s*(<<\s*Volver|Desconectarse|Imprimir).*$/i, "").trim().slice(0, 8000);
  }
  return out;
}

// ── diff de novedades (mismo contrato que eje-client) ─────────────────────────
/**
 * Pasos nuevos de una causa respecto de un corte { nPosi } o { fecha:Date }.
 * corte null = primera corrida (linea de base): devuelve [] y el bot registra el ultimo.
 */
export async function pasosNuevos(jur, causa, corte) {
  const ficha = await obtenerFicha(jur, causa.nidCausa, causa.pidJuzgado);
  if (!corte) return { ficha, nuevos: [] };
  const nuevos = [];
  for (const p of ficha.pasos) {
    if (corte.nPosi && String(p.nPosi) === String(corte.nPosi)) break;
    if (!corte.nPosi && corte.fecha instanceof Date) {
      const f = parseDia(p.fechaHora || p.fecha);
      if (f && f.getTime() <= corte.fecha.getTime()) break;
    }
    nuevos.push(p);
  }
  return { ficha, nuevos };
}

export function endpointsEnUso() {
  return {
    modo: hayCredenciales() ? "AUTENTICADO (unico modo: la MEV requiere login)" : "SIN CREDENCIALES (no funciona)",
    login: "POST /loguin.asp?familiadepto= (usuario, clave, DeptoRegistrado)",
    jurisdiccion: "POST /POSLoguin.asp (TipoDto, DtoJudElegido, TipoF, TipoP)",
    busqueda: "POST /Busqueda.asp (radio=xCa|xSb|xNs, ...)",
    listado: "GET /MuestraCausas.asp | GET /resultados.asp?nidset&sFechaDesde&sFechaHasta",
    ficha: "GET /procesales.asp?nidCausa&pidJuzgado",
    texto: "GET /proveido.asp?pidJuzgado&sCodi&nPosi&sFile=a",
  };
}

export { login, seleccionarJurisdiccion };
