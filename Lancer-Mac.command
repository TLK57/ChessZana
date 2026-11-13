#!/bin/bash
# Double-cliquez sur ce fichier pour lancer l'application (macOS ; fonctionne aussi sous Linux).
cd "$(dirname "$0")" || exit 1
TEST_MODE=0
[ "$1" = "--test" ] && TEST_MODE=1
NODE_VERSION=24.22.3

fin() {
  [ "$TEST_MODE" = 1 ] || read -r -p "Appuyez sur Entrée pour fermer…"
  exit "${1:-1}"
}

# Node.js 22.13 ou plus déjà installé ?
node_recent() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)'
}

if [ -n "$ANALYSE_ECHECS_NODE_PORTABLE" ] || ! node_recent; then
  # Version portable officielle, vérifiée par sa somme SHA-256, dans runtime/ (rien n'est installé sur le système).
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64)  PLATEFORME=darwin-arm64; SOMME=ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd ;;
    Darwin-x86_64) PLATEFORME=darwin-x64;   SOMME=977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7 ;;
    Linux-x86_64)  PLATEFORME=linux-x64;    SOMME=061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2 ;;
    Linux-aarch64|Linux-arm64) PLATEFORME=linux-arm64; SOMME=261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8 ;;
    *) echo "  Système non pris en charge : $(uname -s) $(uname -m)"; fin 1 ;;
  esac
  NOM="node-v$NODE_VERSION-$PLATEFORME"
  if [ ! -x "runtime/$NOM/bin/node" ]; then
    mkdir -p runtime
    echo "  Téléchargement de Node.js $NODE_VERSION (version portable)…"
    curl -fL --retry 3 --progress-bar -o "runtime/$NOM.tar.gz" "https://nodejs.org/dist/v$NODE_VERSION/$NOM.tar.gz" \
      || { echo "  Téléchargement impossible : vérifiez votre connexion Internet."; fin 1; }
    if command -v shasum >/dev/null 2>&1; then OBTENU=$(shasum -a 256 "runtime/$NOM.tar.gz" | cut -d' ' -f1)
    else OBTENU=$(sha256sum "runtime/$NOM.tar.gz" | cut -d' ' -f1); fi
    if [ "$OBTENU" != "$SOMME" ]; then
      rm -f "runtime/$NOM.tar.gz"
      echo "  La somme SHA-256 ne correspond pas à celle publiée par nodejs.org : fichier corrompu ou modifié."
      fin 1
    fi
    tar -xzf "runtime/$NOM.tar.gz" -C runtime && rm -f "runtime/$NOM.tar.gz"
  fi
  export PATH="$PWD/runtime/$NOM/bin:$PATH"
fi
echo "  Node.js $(node --version)"

if [ ! -d "node_modules/chess.js" ] || [ ! -d "node_modules/chessground" ]; then
  echo "  Première installation des composants, patientez…"
  npm install --no-audit --no-fund || { echo "  L'installation a échoué. Vérifiez votre connexion Internet."; fin 1; }
fi

if [ "$TEST_MODE" = 1 ]; then
  npm run smoke
  exit $?
fi
npm start
