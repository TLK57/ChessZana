// Statistiques fiables : intervalle de Wilson, comparaison seulement si les intervalles sont disjoints,
// taille d'échantillon (n) dans les statistiques et dans le bilan.
import './_unit.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, getDb } from '../src/db.js';
import { importPgnText } from '../src/importers/pgnfile.js';
import { ensureStatsSchema } from '../src/stats/compute.js';
import { dashboard, recurringErrors, timeStats } from '../src/stats/queries.js';
import { bilanText } from '../src/stats/bilan.js';
import { MIN_GAMES, compare, enough, wilson } from '../src/stats/confidence.js';

openDb();
const near = (a, b, eps = 0.001) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

test('Wilson : valeurs de référence', () => {
  const half = wilson(5, 10);
  near(half.p, 0.5); near(half.low, 0.2366); near(half.high, 0.7634);
  const none = wilson(0, 10);
  assert.equal(none.low, 0); near(none.high, 0.2775);
  const all = wilson(10, 10);
  near(all.low, 0.7225); near(all.high, 1);
  const big = wilson(520, 1000);
  near(big.low, 0.4890); near(big.high, 0.5508);
  assert.equal(wilson(3, 0), null, 'aucune partie : pas d\'intervalle');
  assert.equal(wilson(2.5, 5).p, 0.5, 'une nulle compte pour ½');
});

test('comparaison : une différence n\'est réelle que si les intervalles ne se chevauchent pas', () => {
  assert.equal(compare(wilson(55, 100), wilson(45, 100)), 'similar', '55 % contre 45 % sur 100 coups : chevauchement');
  assert.equal(compare(wilson(60, 100), wilson(40, 100)), 'higher', '60 % contre 40 % sur 100 coups : intervalles disjoints');
  assert.equal(compare(wilson(300, 1000), wilson(100, 1000)), 'higher');
  assert.equal(compare(wilson(100, 1000), wilson(300, 1000)), 'lower');
  assert.equal(compare(wilson(4, 5), wilson(1, 5)), 'similar', 'sur 5 essais, même un gros écart n\'est pas démontré');
  assert.equal(compare(null, wilson(1, 2)), 'similar');
  assert.equal(MIN_GAMES, 10);
  assert.equal(enough(9), false);
  assert.equal(enough(10), true);
});

test('tableau de bord, temps et erreurs : n et intervalles de confiance', async () => {
  ensureStatsSchema();
  const pgn = (i) => `[White "Moi"]\n[Black "Adv${i}"]\n[Result "${i % 3 === 0 ? '0-1' : '1-0'}"]\n[UTCDate "2026.10.${String(i + 1).padStart(2, '0')}"]\n\n1. e4 e5 ${i % 3 === 0 ? '0-1' : '1-0'}`;
  const r = await importPgnText(Array.from({ length: 12 }, (_, i) => pgn(i)).join('\n\n'));
  const ins = getDb().prepare(`INSERT INTO game_stats(game_id, version, pass, analyzed_at, my_color, outcome, time_class, played_at, has_clock,
      accuracy, my_moves, n_blunder, n_mistake, n_inaccuracy, n_miss, op_n, op_acc, mg_n, mg_acc, eg_n, eg_acc,
      op_t, op_tn, mg_t, mg_tn, eg_t, eg_tn, low_n, low_bad, low_inacc, oth_n, oth_bad, oth_inacc, simple_n, slow_simple)
    VALUES (?, 1, 'quick', datetime('now'), 'white', ?, 'blitz', ?, 1, 80, 30, 1, 1, 2, 0, 10, 850, 15, 1200, ?, ?,
      0, 0, 0, 0, 0, 0, ?, ?, 0, 25, 1, 0, 4, 1)`);
  r.ids.forEach((id, i) => ins.run(id, i % 3 === 0 ? 'loss' : 'win', `2026-10-${String(i + 1).padStart(2, '0')}T10:00:00Z`,
    i < 3 ? 5 : 0, i < 3 ? 400 : 0, 10, 6));
  getDb().prepare(`INSERT INTO move_features(game_id, ply, phase, classification, error_type) VALUES (?, 3, 'opening', 'blunder', 'hanging')`).run(r.ids[0]);

  const d = dashboard({});
  assert.equal(d.count, 12);
  assert.equal(d.score.n, 12);
  near(d.score.p, 8 / 12);
  assert.ok(d.score.low < d.score.p && d.score.high > d.score.p);
  assert.equal(d.accuracyGames, 12);
  assert.equal(d.phases.opening.games, 12);
  assert.equal(d.phases.endgame.games, 3, 'finale : seulement 3 parties (échantillon trop petit)');
  assert.ok(!enough(d.phases.endgame.games));

  const t = timeStats({});
  assert.equal(t.lowClock.moves, 120);
  assert.equal(t.lowClock.games, 12);
  near(t.lowClock.errorCI.p, 0.6);
  near(t.otherClock.errorCI.p, 1 / 25);
  assert.equal(t.lowVsOther, 'higher', '60 % contre 4 % : intervalles disjoints');
  near(t.slowSimple.rate.p, 0.25);

  const e = recurringErrors({});
  assert.equal(e.games, 12);
  assert.equal(e.types[0].shareCI.n, e.total);

  const b = bilanText(25, {});
  assert.match(b.text, /IC 95 %/);
  assert.match(b.text, /n = 12 parties/);
  assert.match(b.text, /échantillon trop petit/, 'la finale (3 parties) est signalée');
  assert.match(b.text, /différence est nette/);
});
