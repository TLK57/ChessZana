// Étape « profondeur honnête » : vérification à profondeur fixe des coups douteux, profondeur réellement
// atteinte, et file « Analyser tout mon historique » (reste à faire, temps estimé, pause).
import './_unit.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { openDb, getDb } from '../src/db.js';
import { analyzeMoveList } from '../src/analysis/analyze.js';
import { importPgnText } from '../src/importers/pgnfile.js';
import { upsertPlayer } from '../src/games.js';
import { AnalysisQueue } from '../src/queue.js';
import { moveToUci, START_FEN } from '../src/chessutil.js';

openDb();

// Faux évaluateur : avec un budget de nœuds, 1. g4 a l'air d'une gaffe ; à la vraie profondeur 22, c'est un coup correct.
function scriptedEvaluator({ budgetDepth = 18, playedCpBudget = -400 } = {}) {
  const calls = [];
  const line = (move, cp, depth) => ({ move, cp, mate: null, pv: [move], depth });
  return {
    calls,
    async evaluatePosition(fen, { depth, nodes = null }) {
      calls.push({ kind: 'position', fen, depth, nodes });
      if (fen !== START_FEN) return { source: 'stockfish', depth: nodes ? budgetDepth : depth, lines: [line('e7e5', 0, nodes ? budgetDepth : depth)] };
      if (nodes) return { source: 'stockfish', depth: budgetDepth, lines: [line('e2e4', 40, budgetDepth), line('d2d4', 35, budgetDepth)] };
      return { source: 'stockfish', depth, lines: [line('e2e4', 30, depth), line('g2g4', 20, depth)] };
    },
    async evaluateMove(fen, uci, { depth, nodes = null }) {
      calls.push({ kind: 'move', fen, uci, depth, nodes });
      return { ...line(uci, nodes ? playedCpBudget : 20, nodes ? budgetDepth : depth), source: 'stockfish', depth: nodes ? budgetDepth : depth };
    },
  };
}

function oneMove(uci) {
  const c = new Chess();
  const m = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4) });
  return { moves: [{ ply: 1, color: 'w', san: m.san, uci: moveToUci(m), fenBefore: START_FEN }], finalFen: c.fen() };
}

const deepOpts = (evaluator, finalFen, extra = {}) => ({
  evaluator, depth: 22, nodes: 1500000, verifyDepth: 22, allowCloud: false, standardStart: false, finalFen, whiteElo: 1500, blackElo: 1500, ...extra,
});

test('vérification : une « gaffe » trouvée avec le budget de nœuds est recalculée à la vraie profondeur 22, puis reclassée', async () => {
  const ev = scriptedEvaluator();
  const { moves, finalFen } = oneMove('g2g4');
  const without = await analyzeMoveList(moves, deepOpts(scriptedEvaluator(), finalFen, { verifyDepth: 0 }));
  assert.equal(without.moves[0].classification, 'blunder', 'sans vérification : gaffe');
  assert.equal(without.moves[0].depth, 18);
  const r = await analyzeMoveList(moves, deepOpts(ev, finalFen));
  const m = r.moves[0];
  assert.notEqual(m.classification, 'blunder', 'à profondeur 22, le coup est correct');
  assert.equal(m.verified, true);
  assert.equal(m.depth, 22, 'profondeur réellement atteinte affichée');
  assert.equal(r.verifiedCount, 1);
  assert.equal(r.verifyDepth, 22);
  assert.ok(ev.calls.some((c) => c.kind === 'position' && c.fen === START_FEN && c.depth === 22 && c.nodes === null), 'recherche à profondeur 22 sans limite de nœuds');
});

test('vérification : seulement les erreurs, gaffes, occasions manquées, très bons et brillants', async () => {
  const ev = scriptedEvaluator({ playedCpBudget: 25 }); // perte faible : coup « bon », pas de vérification
  const { moves, finalFen } = oneMove('g2g4');
  const r = await analyzeMoveList(moves, deepOpts(ev, finalFen));
  assert.ok(!['mistake', 'blunder', 'miss', 'brilliant', 'great'].includes(r.moves[0].classification), r.moves[0].classification);
  assert.equal(r.moves[0].verified, false);
  assert.equal(r.verifiedCount, 0);
  assert.ok(!ev.calls.some((c) => c.nodes === null && c.depth === 22), 'aucune recherche supplémentaire');
});

test('vérification : inutile si la recherche a déjà atteint la profondeur 22', async () => {
  const ev = scriptedEvaluator({ budgetDepth: 24 });
  const { moves, finalFen } = oneMove('g2g4');
  const r = await analyzeMoveList(moves, deepOpts(ev, finalFen));
  assert.equal(r.moves[0].classification, 'blunder');
  assert.equal(r.moves[0].verified, false);
  assert.equal(r.moves[0].depth, 24);
  assert.equal(r.verifiedCount, 0);
});

