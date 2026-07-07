@echo off
REM Doble clic para configurar el parte diario del PJN.
cd /d "%~dp0"
echo Instalando dependencias (puppeteer, nodemailer)...
call npm install
echo.
node "configurar.mjs"
echo.
pause
