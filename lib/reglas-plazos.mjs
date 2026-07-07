/**
 * reglas-plazos.mjs - Fuente UNICA de reglas de plazos por jurisdiccion (los 3 fueros:
 * Nacion/PJN, CABA/EJE, Provincia de Buenos Aires/SCBA). La usan los motores de caducidad
 * y prescripcion de los distintos bots, para no duplicar ni desincronizar las reglas.
 *
 * Cada regla lleva su norma, su estado de verificacion y marcadores de integridad. NO es
 * asesoramiento: es la base normativa que el motor aplica y que el abogado confirma.
 *
 * ── CADUCIDAD DE INSTANCIA ─────────────────────────────────────────────────────────────
 * NACION (CPCCN, Dec-Ley 17.454 t.o. 1981, InfoLEG idNorma 16547; art. 310 sust. Ley 25.488)
 *   [VERIFICAR VIGENCIA]:
 *     art. 310: 6 meses (1ra/unica inst.); 3 meses (2da/ulterior, sumarisimo, ejecutivo,
 *       ejecuciones especiales, incidentes); 1 mes (incidente de caducidad).
 *     art. 311: se cuentan desde el ultimo acto impulsorio; corren en dias inhabiles salvo
 *       feria (se descuenta); se descuenta el tiempo de suspension/paralizacion.
 *     Opera de PLENO DERECHO (art. 313); se acusa (no hay intimacion previa legal).
 *
 * CABA - fuero CAyT (Ley 189, t.c.; InfoLEG no cubre CABA; SAIJ: cuerpo vigente, mod. Ley
 *   6.402/2020) [VERIFICAR VIGENCIA - articulado por texto consolidado]:
 *     art. 216: 6 meses de inactividad imputable al ACTOR -> el tribunal INTIMA -> 30 dias
 *       para acreditar prosecucion -> si no, caducidad. No en colectivos/interes publico.
 *     art. 122: plazos en dias habiles judiciales; feria/inhabiles se descuentan.
 *     BIFASICA (intimacion + 30 dias habiles).
 *
 * PROVINCIA DE BUENOS AIRES (CPCC, Dec-Ley 7.425/68 VIGENTE CON MODIFICACIONES;
 *   arts. 310/315 t. Ley 13.986 y 311 t. Ley 12.357; TEXTO LITERAL verificado en el
 *   consolidado oficial normas.gba.gob.ar, jul-2026):
 *     art. 310 (t. Ley 13.986): 6 meses (1ra/unica inst.); 3 meses (2da/ulterior inst. y
 *       Justicia de Paz); 3 meses (procesos sumarios, sumarisimos y juicio ejecutivo); o el
 *       plazo en que se opere la prescripcion de la accion, si fuere menor.
 *     art. 311 (t. Ley 12.357): se computa desde la ultima peticion/resolucion/actuacion
 *       impulsoria; CORRE EN DIAS INHABILES SALVO LAS FERIAS JUDICIALES (se descuentan); se
 *       descuenta el tiempo de paralizacion/suspension por acuerdo o por el juez. (El bot usa
 *       meses corridos con feria descontada: criterio conservador consistente con el texto.)
 *     art. 315 (t. Ley 13.986): la caducidad NO se declara de plano. La pide, por UNICA VEZ,
 *       el demandado (1ra inst.), el contrario del promotor (incidentes) o la parte recurrida
 *       (recursos), antes de consentir actuacion posterior al vencimiento. Se sustancia con
 *       INTIMACION PREVIA por unica vez: 5 dias para manifestar intencion de continuar y
 *       producir actividad util, bajo apercibimiento de caducidad. 2da fase: si la intimada
 *       activa y luego pasa igual plazo sin actividad util, se decreta a pedido o DE OFICIO.
 *       BIFASICA. (Nota: en 1ra instancia la primera peticion es de PARTE, no de oficio.)
 *
 * ── PRESCRIPCION DE LA ACCION PENAL ────────────────────────────────────────────────────
 * NACIONAL para los 3 fueros: el Codigo Penal (Ley 11.179, InfoLEG idNorma 16546; art. 67
 *   sust. Ley 27.206) rige en Nacion, CABA y Provincia. Ver base en prescripcion-penal.
 */

// Claves de jurisdiccion usadas por los bots.
export const JURIS = { NACION: "nacion", CABA_CAYT: "caba_cayt", PBA: "pba" };

