// Méthode Lichess exacte (lila : Advice.scala, AccuracyPercent.scala ; scalachess : eval.scala) : chances de gain,
// imprécision / erreur / gaffe, règles des mats et précision.
import './_unit.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { accuracyFromWinPercents, gameAccuracy, lichessWinPercent, winningChances } from '../src/analysis/formulas.js';
import { judgeLichess, lichessJudgement, lichessLoss } from '../src/analysis/classify.js';
import { storedMoves } from '../src/analysis/reclassify.js';
import { START_FEN } from '../src/chessutil.js';
import { loadPartie620, ply } from './_partie620.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);
const cp = (v) => ({ cp: v, mate: null, wdl: null });
const mate = (n) => ({ cp: null, mate: n, wdl: null });

test('chances de gain Lichess : 2 / (1 + e^(−0,00368208 × cp)) − 1, entre −1 et +1', () => {
  near(winningChances(0), 0);
  near(winningChances(100), 2 / (1 + Math.exp(-0.368208)) - 1);
  near(winningChances(-300), -winningChances(300));
  assert.ok(winningChances(100000) <= 1 && winningChances(-100000) >= -1);
});

test('précision Lichess : évaluation plafonnée à ±10 pions, mat = ±10 pions', () => {
  near(lichessWinPercent(cp(2500)), lichessWinPercent(cp(1000)));
  near(lichessWinPercent(cp(1000)), 50 + 50 * winningChances(1000));
  near(lichessWinPercent(mate(3)), lichessWinPercent(cp(1000)));
  near(lichessWinPercent(mate(-2)), lichessWinPercent(cp(-1000)));
  near(lichessWinPercent(mate(0)), lichessWinPercent(cp(-1000))); // déjà maté
  assert.ok(lichessWinPercent(mate(1)) < 98, 'un mat ne vaut pas 100 % pour la précision Lichess');
  near(lichessWinPercent({ wdl: 'draw' }), 50);
});

test('précision d\'un coup : formule Lichess + 1 (bonus d\'incertitude), 100 si rien n\'est perdu', () => {
  assert.equal(accuracyFromWinPercents(60, 60), 100);
  assert.equal(accuracyFromWinPercents(60, 70), 100);
  near(accuracyFromWinPercents(60, 50), 103.1668100711649 * Math.exp(-0.04354415386753951 * 10) - 3.166924740191411 + 1);
  near(accuracyFromWinPercents(60, 50, 0), 63.58, 0.01);
  assert.equal(accuracyFromWinPercents(100, 0), 0, 'bornée à 0');
  assert.ok(accuracyFromWinPercents(50, 49.99) <= 100, 'bornée à 100 malgré le bonus');
});

test('imprécision / erreur / gaffe : 0,1 / 0,2 / 0,3 de « winning chances » perdues, sans plafond', () => {
  // Position égale : 0,1 de winning chances ≈ 5 points de chances de gain.
  const at = (delta) => { // évaluation après qui fait perdre exactement « delta » winning chances depuis 0
    const target = -delta;
    return cp(Math.log((1 + target) / (1 - target)) / 0.00368208 + (delta > 0 ? -1e-6 : 0));
  };
  assert.equal(lichessJudgement(cp(0), at(0.099)), null);
  assert.equal(lichessJudgement(cp(0), at(0.1)), 'inaccuracy');
  assert.equal(lichessJudgement(cp(0), at(0.2)), 'mistake');
  assert.equal(lichessJudgement(cp(0), at(0.3)), 'blunder');
  near(lichessLoss(cp(0), at(0.1)), 5, 1e-3);
  // Pas de plafond pour juger : de +15 à +9, la perte est faible ; de +3 à −3, c'est une gaffe.
  assert.equal(lichessJudgement(cp(1500), cp(900)), null);
  assert.equal(lichessJudgement(cp(300), cp(-300)), 'blunder');
});

