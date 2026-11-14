import './_setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { explainMove, detectMotifs, pvDetails, formatLine } from '../src/analysis/explain.js';

const text = (r) => r.sentences.join(' ');

test('pièce laissée en prise : cavalier non défendu', () => {
  // 1. e4 e5 2. Cf3 Cc6 puis 3. Ch4?? Dxh4
  const r = explainMove({
    fenBefore: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
    playedUci: 'f3h4', playedPv: ['f3h4', 'd8h4'], bestPv: ['f1c4', 'g8f6'],
    evalBest: { cp: 30 }, evalPlayed: { cp: -300 }, classification: 'blunder',
  });
  assert.match(text(r), /votre cavalier en h4 n'est pas défendu/);
  assert.match(text(r), /♕xh4/);
});

test("coup de l'adversaire : explication par couleur, pas à la 2e personne", () => {
  const r = explainMove({
    fenBefore: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
    playedUci: 'f3h4', playedPv: ['f3h4', 'd8h4'], bestPv: ['f1c4', 'g8f6'],
    evalBest: { cp: 30 }, evalPlayed: { cp: -300 }, classification: 'blunder', you: false,
  });
  assert.match(text(r), /le cavalier blanc en h4 n'est pas défendu : les Noirs répondent ♕xh4/);
  assert.match(text(r), /les Blancs perdent/);
  assert.doesNotMatch(text(r), /votre|vous/);
});

test('fourchette manquée', () => {
  const r = explainMove({
    fenBefore: 'r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1',
    playedUci: 'e1d2', playedPv: ['e1d2', 'a8a5'], bestPv: ['b5c7', 'e8d7', 'c7a8'],
    evalBest: { cp: 900 }, evalPlayed: { cp: -100 }, classification: 'blunder',
  });
  assert.match(text(r), /fourchette/);
  assert.match(text(r), /son roi/);
  assert.match(text(r), /sa tour en a8/);
});

test('clouage, enfilade, attaque à la découverte', () => {
  assert.equal(detectMotifs('4k3/8/2n5/8/8/8/8/4KB2 w - - 0 1', 'f1b5')[0].kind, 'pin');
  assert.equal(detectMotifs('8/q2k4/8/8/8/8/8/5K1R w - - 0 1', 'h1h7').find((m) => m.kind === 'skewer').behind.type, 'q');
  const d = detectMotifs('3qk3/8/8/8/3N4/8/8/3QK3 w - - 0 1', 'd4f5').find((m) => m.kind === 'discovered');
  assert.equal(d.target.type, 'q');
});

test('mat raté et mat subi', () => {
  const missed = explainMove({
    fenBefore: '2r3k1/5ppp/8/8/3Q4/8/q4PPP/3R2K1 w - - 0 1',
    playedUci: 'h2h3', playedPv: ['h2h3', 'a2a5'], bestPv: ['d4d8', 'c8d8', 'd1d8'],
    evalBest: { mate: 2 }, evalPlayed: { cp: 0 }, classification: 'blunder',
  });
  assert.match(text(missed), /Vous aviez un mat en 2 : 1\. ♕d8\+ ♖xd8 2\. ♖xd8#/);
  const allowed = explainMove({
    fenBefore: 'r5k1/5ppp/8/7Q/8/8/5PPP/6K1 w - - 0 1',
    playedUci: 'h5h4', playedPv: ['h5h4', 'a8a1'], bestPv: ['h2h3'],
    evalBest: { cp: 500 }, evalPlayed: { mate: -1 }, classification: 'blunder',
  });
  assert.match(text(allowed), /permet à l'adversaire de mater en 1 : 1\.\.\. ♖a1#/);
});

test('finale gagnante gâchée (table de finales)', () => {
  const r = explainMove({
    fenBefore: '8/5k2/8/3K4/3P4/2P5/1R4r1/8 w - - 0 1',
    playedUci: 'b2b7', playedPv: ['b2b7'], bestPv: ['b2g2'],
    evalBest: { wdl: 'win' }, evalPlayed: { wdl: 'draw' }, classification: 'blunder',
  });
  assert.match(text(r), /Finale gagnante gâchée/);
});

test('aucune règle : phrase par défaut', () => {
  const r = explainMove({
    fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    playedUci: 'g2g4', playedPv: ['g2g4', 'd7d5'], bestPv: ['e2e4', 'e7e5'],
    evalBest: { cp: 30 }, evalPlayed: { cp: -60 }, classification: 'inaccuracy',
  });
  assert.equal(text(r), 'Stockfish préférait e4 : la suite montre pourquoi.');
  assert.equal(r.bestLine.length, 2);
});

test('suite de Stockfish en notation lisible', () => {
  const line = pvDetails('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', ['e2e4', 'e7e5', 'g1f3']);
  assert.equal(formatLine(line), '1. e4 e5 2. ♘f3');
  assert.equal(formatLine(line.slice(1)), '1... e5 2. ♘f3');
});
