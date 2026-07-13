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
// Tabla orientativa de pena MAXIMA (anios) por articulo del CP (y algunas leyes
// penales especiales), con flag de suspension por victima menor (art. 67, delitos
// sexuales) y de pena perpetua (art. 62 inc. 1 -> termino 15). TODAS las penas son
// PREFILL [VERIFICAR VIGENCIA]: las escalas cambian por reforma y varian por inciso/
// agravante. El abogado confirma o pisa con "Pena Max (anios)" en la cartera.
// "max" es el maximo de la escala; el termino de prescripcion lo deriva terminoArt62.
export const TABLA_PENAS = {
  // --- Contra las personas (vida e integridad fisica) ---
  "79":  { max: 25 },                 // homicidio simple (8-25)
  "80":  { max: 25, perpetua: true }, // homicidio agravado/calificado; femicidio (perpetua) -> termino 15
  "81":  { max: 6 },                  // emocion violenta / preterintencional
  "84":  { max: 5 },                  // homicidio culposo
  "84bis": { max: 6 },                // homicidio culposo por conduccion
  "85":  { max: 10 },                 // aborto (sin consentimiento 3-10)
  "89":  { max: 1 },                  // lesiones leves (1 mes-1a) -> piso 2 (art.62.2)
  "90":  { max: 6 },                  // lesiones graves
  "91":  { max: 10 },                 // lesiones gravisimas
  "94":  { max: 3 },                  // lesiones culposas
  "94bis": { max: 4 },                // lesiones culposas por conduccion
  "106": { max: 10 },                 // abandono de persona (agravado por muerte 5-15)
  // --- Contra el honor (solo multa -> termino 2, art. 62 inc. 5) ---
  "109": { max: 1 }, "110": { max: 1 }, // calumnias / injurias
  // --- Integridad sexual (119 desagregado por parrafo; ver parrafoDe) ---
  "119.1":   { max: 4,  menor: true }, // abuso sexual simple (6m-4a)
  "119.2":   { max: 10, menor: true }, // gravemente ultrajante (4-10)
  "119.3":   { max: 15, menor: true }, // acceso carnal (6-15) -> termino topea 12
  "119.ult": { max: 20, menor: true }, // agravado (ej. resultado muerte)
  "120": { max: 6,  menor: true },     // estupro
  "125": { max: 10, menor: true },     // corrupcion de menores
  "125bis": { max: 15, menor: true },  // promocion/facilitacion prostitucion (agravada)
  "127": { max: 10, menor: true },     // explotacion de la prostitucion
  "128": { max: 6,  menor: true },     // pornografia infantil (produccion/distribucion)
  "129": { max: 4,  menor: true },     // exhibiciones obscenas (ante menor)
  "130": { max: 4,  menor: true },     // rapto
  "131": { max: 4,  menor: true },     // grooming
  // --- Contra la libertad ---
  "140": { max: 15 },                 // reduccion a servidumbre/esclavitud
  "141": { max: 3 },                  // privacion ilegitima de la libertad
  "142": { max: 6 },                  // privacion agravada
  "142bis": { max: 25 },              // secuestro coactivo (agravado hasta 25)
  "144ter": { max: 25 },              // torturas (8-25)
  "145bis": { max: 15, menor: true }, // trata de personas
  "146": { max: 15, menor: true },    // sustraccion/retencion de menores
  "149bis": { max: 2 },               // amenazas
  "149ter": { max: 6 },               // coaccion agravada
  "150": { max: 2 },                  // violacion de domicilio
  "153": { max: 2 },                  // violacion de correspondencia/comunicaciones
  "153bis": { max: 1 },               // acceso ilegitimo a sistema informatico
  "156": { max: 2 },                  // violacion de secreto profesional
  "157bis": { max: 4 },               // datos personales
  // --- Contra la propiedad ---
  "162": { max: 2 },                  // hurto
  "163": { max: 6 },                  // hurto agravado / abigeato
  "164": { max: 6 },                  // robo
  "165": { max: 25 },                 // robo con homicidio (10-25)
  "166": { max: 15 },                 // robo agravado (armas/lesiones)
  "167": { max: 10 },                 // robo agravado (despoblado/banda)
  "168": { max: 10 },                 // extorsion
  "169": { max: 8 },                  // chantaje
  "170": { max: 25, perpetua: true }, // secuestro extorsivo (agravado por muerte, perpetua)
  "172": { max: 6 },                  // estafa
  "173": { max: 6 },                  // defraudaciones especiales
  "174": { max: 6 },                  // defraudacion agravada
  "175": { max: 2 },                  // defraudacion menor
  "176": { max: 6 },                  // quiebra fraudulenta
  "177": { max: 4 },                  // quiebra culpable
  "179": { max: 6 },                  // insolvencia fraudulenta
  "181": { max: 3 },                  // usurpacion
  "182": { max: 4 },                  // usurpacion de aguas
  "183": { max: 1 },                  // daño
  "184": { max: 4 },                  // daño agravado
  // --- Seguridad publica / salud publica ---
  "186": { max: 20 },                 // incendio / estrago (con muerte 8-20)
  "189bis": { max: 8 },               // tenencia/portacion/acopio de armas
  "190": { max: 15 },                 // pirateria / atentado a la seguridad del transporte
  "193bis": { max: 3 },               // picadas (prueba de velocidad)
  "200": { max: 10 },                 // envenenar/adulterar aguas o alimentos
  "201": { max: 10 },                 // adulteracion de medicamentos
  "202": { max: 15 },                 // propagacion de enfermedad peligrosa
  // --- Orden publico ---
  "209": { max: 5 },                  // instigacion a cometer delitos / apologia
  "210": { max: 10 },                 // asociacion ilicita
  "211": { max: 6 },                  // intimidacion publica
  // --- Administracion publica ---
  "237": { max: 3 },                  // atentado contra la autoridad
  "239": { max: 1 },                  // resistencia / desobediencia
  "248": { max: 2 },                  // abuso de autoridad
  "256": { max: 6 },                  // cohecho (pasivo/activo)
  "257": { max: 12 },                 // cohecho agravado (magistrado)
  "261": { max: 10 },                 // peculado / malversacion (2-10)
  "265": { max: 6 },                  // negociaciones incompatibles
  "266": { max: 4 },                  // exacciones ilegales
  "268(2)": { max: 6 },               // enriquecimiento ilicito
  "275": { max: 10 },                 // falso testimonio (agravado en causa criminal)
  "277": { max: 3 },                  // encubrimiento (agravado hasta 6)
  // --- Fe publica ---
  "282": { max: 15 },                 // falsificacion de moneda (3-15)
  "289": { max: 6 },                  // falsificacion de sellos/marcas/timbres
  "292": { max: 6 },                  // falsificacion de documento
  "293": { max: 6 },                  // falsedad ideologica
  "296": { max: 6 },                  // uso de documento falso
  "300": { max: 2 },                  // balances/estados contables falsos
  "303": { max: 10 },                 // lavado de activos (3-10)
  // --- Leyes penales especiales frecuentes (clave = etiqueta legible) ---
  "Ley 23.737 (comercio)":         { max: 15 }, // trafico/comercio/tenencia con fines (art. 5)
  "Ley 23.737 (tenencia)":         { max: 6 },  // tenencia simple (art. 14, 1er parr.)
  "Ley 23.737 (tenencia consumo)": { max: 2 },  // tenencia para consumo personal (art. 14, 2do parr.)
  "Ley 13.944 (asistencia familiar)": { max: 2 }, // incumplimiento deberes de asistencia familiar
  "Ley penal tributaria":          { max: 9 },  // evasion agravada (Ley 27.430, tit. IX)
};

