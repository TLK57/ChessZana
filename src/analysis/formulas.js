// Formules de chances de gain, de précision et d'Elo estimé.
import { config } from '../config.js';

// Formule Lichess : Gain% = 50 + 50 × (2 / (1 + e^(−0,00368208 × cp)) − 1)
export const WIN_K = 0.00368208;

export function winPctFromCp(cp) {
  return 50 + 50 * (2 / (1 + Math.exp(-WIN_K * cp)) - 1);
}

/**
 * Chances de gain (0–100) d'un score vu par le joueur concerné.
 * - mat en N pour lui : 100 % ; mat contre lui (ou déjà maté, « mate 0 ») : 0 %.
 *   Les mats ne passent JAMAIS par la formule en centipions.
 * - table de finales : gain 100 %, nulle 50 %, perte 0 %.
 */
export function winPct(score) {
  if (!score) return 50;
  if (score.wdl) return score.wdl === 'win' ? 100 : score.wdl === 'loss' ? 0 : 50;
  if (score.mate != null) return score.mate > 0 ? 100 : 0;
  if (score.cp != null) return winPctFromCp(score.cp);
  return 50;
}

// ---- Méthode Lichess exacte (scalachess eval.scala, lila AccuracyPercent.scala) ----

/** Plafond des évaluations pour la précision Lichess (Eval.Cp.CEILING) : ±10 pions. */
export const LICHESS_CP_CEILING = 1000;

/** Chances de gain Lichess entre −1 et +1 (WinPercent.winningChances), sans plafond sur l'évaluation. */
export function winningChances(cp) {
  return Math.max(-1, Math.min(1, 2 / (1 + Math.exp(-WIN_K * cp)) - 1));
}

/**
 * Centipions d'un score, comme Lichess : un mat vaut ±1000 (forceAsCp puis plafond), « déjà maté » −1000.
 * Les tables de finales (absentes chez Lichess) : gagné +1000, nulle 0, perdu −1000.
 */
export function lichessCp(score) {
  if (!score) return 0;
  if (score.wdl) return score.wdl === 'win' ? LICHESS_CP_CEILING : score.wdl === 'loss' ? -LICHESS_CP_CEILING : 0;
  if (score.mate != null) return score.mate > 0 ? LICHESS_CP_CEILING : -LICHESS_CP_CEILING;
  return score.cp ?? 0;
}

/** WinPercent Lichess (0–100) utilisé par la précision : évaluation plafonnée à ±1000 centipions. */
export function lichessWinPercent(score) {
  const cp = Math.max(-LICHESS_CP_CEILING, Math.min(LICHESS_CP_CEILING, lichessCp(score)));
  return 50 + 50 * winningChances(cp);
}

/**
 * Précision d'un coup (AccuracyPercent.fromWinPercents) à partir des chances de gain du joueur avant et après :
 * 100 si elles ne baissent pas, sinon 103,1668 × e^(−0,04354 × perte) − 3,1669, plus le bonus d'incertitude de
 * Lichess (+1), bornée entre 0 et 100.
 */
export function accuracyFromWinPercents(before, after, bonus = config.accuracy?.uncertaintyBonus ?? 1) {
  if (after >= before) return 100;
  const raw = 103.1668100711649 * Math.exp(-0.04354415386753951 * (before - after)) - 3.166924740191411;
  return Math.min(100, Math.max(0, raw + bonus));
}

// Précision d'un coup à partir d'une perte (points de chances de gain), même formule Lichess.
export function moveAccuracy(loss, bonus = config.accuracy?.uncertaintyBonus ?? 1) {
  return accuracyFromWinPercents(100, 100 - Math.max(0, loss), bonus);
}

// ---- Style chess.com (approximation : chess.com ne publie ni sa courbe ni sa formule de précision) ----
// Paramètres : config.classification.curve et config.accuracy.chesscom (valeurs ajustées sur vos bilans chess.com :
// data/style-chesscom.json, npm run ajuster-chesscom).

/** Elo retenu pour la courbe : celui de la partie, borné ; 1500 s'il est inconnu. */
export function curveElo(elo, curve = config.classification.curve) {
  return Math.min(curve.eloMax, Math.max(curve.eloMin, Number.isFinite(elo) && elo > 0 ? elo : 1500));
}

/** Pente de la courbe (par pion) pour un Elo : k = k1500 × e^(eloSlope × (Elo − 1500) / 1000). */
export function curveSlope(elo, curve = config.classification.curve) {
  return curve.k1500 * Math.exp(curve.eloSlope * ((curveElo(elo, curve) - 1500) / 1000));
}

