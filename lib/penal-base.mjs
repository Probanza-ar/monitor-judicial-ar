/**
 * penal-base.mjs - Nucleo normativo penal COMPARTIDO (Codigo Penal nacional, arts. 62-67).
 *
 * El CP rige en los 3 fueros (Nacion, CABA, Provincia): la prescripcion de la accion se
 * computa igual en todos. Este modulo centraliza la parte que NO debe duplicarse ni
 * desincronizarse: tabla de penas, termino del art. 62, y deteccion de actos interruptivos
 * (art. 67) y de cierre desde las actuaciones. Lo usan prescripcion-penal-eje.mjs (EJE) y
 * penal.mjs (PJN), y lo usara el frente SCBA.
 *
 * Base: CP Ley 11.179 (InfoLEG idNorma 16546, texto actualizado; art. 67 t. Ley 27.206)
 * [VERIFICAR VIGENCIA]. Detalle en reglas-plazos.mjs (PRESCRIPCION_PENAL).
 */
export const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\s+/g, " ").trim();

export function parseFecha(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) return v;
  if (typeof v === "object" && v.result instanceof Date) return v.result;
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);
  if (m) { const a = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]); const d = new Date(a, Number(m[2]) - 1, Number(m[1])); return isNaN(d) ? null : d; }
  const d = new Date(s); return isNaN(d) ? null : d;
}

export function sumarAnios(fecha, anios) {
  const d = new Date(fecha.getTime()); const dia = d.getDate();
  d.setFullYear(d.getFullYear() + Math.trunc(anios));
  const frac = anios - Math.trunc(anios);
  if (frac) d.setDate(d.getDate() + Math.round(frac * 365));
  if (d.getDate() < dia && frac === 0) d.setDate(0);
  return d;
}

// Tabla orientativa de pena maxima (anios) y suspension por victima menor (art. 67), por
// articulo del CP. PREFILL marcado [VERIFICAR VIGENCIA]: las penas cambian por reforma; el
// abogado confirma o pisa. Ampliar segun cartera de cada colega.
export const TABLA_PENAS = {
  "89":  { max: 1,  menor: false }, // lesiones leves (1 mes a 1 anio) -> piso 2 anios (art.62.2)
  "90":  { max: 6,  menor: false }, // lesiones graves
  "91":  { max: 10, menor: false }, // lesiones gravisimas
  // 119 tiene escalas MUY distintas por parrafo: sin desagregar, todo caia en el 1er parrafo
  // (4 anios), lo que subestimaba en hasta 8 anios el termino de prescripcion de los parrafos
  // agravados. No se deja una entrada generica "119": si buscarPena() no identifica el
  // parrafo, debe devolver null y forzar la revision manual (ver penal.mjs).
  "119.1":   { max: 4,  menor: true }, // 1er parrafo (abuso sexual simple): 6m-4a
  "119.2":   { max: 10, menor: true }, // 2do parrafo (sometimiento gravemente ultrajante): 4-10a
  "119.3":   { max: 15, menor: true }, // 3er parrafo (acceso carnal): 6-15a -> termino topea en 12 (art.62.2)
  "119.ult": { max: 20, menor: true }, // ultimo parrafo (agravantes, ej. resultado muerte): hasta 20a -> topea en 12
  "120": { max: 6,  menor: true },
  "125": { max: 10, menor: true },
  "128": { max: 6,  menor: true },  // pornografia infantil (produccion/publicacion), 3-6a
  "149bis": { max: 2, menor: false }, // amenazas
  "162": { max: 2,  menor: false }, // hurto
  "164": { max: 6,  menor: false }, // robo
  "172": { max: 6,  menor: false }, // estafa
  "173": { max: 6,  menor: false }, // defraudaciones especiales (remiten a la escala del 172: 1m-6a)
};

// Termino de prescripcion (anios) segun art. 62 para pena temporal (prision/reclusion).
// tope 12, piso 2 (art. 62 inc. 2). Perpetua/inhab/multa: el abogado carga el plazo.
export function terminoArt62(penaMaxAnios) {
  const p = Number(penaMaxAnios);
  if (!Number.isFinite(p) || p <= 0) return null;
  return Math.min(12, Math.max(2, p));
}

// Extrae el primer numero de articulo del delito o la caratula ("SOBRE 89 - ...").
export function articuloDe(delito, caratula) {
  const m = norm(`${delito} ${caratula}`).match(/(?:art\.?\s*)?(\d{2,3}\s*(?:bis|ter)?)/);
  return m ? m[1].replace(/\s+/g, "") : "";
}

