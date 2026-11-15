// Style chess.com : seuils publiés par chess.com, occasion manquée, précision réglable, réglages ajustés
// (data/style-chesscom.json) et empreinte des réglages (reclassement quand ils changent).
// La courbe des tests est la formule Lichess (test/_setup.js) : les cas s'écrivent en pourcentages Lichess.
import './_setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { config, overrideConfig, readStyleFile, styleFilePath } from '../src/config.js';
import { chesscomAccuracy, classificationSignature, classifyChesscom, lossCategory, scoreFromWin } from '../src/analysis/classify.js';
import { chesscomGameAccuracy, chesscomMoveAccuracy, moveAccuracy } from '../src/analysis/formulas.js';
import { START_FEN } from '../src/chessutil.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);
const sc = (w) => scoreFromWin(w);
const move = (o = {}) => ({
  color: 'w', uci: 'e2e4', san: 'e4', fenBefore: START_FEN, book: false, bestUci: o.best ? 'e2e4' : 'd2d4',
  evalBest: sc(o.wb ?? 60), evalPlayed: sc(o.wp ?? o.wb ?? 60), evalSecond: o.ws != null ? sc(o.ws) : null,
});
const prevBlack = (theirBest, theirPlayed) => ({ color: 'b', uci: 'e7e5', san: 'e5', book: true, evalBest: sc(theirBest), evalPlayed: sc(theirPlayed) });
const afterPrev = (prev, o) => classifyChesscom([prev, move(o)], { w: { elo: 1500 } })[1];

test('seuils publiés par chess.com : Excellent ≤ 2, Bon ≤ 5, Imprécision ≤ 10, Erreur ≤ 20, Gaffe au-delà', () => {
  const th = config.classification.thresholds;
  assert.equal(lossCategory(2, th, true), 'excellent');
  assert.equal(lossCategory(2.01, th, true), 'good');
  assert.equal(lossCategory(5, th, true), 'good');
  assert.equal(lossCategory(10, th, true), 'inaccuracy');
  assert.equal(lossCategory(20, th, true), 'mistake');
  assert.equal(lossCategory(20.01, th, true), 'blunder');
  assert.equal(lossCategory(5, th), 'inaccuracy', 'sans « inclusive » (Lichess), le seuil passe à la catégorie suivante');
});

test('occasion manquée : rater un gain net qui vient d\'apparaître, même après une petite imprécision adverse', () => {
  // Les Noirs passent de 35 % à 28 % : je gagne seulement 7 points, mais le meilleur coup me donnait 80 %
  // alors que je n'étais pas gagnant (65 %) si l'adversaire avait bien joué.
  const prev = prevBlack(35, 28);
  assert.equal(afterPrev(prev, { wb: 80, wp: 64 }).classification, 'miss');
  // Je reste gagnant : pas d'occasion manquée, juste une perte ordinaire.
  assert.equal(afterPrev(prev, { wb: 80, wp: 72 }).classification, 'inaccuracy');
  // Perte trop faible (moins de 5 points) : pas une occasion manquée, même en repassant sous 70 %.
  assert.equal(afterPrev(prevBlack(31, 30), { wb: 72, wp: 68 }).classification, 'good');
});

test('occasion manquée : les réglages config.classification.miss sont pris en compte', () => {
  const prev = prevBlack(50, 10);
  assert.equal(afterPrev(prev, { wb: 90, wp: 60 }).classification, 'miss');
  overrideConfig({ classification: { miss: { winning: 95 } } });
  try {
    assert.equal(afterPrev(prev, { wb: 90, wp: 60 }).classification, 'blunder', 'seuil gagnant relevé à 95 % : plus d\'occasion manquée');
  } finally {
    overrideConfig({ classification: { miss: { winning: 70 } } });
  }
});

test('précision style chess.com : par coup scale × e^(−decay × perte) − (scale − 100), réglable', () => {
  const p = config.accuracy.chesscom;
  assert.equal(chesscomMoveAccuracy(0, p), 100);
  near(chesscomMoveAccuracy(10, p), moveAccuracy(10, 0), 0.01); // valeurs de départ : la courbe de Lichess, sans bonus
  near(chesscomMoveAccuracy(10, { ...p, decay: 0.1, scale: 100 }), 100 * Math.exp(-1));
  assert.equal(chesscomMoveAccuracy(100, p), 0, 'bornée à 0');
  assert.ok(chesscomMoveAccuracy(10, { ...p, decay: 0.08 }) < chesscomMoveAccuracy(10, p), 'decay plus grand : plus sévère');
});

test('précision style chess.com de la partie : mélange réglable de moyenne et de moyenne harmonique', () => {
  const moves = [{ color: 'w', accuracy: 100 }, { color: 'w', accuracy: 10 }, { color: 'b', accuracy: 90 }];
  const mean = 55, harmonic = 2 / (1 / 100 + 1 / 10);
  near(chesscomGameAccuracy(moves, { harmonicWeight: 0 }).white, mean);
  near(chesscomGameAccuracy(moves, { harmonicWeight: 1 }).white, harmonic);
  near(chesscomGameAccuracy(moves, { harmonicWeight: 0.5 }).white, (mean + harmonic) / 2);
  near(chesscomGameAccuracy(moves, { harmonicWeight: 0.5 }).black, 90);
  // Sur une partie : à partir des pertes du classement style chess.com.
  const game = [move({ wb: 60, best: true }), { ...move({ wb: 60, wp: 40 }), color: 'b' }];
  const acc = chesscomAccuracy(game, {});
  near(acc.white, 100);
  near(acc.black, chesscomMoveAccuracy(classifyChesscom(game, {})[1].loss));
  assert.ok(Math.abs(classifyChesscom(game, {})[1].loss - 20) < 0.1);
});

test('réglages ajustés (data/style-chesscom.json) : seules la courbe et la précision sont lues', () => {
  const dir = fs.mkdtempSync(path.join(config.dataDir, 'style-'));
  fs.writeFileSync(styleFilePath(dir), JSON.stringify({ curve: { k1500: 0.15, eloSlope: 0.6 }, accuracy: { decay: 0.07 }, thresholds: { mistake: 99 }, ajustement: { parties: 3 } }));
  assert.deepEqual(readStyleFile(dir), { classification: { curve: { k1500: 0.15, eloSlope: 0.6 } }, accuracy: { chesscom: { decay: 0.07 } } });
  assert.deepEqual(readStyleFile(path.join(dir, 'absent')), {});
});

test('empreinte des réglages : la courbe ne compte qu\'avec le style chess.com', () => {
  const curve = structuredClone(config.classification.curve);
  overrideConfig({ classification: { method: 'lichess' } });
  const lichess = classificationSignature();
  overrideConfig({ classification: { curve: { k1500: curve.k1500 + 0.05 } } });
  assert.equal(classificationSignature(), lichess, 'méthode Lichess : la courbe du style chess.com ne change rien');
  overrideConfig({ classification: { method: 'chesscom' } });
  const a = classificationSignature();
  overrideConfig({ classification: { curve } });
  assert.notEqual(classificationSignature(), a, 'style chess.com : une autre courbe impose un reclassement');
  overrideConfig({ classification: { method: 'lichess' } });
});
