# Trouve un Node.js assez récent (22.13 ou plus), sinon télécharge une version portable officielle
# dans le dossier runtime\ de l'application (rien n'est installé sur le système).
# Écrit dans le fichier -OutFile le dossier qui contient node.exe.
param([Parameter(Mandatory = $true)][string]$OutFile)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# En cas de problème : un message clair, sans détail technique.
trap { Write-Host "  $($_.Exception.Message)"; exit 1 }
$Version = '24.22.3'
$Minimum = [version]'22.13.0'
$Sums = @{
  'x64'   = 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f'
  'arm64' = 'b3cc74a295b39d4f273271e96f58c06dd2b35757ca12abec64c7d0598b434f14'
}
$Root = Split-Path -Parent $PSScriptRoot
function Resultat([string]$dossier) {
  [IO.File]::WriteAllText($OutFile, $dossier, (New-Object Text.UTF8Encoding $false))
  exit 0
}

if (-not $env:ANALYSE_ECHECS_NODE_PORTABLE) {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) {
    $v = (& $node.Source --version).Trim().TrimStart('v')
    if ([version]$v -ge $Minimum) { Resultat (Split-Path -Parent $node.Source) }
    Write-Host "  Node.js $v est trop ancien (il faut 22.13 ou plus) : utilisation d'une version portable."
  }
}

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$name = "node-v$Version-win-$arch"
$runtime = Join-Path $Root 'runtime'
$dir = Join-Path $runtime $name
if (-not (Test-Path (Join-Path $dir 'node.exe'))) {
  New-Item -ItemType Directory -Force $runtime | Out-Null
  $zip = Join-Path $runtime "$name.zip"
  Write-Host "  Téléchargement de Node.js $Version (version portable, environ 35 Mo)..."
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri "https://nodejs.org/dist/v$Version/$name.zip" -OutFile $zip -UseBasicParsing
  $hash = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower()
  if ($hash -ne $Sums[$arch]) {
    Remove-Item -Force $zip
    throw "La somme SHA-256 de $name.zip ne correspond pas à celle publiée par nodejs.org : fichier corrompu ou modifié."
  }
  Expand-Archive -LiteralPath $zip -DestinationPath $runtime -Force
  Remove-Item -Force $zip
}
Resultat $dir
