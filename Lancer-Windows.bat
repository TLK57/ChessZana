@echo off
chcp 65001 >nul
title Analyse d'echecs
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js n'est pas installe.
  echo  Installez la version LTS depuis https://nodejs.org puis relancez ce fichier.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\chessground" goto installer
if not exist "node_modules\chess.js" goto installer
goto lancer

:installer
(
  echo  Premiere installation des composants, patientez...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo  L'installation a echoue. Verifiez votre connexion Internet.
    pause
    exit /b 1
  )
)


:lancer
call npm start
pause
