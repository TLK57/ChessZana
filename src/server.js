// Petit serveur local : n'écoute que sur 127.0.0.1 (jamais accessible depuis le réseau).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, config } from './config.js';
import { closeDb, getDb, openDb } from './db.js';
import { getEvaluator, getLiveEvaluator } from './engine/evaluator.js';
import { installedEngine, ensureEngine } from './engine/install.js';
import { lichessStatus } from './engine/lichess.js';
import { AnalysisQueue } from './queue.js';
import { syncChessCom } from './importers/chesscom.js';
import { syncLichess } from './importers/lichess.js';
import { importPgnText } from './importers/pgnfile.js';
import { listPlayers } from './games.js';
import { LABELS } from './analysis/classify.js';
import { backfillOpenings, listMyGames, openingFamilies } from './library.js';
import { buildGameView, liveMove } from './analysis/gameview.js';
import { ensureStatsSchema, refreshAllStats, refreshGameStats, resetStatsSchema } from './stats/compute.js';
import { KEEP, backupDatabase, exportDatabase, integrityCheck, latestHealthyBackup, listBackups, maybeDailyBackup, restoreBackup } from './backup.js';
import os from 'node:os';
import { dashboard, gamesSummary, recurringErrors, repertoire, timeStats } from './stats/queries.js';
import { answerPuzzle, todaySession, trainingStats } from './stats/training.js';
import { bilanText } from './stats/bilan.js';

const HOST = '127.0.0.1';
const MAX_BODY = 200 * 1024 * 1024;

const state = {
  stats: { refreshing: false },
  integrity: { ok: true, messages: [] },
  engine: { status: 'starting', message: 'Démarrage…', pct: 0, name: null },
  imports: [], // historique des imports (le plus récent en premier)
};
let importChain = Promise.resolve();
const evaluator = getEvaluator();
const liveEvaluator = getLiveEvaluator();

// Pendant le mode libre, la file de fond attend entre deux positions pour laisser tout le processeur
// à l'analyse en direct (aucun calcul n'est perdu).
const LIVE_PAUSE_MS = 45000;
let liveActiveUntil = 0;
evaluator.gate = async (signal) => {
  while (Date.now() < liveActiveUntil && !signal?.aborted) await new Promise((r) => setTimeout(r, 500));
};
let queue;

// Fichiers de l'interface : public/ et bibliothèques (échiquier chessground, règles chess.js).
const VENDOR = {
  '/vendor/chessground.js': ['node_modules', 'chessground', 'dist', 'chessground.min.js'],
  '/vendor/chessground.base.css': ['node_modules', 'chessground', 'assets', 'chessground.base.css'],
  '/vendor/chessground.brown.css': ['node_modules', 'chessground', 'assets', 'chessground.brown.css'],
  '/vendor/chessground.cburnett.css': ['node_modules', 'chessground', 'assets', 'chessground.cburnett.css'],
  '/vendor/chess.js': ['node_modules', 'chess.js', 'dist', 'esm', 'chess.js'],
};
const MIME = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon' };

function staticFile(p) {
  if (VENDOR[p]) return path.join(ROOT, ...VENDOR[p]);
  const m = /^\/app\/([a-z0-9_-]+\.(?:js|css|svg|png))$/i.exec(p);
  if (m) return path.join(ROOT, 'public', 'app', m[1]);
  return null;
}

// ---------------------------------------------------------------------------- imports

function startImport(kind, username) {
  const job = { id: Date.now() + Math.random(), kind, username, status: 'waiting', message: 'En attente…', done: 0, total: null, stats: null, error: null, startedAt: new Date().toISOString() };
  state.imports.unshift(job);
  state.imports = state.imports.slice(0, 15);
  importChain = importChain.then(async () => {
    job.status = 'running';
    const onProgress = (p) => { Object.assign(job, { message: p.message, done: p.done ?? job.done, total: p.total ?? job.total, stats: p.stats ?? job.stats }); };
    try {
      const fn = kind === 'chesscom' ? syncChessCom : syncLichess;
      job.stats = await fn(username, { onProgress });
      job.status = 'done';
    } catch (e) {
      job.status = 'error';
      job.error = e.message;
      job.message = e.message;
    }
    queue?.notify();
  });
  return job;
}

