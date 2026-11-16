import './_setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, getDb } from '../src/db.js';
import { syncChessCom, isArchiveComplete } from '../src/importers/chesscom.js';
import { syncLichess } from '../src/importers/lichess.js';

// Ces tests simulent les API (aucun appel réseau réel).
openDb();
const realFetch = globalThis.fetch;
const json = (obj, headers = {}) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
const pgn = (white, black, result, moves) => `[White "${white}"]\n[Black "${black}"]\n[Result "${result}"]\n[TimeControl "300"]\n\n${moves} ${result}`;

test("chess.com : un mois est clos s'il a été téléchargé au moins un jour après sa fin", () => {
  assert.equal(isArchiveComplete(2024, 1, Date.UTC(2024, 1, 2, 1)), true);
  assert.equal(isArchiveComplete(2024, 1, Date.UTC(2024, 1, 1, 12)), false);
  assert.equal(isArchiveComplete(2024, 12, Date.UTC(2025, 0, 3)), true);
});

test('chess.com : parties terminées seulement, User-Agent, retry sur 429, synchro incrémentale', async (t) => {
  const now = new Date();
  const cur = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const OLD = 'https://api.chess.com/pub/player/testeur/games/2020/01';
  const CUR = `https://api.chess.com/pub/player/testeur/games/${cur}`;
  const calls = [];
  let limited = false;
  let inFlight = 0, maxInFlight = 0;
  const game = (id, end, extra = {}) => ({
    uuid: id, url: `https://www.chess.com/game/live/${id}`, end_time: end, rules: 'chess', time_class: 'blitz', time_control: '300', rated: true,
    white: { username: 'Testeur', rating: 1500 }, black: { username: 'Autre', rating: 1490 },
    pgn: pgn('Testeur', 'Autre', '1-0', '1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7#'), ...extra,
  });
  globalThis.fetch = async (url, opts) => {
    url = String(url);
    calls.push({ url, headers: opts?.headers ?? {} });
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    if (url.endsWith('/player/testeur')) return json({ username: 'Testeur' });
    if (url.endsWith('/games/archives')) return json({ archives: [OLD, CUR] });
    if (url === OLD) {
      if (!limited) { limited = true; return new Response('', { status: 429, headers: { 'retry-after': '0' } }); }
      return json({ games: [game('a1', 1580000000), game('a2', 1580000100, { rules: 'chess960' })] });
    }
    if (url === CUR) {
      if (opts?.headers?.['If-None-Match'] === '"v1"') return new Response(null, { status: 304 });
      const unfinished = game('a4', Math.floor(Date.now() / 1000), { pgn: pgn('Testeur', 'Autre', '*', '1. d4 d5 2. c4') });
      return json({ games: [game('a3', Math.floor(Date.now() / 1000)), unfinished] }, { etag: '"v1"' });
    }
    return new Response('', { status: 404 });
  };
  t.after(() => { globalThis.fetch = realFetch; });

  const s1 = await syncChessCom('Testeur');
  assert.equal(s1.added, 2); // a1 et a3
  assert.equal(s1.skipped, 2); // Chess960 + partie non terminée
  assert.equal(calls.filter((c) => c.url === OLD).length, 2, '429 puis nouvelle tentative');
  assert.equal(maxInFlight, 1, 'jamais deux requêtes en parallèle');
  assert.match(calls[0].headers['User-Agent'], /ChessZana/);
  const games = getDb().prepare("SELECT source_id FROM games WHERE source = 'chesscom' ORDER BY source_id").all().map((g) => g.source_id);
  assert.deepEqual(games, ['a1', 'a3']);
  const link = getDb().prepare("SELECT color, outcome FROM player_games pg JOIN games g ON g.id = pg.game_id WHERE g.source_id = 'a1'").get();
  assert.deepEqual({ ...link }, { color: 'white', outcome: 'win' });

  calls.length = 0;
  const s2 = await syncChessCom('testeur');
  assert.equal(s2.added, 0);
  assert.equal(calls.filter((c) => c.url === OLD).length, 0, 'un mois clos ne doit pas être retéléchargé');
  assert.equal(calls.filter((c) => c.url === CUR).length, 1, 'le mois en cours doit être revérifié');
});

test('Lichess : flux NDJSON, parties standard terminées, curseur incrémental', async (t) => {
  const urls = [];
  const lg = (id, created, variant = 'standard') => JSON.stringify({
    id, variant, speed: 'blitz', rated: true, createdAt: created, lastMoveAt: created + 600000, status: 'mate',
    players: { white: { user: { name: 'LiTest', id: 'litest' }, rating: 1700 }, black: { user: { name: 'Bob', id: 'bob' }, rating: 1650 } },
    clock: { initial: 180, increment: 2 },
    pgn: '[White "LiTest"]\n[Black "Bob"]\n[Result "1-0"]\n\n1. e4 {[%clk 0:03:00]} e5 {[%clk 0:03:00]} 2. Qh5 {[%clk 0:02:59]} Nc6 {[%clk 0:02:58]} 3. Bc4 {[%clk 0:02:58]} Nf6 {[%clk 0:02:55]} 4. Qxf7# {[%clk 0:02:57]} 1-0',
  });
  globalThis.fetch = async (url) => {
    url = String(url); urls.push(url);
    if (url.endsWith('/api/user/litest')) return json({ username: 'LiTest', count: { all: 2 } });
    if (url.includes('/api/games/user/litest')) return new Response(`${lg('abcdefgh', 1700000000000)}\n${lg('zzzzzzzz', 1700000500000, 'chess960')}\n`, { status: 200 });
    return new Response('', { status: 404 });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const s = await syncLichess('LiTest');
  assert.equal(s.added, 1); assert.equal(s.skipped, 1);
  const exp = urls.find((u) => u.includes('/api/games/user/'));
  assert.match(exp, /clocks=true/); assert.match(exp, /finished=true/); assert.match(exp, /ongoing=false/);
  const g = getDb().prepare("SELECT * FROM games WHERE source = 'lichess'").get();
  assert.equal(g.time_control, '180+2');
  assert.equal(getDb().prepare('SELECT clock_ms FROM game_moves WHERE game_id = ? AND ply = 7').get(g.id).clock_ms, 177000);
  urls.length = 0;
  await syncLichess('litest');
  assert.match(urls.find((u) => u.includes('/api/games/user/')), /since=\d+/);
});
