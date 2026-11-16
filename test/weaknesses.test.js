// Aide « Faiblesses » (public/app/weaknesses.js) : pièces en prise selon le calcul d'échange (SEE), sur des positions
// connues.
import './_unit.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { boardOf, exchangeOn, findWeaknesses, hangingText, pinText } from '../public/app/weaknesses.js';

/** Marquage d'une case : « en prise » par défaut, ou « clouée ». */
const at = (list, sq, kind = 'hanging') => list.find((w) => w.square === sq && w.kind === kind) ?? null;
const pinAt = (list, sq) => at(list, sq, 'pinned');
const weak = (fen, colors = ['w', 'b']) => findWeaknesses(new Chess(fen), colors);
const gainOn = (fen, sq, side) => exchangeOn(boardOf(new Chess(fen)), sq, side).gain;

test('position de départ : rien à signaler (une pièce simplement non défendue n\'est pas marquée)', () => {
  assert.deepEqual(findWeaknesses(new Chess(), ['w', 'b']), []);
});

test('partie tfg2s – Dilo56 après 32…Txc3 : seul le pion c4 est en prise', () => {
  // La tour a2, le pion e4, la tour c3, le pion c5 et le pion a7 ne sont pas attaqués ; le pion a3 est attaqué par la
  // tour c3 mais défendu par la tour a2 (Txa3 Txa3 perdrait la tour).
  const list = weak('5rk1/p5p1/5p2/2p1p3/2P1P3/P1r5/R6P/6K1 w - - 0 33');
  assert.deepEqual(list.map((w) => [w.square, w.text]), [['c4', 'Pion en prise : Txc4 gagne un pion']]);
});

test('pièce attaquée par une pièce de moindre valeur : en prise même si elle est défendue', () => {
  // Cavalier blanc en f3, défendu par le pion g2, attaqué par le pion noir e4 : exf3 gxf3, les Noirs gagnent 2 points.
  const w = at(weak('4k3/8/8/8/4p3/5N2/6P1/4K3 w - - 0 1', ['w']), 'f3');
  assert.deepEqual([w.kind, w.gain, w.capture], ['hanging', 2, 'exf3']);
  assert.equal(w.text, 'Cavalier en prise : échange perdant (−2)');
});

test('pion défendu attaqué par une dame : pas en prise (Dxe4 dxe4 perdrait la dame)', () => {
  const fen = '6k1/4q3/8/8/4P3/3P4/8/6K1 w - - 0 1';
  assert.equal(at(weak(fen), 'e4'), null);
  assert.equal(gainOn(fen, 'e4', 'b'), 0);
  // Le même pion sans le pion d3 : la dame le prend gratuitement.
  assert.equal(at(weak('6k1/4q3/8/8/4P3/8/8/6K1 w - - 0 1'), 'e4').text, 'Pion en prise : Dxe4 gagne un pion');
});

test('pièce attaquée une fois et défendue une fois par une pièce clouée : en prise', () => {
  // Le cavalier c6 est cloué sur le roi e8 par le fou b5 (d7 est vide) : il ne défend plus le pion e5.
  const pinned = 'r1bqkbnr/ppp2ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 1';
  assert.equal(at(weak(pinned, ['b']), 'e5').text, 'Pion en prise : Cxe5 gagne un pion');
  // Avec un pion en d7, plus de clouage : Cxe5 Cxe5 perdrait le cavalier.
  assert.equal(at(weak('r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 1', ['b']), 'e5'), null);
  // Le cavalier c6, lui, est attaqué par le fou mais défendu par le pion b7 : échange égal, rien à signaler.
  assert.equal(at(weak(pinned, ['b']), 'c6'), null);
});

test('une pièce clouée peut prendre le long du clouage, pas en dehors', () => {
  // Tour blanche e2 clouée par la tour noire e8 : elle peut prendre la tour e8 (sur la ligne du clouage).
  assert.equal(at(weak('4r3/7k/8/8/8/8/4R3/4K3 w - - 0 1', ['b']), 'e8').text, 'Tour en prise : Txe8 gagne une tour');
  // Fou blanc d2 cloué par le fou noir b4 : il ne peut pas prendre le cavalier e3 (hors de la diagonale du clouage).
  assert.equal(at(weak('7k/8/8/8/1b6/4n3/3B4/4K3 w - - 0 1', ['b']), 'e3'), null);
  assert.equal(at(weak('7k/8/8/8/8/4n3/3B4/4K3 w - - 0 1', ['b']), 'e3').text, 'Cavalier en prise : Fxe3 gagne un cavalier');
});

