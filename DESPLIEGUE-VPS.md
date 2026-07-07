# Despliegue en VPS - Oracle Cloud Always Free (Ubuntu 24.04)

Guia para correr `monitor-judicial-ar` 24/7 en un VPS gratuito de Oracle Cloud,
en lugar de (o ademas de) la PC propia con el Programador de tareas de Windows.
Sirve igual para cualquier VPS Ubuntu (Hetzner, Contabo, etc.): salteá la
seccion de Oracle y arrancá en "Dependencias".

ADVERTENCIA PREVIA: el `.env` lleva credenciales del PJN y una contraseña de
aplicacion de Gmail, y la carpeta `.pjn-profile/` contiene una SESION VIVA del
Portal. Un VPS comprometido expone todo eso. Usá clave SSH (nunca password),
no abras puertos de entrada y tratá `.pjn-profile/` como si fuera una clave mas.

## 1. Crear la instancia en Oracle

1. Cuenta en cloud.oracle.com (pide tarjeta para validar identidad; el Always
   Free no factura). Elegí bien la "home region": no se cambia despues.
2. Compute > Instances > Create Instance.
3. Imagen: Ubuntu 24.04 (aarch64). Shape: VM.Standard.A1.Flex (Ampere/ARM).
   Con 1 OCPU / 6 GB sobra para este bot.
   OJO (jun-2026): Oracle recorto el tope Always Free de A1 a 2 OCPU / 12 GB
   totales por tenancy (antes 4/24), sin anuncio publico. Si la creacion falla
   por limites, revisá cuanto A1 ya tenes usado.
   OJO 2: el error "Out of capacity" en A1 es comun en el free tier. Insistir
   en otro Availability Domain u horario, o usar el shape AMD micro (x86, 1 GB,
   mas justo de RAM pero evita el problema de Chromium ARM del paso 4).
4. SSH: subi tu clave publica (o generala ahi y guardá la privada).
5. Red: NO hace falta abrir ningun puerto de entrada ademas del 22 (SSH). El
   bot solo hace conexiones salientes (PJN + SMTP). Cuanto menos abierto, mejor.

## 2. Conectarse y preparar el sistema

    ssh ubuntu@<IP_PUBLICA>

(la IP figura en el detalle de la instancia; el usuario default es `ubuntu`).

    sudo apt update && sudo apt upgrade -y
    sudo apt install -y git curl
    curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
    sudo apt install -y nodejs

ZONA HORARIA (importante): el calculo de "hoy" del bot usa America/Argentina/
Buenos_Aires internamente, pero el CRON dispara segun la hora del sistema, que
en Oracle viene en UTC. Para que "8:00" sea 8:00 de Argentina:

    sudo timedatectl set-timezone America/Argentina/Buenos_Aires

## 3. Librerias del navegador headless

    sudo apt install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2t64

## 4. Chromium en ARM: el paso que rompe a todos

Puppeteer descarga "Chrome for Testing", que en Linux existe SOLO para x64.
En una instancia Ampere (arm64) `npm install` no va a traer navegador y el bot
muere al lanzar. Solucion: usar el Chromium del sistema.

    sudo apt install -y chromium-browser

y ANTES de `npm install`, evitar la descarga inutil:

    export PUPPETEER_SKIP_DOWNLOAD=true

En el `.env` (paso 5) apuntá Puppeteer al binario del sistema:

    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

(verificá la ruta con `which chromium-browser`; en Ubuntu es un shim que lanza
el snap de Chromium, funciona igual). En una instancia AMD x64 este paso entero
se omite: Puppeteer baja su propio Chrome.

## 5. Clonar y configurar

    git clone https://github.com/Probanza-ar/monitor-judicial-ar.git
    cd monitor-judicial-ar
    PUPPETEER_SKIP_DOWNLOAD=true npm install
    bash configurar.sh

El configurador pide Gmail (contraseña de aplicacion, no la clave normal),
usuario/clave del PJN y demas, y al final ofrece agendar por cron: aceptalo.
Sugerido: dos corridas, 08:00 y 18:00 (hora argentina, ya seteada en paso 2).

