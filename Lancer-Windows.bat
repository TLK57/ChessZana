@echo off
chcp 65001 >nul
title Analyse d'echecs
cd /d "%~dp0"
set "TEST_MODE="
if /i "%~1"=="--test" set "TEST_MODE=1"

rem Node.js 22.13 ou plus : celui de l'ordinateur, sinon une version portable dans runtime\
set "NODE_FILE=%TEMP%\analyse-echecs-node.txt"
if exist "%NODE_FILE%" del "%NODE_FILE%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\node-portable.ps1" -OutFile "%NODE_FILE%"
if errorlevel 1 (
  echo.
  echo  Impossible de preparer Node.js. Verifiez votre connexion Internet puis relancez ce fichier.
  goto erreur
)
set /p NODE_DIR=<"%NODE_FILE%"
set "PATH=%NODE_DIR%;%PATH%"
for /f "delims=" %%v in ('node --version') do echo  Node.js %%v

if not exist "node_modules\chessground" goto installer
if not exist "node_modules\chess.js" goto installer
goto lancer

:installer
echo  Premiere installation des composants, patientez...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo  L'installation a echoue. Verifiez votre connexion Internet.
  goto erreur
)

:lancer
if defined TEST_MODE goto test
call npm start
pause
exit /b 0

:test
rem Mode test (integration continue) : test de fumee au lieu du lancement normal
call npm run smoke
exit /b %errorlevel%

:erreur
if not defined TEST_MODE pause
exit /b 1
