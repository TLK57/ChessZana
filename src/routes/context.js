// État partagé du serveur (moteurs, file d'analyse, imports, réglages) et tâches de fond.
import { config, overrideConfig, readStyleFile } from '../config.js';
import { getMeta, setMeta } from '../db.js';
import { getEvaluator, getLiveEvaluator } from '../engine/evaluator.js';
import { AnalysisQueue } from '../queue.js';
import { syncChessCom } from '../importers/chesscom.js';
import { syncLichess } from '../importers/lichess.js';
import { listPlayers } from '../games.js';
import { CLASSIFICATION_VERSION, METHODS, classificationSignature } from '../analysis/classify.js';
import { reclassifyAll, reclassifyStored } from '../analysis/reclassify.js';
import { referenceDataset } from '../analysis/reviews.js';
import { currentParams, fitStyle, writeStyleFile } from '../analysis/fitstyle.js';
import { backfillOpenings } from '../library.js';
import { ensureStatsSchema, refreshAllStats, refreshGameStats, resetStatsSchema } from '../stats/compute.js';
import { backupDatabase, integrityCheck, restoreBackup } from '../backup.js';
import { getDb } from '../db.js';

export const state = {
  stats: { refreshing: false },
  integrity: { ok: true, messages: [] },
  engine: { status: 'starting', message: 'Démarrage…', pct: 0, name: null },
  imports: [], // historique des imports (le plus récent en premier)
  reclassify: { running: false },
  fit: { running: false }, // ajustement du style chess.com sur les bilans saisis
};

export const evaluator = getEvaluator();
export const liveEvaluator = getLiveEvaluator();

// Pendant le mode libre, la file de fond attend entre deux positions pour laisser tout le processeur
// à l'analyse en direct (aucun calcul n'est perdu).
export const LIVE_PAUSE_MS = 45000;
let liveActiveUntil = 0;
evaluator.gate = async (signal) => {
  while (Date.now() < liveActiveUntil && !signal?.aborted) await new Promise((r) => setTimeout(r, 500));
};
export function markLiveActive() { liveActiveUntil = Date.now() + LIVE_PAUSE_MS; }
export const liveActive = () => Date.now() < liveActiveUntil;

// ---------------------------------------------------------------------------- file d'analyse

let queue;
export const getQueue = () => queue;

// File d'analyse (recréée après une restauration de la base).
export function setupQueue() {
  queue = new AnalysisQueue(evaluator);
  queue.recover();
  // Statistiques : mises à jour après chaque analyse.
  queue.onAnalyzed = (gameId) => refreshGameStats(gameId);
}

// ---------------------------------------------------------------------------- imports

let importChain = Promise.resolve();

