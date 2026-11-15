// Classement des coups. Les deux méthodes sont toutes ici, avec la même entrée (les évaluations enregistrées) :
//  - « lichess » : règles exactes de Lichess (lila, Advice.scala) : imprécision, erreur, gaffe d'après les chances
//    de gain de la position avant et après le coup ;
//  - « chesscom » : style chess.com (leur algorithme n'est pas public) : points attendus selon le niveau, seuils
//    publiés par chess.com, et les catégories Brillant, Très bon, Occasion manquée.
// classifyGame() choisit la méthode réglée ; la précision enregistrée est toujours celle de Lichess (judgeLichess).
import { Chess } from 'chess.js';
import { config } from '../config.js';
import { materialBalance, playUci } from '../chessutil.js';
import {
  WIN_K, accuracyFromWinPercents, chesscomGameAccuracy, chesscomMoveAccuracy, chesscomXp, gameAccuracy, lichessCp, lichessWinPercent,
  winningChances,
} from './formulas.js';
import { pieceSacrifice } from './patterns.js';

export const METHODS = ['lichess', 'chesscom'];
export const METHOD_LABELS = { lichess: 'Lichess', chesscom: 'Style chess.com' };
/** Méthode réglée (config.json, ou choix fait dans l'application) : Lichess par défaut. */
export const currentMethod = () => (config.classification.method === 'chesscom' ? 'chesscom' : 'lichess');

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

// Seuils Lichess : perte de chances de gain d'au moins 5 % (imprécision), 10 % (erreur), 15 % (gaffe), soit 0,1 / 0,2 /
// 0,3 en « winning chances » (−1 à +1). En dessous, « excellent » ou « bon » (2,5 %) ne sert qu'à l'affichage.
export const LICHESS_THRESHOLDS = { excellent: 2.5, good: 5, inaccuracy: 10, mistake: 15 };

// Version des règles de classement : quand elle change, les parties déjà analysées sont reclassées
// au lancement suivant (sans moteur, après une sauvegarde de la base).
export const CLASSIFICATION_VERSION = 6;

/**
 * Empreinte des réglages qui changent le classement ou la précision enregistrés : si elle change d'un lancement à
 * l'autre, les parties déjà analysées sont reclassées (src/routes/context.js).
 */
export function classificationSignature() {
  const c = config.classification;
  const parts = { version: CLASSIFICATION_VERSION, method: currentMethod(), bonus: config.accuracy.uncertaintyBonus };
  if (currentMethod() === 'chesscom') {
    Object.assign(parts, { curve: c.curve, thresholds: c.thresholds, miss: c.miss, bestMaxLoss: c.bestMaxLoss, brilliant: c.brilliant, great: c.great, lowElo: c.lowElo });
  }
  return JSON.stringify(parts);
}

// Seuils de perte (en % de chances de gain) de la méthode. Comme chez chess.com, ils ne dépendent pas du niveau.
export function thresholdsFor(method = currentMethod()) {
  return method === 'lichess' ? LICHESS_THRESHOLDS : config.classification.thresholds;
}

/**
 * Catégorie d'après la perte. Lichess : une perte égale au seuil passe dans la catégorie suivante (imprécision dès 5).
 * chess.com (inclusive) : « Excellent ≤ 0,02, Bon 0,02–0,05… » : une perte égale au seuil reste dans la catégorie.
 */
