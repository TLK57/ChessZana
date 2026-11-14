// Étape 3 : statistiques incrémentales, répertoire, erreurs récurrentes, puzzles, bilan pour Claude. — avec le vrai Stockfish (intégration).
import '../_setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { overrideConfig } from '../../src/config.js';
import { openDb, getDb, setMeta } from '../../src/db.js';
import { Evaluator } from '../../src/engine/evaluator.js';
import { analyzeGame } from '../../src/analysis/analyze.js';
import { importPgnText } from '../../src/importers/pgnfile.js';
import { upsertPlayer } from '../../src/games.js';
import { refreshAllStats, refreshGameStats } from '../../src/stats/compute.js';
import { dashboard, recurringErrors, repertoire, timeStats } from '../../src/stats/queries.js';
import { answerPuzzle, pickSession, todaySession, trainingStats } from '../../src/stats/training.js';
import { bilanText } from '../../src/stats/bilan.js';

openDb();
overrideConfig({ lichess: { cloudEval: false, tablebase: false }, engine: { quickDepth: 10 } });
const ev = new Evaluator();
test.before(async () => { await ev.init(); });
test.after(async () => { await ev.close(); });

const clk = (s) => `{[%clk 0:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}]}`;
// Partie 1 : je joue les Noirs et je gaffe (3... Cf6?? permet le mat du berger), avec moins de 30 s à la pendule.
const G1 = `[White "Adv"]\n[Black "Moi"]\n[WhiteElo "1200"]\n[BlackElo "1100"]\n[Result "1-0"]\n[UTCDate "2026.10.01"]\n[TimeControl "60"]\n[Termination "Adv won by checkmate"]\n\n`
  + `1. e4 ${clk(59)} e5 ${clk(40)} 2. Qh5 ${clk(58)} Nc6 ${clk(25)} 3. Bc4 ${clk(57)} Nf6 ${clk(20)} 4. Qxf7# ${clk(56)} 1-0`;
// Partie 2 : je joue les Blancs, une partie propre en début de théorie.
const G2 = `[White "Moi"]\n[Black "Adv2"]\n[WhiteElo "1110"]\n[BlackElo "1050"]\n[Result "1-0"]\n[UTCDate "2026.10.05"]\n[TimeControl "180"]\n\n`
  + `1. e4 ${clk(179)} e5 ${clk(179)} 2. Nf3 ${clk(177)} Nc6 ${clk(178)} 3. Bb5 ${clk(175)} a6 ${clk(176)} 4. Ba4 ${clk(170)} Nf6 ${clk(170)} 1-0`;
let ids;

test('statistiques : calculées pour mes parties analysées, puis seulement quand une analyse change', async () => {
  upsertPlayer('pgn', 'Moi', 'Moi');
  ids = (await importPgnText(`${G1}\n\n${G2}`)).ids;
  for (const id of ids) await analyzeGame(id, 'quick', { evaluator: ev });
  const r1 = await refreshAllStats();
  assert.deepEqual(r1, { checked: 2, updated: 2 });
  const r2 = await refreshAllStats();
  assert.deepEqual(r2, { checked: 0, updated: 0 }, 'rien à refaire');
  assert.equal(refreshGameStats(ids[0]), 'fresh');
  // Une nouvelle analyse de la partie 1 -> seule cette partie est recalculée.
  getDb().prepare("UPDATE game_analysis SET analyzed_at = datetime('now', '+1 minute') WHERE game_id = ?").run(ids[0]);
  assert.deepEqual(await refreshAllStats(), { checked: 1, updated: 1 });

  const s1 = getDb().prepare('SELECT * FROM game_stats WHERE game_id = ?').get(ids[0]);
  assert.equal(s1.my_color, 'black');
  assert.equal(s1.outcome, 'loss');
  assert.equal(s1.n_blunder, 1);
  assert.equal(s1.low_n >= 1, true, 'des coups joués avec moins de 30 s');
  assert.equal(s1.low_bad, 1, 'la gaffe a été jouée avec moins de 30 s');
});