/**
 * Points attendus (0–100) du joueur, style chess.com, pour un score vu de son côté :
 * 100 / (1 + e^(−k × évaluation en pions)), k dépendant de son Elo (un même avantage vaut moins à faible niveau).
 * Mat pour lui 100, contre lui (ou déjà maté) 0 ; tables de finales : 100, 50 ou 0.
 */
export function chesscomXp(score, elo, curve = config.classification.curve) {
  if (!score) return 50;
  if (score.wdl) return score.wdl === 'win' ? 100 : score.wdl === 'loss' ? 0 : 50;
  if (score.mate != null) return score.mate > 0 ? 100 : 0;
  if (score.cp == null) return 50;
  return 100 / (1 + Math.exp(-curveSlope(elo, curve) * (score.cp / 100)));
}

/** Précision d'un coup style chess.com : scale × e^(−decay × perte) − (scale − 100), bornée entre 0 et 100. */
export function chesscomMoveAccuracy(loss, p = config.accuracy.chesscom) {
  if (!(loss > 0)) return 100;
  return Math.min(100, Math.max(0, p.scale * Math.exp(-p.decay * loss) - (p.scale - 100)));
}

/**
 * Précision de la partie style chess.com : (1 − h) × moyenne + h × moyenne harmonique des précisions par coup
 * (h = harmonicWeight : plus il est grand, plus une gaffe pèse). moves : [{ color, accuracy }].
 */
export function chesscomGameAccuracy(moves, p = config.accuracy.chesscom) {
  const out = { white: null, black: null };
  for (const color of ['w', 'b']) {
    const accs = moves.filter((m) => m.color === color && m.accuracy != null).map((m) => m.accuracy);
    if (!accs.length) continue;
    const mean = accs.reduce((a, b) => a + b, 0) / accs.length;
    const harmonic = accs.length / accs.reduce((a, b) => a + 1 / Math.max(1, b), 0);
    out[color === 'w' ? 'white' : 'black'] = (1 - p.harmonicWeight) * mean + p.harmonicWeight * harmonic;
  }
  return out;
}

function stdDev(xs) {
  const n = xs.length;
  if (!n) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
}

/**
 * Précision de la partie, méthode Lichess complète :
 *   moyenne de (a) la moyenne pondérée par la volatilité et (b) la moyenne harmonique des précisions par coup.
 * `series` : chances de gain des Blancs pour chaque position P0…Pn (n+1 valeurs).
 * `moves`  : [{ color: 'w'|'b', accuracy }] pour chaque demi-coup (n valeurs).
 * Poids d'un coup = écart-type des chances de gain sur une fenêtre glissante, borné entre 0,5 et 12.
 */
export function gameAccuracy(series, moves) {
  const n = moves.length;
  const out = { white: null, black: null };
  if (!n || series.length !== n + 1) return out;
  const windowSize = Math.min(8, Math.max(2, Math.floor(n / 10)));
  const windows = [];
  const pad = Math.min(windowSize, series.length) - 2;
  for (let i = 0; i < pad; i++) windows.push(series.slice(0, windowSize));
  if (series.length <= windowSize) windows.push(series.slice());
  else for (let i = 0; i + windowSize <= series.length; i++) windows.push(series.slice(i, i + windowSize));
  const weights = windows.map((w) => Math.min(12, Math.max(0.5, stdDev(w))));

  for (const color of ['w', 'b']) {
    let sumW = 0, sumWA = 0, sumInv = 0, count = 0;
    moves.forEach((m, i) => {
      if (m.color !== color) return;
      const w = weights[i] ?? 0.5;
      sumW += w;
      sumWA += w * m.accuracy;
      sumInv += 1 / Math.max(1, m.accuracy);
      count++;
    });
    if (!count) continue;
    const weighted = sumWA / sumW;
    const harmonic = count / sumInv;
    out[color === 'w' ? 'white' : 'black'] = (weighted + harmonic) / 2;
  }
  return out;
}

/**
 * Elo estimé de la partie à partir de la précision (interpolation linéaire dans une table, voir README).
 * C'est une ESTIMATION grossière : renvoie null si le joueur a joué trop peu de coups hors théorie.
 */
export function estimateElo(accuracy, movesPlayed, table = config.elo.table, minMoves = config.elo.minMoves) {
  if (accuracy == null || !Number.isFinite(accuracy) || movesPlayed < minMoves) return null;
  const t = [...table].sort((a, b) => a[0] - b[0]);
  if (accuracy <= t[0][0]) return Math.round(t[0][1]);
  for (let i = 1; i < t.length; i++) {
    const [a1, e1] = t[i];
    const [a0, e0] = t[i - 1];
    if (accuracy <= a1) return Math.round((e0 + ((accuracy - a0) / (a1 - a0)) * (e1 - e0)) / 10) * 10;
  }
  return Math.round(t[t.length - 1][1]);
}
