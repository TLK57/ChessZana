// Classement des coups, inspiré de chess.com (ce n'est pas l'algorithme de chess.com, qui n'est pas public).
// Réglage possible : seuils Lichess (imprécision dès 5 %, erreur dès 10 %, gaffe dès 15 % de chances de gain perdues).
import fs from 'node:fs';
import path from 'node:path';
import { Chess } from 'chess.js';
import { ROOT, config } from '../config.js';
import { materialBalance, playUci } from '../chessutil.js';
import { WIN_K, winPct } from './formulas.js';

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

export const PRESETS = ['chesscom', 'lichess'];
// Seuils Lichess : perte de chances de gain d'au moins 5 % (imprécision), 10 % (erreur), 15 % (gaffe).
export const LICHESS_THRESHOLDS = { excellent: 2.5, good: 5, inaccuracy: 10, mistake: 15 };

// Version des règles de classement : quand elle change, les parties déjà analysées sont reclassées
// au lancement suivant (sans moteur, après une sauvegarde de la base).
export const CLASSIFICATION_VERSION = 4;

// Seuils de perte (en % de chances de gain) selon le réglage. Comme chess.com, ils ne dépendent pas du niveau.
export function thresholdsFor() {
  const c = config.classification;
  return c.preset === 'lichess' ? LICHESS_THRESHOLDS : c.thresholds;
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
// ---- Règle « occasion manquée » (définition de chess.com : ne pas profiter d'une erreur adverse,
//      et perdre ainsi la chance d'atteindre une position gagnante) ----
export const WINNING = 70; // position gagnante : au moins 70 % de chances de gain (points espérés)
export const MISS_MIN_GAIN = 10; // le coup adverse précédent m'a fait gagner au moins 10 points
export const MISS_MIN_LOSS = 10; // ou mon coup perd au moins 10 points (même si je reste gagnant)

/** Score vu par l'autre joueur. */
export function negate(s) {
  if (!s) return null;
  return { cp: s.cp != null ? -s.cp : null, mate: s.mate != null ? -s.mate : null, wdl: s.wdl === 'win' ? 'loss' : s.wdl === 'loss' ? 'win' : (s.wdl ?? null) };
}

// ---- Points espérés selon le niveau (resources/expected-points.json, npm run fit-curves) ----
let CURVES;
export const CURVES_FILE = path.join(ROOT, 'resources', 'expected-points.json');
// CHESS_CURVES : autre fichier de courbes, ou chaîne vide pour s'en passer (formule Lichess partout).
export function loadCurves(file = process.env.CHESS_CURVES ?? CURVES_FILE) {
  try { CURVES = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; } catch { CURVES = null; }
  return CURVES;
}
const curves = () => (CURVES === undefined ? loadCurves() : CURVES);
// Cadences sans courbe propre : bullet → blitz ; classique et partie par correspondance → rapide.
const CURVE_TC = { bullet: 'blitz', blitz: 'blitz', rapid: 'rapid', classical: 'rapid', daily: 'rapid' };
export const DEFAULT_ELO = 1500;

/** Courbe pour un Elo et une cadence : interpolation linéaire entre les centres des tranches de 100 Elo. */
export function curveFor(elo, timeClass, data = curves()) {
  const bins = data.curves[CURVE_TC[timeClass] ?? 'blitz'];
  const centers = bins.map((b) => b.elo + 50);
  const e = Math.min(centers.at(-1), Math.max(centers[0], Number.isFinite(elo) && elo > 0 ? elo : DEFAULT_ELO));
  let i = 0;
  while (i < bins.length - 2 && e > centers[i + 1]) i++;
  const t = (e - centers[i]) / (centers[i + 1] - centers[i]);
  const mix = (k) => bins[i][k] + t * (bins[i + 1][k] - bins[i][k]);
  return { a: mix('a'), b: mix('b'), mateWin: mix('mateWin'), mateLoss: mix('mateLoss') };
}

/**
 * Points espérés (0–100) du joueur concerné, pour un score vu de son côté.
 * - Mode « inspiré de chess.com » : courbe ajustée sur les parties Lichess de son niveau et de sa cadence
 *   (un +3 ne vaut pas la même chose à 1100 et à 2500 Elo) ; les mats prennent le score moyen observé.
 * - Mode « Seuils Lichess », ou sans fichier de courbes : formule Lichess (chances de gain).
 * - Table de finales : résultat exact (100, 50 ou 0).
 */
export function expectedPoints(score, who = {}) {
  const data = config.classification.preset === 'lichess' || config.classification.levelCurves === false ? null : curves();
  if (!data || !score || score.wdl) return winPct(score);
  const c = curveFor(who.elo, who.timeClass, data);
  if (score.mate != null) return score.mate > 0 ? 100 * c.mateWin : score.mate < 0 ? 100 * c.mateLoss : 0;
  if (score.cp == null) return 50;
  const cp = Math.max(-data.model.cpClamp, Math.min(data.model.cpClamp, score.cp));
  return 100 / (1 + Math.exp(-(c.a + (c.b * cp) / 100)));
}

/**
 * Classe les coups d'une partie à partir des évaluations, sans moteur.
 * moves[i] : { color, uci, san, fenBefore, book, bestUci, evalBest, evalPlayed, evalSecond, sacrifice }
 *   evalBest / evalPlayed / evalSecond : { cp, mate, wdl } du point de vue du joueur qui joue le coup ;
 *   sacrifice : true, false ou une fonction (calcul fait seulement si nécessaire).
 * players : { w: { elo }, b: { elo }, timeClass }.
 * Renvoie pour chaque coup { classification, loss, xpBest, xpPlayed, xpSecond, gain }.
 */
export function classifyMoves(moves, players = {}) {
  const c = config.classification;
  const th = thresholdsFor();
  return moves.map((m, i) => {
    const who = { elo: players[m.color]?.elo ?? null, timeClass: players.timeClass ?? null };
    const xp = (s) => expectedPoints(s, who);
    const xpBest = xp(m.evalBest);
    const xpPlayed = xp(m.evalPlayed);
    const xpSecond = m.evalSecond ? xp(m.evalSecond) : null;
    const loss = Math.max(0, xpBest - xpPlayed);
    const prev = i > 0 ? moves[i - 1] : null;
    // Ce que le coup adverse précédent m'a fait gagner, mesuré avec ma propre courbe.
    const gain = prev && prev.color !== m.color && prev.evalBest && prev.evalPlayed
      ? xp(negate(prev.evalPlayed)) - xp(negate(prev.evalBest)) : 0;
    const out = (classification) => ({ classification, loss, xpBest, xpPlayed, xpSecond, gain });
    if (m.book) return out('book');
    const chess = new Chess(m.fenBefore);
    const legal = chess.moves().length;
    const playedIsBest = m.bestUci === m.uci;

    // Brillant : sacrifice qui tient, coup (quasi) égal au meilleur, position pas déjà gagnée à > 90 %.
    if (loss < c.brilliantMaxLoss && xpBest <= c.brilliantMaxWinBefore && !chess.inCheck() && legal > 1
        && (typeof m.sacrifice === 'function' ? m.sacrifice() : !!m.sacrifice)) return out('brilliant');

    // Très bon : seul coup qui tient (écart > 10 points avec le 2e coup du MultiPV) et c'est celui qui a été joué.
    const isRecapture = !!prev && /x/.test(prev.san ?? '') && /x/.test(m.san ?? '') && prev.uci?.slice(2, 4) === m.uci.slice(2, 4);
    if (playedIsBest && xpSecond != null && legal > 1 && xpBest - xpSecond > c.greatMinGap && !(c.greatIgnoreRecaptures && isRecapture)) return out('great');

    // Occasion manquée : l'erreur adverse m'a fait gagner au moins 10 points, le meilleur coup me donnait une
    // position gagnante, et mon coup me fait repasser sous le seuil gagnant ou perd au moins 10 points.
    if (xpBest >= WINNING && gain >= MISS_MIN_GAIN && (xpPlayed < WINNING || loss >= MISS_MIN_LOSS)) return out('miss');

    if (playedIsBest || loss <= c.bestMaxLoss) return out('best');
    return out(lossCategory(loss, th));
  });
}

/**
 * Score à partir d'un pourcentage de chances de gain calculé avec la formule Lichess (inverse de winPct).
 * Sert pour les anciennes analyses, qui n'enregistraient que le pourcentage du 2e coup du MultiPV.
 */
export function scoreFromWin(w) {
  if (w == null || !Number.isFinite(w)) return null;
  if (w >= 99.999) return { cp: null, mate: 1, wdl: null };
  if (w <= 0.001) return { cp: null, mate: -1, wdl: null };
  return { cp: Math.round(-Math.log(100 / w - 1) / WIN_K), mate: null, wdl: null };
}
