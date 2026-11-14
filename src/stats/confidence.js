// Fiabilité des statistiques : taille d'échantillon et intervalle de confiance à 95 % (méthode de Wilson).
//
// Un score de 60 % sur 5 parties ne veut presque rien dire ; sur 200 parties, si. L'intervalle de Wilson donne
// la fourchette dans laquelle se trouve, avec 95 % de confiance, la vraie valeur (score ou taux).
// Deux valeurs ne sont présentées comme différentes que si leurs intervalles ne se chevauchent pas.

export const MIN_GAMES = 10; // en dessous : « échantillon trop petit »
const Z95 = 1.959964;

/**
 * Intervalle de Wilson pour `k` réussites sur `n` essais (k peut être fractionnaire : une nulle vaut ½).
 * Renvoie { p, low, high, n } (proportions entre 0 et 1), ou null si n = 0.
 */
export function wilson(k, n, z = Z95) {
  if (!n || n <= 0) return null;
  const p = Math.min(1, Math.max(0, k / n));
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { p, low: Math.max(0, center - half), high: Math.min(1, center + half), n };
}

/** 'higher' si a est nettement au-dessus de b, 'lower' si nettement en dessous, 'similar' si les intervalles se chevauchent. */
export function compare(a, b) {
  if (!a || !b) return 'similar';
  if (a.low > b.high) return 'higher';
  if (a.high < b.low) return 'lower';
  return 'similar';
}

export const enough = (n) => (n ?? 0) >= MIN_GAMES;
