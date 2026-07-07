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
- caducidad-mev.mjs  = caducidad de instancia PBA (art. 310/315 CPCC BA).

Datos/config:
- feria-pba.json     = feria judicial SCBA (VACIA: cargar los rangos reales).
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
4. Arma prioritarias + caducidad + agrupado por causa; manda mail; heartbeat;
   alerta de falla (con aviso especifico si la clave MEV vencio).

## Caducidad de instancia PBA (art. 310/315 CPCC BA [VERIFICAR VIGENCIA])

Bifasica, calcada del enfoque CABA pero con la norma provincial:
- Plazos art. 310: 6 meses (1ra/unica instancia); 3 meses (2da, justicia de paz,
  sumario, sumarisimo, ejecutivo); o la prescripcion si fuere menor (esta ultima
  variante el bot NO la computa: confirmarla a mano).
- Art. 315: intimacion previa por unica vez, 5 dias habiles perentorios.
- Fases: EN CURSO -> PLAZO CUMPLIDO -> INTIMADA (cargar "Fecha Notif. Intimacion").
- Excluye automatico: fuero Penal (rige prescripcion) y Laboral (impulso de
  oficio, Ley 11.653). El amparo NO se excluye por defecto (a diferencia de CABA)
  [REVISION NORMATIVA REQUERIDA: criterio SCBA]. Overrides: "Caducidad Aplica".
- Descuento de feria: feria-pba.json (VACIO -> cargar la feria SCBA real).

Reglas centralizadas en lib/reglas-plazos.mjs (JURIS.PBA), compartidas con los
otros frentes.

## Estado / pendientes (lado del usuario)

1. Pegar las variables MEV_* al .env con credenciales reales.
2. Correr `node descubrir-mev.mjs` para sembrar cartera-mev.xlsx; depurar con "Vigilar".
3. Cargar "Fecha Impulso Real" en las causas civiles/comerciales para que la
   caducidad pase de estimada a exacta.
4. Cargar feria-pba.json con los rangos de la feria judicial SCBA (enero + invierno)
   desde la acordada anual [REVISION NORMATIVA REQUERIDA].
5. Sumar la tarea programada (08/18 hs) apuntando a run-parte-mev.bat.

## Marcadores de integridad pendientes

- Normas [VERIFICAR VIGENCIA]: CPCC BA arts. 310/311/315 (Dec-Ley 7.425/68;
  310 y 315 t. Ley 13.986/2009; computo art. 311 t. Ley 12.357); Ley 11.653
  (procedimiento laboral PBA, impulso de oficio).
- [REVISION NORMATIVA REQUERIDA]: feria judicial SCBA (feria-pba.json vacio);
  criterio de la SCBA sobre caducidad de instancia en amparo (Ley 13.928).
- Prescripcion penal PBA: frente PENDIENTE (el nucleo comun CP esta en
  lib/penal-base.mjs; falta el modulo provincial analogo a prescripcion-penal-eje.mjs).

## Gotcha del recon (ver test/RECON-MEV.md)

El set de autorizadas del usuario figura con "Total: 1" en Moron-Penal pero el
detalle sale vacio ("otra jurisdiccion o sin causas"). A confirmar: depto/fuero
exacto donde tramita, o si la autorizacion vencio. No afecta el codigo: el bot
recorre todas las jurisdicciones y la toma cuando este visible.