// Deteccion de jurisdiccion por fuero/caratula/tipo (best-effort; el bot ya sabe la suya).
export function detectarJurisdiccion({ portal, fuero = "", caratula = "" } = {}) {
  if (portal === "eje") return JURIS.CABA_CAYT;
  if (portal === "scba" || portal === "mev") return JURIS.PBA;
  if (portal === "pjn") return JURIS.NACION;
  const t = `${fuero} ${caratula}`.toLowerCase();
  if (/caba|ciudad|cayt|contencioso administrativo y tributario/.test(t)) return JURIS.CABA_CAYT;
  if (/provincia|buenos aires|la plata|departamento judicial|scba/.test(t)) return JURIS.PBA;
  return JURIS.NACION;
}

// Reglas de CADUCIDAD DE INSTANCIA por jurisdiccion.
export const CADUCIDAD = {
  [JURIS.NACION]: {
    etiqueta: "Nacion (CPCCN art. 310/311)",
    norma: "art. 310/311 CPCCN [VERIFICAR VIGENCIA]",
    unidad: "meses",
    plazos: { primera: 6, segunda: 3, sumarisimo: 3, ejecutivo: 3, incidente: 3, incidenteCaducidad: 1, default: 6 },
    computo: "corrido",          // meses corridos
    descuentaFeria: true,
    intimacionPrevia: null,      // opera de pleno derecho; se acusa
    excluyeFueros: ["penal", "laboral"],
    feriaSource: "ferias-judiciales.json",
    verificacion: "verificado (InfoLEG 16547)",
  },
  [JURIS.CABA_CAYT]: {
    etiqueta: "CABA CAyT (Ley 189 art. 216/122)",
    norma: "art. 216/122 Ley 189 [VERIFICAR VIGENCIA]",
    unidad: "meses",
    plazos: { primera: 6, segunda: 6, default: 6 },
    computo: "corrido",
    descuentaFeria: true,
    intimacionPrevia: { dias: 30, unidad: "habiles", norma: "art. 216 Ley 189" },
    excluyeFueros: ["penal", "contravencional", "faltas"],
    excluyeAmparo: true,         // Ley 2145 (vigente, SAIJ)
    feriaSource: "feria-caba.json",
    verificacion: "cuerpo vigente; articulado a confirmar por texto consolidado",
  },
  [JURIS.PBA]: {
    etiqueta: "Prov. Buenos Aires (CPCC art. 310/315, Dec-Ley 7.425/68 t. Ley 13.986)",
    norma: "arts. 310/311/315 CPCC BA (Dec-Ley 7.425/68; 310 y 315 t. Ley 13.986; 311 t. Ley 12.357)",
    unidad: "meses",
    plazos: { primera: 6, segunda: 3, justiciaPaz: 3, sumario: 3, sumarisimo: 3, ejecutivo: 3, default: 6 },
    computo: "corrido",
    descuentaFeria: true,
    intimacionPrevia: { dias: 5, unidad: "habiles", norma: "art. 315 CPCC BA" },
    excluyeFueros: ["penal", "laboral"],
    feriaSource: "feria-pba.json",
    verificacion: "VERIFICADO texto literal (normas.gba.gob.ar consolidado, jul-2026): arts. 310/311/315 confirmados",
  },
};

// Resuelve el plazo (en meses) segun jurisdiccion + tipo de proceso/instancia detectado.
export function plazoCaducidadMeses(juris, { texto = "" } = {}) {
  const reglas = CADUCIDAD[juris] || CADUCIDAD[JURIS.NACION];
  const t = String(texto).toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
  if (/incidente de caducidad/.test(t) && reglas.plazos.incidenteCaducidad) return reglas.plazos.incidenteCaducidad;
  if (/justicia de paz|juzgado de paz/.test(t) && reglas.plazos.justiciaPaz) return reglas.plazos.justiciaPaz;
  if (/ejecutiv|ejecucion especial|apremio/.test(t) && reglas.plazos.ejecutivo) return reglas.plazos.ejecutivo;
  if (/sumarisim/.test(t) && reglas.plazos.sumarisimo) return reglas.plazos.sumarisimo;
  if (/sumario/.test(t) && reglas.plazos.sumario) return reglas.plazos.sumario;
  if (/incidente/.test(t) && reglas.plazos.incidente) return reglas.plazos.incidente;
  if (/apela|camara|segunda instancia|2da instancia|3ra instancia|ulterior instancia/.test(t) && reglas.plazos.segunda) return reglas.plazos.segunda;
  return reglas.plazos.default;
}

// Base penal (nacional, comun a los 3 fueros). Detalle en prescripcion-penal.
export const PRESCRIPCION_PENAL = {
  norma: "arts. 62-67 Codigo Penal (Ley 11.179) [VERIFICAR VIGENCIA]",
  verificacion: "verificado (InfoLEG 16546, texto actualizado; art. 67 t. Ley 27.206)",
  termino: { perpetua: 15, inhabPerpetua: 5, inhabTemporal: 1, multa: 2, temporalTope: 12, temporalPiso: 2 },
};