function syncTrackedPlayers() {
  for (const p of listPlayers()) {
    if (p.tracked && (p.source === 'chesscom' || p.source === 'lichess')) startImport(p.source, p.username);
  }
}

// ---------------------------------------------------------------------------- données

function stats() {
  const d = getDb();
  const one = (sql) => d.prepare(sql).get().n;
  return {
    games: one('SELECT COUNT(*) AS n FROM games'),
    positions: one('SELECT COUNT(*) AS n FROM positions'),
    evaluations: one('SELECT COUNT(*) AS n FROM evaluations'),
    players: one('SELECT COUNT(*) AS n FROM players'),
  };
}

function listGames({ limit = 50, offset = 0, player } = {}) {
  const d = getDb();
  const where = player ? 'WHERE g.id IN (SELECT game_id FROM player_games WHERE player_id = ?)' : '';
  const args = player ? [player] : [];
  return d.prepare(`
    SELECT g.id, g.source, g.url, g.white_name, g.black_name, g.white_elo, g.black_elo, g.result, g.time_class, g.time_control,
           g.played_at, g.ply_count, g.opening_name, g.parse_error,
           COALESCE(gd.accuracy_white, gq.accuracy_white) AS accuracy_white,
           COALESCE(gd.accuracy_black, gq.accuracy_black) AS accuracy_black,
           COALESCE(gd.elo_white, gq.elo_white) AS est_elo_white,
           COALESCE(gd.elo_black, gq.elo_black) AS est_elo_black,
           CASE WHEN gd.game_id IS NOT NULL THEN 'deep' WHEN gq.game_id IS NOT NULL THEN 'quick' ELSE NULL END AS analysis_pass
    FROM games g
    LEFT JOIN game_analysis gd ON gd.game_id = g.id AND gd.pass = 'deep'
    LEFT JOIN game_analysis gq ON gq.game_id = g.id AND gq.pass = 'quick'
    ${where}
    ORDER BY COALESCE(g.end_time, 0) DESC, g.id DESC
    LIMIT ? OFFSET ?`).all(...args, Math.min(500, Number(limit) || 50), Number(offset) || 0);
}

function gameDetail(id) {
  const d = getDb();
  const game = d.prepare('SELECT * FROM games WHERE id = ?').get(id);
  if (!game) return null;
  const analyses = d.prepare('SELECT * FROM game_analysis WHERE game_id = ?').all(id);
  const pass = analyses.some((a) => a.pass === 'deep') ? 'deep' : analyses.some((a) => a.pass === 'quick') ? 'quick' : null;
  const moves = d.prepare(`
    SELECT m.ply, m.color, m.san, m.uci, m.clock_ms, m.time_spent_ms,
           a.best_san, a.best_uci, a.eval_best, a.eval_played, a.win_best, a.win_played, a.win_second, a.win_white_after,
           a.loss, a.accuracy, a.classification, a.source, a.depth
    FROM game_moves m LEFT JOIN move_analysis a ON a.game_id = m.game_id AND a.ply = m.ply AND a.pass = ?
    WHERE m.game_id = ? ORDER BY m.ply`).all(pass, id)
    .map((m) => ({ ...m, eval_best: m.eval_best ? JSON.parse(m.eval_best) : null, eval_played: m.eval_played ? JSON.parse(m.eval_played) : null }));
  const queueRows = d.prepare('SELECT pass, status, error FROM analysis_queue WHERE game_id = ?').all(id);
  return { game, pass, analyses: analyses.map((a) => ({ ...a, counts: a.counts ? JSON.parse(a.counts) : null })), moves, queue: queueRows, labels: LABELS };
}

// ---------------------------------------------------------------------------- HTTP

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/application\/json/.test(req.headers['content-type'] || '')) return reject(Object.assign(new Error('Content-Type application/json attendu'), { status: 415 }));
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Fichier trop volumineux'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('JSON invalide'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

