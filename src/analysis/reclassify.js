// Reclassement des parties déjà analysées (nouvelles règles, ou réglage « Seuils Lichess ») : sans moteur.
// Les évaluations de chaque coup sont enregistrées ; la même fonction de classement que pendant l'analyse
// (classifyMoves, src/analysis/classify.js) est appliquée à ces évaluations.
import { config } from '../config.js';
import { getDb, transaction } from '../db.js';
import { getGame } from '../games.js';
import { classifyMoves, scoreFromWin } from './classify.js';
import { needsVerification } from './analyze.js';

const parse = (j) => (j ? JSON.parse(j) : null);

/** Reclasse une analyse enregistrée. Renvoie le nombre de coups qui changent de catégorie. */
export function reclassifyStored(gameId, pass) {
  const d = getDb();
  const game = getGame(gameId);
  const rows = d.prepare(`SELECT ma.ply, ma.classification, ma.loss, ma.eval_best, ma.eval_played, ma.eval_second, ma.win_second,
        ma.best_uci, ma.verified, ma.depth, ma.source, gm.uci, gm.san, gm.color, gm.fen_before
      FROM move_analysis ma JOIN game_moves gm ON gm.game_id = ma.game_id AND gm.ply = ma.ply
      WHERE ma.game_id = ? AND ma.pass = ? ORDER BY ma.ply`).all(gameId, pass);
  if (!rows.length || rows.some((r) => !r.eval_best || !r.eval_played)) return { changed: 0 };
  const list = rows.map((r) => ({
    color: r.color, uci: r.uci, san: r.san, fenBefore: r.fen_before, book: r.classification === 'book',
    bestUci: r.best_uci, evalBest: parse(r.eval_best), evalPlayed: parse(r.eval_played),
    // Anciennes analyses : seul le pourcentage du 2e coup était enregistré (formule Lichess, inversible).
    evalSecond: parse(r.eval_second) ?? scoreFromWin(r.win_second),
    sacrifice: r.classification === 'brilliant',
  }));
  const judged = classifyMoves(list, { w: { elo: game?.white_elo ?? null }, b: { elo: game?.black_elo ?? null }, timeClass: game?.time_class ?? null });
  const verifyDepth = pass === 'deep' ? config.engine.verifyDepth : 0;
  const quick = pass === 'deep'
    ? new Map(d.prepare("SELECT ply, classification, loss FROM move_analysis WHERE game_id = ? AND pass = 'quick'").all(gameId).map((q) => [q.ply, q]))
    : null;
  const update = d.prepare('UPDATE move_analysis SET classification = ?, loss = ?, eval_second = ? WHERE game_id = ? AND pass = ? AND ply = ?');
  const counts = { w: {}, b: {} };
  let changed = 0;
  let toVerify = false;
  transaction(() => {
    rows.forEach((r, i) => {
      const cls = judged[i].classification;
      if (cls !== r.classification) changed++;
      update.run(cls, judged[i].loss, list[i].evalSecond ? JSON.stringify(list[i].evalSecond) : null, gameId, pass, r.ply);
      // Un coup devenu douteux sans vérification à la profondeur fixe : la partie redevient « à revérifier ».
      if (verifyDepth && needsVerification(judged[i], quick.get(r.ply)) && !r.verified && r.source !== 'tablebase' && (r.depth ?? 0) < verifyDepth) toVerify = true;
      counts[r.color][cls] = (counts[r.color][cls] ?? 0) + 1;
    });
    d.prepare(`UPDATE game_analysis SET counts = ?, analyzed_at = datetime('now')${toVerify ? ', verify_version = NULL' : ''}
      WHERE game_id = ? AND pass = ?`).run(JSON.stringify(counts), gameId, pass);
  });
  return { changed };
}

/**
 * Reclasse toutes les analyses enregistrées avec les seuils actuels.
 * onGame(gameId) est appelé après chaque partie (mise à jour des statistiques et des puzzles).
 */
export async function reclassifyAll({ onProgress, onGame, skip = () => false } = {}) {
  const rows = getDb().prepare('SELECT game_id, pass FROM game_analysis ORDER BY game_id, pass').all();
  let done = 0;
  let changed = 0;
  const failed = [];
  for (const r of rows) {
    if (!skip(r.game_id)) {
      try {
        changed += reclassifyStored(r.game_id, r.pass).changed;
        onGame?.(r.game_id, r.pass);
      } catch (e) {
        failed.push({ gameId: r.game_id, pass: r.pass, error: e.message });
      }
    }
    done++;
    onProgress?.(done, rows.length);
    await new Promise((res) => setImmediate(res)); // laisse le serveur répondre entre deux parties
  }
  return { total: rows.length, changed, failed };
}
