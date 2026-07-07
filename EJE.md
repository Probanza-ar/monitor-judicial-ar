# Parte diario JusCABA (EJE) - frente CABA

Modulo independiente que replica el parte del Portal PJN, pero para la Justicia de
la Ciudad de Buenos Aires (Expediente Judicial Electronico, eje.juscaba.gob.ar).
Corre con su propia tarea programada y su propio mail. Un colega que solo litiga en
CABA usa solo esto; uno con causas en Nacion y Ciudad corre los dos partes.

## Dos modos: AUTENTICADO (recomendado) y publico

MODO AUTENTICADO (con EJE_USUARIO=CUIT y EJE_CLAVE en .env):
El Portal del Litigante SI tiene feed de "Mis Causas" (login Keycloak). El bot baja tu
cartera EXACTA -las causas donde figuras como parte/letrado-, incluidas las RESERVADAS
(penal/PCyF y sensibles) que la consulta publica oculta. No hay homonimos que depurar.
Es el modo necesario si tenes causas reservadas: sin login la API publica las rechaza
(code 1004) y el bot no ve nada.

MODO PUBLICO (sin credenciales, solo con EJE_CRITERIOS):
JusCABA publico no expone "mis causas", asi que el bot descubre por nombre (hibrido):

- Descubre por nombre/criterio (EJE_CRITERIOS) y agrega cada causa a cartera-eje.xlsx.
- Vos depuras homonimos con la columna "Vigilar": poné "NO" a las que no son tuyas.
- Solo ve causas NO reservadas.

En ambos modos, por causa vigilada baja las actuaciones y reporta solo las posteriores a
la ultima ya vista (diff contra movimientos-eje.csv).

Detalle tecnico de la capa autenticada: ver lib/eje-auth.mjs y HANDOFF-EJE.md.

Nota fuero: si tu cartera es penal (IPP/PCyF), el modulo de caducidad de instancia
(art. 216 CAyT) NO aplica y queda inerte; el resto del parte funciona igual.

## Archivos

Scripts:
- parte-diario-eje.mjs = el bot principal (analogo a parte-diario-pjn.v2.mjs).
- descubrir-eje.mjs    = confirma endpoints de la API y siembra la cartera. Correr 1 vez.
- run-parte-eje.bat    = runner para la tarea programada.

Modulos (lib/):
- eje-client.mjs   = cliente HTTP de la API publica de JusCABA (buscar, actuaciones).
- cartera-eje.mjs  = cartera-eje.xlsx (descubrimiento + columna Vigilar). Preserva gestion.
- movimientos-eje.mjs = movimientos-eje.csv (log + estado previo para el diff).
- caducidad-eje.mjs = caducidad de instancia CAyT (art. 216 Ley 189). Lee la cartera.

Genera:
- cartera-eje.xlsx    = causas CABA. Columnas del bot (CUIJ, ExpId, Caratula, Fuero,
  Estado, Fecha Inicio, Ult. Actuacion) + gestion tuya (Vigilar, Ref/Cliente, Fecha
  Impulso Real, Caducidad Meses, Caducidad Aplica, Fecha Notif. Intimacion, Observaciones).
- movimientos-eje.csv = actuaciones reportadas (dedup por act_id).
- feria-caba.json     = feria judicial CABA (a completar; ver "Plazos" abajo).
- ultima-corrida-eje.log / parte-eje.log = heartbeat y log. ALERTA_CRITICA_EJE.txt si falla todo.

## Puesta en marcha

1. `npm i` (ya estan puppeteer/nodemailer/exceljs del parte PJN; no agrega dependencias).
2. Copiar las variables de `.env.eje.example` al final del `.env` existente y setear
   `EJE_CRITERIOS` con tus nombres de parte/letrado/estudio.
3. Confirmar la API y sembrar la cartera:  `node descubrir-eje.mjs`
   - Imprime los endpoints que quedaron y una muestra de busqueda/actuaciones.
   - Siembra cartera-eje.xlsx con lo encontrado.
4. Abrir cartera-eje.xlsx y poner "NO" en Vigilar a las causas ajenas (homonimos).
5. Prueba manual del parte:  `node parte-diario-eje.mjs`
6. Agregar a la tarea programada un disparo que ejecute run-parte-eje.bat a las 08:00
   y 18:00 (misma logica que ParteDiarioPJN, tarea separada o accion adicional).

## Endpoints de la API (confirmados contra el trafico real del portal)

Base: https://eje.juscaba.gob.ar/iol-api/api/public  (sin auth; datos publicos)

- Busqueda:   POST /expedientes/lista  (form-urlencoded, UN campo "info")
              body: info=<urlencode(JSON({filter:JSON({identificador:<criterio>}),
                          tipoBusqueda:"CAU", page, size}))>
              resp: Spring Page con content:[{expId, fechaFavorito}] (solo IDs).
- Encabezado: GET /expedientes/encabezado?expId=  -> cuij, caratula, numero, anio,
              estadoAdministrativo, esPrivado (0/1), fechaInicio (epoch ms).