// Termino de prescripcion (anios) segun art. 62 para pena temporal (prision/reclusion):
// tope 12, piso 2 (inc. 2). Si es PERPETUA -> 15 (inc. 1). Inhabilitacion/multa: el
// abogado carga el plazo (5/1 y 2 respectivamente).
export function terminoArt62(penaMaxAnios, perpetua = false) {
  if (perpetua) return 15;
  const p = Number(penaMaxAnios);
  if (!Number.isFinite(p) || p <= 0) return null;
  return Math.min(12, Math.max(2, p));
}

// Diccionario NOMBRE del delito -> articulo del CP (o etiqueta de ley especial). Las
// caratulas penales traen el delito por nombre ("s/ HURTO", "s/ AMENAZAS"), no el numero.
// ORDEN: del mas especifico al mas generico. "not" excluye el match generico cuando hay un
// calificante atenuante (ej. "homicidio culposo" NO debe caer en el homicidio simple).
// Solo se mapean delitos cuya pena esta en TABLA_PENAS.
export const TABLA_DELITOS = [
  // Delitos por nombre (CP + leyes especiales). Vida:
  { rx: /femicidio|homicidio\s+(agravad|calificad)|homicidio.*(alevos|ensa|criminis|precio|placer)/, art: "80" },
  { rx: /homicidio.*(transito|conduccion|volante|vehicul)/, art: "84bis" },
  { rx: /homicidio\s+culpos|homicidio.*culpa/, art: "84" },
  { rx: /homicidio.*(emocion violenta|preterintencional)/, art: "81" },
  { rx: /\bhomicidio\b/, art: "79", not: /culpos|emocion violenta|preterinten|agravad|calificad|\brobo\b|ocasion de robo/ },
  { rx: /\baborto\b/, art: "85" },
  // Integridad fisica
  { rx: /lesiones\s+gravisimas/, art: "91" },
  { rx: /lesiones\s+graves/, art: "90" },
  { rx: /lesiones\s+culpos/, art: "94" },
  { rx: /lesiones/, art: "89", not: /gravisim|graves|culpos/ },
  { rx: /abandono de persona/, art: "106" },
  // Honor
  { rx: /calumnia/, art: "109" }, { rx: /injuria/, art: "110" },
  // Integridad sexual
  { rx: /abuso sexual.*(acceso carnal)|acceso carnal|\bviolacion\b/, art: "119.3" },
  { rx: /abuso sexual.*(gravemente ultrajante|sometimiento)/, art: "119.2" },
  { rx: /abuso sexual|ultraje sexual/, art: "119.1" },
  { rx: /\bestupro\b/, art: "120" },
  { rx: /corrupcion de menor/, art: "125" },
  { rx: /(promocion|facilitacion).*prostitucion|proxenetismo|rufian/, art: "125bis" },
  { rx: /explotacion.*(prostitucion|sexual)/, art: "127" },
  { rx: /pornografia infantil|representacion.*menor.*(sexual|explicit)/, art: "128" },
  { rx: /exhibicion(es)? obscen/, art: "129" },
  { rx: /\brapto\b/, art: "130" },
  { rx: /grooming|contacto.*tecnolog.*menor/, art: "131" },
  // Libertad
  { rx: /reduccion a servidumbre|esclavitud/, art: "140" },
  { rx: /secuestro coactivo|toma de rehen/, art: "142bis" },
  { rx: /privacion (ilegitima|ilegal) de (la )?libertad.*(agravad|violencia|amenaza)/, art: "142" },
  { rx: /privacion (ilegitima|ilegal) de (la )?libertad/, art: "141", not: /agravad|violencia|amenaza/ },
  { rx: /tortura|apremios ilegales|vejaciones|severidades/, art: "144ter" },
  { rx: /trata de personas/, art: "145bis" },
  { rx: /sustraccion de menor|retencion.*ocultacion.*menor/, art: "146" },
  { rx: /coaccion/, art: "149ter" },
  { rx: /\bamenaza/, art: "149bis" },
  { rx: /violacion de domicilio|allanamiento ilegal/, art: "150" },
  { rx: /violacion de (correspondencia|secretos|comunicaciones)/, art: "153" },
  { rx: /acceso (ilegitimo|indebido).*sistema|hackeo/, art: "153bis" },
  { rx: /violacion de secreto profesional/, art: "156" },
  { rx: /datos personales|base de datos/, art: "157bis" },
  // Propiedad
  { rx: /robo.*(homicidio|muerte)/, art: "165" },
  { rx: /robo.*(arma|lesion|efractur|escalamiento|perforacion)/, art: "166" },
  { rx: /robo.*(despoblado|banda|llave|ganzua)/, art: "167" },
  { rx: /\brobo\b/, art: "164", not: /homicidio|muerte|banda|efractur/ },
  { rx: /hurto agravado|abigeato/, art: "163" },
  { rx: /\bhurto\b/, art: "162", not: /agravado|abigeato/ },
  { rx: /secuestro extorsivo/, art: "170" },
  { rx: /extorsion/, art: "168" },
  { rx: /chantaje/, art: "169" },
  { rx: /administracion fraudulenta/, art: "173" },
  { rx: /defraudacion|desbaratamiento de derechos/, art: "173" },
  { rx: /estafa/, art: "172" },
  { rx: /insolvencia fraudulenta/, art: "179" },
  { rx: /quiebra fraudulenta|bancarrota/, art: "176" },
  { rx: /quiebra culpable/, art: "177" },
  { rx: /usurpacion de agua/, art: "182" },
  { rx: /usurpacion/, art: "181", not: /agua/ },
  { rx: /daño agravado/, art: "184" },
  { rx: /\bdaño\b/, art: "183", not: /agravado/ },
  // Seguridad publica
  { rx: /incendio|estrago|explosion/, art: "186" },
  { rx: /(portacion|tenencia|acopio).*arma|abuso de arma/, art: "189bis" },
  { rx: /pirateria/, art: "190" },
  { rx: /picada|prueba de velocidad/, art: "193bis" },
  { rx: /envenen|adulteracion.*(agua|aliment)/, art: "200" },
  { rx: /adulteracion.*medicamento/, art: "201" },
  { rx: /propagacion.*enfermedad|contagio/, art: "202" },
  // Orden publico
  { rx: /instigacion a cometer delito|apologia del (crimen|delito)/, art: "209" },
  { rx: /asociacion ilicita/, art: "210" },
  { rx: /intimidacion publica/, art: "211" },
  // Administracion publica
  { rx: /atentado.*autoridad/, art: "237" },
  { rx: /resistencia.*autoridad|desobediencia/, art: "239" },
  { rx: /abuso de autoridad|abuso funcional/, art: "248" },
  { rx: /cohecho.*(juez|magistrad)/, art: "257" },
  { rx: /cohecho|soborno/, art: "256", not: /juez|magistrad/ },
  { rx: /peculado|malversacion/, art: "261" },
  { rx: /negociaciones incompatibles/, art: "265" },
  { rx: /exacciones ilegales/, art: "266" },
  { rx: /enriquecimiento ilicito/, art: "268(2)" },
  { rx: /falso testimonio/, art: "275" },
  { rx: /encubrimiento/, art: "277", not: /lavado/ },
  // Fe publica
  { rx: /falsificacion de moneda/, art: "282" },
  { rx: /falsedad ideologica/, art: "293" },
  { rx: /uso de documento (falso|adulterado)/, art: "296" },
  { rx: /(falsificacion|adulteracion) de (documento|instrumento)/, art: "292" },
  { rx: /falsificacion.*(sello|marca|timbre)/, art: "289" },
  { rx: /balance(s)? falso|estados contables falsos/, art: "300" },
  { rx: /lavado de (activos|dinero)/, art: "303" },
  // Leyes especiales
  { rx: /(comercio|trafico|venta|siembra|almacenamiento|entrega).*estupefaciente|tenencia.*fin.*(comercial|venta)|narcotrafico/, art: "Ley 23.737 (comercio)" },
  { rx: /tenencia.*(consumo personal|uso personal)|estupefaciente.*consumo/, art: "Ley 23.737 (tenencia consumo)" },
  { rx: /tenencia.*estupefaciente|estupefaciente|ley 23\.?737|infraccion.*23\.?737/, art: "Ley 23.737 (tenencia)", not: /consumo personal|uso personal|fin.*(comercial|venta)/ },
  { rx: /incumplimiento de los deberes de asistencia familiar|asistencia familiar|cuota alimentaria|ley 13\.?944/, art: "Ley 13.944 (asistencia familiar)" },
  { rx: /evasion (tributaria|fiscal|impositiva|previsional)|ley penal tributaria|apropiacion indebida.*(tribut|recurso)/, art: "Ley penal tributaria" },
];