test('échec à la découverte pendant l\'échange : la reprise devient impossible', () => {
  // exf5 ouvre la colonne e : la tour e1 donne échec au roi e8, et gxf5 n'est plus jouable. Les Blancs gagnent un pion.
  const fen = 'r3k1nr/pbpq2bp/3p2p1/2p2pB1/4P3/2N2N2/PPP2PPP/R2QR1K1 w kq - 3 13';
  assert.equal(at(weak(fen, ['b']), 'f5').text, 'Pion en prise : exf5 gagne un pion');
  // Même position avec le roi noir en f8 (pas d'échec) : exf5 gxf5, échange égal.
  assert.equal(at(weak('r4knr/pbpq2bp/3p2p1/2p2pB1/4P3/2N2N2/PPP2PPP/R2QR1K1 w - - 3 13', ['b']), 'f5'), null);
});

test('camp déjà en échec : il y répond d\'abord, ses défenseurs comptent pour la suite', () => {
  // Partie 620 après 5…Fxc3+ : les Blancs sont en échec ; le pion e4, attaqué par le cavalier f6 et défendu par le pion
  // d3, n'est pas en prise (après bxc3, Cxe4 dxe4 est un échange égal).
  const fen = 'r1bqk2r/pppp1ppp/2n2n2/4p3/2B1P3/2bP1N2/PPP2PPP/R1BQK2R w KQkq - 0 6';
  assert.equal(at(weak(fen, ['w']), 'e4'), null);
  // Le fou c3 qui donne l'échec, lui, est bien en prise : bxc3 gagne un fou.
  assert.equal(at(weak(fen, ['b']), 'c3').text, 'Fou en prise : bxc3 gagne un fou');
});

test('tours doublées en enfilade : la tour de derrière rend l\'échange gagnant (rayons X des deux camps)', () => {
  // Pion d5 défendu par la tour d8, attaqué par les tours d2 et d1 : Txd5 Txd5 Txd5, les Blancs gagnent un pion.
  assert.equal(at(weak('3r2k1/8/8/3p4/8/8/3R4/3R2K1 w - - 0 1', ['b']), 'd5').text, 'Pion en prise : Txd5 gagne un pion');
  // Une seule tour blanche : Txd5 Txd5 perdrait la tour.
  assert.equal(at(weak('3r2k1/8/8/3p4/8/8/3R4/6K1 w - - 0 1', ['b']), 'd5'), null);
  // La dame d8 derrière la tour d7 défend aussi (rayon X noir) : trois défenseurs pour deux attaquants, rien à gagner.
  assert.equal(gainOn('3q2k1/3r4/8/3p4/8/8/3R4/3R2K1 w - - 0 1', 'd5', 'w'), 0);
});

test('rayon X derrière un pion, en diagonale : le fou b2 soutient le pion d4 qui prend en e5', () => {
  // dxe5 Cxe5 Fxe5 : les Blancs gagnent un pion ; sans le fou, dxe5 Cxe5 est un échange égal.
  assert.equal(at(weak('6k1/8/2n5/4p3/3P4/8/1B6/6K1 w - - 0 1', ['b']), 'e5').text, 'Pion en prise : dxe5 gagne un pion');
  assert.equal(at(weak('6k1/8/2n5/4p3/3P4/8/8/6K1 w - - 0 1', ['b']), 'e5'), null);
});

test('le roi ne reprend que si la case n\'est plus attaquée ensuite', () => {
  // Tour d4 défendue par le seul roi e3, attaquée par les tours h4 et d8 : le roi ne peut pas reprendre.
  assert.equal(at(weak('3r2k1/8/8/8/3R3r/4K3/8/8 w - - 0 1', ['w']), 'd4').text, 'Tour en prise : Thxd4 gagne une tour');
  // Attaquée par la seule tour h4 : Txd4 Rxd4, échange égal.
  assert.equal(at(weak('6k1/8/8/8/3R3r/4K3/8/8 w - - 0 1', ['w']), 'd4'), null);
});

