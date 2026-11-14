// Elo de performance par cadence, Elo estimé « indicatif » avec fourchette, seuils Lichess (5 / 10 / 15 %)
// et reclassement des parties déjà analysées sans recalcul (évaluations en cache).
import { useRecordedEngine } from './_unit.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { overrideConfig, config } from '../src/config.js';
import { openDb, getDb } from '../src/db.js';
import { Evaluator } from '../src/engine/evaluator.js';
import { analyzeGame } from '../src/analysis/analyze.js';
import { reclassifyAll } from '../src/analysis/reclassify.js';
import { LICHESS_THRESHOLDS, lossCategory, thresholdsFor } from '../src/analysis/classify.js';
import { importPgnText } from '../src/importers/pgnfile.js';
import { upsertPlayer } from '../src/games.js';
import { myResults } from '../src/library.js';
import { estimatedEloByTimeClass, performanceByTimeClass } from '../src/stats/performance.js';

useRecordedEngine('preset');
openDb();
overrideConfig({ lichess: { cloudEval: false, tablebase: false }, engine: { quickDepth: 10 } });
const ev = new Evaluator();
test.before(async () => { await ev.init(); });
test.after(async () => { await ev.close(); overrideConfig({ classification: { preset: 'chesscom' } }); });

test('Elo de performance : adversaires + 400 × (V − D) / N, par cadence, avec fourchette', () => {
  const g = (time_class, result, my_color, white_elo, black_elo) => ({ time_class, result, my_color, white_elo, black_elo });
  const rows = [
    g('blitz', '1-0', 'white', 1000, 1100), g('blitz', '0-1', 'white', 1000, 1200), g('blitz', '1/2-1/2', 'black', 900, 1000),
    g('blitz', '0-1', 'black', 1300, 1000), g('rapid', '1-0', 'white', 1000, 1500), g('blitz', '*', 'white', 1000, 1000),
    g('blitz', '1-0', 'white', 1000, null),
  ];
  const [blitz, rapid] = performanceByTimeClass(rows);
  assert.equal(blitz.timeClass, 'blitz');
  assert.equal(blitz.n, 4, 'parties en cours et adversaires sans Elo ignorés');
  assert.deepEqual([blitz.win, blitz.draw, blitz.loss], [2, 1, 1]);
  assert.equal(blitz.avgOpp, 1125); // (1100 + 1200 + 900 + 1300) / 4
  assert.equal(blitz.performance, 1125 + 400 * (2 - 1) / 4);
  assert.ok(blitz.low < blitz.performance && blitz.high > blitz.performance);
  assert.equal(rapid.performance, 1900);
  assert.equal(rapid.high, 1900, 'score 100 % : la borne haute est adversaires + 400');
});

test('Elo estimé (indicatif) : moyenne par cadence et fourchette de la moyenne', () => {
  const [e] = estimatedEloByTimeClass([{ timeClass: 'blitz', estElo: 1000 }, { timeClass: 'blitz', estElo: 1200 }, { timeClass: 'blitz', estElo: 1100 }, { timeClass: 'blitz', estElo: null }]);
  assert.equal(e.n, 3);
  assert.equal(e.mean, 1100);
  assert.equal(e.low, Math.round(1100 - (1.96 * 100) / Math.sqrt(3)));
  assert.equal(e.high, Math.round(1100 + (1.96 * 100) / Math.sqrt(3)));
});

test('seuils Lichess : imprécision dès 5 %, erreur dès 10 %, gaffe dès 15 %, quel que soit l\'Elo', () => {
  overrideConfig({ classification: { preset: 'lichess' } });
  assert.deepEqual(thresholdsFor(900), LICHESS_THRESHOLDS);
  const th = thresholdsFor(2000);
  assert.equal(lossCategory(4.9, th), 'good');
  assert.equal(lossCategory(5, th), 'inaccuracy');
  assert.equal(lossCategory(10, th), 'mistake');
  assert.equal(lossCategory(14.9, th), 'mistake');
  assert.equal(lossCategory(15, th), 'blunder');
  overrideConfig({ classification: { preset: 'chesscom' } });
  assert.equal(lossCategory(15, thresholdsFor(2000)), 'mistake', 'inspiré de chess.com : gaffe dès 22 %');
});

test('changement de seuils : toutes les analyses sont reclassées sans recalcul, puis retour à l\'identique', async () => {
  upsertPlayer('pgn', 'Moi', 'Moi');
  // Piège de Blackburne-Shilling : des fautes de toutes tailles.
  const pgn = '[White "Moi"]\n[Black "Adv"]\n[Result "0-1"]\n[TimeControl "300"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bc4 Nd4 4. Nxe5 Qg5 5. Nxf7 Qxg2 6. Rf1 Qxe4+ 7. Be2 Nf3# 0-1';
  const id = (await importPgnText(pgn)).ids[0];
  const original = await analyzeGame(id, 'quick', { evaluator: ev });
  const searches = ev.stats.stockfish;
  const lossBased = new Set(['excellent', 'good', 'inaccuracy', 'mistake', 'blunder']);
  const classes = () => getDb().prepare("SELECT ply, classification, loss FROM move_analysis WHERE game_id = ? AND pass = 'quick' ORDER BY ply").all(id);

  overrideConfig({ classification: { preset: 'lichess' } });
  const r = await reclassifyAll();
  assert.equal(r.failed.length, 0, JSON.stringify(r.failed));
  assert.equal(ev.stats.stockfish, searches, 'aucune recherche Stockfish pour reclasser');
  const after = classes();
  let changed = 0;
  for (const [i, m] of original.moves.entries()) {
    if (!lossBased.has(m.classification)) continue;
    const want = lossCategory(m.loss, LICHESS_THRESHOLDS);
    if (lossBased.has(after[i].classification)) assert.equal(after[i].classification, want, `coup ${m.ply} (perte ${m.loss.toFixed(1)} %)`);
    if (lossCategory(m.loss, config.classification.thresholds) !== want) changed++;
  }
  if (changed) assert.ok(after.some((m, i) => m.classification !== original.moves[i].classification), 'au moins un coup change de catégorie');

  overrideConfig({ classification: { preset: 'chesscom' } });
  await reclassifyAll();
  assert.deepEqual(classes().map((m) => m.classification), original.moves.map((m) => m.classification), 'retour aux seuils d\'origine : classement identique');
});

test('mes résultats pour l\'Elo de performance : toutes mes parties terminées, analysées ou non', async () => {
  const pgn = (r, d) => `[White "Moi"]\n[Black "X"]\n[WhiteElo "1000"]\n[BlackElo "1100"]\n[Result "${r}"]\n[UTCDate "${d}"]\n[TimeControl "180"]\n\n1. d4 d5 ${r}`;
  await importPgnText([pgn('1-0', '2026.09.01'), pgn('0-1', '2026.09.02'), pgn('1-0', '2026.09.03')].join('\n\n'));
  const rows = myResults({ timeClass: 'blitz' });
  assert.ok(rows.length >= 3);
  const blitz = performanceByTimeClass(rows).find((p) => p.timeClass === 'blitz');
  assert.equal(blitz.n, rows.filter((x) => (x.my_color === 'white' ? x.black_elo : x.white_elo)).length);
  assert.equal(myResults({ timeClass: 'blitz', opponent: 'weaker' }).length, 0, 'adversaires tous plus forts');
  assert.equal(myResults({ timeClass: 'blitz', from: '2026-09-02', to: '2026-09-02' }).length, 1);
});
