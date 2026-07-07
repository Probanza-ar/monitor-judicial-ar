#!/bin/sh
# Configurar el parte diario del PJN en Mac o Linux.
# Uso:  sh configurar.sh      (o:  chmod +x configurar.sh && ./configurar.sh)
cd "$(dirname "$0")"
echo "Instalando dependencias (puppeteer, nodemailer)..."
npm install
echo
node configurar.mjs