test('règles des mats : mat créé, mat perdu, mat retardé', () => {
  // Mat créé : on se fait mater après le coup. Imprécision si on était déjà à −10, erreur à −7, gaffe sinon.
  assert.equal(lichessJudgement(cp(-1200), mate(-3)), 'inaccuracy');
  assert.equal(lichessJudgement(cp(-800), mate(-3)), 'mistake');
  assert.equal(lichessJudgement(cp(100), mate(-3)), 'blunder');
  // Mat perdu : on avait un mat et on ne l'a plus.
  assert.equal(lichessJudgement(mate(2), cp(1200)), 'inaccuracy');
  assert.equal(lichessJudgement(mate(2), cp(800)), 'mistake');
  assert.equal(lichessJudgement(mate(2), cp(100)), 'blunder');
  assert.equal(lichessJudgement(mate(2), mate(-4)), 'blunder');
  // Mat plus long (« retardé ») ou mat qui apparaît pour soi : rien.
  assert.equal(lichessJudgement(mate(2), mate(5)), null);
  assert.equal(lichessJudgement(cp(300), mate(4)), null);
  assert.equal(lichessJudgement(mate(-3), mate(-2)), null);
});

test('partie : position avant / position après (coup suivant), coup du moteur jamais jugé, dernier coup', () => {
  const m = (o) => ({ color: 'w', uci: 'e2e4', san: 'e4', fenBefore: START_FEN, book: false, bestUci: 'd2d4', evalSecond: null, ...o });
  const moves = [
    // Blancs : +0,30 avant ; le coup suivant (Noirs) voit −2,00 pour eux, soit +2,00 pour les Blancs : rien perdu.
    m({ evalBest: cp(30), evalPlayed: cp(-500) }),
    // Noirs : −2,00 avant, et après (coup suivant des Blancs) +6,00 pour les Blancs : gaffe, même si leur coup joué
    // valait −2,10 dans la même recherche.
    m({ color: 'b', uci: 'e7e5', san: 'e5', bestUci: 'd7d5', evalBest: cp(-200), evalPlayed: cp(-210) }),
    // Blancs : coup du moteur, jamais jugé.
    m({ uci: 'g1f3', san: 'Nf3', bestUci: 'g1f3', evalBest: cp(600), evalPlayed: cp(600) }),
    // Noirs, dernier coup : jugé sur l'évaluation du coup joué.
    m({ color: 'b', uci: 'b8c6', san: 'Nc6', bestUci: 'g8f6', evalBest: cp(-600), evalPlayed: cp(-700) }),
  ];
  const r = judgeLichess(moves);
  assert.equal(r.moves[0].classification, 'excellent', 'le coup suivant montre que rien n\'est perdu');
  assert.equal(r.moves[1].classification, 'blunder');
  assert.equal(r.moves[2].classification, 'best');
  assert.equal(r.moves[3].classification, lichessJudgement(cp(-600), cp(-700)) ?? (lichessLoss(cp(-600), cp(-700)) < 2.5 ? 'excellent' : 'good'));
  // Précision de la partie : celle de gameAccuracy sur la série plafonnée P0…P4.
  const series = [cp(30), cp(200), cp(600), cp(600), cp(700)].map(lichessWinPercent);
  const acc = gameAccuracy(series, moves.map((x, i) => ({ color: x.color, accuracy: r.moves[i].accuracy })));
  near(r.accuracy.white, acc.white);
  near(r.accuracy.black, acc.black);
  assert.equal(judgeLichess([{ ...moves[0], book: true }]).moves[0].classification, 'book');
});

test('partie 620 : les gaffes 15...Nxf3+ et 19.Qd2 restent des gaffes avec la méthode Lichess', async () => {
  openDb();
  const id = await loadPartie620();
  const { list } = storedMoves(id, 'deep');
  const r = judgeLichess(list);
  assert.equal(r.moves[ply('15...') - 1].classification, 'blunder');
  assert.equal(r.moves[ply('19.') - 1].classification, 'blunder');
  assert.ok(r.moves.every((m) => !['brilliant', 'great', 'miss'].includes(m.classification)), 'Lichess n\'a ni brillant, ni très bon, ni occasion manquée');
  assert.ok(r.accuracy.white > 50 && r.accuracy.white < 100 && r.accuracy.black > 50 && r.accuracy.black < 100);
});