export function startImport(kind, username) {
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

export function syncTrackedPlayers() {
  for (const p of listPlayers()) {
    if (p.tracked && (p.source === 'chesscom' || p.source === 'lichess')) startImport(p.source, p.username);
  }
}

// ---------------------------------------------------------------------------- classement des coups

// Méthode de classement (« lichess » ou « chesscom », style chess.com) : enregistrée dans la base, puis toutes les
// parties déjà analysées sont reclassées à partir des évaluations enregistrées (sans recalcul). gameId : la partie
// affichée, reclassée tout de suite (l'écran se met à jour sans attendre les autres).
export function setClassificationMethod(method, gameId = null) {
  if (!METHODS.includes(method)) throw Object.assign(new Error('Méthode inconnue'), { status: 400 });
  const changed = method !== config.classification.method;
  setMeta('classification_method', method);
  overrideConfig({ classification: { method } });
  if (changed) {
    if (gameId) {
      for (const pass of ['quick', 'deep']) reclassifyStored(gameId, pass);
      refreshGameStats(gameId);
    }
    reclassifyInBackground();
  }
  return { method, reclassify: state.reclassify };
}

// La méthode choisie dans l'application (enregistrée dans la base) l'emporte sur config.json.
// (L'ancien réglage « classification_preset » n'est plus lu : la méthode Lichess exacte est la nouvelle valeur par défaut.)
export function loadClassificationMethod() {
  try {
    const m = getMeta('classification_method', config.classification.method);
    if (METHODS.includes(m)) overrideConfig({ classification: { method: m } });
  } catch { /* base illisible : réglage par défaut */ }
}

// Nouvelles règles de classement (nouvelle version de l'application) : sauvegarde de la base, puis reclassement
// de toutes les parties déjà analysées, sans moteur. Réglages du classement modifiés depuis le dernier lancement
// (méthode dans config.json, réglages du style chess.com ajustés par npm run ajuster-chesscom) : reclassement aussi,
// sans sauvegarde (les évaluations ne changent pas). Rien à faire si la base est déjà à jour.
export function reclassifyIfRulesChanged() {
  const done = Number(getMeta('classification_version', '1'));
  const sameSettings = getMeta('classification_signature', '') === classificationSignature();
  if (done >= CLASSIFICATION_VERSION && sameSettings) return false;
  const analysed = getDb().prepare('SELECT COUNT(*) AS n FROM game_analysis').get().n;
  if (!analysed) {
    setMeta('classification_version', String(CLASSIFICATION_VERSION));
    setMeta('classification_signature', classificationSignature());
    return false;
  }
  if (done < CLASSIFICATION_VERSION) {
    const b = backupDatabase(getDb(), `avant-reclassement-v${CLASSIFICATION_VERSION}`);
    console.log(`  Nouvelles règles de classement : sauvegarde ${b.name}, puis reclassement de ${analysed} analyses.`);
  } else console.log(`  Réglages du classement modifiés : reclassement de ${analysed} analyses.`);
  reclassifyInBackground(() => setMeta('classification_version', String(CLASSIFICATION_VERSION)));
  return true;
}

function reclassifyInBackground(onDone = null) {
  if (state.reclassify.running) { state.reclassify.again = true; return; }
  state.reclassify = { running: true, done: 0, total: 0, method: config.classification.method };
  reclassifyAll({
    onProgress: (done, total) => Object.assign(state.reclassify, { done, total }),
    onGame: (gameId) => refreshGameStats(gameId),
    skip: (gameId) => queue?.current?.gameId === gameId, // analysée en ce moment : déjà avec les nouveaux seuils
  }).then((r) => {
    const again = state.reclassify.again;
    state.reclassify = { running: false, done: r.total, total: r.total, failed: r.failed.length, method: config.classification.method };
    if (r.failed.length) console.error(`  Reclassement : ${r.failed.length} analyse(s) à relancer (${r.failed[0].error})`);
    else { onDone?.(); if (!again) setMeta('classification_signature', classificationSignature()); }
    if (again) reclassifyInBackground();
  }).catch((e) => { state.reclassify = { running: false, error: e.message }; });
}

// ---------------------------------------------------------------------------- style chess.com

// Ajuste le style chess.com sur les bilans saisis (en tâche de fond), enregistre data/style-chesscom.json, applique
// les nouveaux réglages et, si le style chess.com classe les coups, reclasse les parties.
export function startStyleFit() {
  if (state.fit.running) return state.fit;
  const { games, missing } = referenceDataset(getDb());
  if (!games.length) throw Object.assign(new Error('Aucun bilan chess.com saisi sur une partie analysée.'), { status: 400 });
  state.fit = { running: true, done: 0, total: 1, games: games.length, missing: missing.length };
  const start = currentParams();
  fitStyle(games, { start, onProgress: (done, total) => Object.assign(state.fit, { done, total }) })
    .then((result) => {
      writeStyleFile(result, { games: games.length });
      overrideConfig(readStyleFile(config.dataDir));
      if (getMeta('classification_signature', '') !== classificationSignature()) reclassifyInBackground();
      state.fit = { running: false, games: games.length, missing: missing.length, before: result.before.mae, after: result.after.mae, start, params: result.params };
    })
    .catch((e) => { state.fit = { running: false, error: e.message }; });
  return state.fit;
}

// ---------------------------------------------------------------------------- statistiques et sauvegardes

// Statistiques : mises à jour au démarrage pour les parties analysées depuis.
export function refreshStatsInBackground() {
  backfillOpenings()
    .then(() => { state.stats = { refreshing: true, done: 0, total: 0 }; return refreshAllStats({ onProgress: (done, total) => { state.stats = { refreshing: true, done, total }; } }); })
    .then((r) => { state.stats = { refreshing: false, ...r }; })
    .catch((e) => { state.stats = { refreshing: false, error: e.message }; console.error(`  Statistiques : ${e.message}`); });
}

// Restauration d'une sauvegarde : on arrête l'analyse, on remplace la base, on repart.
export async function restore(name) {
  await queue.stop();
  for (let i = 0; i < 100 && queue.running; i++) await new Promise((r) => setTimeout(r, 100));
  const result = restoreBackup(name);
  resetStatsSchema();
  ensureStatsSchema();
  state.integrity = integrityCheck();
  loadClassificationMethod();
  setupQueue();
  if (state.engine.status === 'ready' && state.integrity.ok) queue.start();
  refreshStatsInBackground();
  return result;
}
