// Lectures pour le tableau de bord, la gestion du temps, les erreurs récurrentes et le répertoire.
import { getDb } from '../db.js';
import { ERROR_TYPES } from '../analysis/explain.js';
import { isBookPosition } from '../analysis/openings.js';
import { ensureStatsSchema } from './compute.js';
import { PHASE_LABELS } from './rules.js';
import { calibratedElo, calibrationInfo } from './calibration.js';

const TIME_CLASSES = ['bullet', 'blitz', 'rapid', 'classical', 'daily'];

/** filtres : { timeClass, color, from, to, opponent: 'stronger' | 'weaker', last } -> clause SQL sur game_stats (alias s) */
export function filterSql(f = {}) {
  const where = [];
  const args = [];
  if (TIME_CLASSES.includes(f.timeClass)) { where.push('s.time_class = ?'); args.push(f.timeClass); }
  if (f.color === 'white' || f.color === 'black') { where.push('s.my_color = ?'); args.push(f.color); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(f.from ?? '')) { where.push('s.played_at >= ?'); args.push(`${f.from}T00:00:00`); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(f.to ?? '')) { where.push('s.played_at <= ?'); args.push(`${f.to}T23:59:59.999Z`); }
  if (f.opponent === 'stronger') where.push('s.opp_elo > s.my_elo');
  if (f.opponent === 'weaker') where.push('s.opp_elo < s.my_elo');
  if (f.ids?.length) { where.push(`s.game_id IN (${f.ids.map(() => '?').join(',')})`); args.push(...f.ids); }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

/** Identifiants des N dernières parties analysées qui respectent les filtres. */
export function lastGameIds(f, n) {
  ensureStatsSchema();
  const { sql, args } = filterSql(f);
  return getDb().prepare(`SELECT s.game_id FROM game_stats s ${sql} ORDER BY s.played_at DESC LIMIT ?`).all(...args, n).map((r) => r.game_id);
}

const ratio = (a, b) => (b ? a / b : null);

export function dashboard(f = {}) {
  ensureStatsSchema();
  const d = getDb();
  const { sql, args } = filterSql(f);
  const games = d.prepare(`SELECT s.*, g.white_name, g.black_name FROM game_stats s JOIN games g ON g.id = s.game_id ${sql} ORDER BY s.played_at`).all(...args)
    // Elo estimé calibré sur les parties de l'utilisateur (l'estimation générique reste disponible).
    .map((g) => ({ ...g, est_elo_generic: g.est_elo, est_elo: calibratedElo(g.accuracy, g.time_class, g.my_moves) }));
  const sum = (k) => games.reduce((a, g) => a + (g[k] ?? 0), 0);
  const n = games.length;
  const withAcc = games.filter((g) => g.accuracy != null);
  const withElo = games.filter((g) => g.est_elo != null);
  // Évolution mois par mois.
  const months = new Map();
  for (const g of games) {
    const key = (g.played_at ?? '').slice(0, 7);
    if (!key) continue;
    const m = months.get(key) ?? { month: key, games: 0, blunder: 0, mistake: 0, inaccuracy: 0, miss: 0, acc: 0, accN: 0 };
    m.games++; m.blunder += g.n_blunder; m.mistake += g.n_mistake; m.inaccuracy += g.n_inaccuracy; m.miss += g.n_miss;
    if (g.accuracy != null) { m.acc += g.accuracy; m.accN++; }
    months.set(key, m);
  }
  return {
    count: n,
    results: { win: games.filter((g) => g.outcome === 'win').length, draw: games.filter((g) => g.outcome === 'draw').length, loss: games.filter((g) => g.outcome === 'loss').length },
    avgAccuracy: ratio(withAcc.reduce((a, g) => a + g.accuracy, 0), withAcc.length),
    avgEstElo: ratio(withElo.reduce((a, g) => a + g.est_elo, 0), withElo.length),
    calibration: calibrationInfo(),
    series: games.map((g) => ({
      gameId: g.game_id, playedAt: g.played_at, timeClass: g.time_class, color: g.my_color, outcome: g.outcome,
      accuracy: g.accuracy, estElo: g.est_elo, estEloGeneric: g.est_elo_generic, myElo: g.my_elo, oppElo: g.opp_elo,
      opponent: g.my_color === 'white' ? g.black_name : g.white_name, opening: g.opening_name,
    })),
    phases: {
      opening: { accuracy: ratio(sum('op_acc'), sum('op_n')), moves: sum('op_n'), label: PHASE_LABELS.opening },
      middlegame: { accuracy: ratio(sum('mg_acc'), sum('mg_n')), moves: sum('mg_n'), label: PHASE_LABELS.middlegame },
      endgame: { accuracy: ratio(sum('eg_acc'), sum('eg_n')), moves: sum('eg_n'), label: PHASE_LABELS.endgame },
    },
    perGame: {
      blunder: ratio(sum('n_blunder'), n), mistake: ratio(sum('n_mistake'), n),
      inaccuracy: ratio(sum('n_inaccuracy'), n), miss: ratio(sum('n_miss'), n),
    },
    byMonth: [...months.values()].map((m) => ({
      month: m.month, games: m.games,
      blunder: m.blunder / m.games, mistake: m.mistake / m.games, inaccuracy: m.inaccuracy / m.games, miss: m.miss / m.games,
      accuracy: ratio(m.acc, m.accN),
    })),
  };
}

export function timeStats(f = {}) {
  ensureStatsSchema();
  const d = getDb();
  const { sql, args } = filterSql(f);
  const where = sql ? `${sql} AND s.has_clock = 1` : 'WHERE s.has_clock = 1';
  const games = d.prepare(`SELECT s.* FROM game_stats s ${where}`).all(...args);
  const sum = (k) => games.reduce((a, g) => a + (g[k] ?? 0), 0);
  const slow = d.prepare(`SELECT m.game_id, m.ply, m.san, m.spent, m.phase, s.played_at, g.white_name, g.black_name, s.my_color
      FROM move_features m JOIN game_stats s ON s.game_id = m.game_id JOIN games g ON g.id = m.game_id
      ${where} AND m.slow = 1 ORDER BY m.spent DESC LIMIT 15`).all(...args);
  const lostOnTime = d.prepare(`SELECT s.game_id, s.played_at, s.final_win, g.white_name, g.black_name, s.my_color, g.termination
      FROM game_stats s JOIN games g ON g.id = s.game_id ${where} AND s.lost_time_winning = 1 ORDER BY s.played_at DESC`).all(...args);
  const opp = (r) => (r.my_color === 'white' ? r.black_name : r.white_name);
  return {
    games: games.length,
    lowClock: { moves: sum('low_n'), errors: sum('low_bad'), inaccuracies: sum('low_inacc'), errorRate: ratio(sum('low_bad'), sum('low_n')), inaccuracyRate: ratio(sum('low_inacc'), sum('low_n')) },
    otherClock: { moves: sum('oth_n'), errors: sum('oth_bad'), inaccuracies: sum('oth_inacc'), errorRate: ratio(sum('oth_bad'), sum('oth_n')), inaccuracyRate: ratio(sum('oth_inacc'), sum('oth_n')) },
    perPhase: {
      opening: ratio(sum('op_t'), sum('op_tn')), middlegame: ratio(sum('mg_t'), sum('mg_tn')), endgame: ratio(sum('eg_t'), sum('eg_tn')),
    },
    simpleMoves: sum('simple_n'),
    slowSimple: { count: sum('slow_simple'), examples: slow.map((r) => ({ gameId: r.game_id, ply: r.ply, san: r.san, spentMs: r.spent, phase: r.phase, playedAt: r.played_at, opponent: opp(r) })) },
    lostOnTimeWinning: lostOnTime.map((r) => ({ gameId: r.game_id, playedAt: r.played_at, finalWin: r.final_win, opponent: opp(r), termination: r.termination })),
  };
}

/** Types d'erreurs (erreurs, gaffes, occasions manquées) les plus fréquents, avec des exemples. */
export function recurringErrors(f = {}, { examples = 3 } = {}) {
  ensureStatsSchema();
  const d = getDb();
  const { sql, args } = filterSql(f);
  const where = `${sql ? `${sql} AND` : 'WHERE'} m.classification IN ('mistake', 'blunder', 'miss') AND m.error_type IS NOT NULL`;
  const rows = d.prepare(`SELECT m.error_type AS type, COUNT(*) AS n,
        SUM(CASE WHEN m.classification = 'blunder' THEN 1 ELSE 0 END) AS blunders
      FROM move_features m JOIN game_stats s ON s.game_id = m.game_id ${where} GROUP BY m.error_type ORDER BY n DESC`).all(...args);
  const total = rows.reduce((a, r) => a + r.n, 0);
  const ex = d.prepare(`SELECT m.game_id, m.ply, m.san, m.best_san, m.classification, m.phase, m.fen_before, s.played_at, s.my_color,
        g.white_name, g.black_name
      FROM move_features m JOIN game_stats s ON s.game_id = m.game_id JOIN games g ON g.id = m.game_id
      ${where} AND m.error_type = ? ORDER BY CASE m.classification WHEN 'blunder' THEN 0 ELSE 1 END, s.played_at DESC LIMIT ?`);
  return {
    total,
    types: rows.map((r) => ({
      type: r.type, label: ERROR_TYPES[r.type] ?? r.type, count: r.n, blunders: r.blunders, share: total ? r.n / total : 0,
      examples: ex.all(...args, r.type, examples).map((e) => ({
        gameId: e.game_id, ply: e.ply, san: e.san, bestSan: e.best_san, classification: e.classification, phase: e.phase,
        fen: e.fen_before, playedAt: e.played_at, opponent: e.my_color === 'white' ? e.black_name : e.white_name,
      })),
    })),
  };
}

/**
 * Arbre de mes coups pour une couleur : chaque nœud = une suite de coups depuis le départ,
 * avec le nombre de parties, le score et la précision moyenne. maxPlies = profondeur de l'arbre.
 */
export function repertoire(f = {}, { color = 'white', maxPlies = 14, minGames = 2 } = {}) {
  ensureStatsSchema();
  const d = getDb();
  const { sql, args } = filterSql({ ...f, color });
  const games = d.prepare(`SELECT s.game_id, s.outcome, s.accuracy, s.exit_ply, s.exit_by_me, s.exit_win_before, s.exit_win_after, s.played_at
      FROM game_stats s JOIN games g ON g.id = s.game_id ${sql} ${sql ? 'AND' : 'WHERE'} g.start_fen IS NULL`).all(...args);
  const movesStmt = d.prepare(`SELECT m.ply, m.san, m.position_after, p.fen FROM game_moves m JOIN positions p ON p.id = m.position_after
      WHERE m.game_id = ? AND m.ply <= ? ORDER BY m.ply`);
  const root = { san: null, path: [], games: 0, points: 0, accSum: 0, accN: 0, ids: [], children: new Map() };
  const points = { win: 1, draw: 0.5, loss: 0 };
  const exits = new Map();
  const maxExitPly = Math.max(maxPlies, 30);
  for (const g of games) {
    const mv = movesStmt.all(g.game_id, maxExitPly);
    let node = root;
    const visit = (n) => {
      n.games++; n.points += points[g.outcome] ?? 0; n.ids.push(g.game_id);
      if (g.accuracy != null) { n.accSum += g.accuracy; n.accN++; }
    };
    visit(root);
    for (const m of mv.slice(0, maxPlies)) {
      let child = node.children.get(m.san);
      if (!child) {
        child = { san: m.san, ply: m.ply, path: [...node.path, m.san], fen: m.fen, games: 0, points: 0, accSum: 0, accN: 0, ids: [], children: new Map() };
        node.children.set(m.san, child);
      }
      visit(child);
      node = child;
    }
    // Lignes où JE sors de la théorie : regroupées par la suite de coups jusqu'à la sortie.
    if (g.exit_by_me && g.exit_ply && g.exit_ply <= mv.length) {
      const path = mv.slice(0, g.exit_ply).map((m) => m.san);
      const key = path.join(' ');
      const e = exits.get(key) ?? { path, exitPly: g.exit_ply, games: 0, points: 0, deltaSum: 0, deltaN: 0, ids: [] };
      e.games++; e.points += points[g.outcome] ?? 0; e.ids.push(g.game_id);
      if (g.exit_win_before != null && g.exit_win_after != null) { e.deltaSum += g.exit_win_after - g.exit_win_before; e.deltaN++; }
      exits.set(key, e);
    }
  }
  const out = (n) => ({
    san: n.san, ply: n.ply ?? 0, path: n.path, games: n.games,
    score: n.games ? n.points / n.games : null,
    accuracy: n.accN ? n.accSum / n.accN : null,
    book: n.fen ? isBookPosition(n.fen) : true,
    ids: n.ids,
    children: [...n.children.values()].filter((c) => c.games >= minGames).sort((a, b) => b.games - a.games).map(out),
  });
  const lines = [...exits.values()].map((e) => ({
    path: e.path, exitPly: e.exitPly, games: e.games, score: e.points / e.games,
    winDelta: e.deltaN ? e.deltaSum / e.deltaN : null, ids: e.ids,
  }));
  const bad = (l) => (l.winDelta != null && l.winDelta <= -10) || l.score <= 0.35;
  const several = lines.filter((l) => l.games >= 2 && bad(l));
  const problemLines = (several.length ? several : lines.filter(bad))
    .sort((a, b) => (a.winDelta ?? 0) - (b.winDelta ?? 0) || a.score - b.score).slice(0, 12);
  return { color, games: games.length, tree: out(root), problemLines };
}

/** Résumé court de parties (pour les listes cliquables). */
export function gamesSummary(ids) {
  ensureStatsSchema();
  if (!ids.length) return [];
  return getDb().prepare(`SELECT s.game_id, s.played_at, s.my_color, s.outcome, s.accuracy, s.time_class, s.opening_name, s.my_elo, s.opp_elo,
        g.white_name, g.black_name, g.result
      FROM game_stats s JOIN games g ON g.id = s.game_id WHERE s.game_id IN (${ids.map(() => '?').join(',')})
      ORDER BY s.played_at DESC`).all(...ids).map((r) => ({
    gameId: r.game_id, playedAt: r.played_at, color: r.my_color, outcome: r.outcome, accuracy: r.accuracy, timeClass: r.time_class,
    opening: r.opening_name, myElo: r.my_elo, oppElo: r.opp_elo, opponent: r.my_color === 'white' ? r.black_name : r.white_name, result: r.result,
  }));
}
