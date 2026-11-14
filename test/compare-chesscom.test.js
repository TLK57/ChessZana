// Comparaison avec les bilans chess.com (scripts/compare-chesscom.js) : fichier des bilans et décompte des fautes.
import './_unit.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, serious } from '../scripts/compare-chesscom.js';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'chesscom-reviews.json');

test('bilans chess.com : la partie 620 est la première, avec les chiffres de chess.com', () => {
  const { games } = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const g = games[0];
  assert.match(g.url, /186787115286$/);
  assert.deepEqual(g.white, { brilliant: 1, excellent: 3, best: 21, mistake: 3, miss: 2, blunder: 1, accuracy: 79.0, gameRating: 1500 });
  assert.deepEqual(g.black, { brilliant: 0, excellent: 2, best: 16, mistake: 3, miss: 2, blunder: 1, accuracy: 75.7, gameRating: 1250 });
  for (const entry of games) {
    for (const side of ['white', 'black']) {
      for (const k of Object.keys(entry[side])) assert.ok(CATEGORIES.includes(k) || ['accuracy', 'gameRating'].includes(k), k);
    }
    if (entry.fixture) assert.ok(fs.existsSync(path.join(path.dirname(FILE), entry.fixture)), entry.fixture);
  }
});

test('fautes sérieuses = erreurs + occasions manquées + gaffes', () => {
  assert.equal(serious({ mistake: 3, miss: 2, blunder: 1, inaccuracy: 7 }), 6);
  assert.equal(serious({}), 0);
});
