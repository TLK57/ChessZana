#!/bin/bash
# Double-cliquez sur ce fichier pour lancer l'application (macOS).
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Node.js n'est pas installé."
  echo "  Installez la version LTS depuis https://nodejs.org puis relancez ce fichier."
  echo ""
  read -r -p "Appuyez sur Entrée pour fermer…"
  exit 1
fi

if [ ! -d "node_modules/chess.js" ] || [ ! -d "node_modules/chessground" ]; then
  echo "  Première installation des composants, patientez…"
  npm install --no-audit --no-fund || { echo "  L'installation a échoué. Vérifiez votre connexion Internet."; read -r; exit 1; }
fi

npm start
