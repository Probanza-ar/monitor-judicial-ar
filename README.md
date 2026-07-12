# Gestion automatica de expedientes, control de cartera y calculo de plazos - herramienta libre para abogados argentinos

Programa gratuito y de codigo abierto que arma solo un Excel con TODAS tus causas, calcula plazos y lo
actualiza dos veces por dia. En cada corrida revisa tus expedientes, te manda un parte
diario por email con las novedades, y te avisa de plazos criticos (caducidad de instancia
y prescripcion penal). Pensado para abogados de los tres fueros: Nacion (PJN), Ciudad de
Buenos Aires (JusCABA/EJE) y Provincia de Buenos Aires (SCBA / MEV).

Corre en tu propia computadora, con tus credenciales. Nadie mas ve tus datos: no hay
servidor central, no se sube nada a la nube, no tiene costo.

> **Aviso profesional.** Es una ayuda de gestion, informativa y orientativa. La deteccion
> de novedades y el computo de plazos NO reemplazan la lectura del expediente ni el criterio
> del abogado. Verificá siempre en el portal oficial antes de computar un plazo o actuar. La
> responsabilidad y la firma son del abogado.

---

## Que problema resuelve

Hoy revisar la cartera implica entrar todos los dias a dos o tres portales distintos, causa
por causa, para ver si hubo una novedad. El programa hace esa ronda por vos: entra a los
portales, detecta lo nuevo, descarga los PDF, actualiza el Excel de la cartera completa y
manda el parte por email. Si no hubo novedades, tambien te lo informa. En paralelo calcula
los plazos criticos de cada causa y te avisa antes de que venzan.

---

## Que hace

**1) Parte diario de novedades.** Entra a los portales, junta lo nuevo de tus causas
(despachos, cedulas, actuaciones) y te manda un email con el resumen. Tres frentes, cada
uno independiente (su propia tarea y su propio mail; comparten el `.env`):

- **Poder Judicial de la Nacion (PJN).** Feed autenticado de tus novedades; adjunta y
  guarda los PDF.
- **Justicia de la Ciudad de Buenos Aires (JusCABA / EJE).** Baja tu cartera exacta
  ("Mis Causas") por API autenticada, incluidas las causas reservadas. Diff diario contra
  lo ya visto.
- **Provincia de Buenos Aires (SCBA / MEV).** Recorre tus sets de la Mesa de Entradas
  Virtual (incluida la "Lista de Causas con Autorizacion") por cada departamento judicial
  y fuero que configures. Diff diario de los pasos procesales.

En cualquiera de los tres, el programa:

- Genera un archivo Excel con el listado de todas tus causas y calcula los plazos. Lo
  mantiene actualizado automaticamente en cada corrida.
- Revisa cada expediente y detecta despachos, cedulas y documentos nuevos.
- Te envia un correo electronico con un resumen de las novedades (y, si no hubo, tambien
  te lo informa).
- Adjunta los PDF de despachos y cedulas al email.
- Guarda automaticamente una copia local de todos los PDF, organizados por fecha.

**2) Control de plazos (orientativo).**

- **Caducidad de instancia**, con las reglas de cada jurisdiccion en `lib/reglas-plazos.mjs`:
  Nacion (CPCCN art. 310/311), CABA CAyT (Ley 189 art. 216/122) y Provincia (CPCC art. 310/315,
  Ley 13.986). Descuenta feria; contempla la intimacion previa donde corresponde.
- **Prescripcion de la accion penal** (Codigo Penal, arts. 62-67), comun a los tres fueros.
  Estima el termino segun la pena, computa desde el hecho o el ultimo acto interruptivo, y
  detecta cierres (extincion, sobreseimiento, condena) leyendo las actuaciones. Nucleo
  compartido en `lib/penal-base.mjs`.

Cada regla lleva marcadores de integridad (`[VERIFICAR VIGENCIA]`, etc.): el programa nunca
afirma una vigencia o una pena como certeza; te señala que la confirmes.

**3) Flujo general del programa:**

    PJN / EJE / MEV
        |
        v
    Descarga novedades
        |
        v
    Actualiza Excel
        |
        v
    Calcula plazos
        |
        v
    Envia email

---

## Lo que vas a necesitar

1. Una computadora (Windows, Mac o Linux) prendida a la hora del parte.
2. Node.js (LTS) desde https://nodejs.org. Para verificar: en una terminal, `node -v`.
3. Una cuenta de Gmail con verificacion en 2 pasos (ver Paso 1).
4. Tus credenciales del portal que uses (PJN, EJE y/o MEV).

---

## Frente PJN (Nacion) - guia paso a paso

### Paso 1 - Contrasena de aplicacion de Gmail

Por unica vez. Gmail no deja que un programa mande correos con tu clave normal: pide una
"contrasena de aplicacion" de 16 letras solo para esto.

1. Entra a https://myaccount.google.com/security
2. Activa "Verificacion en 2 pasos" si no lo esta.
3. Entra a https://myaccount.google.com/apppasswords, poné un nombre (ej. "Parte PJN"), Crear.
4. Copiá la clave de 16 letras (los espacios no importan).

### Paso 2 - Configurar

1. Abri la carpeta del programa.
2. Doble clic en `configurar.bat` (Mac/Linux: `sh configurar.sh`). Instala lo necesario y
   te hace las preguntas una por una (Gmail, contrasena de aplicacion, destinatario, usuario
   y clave del PJN, ventana en dias, si mandar mail sin novedades, si adjuntar/guardar PDF).
3. Al final ofrece agendar la tarea automatica.

Deja creados `.env` (tus datos) y `run-parte-pjn.bat` (para probar).

### Paso 3 - Probar

