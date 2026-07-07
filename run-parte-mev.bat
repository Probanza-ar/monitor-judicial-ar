@echo off
cd /d "%~dp0"
node "parte-diario-mev.mjs" >> "parte-mev.log" 2>&1
