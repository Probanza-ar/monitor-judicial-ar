# Alerta y cómputo de caducidad de instancia

Módulo `lib/caducidad.mjs`. Suma al parte diario una sección con las causas que se
acercan al plazo de caducidad. Solo LEE la hoja CAUSAS (no escribe): sin riesgo para
fórmulas ni gráficos.

## Base normativa (verificada en InfoLEG - CPCCN idNorma 16547, texto actualizado)

Art. 310 CPCCN (sustituido por Ley 25.488):
- 6 meses: primera o única instancia.
- 3 meses: 2da/3ra instancia, sumarísimo, ejecutivo, ejecuciones especiales, incidentes.
- 1 mes: incidente de caducidad.

Art. 311: los plazos corren desde el último acto impulsorio, en días inhábiles salvo
feria judicial, y se descuenta el tiempo de suspensión o paralización acordada.

## Cómo computa

Es un CALCULADOR: dado el acto impulsorio, el plazo y las suspensiones, devuelve la
fecha exacta de caducidad, descontando la feria judicial. La precisión depende de los
datos cargados. El sistema no decide cuál acto fue impulsorio ni conoce suspensiones
no registradas: eso lo carga el abogado, que confirma la fecha antes de actuar.

- Descuenta la feria judicial (art. 311) leyendo los rangos de `ferias-judiciales.json`.
- Descuenta el período de suspensión si está cargado.
- Extiende el vencimiento por esos días no computables.

## Datos por causa - columnas OPCIONALES en CAUSAS

El módulo las detecta por nombre. Si las agregás, el cómputo es preciso; si no, usa una
estimación y marca la fila como "[dato estimado]".

- "Último impulso" (o "Fecha impulso"): fecha del último acto impulsorio real.
- "Caducidad meses" (o "Plazo caducidad"): 6, 3 o 1 según el caso.
- "Suspensión desde" y "Suspensión hasta": período suspendido a descontar.

Sin esas columnas: toma como impulso el último movimiento (de CAUSAS o de MOVIMIENTOS,
lo que alimenta el bot) y estima el plazo (6, o 3 si detecta ejecutivo/sumarísimo/
incidente/2da instancia). Igual descuenta feria. Esas filas salen marcadas [dato
estimado] para que sepas cuáles revisar.

## Feria judicial - ferias-judiciales.json

Rangos donde el plazo NO corre. Distinto de `feriados.json`. Cargado:
- Invierno 2026: 20 al 31/07 (confirmado por Acordada 11/2026 CSJN).
- Verano 2026: enero completo [VERIFICAR VIGENCIA con la acordada anual].

Actualizá este archivo cada año. La feria de verano conviene confirmarla contra la
acordada de la CSJN.

## Refinamientos jurídicos

- Vencimiento en día inhábil (art. 124 CPCCN): si la fecha final cae sábado,
  domingo o feriado, se prorroga al primer día hábil y se indica "(prorrogado al
  1er día hábil - primeras 2 hs de gracia)". Usa el mismo feriados.json del bot.
- Litisconsorcio (art. 312 CPCCN): el cómputo es por expediente y por el último
  acto registrado. La sección incluye una advertencia fija: el impulso por o contra
  un colitigante beneficia a los demás; verificar actos dirigidos a otros sujetos
  que no figuren en la solapa.
- Dato estimado = REVISIÓN REQUERIDA: cuando no hay "Último impulso" cargado, la
  fila NO se trata como aviso común sino como "REVISIÓN REQUERIDA - causa sin acto
  impulsorio verificado", porque un movimiento (un "téngase presente", una cédula
  rebotada, un pedido de copias) puede no interrumpir la caducidad. Además el asunto
  del mail lleva "[REVISION CADUCIDAD xN]" y se informa el total de causas civiles
  activas sin impulso cargado, que es donde se esconde la falsa seguridad.

## Aplicabilidad por fuero (automática)

- Penal: se OMITE (no corre caducidad; rige prescripción de la acción). El cómputo
  penal es una parte aparte, pendiente.
- Laboral nacional / trabajo: se OMITE (impulso de oficio, Ley 18.345). [VERIFICAR caso]
- Civil, comercial y demás: se calcula.
- Causas archivadas/terminadas/con sentencia firme: se omiten.

## Niveles

- VENCIDO: el plazo ya pasó. Revisar de inmediato.
- URGENTE: faltan 15 días o menos.
- preventivo: dentro de la ventana de aviso (default 45 días antes).

## Configuración (.env)

Se activa con EXCEL_PATH.
- CADUCIDAD_AVISO_DIAS: días de anticipación del aviso (default 45).
- CADUCIDAD_MESES_DEFAULT: plazo por defecto en meses cuando no hay dato (default 6).

## Estado

Construido con cómputo de feria y suspensiones, sobre base normativa verificada. No se
pudo probar en ejecución en este entorno; validar en la primera corrida con EXCEL_PATH.
Pendiente aparte: cómputo penal (monitor de inactividad + prescripción de la acción).
