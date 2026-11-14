// Reclassement des parties déjà analysées après un changement de seuils (par exemple « Seuils Lichess »).
// Rien n'est recalculé : la perte de chaque coup est déjà enregistrée, seuls les seuils changent.
// Théorie, brillant et très bon ne dépendent pas des seuils (et sont décidés avant eux) : ils sont gardés tels quels.
import { config } from '../config.js';
import { getDb, transaction } from '../db.js';
import { getGame } from '../games.js';
import { lossCategory, thresholdsFor } from './classify.js';
import { VERIFIED_CLASSES } from './analyze.js';

const THRESHOLD_FREE = new Set(['book', 'brilliant', 'great']);

/** Reclasse une analyse enregistrée avec les seuils actuels. Renvoie le nombre de coups qui changent de catégorie. */
export function reclassifyStored(gameId, pass) {
  const d = getDb();
  const game = getGame(gameId);
  const rows = d.prepare(`SELECT ma.ply, ma.classification, ma.loss, ma.win_best, ma.win_played, ma.best_uci, ma.verified, ma.depth,
        ma.source, gm.uci, gm.color
      FROM move_analysis ma JOIN game_moves gm ON gm.game_id = ma.game_id AND gm.ply = ma.ply
      WHERE ma.game_id = ? AND ma.pass = ? ORDER BY ma.ply`).all(gameId, pass);
  const c = config.classification;
  const verifyDepth = pass === 'deep' ? config.engine.verifyDepth : 0;
  const update = d.prepare('UPDATE move_analysis SET classification = ? WHERE game_id = ? AND pass = ? AND ply = ?');
  const counts = { w: {}, b: {} };
  let prev = null;
  let changed = 0;
  let toVerify = false;
  transaction(() => {
    for (const r of rows) {
      let cls = r.classification;
      if (!THRESHOLD_FREE.has(cls)) {
        // Mêmes règles, dans le même ordre, que classifyMove (src/analysis/classify.js).
        const th = thresholdsFor(r.color === 'w' ? game.white_elo : game.black_elo);
        const loss = r.loss ?? Math.max(0, r.win_best - r.win_played);
        if (prev && ['mistake', 'blunder', 'miss'].includes(prev.classification) && loss >= th.inaccuracy
            && r.win_played >= 100 - prev.winBest - c.missKeepIfWorseThanBeforeError) cls = 'miss';
        else if (r.best_uci === r.uci || loss <= c.bestMaxLoss) cls = 'best';
        else cls = lossCategory(loss, th);
        if (cls !== r.classification) { update.run(cls, gameId, pass, r.ply); changed++; }
      }
      // Un coup devenu douteux sans vérification à la profondeur fixe : la partie redevient « à revérifier ».
      if (VERIFIED_CLASSES.has(cls) && !r.verified && r.source !== 'tablebase' && (r.depth ?? 0) < verifyDepth) toVerify = true;
      counts[r.color][cls] = (counts[r.color][cls] ?? 0) + 1;
      prev = { classification: cls, winBest: r.win_best };
    }
    d.prepare(`UPDATE game_analysis SET counts = ?, analyzed_at = datetime('now')${verifyDepth ? ', verify_depth = ?' : ''}
      WHERE game_id = ? AND pass = ?`).run(JSON.stringify(counts), ...(verifyDepth ? [toVerify ? null : verifyDepth] : []), gameId, pass);
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