Doble clic en `run-parte-pjn.bat`, o en la terminal:

    cd D:\DERECHO\PartesPJN
    node parte-diario-pjn.mjs

Si termina en "Email enviado", funciono.

---

## Frente JusCABA / EJE (Ciudad)

Es un modulo independiente, con su propia tarea y su propio mail; comparte el `.env` con el
PJN (SMTP, feriados). Baja tu cartera exacta del Portal del Litigante (login Keycloak con tu
CUIT), incluidas las causas reservadas que la consulta publica no muestra.

1. Copiá las variables de `.env.eje.example` al final de tu `.env` y completá:
   `EJE_USUARIO` (tu CUIT) y `EJE_CLAVE` (tu clave del EJE).
2. Sembrá tu cartera: `node descubrir-eje.mjs` (trae "Mis Causas", sin homonimos).
3. Probá el parte: `node parte-diario-eje.mjs`.
4. Agendá `run-parte-eje.bat` en el Programador de tareas (ej. 08:00 y 18:00).

Detalle del frente y de los computos de plazos: ver `EJE.md`.

> El `.env` guarda tu clave en texto plano en tu disco. Protegé el archivo y no lo compartas.

---

## Frente MEV / SCBA (Provincia de Buenos Aires)

Tercer frente, tambien independiente, con su propia tarea y su propio mail; comparte el
`.env` con el PJN y el EJE. A diferencia del EJE, la MEV no tiene consulta anonima ni API
JSON: el bot loguea siempre (con re-login automatico ante timeout y aviso si la clave
vencio) y parsea el HTML del portal.

1. Copiá las variables de `.env.mev.example` al final de tu `.env` y completá:
   `MEV_USUARIO`, `MEV_CLAVE`, `MEV_DEPTO_REGISTRADO` (el "Creado en" del login; `aa` =
   Todos los Deptos) y `MEV_JURISDICCIONES` (lista separada por `;` de
   `Depto[:penal][:familia]`; el fuero penal/familia se pasa como flag porque las causas
   reservadas solo se ven entrando con ese fuero).
2. Sembrá tu cartera: `node descubrir-mev.mjs` (recorre los sets de cada jurisdiccion
   configurada, incluida la "Lista de Causas con Autorizacion"). Depurá homonimos con la
   columna "Vigilar", igual que en el EJE.
3. Para que la caducidad de instancia pase de estimada a exacta, cargá "Fecha Impulso
   Real" en las causas civiles/comerciales.
4. Para que la prescripcion penal pase de estimada a computo, cargá "Delito (art. CP)",
   "Fecha Hecho", "Pena Max (anios)" y "Ultima Interrupcion" en las causas penales.
5. Probá el parte: `node parte-diario-mev.mjs`.
6. Agendá `run-parte-mev.bat` en el Programador de tareas (ej. 08:00 y 18:00).

Detalle del frente y de los computos de plazos: ver `MEV.md`.

---

## Control de plazos - como funciona

El programa primero DESCARGA todos los movimientos (actuaciones) de cada causa y recien
despues CALCULA los plazos a partir de ellos. De esos movimientos deduce lo que puede: el
ultimo acto impulsorio para la caducidad, y en penal el ultimo acto interruptivo y los
cierres (extincion, sobreseimiento, condena) para la prescripcion. Completa ademas el fuero,
el delito por la caratula y la pena de tabla.

Lo que no surge de los movimientos -por ejemplo la fecha del hecho, que esta en el texto de
la denuncia- se toma de una columna opcional del Excel o se estima, y en ese caso el aviso
se marca como estimado. El abogado confirma antes de actuar.

El resultado del calculo se ESCRIBE en el propio Excel de la cartera, en columnas que el bot
completa y actualiza en cada corrida (no las cargas vos): "Caduc. Vence", "Caduc. Dias",
"Caduc. Alerta" (y "Caduc. Fase" en EJE/MEV) para la caducidad, y "Prescr. Vence",
"Prescr. Dias", "Prescr. Alerta" para la prescripcion penal, mas "Plazos Actualizado" con la
fecha de la ultima corrida. Asi cada causa muestra su plazo en su fila, este o no en el mail
(el mail lista solo las que estan en zona de aviso; la cartera las muestra todas). Estas
columnas son de solo lectura para vos: el bot las pisa cada vez. Las que SI cargas vos
(Fecha Impulso Real, Delito, Pena Max, Fecha Hecho, etc.) se conservan intactas.

---

## Solucion de problemas (PJN)

- No llega el mail: abri `parte-pjn.log`; ahi queda el error.
- "Cannot find package ...": faltan dependencias. Corre `npm install` en la carpeta.
- El envio se cuelga o da error de certificado: suele ser el antivirus/firewall interceptando
  el correo. Desactivalo un momento o cambia el puerto SMTP a 587 en el `.env`.
- Se traba en el login del PJN la primera vez: en `.env` poné `HEADLESS=false`, corre, logueate
  a mano una vez, y volve a `HEADLESS=true`.
- MEV: si el mail de falla avisa clave vencida, actualizá `MEV_CLAVE` en el `.env`; el bot
  reintenta el login solo, pero no puede generar una clave nueva por vos.

---

## En Mac o Linux

El programa es el mismo; cambian los ejecutables: `sh configurar.sh` en vez de `configurar.bat`,
`sh run-parte-pjn.sh` para probar, y cron en vez del Programador de tareas (el configurador te
lo ofrece).

## En un servidor (VPS)

Para que corra 24/7 sin depender de tu PC: guia completa en `DESPLIEGUE-VPS.md`
(Oracle Cloud Always Free en Ubuntu ARM, con los tres tropiezos tipicos resueltos:
Chromium en ARM64, zona horaria del cron y el primer login sin pantalla).

---

## Licencia y uso

Ver `LICENSE`.
