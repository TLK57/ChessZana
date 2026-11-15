// Partie 620 de Dilo56 (chess.com 186787115286) : le classement doit se rapprocher de celui de chess.com.
import './_unit.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { reclassifyStored } from '../src/analysis/reclassify.js';
import { DEFAULTS, config, overrideConfig } from '../src/config.js';
import { classOf, loadPartie620, ply } from './_partie620.js';

openDb();
let id;
// Ces tests vérifient le style chess.com (la méthode Lichess est testée dans lichess.test.js).
test.before(async () => { overrideConfig({ classification: { method: 'chesscom' } }); id = await loadPartie620(); reclassifyStored(id, 'deep'); });
test.after(() => overrideConfig({ classification: { method: 'lichess' } }));

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

// Courbe des tests : la formule Lichess (test/_setup.js) ; courbe par niveau : celle de config.json.
const withLevelCurve = (fn) => {
  const lichessLike = structuredClone(config.classification.curve);
  overrideConfig({ classification: { curve: DEFAULTS.classification.curve } });
  try {
    reclassifyStored(id, 'deep');
    fn();
  } finally {
    overrideConfig({ classification: { curve: lichessLike } });
    reclassifyStored(id, 'deep');
  }
};

test('courbe par niveau : les pertes de joueurs vers 1100 Elo en blitz sont plus faibles qu\'avec la formule Lichess', async () => {
  const { getDb } = await import('../src/db.js');
  const loss = (label) => getDb().prepare("SELECT loss FROM move_analysis WHERE game_id = ? AND pass = 'deep' AND ply = ?").get(id, ply(label)).loss;
  const before = loss('19.');
  withLevelCurve(() => {
    assert.ok(loss('19.') < before, `${loss('19.')} < ${before}`);
    assert.ok(loss('19.') > 5, '19.Qd2 reste une faute');
  });
});

test('brillant : 21.Rg4 offre la tour (prise par 21...Bxg4), reste le meilleur coup et garde la partie équilibrée', async () => {
  assert.equal(classOf(id, '21.'), 'brilliant');
  withLevelCurve(() => assert.equal(classOf(id, '21.'), 'brilliant', 'aussi avec la courbe par niveau'));
});
