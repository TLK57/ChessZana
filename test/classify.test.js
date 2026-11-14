import './_setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMoves, scoreFromWin, WINNING } from '../src/analysis/classify.js';
import { pieceSacrifice, staticExchange } from '../src/analysis/patterns.js';
import { winPct } from '../src/analysis/formulas.js';
import { START_FEN } from '../src/chessutil.js';

// Score correspondant à un pourcentage de chances de gain (pour écrire les cas en pourcentages).
const sc = (w) => scoreFromWin(w);
// Un coup des Blancs depuis la position de départ : e4 joué, d4 meilleur (sauf indication contraire).
const move = (o = {}) => ({
  color: 'w', uci: 'e2e4', san: 'e4', fenBefore: START_FEN, book: false, bestUci: o.best ? 'e2e4' : 'd2d4',
  evalBest: sc(o.wb ?? 60), evalPlayed: sc(o.wp ?? o.wb ?? 60), evalSecond: o.ws != null ? sc(o.ws) : null, ...o.extra,
});
const cls = (o, players = { w: { elo: 1800 } }) => classifyMoves([move(o)], players)[0].classification;
// Coup adverse précédent (les Noirs), vu de leur côté : évaluation du meilleur coup et du coup joué.
const prevBlack = (theirBest, theirPlayed) => ({ color: 'b', uci: 'e7e5', san: 'e5', book: true, evalBest: sc(theirBest), evalPlayed: sc(theirPlayed) });
const afterPrev = (prev, o) => classifyMoves([prev, move(o)], { w: { elo: 1500 } })[1];

test('seuils de perte 2 / 5 / 10 / 20 %', () => {
  assert.equal(cls({ wb: 60, wp: 58.5 }), 'excellent');
  assert.equal(cls({ wb: 60, wp: 56 }), 'good');
  assert.equal(cls({ wb: 60, wp: 52 }), 'inaccuracy');
  assert.equal(cls({ wb: 60, wp: 49 }), 'mistake');
  assert.equal(cls({ wb: 60, wp: 39 }), 'blunder');
  assert.equal(cls({ wb: 60, best: true }), 'best');
  assert.equal(cls({ wb: 60, wp: 50, extra: { book: true } }), 'book');
});

test('mêmes seuils à tous les niveaux (pas d\'indulgence sous 1400 Elo)', () => {
  for (const elo of [800, 1200, 1800, 2400]) {
    assert.equal(cls({ wb: 60, wp: 57 }, { w: { elo } }), 'good');
    assert.equal(cls({ wb: 60, wp: 48 }, { w: { elo } }), 'mistake');
  }
});

test("très bon : une simple reprise n'est pas comptée", () => {
  const fen = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
  const prev = { color: 'b', uci: 'f6d5', san: 'Nxd5', book: true, evalBest: sc(50), evalPlayed: sc(50) };
  const recapture = { ...move({ wb: 70, best: true, ws: 30 }), uci: 'e4d5', san: 'exd5', bestUci: 'e4d5', fenBefore: fen };
  assert.equal(classifyMoves([prev, recapture], {})[1].classification, 'best');
});

test(`occasion manquée : l'erreur adverse n'est pas punie (seuil gagnant ${WINNING} %)`, () => {
  // Les Noirs avaient 50 % et tombent à 10 % : j'ai gagné 40 points, le meilleur coup me donnait 90 %.
  const prev = prevBlack(50, 10);
  const r = afterPrev(prev, { wb: 90, wp: 60 });
  assert.equal(r.classification, 'miss', 'je repasse sous le seuil gagnant');
  assert.ok(r.gain > 39 && r.gain < 41, `gain ${r.gain}`);
  // Même si le coup gâche tout, l'occasion manquée est comptée comme telle.
  assert.equal(afterPrev(prev, { wb: 90, wp: 5 }).classification, 'miss');
});

test('occasion manquée : erreur adverse punie correctement', () => {
  const prev = prevBlack(50, 10);
  assert.equal(afterPrev(prev, { wb: 90, best: true }).classification, 'best');
  assert.equal(afterPrev(prev, { wb: 90, wp: 88.5 }).classification, 'excellent', 'je reste gagnant et perds moins de 10 points');
});

test('occasion manquée : pas sans un vrai cadeau adverse (moins de 10 points), quelle que soit son étiquette', () => {
  // Le coup adverse ne m'a fait gagner que 5 points : mon mauvais coup est une gaffe ordinaire.
  assert.equal(afterPrev(prevBlack(20, 15), { wb: 85, wp: 60 }).classification, 'blunder');
  // Pas de position gagnante possible : erreur ordinaire, même après un gros cadeau.
  assert.equal(afterPrev(prevBlack(80, 45), { wb: 55, wp: 40 }).classification, 'mistake');
});

