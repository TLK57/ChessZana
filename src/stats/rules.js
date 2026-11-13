// Règles de l'étape 3 (pures, testées) : phases de jeu, gestion du temps, répétition espacée.

// ---------------------------------------------------------------------------- phases de jeu
// Règle (inspirée du « Divider » de Lichess), appliquée à la position AVANT chaque coup :
//  - Finale : 6 pièces ou moins sur l'échiquier, rois et pions non comptés (les deux camps ensemble).
//  - Milieu de jeu : dès que l'une de ces conditions est vraie :
//      a) 10 pièces ou moins (rois et pions non comptés),
//      b) un camp a moins de 4 pièces sur sa première rangée (il a développé ses pièces),
//      c) on a dépassé le 15e coup (30 demi-coups).
//  - Ouverture : avant cela.
// Une phase ne revient jamais en arrière (une fois en finale, on reste en finale).
export const PHASES = ['opening', 'middlegame', 'endgame'];
export const PHASE_LABELS = { opening: 'Ouverture', middlegame: 'Milieu de jeu', endgame: 'Finale' };

export function boardInfo(fen) {
  const rows = fen.split(' ')[0].split('/');
  let pieces = 0;
  for (const row of rows) for (const ch of row) if ('nbrqNBRQ'.includes(ch)) pieces++;
  const count = (row, upper) => [...row].filter((ch) => /[a-z]/i.test(ch) && (upper ? ch === ch.toUpperCase() : ch === ch.toLowerCase())).length;
  return { pieces, whiteBackRank: count(rows[7], true), blackBackRank: count(rows[0], false) };
}

export function rawPhase(fen, ply) {
  const b = boardInfo(fen);
  if (b.pieces <= 6) return 'endgame';
  if (b.pieces <= 10 || b.whiteBackRank < 4 || b.blackBackRank < 4 || ply > 30) return 'middlegame';
  return 'opening';
}

// fens[i] = position avant le demi-coup i+1. Renvoie la phase de chaque demi-coup (monotone).
export function gamePhases(fens) {
  let level = 0;
  return fens.map((fen, i) => {
    level = Math.max(level, PHASES.indexOf(rawPhase(fen, i + 1)));
    return PHASES[level];
  });
}

// ---------------------------------------------------------------------------- gestion du temps
export const LOW_CLOCK_MS = 30000;

/**
 * Temps à la pendule au moment de commencer à réfléchir à chaque coup du joueur.
 * clocks[i] = temps restant après le i-ème coup du joueur (%clk), baseMs = temps initial.
 */
export function clocksBefore(clocks, baseMs) {
  return clocks.map((_, i) => (i === 0 ? (baseMs ?? null) : clocks[i - 1]));
}

/**
 * Coup « simple » : un seul coup raisonnable (un seul coup légal, ou le 2e meilleur coup perd au moins 20 %
 * de chances de gain), et le joueur l'a trouvé.
 */
export function isSimpleMove({ legalMoves, winBest, winSecond, playedIsBest }) {
  if (!playedIsBest) return false;
  if (legalMoves === 1) return true;
  return winSecond != null && winBest - winSecond >= 20;
}

/** Joué « trop lentement » : au moins 5 s ET au moins le double du temps moyen du joueur sur la partie. */
export function isSlow(spentMs, avgMs) {
  if (spentMs == null || avgMs == null || !(avgMs > 0)) return false;
  return spentMs >= 5000 && spentMs >= 2 * avgMs;
}

/** Partie perdue au temps alors que le joueur avait au moins 70 % de chances de gain à la fin. */
export function lostOnTimeWinning({ outcome, termination, finalWin }) {
  if (outcome !== 'loss' || finalWin == null) return false;
  const onTime = /\b(time|temps|timeout|forfeit)\b/i.test(termination ?? '') && !/abandon|resign|checkmate|mat\b/i.test(termination ?? '');
  return onTime && finalWin >= 70;
}

// ---------------------------------------------------------------------------- répétition espacée
// Raté -> revient demain. Réussi -> dans 3 jours, puis 7, 14 et 30 jours (ensuite tous les 30 jours).
export const SUCCESS_INTERVALS = [3, 7, 14, 30];

export function localDate(d = new Date()) {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
}

export function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** card : { streak } ; renvoie { streak, intervalDays, dueDate } après une réponse. */
export function schedule(card, success, today = localDate()) {
  if (!success) return { streak: 0, intervalDays: 1, dueDate: addDays(today, 1) };
  const streak = (card?.streak ?? 0) + 1;
  const intervalDays = SUCCESS_INTERVALS[Math.min(streak - 1, SUCCESS_INTERVALS.length - 1)];
  return { streak, intervalDays, dueDate: addDays(today, intervalDays) };
}