test('profondeur réellement atteinte : minimum, maximum et médiane de la partie', async () => {
  const ev = scriptedEvaluator();
  const { moves, finalFen } = oneMove('e2e4');
  const r = await analyzeMoveList(moves, deepOpts(ev, finalFen, { verifyDepth: 0 }));
  assert.deepEqual([r.depthMin, r.depthUsed, r.depthMax], [18, 18, 18]);
});

test('historique : mes parties après les parties demandées, reste à faire, temps estimé, pause et reprise', async () => {
  upsertPlayer('pgn', 'Moi', 'Moi');
  const pgn = (w, b, d) => `[White "${w}"]\n[Black "${b}"]\n[Result "1-0"]\n[UTCDate "${d}"]\n\n1. e4 e5 2. Nf3 Nc6 1-0`;
  const r = await importPgnText([pgn('Moi', 'A', '2026.10.01'), pgn('B', 'Moi', '2026.10.02'), pgn('C', 'D', '2026.10.03')].join('\n\n'));
  const [g1, g2, other] = r.ids;
  const q = new AnalysisQueue(null);
  assert.equal(q.mode, 'manual');
  assert.equal(q.nextItem(), undefined, 'rien sans demande');
  let h = q.progress().history;
  assert.equal(h.state, 'off');
  assert.equal(h.totalGames, 2, 'seulement mes parties');
  assert.equal(h.remainingGames, 2);
  assert.equal(h.remainingQuick, 2);
  assert.equal(h.remainingDeep, 2);
  assert.equal(h.measured, false);
  assert.equal(h.etaSec, 2 * 20 + 2 * 300, 'estimation par défaut sans mesure');

  q.setHistory('start');
  const first = q.nextItem();
  assert.ok([g1, g2].includes(first.game_id));
  assert.equal(first.pass, 'quick', 'passe rapide de tout l\'historique d\'abord');
  // Une partie demandée passe avant l'historique.
  q.prioritize(other);
  assert.equal(q.nextItem().game_id, other);
  q.unrequest(other);

  // Durées mesurées : l'estimation suit cet ordinateur.
  for (const [id, pass, ms] of [[g1, 'quick', 10000], [g2, 'quick', 12000], [other, 'quick', 14000]]) {
    getDb().prepare("INSERT INTO game_analysis(game_id, pass, depth, duration_ms) VALUES (?, ?, 12, ?)").run(id, pass, ms);
  }
  getDb().prepare("UPDATE analysis_queue SET status = 'done' WHERE pass = 'quick' AND game_id IN (?, ?)").run(g1, g2);
  h = q.progress().history;
  assert.equal(h.remainingQuick, 0);
  assert.equal(h.remainingDeep, 2);
  assert.equal(h.avgSec.quick, 12);
  assert.equal(q.nextItem().pass, 'deep');

  q.setHistory('pause');
  assert.equal(q.progress().history.state, 'paused');
  assert.equal(q.nextItem(), undefined, 'en pause : plus rien en mode manuel');
  q.setHistory('resume');
  assert.equal(q.nextItem().pass, 'deep');
  q.setHistory('stop');
  assert.equal(q.nextItem(), undefined);
  assert.throws(() => q.setHistory('nimporte'), /Action inconnue/);
});

test('historique : les analyses profondes faites avant la vérification sont refaites (positions en cache)', () => {
  const q = new AnalysisQueue(null);
  const d = getDb();
  const mine = d.prepare("SELECT game_id FROM analysis_queue WHERE pass = 'deep' AND game_id IN (SELECT id FROM games WHERE white_name = 'Moi')").get().game_id;
  d.prepare("UPDATE analysis_queue SET status = 'done' WHERE game_id = ? AND pass = 'deep'").run(mine);
  d.prepare("INSERT INTO game_analysis(game_id, pass, depth, verify_depth) VALUES (?, 'deep', 20, NULL)").run(mine);
  q.setHistory('start');
  assert.equal(d.prepare("SELECT status FROM analysis_queue WHERE game_id = ? AND pass = 'deep'").get(mine).status, 'pending');
  // Une analyse déjà vérifiée n'est pas refaite.
  d.prepare("UPDATE analysis_queue SET status = 'done' WHERE game_id = ? AND pass = 'deep'").run(mine);
  d.prepare("UPDATE game_analysis SET verify_depth = 22 WHERE game_id = ? AND pass = 'deep'").run(mine);
  q.setHistory('start');
  assert.equal(d.prepare("SELECT status FROM analysis_queue WHERE game_id = ? AND pass = 'deep'").get(mine).status, 'done');
  // Bouton « Revérifier » d'une partie : refait la passe profonde.
  q.prioritize(mine, { reverify: true });
  assert.equal(d.prepare("SELECT status FROM analysis_queue WHERE game_id = ? AND pass = 'deep'").get(mine).status, 'pending');
  q.setHistory('stop');
});
