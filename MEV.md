# Frente MEV / SCBA (Provincia de Buenos Aires)

Tercer frente del sistema, junto al PJN (Nacion) y el EJE (CABA). Monitorea las
causas de la Mesa de Entradas Virtual de la Suprema Corte de Justicia de la
Provincia de Buenos Aires (mev.scba.gov.ar) y arma un parte diario por mail,
con alerta de caducidad de instancia provincial.

## Diferencias con los otros dos frentes

- La MEV REQUIERE login siempre: no hay consulta anonima (a diferencia del EJE).
- Es ASP clasico, sin API JSON: el cliente postea formularios y parsea HTML.
- La "cartera" natural son los SETS del portal. El set automatico "Lista de
  Causas con AUTORIZACION" junta las causas reservadas ya autorizadas
  (penal/familia). Ademas podes armar sets propios en "Organizar Mis Sets".
  El bot recorre todos los sets de cada jurisdiccion configurada.
- La jurisdiccion (departamento judicial + fuero) es estado de SESION: el bot la
  re-postea por cada grupo de causas.

## Archivos

Scripts:
- parte-diario-mev.mjs = bot principal (analogo a parte-diario-eje.mjs).
- descubrir-mev.mjs     = diagnostico + siembra de cartera-mev.xlsx. Correr 1 vez.
- run-parte-mev.bat     = runner para la tarea programada.

Modulos (lib/):
- mev-auth.mjs       = login (POST loguin.asp) + seleccion de jurisdiccion
                       (POST POSLoguin.asp) + manejo de sesion (cookie ASP,
                       re-login automatico ante timeout, deteccion de clave vencida).
- mev-client.mjs     = cliente HTTP + parser HTML: busqueda, listado de causas,
                       sets, novedades por rango, ficha (pasos procesales),
                       texto de proveido, diff de novedades.
- cartera-mev.mjs    = cartera-mev.xlsx (clave nidCausa|pidJuzgado; columna Vigilar).
- movimientos-mev.mjs = movimientos-mev.csv (log + estado previo para el diff).
- caducidad-mev.mjs  = caducidad de instancia PBA (arts. 310/311/315 CPCC BA).
- prescripcion-penal-mev.mjs = prescripcion de la accion penal (arts. 62-67 CP)
                       para la cartera penal PBA. Usa penal-base.mjs (nucleo compartido).

Datos/config:
- feria-pba.json     = feria judicial SCBA 2026 (CARGADA: verano 1-31/01 e
                       invierno 20-31/07, Acuerdos SCBA 4203 y 4229).
- .env.mev.example   = variables MEV_* para pegar al .env existente.

## Config (pegar al .env)

    MEV_USUARIO=<usuario MEV>
    MEV_CLAVE=<clave MEV>
    MEV_DEPTO_REGISTRADO=aa          # "Creado en" del login; aa = Todos los Deptos
    MEV_JURISDICCIONES=Moron:penal;San Isidro
    MAIL_TO_MEV=<destinatario>       # opcional; si falta usa MAIL_TO

MEV_JURISDICCIONES: lista separada por ";" de "Depto[:penal][:familia]". El
nombre del depto matchea contra el listado del propio portal (no hace falta el
codigo). El fuero penal/familia se pasa como flag porque las causas reservadas
solo se ven entrando con ese fuero.

## Como funciona el parte MEV

1. Login + por cada jurisdiccion de MEV_JURISDICCIONES: entra, lista sus sets y
   siembra cartera-mev.xlsx con las causas de cada set.
2. Depuras homonimos con la columna "Vigilar" (=NO a las ajenas), igual que el EJE.
3. Por causa vigilada, baja los pasos procesales y reporta solo lo posterior a lo
   ya visto (diff contra movimientos-mev.csv). Primera corrida = linea de base.
4. Arma prioritarias + caducidad + prescripcion penal + agrupado por causa; manda
   mail; heartbeat; alerta de falla (con aviso especifico si la clave MEV vencio).

## Caducidad de instancia PBA (arts. 310/311/315 CPCC BA, VERIFICADO)

Bifasica, calcada del enfoque CABA pero con la norma provincial (texto literal
confirmado en normas.gba.gob.ar, jul-2026):
- Plazos art. 310 (t. Ley 13.986): 6 meses (1ra/unica instancia); 3 meses (2da/
  ulterior instancia y Justicia de Paz); 3 meses (sumario, sumarisimo, ejecutivo);
  o la prescripcion si fuere menor (esta ultima variante el bot NO la computa:
  confirmarla a mano).
- Art. 311 (t. Ley 12.357): corre en dias inhabiles SALVO ferias (se descuentan)
  y descontando paralizacion/suspension. El bot usa meses corridos con feria
  descontada (feria-pba.json).
- Art. 315 (t. Ley 13.986): la caducidad la pide POR UNICA VEZ la contraparte
  (demandado en 1ra inst.), no de oficio; intimacion previa por unica vez, 5 dias
  habiles perentorios. 2da fase: si la intimada activa y luego pasa igual plazo sin
  actividad util, se decreta a pedido o de oficio.
