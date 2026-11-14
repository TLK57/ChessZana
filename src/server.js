// Petit serveur local : n'écoute que sur 127.0.0.1 (jamais accessible depuis le réseau).
// Les adresses de l'API sont rangées par thème dans src/routes/ :
//   static.js (page et fichiers), status.js (état, réglages), games.js (parties, mode libre), stats.js (statistiques,
//   entraînement), imports.js, queue.js (file d'analyse), backups.js ; context.js garde l'état partagé.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { closeDb, openDb } from './db.js';
import { installedEngine, ensureEngine } from './engine/install.js';
import { ensureStatsSchema } from './stats/compute.js';
import { integrityCheck, latestHealthyBackup, maybeDailyBackup } from './backup.js';
import {
  evaluator, getQueue, liveEvaluator, loadClassificationPreset, reclassifyIfRulesChanged, refreshStatsInBackground, setupQueue, state,
  syncTrackedPlayers,
} from './routes/context.js';
import { readJson, send } from './routes/respond.js';
import { serveStatic } from './routes/static.js';
import { statusRoutes } from './routes/status.js';
import { gameRoutes } from './routes/games.js';
import { statsRoutes } from './routes/stats.js';
import { importRoutes } from './routes/imports.js';
import { queueRoutes } from './routes/queue.js';
import { backupRoutes } from './routes/backups.js';

const HOST = '127.0.0.1';
const ROUTES = [statusRoutes, gameRoutes, statsRoutes, importRoutes, queueRoutes, backupRoutes];

async function handle(req, res) {
  // Protection contre le « DNS rebinding » : seules les adresses locales sont acceptées.
  const host = (req.headers.host || '').toLowerCase();
  if (!new RegExp(`^(127\\.0\\.0\\.1|localhost):${config.port}$`).test(host)) return send(res, 403, { error: 'Accès refusé' });
  const url = new URL(req.url, `http://${host}`);
  const p = url.pathname;

  if (serveStatic(req, res, p)) return undefined;
  const body = req.method === 'POST' ? await readJson(req) : null;
  for (const route of ROUTES) {
    if (await route(req, res, { p, url, body })) return undefined;
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
  loadClassificationPreset();
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
  if (!state.integrity.ok || !reclassifyIfRulesChanged()) refreshStatsInBackground();
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
  if (state.engine.status === 'ready' && state.integrity.ok) getQueue().start();
  if (config.autoSyncOnStart) syncTrackedPlayers();

  const shutdown = async () => {
    console.log('\n  Fermeture… (l\'analyse reprendra au prochain lancement)');
    await getQueue().stop();
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
