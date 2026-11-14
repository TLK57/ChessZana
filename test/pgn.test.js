import './_setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGame, splitPgn, parseClock } from '../src/pgn.js';
import { importPgnText } from '../src/importers/pgnfile.js';
import { openDb, getDb } from '../src/db.js';

const CHESSCOM_PGN = `[Event "Live Chess"]
[Site "Chess.com"]
[Date "2024.05.01"]
[White "Alice"]
[Black "Bob"]
[Result "0-1"]
[WhiteElo "1250"]
[BlackElo "1302"]
[TimeControl "180+2"]
[Termination "Bob won by resignation"]

1. e4 {[%clk 0:03:01.1]} 1... e5 {[%clk 0:03:00.4]} 2. Qh5 {[%clk 0:02:59.2]} 2... Nc6 {[%clk 0:02:58.8]} 3. Bc4 {[%clk 0:02:55]} 0-1`;

test('PGN : coups, pendules %clk et temps passé par coup', () => {
  const g = parseGame(CHESSCOM_PGN);
  assert.equal(g.error, null);
  assert.equal(g.result, '0-1');
  assert.deepEqual(g.moves.map((m) => m.san), ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4']);
  assert.equal(g.moves[0].clockMs, 181100);
  assert.equal(g.moves[4].clockMs, 175000);
  // 2e coup des Blancs : 3:01.1 - 2:59.2 + 2 s d'incrément = 3,9 s
  assert.equal(g.moves[2].timeSpentMs, 3900);
  assert.equal(parseClock('[%clk 1:02:03.5]'), 3723500);
});

test('PGN : variantes, NAG, annotations et roque 0-0 ignorés/convertis', () => {
  const g = parseGame('[Result "1-0"]\n1. e4 $1 e5 (1... c5 2. Nf3) 2. Nf3!? {bon} Nc6 3. Bc4 Bc5 4. 0-0 Nf6?! 1-0');
  assert.equal(g.error, null);
  assert.deepEqual(g.moves.map((m) => m.san), ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O', 'Nf6']);
  assert.equal(g.moves[6].uci, 'e1g1');
});

test('PGN : découpage de plusieurs parties', () => {
  const two = `${CHESSCOM_PGN}\n\n[White "X"]\n[Black "Y"]\n[Result "1/2-1/2"]\n\n1. d4 d5 1/2-1/2\n`;
  const parts = splitPgn(two);
  assert.equal(parts.length, 2);
  assert.equal(parseGame(parts[1]).moves.length, 2);
});

test('Import PGN : partie en cours refusée, doublons ignorés, données enregistrées', async () => {
  openDb();
  const r1 = await importPgnText(CHESSCOM_PGN);
  assert.equal(r1.added, 1);
  const r2 = await importPgnText(CHESSCOM_PGN);
  assert.equal(r2.added, 0); assert.equal(r2.duplicate, 1);
  const ongoing = await importPgnText('[White "A"]\n[Black "B"]\n[Result "*"]\n\n1. e4 e5 2. Nf3 *');
  assert.equal(ongoing.added, 0); assert.equal(ongoing.unfinished, 1);
  const g = getDb().prepare('SELECT * FROM games').get();
  assert.equal(g.white_elo, 1250); assert.equal(g.result, '0-1'); assert.equal(g.time_control, '180+2'); assert.equal(g.ply_count, 5);
  const moves = getDb().prepare('SELECT * FROM game_moves WHERE game_id = ? ORDER BY ply').all(g.id);
  assert.equal(moves.length, 5); assert.equal(moves[0].clock_ms, 181100);
  const q = getDb().prepare('SELECT pass, status FROM analysis_queue WHERE game_id = ? ORDER BY pass').all(g.id);
  assert.deepEqual(q.map((x) => `${x.pass}:${x.status}`), ['deep:pending', 'quick:pending']);
});
