// Classement des coups « à la chess.com ».
import { Chess } from 'chess.js';
import { config } from '../config.js';
import { materialBalance, playUci } from '../chessutil.js';

export const LABELS = {
  book: 'Théorie',
  brilliant: 'Brillant',
  great: 'Très bon',
  best: 'Meilleur',
  excellent: 'Excellent',
  good: 'Bon',
  inaccuracy: 'Imprécision',
  mistake: 'Erreur',
  miss: 'Occasion manquée',
  blunder: 'Gaffe',
};

export const SYMBOLS = {
  book: '📖', brilliant: '!!', great: '!', best: '★', excellent: '👍', good: '✓',
  inaccuracy: '?!', mistake: '?', miss: '✗', blunder: '??',
};

// Seuils de perte (en % de chances de gain) selon l'Elo du joueur qui a joué le coup.
export function thresholdsFor(elo) {
  const c = config.classification;
  if (Number.isFinite(elo) && elo > 0 && c.lowElo && elo < c.lowElo.below) return c.lowElo.thresholds;
  return c.thresholds;
}

export function lossCategory(loss, th) {
  if (loss < th.excellent) return 'excellent';
  if (loss < th.good) return 'good';
  if (loss < th.inaccuracy) return 'inaccuracy';
  if (loss < th.mistake) return 'mistake';
  return 'blunder';
}

/**
 * Variation de matériel (du point de vue du joueur qui joue) après chaque demi-coup d'une ligne.
 * deltas[0] = après le coup joué, deltas[1] = après la réponse adverse, deltas[2] = après notre coup suivant…
 */
export function materialDeltas(fenBefore, pv, maxPlies = 4) {
  const c = new Chess(fenBefore);
  const me = c.turn();
  const m0 = materialBalance(c, me);
  const out = [];
  for (const uci of (pv ?? []).slice(0, maxPlies)) {
    if (!playUci(c, uci)) break;
    out.push(materialBalance(c, me) - m0);
  }
  return out;
}

// Le matériel abandonné l'est encore après la réponse adverse ET après notre coup suivant
// (pas un simple échange où l'on reprend tout de suite).
function holdsDeficit(deltas, minSac) {
  if (deltas.length < 2) return false;
  const afterReply = deltas[1];
  const afterNext = deltas.length >= 3 ? deltas[2] : deltas[1];
  return afterReply <= -minSac && afterNext <= -minSac;
}

/**
 * Sacrifice d'au moins `minSac` points qui tient sur les coups suivants (selon la ligne principale du moteur),
 * et qui était évitable (la meilleure autre ligne ne perd pas ce matériel).
 */
export function isSacrifice(fenBefore, playedPv, altPv, minSac = config.classification.brilliantMinSacrifice) {
  if (!playedPv || playedPv.length < 2) return false;
  if (!holdsDeficit(materialDeltas(fenBefore, playedPv), minSac)) return false;
  if (altPv && altPv.length >= 2 && holdsDeficit(materialDeltas(fenBefore, altPv), minSac)) return false;
  return true;
}

/**
 * Classe un coup. ctx :
 *  book, legalMoves, inCheck, playedIsBest, winBest, winPlayed, winSecond (chances de gain du joueur qui joue),
 *  elo, fenBefore, playedPv, altPv, isRecapture,
 *  prev : { classification, winBest } du coup adverse précédent (ou null)
 * Renvoie { classification, loss }.
 */
export function classifyMove(ctx) {
  const c = config.classification;
  const loss = Math.max(0, ctx.winBest - ctx.winPlayed);
  if (ctx.book) return { classification: 'book', loss };
  const th = thresholdsFor(ctx.elo);

  // Brillant : sacrifice ≥ 2 points qui tient, coup (quasi) égal au meilleur, position pas déjà gagnée à > 90 %.
  if (loss < c.brilliantMaxLoss && ctx.winBest <= c.brilliantMaxWinBefore && !ctx.inCheck && ctx.legalMoves > 1
      && isSacrifice(ctx.fenBefore, ctx.playedPv, ctx.altPv)) {
    return { classification: 'brilliant', loss };
  }

  // Très bon : seul coup qui tient (écart > 10 % avec le 2e coup du MultiPV) et c'est celui qui a été joué.
  if (ctx.playedIsBest && ctx.winSecond != null && ctx.legalMoves > 1 && ctx.winBest - ctx.winSecond > c.greatMinGap
      && !(c.greatIgnoreRecaptures && ctx.isRecapture)) {
    return { classification: 'great', loss };
  }

  // Occasion manquée : l'adversaire vient de commettre une erreur/gaffe et le coup joué ne la punit pas.
  const prev = ctx.prev;
  if (prev && ['mistake', 'blunder', 'miss'].includes(prev.classification) && loss >= th.inaccuracy) {
    const winBeforeTheirError = 100 - prev.winBest;
    // Si le coup rend la position pire qu'avant l'erreur adverse, c'est une vraie erreur/gaffe, pas seulement une occasion manquée.
    if (ctx.winPlayed >= winBeforeTheirError - c.missKeepIfWorseThanBeforeError) {
      return { classification: 'miss', loss };
    }
  }

  if (ctx.playedIsBest || loss <= c.bestMaxLoss) return { classification: 'best', loss };
  return { classification: lossCategory(loss, th), loss };
}
