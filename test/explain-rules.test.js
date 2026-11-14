// Nouvelles règles d'explication : un test par règle (positions construites ou tirées de vraies parties).
import './_unit.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { explainMove, ERROR_TYPES } from '../src/analysis/explain.js';
import { pinnedBy, pawnWeaknesses, passedPawns, safeSquares } from '../src/analysis/patterns.js';

const ex = (fen, played, best, extra = {}) => explainMove({
  fenBefore: fen, playedUci: played[0], playedPv: played, bestPv: best,
  evalBest: { cp: 0 }, evalPlayed: { cp: -300 }, classification: 'mistake', lossPct: 15, you: true, ...extra,
});
const line = (s) => s.split(' ');

test('motif plus loin dans la ligne : fourchette au 2e coup adverse', () => {
  const r = ex('6k1/6pp/4n3/8/8/8/6PP/R3K3 w - - 0 1', line('h2h3 e6d4 h3h4 d4c2 e1d1 c2a1'), line('e1d2 e6d4 a1a7 g8f8'));
  assert.equal(r.type, 'allowed_fork');
  assert.match(r.sentences.join(' '), /♘c2\+ est une fourchette/);
  assert.match(r.sentences.join(' '), /votre tour en a1/);
});

test('surcharge : la dame ne peut pas reprendre en c3 et défendre f4', () => {
  const r = ex('6k1/p4ppp/8/7n/1b3B2/2N5/P2Q1PPP/6K1 w - - 0 1', line('h2h3 b4c3 d2c3 h5f4'), line('f4e3 b4c3 d2c3 h5f6'), { classification: 'blunder' });
  assert.equal(r.type, 'allowed_overload');
  assert.match(r.sentences.join(' '), /surcharge/);
  assert.match(r.sentences.join(' '), /votre dame en d2 ne pouvait pas défendre à la fois c3 et f4/);
});

