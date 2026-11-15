// Étape 2 : liste filtrée, ouverture, données de l'écran d'analyse, mode libre. — réponses enregistrées de Stockfish (test/fixtures/uci).
import { useRecordedEngine } from './_unit.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { overrideConfig } from '../src/config.js';
import { openDb, getDb } from '../src/db.js';
import { Evaluator } from '../src/engine/evaluator.js';
import { analyzeGame } from '../src/analysis/analyze.js';
import { buildGameView, liveMove } from '../src/analysis/gameview.js';
import { importPgnText } from '../src/importers/pgnfile.js';
import { listMyGames, openingFamilies } from '../src/library.js';
import { upsertPlayer } from '../src/games.js';
import { AnalysisQueue } from '../src/queue.js';

useRecordedEngine('step2');
openDb();
overrideConfig({ lichess: { cloudEval: false, tablebase: false }, engine: { quickDepth: 12, liveDepth: 12 } });
const ev = new Evaluator();
test.before(async () => { await ev.init(); });
test.after(async () => { await ev.close(); });

const GAME = `[Event "Test"]
[White "MoiMeme"]
[Black "Adversaire"]
[WhiteElo "1100"]
[BlackElo "1120"]
[Result "1-0"]
[UTCDate "2026.11.01"]
[UTCTime "10:00:00"]
[TimeControl "180+2"]

1. e4 {[%clk 0:03:01]} e5 {[%clk 0:03:01]} 2. Qh5 {[%clk 0:02:59]} Nc6 {[%clk 0:02:58]} 3. Bc4 {[%clk 0:02:57]} Nf6 {[%clk 0:02:40]} 4. Qxf7# {[%clk 0:02:55]} 1-0`;

const OTHER = `[White "Adversaire2"]
[Black "MoiMeme"]
[Result "1-0"]
[UTCDate "2026.10.01"]
[TimeControl "600"]

1. d4 d5 2. c4 e6 3. Nc3 Nf6 1-0`;

let gameId;

test('liste : mes parties, filtres cadence / couleur / résultat / période / ouverture', async () => {
  upsertPlayer('pgn', 'MoiMeme', 'MoiMeme');
  const r = await importPgnText(`${GAME}\n\n${OTHER}`);
  assert.equal(r.added, 2);
  gameId = r.ids[0];
  const all = listMyGames({});
  assert.equal(all.total, 2);
  const g = all.games.find((x) => x.id === gameId);
  assert.equal(g.myColor, 'white');
  assert.equal(g.outcome, 'win');
  assert.equal(g.opponent.name, 'Adversaire');
  assert.equal(g.timeClass, 'blitz');
  assert.equal(g.analysis, 'pending');
  assert.equal(listMyGames({ color: 'black' }).total, 1);
  assert.equal(listMyGames({ result: 'loss' }).total, 1);
  assert.equal(listMyGames({ timeClass: 'rapid' }).total, 1);
  assert.equal(listMyGames({ from: '2026-10-15' }).total, 1);
  const families = openingFamilies().map((o) => o.name);
  assert.ok(families.includes("Queen's Gambit Declined"), families.join(', '));
  const qgd = listMyGames({ opening: "Queen's Gambit Declined" });
  assert.equal(qgd.total, 1);
});

