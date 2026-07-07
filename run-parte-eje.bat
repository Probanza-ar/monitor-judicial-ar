@echo off
cd /d "%~dp0"
node "parte-diario-eje.mjs" >> "parte-eje.log" 2>&1
