import './_setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { winPct, winPctFromCp, moveAccuracy, gameAccuracy, estimateElo } from '../src/analysis/formulas.js';

const near = (a, b, eps = 0.05) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);

test('chances de gain : formule Lichess en centipions', () => {
  near(winPctFromCp(0), 50);
  near(winPctFromCp(100), 59.1);
  near(winPctFromCp(-100), 40.9);
  near(winPctFromCp(300), 75.1);
});

test('chances de gain : les mats valent 100 % ou 0 % (jamais la formule cp)', () => {
  assert.equal(winPct({ mate: 1 }), 100);
  assert.equal(winPct({ mate: 25 }), 100);
  assert.equal(winPct({ mate: -3 }), 0);
  assert.equal(winPct({ mate: 0 }), 0); // déjà maté
  assert.equal(winPct({ wdl: 'win' }), 100);
  assert.equal(winPct({ wdl: 'draw' }), 50);
  assert.equal(winPct({ wdl: 'loss' }), 0);
});

test('précision par coup : 103,1668 × e^(−0,04354 × perte) − 3,1669, bornée 0–100', () => {
  assert.equal(moveAccuracy(0, 0), 100);
  near(moveAccuracy(10, 0), 63.58);
  near(moveAccuracy(50, 0), 8.53); // 103,1668 × e^(−2,177) − 3,1669
  assert.equal(moveAccuracy(100, 0), 0);
});

test('précision de la partie : moyenne pondérée par la volatilité + moyenne harmonique', () => {
  // Partie parfaite : 100 % des deux côtés.
  const perfect = gameAccuracy([50, 50, 50, 50, 50], [
    { color: 'w', accuracy: 100 }, { color: 'b', accuracy: 100 }, { color: 'w', accuracy: 100 }, { color: 'b', accuracy: 100 },
  ]);
  near(perfect.white, 100); near(perfect.black, 100);
  // Une gaffe des Noirs fait chuter leur précision bien plus que la moyenne simple.
  const r = gameAccuracy([50, 50, 50, 95, 95], [
    { color: 'w', accuracy: 100 }, { color: 'b', accuracy: 100 }, { color: 'w', accuracy: 100 }, { color: 'b', accuracy: 10 },
  ]);
  near(r.white, 100);
  assert.ok(r.black < 55, `précision noire ${r.black}`);
  // Une seule valeur par couleur, jamais NaN, même pour une partie très courte.
  const short = gameAccuracy([50, 55], [{ color: 'w', accuracy: 80 }]);
  near(short.white, 80); assert.equal(short.black, null);
});

test('Elo estimé : croissant avec la précision, absent si trop peu de coups', () => {
  assert.equal(estimateElo(90, 3), null);
  const a = estimateElo(60, 20), b = estimateElo(80, 20), c = estimateElo(95, 20);
  assert.ok(a < b && b < c, `${a} ${b} ${c}`);
});
