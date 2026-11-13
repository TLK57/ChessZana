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
import { analyzeGame } from './analysis/analyze.js';
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
    // Une analyse en cours qui ne fait plus partie du nouveau mode est remise en attente.
    if (this.current && !this.isWanted(this.current.gameId, this.current.pass)) this.ctrl?.abort();
    this.notify();
  }

  isWanted(gameId, pass) {
    return !!getDb().prepare(`SELECT 1 FROM analysis_queue q WHERE q.game_id = ? AND q.pass = ? AND ${MODE_FILTER[this.mode]}`).get(gameId, pass);
  }

  // Au démarrage : une analyse interrompue par la fermeture redevient « à faire ».
  recover() {
    getDb().prepare("UPDATE analysis_queue SET status = 'pending', updated_at = datetime('now') WHERE status = 'running'").run();
  }

  nextItem() {
    return getDb().prepare(`
      SELECT q.game_id, q.pass, g.white_name, g.black_name, g.played_at
      FROM analysis_queue q JOIN games g ON g.id = q.game_id
      WHERE q.status = 'pending' AND ${MODE_FILTER[this.mode]}
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
          onProgress: (ply, total) => { if (this.current) { this.current.ply = ply; this.current.total = total; } },
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
  prioritize(gameId) {
    const d = getDb();
    const top = d.prepare('SELECT COALESCE(MAX(priority), 0) AS p FROM analysis_queue').get().p + 1;
    d.prepare("UPDATE analysis_queue SET priority = ?, status = CASE WHEN status = 'error' THEN 'pending' ELSE status END WHERE game_id = ?")
      .run(top, gameId);
    // La partie demandée démarre tout de suite : l'analyse en cours d'une autre partie est remise en file
    // (les positions déjà calculées restent en cache, elle reprendra ensuite là où elle en était).
    if (this.current && this.current.gameId !== gameId) this.ctrl?.abort();
    this.notify();
  }

  // Retire une partie de la file (seulement ce qui n'a pas encore été analysé).
  unrequest(gameId) {
    getDb().prepare("UPDATE analysis_queue SET priority = 0 WHERE game_id = ? AND status IN ('pending', 'error')").run(gameId);
    if (this.current?.gameId === gameId && !this.isWanted(gameId, this.current.pass)) this.ctrl?.abort();
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
      current: this.current,
      passes: p,
      requested: { waiting: req.waiting, total: req.total },
      lastError: this.lastError,
    };
  }
}
