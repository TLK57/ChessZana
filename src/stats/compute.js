// Statistiques par partie (étape 3), calculées une fois par analyse et mises à jour seulement quand
// une partie est (ré)analysée : rien n'est recalculé inutilement.
import { Chess } from 'chess.js';
import { getDb, stmt, transaction } from '../db.js';
import { myColorOf } from '../library.js';
import { explainMove } from '../analysis/explain.js';
import { gamePhases, clocksBefore, isSimpleMove, isSlow, lostOnTimeWinning, LOW_CLOCK_MS } from './rules.js';

// À augmenter quand les règles changent : toutes les statistiques sont alors recalculées automatiquement.
export const STATS_VERSION = 2; // 2 : nouvelles règles d'explication (types d'erreurs recalculés)
const ERRORS = new Set(['mistake', 'blunder', 'miss']);
const BAD = new Set(['inaccuracy', 'mistake', 'blunder', 'miss']);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS game_stats (
  game_id INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, pass TEXT NOT NULL, analyzed_at TEXT NOT NULL,
  my_color TEXT NOT NULL, my_elo INTEGER, opp_elo INTEGER, outcome TEXT, time_class TEXT,
  played_at TEXT, end_time INTEGER, has_clock INTEGER,
  accuracy REAL, opp_accuracy REAL, est_elo INTEGER, my_moves INTEGER,
  n_blunder INTEGER, n_mistake INTEGER, n_inaccuracy INTEGER, n_miss INTEGER,
  op_n INTEGER, op_acc REAL, mg_n INTEGER, mg_acc REAL, eg_n INTEGER, eg_acc REAL,
  op_t INTEGER, op_tn INTEGER, mg_t INTEGER, mg_tn INTEGER, eg_t INTEGER, eg_tn INTEGER,
  low_n INTEGER, low_bad INTEGER, low_inacc INTEGER, oth_n INTEGER, oth_bad INTEGER, oth_inacc INTEGER,
  simple_n INTEGER, slow_simple INTEGER,
  final_win REAL, lost_time_winning INTEGER,
  exit_ply INTEGER, exit_by_me INTEGER, exit_win_before REAL, exit_win_after REAL,
  opening_name TEXT, eco TEXT,
  computed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_game_stats_played ON game_stats(played_at);

-- Coups du joueur (seulement les siens), avec phase, pendule et type d'erreur.
CREATE TABLE IF NOT EXISTS move_features (
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  ply INTEGER NOT NULL,
  phase TEXT, classification TEXT, loss REAL, accuracy REAL,
  clock_before INTEGER, spent INTEGER, low_clock INTEGER,
  error_type TEXT, simple INTEGER, slow INTEGER, win_before REAL,
  fen_before TEXT, san TEXT, uci TEXT, best_uci TEXT, best_san TEXT,
  PRIMARY KEY (game_id, ply)
);
CREATE INDEX IF NOT EXISTS idx_move_features_type ON move_features(error_type);

-- Puzzles tirés de mes gaffes et occasions manquées, avec la répétition espacée.
CREATE TABLE IF NOT EXISTS puzzles (
  id INTEGER PRIMARY KEY,
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  ply INTEGER NOT NULL,
  fen TEXT NOT NULL, color TEXT NOT NULL,
  solution_uci TEXT NOT NULL, solution_san TEXT,
  played_uci TEXT, played_san TEXT,
  error_type TEXT, classification TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  streak INTEGER NOT NULL DEFAULT 0, interval_days INTEGER, due_date TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, successes INTEGER NOT NULL DEFAULT 0,
  last_result TEXT, last_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (game_id, ply)
);
CREATE TABLE IF NOT EXISTS puzzle_attempts (
  id INTEGER PRIMARY KEY,
  puzzle_id INTEGER NOT NULL REFERENCES puzzles(id) ON DELETE CASCADE,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  session_date TEXT, success INTEGER NOT NULL, answer_uci TEXT
);
`;

let schemaReady = false;
// Après une restauration, la base peut ne pas encore avoir les tables de statistiques.
export function resetStatsSchema() { schemaReady = false; }
export function ensureStatsSchema() {
  if (schemaReady) return;
  getDb().exec(SCHEMA);
  schemaReady = true;
}

export function preferredAnalysis(gameId) {
  return stmt(`SELECT * FROM game_analysis WHERE game_id = ? ORDER BY CASE pass WHEN 'deep' THEN 0 ELSE 1 END LIMIT 1`).get(gameId) ?? null;
}

function linesFor(positionId) {
  const rows = stmt('SELECT kind, lines FROM evaluations WHERE position_id = ?').all(positionId);
  const map = new Map(rows.map((r) => [r.kind, JSON.parse(r.lines)]));
  return map;
}

const toMine = (whiteWin, color) => (whiteWin == null ? null : color === 'white' ? whiteWin : 100 - whiteWin);

function outcomeOf(result, color) {
  if (result === '1/2-1/2') return 'draw';
  if (result === '1-0') return color === 'white' ? 'win' : 'loss';
  if (result === '0-1') return color === 'black' ? 'win' : 'loss';
  return null;
}

/** Recalcule (si besoin) les statistiques d'une partie. Renvoie 'fresh', 'updated' ou 'skipped'. */
export function refreshGameStats(gameId, { force = false } = {}) {
  ensureStatsSchema();
  const d = getDb();
  const g = stmt('SELECT * FROM games WHERE id = ?').get(gameId);
  const color = g ? myColorOf(gameId) : null;
  const ga = g ? preferredAnalysis(gameId) : null;
  if (!g || !color || !ga) {
    d.prepare('DELETE FROM game_stats WHERE game_id = ?').run(gameId);
    d.prepare('DELETE FROM move_features WHERE game_id = ?').run(gameId);
    d.prepare('UPDATE puzzles SET active = 0 WHERE game_id = ?').run(gameId);
    return 'skipped';
  }
  const old = stmt('SELECT version, pass, analyzed_at FROM game_stats WHERE game_id = ?').get(gameId);
  if (!force && old && old.version === STATS_VERSION && old.pass === ga.pass && old.analyzed_at === ga.analyzed_at) return 'fresh';

  const mc = color[0];
  const moves = stmt('SELECT * FROM game_moves WHERE game_id = ? ORDER BY ply').all(gameId);
  const ma = new Map(stmt('SELECT * FROM move_analysis WHERE game_id = ? AND pass = ?').all(gameId, ga.pass).map((r) => [r.ply, r]));
  const phases = gamePhases(moves.map((m) => m.fen_before));
  const mine = moves.map((m, i) => ({ m, i })).filter(({ m }) => m.color === mc);
  const hasClock = g.time_class !== 'daily' && mine.some(({ m }) => m.clock_ms != null);
  const before = clocksBefore(mine.map(({ m }) => m.clock_ms), g.base_seconds != null ? g.base_seconds * 1000 : null);
  const spentKnown = mine.map(({ m }) => m.time_spent_ms).filter((x) => x != null);
  const avgSpent = spentKnown.length ? spentKnown.reduce((a, b) => a + b, 0) / spentKnown.length : null;
  const bookExit = g.book_exit_ply;

  const s = {
    n_blunder: 0, n_mistake: 0, n_inaccuracy: 0, n_miss: 0,
    op_n: 0, op_acc: 0, mg_n: 0, mg_acc: 0, eg_n: 0, eg_acc: 0,
    op_t: 0, op_tn: 0, mg_t: 0, mg_tn: 0, eg_t: 0, eg_tn: 0,
    low_n: 0, low_bad: 0, low_inacc: 0, oth_n: 0, oth_bad: 0, oth_inacc: 0,
    simple_n: 0, slow_simple: 0,
  };
  const features = [];
  const puzzleRows = [];
  mine.forEach(({ m, i }, k) => {
    const a = ma.get(m.ply);
    const phase = phases[i];
    const pre = { opening: 'op', middlegame: 'mg', endgame: 'eg' }[phase];
    const cls = a?.classification ?? null;
    if (cls && `n_${cls}` in s) s[`n_${cls}`]++;
    const isBook = cls === 'book';
    if (a && !isBook) { s[`${pre}_n`]++; s[`${pre}_acc`] += a.accuracy; }
    if (hasClock && m.time_spent_ms != null) { s[`${pre}_t`] += m.time_spent_ms; s[`${pre}_tn`]++; }
    const clockBefore = hasClock ? before[k] : null;
    const low = clockBefore != null && clockBefore < LOW_CLOCK_MS;
    if (a && clockBefore != null && !isBook) {
      if (low) { s.low_n++; if (ERRORS.has(cls)) s.low_bad++; if (cls === 'inaccuracy') s.low_inacc++; }
      else { s.oth_n++; if (ERRORS.has(cls)) s.oth_bad++; if (cls === 'inaccuracy') s.oth_inacc++; }
    }
    let simple = 0, slow = 0, errorType = null;
    if (a) {
      const legal = new Chess(m.fen_before).moves().length;
      simple = isSimpleMove({ legalMoves: legal, winBest: a.win_best, winSecond: a.win_second, playedIsBest: a.best_uci === m.uci }) ? 1 : 0;
      if (simple) s.simple_n++;
      slow = simple && hasClock && isSlow(m.time_spent_ms, avgSpent) ? 1 : 0;
      if (slow) s.slow_simple++;
      if (BAD.has(cls)) {
        const lines = linesFor(m.position_before);
        const multipv = lines.get('multipv') ?? [];
        const playedLine = multipv.find((l) => l.move === m.uci) ?? lines.get(`move:${m.uci}`)?.[0] ?? null;
        const ex = explainMove({
          fenBefore: m.fen_before, playedUci: m.uci,
          playedPv: playedLine?.pv ?? [m.uci], bestPv: multipv[0]?.pv ?? (a.best_uci ? [a.best_uci] : []),
          evalBest: a.eval_best ? JSON.parse(a.eval_best) : null, evalPlayed: a.eval_played ? JSON.parse(a.eval_played) : null,
          classification: cls, lossPct: a.loss, you: true,
        });
        errorType = ex.type;
      }
    }
    features.push([gameId, m.ply, phase, cls, a?.loss ?? null, a?.accuracy ?? null, clockBefore, m.time_spent_ms, low ? 1 : 0,
      errorType, simple, slow, a?.win_best ?? null, m.fen_before, m.san, m.uci, a?.best_uci ?? null, a?.best_san ?? null]);
    if ((cls === 'blunder' || cls === 'miss') && a?.best_uci && a.best_uci !== m.uci) {
      puzzleRows.push([gameId, m.ply, m.fen_before, color, a.best_uci, a.best_san, m.uci, m.san, errorType, cls]);
    }
  });

  // Fin de partie et sortie de la théorie, du point de vue du joueur.
  const last = moves.length ? ma.get(moves[moves.length - 1].ply) : null;
  const finalWin = toMine(last?.win_white_after ?? null, color);
  const outcome = outcomeOf(g.result, color);
  let exitByMe = null, exitBefore = null, exitAfter = null;
  if (bookExit && bookExit <= moves.length) {
    const exitMove = moves[bookExit - 1];
    exitByMe = exitMove.color === mc ? 1 : 0;
    const ea = ma.get(bookExit);
    if (ea) exitBefore = exitMove.color === mc ? ea.win_best : 100 - ea.win_best;
    const later = ma.get(Math.min(bookExit + 10, moves.length));
    exitAfter = toMine(later?.win_white_after ?? null, color);
  }
  const oppColor = color === 'white' ? 'black' : 'white';

  transaction(() => {
    d.prepare('DELETE FROM move_features WHERE game_id = ?').run(gameId);
    const insF = stmt(`INSERT INTO move_features(game_id, ply, phase, classification, loss, accuracy, clock_before, spent, low_clock,
        error_type, simple, slow, win_before, fen_before, san, uci, best_uci, best_san) VALUES (${Array(18).fill('?').join(',')})`);
    for (const f of features) insF.run(...f);
    d.prepare(`INSERT OR REPLACE INTO game_stats(game_id, version, pass, analyzed_at, my_color, my_elo, opp_elo, outcome, time_class,
        played_at, end_time, has_clock, accuracy, opp_accuracy, est_elo, my_moves,
        n_blunder, n_mistake, n_inaccuracy, n_miss, op_n, op_acc, mg_n, mg_acc, eg_n, eg_acc,
        op_t, op_tn, mg_t, mg_tn, eg_t, eg_tn, low_n, low_bad, low_inacc, oth_n, oth_bad, oth_inacc, simple_n, slow_simple,
        final_win, lost_time_winning, exit_ply, exit_by_me, exit_win_before, exit_win_after, opening_name, eco, computed_at)
        VALUES (${Array(48).fill('?').join(',')}, datetime('now'))`).run(
      gameId, STATS_VERSION, ga.pass, ga.analyzed_at, color, g[`${color}_elo`], g[`${oppColor}_elo`], outcome, g.time_class,
      g.played_at, g.end_time, hasClock ? 1 : 0, ga[`accuracy_${color}`], ga[`accuracy_${oppColor}`], ga[`elo_${color}`], mine.length,
      s.n_blunder, s.n_mistake, s.n_inaccuracy, s.n_miss, s.op_n, s.op_acc, s.mg_n, s.mg_acc, s.eg_n, s.eg_acc,
      s.op_t, s.op_tn, s.mg_t, s.mg_tn, s.eg_t, s.eg_tn, s.low_n, s.low_bad, s.low_inacc, s.oth_n, s.oth_bad, s.oth_inacc,
      s.simple_n, s.slow_simple, finalWin,
      lostOnTimeWinning({ outcome, termination: g.termination, finalWin }) ? 1 : 0,
      bookExit, exitByMe, exitBefore, exitAfter, g.book_name ?? g.opening_name, g.book_eco ?? g.eco,
    );
    // Puzzles : on garde la progression des puzzles existants, on désactive ceux qui ne sont plus des erreurs.
    d.prepare('UPDATE puzzles SET active = 0 WHERE game_id = ?').run(gameId);
    const upP = stmt(`INSERT INTO puzzles(game_id, ply, fen, color, solution_uci, solution_san, played_uci, played_san, error_type, classification, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(game_id, ply) DO UPDATE SET fen = excluded.fen, color = excluded.color, solution_uci = excluded.solution_uci,
          solution_san = excluded.solution_san, played_uci = excluded.played_uci, played_san = excluded.played_san,
          error_type = excluded.error_type, classification = excluded.classification, active = 1`);
    for (const p of puzzleRows) upP.run(...p);
  });
  return 'updated';
}

/** Met à jour les statistiques de toutes les parties dont l'analyse a changé (en laissant respirer le serveur). */
export async function refreshAllStats({ onProgress } = {}) {
  ensureStatsSchema();
  const d = getDb();
  const ids = d.prepare(`SELECT DISTINCT a.game_id AS id FROM game_analysis a
      LEFT JOIN game_stats s ON s.game_id = a.game_id
      WHERE s.game_id IS NULL OR s.version <> ? OR s.analyzed_at < a.analyzed_at
         OR (s.pass = 'quick' AND a.pass = 'deep')`).all(STATS_VERSION).map((r) => r.id);
  let last = performance.now();
  let updated = 0;
  for (const [i, id] of ids.entries()) {
    if (refreshGameStats(id) === 'updated') updated++;
    onProgress?.(i + 1, ids.length);
    if (performance.now() - last > 40) { await new Promise((r) => setImmediate(r)); last = performance.now(); }
  }
  return { checked: ids.length, updated };
}