// Detecta el PARRAFO cuando el texto lo menciona explicitamente (ordinal + "parrafo", o
// "in fine"/"ultimo parrafo"), para articulos con escalas diferenciadas por parrafo (ej.
// 119). Devuelve "1" | "2" | "3" | "ult" | "" (no detectado -> el llamador debe pedir
// revision, no asumir el 1er parrafo). Heuristica: en la practica el parrafo casi nunca
// figura en la caratula; sirve sobre todo cuando se carga a mano en "Delito (art. CP)"
// (ej. "119 3er parrafo", "119 (3)").
// [°º]? opcional pegado al numero ordinal: las caratulas reales del PJN vienen como
// "119 2° PARRAFO" (el simbolo de grado pegado al digito, antes del espacio), y sin este
// opcional el \s* que sigue al digito no matchea -> el parrafo no se detectaba NUNCA en
// caratulas reales, solo en texto sintetico sin el simbolo.
const RX_PARRAFO = [
  { rx: /ultimo[°º]?\s*parr(?:afo)?\.?|in\s*fine/, val: "ult" },
  { rx: /(?:3[°º]?\s*(?:er|ro|ero)?|tercer)\s*parr(?:afo)?\.?|\(\s*3\s*\)/, val: "3" },
  { rx: /(?:2[°º]?\s*(?:do)?|segundo)\s*parr(?:afo)?\.?|\(\s*2\s*\)/, val: "2" },
  { rx: /(?:1[°º]?\s*(?:er|ro|ero)?|primer)\s*parr(?:afo)?\.?|\(\s*1\s*\)/, val: "1" },
];
export function parrafoDe(delito, caratula) {
  const t = norm(`${delito} ${caratula}`);
  for (const p of RX_PARRAFO) if (p.rx.test(t)) return p.val;
  return "";
}
export const ETIQUETA_PARRAFO = { "1": "1er parrafo", "2": "2do parrafo", "3": "3er parrafo", ult: "ultimo parrafo" };

// Busca la pena en TABLA_PENAS: primero por "articulo.parrafo" (si hay parrafo detectado
// o cargado a mano), y solo si eso no existe cae al articulo pelado. Para articulos
// desagregados por parrafo (119) NO hay entrada pelada: si no se identifico el parrafo,
// esto devuelve null a proposito, para que el llamador lo trate como dato faltante y lo
// marque en el parte en vez de omitir la causa sin aviso (ver calcularPenal en penal.mjs).
export function buscarPena(articulo, parrafo) {
  if (!articulo) return null;
  if (parrafo && TABLA_PENAS[`${articulo}.${parrafo}`]) return TABLA_PENAS[`${articulo}.${parrafo}`];
  return TABLA_PENAS[articulo] || null;
}

// Ruido: escritos de parte, constancias, cedulas, oficios, pedidos. No son actos
// jurisdiccionales; evita falsos positivos ("SOLICITA SE DICTE SENTENCIA", etc.).
export const RX_RUIDO = /\bescrit\b|solicita|se dicte|\bpide\b|reitera|incomparecencia|constancia|\bcedula\b|\boficio\b|\binforme\b|certificad|recepcion|adjunt/;
// Actos que INTERRUMPEN (art. 67 CP), version jurisdiccional. Conservador.
export const RX_INTERRUP = [
  { rx: /declaracion indagatoria|intimacion del hecho\b|audiencia de intimacion/, tipo: "indagatoria/intimacion del hecho" },
  { rx: /requerimiento de (elevacion a )?juicio|requerimiento de elevacion/, tipo: "requerimiento de juicio" },
  { rx: /auto de citacion a juicio|citacion a juicio\b|apertura del debate|admisibilidad de (la )?prueba/, tipo: "citacion a juicio" },
  { rx: /sentencia condenatoria|\bcondena\b/, tipo: "sentencia condenatoria" },
];
// Eventos TERMINALES o suspensivos (se leen de las actuaciones; el "estado" del portal suele
// estar desactualizado).
export const RX_CIERRE = [
  { rx: /extincion de la accion|extincion de accion/, tipo: "extincion de la accion" },
  { rx: /sobreseimiento|sobresee/, tipo: "sobreseimiento" },
  { rx: /prescripcion|prescribe|prescript/, tipo: "prescripcion declarada" },
  { rx: /suspension del? proceso a prueba|proceso a prueba/, tipo: "suspension del proceso a prueba" },
  { rx: /\bcondena\b|condenatoria|avenimiento/, tipo: "condena" },
];

// Devuelve el match MAS RECIENTE de una lista de patrones sobre las actuaciones (o null).
export function detectarUltimo(actuaciones, patrones, { excluirRuido = false } = {}) {
  let best = null;
  for (const a of actuaciones || []) {
    const t = norm(`${a.titulo} ${a.codigo}`);
    if (excluirRuido && RX_RUIDO.test(t)) continue;
    for (const p of patrones) {
      if (p.rx.test(t)) {
        const f = parseFecha(a.fechaFirma || a.fechaPublicacion);
        if (f && (!best || f > best.fecha)) best = { fecha: f, tipo: p.tipo, titulo: a.titulo || "" };
        break;
      }
    }
  }
  return best;
}
export const detectarInterrupcion = (acts) => detectarUltimo(acts, RX_INTERRUP, { excluirRuido: true });
export const detectarCierre = (acts) => detectarUltimo(acts, RX_CIERRE, { excluirRuido: false });