async function handle(req, res) {
  // Protection contre le « DNS rebinding » : seules les adresses locales sont acceptées.
  const host = (req.headers.host || '').toLowerCase();
  if (!new RegExp(`^(127\\.0\\.0\\.1|localhost):${config.port}$`).test(host)) return send(res, 403, { error: 'Accès refusé' });
  const url = new URL(req.url, `http://${host}`);
  const p = url.pathname;

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    return send(res, 200, fs.readFileSync(path.join(ROOT, 'public', 'index.html')), 'text/html; charset=utf-8');
  }
  if (req.method === 'GET') {
    const file = staticFile(p);
    if (file) {
      if (!fs.existsSync(file)) return send(res, 404, { error: 'Fichier introuvable' });
      return send(res, 200, fs.readFileSync(file), MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    }
  }
  if (req.method === 'GET' && p === '/api/library') {
    const q = Object.fromEntries(url.searchParams.entries());
    return send(res, 200, listMyGames(q, queue.current?.gameId ?? null));
  }
  if (req.method === 'GET' && p === '/api/openings') return send(res, 200, openingFamilies());
  // --- Sauvegardes
  if (req.method === 'GET' && p === '/api/backups') return send(res, 200, { backups: listBackups(), keep: KEEP, integrity: state.integrity });
  if (req.method === 'GET' && p === '/api/backups/export') {
    const tmp = path.join(os.tmpdir(), `echecs-export-${process.pid}-${Date.now()}.sqlite`);
    exportDatabase(tmp);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.sqlite3',
      'Content-Disposition': `attachment; filename="echecs-${new Date().toISOString().slice(0, 10)}.sqlite"`,
      'Content-Length': fs.statSync(tmp).size,
      'Cache-Control': 'no-store',
    });
    const stream = fs.createReadStream(tmp);
    stream.pipe(res);
    stream.on('close', () => fs.rm(tmp, { force: true }, () => {}));
    return undefined;
  }
  // --- Étape 3 : progression, temps, erreurs, répertoire, entraînement, bilan
  if (req.method === 'GET' && p.startsWith('/api/stats/')) {
    const q = Object.fromEntries(url.searchParams.entries());
    const f = { timeClass: q.timeClass, color: q.color, from: q.from, to: q.to, opponent: q.opponent };
    switch (p) {
      case '/api/stats/dashboard': return send(res, 200, { ...dashboard(f), refresh: state.stats });
      case '/api/stats/time': return send(res, 200, timeStats(f));
      case '/api/stats/errors': return send(res, 200, recurringErrors(f, { examples: 3 }));
      case '/api/stats/repertoire': return send(res, 200, repertoire({ ...f, color: undefined }, {
        color: q.side === 'black' ? 'black' : 'white', maxPlies: Math.min(24, Number(q.depth) || 14), minGames: Math.max(1, Number(q.min) || 2),
      }));
      case '/api/stats/games': return send(res, 200, gamesSummary(String(q.ids ?? '').split(',').map(Number).filter(Number.isFinite).slice(0, 300)));
      case '/api/stats/bilan': return send(res, 200, bilanText(Number(q.n) || 25, f));
      default: break;
    }
  }
  if (req.method === 'GET' && p === '/api/training/session') return send(res, 200, todaySession());
  if (req.method === 'GET' && p === '/api/training/stats') return send(res, 200, trainingStats());
  const vm = /^\/api\/games\/(\d+)\/view$/.exec(p);
  if (req.method === 'GET' && vm) {
    const v = buildGameView(Number(vm[1]), { currentGameId: queue.current?.gameId ?? null });
    return v ? send(res, 200, v) : send(res, 404, { error: 'Partie introuvable' });
  }
  if (req.method === 'GET' && p === '/api/status') {
    return send(res, 200, {
      engine: { ...state.engine, threads: config.engine.threadsResolved, hashMB: config.engine.hashMB, quickDepth: config.engine.quickDepth, deepDepth: config.engine.deepDepth, multiPV: config.engine.multiPV, evalStats: evaluator.stats },
      queue: { ...queue.progress(), waitingForLive: Date.now() < liveActiveUntil },
      imports: state.imports,
      lichess: lichessStatus(),
      stats: stats(),
      players: listPlayers(),
      contactSet: !!String(config.contact || '').trim(),
      integrity: state.integrity,
      lastBackup: listBackups()[0] ?? null,
    });
  }
  if (req.method === 'GET' && p === '/api/games') {
    return send(res, 200, listGames({ limit: url.searchParams.get('limit'), offset: url.searchParams.get('offset'), player: url.searchParams.get('player') }));
  }
  const gm = /^\/api\/games\/(\d+)$/.exec(p);
  if (req.method === 'GET' && gm) {
    const g = gameDetail(Number(gm[1]));
    return g ? send(res, 200, g) : send(res, 404, { error: 'Partie introuvable' });
  }
  if (req.method === 'POST') {
    const body = await readJson(req);
    if (p === '/api/import/chesscom' || p === '/api/import/lichess') {
      const username = String(body.username ?? '').trim();
      if (!username) return send(res, 400, { error: 'Pseudo manquant' });
      return send(res, 202, startImport(p.endsWith('chesscom') ? 'chesscom' : 'lichess', username));
    }
    if (p === '/api/import/pgn') {
      const r = await importPgnText(String(body.pgn ?? ''));
      queue.notify();
      return send(res, 200, r);
    }
    const pm = /^\/api\/games\/(\d+)\/prioritize$/.exec(p);
    if (pm) { queue.prioritize(Number(pm[1])); return send(res, 200, { ok: true }); }
    const um = /^\/api\/games\/(\d+)\/unrequest$/.exec(p);
    if (um) { queue.unrequest(Number(um[1])); return send(res, 200, { ok: true }); }
    if (p === '/api/queue/mode') { queue.setMode(String(body.mode)); return send(res, 200, queue.progress()); }
    if (p === '/api/training/answer') {
      liveActiveUntil = Date.now() + LIVE_PAUSE_MS;
      return send(res, 200, await answerPuzzle(Number(body.id), String(body.uci ?? ''), { evaluator: state.engine.status === 'ready' ? liveEvaluator : null }));
    }
    if (p === '/api/training/session/new') return send(res, 200, todaySession({ reset: true }));
    if (p === '/api/backups/create') return send(res, 200, backupDatabase(getDb(), 'manuelle'));
    if (p === '/api/backups/restore') return send(res, 200, await restore(String(body.name ?? '')));
    if (p === '/api/live/move') {
      if (state.engine.status !== 'ready') return send(res, 503, { error: 'Le moteur démarre encore, réessayez dans un instant.' });
      liveActiveUntil = Date.now() + LIVE_PAUSE_MS;
      return send(res, 200, await liveMove(liveEvaluator, body));
    }
    if (p === '/api/sync') { syncTrackedPlayers(); return send(res, 202, { ok: true }); }
    if (p === '/api/queue/pause') { queue.pause(); return send(res, 200, queue.progress()); }
    if (p === '/api/queue/resume') { queue.resume(); return send(res, 200, queue.progress()); }
    if (p === '/api/queue/retry') { queue.retryErrors(); return send(res, 200, queue.progress()); }
  }
  return send(res, 404, { error: 'Introuvable' });
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* pas grave : l'adresse est affichée dans la console */ }
}