test('tableau de bord, temps, erreurs récurrentes et répertoire', () => {
  const d = dashboard({});
  assert.equal(d.count, 2);
  assert.deepEqual(d.results, { win: 1, draw: 0, loss: 1 });
  assert.equal(d.perGame.blunder, 0.5);
  assert.equal(d.series.length, 2);
  assert.ok(d.phases.opening.moves >= 1);
  assert.equal(dashboard({ color: 'white' }).count, 1);
  assert.equal(dashboard({ opponent: 'stronger' }).count, 1);
  const t = timeStats({});
  assert.equal(t.lowClock.errors, 1);
  assert.ok(t.lowClock.errorRate > t.otherClock.errorRate);
  const e = recurringErrors({});
  assert.equal(e.types[0].type, 'mate_allowed');
  assert.equal(e.types[0].examples[0].gameId, ids[0]);
  const rep = repertoire({}, { color: 'white', maxPlies: 8, minGames: 1 });
  assert.equal(rep.games, 1);
  assert.equal(rep.tree.children[0].san, 'e4');
  assert.equal(rep.tree.children[0].book, true);
  assert.deepEqual(rep.tree.children[0].ids, [ids[1]]);
});

test('puzzles : la gaffe devient un puzzle ; bonne réponse -> 3 jours, mauvaise -> demain', async () => {
  const stats = trainingStats('2026-11-13');
  assert.equal(stats.total, 1);
  setMeta('training_session', 'null');
  const s = todaySession({ today: '2026-11-13' });
  assert.equal(s.puzzles.length, 1);
  const p = s.puzzles[0];
  assert.equal(p.color, 'black');
  assert.equal(p.playedSan, 'Nf6');
  const wrong = await answerPuzzle(p.id, 'a7a6', { evaluator: ev, today: '2026-11-13' });
  assert.equal(wrong.correct, false);
  assert.equal(wrong.next.dueDate, '2026-11-14');
  assert.match(wrong.explanation.join(' '), /mater en 1/);
  // Deuxième réponse le même jour : ne change plus la révision.
  const again = await answerPuzzle(p.id, wrong.solutionUci, { evaluator: ev, today: '2026-11-13' });
  assert.equal(again.correct, true);
  assert.equal(again.firstTry, false);
  // Le lendemain, réussi -> dans 3 jours.
  const next = await answerPuzzle(p.id, wrong.solutionUci, { evaluator: ev, today: '2026-11-14' });
  assert.equal(next.correct, true);
  assert.equal(next.next.dueDate, '2026-11-17');
  const st = trainingStats('2026-11-14');
  assert.equal(st.byType[0].attempts, 2);
  assert.equal(st.byType[0].successes, 1);
});

test('session : priorité aux types d\'erreurs les plus fréquents, 4 au plus par type', () => {
  const freq = new Map([['hanging_piece', { rank: 0 }], ['missed_fork', { rank: 1 }], ['positional', { rank: 2 }]]);
  const mk = (id, type, due = null) => ({ id, error_type: type, due_date: due, played_at: `2026-10-${String(id).padStart(2, '0')}` });
  const cands = [
    ...[1, 2, 3, 4, 5, 6].map((i) => mk(i, 'hanging_piece')),
    ...[7, 8].map((i) => mk(i, 'missed_fork')),
    ...[9, 10, 11, 12].map((i) => mk(i, 'positional')),
  ];
  const chosen = pickSession(cands, freq, 10, '2026-11-13');
  assert.equal(chosen.length, 10);
  const count = (t) => chosen.filter((c) => c.error_type === t).length;
  assert.equal(count('hanging_piece') >= 4, true);
  assert.equal(count('missed_fork'), 2);
  assert.equal(chosen[0].error_type, 'hanging_piece');
});

test('bilan pour Claude : statistiques, ouvertures, erreurs, temps, 5 positions et la demande', () => {
  const b = bilanText(10);
  assert.equal(b.count, 2);
  for (const part of ['Précision par phase', 'Ouvertures', 'erreurs récurrentes', 'Gestion du temps', 'positions typiques', "Fais-moi un plan d'entraînement de 4 semaines adapté à ces faiblesses."]) {
    assert.ok(b.text.includes(part), part);
  }
  assert.match(b.text, /r1bqkbnr\/pppp1ppp\/2n5\/4p2Q\/2B1P3\/8\/PPPP1PPP\/RNB1K1NR b KQkq/);
});
