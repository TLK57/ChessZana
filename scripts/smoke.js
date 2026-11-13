// Test de fumée (utilisé par les lanceurs en mode --test et par l'intégration continue) :
// démarre l'application dans un dossier temporaire, installe Stockfish si besoin, analyse une courte partie.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'echecs-smoke-'));
const port = 3790 + Math.floor(Math.random() * 9);
const cfg = path.join(dir, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({ port, openBrowser: false, autoSyncOnStart: false, analysisMode: 'manual', engine: { quickDepth: 8, threads: 2 }, lichess: { cloudEval: false, tablebase: false } }));
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (m) => console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)} s] ${m}`);

const server = spawn(process.execPath, [path.join(ROOT, 'src', 'start.js')], {
  cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...process.env, CHESS_CONFIG: cfg, CHESS_CONFIG_LOCAL: '', CHESS_DATA_DIR: dir },
});

async function getJson(p, body) {
  const r = await fetch(base + p, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${p} : HTTP ${r.status}`);
  return r.json();
}

async function until(what, fn, timeoutMs) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* pas encore prêt */ }
    if (Date.now() > end) throw new Error(`délai dépassé : ${what}`);
    await sleep(1000);
  }
}

let code = 0;
try {
  await until('le serveur répond', () => getJson('/api/status'), 60000);
  log('serveur démarré');
  const st = await until('Stockfish prêt', async () => { const s = await getJson('/api/status'); if (s.engine.status === 'error') throw new Error(s.engine.message); return s.engine.status === 'ready' && s; }, 10 * 60000);
  log(`moteur prêt : ${st.engine.name}`);
  const page = await (await fetch(base + '/')).text();
  if (!page.includes('/app/main.js')) throw new Error("la page de l'application ne s'affiche pas");
  for (const f of ['/vendor/chessground.js', '/vendor/chess.js', '/app/main.js']) {
    if ((await fetch(base + f)).status !== 200) throw new Error(`fichier introuvable : ${f}`);
  }
  const pgn = '[White "A"]\n[Black "B"]\n[Result "1-0"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0';
  const imp = await getJson('/api/import/pgn', { pgn });
  const id = imp.ids[0];
  await getJson(`/api/games/${id}/prioritize`, {});
  const view = await until('analyse rapide terminée', async () => { const v = await getJson(`/api/games/${id}/view`); return v.pass && v; }, 5 * 60000);
  const nf6 = view.moves[5];
  log(`partie analysée : 3... Cf6 classé « ${nf6.label} »`);
  if (nf6.classification !== 'blunder') throw new Error(`classement inattendu pour 3... Cf6 : ${nf6.classification}`);
  log('TEST DE FUMÉE RÉUSSI');
} catch (e) {
  console.error(`  ÉCHEC du test de fumée : ${e.message}`);
  code = 1;
} finally {
  server.kill();
  await sleep(1500);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* fichiers encore ouverts */ }
  process.exit(code);
}
