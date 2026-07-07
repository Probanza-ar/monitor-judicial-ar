# Acto impulsorio y caducidad de instancia - guía rápida

Para cargar la columna "Fecha Impulso Real" en la hoja CAUSAS. Mientras esté vacía,
la causa sale en el parte como REVISIÓN REQUERIDA.

## Plazos de caducidad (art. 310 CPCCN)

- 6 meses: primera o única instancia.
- 3 meses: 2da/3ra instancia, sumarísimo, ejecutivo, ejecuciones especiales, incidentes.
- 1 mes: incidente de caducidad.

## Cuadro de comandos operativos

| Actuación en el expediente | ¿Se carga en "Fecha Impulso Real"? | Impacto en el script |
|---|---|---|
| Demanda / responde / alegato | SÍ (obligatorio) | Quita REVISIÓN REQUERIDA y calcula a 6 meses limpios |
| Ofrecimiento de prueba / autos para sentencia | SÍ (obligatorio) | Quita la alerta y resetea el plazo según el proceso (3 o 6 m) |
| Notificación efectiva de providencia impulsoria (cédula diligenciada / oficio con resultado positivo) | SÍ | Resetea el reloj a la fecha de la notificación efectiva |
| Pedido de copias / cambio de patrocinio / cédula rebotada | NO (prohibido) | Mantiene el cálculo anterior; si no hay fecha previa, sigue en REVISIÓN REQUERIDA |
| Pronto despacho / oficios de oficio / pedido de audiencia | ZONA GRIS (por defecto NO) | Solo se carga si el proveído del juez efectivamente hace avanzar el proceso |

## SÍ interrumpe - va a "Fecha Impulso Real"

Todo acto que empuja el proceso hacia la sentencia:

- Demanda, contestación, reconvención.
- Apertura a prueba; ofrecimiento y producción de prueba con petición concreta.
- Notificación EFECTIVA de providencias impulsorias (cédula diligenciada u oficio con
  resultado positivo). La mera confección o confronte de la cédula no basta: lo que
  interrumpe es la notificación efectiva de la providencia que impulsa.
- Agregación de pericia u oficio con instancia de parte.
- Alegato.
- Pedido de sentencia / autos para sentencia.

## NO interrumpe - NO cargar (da falsa seguridad)

- "Téngase presente" el nuevo domicilio o el nuevo letrado.
- Agregación de una cédula rebotada o devuelta.
- Pedido de copias, desgloses o vista.
- Constitución de domicilio.

## Zona gris - criterio del abogado

- Pedido de designación de audiencia: SOLO si el juzgado efectivamente la fija. Si
  provee "téngase presente para su oportunidad", NO cargar. En el fuero comercial, la
  petición que no remueve un obstáculo procesal real suele no impulsar.
- Pronto despacho, ciertas actuaciones de oficio del tribunal.

Ante la duda, NO cargar como impulso. El costo de subestimar el reloj es cero; el de
sobrestimarlo es la perención.

## Purga del plazo (art. 315 CPCCN)

Una causa marcada [VENCIDO] no está necesariamente muerta. Si presentás un acto de
impulso real antes de que la contraparte acuse la perención o el juez la declare de
oficio, y la contraparte no lo cuestiona dentro de los 5 días de notificada (art. 315
in fine), la caducidad se purga (queda consentida). En ese caso, cargá la fecha del
nuevo acto en "Fecha Impulso Real": el reloj se resetea a cero.

## Cómo corre el plazo

- Se cuenta desde el último acto impulsorio (art. 311).
- Corre en días inhábiles, salvo la feria judicial (se descuenta).
- Se descuenta el tiempo de suspensión o paralización acordada.
- Si el vencimiento cae inhábil, se prorroga al primer día hábil, con las dos primeras
  horas de gracia (art. 124 CPCCN).

## Litisconsorcio (art. 312 CPCCN)

El impulso por o contra uno de los colitigantes beneficia a los demás. El sistema
calcula por expediente; verificá actos dirigidos a otros sujetos que no figuren en la
solapa principal.

## Regla de oro

Cargá en "Fecha Impulso Real" solo actos indiscutiblemente impulsorios. El sistema no
decide por vos: te obliga a decidir. La firma y el cómputo final son del abogado.

---
Base: CPCCN arts. 310, 311, 312, 315 y 124 (verificado en InfoLEG, texto actualizado).
Guía orientativa de gestión, no sustituye el análisis del caso.
