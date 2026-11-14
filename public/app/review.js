// Bilan guidé : les moments clés d'une partie, un par un, comme une revue avec un entraîneur.
// Fonctions pures (testées sans navigateur).

/** Classements qui font un moment clé, et l'ordre de priorité quand il faut en garder peu. */
export const KEY_CLASSES = ['blunder', 'miss', 'mistake', 'brilliant'];

/**
 * Moments clés d'une partie : gaffes, occasions manquées, erreurs et coups brillants, dans l'ordre de la partie.
 * moves : coups de la partie ({ ply, color, classification }).
 * Options : color ('w' | 'b') pour ne garder qu'un camp.
 */
export function keyMoments(moves, { color = null } = {}) {
  return (moves ?? [])
    .filter((m) => KEY_CLASSES.includes(m.classification) && (!color || m.color === color))
    .map((m) => ({ ply: m.ply, color: m.color, classification: m.classification }))
    .sort((a, b) => a.ply - b.ply);
}

/** État du bilan : { moments, index }. Renvoie null s'il n'y a aucun moment clé. */
export function startReview(moves, opts) {
  const moments = keyMoments(moves, opts);
  return moments.length ? { moments, index: 0 } : null;
}

/** Avance (+1) ou recule (−1) dans le bilan, sans sortir des bornes. */
export function stepReview(review, d) {
  if (!review) return null;
  return { ...review, index: Math.max(0, Math.min(review.moments.length - 1, review.index + d)) };
}

/** Moment affiché. */
export const currentMoment = (review) => review?.moments[review.index] ?? null;

/** « Moment 2 sur 5 ». */
export const reviewProgress = (review) => (review ? `Moment ${review.index + 1} sur ${review.moments.length}` : '');
