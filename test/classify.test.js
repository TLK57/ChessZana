import './_setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMove, isSacrifice, materialDeltas } from '../src/analysis/classify.js';

const base = { book: false, legalMoves: 30, inCheck: false, playedIsBest: false, winSecond: null, elo: 1800, fenBefore: null, playedPv: null, altPv: null, isRecapture: false, prev: null };
const cls = (o) => classifyMove({ ...base, ...o }).classification;

test('seuils de perte 2,5 / 6 / 12 / 22 %', () => {
  assert.equal(cls({ winBest: 60, winPlayed: 58 }), 'excellent');
  assert.equal(cls({ winBest: 60, winPlayed: 55 }), 'good');
  assert.equal(cls({ winBest: 60, winPlayed: 50 }), 'inaccuracy');
  assert.equal(cls({ winBest: 60, winPlayed: 45 }), 'mistake');
  assert.equal(cls({ winBest: 60, winPlayed: 30 }), 'blunder');
  assert.equal(cls({ winBest: 60, winPlayed: 60, playedIsBest: true }), 'best');
  assert.equal(cls({ winBest: 60, winPlayed: 50, book: true }), 'book');
});

test('seuils plus indulgents sous 1400 Elo', () => {
  assert.equal(cls({ winBest: 60, winPlayed: 57.2, elo: 1800 }), 'good');
  assert.equal(cls({ winBest: 60, winPlayed: 57.2, elo: 1200 }), 'excellent');
  assert.equal(cls({ winBest: 60, winPlayed: 47, elo: 1200 }), 'inaccuracy');
  assert.equal(cls({ winBest: 60, winPlayed: 36, elo: 1200 }), 'mistake');
});

test('très bon : seul coup qui tient (écart > 10 % avec le 2e coup)', () => {
  assert.equal(cls({ winBest: 70, winPlayed: 70, winSecond: 50, playedIsBest: true }), 'great');
  assert.equal(cls({ winBest: 70, winPlayed: 70, winSecond: 65, playedIsBest: true }), 'best');
  assert.equal(cls({ winBest: 70, winPlayed: 70, winSecond: 50, playedIsBest: true, isRecapture: true }), 'best');
});

test('occasion manquée : erreur adverse non punie', () => {
  const prev = { classification: 'blunder', winBest: 50 }; // avant sa gaffe, j'avais 50 %
  assert.equal(cls({ winBest: 95, winPlayed: 60, prev }), 'miss');
  // Si mon coup rend la position pire qu'avant son erreur, c'est une vraie gaffe.
  assert.equal(cls({ winBest: 95, winPlayed: 20, prev }), 'blunder');
  // Sans erreur adverse juste avant : gaffe normale.
  assert.equal(cls({ winBest: 95, winPlayed: 60, prev: { classification: 'good', winBest: 50 } }), 'blunder');
});

// Le « cadeau grec » classique : Fxh7+ Rxh7 Cg5+ Rg8 Dh5.
const GREEK = 'rnbq1rk1/pppn1ppp/4p3/3pP3/1b1P4/2NB1N2/PPP2PPP/R1BQK2R w KQ - 0 7';
const GREEK_PV = ['d3h7', 'g8h7', 'f3g5', 'h7g8', 'd1h5'];

test('sacrifice : le matériel abandonné doit le rester sur les coups suivants', () => {
  assert.deepEqual(materialDeltas(GREEK, GREEK_PV), [1, -2, -2, -2]);
  assert.equal(isSacrifice(GREEK, GREEK_PV, ['a2a3', 'b4c3', 'b2c3']), true);
  // Un échange (on reprend tout de suite) n'est pas un sacrifice.
  assert.equal(isSacrifice(GREEK, ['a2a3', 'b4c3', 'b2c3', 'd7b6'], null), false);
  // Si l'autre ligne perd aussi ce matériel, la perte était inévitable : pas de sacrifice.
  assert.equal(isSacrifice(GREEK, GREEK_PV, GREEK_PV), false);
});

test('brillant : sacrifice qui tient, coup égal au meilleur, position pas déjà gagnante à > 90 %', () => {
  const ctx = { fenBefore: GREEK, playedPv: GREEK_PV, altPv: ['a2a3', 'b4c3', 'b2c3'], playedIsBest: true, winSecond: 55 };
  assert.equal(cls({ ...ctx, winBest: 75, winPlayed: 75 }), 'brilliant');
  assert.equal(cls({ ...ctx, winBest: 95, winPlayed: 95 }), 'great'); // déjà gagnant : pas brillant
  assert.equal(cls({ ...ctx, winBest: 75, winPlayed: 73, playedIsBest: false }), 'excellent'); // perte ≥ 1 %
});
