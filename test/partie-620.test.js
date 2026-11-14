// Partie 620 de Dilo56 (chess.com 186787115286) : le classement doit se rapprocher de celui de chess.com.
import './_unit.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { reclassifyStored } from '../src/analysis/reclassify.js';
import { classOf, loadPartie620 } from './_partie620.js';

openDb();
let id;
test.before(async () => { id = await loadPartie620(); reclassifyStored(id, 'deep'); });

test('seuils comme chess.com : 20.Qe3 (perte ≈ 11 %) devient une erreur', () => {
  assert.equal(classOf(id, '20.'), 'mistake');
});

test('seuils comme chess.com : 27...g5, 32...h4 et 34...Rh8 deviennent des erreurs', () => {
  for (const m of ['27...', '32...', '34...']) assert.equal(classOf(id, m), 'mistake', m);
  assert.equal(classOf(id, '22...'), 'mistake');
});

test('occasion manquée : 28.Ke2 ne profite pas de 27...g5 et repasse sous le seuil gagnant', () => {
  assert.equal(classOf(id, '28.'), 'miss');
});

test('les gaffes restent des gaffes : 15...Nxf3+ et 19.Qd2', () => {
  assert.equal(classOf(id, '15...'), 'blunder');
  assert.equal(classOf(id, '19.'), 'blunder');
});
