// Enregistrement des parties, de leurs coups et de leur place dans la file d'analyse.
import { getDb, positionId, stmt, transaction } from './db.js';
import { parseGame, isFinishedResult } from './pgn.js';
import { computeOpening } from './library.js';

// Laisse respirer le serveur pendant les gros imports (analyse, page web, moteur continuent de tourner).
export function makeYielder(sliceMs = 40) {
  let last = performance.now();
  return async () => {
    if (performance.now() - last < sliceMs) return;
    await new Promise((r) => setImmediate(r));
    last = performance.now();
  };
}

export function upsertPlayer(source, username, displayName) {
  const d = getDb();
  const uname = username.toLowerCase();
  d.prepare(`INSERT INTO players(source, username, display_name) VALUES (?, ?, ?)
             ON CONFLICT(source, username) DO UPDATE SET display_name = COALESCE(excluded.display_name, players.display_name), tracked = 1`)
    .run(source, uname, displayName ?? username);
  return d.prepare('SELECT * FROM players WHERE source = ? AND username = ?').get(source, uname);
}

export function getPlayer(source, username) {
  return getDb().prepare('SELECT * FROM players WHERE source = ? AND username = ?').get(source, username.toLowerCase());
}

export function listPlayers() {
  return getDb().prepare(`SELECT p.*, (SELECT COUNT(*) FROM player_games pg WHERE pg.player_id = p.id) AS games
                          FROM players p ORDER BY p.source, p.username`).all();
}

function outcomeFor(color, result) {
  if (result === '1/2-1/2') return 'draw';
  if (result === '1-0') return color === 'white' ? 'win' : 'loss';
  if (result === '0-1') return color === 'black' ? 'win' : 'loss';
  return null;
}

function toInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Insère une partie terminée (si elle n'existe pas déjà). Renvoie { id, inserted, skipped? }.
 * meta : { source, sourceId, url, whiteElo, blackElo, timeControl, timeClass, rated, endTime, playedAt, player, color }
 */
export function insertGame(pgn, meta) {
  const existing = stmt('SELECT id FROM games WHERE source = ? AND source_id = ?').get(meta.source, meta.sourceId);
  if (existing) {
    if (meta.player) linkPlayer(meta.player.id, existing.id, meta.color);
    return { id: existing.id, inserted: false };
  }
  const parsed = parseGame(pgn, { timeControl: meta.timeControl });
  const result = parsed.result;
  // Sécurité anti-triche : jamais de partie en cours.
  if (!isFinishedResult(result)) return { id: null, inserted: false, skipped: 'unfinished' };

  const h = parsed.headers;
  const tc = meta.timeControl ?? h.TimeControl ?? null;
  const tcm = tc ? /^(\d+)(?:\+(\d+))?$/.exec(tc) : null;
  const playedAt = meta.playedAt ?? pgnDateToIso(h.UTCDate || h.Date, h.UTCTime || h.EndTime || h.StartTime);
  const endTime = meta.endTime ?? (playedAt ? Math.floor(Date.parse(playedAt) / 1000) : null);

  return transaction(() => {
    const info = stmt(`INSERT INTO games(source, source_id, url, pgn, white_name, black_name, white_elo, black_elo, result,
        termination, time_control, time_class, base_seconds, increment_seconds, rated, start_fen, played_at, end_time, eco,
        opening_name, ply_count, parse_error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      meta.source, meta.sourceId, meta.url ?? h.Link ?? h.Site ?? null, pgn,
      meta.whiteName ?? h.White ?? null, meta.blackName ?? h.Black ?? null,
      meta.whiteElo ?? toInt(h.WhiteElo), meta.blackElo ?? toInt(h.BlackElo),
      result, h.Termination ?? null, tc, meta.timeClass ?? guessTimeClass(tcm),
      tcm ? Number(tcm[1]) : null, tcm ? Number(tcm[2] ?? 0) : null,
      meta.rated == null ? null : (meta.rated ? 1 : 0),
      parsed.isStandardStart ? null : parsed.startFen,
      playedAt, Number.isFinite(endTime) ? endTime : null,
      meta.eco ?? h.ECO ?? null, meta.openingName ?? h.Opening ?? openingFromUrl(h.ECOUrl),
      parsed.moves.length, parsed.error,
    );
    const gameId = Number(info.lastInsertRowid);
    const insMove = stmt(`INSERT INTO game_moves(game_id, ply, color, san, uci, fen_before, position_before, position_after,
                               clock_ms, time_spent_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const m of parsed.moves) {
      insMove.run(gameId, m.ply, m.color, m.san, m.uci, m.fenBefore,
        positionId(m.normBefore, m.piecesBefore), positionId(m.normAfter, m.piecesAfter), m.clockMs, m.timeSpentMs);
    }
    if (meta.player) linkPlayer(meta.player.id, gameId, meta.color, result);
    computeOpening(gameId);
    if (!parsed.error && parsed.moves.length > 0) {
      const q = stmt("INSERT OR IGNORE INTO analysis_queue(game_id, pass, status) VALUES (?, ?, 'pending')");
      q.run(gameId, 'quick');
      q.run(gameId, 'deep');
    }
    return { id: gameId, inserted: true, error: parsed.error };
  });
}

function linkPlayer(playerId, gameId, color, result) {
  if (!color) return;
  const res = result ?? stmt('SELECT result FROM games WHERE id = ?').get(gameId)?.result;
  stmt('INSERT OR IGNORE INTO player_games(player_id, game_id, color, outcome) VALUES (?, ?, ?, ?)')
    .run(playerId, gameId, color, outcomeFor(color, res));
}

function guessTimeClass(tcm) {
  if (!tcm) return null;
  const est = Number(tcm[1]) + 40 * Number(tcm[2] ?? 0); // estimation Lichess
  if (est < 180) return 'bullet';
  if (est < 480) return 'blitz';
  if (est < 1500) return 'rapid';
  return 'classical';
}

function openingFromUrl(url) {
  if (!url) return null;
  const last = url.split('/').pop();
  return last ? decodeURIComponent(last).replace(/-/g, ' ') : null;
}

function pgnDateToIso(date, time) {
  if (!date || /\?/.test(date)) return null;
  const m = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(date);
  if (!m) return null;
  const t = time && /^\d{2}:\d{2}:\d{2}$/.test(time) ? time : '00:00:00';
  return `${m[1]}-${m[2]}-${m[3]}T${t}Z`;
}

export function getGame(id) {
  return getDb().prepare('SELECT * FROM games WHERE id = ?').get(id);
}

export function getGameMoves(id) {
  return getDb().prepare('SELECT * FROM game_moves WHERE game_id = ? ORDER BY ply').all(id);
}
