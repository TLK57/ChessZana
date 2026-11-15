// Bilans chess.com saisis à la main et ajustement du style chess.com (src/analysis/reviews.js, fitstyle.js).
import './_unit.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { openDb, getDb } from '../src/db.js';
import { cleanSide, getReview, referenceDataset, referenceReviews, saveReview } from '../src/analysis/reviews.js';
import { evaluate, fitStyle, lastFit, nelderMead, writeStyleFile } from '../src/analysis/fitstyle.js';
import { loadPartie620 } from './_partie620.js';

openDb();
let id;
test.before(async () => { id = await loadPartie620(); });

test('bilan saisi : virgules et « % » acceptés, cases vides ignorées, valeurs impossibles refusées', () => {
  assert.deepEqual(cleanSide({ accuracy: '79,04 %', best: '21', mistake: 3, miss: '', blunder: null }), { accuracy: 79, best: 21, mistake: 3 });
  assert.throws(() => cleanSide({ accuracy: 120 }), /entre 0 et 100/);
  assert.throws(() => cleanSide({ mistake: 2.5 }), /entier/);
  assert.throws(() => cleanSide({ blunder: -1 }), /entier/);
});

test('bilan d\'une partie : enregistré, relu, remplacé, effacé quand tout est vide', () => {
  assert.equal(getReview(id), null);
  saveReview(id, { white: { accuracy: 79, mistake: 3 }, black: { accuracy: '75,7' } });
  assert.deepEqual({ ...getReview(id), updatedAt: undefined }, { white: { accuracy: 79, mistake: 3 }, black: { accuracy: 75.7 }, updatedAt: undefined });
  saveReview(id, { white: { accuracy: 80 }, black: {} });
  assert.deepEqual(getReview(id).white, { accuracy: 80 });
  saveReview(id, { white: {}, black: { accuracy: '' } });
  assert.equal(getReview(id), null);
  assert.throws(() => saveReview(999999, { white: { accuracy: 50 } }), /introuvable/);
});

test('bilans de référence : saisis dans l\'application, puis ceux du fichier ; la saisie l\'emporte', () => {
  const file = path.join(config.dataDir, 'bilans.json');
  const url = getDb().prepare('SELECT url FROM games WHERE id = ?').get(id).url ?? 'https://www.chess.com/game/live/186787115286';
  getDb().prepare('UPDATE games SET url = ? WHERE id = ?').run(url, id);
  fs.writeFileSync(file, JSON.stringify({ games: [{ url, white: { accuracy: 70 }, black: { accuracy: 60 } }, { url: 'https://www.chess.com/game/live/1', white: {}, black: {} }] }));
  assert.deepEqual(referenceReviews(getDb(), { file }).map((r) => [r.gameId, r.white.accuracy, r.source]), [[id, 70, 'fichier']]);
  saveReview(id, { white: { accuracy: 79 }, black: { accuracy: 75.7 } });
  assert.deepEqual(referenceReviews(getDb(), { file }).map((r) => [r.gameId, r.white.accuracy]), [[id, 79]]);
  const { games, missing } = referenceDataset(getDb(), { file });
  assert.equal(games.length, 1);
  assert.equal(missing.length, 0);
  assert.ok(games[0].list.length > 100 && games[0].players.w.elo > 0);
  saveReview(id, { white: {}, black: {} });
});

test('simplexe : retrouve le minimum d\'une fonction simple', () => {
  const r = nelderMead(([x, y]) => (x - 1) ** 2 + 3 * (y + 2) ** 2, [0, 0], { iterations: 500 });
  assert.ok(Math.abs(r.x[0] - 1) < 1e-3 && Math.abs(r.x[1] + 2) < 1e-3, JSON.stringify(r.x));
});

test('ajustement : sur des bilans produits avec des réglages connus, les écarts tombent presque à zéro', async () => {
  const { games } = referenceDataset(getDb(), { file: null });
  assert.equal(games.length, 0, 'pas encore de bilan saisi');
  saveReview(id, { white: { accuracy: 50 }, black: { accuracy: 50 } });
  const dataset = referenceDataset(getDb()).games;
  // « chess.com » imaginaire : une autre courbe et une autre précision que les réglages de départ.
  const truth = { curve: { k1500: 0.15, eloSlope: 0.3 }, accuracy: { decay: 0.07, scale: 110, harmonicWeight: 0.3 } };
  for (const p of evaluate(dataset, truth).players) {
    const { accuracy, ...counts } = p.ours;
    dataset[0].ref[p.side] = { accuracy, ...counts };
    for (const k of ['inaccuracy', 'mistake', 'miss', 'blunder']) dataset[0].ref[p.side][k] ??= 0;
  }
  const result = await fitStyle(dataset);
  assert.ok(result.after.mae.accuracy < 0.5, `précision : écart ${result.after.mae.accuracy}`);
  assert.ok(result.after.mae.accuracy < result.before.mae.accuracy);
  assert.ok(result.after.mae.serious <= result.before.mae.serious);
  assert.equal(result.after.mae.serious, 0, 'fautes graves retrouvées');
  // Enregistrement : le fichier lu au démarrage, avec les écarts avant / après.
  const file = writeStyleFile(result, { games: 1 });
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved.curve, result.params.curve);
  assert.deepEqual(saved.accuracy, result.params.accuracy);
  assert.equal(lastFit().parties, 1);
  assert.ok(lastFit().ecartMoyenApres.precision <= lastFit().ecartMoyenAvant.precision);
  saveReview(id, { white: {}, black: {} });
});