test('écran d\'analyse : ouverture, sortie de théorie, pendules, explications, lignes', async () => {
  await analyzeGame(gameId, 'quick', { evaluator: ev });
  const v = buildGameView(gameId);
  assert.equal(v.myColor, 'white');
  assert.equal(v.pass, 'quick');
  assert.ok(v.opening.name, 'nom d\'ouverture');
  assert.ok(v.opening.exitPly >= 3, `sortie de théorie au demi-coup ${v.opening.exitPly}`);
  assert.equal(v.moves.length, 7);
  assert.equal(v.moves[5].timeSpentMs, 18000 + 2000 - 0); // 2:58 -> 2:40, +2 s d'incrément
  const blunder = v.moves[5]; // 3... Cf6??
  assert.equal(blunder.classification, 'blunder');
  assert.match(blunder.explanation.sentences.join(' '), /mater en 1/);
  assert.equal(blunder.lines.length, 2);
  assert.ok(blunder.lines[0].line.length >= 1 && blunder.lines[0].evalText);
  assert.equal(v.moves[6].winWhiteAfter, 100);
  assert.ok(Number.isFinite(v.startWin));
  assert.ok(v.white.counts.blunder === undefined || v.white.counts.blunder === 0);
  assert.equal(v.black.counts.blunder, 1);
  // Deux précisions : Lichess (enregistrée) et style chess.com (recalculée) ; méthode réglée et bilan chess.com.
  assert.equal(v.method, 'lichess');
  assert.deepEqual(v.methodLabels, { lichess: 'Lichess', chesscom: 'Style chess.com' });
  for (const side of [v.white, v.black]) assert.ok(side.accuracyChesscom > 0 && side.accuracyChesscom <= 100, String(side.accuracyChesscom));
  assert.ok(v.black.accuracyChesscom < v.white.accuracyChesscom, 'la gaffe des Noirs pèse aussi dans le style chess.com');
  assert.equal(v.chesscomReview, null);
});

test('mode libre : coup joué depuis une position, classé avec les mêmes règles', async () => {
  const fen = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3';
  const bad = await liveMove(ev, { fen, uci: 'g8f6', prev: null, bookBefore: false, elo: 1100 });
  assert.equal(bad.classification, 'blunder');
  assert.ok(['g6', 'Qe7', 'Qf6'].includes(bad.bestSan), `défense du point f7 attendue, pas ${bad.bestSan}`); // plusieurs défenses équivalentes
  assert.match(bad.explanation.sentences.join(' '), /mater en 1/);
  const good = await liveMove(ev, { fen, uci: 'g7g6', prev: null, bookBefore: false, elo: 1100 });
  assert.ok(['best', 'great', 'excellent'].includes(good.classification), good.classification);
  assert.ok(good.winWhiteAfter < 60);
  await assert.rejects(liveMove(ev, { fen, uci: 'e1e2' }), /Coup illégal/);
});

test("file d'analyse : par défaut, seulement les parties demandées", () => {
  const q = new AnalysisQueue(null);
  const pendingIds = () => getDb().prepare("SELECT DISTINCT game_id FROM analysis_queue WHERE status = 'pending'").all().map((r) => r.game_id);
  const other = pendingIds().find((x) => x !== gameId);
  assert.ok(other, 'une partie non analysée');
  assert.equal(q.mode, 'manual');
  getDb().exec('UPDATE analysis_queue SET priority = 0');
  assert.equal(q.nextItem(), undefined, 'rien sans demande');
  q.prioritize(other);
  assert.deepEqual({ ...q.nextItem() }.game_id, other);
  assert.equal(q.nextItem().pass, 'quick');
  assert.equal(q.progress().requested.waiting, 1);
  q.unrequest(other);
  assert.equal(q.nextItem(), undefined);
  assert.equal(listMyGames({}).games.find((x) => x.id === other).requested, false);
  q.setMode('quick');
  assert.equal(q.nextItem().pass, 'quick');
  getDb().exec("UPDATE analysis_queue SET status = 'done' WHERE pass = 'quick'");
  assert.equal(q.nextItem(), undefined, 'la passe profonde reste à la demande');
  q.setMode('auto');
  assert.equal(q.nextItem().pass, 'deep');
  assert.throws(() => q.setMode('nimporte'), /Mode inconnu/);
  q.setMode('manual');
  // Une partie demandée passe devant l'analyse en cours d'une autre partie.
  q.current = { gameId: other, pass: 'deep' };
  q.ctrl = new AbortController();
  q.prioritize(gameId);
  assert.equal(q.ctrl.signal.aborted, true);
  q.current = null; q.ctrl = null;
});

test('base existante : les colonnes d\'ouverture sont ajoutées sans perte', () => {
  const cols = getDb().prepare('PRAGMA table_info(games)').all().map((c) => c.name);
  for (const c of ['book_name', 'book_eco', 'book_exit_ply', 'book_done']) assert.ok(cols.includes(c), c);
});
