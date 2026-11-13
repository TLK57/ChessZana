// Bibliothèque de parties : « mes » parties, filtres, ouvertures (base lichess-org/chess-openings).
import { getDb, stmt } from './db.js';
import { bookEntry, isBookPosition, loadBook } from './analysis/openings.js';
import { calibratedElo } from './stats/calibration.js';

// --- Ouverture d'une partie ---------------------------------------------------------------

/**
 * Ouverture d'une partie d'après la base libre : nom de la dernière position de théorie atteinte
 * (en privilégiant une position qui porte exactement ce nom) et premier demi-coup hors théorie.
 */
export function openingFromFens(fensAfter, standardStart = true) {
  if (!standardStart) return { name: null, eco: null, exitPly: null, bookPlies: 0 };
  let name = null, eco = null, exact = false, bookPlies = 0;
  for (let i = 0; i < fensAfter.length; i++) {
    if (!isBookPosition(fensAfter[i])) return { name, eco, exitPly: i + 1, bookPlies };
    const e = bookEntry(fensAfter[i]);
    bookPlies = i + 1;
    if (e && (e.exact || !exact)) { name = e.name; eco = e.eco; exact = !!e.exact; }
  }
  return { name, eco, exitPly: null, bookPlies };
}

export function computeOpening(gameId) {
  const g = stmt('SELECT start_fen FROM games WHERE id = ?').get(gameId);
  if (!g) return null;
  const fens = stmt(`SELECT p.fen FROM game_moves m JOIN positions p ON p.id = m.position_after
                     WHERE m.game_id = ? ORDER BY m.ply`).all(gameId).map((r) => r.fen);
  const o = openingFromFens(fens, !g.start_fen);
  stmt('UPDATE games SET book_name = ?, book_eco = ?, book_exit_ply = ?, book_done = 1 WHERE id = ?')
    .run(o.name, o.eco, o.exitPly, gameId);
  return o;
}

// Calcule l'ouverture des parties qui ne l'ont pas encore (anciennes bases, nouveaux imports).
export async function backfillOpenings() {
  loadBook();
  const ids = getDb().prepare('SELECT id FROM games WHERE book_done = 0').all().map((r) => r.id);
  let last = performance.now();
  for (const id of ids) {
    computeOpening(id);
    if (performance.now() - last > 40) { await new Promise((r) => setImmediate(r)); last = performance.now(); }
  }
  return ids.length;
}

// --- « Mes » parties ------------------------------------------------------------------------

function trackedNames() {
  return getDb().prepare('SELECT username FROM players WHERE tracked = 1').all().map((r) => r.username.toLowerCase());
}

// Couleur jouée par l'utilisateur : d'après le compte importé, sinon d'après le nom dans le PGN.
const MY_COLOR_SQL = (names) => `
  CASE
    WHEN pg.color IS NOT NULL THEN pg.color
    ${names.length ? `WHEN lower(g.white_name) IN (${names.map(() => '?').join(',')}) THEN 'white'
    WHEN lower(g.black_name) IN (${names.map(() => '?').join(',')}) THEN 'black'` : ''}
  END`;

export const TIME_CLASSES = ['bullet', 'blitz', 'rapid', 'classical', 'daily'];

/**
 * filters : { timeClass, color, result, from, to, opening, limit, offset }
 *   result : win | loss | draw (du point de vue de l'utilisateur)
 */
