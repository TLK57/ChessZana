// File d'analyse persistante : passe rapide (profondeur 12) sur toutes les parties, puis passe profonde
// (budget de nœuds par coup, ou profondeur 22 si deepNodes = 0). Selon le mode : parties demandées seulement, ou toutes.
import { getDb, getMeta, setMeta } from './db.js';
import { config } from './config.js';

// Que faut-il analyser ?
//  manual : seulement les parties demandées par l'utilisateur (bouton « Analyser »)
//  quick  : passe rapide sur toutes les parties, passe profonde seulement sur les parties demandées
//  auto   : tout (passe rapide sur toutes, puis passe profonde sur toutes)
export const MODES = ['manual', 'quick', 'auto'];
const MODE_FILTER = {
  manual: 'q.priority > 0',
  quick: "(q.priority > 0 OR q.pass = 'quick')",
  auto: '1 = 1',
};
// « Analyser tout mon historique » : toutes mes parties, après les parties demandées (priorité basse).
// Mes parties : celles d'un compte suivi (import chess.com / Lichess) ou dont un joueur porte le nom d'un compte suivi (PGN).
const MINE = `q.game_id IN (
  SELECT pg.game_id FROM player_games pg JOIN players p ON p.id = pg.player_id WHERE p.tracked = 1
  UNION SELECT g.id FROM games g WHERE lower(g.white_name) IN (SELECT lower(username) FROM players WHERE tracked = 1)
    OR lower(g.black_name) IN (SELECT lower(username) FROM players WHERE tracked = 1))`;
export const HISTORY_STATES = ['off', 'on', 'paused'];
// Durée par défaut d'une analyse (en secondes) tant qu'aucune n'a été mesurée sur cet ordinateur.
const DEFAULT_SECONDS = { quick: 20, deep: 300 };
import { VERIFY_VERSION, analyzeGame } from './analysis/analyze.js';
import { AbortError } from './engine/stockfish.js';

export class AnalysisQueue {
  constructor(evaluator) {
    this.evaluator = evaluator;
    this.running = false;
    this.current = null; // { gameId, pass, ply, total, startedAt, label }
    this.ctrl = null;
    this.wake = null;
    this.lastError = null;
    this.stopped = false;
    this.recent = [];
  }

  get paused() {
    return getMeta('queue_paused', '0') === '1';
  }

  get mode() {
    const m = getMeta('queue_mode', config.analysisMode);
    return MODES.includes(m) ? m : 'manual';
  }

  setMode(mode) {
    if (!MODES.includes(mode)) throw Object.assign(new Error('Mode inconnu'), { status: 400 });
    setMeta('queue_mode', mode);
    this.abortIfUnwanted();
    this.notify();
  }

  get history() {
    const h = getMeta('history_run', 'off');
    return HISTORY_STATES.includes(h) ? h : 'off';
  }

  // start : lance l'analyse de tout l'historique ; pause / resume ; stop : arrête (le travail fait est gardé).
  setHistory(action) {
    const next = { start: 'on', resume: 'on', pause: 'paused', stop: 'off' }[action];
    if (!next) throw Object.assign(new Error('Action inconnue'), { status: 400 });
    if (action === 'start') {
      // Les analyses profondes faites avant les critères de vérification actuels sont refaites : les positions
      // sont en cache, seule la vérification des coups douteux est calculée.
      getDb().prepare(`UPDATE analysis_queue SET status = 'pending', error = NULL
        WHERE pass = 'deep' AND status = 'done' AND ${MINE.replaceAll('q.game_id', 'analysis_queue.game_id')}
          AND game_id IN (SELECT game_id FROM game_analysis WHERE pass = 'deep' AND (verify_version IS NULL OR verify_version < ?))`).run(VERIFY_VERSION);
    }
    setMeta('history_run', next);
    this.abortIfUnwanted();
    this.notify(); // la boucle de la file (déjà lancée) prend les nouvelles parties
    return this.progress();
  }

  filter() {
    const base = MODE_FILTER[this.mode];
    return this.history === 'on' ? `(${base} OR ${MINE})` : base;
  }

