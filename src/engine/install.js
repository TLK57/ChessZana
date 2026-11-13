// Téléchargement automatique de Stockfish 19 officiel (github.com/official-stockfish/Stockfish)
// selon le système (Windows / macOS / Linux) et le processeur (x86-64 / ARM).
// Les binaires « universal » de Stockfish 19 choisissent eux-mêmes le meilleur jeu d'instructions du processeur.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { config, userAgent } from '../config.js';

export const STOCKFISH_RELEASE = 'sf_19';

// Empreintes SHA-256 publiées par GitHub pour la version sf_19 (vérifiées après téléchargement).
const ASSETS = {
  'win32-x64': { file: 'stockfish-windows-x86-64-universal.zip', sha256: '3c8bf1f9ea66a09350a40df4f632288285ac206d99f33ab5842c408fc30b48a7' },
  'win32-arm64': { file: 'stockfish-windows-arm64-universal.zip', sha256: '8372ad3f0d7276deb2c70f801f541ec7db463219fc6d9c7592864e542aa4f401' },
  'darwin-x64': { file: 'stockfish-macos-universal.tar.gz', sha256: 'a1f0e3bcc5a6927a11fe6fc8e54a779754645f3c2bae2cf13420fd1957adaa77' },
  'darwin-arm64': { file: 'stockfish-macos-universal.tar.gz', sha256: 'a1f0e3bcc5a6927a11fe6fc8e54a779754645f3c2bae2cf13420fd1957adaa77' },
  'linux-x64': { file: 'stockfish-linux-x86-64-universal.tar.gz', sha256: '9defc0d4e55d49c65a6d042f3e571a39fcea499ade6dbe741b53b8c65e03611f' },
  'linux-arm64': { file: 'stockfish-linux-arm64-universal.tar.gz', sha256: 'fe26cfd1d9db4c8af3d21e24d9ff34cacb31c1f940085a7583da11796f2bac01' },
};

export function pickAsset(platform = process.platform, arch = process.arch) {
  const a = ASSETS[`${platform}-${arch}`];
  if (!a) throw new Error(`Système non pris en charge pour le téléchargement automatique : ${platform}/${arch}`);
  return { ...a, url: `https://github.com/official-stockfish/Stockfish/releases/download/${STOCKFISH_RELEASE}/${a.file}` };
}

function manifestPath() {
  return path.join(config.engineDir, 'engine.json');
}

export function installedEngine() {
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));
    if (m.release === STOCKFISH_RELEASE && fs.existsSync(m.binary)) return m;
  } catch { /* pas encore installé */ }
  return null;
}

async function sha256File(file) {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
}

async function download(url, dest, onProgress) {
  const res = await fetch(url, { headers: { 'User-Agent': userAgent() }, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Téléchargement de Stockfish impossible (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  let done = 0;
  let lastPct = -1;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    done += chunk.length;
    const pct = total ? Math.floor((done / total) * 100) : 0;
    if (pct !== lastPct) { lastPct = pct; onProgress?.({ phase: 'download', pct, done, total }); }
  });
  const tmp = `${dest}.part`;
  await pipeline(body, fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
}

function extract(archive, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  // Windows 10+ fournit tar.exe (bsdtar) qui sait lire les .zip ; macOS/Linux ont tar.
  const tarBin = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  let r = spawnSync(tarBin, ['-xf', archive, '-C', outDir], { stdio: 'pipe' });
  if (r.status !== 0 && process.platform === 'win32') {
    r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${outDir.replace(/'/g, "''")}' -Force`], { stdio: 'pipe' });
  }
  if (r.status !== 0) throw new Error(`Extraction de Stockfish impossible : ${String(r.stderr || '').slice(0, 300)}`);
}

function findBinary(dir) {
  const candidates = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!['src', 'wiki', 'scripts'].includes(e.name)) walk(p); continue; }
      const name = e.name.toLowerCase();
      if (!name.startsWith('stockfish')) continue;
      if (process.platform === 'win32' ? !name.endsWith('.exe') : path.extname(name) !== '') continue;
      candidates.push({ p, size: fs.statSync(p).size });
    }
  };
  walk(dir);
  candidates.sort((a, b) => b.size - a.size);
  return candidates[0]?.p ?? null;
}

// Vérifie que le binaire démarre et répond au protocole UCI.
export function probeBinary(binary, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const finish = (val) => { if (!settled) { settled = true; try { p.kill(); } catch {} resolve(val); } };
    const p = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => finish(null), timeoutMs);
    p.on('error', () => { clearTimeout(timer); finish(null); });
    p.on('exit', () => { clearTimeout(timer); finish(/uciok/.test(out) ? out : null); });
    p.stdout.on('data', (d) => {
      out += d.toString();
      if (/uciok/.test(out)) { clearTimeout(timer); p.stdin.write('quit\n'); }
    });
    p.stdin.write('uci\n');
  });
}

let installing = null;

export function ensureEngine(onProgress) {
  const existing = installedEngine();
  if (existing) return Promise.resolve(existing);
  if (!installing) {
    installing = doInstall(onProgress).finally(() => { installing = null; });
  }
  return installing;
}

async function doInstall(onProgress) {
  const asset = pickAsset();
  const dlDir = path.join(config.engineDir, 'downloads');
  fs.mkdirSync(dlDir, { recursive: true });
  const archive = path.join(dlDir, asset.file);

  if (fs.existsSync(archive) && (await sha256File(archive)) !== asset.sha256) fs.rmSync(archive);
  if (!fs.existsSync(archive)) {
    onProgress?.({ phase: 'download', pct: 0 });
    await download(asset.url, archive, onProgress);
  }
  onProgress?.({ phase: 'verify', pct: 100 });
  const digest = await sha256File(archive);
  if (digest !== asset.sha256) {
    fs.rmSync(archive, { force: true });
    throw new Error('Le fichier Stockfish téléchargé est corrompu (empreinte SHA-256 différente). Relancez l\'application.');
  }

  onProgress?.({ phase: 'extract', pct: 100 });
  const outDir = path.join(config.engineDir, STOCKFISH_RELEASE);
  fs.rmSync(outDir, { recursive: true, force: true });
  extract(archive, outDir);
  const binary = findBinary(outDir);
  if (!binary) throw new Error('Binaire Stockfish introuvable dans l\'archive.');
  if (process.platform !== 'win32') fs.chmodSync(binary, 0o755);

  onProgress?.({ phase: 'probe', pct: 100 });
  const uci = await probeBinary(binary);
  if (!uci) throw new Error(`Stockfish ne démarre pas sur cet ordinateur (${binary}).`);
  const idName = (uci.match(/id name (.+)/) || [])[1]?.trim() || 'Stockfish';

  const manifest = { release: STOCKFISH_RELEASE, name: idName, binary, asset: asset.file, installedAt: new Date().toISOString() };
  fs.writeFileSync(manifestPath(), JSON.stringify(manifest, null, 2));
  // L'archive n'est plus utile une fois le moteur installé.
  fs.rmSync(archive, { force: true });
  onProgress?.({ phase: 'ready', pct: 100 });
  return manifest;
}

// Exécution directe : npm run install-engine
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let last = '';
  ensureEngine((p) => {
    const line = p.phase === 'download' ? `Téléchargement de Stockfish… ${p.pct}%` : `Étape : ${p.phase}`;
    if (line !== last) { last = line; process.stdout.write(`\r${line}        `); }
  }).then((m) => {
    console.log(`\nMoteur prêt : ${m.name}\n${m.binary}`);
  }).catch((e) => {
    console.error(`\nErreur : ${e.message}`);
    process.exit(1);
  });
}