// Articulos que surgen de los NOMBRES de delito presentes en el texto (puede haber
// varios: concurso). Devueltos ordenados por pena maxima DESC, para que el llamador
// tome el mas grave (termino de prescripcion mas largo = criterio conservador).
export function articulosPorNombre(texto) {
  const t = norm(texto);
  const arts = [];
  for (const d of TABLA_DELITOS) {
    if (!d.rx.test(t)) continue;
    if (d.not && d.not.test(t)) continue;
    if (!arts.includes(d.art)) arts.push(d.art);
  }
  const penaDe = (a) => (TABLA_PENAS[a]?.perpetua ? 99 : (TABLA_PENAS[a]?.max ?? 0));
  return arts.sort((a, b) => penaDe(b) - penaDe(a));
}

// Extrae el articulo del delito o la caratula. Primero por numero explicito ("art. 89",
// "SOBRE 89"); si no hay, por el NOMBRE del delito (concurso -> el de mayor pena).
export function articuloDe(delito, caratula) {
  const t = norm(`${delito} ${caratula}`);
  const m = t.match(/(?:art\.?\s*)(\d{2,3}\s*(?:bis|ter)?)/) || t.match(/\b(\d{2,3}\s*(?:bis|ter)?)\b/);
  if (m && (TABLA_PENAS[m[1].replace(/\s+/g, "")] || /bis|ter/.test(m[1]))) return m[1].replace(/\s+/g, "");
  const porNombre = articulosPorNombre(t);
  if (porNombre.length) return porNombre[0];
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
