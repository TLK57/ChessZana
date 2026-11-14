// Elo de performance par cadence, et résumé de l'Elo estimé d'après la précision (indicatif).
import { wilson } from './confidence.js';

const OUTCOME = (result, color) => {
  if (result === '1/2-1/2') return 'draw';
  if (result === '1-0') return color === 'white' ? 'win' : 'loss';
  if (result === '0-1') return color === 'black' ? 'win' : 'loss';
  return null;
};

/**
 * Elo de performance = Elo moyen des adversaires + 400 × (V − D) / N, par cadence (l'Elo d'une cadence
 * n'est pas comparable à celui d'une autre). La fourchette vient de l'intervalle de Wilson du score :
 * (V − D) / N = 2 × score − 1, donc performance = adversaires + 400 × (2 × score − 1).
 * rows : [{ time_class, result, my_color, white_elo, black_elo }]
 */
export function performanceByTimeClass(rows) {
  const by = new Map();
  for (const r of rows) {
    const outcome = OUTCOME(r.result, r.my_color);
    const opp = r.my_color === 'white' ? r.black_elo : r.white_elo;
    if (!outcome || !opp || !r.time_class) continue;
    const t = by.get(r.time_class) ?? { timeClass: r.time_class, n: 0, win: 0, draw: 0, loss: 0, oppSum: 0 };
    t.n++; t[outcome]++; t.oppSum += opp;
    by.set(r.time_class, t);
  }
  return [...by.values()].map((t) => {
    const avgOpp = t.oppSum / t.n;
    const score = wilson(t.win + t.draw / 2, t.n);
    return {
      timeClass: t.timeClass, n: t.n, win: t.win, draw: t.draw, loss: t.loss,
      avgOpp: Math.round(avgOpp),
      performance: Math.round(avgOpp + (400 * (t.win - t.loss)) / t.n),
      low: Math.round(avgOpp + 400 * (2 * score.low - 1)),
      high: Math.round(avgOpp + 400 * (2 * score.high - 1)),
      score,
    };
  }).sort((a, b) => b.n - a.n);
}

/**
 * Elo estimé d'après la précision (indicatif) : moyenne par cadence et fourchette à 95 % de cette moyenne
 * (moyenne ± 1,96 × écart-type / √n). Une partie seule reste imprécise à ± 500 points.
 * games : [{ timeClass, estElo }]
 */
export function estimatedEloByTimeClass(games) {
  const by = new Map();
  for (const g of games) {
    if (g.estElo == null || !g.timeClass) continue;
    const arr = by.get(g.timeClass) ?? [];
    arr.push(g.estElo);
    by.set(g.timeClass, arr);
  }
  return [...by.entries()].map(([timeClass, v]) => {
    const n = v.length;
    const mean = v.reduce((a, x) => a + x, 0) / n;
    const sd = n > 1 ? Math.sqrt(v.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : null;
    const half = sd != null ? (1.96 * sd) / Math.sqrt(n) : null;
    return {
      timeClass, n, mean: Math.round(mean),
      low: half != null ? Math.round(mean - half) : null,
      high: half != null ? Math.round(mean + half) : null,
    };
  }).sort((a, b) => b.n - a.n);
}