export function lossCategory(loss, th, inclusive = false) {
  const under = (x) => (inclusive ? loss <= x : loss < x);
  if (under(th.excellent)) return 'excellent';
  if (under(th.good)) return 'good';
  if (under(th.inaccuracy)) return 'inaccuracy';
  if (under(th.mistake)) return 'mistake';
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


// ---- Style chess.com : règles particulières ----
// Position perdante sous 30 points attendus, gagnante à partir de config.classification.miss.winning (70).
export const LOSING = 30;
// Valeurs par défaut de l'occasion manquée (config.classification.miss) ; MISS_MIN_GAIN sert aussi à la vérification.
export const WINNING = 70;
export const MISS_MIN_GAIN = 10;
const outcome = (x, winning) => (x < LOSING ? 0 : x < winning ? 1 : 2);

/** Réglages « brillant » et « très bon » selon l'Elo du joueur (plus généreux sous 1400 Elo). */
export function generosity(elo) {
  const c = config.classification;
  const low = Number.isFinite(elo) && elo > 0 && c.lowElo?.below && elo < c.lowElo.below;
  return {
    brilliant: { ...c.brilliant, ...(low ? c.lowElo.brilliant : {}) },
    great: { ...c.great, ...(low ? c.lowElo.great : {}) },
  };
}

/** Score vu par l'autre joueur. */
export function negate(s) {
  if (!s) return null;
  return { cp: s.cp != null ? -s.cp : null, mate: s.mate != null ? -s.mate : null, wdl: s.wdl === 'win' ? 'loss' : s.wdl === 'loss' ? 'win' : (s.wdl ?? null) };
}

// Ce qui ne dépend que de la position et du coup (nombre de coups légaux, sacrifice), gardé en mémoire : l'ajustement
// sur les bilans chess.com reclasse les mêmes parties des milliers de fois.
const FEATURES = new Map();
function featuresOf(fen, uci) {
  const key = `${fen}|${uci}`;
  let f = FEATURES.get(key);
  if (!f) {
    if (FEATURES.size > 50000) FEATURES.clear();
    f = { legal: new Chess(fen).moves().length, sacrificeValue: null };
    f.sacrifice = () => (f.sacrificeValue ??= pieceSacrifice(fen, uci).value);
    FEATURES.set(key, f);
  }
  return f;
}

/**
 * Classement « style chess.com » des coups d'une partie, à partir des évaluations, sans moteur.
 * moves[i] : { color, uci, san, fenBefore, book, bestUci, evalBest, evalPlayed, evalSecond }
 *   evalBest / evalPlayed / evalSecond : { cp, mate, wdl } du point de vue du joueur qui joue le coup.
 *   Le sacrifice éventuel est mesuré sur la position (échange statique), sans moteur.
 * players : { w: { elo }, b: { elo } } (Elo de la partie, pour les points attendus).
 * Renvoie pour chaque coup { classification, loss, xpBest, xpPlayed, xpSecond, gain }.
 */
export function classifyChesscom(moves, players = {}) {
  const c = config.classification;
  const th = thresholdsFor('chesscom');
  const ms = c.miss;
  return moves.map((m, i) => {
    const elo = players[m.color]?.elo ?? null;
    const xp = (s) => chesscomXp(s, elo);
    const xpBest = xp(m.evalBest);
    const xpPlayed = xp(m.evalPlayed);
    const xpSecond = m.evalSecond ? xp(m.evalSecond) : null;
    const loss = Math.max(0, xpBest - xpPlayed);
    const prev = i > 0 ? moves[i - 1] : null;
    const prevOpp = prev && prev.color !== m.color && prev.evalBest && prev.evalPlayed ? prev : null;
    // Ce que le coup adverse précédent m'a fait gagner, mesuré avec ma propre courbe.
    const gain = prevOpp ? xp(negate(prevOpp.evalPlayed)) - xp(negate(prevOpp.evalBest)) : 0;
    const out = (classification) => ({ classification, loss, xpBest, xpPlayed, xpSecond, gain });
    if (m.book) return out('book');
    const f = featuresOf(m.fenBefore, m.uci);
    const playedIsBest = m.bestUci === m.uci;
    const g = generosity(elo);
    // Meilleure autre possibilité que le coup joué : le 2e coup du moteur si j'ai joué le 1er, sinon le 1er.
    const xpAlt = playedIsBest ? xpSecond : xpBest;

    // Brillant : bon sacrifice de pièce (cavalier, fou, tour ou dame laissé en prise ou donné, perte nette selon
    // l'échange statique), coup meilleur ou presque, position pas mauvaise après le coup, et je n'étais pas déjà
    // complètement gagnant sans ce coup.
    if (f.legal > 1 && loss <= g.brilliant.maxLoss && xpPlayed >= g.brilliant.minAfter && xpAlt != null && xpAlt < g.brilliant.maxAlternative
        && f.sacrifice() >= g.brilliant.minSacrifice) return out('brilliant');

    // Très bon : coup décisif pour l'issue (perdant → égal, égal → gagnant) ou seul bon coup (écart avec la meilleure
    // autre possibilité). Une simple reprise de pièce n'est pas comptée.
    const isRecapture = !!prev && /x/.test(prev.san ?? '') && /x/.test(m.san ?? '') && prev.uci?.slice(2, 4) === m.uci.slice(2, 4);
    if (f.legal > 1 && loss <= g.great.maxLoss && xpAlt != null && !(g.great.ignoreRecaptures && isRecapture)
        && (outcome(xpPlayed, ms.winning) > outcome(xpAlt, ms.winning) || xpPlayed - xpAlt >= g.great.minGap)) return out('great');

    // Occasion manquée (« Miss » de chess.com : ne pas profiter d'une erreur adverse, ou rater un gain net).
    // Le meilleur coup me donnait une position gagnante, mon coup perd au moins minLoss points, et :
    //  - soit l'adversaire venait de me faire gagner au moins minGain points (erreur ou gaffe) ;
    //  - soit ce gain venait d'apparaître (je n'étais pas gagnant si l'adversaire avait bien joué).
    // Je repasse alors sous le seuil gagnant ; après une erreur adverse, perdre winningLoss points suffit.
    const gift = gain >= ms.minGain;
    const newWin = prevOpp != null && xp(negate(prevOpp.evalBest)) < ms.winning;
    if (xpBest >= ms.winning && loss >= ms.minLoss && (gift || newWin)
        && (xpPlayed < ms.winning || (gift && loss >= ms.winningLoss))) return out('miss');

    if (playedIsBest || loss <= c.bestMaxLoss) return out('best');
    return out(lossCategory(loss, th, true));
  });
}

/**
 * Précision style chess.com d'une partie, à partir des pertes de points attendus du classement style chess.com.
 * Renvoie { white, black }.
 */
export function chesscomAccuracy(moves, players = {}, judged = classifyChesscom(moves, players), p = config.accuracy.chesscom) {
  return chesscomGameAccuracy(moves.map((m, i) => ({ color: m.color, accuracy: chesscomMoveAccuracy(judged[i].loss, p) })), p);
}

// ---- Méthode Lichess exacte ----

const isCp = (s) => s != null && s.mate == null; // centipions, ou table de finales (traitée en centipions)
const adviceCp = (s) => (s.cp != null ? s.cp : lichessCp(s));

/**
 * Jugement Lichess d'un coup (lila, Advice.scala) à partir des évaluations de la position avant et après le coup,
 * vues du joueur qui vient de jouer. null : pas d'imprécision.
 * - Deux évaluations en centipions : perte de « winning chances » (−1 à +1, sans plafond) d'au moins 0,1
 *   (imprécision), 0,2 (erreur) ou 0,3 (gaffe), soit 5, 10 et 15 points de chances de gain.
 * - Sinon, règles des mats (MateAdvice) : « mat créé » (on se fait mater) ou « mat perdu » (on avait un mat).
 *   Imprécision si l'évaluation en centipions (0 pour un mat) passe ±999, erreur au-delà de ±700, gaffe sinon.
 */
export function lichessJudgement(before, after) {
  if (!before || !after) return null;
  if (isCp(before) && isCp(after)) {
    const delta = winningChances(adviceCp(before)) - winningChances(adviceCp(after));
    return delta >= 0.3 ? 'blunder' : delta >= 0.2 ? 'mistake' : delta >= 0.1 ? 'inaccuracy' : null;
  }
  const beforeCp = isCp(before) ? adviceCp(before) : 0;
  const afterCp = isCp(after) ? adviceCp(after) : 0;
  const matedAfter = after.mate != null && after.mate <= 0;
  if (isCp(before) && matedAfter) return beforeCp < -999 ? 'inaccuracy' : beforeCp < -700 ? 'mistake' : 'blunder';
  if (before.mate != null && before.mate > 0 && (isCp(after) || matedAfter)) {
    return afterCp > 999 ? 'inaccuracy' : afterCp > 700 ? 'mistake' : 'blunder';
  }
  return null; // mat retardé, ou mat qui se précise : rien à signaler
}

/** Perte Lichess (points de chances de gain) entre la position avant et après, vues du joueur qui vient de jouer. */
export function lichessLoss(before, after) {
  if (!before || !after) return 0;
  return Math.max(0, 50 * (winningChances(adviceCp(before)) - winningChances(adviceCp(after))));
}

/**
 * Méthode Lichess complète d'une partie (classement et précision), sans moteur.
 * Comme Lichess, chaque coup est jugé sur l'évaluation de la position avant lui (son meilleur coup) et de la position
 * après lui (le meilleur coup du coup suivant, vu de l'autre côté ; pour le dernier coup, l'évaluation du coup joué).
 * Lichess ne juge pas le coup qu'aurait joué le moteur. moves : même forme que classifyChesscom.
 * Renvoie { moves: [{ classification, loss, accuracy }], accuracy: { white, black } }.
 */
export function judgeLichess(moves) {
  const white = (s, color) => (s == null ? null : color === 'w' ? s : negate(s));
  const pos = moves.map((m) => white(m.evalBest, m.color)); // positions P0…Pn-1, vues des Blancs
  const last = moves.at(-1);
  pos.push(last ? white(last.evalPlayed, last.color) : null);
  const pov = (s, color) => (color === 'w' ? s : negate(s));
  const judged = moves.map((m, i) => {
    const before = pos[i] ? pov(pos[i], m.color) : null;
    const after = pos[i + 1] ? pov(pos[i + 1], m.color) : null;
    const loss = lichessLoss(before, after);
    const accuracy = before && after ? accuracyFromWinPercents(lichessWinPercent(before), lichessWinPercent(after)) : null;
    let classification;
    if (m.book) classification = 'book';
    else if (m.bestUci === m.uci) classification = 'best';
    else classification = lichessJudgement(before, after) ?? (loss < LICHESS_THRESHOLDS.excellent ? 'excellent' : 'good');
    return { classification, loss, accuracy };
  });
  const complete = pos.every((p) => p != null);
  const accuracy = complete
    ? gameAccuracy(pos.map(lichessWinPercent), moves.map((m, i) => ({ color: m.color, accuracy: judged[i].accuracy })))
    : { white: null, black: null };
  return { moves: judged, accuracy };
}

/** Classement d'une partie avec la méthode réglée (ou celle demandée) : [{ classification, loss, … }]. */
export function classifyGame(moves, players = {}, method = currentMethod()) {
  return method === 'chesscom' ? classifyChesscom(moves, players) : judgeLichess(moves).moves;
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
