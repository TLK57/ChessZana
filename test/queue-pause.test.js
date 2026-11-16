// Pause de la file : elle retient ce qui était déjà dans la file, mais une partie demandée ensuite
// (bouton « Analyser ») démarre tout de suite.
import './_unit.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, getDb, setMeta } from '../src/db.js';
import { importPgnText } from '../src/importers/pgnfile.js';
import { AnalysisQueue } from '../src/queue.js';

openDb();

const pgn = (w, b) => `[Event "Pause"]\n[White "${w}"]\n[Black "${b}"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 1-0`;

// File sans boucle (aucune analyse réelle) : on teste seulement ce qu'elle choisirait.
function queue() {
  const q = new AnalysisQueue(null);
  q.stopped = true; // start() ne lance pas la boucle
  return q;
}

test('pause : une partie demandée après la mise en pause passe quand même, les autres attendent', async () => {
  const r = await importPgnText([pgn('A', 'B'), pgn('C', 'D')].join('\n\n'));
  const [before, after] = r.ids;
  const q = queue();
  q.prioritize(before);
  assert.equal(q.nextItem().game_id, before);

  q.pause();
  assert.equal(q.paused, true);
  assert.equal(q.nextItem(), undefined, 'demandée avant la pause : retenue');
  assert.equal(q.isHeld(before), true, 'l\'écran propose « Analyser maintenant »');
  assert.equal(q.isWanted(before, 'quick'), false);

  q.prioritize(after);
  const next = q.nextItem();
  assert.equal(next.game_id, after, 'demandée pendant la pause : démarre tout de suite');
  assert.equal(next.pass, 'quick', 'passe rapide d\'abord');
  assert.equal(q.isWanted(after, 'deep'), true, 'puis sa passe profonde, toujours en pause');
  assert.equal(q.isHeld(after), false);

  // « Analyser maintenant » sur la partie retenue : redemandée, elle démarre aussi.
  q.prioritize(before);
  assert.equal(q.nextItem().game_id, before);
  assert.equal(q.isHeld(before), false);

  // Une nouvelle pause retient tout ce qui est demandé à ce moment.
  q.pause();
  assert.equal(q.nextItem(), undefined);

  q.resume();
  assert.equal(q.paused, false);
  assert.ok([before, after].includes(q.nextItem().game_id), 'reprise : toute la file repart');
  assert.equal(q.isHeld(before), false, 'pas en pause : rien n\'est retenu');
});

test('pause mise avant cette version (sans seuil) : ce qui est déjà demandé reste en pause', async () => {
  const r = await importPgnText(pgn('E', 'F'));
  const [g] = r.ids;
  const q = queue();
  q.prioritize(g);
  setMeta('queue_paused', '1');
  getDb().prepare("DELETE FROM meta WHERE key = 'queue_pause_floor'").run();
  assert.equal(q.nextItem(), undefined, 'aucune analyse ne repart toute seule');
  q.prioritize(g);
  assert.equal(q.nextItem().game_id, g, 'redemandée : elle démarre');
  q.resume();
});