test('pièce piégée : le fou en a7 n\'a plus aucune case sûre', () => {
  const r = ex('2k5/ppp5/8/8/8/4B3/6PP/6K1 w - - 0 1', line('e3a7 b7b6 g2g3 c8b7 h2h3 b7a7'), line('e3d4 a7a6 g2g3 c8d7'), { evalBest: { cp: 50 }, evalPlayed: { cp: -250 } });
  assert.equal(r.type, 'allowed_trapped');
  assert.match(r.sentences.join(' '), /votre fou en a7 n'avait plus aucune case sûre/);
});

test('clouage et non piège : une pièce clouée sur son roi', () => {
  const c = new Chess('4r1k1/8/8/8/8/8/4R3/4K3 w - - 0 1');
  assert.deepEqual(pinnedBy(c, 'e2'), { square: 'e8', type: 'r' });
  assert.equal(pinnedBy(new Chess('4r1k1/8/8/8/8/8/3R4/4K3 w - - 0 1'), 'd2'), null);
});

test('pièce non défendue plus loin : le pion e3 tombe après une série d\'échecs', () => {
  const r = ex('8/1R3pk1/2p4p/P1P3r1/2qP4/4P3/3Q2P1/6K1 w - - 1 48', line('d2f2 c4c1 f2f1 c1e3 f1f2 e3c1 f2f1 c1e3'), line('d2d3'));
  assert.equal(r.type, 'hanging_piece');
  assert.match(r.sentences.join(' '), /votre pion en e3 n'est plus défendu et ♕xe3\+ le prend/);
});

test('échec perpétuel permis : la position gagnante devient nulle', () => {
  const r = ex('6k1/R4ppp/8/4q3/8/7P/6P1/7K w - - 0 1', line('a7b7 e5e1 h1h2 e1e5 h2g1 e5e1 g1h2 e1e5'), line('g2g3'),
    { evalBest: { cp: 600 }, evalPlayed: { cp: 0 }, classification: 'blunder', lossPct: 40 });
  assert.equal(r.type, 'perpetual_allowed');
  assert.match(r.sentences.join(' '), /échec perpétuel/);
});

test('pion passé adverse laissé avancer', () => {
  const r = ex('6k1/6pp/8/8/3p4/8/P5PP/1R4K1 w - - 0 1', line('a2a3 d4d3 a3a4 d3d2 g2g3 g8f8'), line('b1d1 g8f8 g1f1 f8e7'), { evalPlayed: { cp: -400 } });
  assert.equal(r.type, 'passed_pawn');
  assert.match(r.sentences.join(' '), /Son pion passé en d4 n'est pas arrêté.*jusqu'en d2/);
  assert.deepEqual(passedPawns(new Chess('6k1/6pp/8/8/3p4/8/P5PP/1R4K1 w - - 0 1'), 'b'), ['d4']);
});

test('roi exposé : l\'adversaire enchaîne les échecs (vraie partie)', () => {
  const r = ex('rn2k2r/pp2n1pp/2pb1qb1/3p4/3Pp1P1/P4N1P/BPPN1P2/R1BQR1K1 w kq - 1 14',
    line('f3h2 d6h2 g1h2 f6f2 h2h1 h7h5 e1g1 h5g4'), line('c2c4 h7h5 c4d5 h5g4 f3g5 d6h2 g1f1 f6g5'),
    { evalBest: { cp: -302 }, evalPlayed: { cp: -661 } });
  assert.equal(r.type, 'king_exposed');
  assert.match(r.sentences.join(' '), /votre roi est exposé : l'adversaire enchaîne les échecs/);
});

test('roi exposé : un pion de l\'abri du roi avance (vraie partie)', () => {
  const r = ex('r1bqk2r/pp3ppp/2n1pn2/3p4/1bP2B2/2N1P3/PP1Q1PPP/R3KBNR w KQkq - 5 8',
    line('f2f3 e6e5 c4d5 f6d5 f4g3 c8e6 f1d3 d8a5'), line('c4d5 f6e4 d2c2 e6d5'), { evalBest: { cp: -43 }, evalPlayed: { cp: -218 } });
  assert.equal(r.type, 'king_exposed');
  assert.match(r.sentences.join(' '), /f3 affaiblit l'abri de votre roi/);
});

test('roque perdu : le roi bouge alors que le roque était possible', () => {
  const r = ex('4k3/pppppppp/8/8/8/8/PPPPPPPP/4K2R w K - 0 1', line('e1f1 e7e6'), line('e1g1 e7e6'));
  assert.equal(r.type, 'castling');
  assert.match(r.sentences.join(' '), /vous perdez le droit de roquer/);
});

test('roque trop tardif : il fallait roquer, l\'adversaire l\'empêche ensuite (vraie partie)', () => {
  const r = ex('rn1qk2r/pp1bbppp/5n2/3p4/3N1B2/6P1/PPP2PBP/RN1QR1K1 b kq - 2 10',
    line('b8c6 f4d6 f6e4 d4c6 d7c6 d6e7 d8e7 f2f3'), line('e8g8 c2c4 e7c5 b1c3 c5d4 d1d4 b8c6 d4c5'), { evalBest: { cp: -117 }, evalPlayed: { cp: -336 } });
  assert.equal(r.type, 'castling');
  assert.match(r.sentences.join(' '), /Il fallait roquer \(O-O\) : votre roi reste au centre/);
});

test('roque adverse : le meilleur coup empêchait le roi adverse de se mettre à l\'abri (vraie partie)', () => {
  const r = ex('r1b1k2r/2q2p1p/p3p1p1/2p1b3/N2p4/1P2Q2P/P1P1NPP1/3R1RK1 w kq - 0 18',
    line('e3e4 c8b7 e4g4 a8d8 f2f4 e5g7 a4b2 e8g8'), line('e3h6 c8b7 c2c3 a8d8 c3d4 c5d4 d1c1 c7b8'), { evalBest: { cp: -204 }, evalPlayed: { cp: -421 } });
  assert.equal(r.type, 'castling');
  assert.match(r.sentences.join(' '), /Son roi était encore au centre : ♕h6 l'empêchait de roquer/);
  const forced = ex('r3k2r/p4pp1/1qb2n2/1N2p1Bp/PnBp4/3P3P/1PP2PP1/R2Q1RK1 w kq - 3 18',
    line('g5f6 g7f6 f2f4 b4d5 c4d5 c6d5 f4e5 f6e5 d1e2 f7f6 f1f2 e8c8'), line('b5d6 e8d7 d6f7 h8e8 c2c3 b4d5 f1e1 d4c3 b2c3'),
    { evalBest: { cp: 649 }, evalPlayed: { cp: 284 } });
  assert.equal(forced.type, 'castling');
  assert.match(forced.sentences.join(' '), /l'obligeait à bouger et lui retirait le roque/);
});

test('pièce non développée : il restait des pièces à sortir (vraie partie)', () => {
  const r = ex('r1bqk2r/ppp3pp/2n5/2bp4/4nP2/5N2/PPP1Q1PP/RNB1KB1R w KQkq - 0 8',
    line('c2c4 c8f5 b1d2 c6b4 c4d5'), line('c1e3 e8g8 e3c5 e4c5 b1c3 f8e8 f3e5 c6e5'), { evalBest: { cp: -289 }, evalPlayed: { cp: -626 } });
  assert.equal(r.type, 'development');
  assert.match(r.sentences.join(' '), /Vous aviez encore 3 pièces à sortir.*♗e3 en développait une, alors que c4 avance un pion/);
});

test('pièce sans retraite : le cavalier en a7 n\'a plus de case sûre et il est attaqué', () => {
  const fen = '1r4k1/1p1p2pp/p7/1N6/8/8/6PP/6K1 w - - 0 1';
  const r = ex(fen, line('b5a7 b8a8'), line('b5c3 g8f7'));
  assert.equal(r.type, 'no_retreat');
  assert.match(r.sentences.join(' '), /votre cavalier en a7 n'a plus aucune case de retraite/);
  const after = new Chess(fen); after.move('Na7');
  after.load(after.fen().replace(' b ', ' w '));
  assert.equal(safeSquares(after, 'a7').length, 0);
});

test('pièce mal placée : cavalier envoyé au bord (vraie partie)', () => {
  const r = ex('2r3k1/nprb1p1p/1q2p1p1/pP1pP3/Pb1P4/1QN1B3/2RN1PPP/2R3K1 w - - 9 25',
    line('c3a2 c7c2 c1c2 b4f8 h2h3 c8c2 b3c2 d7b5 a4b5 b6b5 c2c7 a7c6'), line('c3e4 d5e4 c2c7 c8c7 d2c4 c7c4 b3c4 a7c6 d4d5 e6d5 c4d5 b6c7'),
    { evalBest: { cp: 411 }, evalPlayed: { cp: 177 } });
  assert.equal(r.type, 'no_retreat');
  assert.match(r.sentences.join(' '), /au bord de l'échiquier, en a2/);
});

test('pion isolé créé (vraie partie)', () => {
  const r = ex('rn3rk1/pp1q1ppp/2pb1n2/3p4/3P4/2PB1Q1P/PP1N1PP1/R1B1R1K1 b - - 2 11',
    line('c6c5 d4c5 d6c5 d2b3 d7d6 c1f4 d6b6 b3c5 b6c5 a2a4 a7a6 f4e3'), line('f8e8 e1e8 d7e8 d2f1 b8d7 c1g5 e8f8 f1e3'),
    { evalBest: { cp: -40 }, evalPlayed: { cp: -219 } });
  assert.equal(r.type, 'pawn_structure');
  assert.match(r.sentences.join(' '), /un pion isolé en d5/);
});

test('pions doublés créés', () => {
  const w = pawnWeaknesses(new Chess('6k1/5p1p/5p2/8/8/8/5PPP/6K1 w - - 0 1'), 'b');
  assert.deepEqual(w.doubled, ['f']);
  assert.deepEqual(w.isolated, ['f7', 'h7', 'f6']);
  const r = ex('r2q1rk1/1p1n1ppp/1b3n2/pP2p1B1/P1p1P3/2P2Q1P/4NPP1/RN3RK1 b - - 1 16',
    line('d7c5 e2g3 c5e6 g5f6 d8f6 f3f6 g7f6 g3h5 b6d8 f1d1 a8c8 h5g3'), line('h7h6 g5c1 d7c5 e2g3 c5b3 a1a2 d8d3 b1d2 f8d8 f3d3 d8d3 d2c4'),
    { evalBest: { cp: 38 }, evalPlayed: { cp: -167 } });
  assert.equal(r.type, 'pawn_structure');
  assert.match(r.sentences.join(' '), /pions doublés sur la colonne f/);
});

test('roi passif en finale : le roi devait se rapprocher du centre', () => {
  const r = ex('7k/p6p/8/8/8/8/P6P/7K w - - 0 1', line('a2a3 h8g7'), line('h1g2 h8g7'));
  assert.equal(r.type, 'passive_king');
  assert.match(r.sentences.join(' '), /En finale, votre roi doit participer : ♔g2 le rapprochait du centre/);
  const away = ex('7k/p6p/8/8/8/8/P5KP/8 w - - 0 1', line('g2h1 h8g7'), line('a2a4 h8g7'));
  assert.equal(away.type, 'passive_king');
  assert.match(away.sentences.join(' '), /éloigne votre roi du centre/);
});

test('pièce adverse non chassée : h6 chassait le cavalier (vraie partie)', () => {
  const r = ex('rnbqkbnr/ppp3pp/4p3/5pN1/8/5N2/PPPP1PPP/R1BQKB1R b KQkq - 1 5',
    line('f8e7 d2d4 g8f6 f1c4 f6d5 d1e2 d8d6 g5h3 e8g8 e1g1 a7a5'), line('h7h6 g5h3 g7g5 f3e5 g8f6 f1b5 b8c6 d1e2'),
    { evalBest: { cp: 5 }, evalPlayed: { cp: -160 } });
  assert.equal(r.type, 'missed_tempo');
  assert.match(r.sentences.join(' '), /h6 chassait son cavalier en g5 avec un pion/);
});

test('chaque type d\'erreur a un libellé en français', () => {
  for (const t of ['allowed_overload', 'allowed_trapped', 'perpetual_allowed', 'passed_pawn', 'king_exposed', 'castling', 'development',
    'no_retreat', 'pawn_structure', 'passive_king', 'missed_tempo']) assert.ok(ERROR_TYPES[t], t);
});