  isWanted(gameId, pass) {
    return !!getDb().prepare(`SELECT 1 FROM analysis_queue q WHERE q.game_id = ? AND q.pass = ? AND ${this.filter()}`).get(gameId, pass);
  }

  // Une analyse en cours qui ne fait plus partie de ce qui est demandé est remise en attente.
  abortIfUnwanted() {
    if (this.current && !this.isWanted(this.current.gameId, this.current.pass)) this.ctrl?.abort();
  }

  // Au démarrage : une analyse interrompue par la fermeture redevient « à faire ».
  recover() {
    getDb().prepare("UPDATE analysis_queue SET status = 'pending', updated_at = datetime('now') WHERE status = 'running'").run();
  }

  nextItem() {
    return getDb().prepare(`
      SELECT q.game_id, q.pass, g.white_name, g.black_name, g.played_at
      FROM analysis_queue q JOIN games g ON g.id = q.game_id
      WHERE q.status = 'pending' AND ${this.filter()}
      ORDER BY q.priority DESC, CASE q.pass WHEN 'quick' THEN 0 ELSE 1 END, COALESCE(g.end_time, 0) DESC, g.id DESC
      LIMIT 1`).get();
  }

  setStatus(gameId, pass, status, error = null) {
    getDb().prepare("UPDATE analysis_queue SET status = ?, error = ?, updated_at = datetime('now') WHERE game_id = ? AND pass = ?")
      .run(status, error, gameId, pass);
  }

  notify() {
    if (this.wake) { const w = this.wake; this.wake = null; w(); }
  }

  start() {
    if (this.running || this.paused || this.stopped) return;
    this.running = true;
    this.loop().catch((e) => { this.lastError = e.message; }).finally(() => {
      this.running = false;
      // Une reprise demandée pendant l'arrêt de la boucle doit relancer la file.
      if (!this.paused && !this.stopped) setTimeout(() => this.start(), 1000);
    });
  }

  async loop() {
    while (!this.paused && !this.stopped) {
      const item = this.nextItem();
      if (!item) {
        await new Promise((r) => { this.wake = r; setTimeout(r, 5000); });
        continue;
      }
      this.setStatus(item.game_id, item.pass, 'running');
      this.ctrl = new AbortController();
      this.current = {
        gameId: item.game_id, pass: item.pass, ply: 0, total: 0, startedAt: Date.now(),
        label: `${item.white_name ?? '?'} – ${item.black_name ?? '?'}${item.played_at ? ` (${item.played_at.slice(0, 10)})` : ''}`,
      };
      try {
        await analyzeGame(item.game_id, item.pass, {
          evaluator: this.evaluator,
          signal: this.ctrl.signal,
          onProgress: (ply, total, extra) => {
            if (!this.current) return;
            this.current.ply = ply;
            this.current.total = total;
            this.current.verify = extra?.phase === 'verify' ? { done: extra.done, total: extra.total, depth: extra.depth } : null;
          },
        });
        this.setStatus(item.game_id, item.pass, 'done');
        try { this.onAnalyzed?.(item.game_id, item.pass); } catch { /* les statistiques seront recalculées au prochain lancement */ }
        this.recent.unshift({ gameId: item.game_id, pass: item.pass, at: new Date().toISOString() });
        this.recent = this.recent.slice(0, 20);
      } catch (e) {
        if (e instanceof AbortError || e?.name === 'AbortError') {
          this.setStatus(item.game_id, item.pass, 'pending'); // reprise plus tard (les positions déjà vues sont en cache)
        } else {
          this.lastError = `Partie ${item.game_id} : ${e.message}`;
          this.setStatus(item.game_id, item.pass, 'error', e.message);
        }
      } finally {
        this.current = null;
        this.ctrl = null;
      }
    }
  }

  pause() {
    setMeta('queue_paused', '1');
    this.ctrl?.abort();
    this.notify();
  }

  resume() {
    setMeta('queue_paused', '0');
    this.start();
    this.notify();
  }

  async stop() {
    this.stopped = true;
    this.ctrl?.abort();
    this.notify();
  }