test('chaque camp prend avec sa pièce la moins chère et peut s\'arrêter', () => {
  // Fou d4 attaqué par le fou a7, défendu par le pion c3 : Fxd4 cxd4, échange égal.
  assert.equal(at(weak('4k3/b7/8/8/3B4/2P5/8/4K3 w - - 0 1', ['w']), 'd4'), null);
  // Dame d5 attaquée par le fou b3, sans défense ; le fou b3, lui, est attaqué par la dame et sans défense.
  const list = weak('4k3/8/7n/3q4/8/1B6/8/4K3 b - - 0 1');
  assert.deepEqual(list.map((w) => [w.square, w.text]), [['d5', 'Dame en prise : Fxd5 gagne la dame'], ['b3', 'Fou en prise : Dxb3 gagne un fou']]);
  assert.equal(at(list, 'h6'), null, 'cavalier non défendu mais pas attaqué');
  assert.equal(at(list, 'e8'), null, 'jamais le roi');
  // Dame attaquée par un fou et défendue par un pion : Fxd5 exd5, les Blancs gagnent 6 points.
  assert.equal(at(weak('4k3/8/4p3/3q4/8/1B6/8/4K3 b - - 0 1', ['b']), 'd5').text, 'Dame en prise : échange perdant (−6)');
});

test('seulement les camps demandés ; textes', () => {
  const fen = '4k3/8/7n/3q4/8/1B6/8/4K3 b - - 0 1';
  assert.deepEqual(weak(fen, ['b']).map((w) => w.square), ['d5']);
  assert.deepEqual(weak(fen, ['w']).map((w) => w.square), ['b3']);
  assert.equal(hangingText('n', 3, 'Fxe3'), 'Cavalier en prise : Fxe3 gagne un cavalier');
  assert.equal(hangingText('r', 2, 'Fxd1'), 'Tour en prise : échange perdant (−2)');
});

test('clouage absolu : la pièce cache son roi', () => {
  const list = weak('r1bqkbnr/ppp2ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 1', ['b']);
  const c6 = pinAt(list, 'c6');
  assert.deepEqual([c6.absolute, c6.by, c6.on], [true, 'b5', 'e8']);
  assert.equal(c6.text, 'Cavalier cloué sur le roi par le fou b5');
  assert.equal(pinAt(weak('4k3/8/4q3/8/8/8/8/4R1K1 b - - 0 1'), 'e6').text, 'Dame clouée sur le roi par la tour e1');
  // Un pion en d7 casse la ligne : plus de clouage.
  assert.equal(pinAt(weak('r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 1', ['b']), 'c6'), null);
});

test('clouage relatif : sur la dame, ou sur une tour non défendue', () => {
  // Fou e6 entre sa dame e8 et la tour blanche e1.
  const e6 = pinAt(weak('4q1k1/8/4b3/8/8/8/8/4R1K1 b - - 0 1'), 'e6');
  assert.deepEqual([e6.absolute, e6.by, e6.on], [false, 'e1', 'e8']);
  assert.equal(e6.text, 'Fou cloué sur la dame par la tour e1');
  // Dame défendue (roi f8) face à une dame : pas un clouage (Dxe8 Rxe8 est un simple échange) ; dame non défendue : si.
  assert.equal(pinAt(weak('4qk2/8/4b3/8/8/8/8/4Q1K1 b - - 0 1'), 'e6'), null);
  assert.equal(pinAt(weak('4q1k1/8/4b3/8/8/8/8/4Q1K1 b - - 0 1'), 'e6').text, 'Fou cloué sur la dame par la dame e1');
  // Cavalier d4 entre le fou a1 et la tour g7 non défendue ; il est aussi en prise (deux marquages sur la case).
  const list = weak('1k6/6r1/8/8/3n4/8/8/B6K b - - 0 1', ['b']);
  assert.equal(pinAt(list, 'd4').text, 'Cavalier cloué sur la tour non défendue g7 par le fou a1');
  assert.equal(at(list, 'd4').text, 'Cavalier en prise : Fxd4 gagne un cavalier');
  // La tour défendue par le roi h8 : pas de clouage.
  assert.equal(pinAt(weak('7k/6r1/8/8/3n4/8/8/B6K b - - 0 1', ['b']), 'd4'), null);
  // La pièce de devant vaut plus que celle de derrière (dame devant une tour) : pas un clouage.
  assert.equal(pinAt(weak('4r1k1/8/4q3/8/8/8/8/4R1K1 b - - 0 1'), 'e6'), null);
  assert.equal(pinText('r', { onType: 'q', byType: 'b', by: 'g2' }), 'Tour clouée sur la dame par le fou g2');
});

test('clouages : seulement les camps demandés, jamais dans la position 32…Txc3', () => {
  const fen = '4q1k1/8/4b3/8/8/8/8/4R1K1 b - - 0 1';
  assert.equal(weak(fen, ['w']).length, 0);
  assert.equal(weak(fen, ['b']).filter((w) => w.kind === 'pinned').length, 1);
  assert.equal(weak('5rk1/p5p1/5p2/2p1p3/2P1P3/P1r5/R6P/6K1 w - - 0 33').filter((w) => w.kind === 'pinned').length, 0);
});
