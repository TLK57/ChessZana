// Aide « Faiblesses » (public/app/weaknesses.js) : pièces en prise et pièces non défendues, sur des positions connues.
import './_unit.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { findWeaknesses, weaknessText } from '../public/app/weaknesses.js';

const at = (list, sq) => list.find((w) => w.square === sq) ?? null;

test('position de départ : aucune pièce en prise, et seules les tours ne sont pas défendues', () => {
  const list = findWeaknesses(new Chess(), ['w', 'b']);
  assert.ok(list.every((w) => w.kind === 'undefended'), JSON.stringify(list));
  assert.deepEqual(list.map((w) => w.square).sort(), ['a1', 'a8', 'h1', 'h8']);
  assert.equal(at(list, 'a1').text, 'Tour non défendue');
});

test('pièce attaquée par une pièce de moindre valeur : en prise même si elle est défendue', () => {
  // Cavalier blanc en f3, défendu par le pion g2, attaqué par le pion noir e4.
  const c = new Chess('4k3/8/8/8/4p3/5N2/6P1/4K3 w - - 0 1');
  const w = at(findWeaknesses(c, ['w']), 'f3');
  assert.equal(w.kind, 'hanging');
  assert.deepEqual([w.attackers, w.defenders, w.lowerAttacker], [1, 1, 'p']);
  assert.equal(w.text, 'Cavalier en prise : attaqué 1 fois, défendu 1 fois, dont par un pion, de moindre valeur');
});

test('attaquée plus souvent que défendue : en prise ; autant défendue qu\'attaquée par des pièces égales : rien', () => {
  // Tour blanche en d4 attaquée par les deux tours noires (d8, h4), défendue une fois (roi e3).
  const c = new Chess('3r2k1/8/8/8/3R3r/4K3/8/8 w - - 0 1');
  const r = at(findWeaknesses(c, ['w']), 'd4');
  assert.equal(r.kind, 'hanging');
  assert.equal(r.text, 'Tour en prise : attaquée 2 fois, défendue 1 fois');
  // Fou blanc en d4 attaqué par un fou noir (a7), défendu par le pion c3 : rien à signaler.
  const b = new Chess('4k3/b7/8/8/3B4/2P5/8/4K3 w - - 0 1');
  assert.equal(at(findWeaknesses(b, ['w']), 'd4'), null);
});

test('pièce attaquée et non défendue ; pièce non défendue mais pas attaquée (marquage plus discret)', () => {
  // Dame noire en d5 attaquée par le fou b3 et sans défense ; cavalier noir en h6 tranquille mais non défendu.
  const c = new Chess('4k3/8/7n/3q4/8/1B6/8/4K3 b - - 0 1');
  const list = findWeaknesses(c, ['b']);
  assert.equal(at(list, 'd5').kind, 'hanging');
  assert.equal(at(list, 'd5').text, 'Dame en prise : attaquée 1 fois, non défendue, dont par un fou, de moindre valeur');
  assert.equal(at(list, 'h6').kind, 'undefended');
  assert.equal(at(list, 'h6').text, 'Cavalier non défendu');
  assert.equal(at(list, 'e8'), null, 'jamais le roi');
});

test('seulement les camps demandés', () => {
  const c = new Chess('4k3/8/7n/3q4/8/1B6/8/4K3 b - - 0 1');
  assert.ok(findWeaknesses(c, ['b']).every((w) => w.color === 'b'));
  // Le fou b3 est lui-même attaqué par la dame d5 (attaque mutuelle) et n'est pas défendu.
  assert.deepEqual(findWeaknesses(c, ['w']).map((w) => [w.square, w.kind, w.text]), [['b3', 'hanging', 'Fou en prise : attaqué 1 fois, non défendu']]);
  assert.equal(weaknessText({ type: 'b', kind: 'undefended' }), 'Fou non défendu');
});
