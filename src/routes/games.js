// Parties : liste, détail, écran d'analyse, demandes d'analyse et mode libre.
import { getDb } from '../db.js';
import { LABELS } from '../analysis/classify.js';
import { listMyGames, openingFamilies } from '../library.js';
import { buildGameView, liveMove, liveThreat } from '../analysis/gameview.js';
import { saveReview } from '../analysis/reviews.js';
import { getQueue, liveEvaluator, markLiveActive, state } from './context.js';
import { send } from './respond.js';

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

export async function gameRoutes(req, res, { p, url, body }) {
  const queue = getQueue();
  if (req.method === 'GET') {
    if (p === '/api/library') {
      const q = Object.fromEntries(url.searchParams.entries());
      send(res, 200, listMyGames(q, queue.current?.gameId ?? null));
      return true;
    }
    if (p === '/api/openings') { send(res, 200, openingFamilies()); return true; }
    const vm = /^\/api\/games\/(\d+)\/view$/.exec(p);
    if (vm) {
      const v = buildGameView(Number(vm[1]), { currentGameId: queue.current?.gameId ?? null });
      if (v) send(res, 200, v); else send(res, 404, { error: 'Partie introuvable' });
      return true;
    }
    if (p === '/api/games') {
      send(res, 200, listGames({ limit: url.searchParams.get('limit'), offset: url.searchParams.get('offset'), player: url.searchParams.get('player') }));
      return true;
    }
    const gm = /^\/api\/games\/(\d+)$/.exec(p);
    if (gm) {
      const g = gameDetail(Number(gm[1]));
      if (g) send(res, 200, g); else send(res, 404, { error: 'Partie introuvable' });
      return true;
    }
    return false;
  }
  if (req.method === 'POST') {
    const pm = /^\/api\/games\/(\d+)\/prioritize$/.exec(p);
    if (pm) { queue.prioritize(Number(pm[1]), { reverify: !!body.reverify }); send(res, 200, { ok: true }); return true; }
    const rv = /^\/api\/games\/(\d+)\/chesscom-review$/.exec(p);
    if (rv) { send(res, 200, { review: saveReview(Number(rv[1]), body) }); return true; }
    const um = /^\/api\/games\/(\d+)\/unrequest$/.exec(p);
    if (um) { queue.unrequest(Number(um[1])); send(res, 200, { ok: true }); return true; }
    if (p === '/api/live/threat') {
      if (state.engine.status !== 'ready') { send(res, 503, { error: 'Le moteur démarre encore, réessayez dans un instant.' }); return true; }
      markLiveActive();
      // L'écran a changé de position (requête abandonnée) : on arrête le calcul de Stockfish.
      const ctl = new AbortController();
      res.on('close', () => { if (!res.writableFinished) ctl.abort(); });
      try {
        send(res, 200, await liveThreat(liveEvaluator, body, { signal: ctl.signal }));
      } catch (e) {
        if (e.name !== 'AbortError') throw e;
        if (!res.writableEnded) res.end();
      }
      return true;
    }
    if (p === '/api/live/move') {
      if (state.engine.status !== 'ready') { send(res, 503, { error: 'Le moteur démarre encore, réessayez dans un instant.' }); return true; }
      markLiveActive();
      send(res, 200, await liveMove(liveEvaluator, body));
      return true;
    }
  }
  return false;
}