- Ult. accion:GET /expedientes/ultimaAccion?expId= -> {ultimaAccion:{descripcion,fecha(ms),tipo}}
- Actuaciones:GET /expedientes/actuaciones?filtro=<JSON>&page=&size=  con filtro:
              {cedulas,escritos,despachos,notas, expId, accesoMinisterios:false,
               fechaNotificacionDesde:null, fechaNotificacionHasta:null}

La busqueda devuelve solo expId; el cliente enriquece cada uno con encabezado + ultima
accion (por eso una busqueda hace N+1 requests, con pausa entre llamadas). Request y
endpoints calcados del conector juscaba (mcp-legal-ar). Solo se puede pisar EJE_API_BASE
por .env si el server cambia de URL.

## Plazos: caducidad de instancia CAyT

El parte incluye una seccion de caducidad de instancia JUDICIAL del fuero CAyT, sobre
el Codigo Contencioso Administrativo y Tributario de la CABA (Ley 189, texto consolidado
Ley 6.764) [VERIFICAR VIGENCIA]:

- Art. 216: 6 meses de inactividad por causa imputable al ACTOR -> el tribunal intima;
  30 dias para acreditar prosecucion; si no, caducidad y archivo. No opera en procesos
  colectivos ni con interes publico/social/de tercero.
- Art. 122: los plazos procesales se computan en dias habiles judiciales; la feria se
  descuenta (feria-caba.json descontarEnCaducidad = true).
- OJO: es lo JUDICIAL. La caducidad ADMINISTRATIVA de la LPA (DNU 1.510/97, 60+30 dias)
  es otra cosa y NO la ve el EJE (ocurre en sede administrativa).

Es BIFASICA. Cumplir los 6 meses no fulmina la instancia; habilita la intimacion. El
parte distingue tres fases por causa:
- EN CURSO: faltan dias para los 6 meses (avisa al acercarse, a EJE_CADUCIDAD_AVISO_DIAS).
- HABILITADO PARA INTIMAR: se cumplieron los 6 meses sin impulso.
- INTIMADA: al cargar "Fecha Notif. Intimacion" corre la cuenta PERENTORIA de 30 dias
  habiles (art. 216/122); vencida sin acreditar prosecucion, procede la caducidad.

Como cargar los datos (columnas de gestion en cartera-eje.xlsx):
- "Fecha Impulso Real": fecha del ultimo acto impulsorio verificado. Si esta vacia, el
  bot estima sobre el ultimo movimiento y marca la causa como REVISION REQUERIDA.
- "Fecha Notif. Intimacion": fecha de notificacion de la intimacion de caducidad. Al
  cargarla, la causa pasa a fase INTIMADA y arranca el perentorio de 30 dias habiles.
- "Caducidad Meses": por defecto 6; se puede pisar por causa.
- "Caducidad Aplica" = NO excluye la causa; = SI la fuerza (util para reincluir un amparo).

Exclusiones automaticas: amparos (Ley 2145 [VERIFICAR VIGENCIA]) detectados por caratula
-la jurisprudencia CAyT rechaza la caducidad de instancia en amparo-, procesos
colectivos e interes publico, fuero PCyF y estados cerrados. El amparo se excluye por
heuristica de caratula; para forzar el computo, "Caducidad Aplica" = SI.

Inhabiles excepcionales. Ademas de la feria anual, feria-caba.json tiene un array
"inhabilesExcepcionales" para los asuetos ad-hoc que decreta el TSJ durante el anio
(mudanza de juzgado, caida general del EJE, duelo, etc.). Se cargan apenas se decretan
(Acordada/Resolucion o BO CABA) y se descuentan igual que la feria, y cuentan como
inhabiles en la cuenta de 30 dias de la intimacion. El bot NUNCA declara un dia inhabil
solo: si el EJE se cae, el parte marca "posible caida general del EJE" (cuando fallan casi
todas las consultas) y vos confirmas contra fuente oficial antes de agregar la fecha. Una
caida de conexion puede ser de la red propia, por eso no se computa de forma automatica.

Computo de los 6 meses: plazo de meses corridos de fecha a fecha (regla del art. 28 CCyCN
[VERIFICAR VIGENCIA]) con descuento de feria/inhabiles (art. 122 CCAyT); NO se cuentan en
dias habiles (convertir el semestre a habiles lo estiraria a ~9 meses y sub-alertaria).

Pendiente de verificacion (marcado en el parte):
- feria-caba.json sin rangos de feria: el descuento del art. 122 esta activado pero faltan
  las fechas de la feria judicial CABA (NO es la de la CSJN). Cargarlas.

## Limites / integridad

- Solo expedientes publicos; los privados/estrictos no exponen contenido.
- El computo de caducidad es una ALERTA orientativa, no una decision: el abogado
  confirma el acto impulsorio, su imputabilidad y las excepciones. El parte no es notificacion.
- Fuero penal/contravencional/faltas (PCyF): la caducidad de instancia del art. 216 no
  se aplica; el bot lo excluye. Prescripcion/plazos penales quedan fuera de este modulo.
- La deteccion de PRIORITARIAS y el "Fuero" sugerido (por el objeto de la caratula) son
  orientativos: no reemplazan la lectura de la actuacion.