export function listMyGames(filters = {}, currentGameId = null) {
  const names = trackedNames();
  const myColor = MY_COLOR_SQL(names);
  const base = `
    FROM games g
    LEFT JOIN (SELECT game_id, MIN(color) AS color FROM player_games GROUP BY game_id) pg ON pg.game_id = g.id
    LEFT JOIN game_analysis gd ON gd.game_id = g.id AND gd.pass = 'deep'
    LEFT JOIN game_analysis gq ON gq.game_id = g.id AND gq.pass = 'quick'`;
  const where = [];
  const args = [...names, ...names]; // pour MY_COLOR_SQL dans la sous-requête
  const inner = `SELECT g.*, ${myColor} AS my_color,
      COALESCE(gd.accuracy_white, gq.accuracy_white) AS accuracy_white,
      COALESCE(gd.accuracy_black, gq.accuracy_black) AS accuracy_black,
      COALESCE(gd.elo_white, gq.elo_white) AS est_elo_white,
      COALESCE(gd.elo_black, gq.elo_black) AS est_elo_black,
      CASE WHEN gd.game_id IS NOT NULL THEN 'deep' WHEN gq.game_id IS NOT NULL THEN 'quick' END AS analysis_pass,
      (SELECT COUNT(*) FROM analysis_queue aq WHERE aq.game_id = g.id AND aq.priority > 0 AND aq.status IN ('pending', 'running')) AS requested
      ${base}`;
  const fargs = [];
  if (filters.timeClass && TIME_CLASSES.includes(filters.timeClass)) { where.push('x.time_class = ?'); fargs.push(filters.timeClass); }
  if (filters.color === 'white' || filters.color === 'black') { where.push('x.my_color = ?'); fargs.push(filters.color); }
  if (['win', 'loss', 'draw'].includes(filters.result)) {
    where.push(`(CASE WHEN x.result = '1/2-1/2' THEN 'draw'
                      WHEN (x.result = '1-0' AND x.my_color = 'white') OR (x.result = '0-1' AND x.my_color = 'black') THEN 'win'
                      WHEN x.my_color IS NOT NULL THEN 'loss' END) = ?`);
    fargs.push(filters.result);
  }
  if (filters.from && /^\d{4}-\d{2}-\d{2}$/.test(filters.from)) { where.push('x.played_at >= ?'); fargs.push(`${filters.from}T00:00:00`); }
  if (filters.to && /^\d{4}-\d{2}-\d{2}$/.test(filters.to)) { where.push('x.played_at <= ?'); fargs.push(`${filters.to}T23:59:59.999Z`); }
  if (filters.opening) { where.push("(x.book_name = ? OR x.book_name LIKE ? || ':%')"); fargs.push(filters.opening, filters.opening); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const d = getDb();
  const total = d.prepare(`SELECT COUNT(*) AS n FROM (${inner}) x ${whereSql}`).get(...args, ...fargs).n;
  const limit = Math.min(200, Math.max(1, Number(filters.limit) || 50));
  const offset = Math.max(0, Number(filters.offset) || 0);
  const rows = d.prepare(`SELECT x.* FROM (${inner}) x ${whereSql}
                          ORDER BY COALESCE(x.end_time, 0) DESC, x.id DESC LIMIT ? OFFSET ?`).all(...args, ...fargs, limit, offset);
  const games = rows.map((g) => {
    const mine = g.my_color;
    const outcome = g.result === '1/2-1/2' ? 'draw'
      : !mine ? null
        : (g.result === '1-0') === (mine === 'white') ? 'win' : 'loss';
    const opp = mine === 'black' ? 'white' : 'black';
    return {
      id: g.id, source: g.source, url: g.url, playedAt: g.played_at, timeClass: g.time_class, timeControl: g.time_control,
      result: g.result, outcome, myColor: mine,
      me: mine ? { name: g[`${mine}_name`], elo: g[`${mine}_elo`], accuracy: g[`accuracy_${mine}`], estElo: calibratedElo(g[`accuracy_${mine}`], g.time_class, Math.floor((g.ply_count ?? 0) / 2)) } : null,
      opponent: { name: g[`${mine ? opp : 'black'}_name`], elo: g[`${mine ? opp : 'black'}_elo`], accuracy: g[`accuracy_${mine ? opp : 'black'}`] },
      white: { name: g.white_name, elo: g.white_elo, accuracy: g.accuracy_white },
      black: { name: g.black_name, elo: g.black_elo, accuracy: g.accuracy_black },
      opening: g.book_name ?? g.opening_name, eco: g.book_eco ?? g.eco,
      plies: g.ply_count,
      analysis: g.id === currentGameId ? 'running' : (g.analysis_pass ?? (g.parse_error ? 'error' : 'pending')),
      requested: g.requested > 0,
    };
  });
  return { total, games };
}

// Familles d'ouvertures présentes dans mes parties (pour le filtre).
export function openingFamilies() {
  const rows = getDb().prepare("SELECT book_name AS name, COUNT(*) AS n FROM games WHERE book_name IS NOT NULL GROUP BY book_name").all();
  const fam = new Map();
  for (const r of rows) {
    const f = r.name.split(':')[0].trim();
    fam.set(f, (fam.get(f) ?? 0) + r.n);
  }
  return [...fam.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function myColorOf(gameId) {
  const pg = stmt('SELECT color FROM player_games WHERE game_id = ? LIMIT 1').get(gameId);
  if (pg) return pg.color;
  const g = stmt('SELECT white_name, black_name FROM games WHERE id = ?').get(gameId);
  if (!g) return null;
  const names = trackedNames();
  if (names.includes(String(g.white_name).toLowerCase())) return 'white';
  if (names.includes(String(g.black_name).toLowerCase())) return 'black';
  return null;
}
