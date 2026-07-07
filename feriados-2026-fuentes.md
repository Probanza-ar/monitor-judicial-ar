# Feriados e inhabiles judiciales 2026 - auditoria de fuentes

Detalle de lo cargado en `feriados.json`, que alimenta el calculo de la ventana por
dias habiles (MODO_VENTANA=habil). Solo cuentan los dias de semana: sabados y
domingos se excluyen solos. Auditoria conciliada con la revision del colega.

## Estado: base confirmada, sin cambios de fecha

Las tres fechas que en la revision figuraban como "a corregir" (15-06 Guemes, 12-10
Diversidad, 23-11 Soberania) ya estaban cargadas con esos mismos valores. La
auditoria confirma cada fecha del `feriados.json`. No hubo correcciones de datos.

## Normas verificadas

- Ley 27.399 - Regimen de feriados nacionales, dias no laborables y fines de semana
  largos. HCN, sancion 27-09-2017, BO 18-10-2017, B.O. 33732 (InfoLEG id 281835).
  Derogo los Dec. 1584/2010, 52/2017 y 80/2017. TEXTO COMPLETO CONTRASTADO. Los
  cuatro traslados del Art. 6 se verificaron contra el dia de semana real de 2026:
    - Guemes: 17-06-2026 cae miercoles -> lunes anterior 15-06. OK.
    - San Martin: 17-08-2026 cae lunes -> sin traslado. OK.
    - Diversidad: 12-10-2026 cae lunes -> sin traslado. OK.
    - Soberania: 20-11-2026 cae viernes -> lunes siguiente 23-11. OK.
  Belgrano (20-06) es INAMOVIBLE por Art. 1 y en 2026 cae sabado (inocuo).
- Acordada 11/2026 CSJN - Feria judicial de invierno. Fuente oficial CSJN (novedad
  del 02-06-2026, csjn.gov.ar/novedades/detalle/13582): feriado judicial para los
  tribunales federales y nacionales de la Capital Federal desde el 20 al 31 de julio
  de 2026, ambas inclusive. CONFIRMADA. Autoridades de feria por Acordada 14/2026.
- Ley 26.674 - Declara el 16 de noviembre Dia del Trabajador Judicial Argentino.
  HCN, BO 18-05-2011, B.O. 32152 (InfoLEG id 182272). VERIFICADA en cuanto a la
  fecha. Aclaracion: la ley instituye la conmemoracion; el efecto de inhabil
  judicial para el PJN se instrumenta por asueto/acordada de la CSJN. Cargado como
  inhabil segun criterio del colega.

Nota para fueros federales del interior: la Acordada 11/2026 fija la feria para los
tribunales de la Capital Federal; a las Camaras Federales de Apelaciones les instruye
determinar su propia feria de 10 dias habiles (Acordada 30/1984). Si mas adelante se
suman fueros del interior al bot, sus fechas de feria pueden diferir de las de CABA.

Pendiente menor:
- Decreto 164/2025 PEN (dias turisticos 10-07 y 07-12): habilitado por el Art. 7 de
  la Ley 27.399 (hasta 3 dias turisticos en lunes o viernes). Fecha aportada por el
  colega; verificable en InfoLEG/BORA si se quiere cerrar del todo.

## Tabla de fiscalizacion

Origen: (U) aportado/confirmado por el colega; (F) feriado nacional fijo por Ley 27.399.

| Fecha (2026) | Concepto | Origen | Sustento / nota |
|---|---|---|---|
| 01-01 | Ano Nuevo | F | Ley 27.399, inamovible |
| 16-02, 17-02 | Carnaval | F | Ley 27.399; lunes y martes |
| 24-03 | Dia de la Memoria | F | Ley 27.399, inamovible (martes) |
| 02-04 | Malvinas | F | Ley 27.399, inamovible (jueves) |
| 03-04 | Viernes Santo | F | Ley 27.399, inhabil judicial (viernes) |
| 01-05 | Dia del Trabajador | F | Ley 27.399, inamovible (viernes) |
| 25-05 | Revolucion de Mayo | F | Ley 27.399, inamovible (lunes) |
| 15-06 | Guemes (trasladado del 17) | F | Ley 27.399 Art. 6; cae lunes. Inhabil |
| 20-06 | Belgrano | F | Ley 27.399; cae sabado (inocuo) |
| 09-07 | Independencia | U/F | Ley 27.399, inamovible (jueves) |
| 10-07 | No laborable turistico | U | Dec. 164/2025 PEN; viernes; inhabil judicial |
| 20-07 a 31-07 | Feria Judicial de Invierno | U | Acordada 11/2026 CSJN; 10 dias habiles |
| 17-08 | San Martin | U/F | Ley 27.399, trasladable; cae lunes |
| 12-10 | Diversidad Cultural | U/F | Ley 27.399; cae lunes, sin traslado |
| 16-11 | Empleado Judicial | U | Ley 26.674; lunes; asueto/acordada CSJN |
| 23-11 | Soberania (trasladado del 20) | U/F | Ley 27.399 Art. 6; el 20 cae viernes, pasa al lunes 23 |
| 07-12 | No laborable turistico (puente) | U | Dec. 164/2025 PEN; lunes |
| 08-12 | Inmaculada Concepcion | U/F | Ley 27.399, inamovible (martes) |
| 25-12 | Navidad | U/F | Ley 27.399, inamovible (viernes) |

## No cargado (a proposito)

- 29-08 Dia del Abogado: en 2026 cae sabado y no es inhabil judicial. Excluido.
- Sabados y domingos: los excluye el calculo, no hace falta listarlos.

## Bloques criticos

- Feria de invierno 20 al 31-07: se suspende el curso de los plazos por defecto,
  salvo habilitacion de feria (detenidos, cautelares).
- Puente extralargo de diciembre: sabado 05 a martes 08 inhabiles seguidos. La
  corrida del miercoles 09 a la manana procesa un volumen alto de proveidos.

## Reglas de "dias de nota" para la capa de plazos (validadas por el colega)

No afectan la ventana de escaneo (el bot barre todos los dias habiles). Se guardan
para el futuro calculo de vencimientos, conforme Acordada 31/2011 CSJN
(notificaciones electronicas) y CPCCN [VERIFICAR VIGENCIA]:

- Feria de invierno: lo publicado entre el 20 y el 31-07 se tiene por notificado el
  primer dia de nota posterior a la feria. Termina el viernes 31-07; primer habil
  lunes 03-08; primera nota real martes 04-08-2026; los plazos ordinarios empiezan
  a correr el miercoles 05-08-2026.
- Puente de diciembre: lo dejado firmado el viernes 04-12 a ultima hora o durante el
  fin de semana largo perfecciona la notificacion ministerial el viernes 11-12-2026
  (el martes 08 es feriado y la nota se desplaza al siguiente dia de nota legal). El
  computo debera contemplar ese salto de una semana.