- Fases: EN CURSO -> PLAZO CUMPLIDO -> INTIMADA (cargar "Fecha Notif. Intimacion").
- Excluye automatico: fuero Penal (rige prescripcion) y Laboral (impulso de oficio;
  proc. laboral PBA Ley 15.057, vigente desde feb-2020, deroga la Ley 11.653, mod.
  Ley 15.557/2025). El amparo NO se excluye por defecto (a diferencia de CABA)
  [REVISION NORMATIVA REQUERIDA: criterio SCBA]. Overrides: "Caducidad Aplica".
- Descuento de feria: feria-pba.json (CARGADA con la feria SCBA 2026).

Reglas centralizadas en lib/reglas-plazos.mjs (JURIS.PBA), compartidas con los
otros frentes.

## Prescripcion de la accion penal PBA (arts. 62-67 CP)

El CP es nacional: mismo instituto que en el EJE. Para la cartera penal (fuero
Penal/Garantias/Correccional/etc.), donde la caducidad de instancia no corre. Es
una CALCULADORA ASISTIDA (lib/prescripcion-penal-mev.mjs, nucleo penal-base.mjs):
- Termino art. 62 (perpetua 15a; temporal = pena maxima, tope 12 / piso 2a; inhab.
  5/1a; multa 2a) desde la fecha del hecho (art. 63) o el ultimo acto interruptivo
  (art. 67: declaracion del imputado/art. 308 CPP BA, requerimiento de elevacion,
  citacion a juicio, sentencia). Suspension si la victima es menor (delitos sexuales).
- Lee de cartera-mev.xlsx: "Delito (art. CP)", "Fecha Hecho", "Pena Max (anios)",
  "Ultima Interrupcion", "Prescripcion Aplica". Sin datos -> DATOS FALTANTES.
- La pena maxima se prefila de una tabla interna por articulo [VERIFICAR VIGENCIA];
  el abogado confirma o pisa. Prefija el asunto con [PRESCRIPCION xN] si hay
  vencimientos proximos/operados.

## Estado / pendientes (lado del usuario)

1. Pegar las variables MEV_* al .env con credenciales reales.
2. Sembrar la cartera con `node descubrir-mev.mjs` y depurar con "Vigilar":
   - MEV_JURISDICCIONES=auto (o vacio) -> MODO AUTO: barre los 23 deptos x fuero
     (civil/familia/penal), consulta el set de autorizadas en cada uno y siembra todo.
     Al final lista en que jurisdicciones aparecieron causas. Util si no sabes donde
     tramitan. El parte diario con "auto" NO re-siembra: usa la cartera ya cargada
     (correr descubrir-mev.mjs cada vez que pidas una autorizacion nueva).
   - MEV_JURISDICCIONES=Depto:penal;Depto2 -> solo esas jurisdicciones (mas liviano):
     el parte las re-siembra en cada corrida y descubre causas nuevas ahi.
   Nota: el "(NNN)" que muestra el set "Lista de Causas con AUTORIZACION" es un numero
   interno del portal, NO tu cantidad de causas.
3. Cargar "Fecha Impulso Real" en las causas civiles/comerciales para que la
   caducidad pase de estimada a exacta.
4. Para las causas penales: cargar "Delito (art. CP)", "Fecha Hecho", "Pena Max
   (anios)" y "Ultima Interrupcion" para que la prescripcion pase de estimada a computo.
5. feria-pba.json 2026; actualizar cada anio con el nuevo Acuerdo SCBA
   (enero suele ser 1-31; la feria de invierno cambia de fechas).
6. Programar el disparo diario con `agendar.bat` (o `node agendar.mjs`): elegis que
   frentes (PJN/EJE/MEV), frecuencia (1 o 2 veces al dia, o horarios a medida) y hora.
   Crea las tareas en el Programador de Windows (schtasks) o en cron. El Excel guarda
   causas y plazos, pero NO dispara nada: el disparo lo hace el sistema operativo.

## Marcadores de integridad

- Normas VERIFICADAS (normas.gba.gob.ar, texto consolidado, jul-2026): CPCC BA
  arts. 310/311/315 confirmados texto literal (Dec-Ley 7.425/68 VIGENTE con mod.;
  310 y 315 t. Ley 13.986; computo art. 311 t. Ley 12.357). Fuero laboral: proc.
  laboral PBA es Ley 15.057 (vigente feb-2020; deroga la Ley 11.653; mod. Ley
  15.557/2025) - la cita anterior a la 11.653 estaba desactualizada, corregida.
- Feria SCBA 2026 CARGADA (feria-pba.json): verano 1-31/01 (Acuerdo 4203) e
  invierno 20-31/07 (Acuerdo 4229), confirmadas en scba.gov.ar.
- Prescripcion penal PBA: HECHA (lib/prescripcion-penal-mev.mjs, arts. 62-67 CP,
  nucleo penal-base.mjs). Las penas de la tabla interna quedan [VERIFICAR VIGENCIA]:
  son prefill; el abogado confirma o pisa con "Pena Max (anios)".
- [REVISION NORMATIVA REQUERIDA]: criterio de la SCBA sobre caducidad de instancia
  en amparo (Ley 13.928) - el bot NO lo excluye por defecto, a diferencia de CABA.

## Gotcha del recon (ver test/RECON-MEV.md)

El set de autorizadas del usuario figura con "Total: 1" en Moron-Penal pero el
detalle sale vacio ("otra jurisdiccion o sin causas"). A confirmar: depto/fuero
exacto donde tramita, o si la autorizacion vencio. No afecta el codigo: el bot
recorre todas las jurisdicciones y la toma cuando este visible.
