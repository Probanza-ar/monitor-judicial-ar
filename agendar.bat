@echo off
REM Doble clic para programar los partes diarios (PJN / EJE / MEV) a tu gusto.
REM Si alguna tarea falla por permisos, corre este .bat como Administrador.
cd /d "%~dp0"
node "agendar.mjs"
echo.
pause