// File d'analyse (recréée après une restauration de la base).
function setupQueue() {
  queue = new AnalysisQueue(evaluator);
  queue.recover();
  // Statistiques : mises à jour après chaque analyse.
  queue.onAnalyzed = (gameId) => refreshGameStats(gameId);
}

// Statistiques : mises à jour au démarrage pour les parties analysées depuis.
function refreshStatsInBackground() {
  backfillOpenings()
    .then(() => { state.stats = { refreshing: true, done: 0, total: 0 }; return refreshAllStats({ onProgress: (done, total) => { state.stats = { refreshing: true, done, total }; } }); })
    .then((r) => { state.stats = { refreshing: false, ...r }; })
    .catch((e) => { state.stats = { refreshing: false, error: e.message }; console.error(`  Statistiques : ${e.message}`); });
}

// Restauration d'une sauvegarde : on arrête l'analyse, on remplace la base, on repart.
async function restore(name) {
  await queue.stop();
  for (let i = 0; i < 100 && queue.running; i++) await new Promise((r) => setTimeout(r, 100));
  const result = restoreBackup(name);
  resetStatsSchema();
  ensureStatsSchema();
  state.integrity = integrityCheck();
  setupQueue();
  if (state.engine.status === 'ready' && state.integrity.ok) queue.start();
  refreshStatsInBackground();
  return result;
}