  // Met une partie en tête de file (passe rapide puis passe profonde).
  // reverify : refait la passe profonde déjà faite (positions en cache) pour vérifier les coups douteux.
  prioritize(gameId, { reverify = false } = {}) {
    const d = getDb();
    const top = d.prepare('SELECT COALESCE(MAX(priority), 0) AS p FROM analysis_queue').get().p + 1;
    d.prepare(`UPDATE analysis_queue SET priority = ?,
        status = CASE WHEN status = 'error' OR (? AND pass = 'deep' AND status = 'done') THEN 'pending' ELSE status END
      WHERE game_id = ?`).run(top, reverify ? 1 : 0, gameId);
    // La partie demandée démarre tout de suite : l'analyse en cours d'une autre partie est remise en file
    // (les positions déjà calculées restent en cache, elle reprendra ensuite là où elle en était).
    if (this.current && this.current.gameId !== gameId) this.ctrl?.abort();
    this.notify();
  }

  // Retire une partie de la file (seulement ce qui n'a pas encore été analysé).
  unrequest(gameId) {
    getDb().prepare("UPDATE analysis_queue SET priority = 0 WHERE game_id = ? AND status IN ('pending', 'error')").run(gameId);
    if (this.current?.gameId === gameId) this.abortIfUnwanted();
    this.notify();
  }

  retryErrors() {
    getDb().prepare("UPDATE analysis_queue SET status = 'pending', error = NULL WHERE status = 'error'").run();
    this.notify();
  }

  progress() {
    const rows = getDb().prepare('SELECT pass, status, COUNT(*) AS n FROM analysis_queue GROUP BY pass, status').all();
    const p = {
      quick: { pending: 0, running: 0, done: 0, error: 0, total: 0 },
      deep: { pending: 0, running: 0, done: 0, error: 0, total: 0 },
    };
    for (const r of rows) {
      if (!p[r.pass]) continue;
      p[r.pass][r.status] = r.n;
      p[r.pass].total += r.n;
    }
    // Parties demandées par l'utilisateur (comptées une fois, quelle que soit la passe).
    const req = getDb().prepare(`SELECT
        COUNT(DISTINCT CASE WHEN status IN ('pending', 'running') THEN game_id END) AS waiting,
        COUNT(DISTINCT game_id) AS total
      FROM analysis_queue WHERE priority > 0`).get();
    return {
      paused: this.paused,
      running: this.running,
      mode: this.mode,
      history: this.historyProgress(),
      current: this.current,
      passes: p,
      requested: { waiting: req.waiting, total: req.total },
      lastError: this.lastError,
    };
  }

  // Historique : parties restantes et temps estimé d'après les dernières analyses mesurées sur cet ordinateur.
  historyProgress() {
    const d = getDb();
    const left = d.prepare(`SELECT
        COUNT(DISTINCT q.game_id) AS games,
        SUM(q.pass = 'quick') AS quick,
        SUM(q.pass = 'deep') AS deep
      FROM analysis_queue q WHERE q.status IN ('pending', 'running') AND ${MINE}`).get();
    const total = d.prepare(`SELECT COUNT(DISTINCT q.game_id) AS n FROM analysis_queue q WHERE ${MINE}`).get().n;
    const avg = {};
    let measured = true;
    for (const pass of ['quick', 'deep']) {
      const r = d.prepare(`SELECT AVG(duration_ms) AS ms, COUNT(*) AS n FROM (
          SELECT duration_ms FROM game_analysis WHERE pass = ? AND duration_ms > 0 ORDER BY analyzed_at DESC LIMIT 30)`).get(pass);
      if (r.n >= 3) avg[pass] = r.ms / 1000;
      else { avg[pass] = DEFAULT_SECONDS[pass]; measured = false; }
    }
    const quick = left.quick ?? 0;
    const deep = left.deep ?? 0;
    return {
      state: this.history,
      totalGames: total,
      remainingGames: left.games ?? 0,
      remainingQuick: quick,
      remainingDeep: deep,
      etaSec: Math.round(quick * avg.quick + deep * avg.deep),
      avgSec: { quick: Math.round(avg.quick), deep: Math.round(avg.deep) },
      measured,
    };
  }
}
