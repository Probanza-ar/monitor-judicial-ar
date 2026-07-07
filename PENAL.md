# Frente penal - inactividad y prescripción de la acción

Módulo `lib/penal.mjs`. Solo LEE la hoja CAUSAS. Suma al parte diario dos bloques
para las causas de fuero penal (que la caducidad excluye a propósito). Se activa con
EXCEL_PATH.

## 1. Monitor de inactividad (siempre activo)

Marca las causas penales activas sin movimiento registrado hace más de N días
(PENAL_INACTIVIDAD_DIAS, default 120). Es control de gestión, NO prescripción: sirve
para que ninguna causa se duerma. No requiere cargar nada extra.

## 2. Prescripción de la acción (se activa al cargar datos)

Computa la fecha estimada de prescripción según el Código Penal (verificado en
InfoLEG, idNorma 16546, texto actualizado; art. 67 sustituido por Ley 27.206):

- Art. 62: plazo = máximo de la pena del delito (prisión/reclusión temporal), tope
  12 años y piso 2; 15 años perpetua; 5/1 inhabilitación; 2 años multa.
- Art. 63: corre desde la medianoche del día del hecho (o del cese, si continuo).
- Art. 67: interrumpe SOLO la comisión de otro delito, el primer llamado a
  indagatoria, el requerimiento de elevación a juicio, el auto de citación a juicio
  y la sentencia condenatoria (aunque no firme). Corre separadamente por delito y por
  partícipe.

Cálculo: prescribe = (último acto interruptivo, o fecha del hecho) + plazo en años,
extendido por el período de suspensión cargado.

### Columnas opcionales en CAUSAS (detectadas por nombre)

- "Prescripción Años": plazo en años cargado directo (lo más seguro y recomendado).
- "Pena Máx Años": si no hay plazo directo, se usa el máximo de la pena con clamp 2-12
  (art. 62 inc. 2, caso prisión/reclusión temporal). Para perpetua, multa o
  inhabilitación, cargá mejor "Prescripción Años" a mano.
  ATENCIÓN - concurso real (art. 55 CP): NO uses "Pena Máx Años". En concurso real las
  penas se acumulan y el tope de 12 años no aplica (puede llegar a 50). El clamp daría
  una prescripción anticipada y falsa. Cargá "Prescripción Años" sumando a mano los
  máximos de la escala aplicable. Las filas calculadas por "Pena Máx Años" salen en el
  parte marcadas "[VERIFICAR CONCURSO art. 55]".
- "Fecha Hecho": fecha del hecho (art. 63).
- "Último Acto Interruptivo": fecha del último acto del art. 67 (indagatoria,
  requerimiento, citación a juicio, condena). Si está, manda sobre la fecha del hecho.
- "Susp Desde" / "Susp Hasta": período de suspensión a descontar.

## Límites (importante)

Es una ALERTA DE GESTIÓN. El abogado determina el delito, la pena, los actos
interruptivos y las suspensiones, y confirma la fecha. Tres vectores de riesgo a tener
presentes:

1. Cómputo por expediente vs. por imputado (art. 67 CP, texto s/ Ley 25.990
   [VERIFICAR VIGENCIA] mantenido por Ley 27.206): la prescripción se interrumpe
   separadamente para cada partícipe. Si defendés a varios coimputados y a uno lo
   citan a indagatoria y al otro no, el reloj corre distinto. El sistema calcula por
   Nro. Causa: en pluralidad de imputados, verificá la situación individual de cada
   asistido. El parte lo advierte en el bloque de prescripción.

2. Concurso real (art. 55 CP): las penas se acumulan y el tope de 12 años del art. 62
   inc. 2 no aplica. No uses "Pena Máx Años" en ese caso; cargá "Prescripción Años" a
   mano. Ver la nota de esa columna.

3. Comisión de un nuevo delito (art. 67 inc. a): es un hecho exógeno al expediente que
   el bot monitorea en el PJN. Interrumpe la prescripción pero el sistema no puede
   verlo; requiere control directo del letrado (p. ej. actualización del certificado
   del RNR).

Suspensiones que el sistema no infiere (cargar en "Susp Desde"/"Susp Hasta"): delitos
en ejercicio de la función pública mientras se ejerce el cargo; delitos sexuales con
víctima menor; cuestiones prejudiciales; y la suspensión del juicio a prueba, cuya
concesión suspende la prescripción durante el período de prueba (art. 76 ter CP).

## Niveles (prescripción)

- PRESCRIPTA?: el plazo estimado ya se cumplió. Analizar de inmediato.
- URGENTE: faltan 30 días o menos.
- preventivo: dentro de la ventana de aviso (default 90 días).

## Configuración (.env)

- PENAL_INACTIVIDAD_DIAS: umbral de inactividad en días (default 120).
- PENAL_AVISO_DIAS: anticipación del aviso de prescripción (default 90).

## Estado

Construido sobre base normativa verificada. No se pudo probar en ejecución en este
entorno; validar en la primera corrida con EXCEL_PATH. El monitor de inactividad
funciona sin datos extra; la prescripción se enciende al cargar las columnas.