async function main() {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => send(res, e.status || 500, { error: e.message }));
  });
  const url = `http://${HOST}:${config.port}`;

  // On réserve d'abord le port : si l'application tourne déjà (deuxième double-clic), on ouvre simplement
  // la page dans le navigateur, sans toucher à la base ni démarrer de moteur.
  const started = await new Promise((resolve) => {
    server.once('error', async (e) => {
      if (e.code === 'EADDRINUSE') {
        const ours = await fetch(`${url}/api/status`).then((r) => r.ok).catch(() => false);
        if (ours) {
          console.log(`\n  L'application est déjà ouverte : ${url}\n  (la page s'ouvre dans votre navigateur ; vous pouvez fermer cette fenêtre)\n`);
          if (config.openBrowser) openBrowser(url);
          setTimeout(() => process.exit(0), 1500);
          return resolve(false);
        }
        console.error(`\nLe port ${config.port} est utilisé par un autre logiciel.\nChangez "port" dans config.json (par exemple 3738), puis relancez.`);
      } else console.error(e);
      process.exit(1);
    });
    server.listen(config.port, HOST, () => resolve(true));
  });
  if (!started) return;

  openDb();
  // Contrôle d'intégrité, puis sauvegarde quotidienne d'une base saine.
  state.integrity = integrityCheck();
  if (!state.integrity.ok) {
    state.integrity.healthyBackup = latestHealthyBackup();
    console.error(`\n  ATTENTION : la base de données semble endommagée (${state.integrity.messages[0]}).`
      + (state.integrity.healthyBackup ? `\n  Ouvrez l'application pour restaurer la sauvegarde saine du ${state.integrity.healthyBackup.createdAt.slice(0, 10)}.` : ''));
  } else {
    try {
      const b = maybeDailyBackup();
      if (b) console.log(`  Sauvegarde de la base : ${b.name}`);
    } catch (e) { console.error(`  Sauvegarde impossible : ${e.message}`); }
  }
  setupQueue();
  ensureStatsSchema();
  refreshStatsInBackground();
  console.log(`\n  Analyse d'échecs — prête sur ${url}\n  (laissez cette fenêtre ouverte ; Ctrl+C pour quitter)\n`);
  if (config.openBrowser) openBrowser(url);

  // Moteur : téléchargement au premier lancement, puis démarrage de la file d'analyse.
  const already = installedEngine();
  state.engine = { status: already ? 'starting' : 'installing', message: already ? 'Démarrage de Stockfish…' : 'Téléchargement de Stockfish 19…', pct: 0 };
  try {
    await ensureEngine((pr) => {
      state.engine.pct = pr.pct ?? state.engine.pct;
      state.engine.message = pr.phase === 'download' ? `Téléchargement de Stockfish 19… ${pr.pct}%`
        : pr.phase === 'extract' ? 'Décompression…' : pr.phase === 'verify' ? 'Vérification du fichier…' : 'Test du moteur…';
      if (pr.phase === 'download' && pr.pct % 10 === 0) process.stdout.write(`\r  Téléchargement de Stockfish 19… ${pr.pct}%   `);
    });
    await evaluator.init();
    state.engine = { status: 'ready', message: 'Prêt', pct: 100, name: evaluator.engine.name };
    console.log(`  Moteur : ${evaluator.engine.name} — ${config.engine.threadsResolved} threads, hash ${config.engine.hashMB} Mo`);
  } catch (e) {
    state.engine = { status: 'error', message: e.message, pct: 0 };
    console.error(`  Erreur moteur : ${e.message}`);
  }
  if (state.engine.status === 'ready' && state.integrity.ok) queue.start();
  if (config.autoSyncOnStart) syncTrackedPlayers();

  const shutdown = async () => {
    console.log('\n  Fermeture… (l\'analyse reprendra au prochain lancement)');
    await queue.stop();
    await evaluator.close().catch(() => {});
    await liveEvaluator.close().catch(() => {});
    server.close();
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