Despues del configurador, asegurá permisos y agregá la linea de Chromium:

    chmod 600 .env
    echo 'PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser' >> .env

Si preferis armar el cron a mano (con lock para que una corrida colgada no se
pise con la siguiente):

    crontab -e
    # m h dom mon dow command
    0 8,18 * * * cd ~/monitor-judicial-ar && flock -n /tmp/parte-pjn.lock node parte-diario-pjn.mjs >> parte-pjn.log 2>&1

## 6. El primer login (la parte que no es copy-paste)

El bot no usa un archivo de token: Puppeteer levanta con un PERFIL PERSISTENTE
de Chromium (`.pjn-profile/` en la raiz del repo). El primer login del SSO del
PJN conviene hacerlo con pantalla, cosa que el VPS no tiene. El camino probado:

1. En TU PC: corré el bot con `HEADLESS=false` en el `.env` hasta que loguee
   bien y mande el parte (queda la sesion guardada en `.pjn-profile/`).
2. Copiá el perfil completo al servidor:

       scp -r .pjn-profile ubuntu@<IP>:~/monitor-judicial-ar/

3. En el VPS: `HEADLESS=true` en el `.env` y probá una corrida manual:

       node parte-diario-pjn.mjs

   Si sale el mail, listo: el servidor arranca con la sesion ya viva.

Nota: el perfil de la PC (Windows) suele funcionar en Linux porque lo que
importa son las cookies del SSO, pero si el login falla igual, alternativa 100%
en el VPS: `sudo apt install -y xvfb` y correr la primera vez con
`xvfb-run node parte-diario-pjn.mjs` con HEADLESS=false y PJN_USER/PJN_PASS
seteados en el .env (el script completa el formulario del SSO solo).

CUANDO LA SESION VENZA: el bot intenta re-loguear solo con PJN_USER/PJN_PASS.
Si el SSO pide captcha/2FA, la corrida falla y te llega el mail de [FALLA]
(ALERTA_FALLA=true): ahi repetis este paso 6. No asumas que "sin mail" es "sin
novedades": para eso existe el heartbeat `ultima-corrida.log`.

## 7. Que Oracle no te apague la maquina

Oracle RECLAMA instancias Always Free "idle": para A1, si durante 7 dias el uso
de CPU (p95), red y memoria queda debajo del 10%. Un bot que corre 2 minutos
dos veces por dia califica de sobra como idle. Opciones:

- La limpia: pasar la cuenta a Pay As You Go ("upgrade"). Los recursos Always
  Free siguen sin facturarse y las instancias dejan de estar sujetas al reclaim
  de idle. Es la unica solucion que Oracle documenta.
- La casera: sumar carga minima de fondo para superar el umbral. Funciona hoy,
  Oracle puede cambiar el criterio manana.

Chequeá tambien el mail de la cuenta Oracle: avisan ahi antes de detener.

## 8. Verificacion final

1. `node parte-diario-pjn.mjs` a mano -> llega el parte por mail.
2. `crontab -l` -> estan las dos corridas.
3. `date` -> hora argentina.
4. Al dia siguiente: `cat ultima-corrida.log` -> hay lineas OK de 08 y 18 hs.
5. Simulacro de falla (opcional pero recomendado): poné una clave SMTP mala y
   corré a mano; tiene que aparecer `ALERTA_CRITICA.txt`. Restaurá la clave.

## Mantenimiento

- `feriados.json` se actualiza cada año (ver feriados-2026-fuentes.md).
- La clave del PJN vence/cambia: actualizar `.env` y rehacer el paso 6 si hace falta.
- `git pull` para actualizar el bot; `npm install` solo si cambio package.json
  (siempre con PUPPETEER_SKIP_DOWNLOAD=true en ARM).
- Logs: `parte-pjn.log` crece; si molesta, rotarlo con logrotate o truncarlo.