test('occasion manquée : position déjà gagnante avant l\'erreur adverse', () => {
  // J'avais déjà 75 % ; l'erreur adverse me donne 92 %.
  const prev = prevBlack(25, 8);
  // Je reste gagnant et perds moins de 10 points : simple imprécision.
  assert.equal(afterPrev(prev, { wb: 92, wp: 85 }).classification, 'inaccuracy');
  // Je reste gagnant mais perds au moins 10 points : occasion manquée.
  assert.equal(afterPrev(prev, { wb: 92, wp: 80 }).classification, 'miss');
});

test('scores reconstitués à partir des pourcentages enregistrés (anciennes analyses)', () => {
  for (const w of [3, 25, 50, 75, 97]) assert.ok(Math.abs(winPct(scoreFromWin(w)) - w) < 0.05, String(w));
  assert.deepEqual(scoreFromWin(100), { cp: null, mate: 1, wdl: null });
  assert.equal(scoreFromWin(null), null);
});

// Le « cadeau grec » classique : Fxh7+ Rxh7 Cg5+ Rg8 Dh5.
const GREEK = 'rnbq1rk1/pppn1ppp/4p3/3pP3/1b1P4/2NB1N2/PPP2PPP/R1BQK2R w KQ - 0 7';

test("sacrifice de pièce selon l'échange statique", () => {
  assert.equal(pieceSacrifice(GREEK, 'd3h7').value, 2, 'Fxh7+ : fou (3) contre pion (1)');
  assert.equal(pieceSacrifice('r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 2 3', 'b5c6').value, 0, 'échange égal');
  assert.equal(pieceSacrifice('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2', 'd1h5').value, 0, 'pièce attaquée mais défendue');
  // Une pièce déjà en prise avant le coup n'est pas un sacrifice de ce coup…
  assert.equal(pieceSacrifice('4k3/8/8/3r4/8/8/3N4/7K w - - 0 1', 'h1g1').value, 0);
  assert.equal(staticExchange('4k3/8/8/3r4/8/8/3N4/7K b - - 0 1', 'd2'), 3);
  // … mais le coup qui retire son défenseur la donne.
  assert.equal(pieceSacrifice('4k3/8/8/3r4/8/8/3N4/4K3 w - - 0 1', 'e1f2').value, 3);
});

const greek = (o) => ({
  color: 'w', uci: 'd3h7', san: 'Bxh7+', fenBefore: GREEK, book: false, bestUci: o.best === false ? 'f3g5' : 'd3h7',
  evalBest: sc(o.wb), evalPlayed: sc(o.wp ?? o.wb), evalSecond: sc(o.ws ?? 55),
});
const one = (m, elo = 1800) => classifyMoves([m], { w: { elo } })[0].classification;

test('brillant : bon sacrifice, meilleur coup ou presque, position pas mauvaise, pas déjà complètement gagnant', () => {
  assert.equal(one(greek({ wb: 75 })), 'brilliant');
  assert.equal(one(greek({ wb: 75, wp: 73.5, best: false })), 'brilliant', 'presque le meilleur (perte ≤ 2)');
  assert.equal(one(greek({ wb: 75, wp: 72, best: false })), 'good', 'perte de 3 points : trop');
  assert.equal(one(greek({ wb: 40, ws: 20 })), 'great', 'position mauvaise après le coup (40 %) : pas brillant');
  assert.equal(one(greek({ wb: 98, ws: 93 })), 'best', 'déjà complètement gagnant sans ce coup');
});

test('brillant : plus généreux sous 1400 Elo', () => {
  assert.equal(one(greek({ wb: 75, wp: 71, best: false }), 1800), 'good');
  assert.equal(one(greek({ wb: 75, wp: 71, best: false }), 1200), 'brilliant', 'perte de 4 points tolérée');
  assert.equal(one(greek({ wb: 42 }), 1200), 'brilliant', 'position à 42 % acceptée');
});

test('très bon : coup décisif (perdant → égal, égal → gagnant) ou seul bon coup', () => {
  assert.equal(cls({ wb: 50, best: true, ws: 20 }), 'great', 'perdant → égal');
  assert.equal(cls({ wb: 75, best: true, ws: 65 }), 'great', 'égal → gagnant');
  assert.equal(cls({ wb: 55, best: true, ws: 38 }), 'great', "seul bon coup (17 points d'écart)");
  assert.equal(cls({ wb: 55, best: true, ws: 45 }), 'best', 'écart de 10 points, même issue');
  assert.equal(cls({ wb: 55, best: true, ws: 44 }, { w: { elo: 1200 } }), 'great', 'sous 1400 Elo : 10 points suffisent');
  assert.equal(cls({ wb: 95, best: true, ws: 88 }), 'best', 'gagnant dans les deux cas');
});
