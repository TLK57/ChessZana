// Tests avec le vrai moteur Stockfish (téléchargé automatiquement s'il manque) sur des positions connues.
import './_setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { overrideConfig, config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { Evaluator } from '../src/engine/evaluator.js';
import { analyzeMoveList, analyzeGame } from '../src/analysis/analyze.js';
import { importPgnText } from '../src/importers/pgnfile.js';
import { moveToUci, START_FEN } from '../src/chessutil.js';
import { resetLichessState, lichessStatus } from '../src/engine/lichess.js';

const DEPTH = 16;
openDb();
overrideConfig({ lichess: { cloudEval: false, tablebase: false } });
const ev = new Evaluator();

test.before(async () => { await ev.init(); });
test.after(async () => { await ev.close(); });

function buildMoves(startFen, sans) {
  const c = new Chess(startFen);
  return sans.map((san, i) => {
    const fenBefore = c.fen();
    const m = c.move(san);
    return { ply: i + 1, color: m.color, san: m.san, uci: moveToUci(m), fenBefore, finalFen: c.fen() };
  });
}

async function analyse(startFen, sans, extra = {}) {
  const moves = buildMoves(startFen, sans);
  return analyzeMoveList(moves, {
    evaluator: ev, depth: DEPTH, allowCloud: false, standardStart: startFen === START_FEN,
    finalFen: moves[moves.length - 1].finalFen, whiteElo: 1800, blackElo: 1800, ...extra,
  });
}

// Les Blancs matent en 2 : 1. Dd8+ Txd8 2. Txd8#. Tout autre coup laisse une position égale.
const MATE_IN_2 = '2r3k1/5ppp/8/8/3Q4/8/q4PPP/3R2K1 w - - 0 1';

test('mat en 2 trouvé : coup noté meilleur (ou très bon / brillant), perte nulle', async () => {
  const r = await analyse(MATE_IN_2, ['Qd8+']);
  const m = r.moves[0];
  assert.equal(m.evalBest.mate, 2);
  assert.ok(['best', 'great', 'brilliant'].includes(m.classification), m.classification);
  assert.ok(m.loss < 1);
  assert.equal(m.winBest, 100);
});

test('mat en 2 raté : gaffe', async () => {
  const r = await analyse(MATE_IN_2, ['h3']);
  const m = r.moves[0];
  assert.equal(m.classification, 'blunder');
  assert.ok(m.loss >= 22, `perte ${m.loss}`);
  assert.equal(m.bestSan, 'Qd8+');
});

test('dame laissée en prise : gaffe (1. e4 d5 2. Dg4??)', async () => {
  const r = await analyse(START_FEN, ['e4', 'd5', 'Qg4']);
  const m = r.moves[2];
  assert.equal(m.classification, 'blunder');
  assert.ok(m.winPlayed < 10, `chances après la gaffe ${m.winPlayed}`);
});

test('coups de théorie : 1. e4 e5 2. Cf3 Cc6 3. Fb5 (partie espagnole)', async () => {
  const r = await analyse(START_FEN, ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']);
  assert.deepEqual(r.moves.map((m) => m.classification), ['book', 'book', 'book', 'book', 'book']);
});

test('finale à 6 pièces : évaluation venant de la table de finales Lichess', async (t) => {
  overrideConfig({ lichess: { tablebase: true } });
  resetLichessState();
  t.after(() => overrideConfig({ lichess: { tablebase: false } }));
  const fen = '8/5k2/8/3K4/3P4/2P5/1R4r1/8 w - - 0 1'; // R+2P contre T, 6 pièces
  const r = await analyse(fen, ['Rxg2']);
  if (r.moves[0].source !== 'tablebase' && lichessStatus().tablebase.lastError) {
    t.skip(`tablebase.lichess.ovh injoignable : ${lichessStatus().tablebase.lastError}`);
    return;
  }
  assert.equal(r.moves[0].source, 'tablebase');
  assert.equal(r.moves[0].evalBest.wdl, 'win');
  assert.ok(['best', 'great'].includes(r.moves[0].classification));
});

test('Lichess injoignable : repli sur Stockfish sans planter', async (t) => {
  overrideConfig({ lichess: { tablebase: true, cloudEval: true, timeoutMs: 1 } });
  resetLichessState();
  t.after(() => { overrideConfig({ lichess: { tablebase: false, cloudEval: false, timeoutMs: 6000 } }); resetLichessState(); });
  const fen = '8/4k3/8/3K4/3P4/2P5/1R6/6r1 w - - 0 1';
  const r = await analyse(fen, ['Rb7+'], { allowCloud: true });
  assert.equal(r.moves[0].source, 'stockfish');
  assert.ok(lichessStatus().tablebase.paused);
});

test('partie de plus de 150 coups analysée entièrement', async () => {
  // Partie aléatoire mais reproductible de 320 demi-coups (160 coups), sans mat ni pat.
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const c = new Chess();
  const sans = [];
  while (sans.length < 320) {
    const legal = c.moves();
    const safe = legal.filter((san) => { c.move(san); const end = c.isCheckmate() || c.isStalemate(); c.undo(); return !end; });
    if (!safe.length) break;
    const san = safe[Math.floor(rand() * safe.length)];
    c.move(san);
    sans.push(san);
  }
  assert.ok(sans.length > 300, `seulement ${sans.length} demi-coups générés`);
  const moves = buildMoves(START_FEN, sans);
  const r = await analyzeMoveList(moves, { evaluator: ev, depth: 6, allowCloud: false, finalFen: moves.at(-1).finalFen });
  assert.equal(r.moves.length, sans.length);
  assert.equal(r.series.length, sans.length + 1);
  for (const m of r.moves) {
    assert.ok(Number.isFinite(m.loss) && m.accuracy >= 0 && m.accuracy <= 100, `coup ${m.ply}`);
    assert.ok(m.classification);
  }
  assert.ok(r.accuracyWhite >= 0 && r.accuracyWhite <= 100);
  assert.ok(r.accuracyBlack >= 0 && r.accuracyBlack <= 100);
});

test('partie abandonnée au 3e coup : analysée et enregistrée', async () => {
  const pgn = `[Event "Test"]\n[White "Pressé"]\n[Black "Patient"]\n[Result "0-1"]\n[WhiteElo "1500"]\n[BlackElo "1500"]\n[Termination "Patient a gagné par abandon"]\n\n1. f3 e5 2. g4 Nc6 3. h3 0-1`;
  const imp = await importPgnText(pgn);
  assert.equal(imp.added, 1);
  overrideConfig({ engine: { quickDepth: DEPTH } });
  const r = await analyzeGame(imp.ids[0], 'quick', { evaluator: ev });
  assert.equal(r.moves.length, 5);
  assert.ok(r.accuracyWhite != null && r.accuracyBlack != null);
  assert.equal(r.eloWhite, null); // trop peu de coups pour estimer un Elo
});

test('cache par FEN : une position déjà évaluée n\'est jamais recalculée', async () => {
  const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
  await ev.evaluatePosition(fen, { depth: DEPTH });
  const before = ev.stats.stockfish;
  // Même position, compteurs de coups différents : même FEN normalisée.
  const again = await ev.evaluatePosition(fen.replace('2 3', '6 9'), { depth: DEPTH });
  assert.equal(again.cached, true);
  const shallower = await ev.evaluatePosition(fen, { depth: 10 });
  assert.equal(shallower.cached, true);
  assert.equal(ev.stats.stockfish, before, 'aucune nouvelle recherche Stockfish');
  const deeper = await ev.evaluatePosition(fen, { depth: DEPTH + 1 });
  assert.equal(deeper.cached, false, 'une profondeur supérieure relance le calcul');
});

test('passe profonde optimisée : budget de nœuds, cache par nœuds, positions déjà jouées non recalculées', async () => {
  // Les Blancs ont une dame de plus : la partie est jouée, l'analyse rapide suffit pour ces coups.
  const fen = '4k3/8/8/8/8/8/3QK3/8 w - - 0 1';
  const moves = buildMoves(fen, ['Qd4', 'Ke7', 'Qe4+']);
  const opts = { evaluator: ev, depth: 22, nodes: 50000, allowCloud: false, standardStart: false, finalFen: moves.at(-1).finalFen };
  const light = await analyzeMoveList(moves, { ...opts, skipDecided: true });
  assert.equal(light.lightPositions, 3, 'positions gagnées d\'avance gardées de la passe rapide');
  // Sans ce raccourci : recherches à budget de nœuds, puis réutilisées depuis le cache.
  const start = ev.stats.stockfish;
  const full = await analyzeMoveList(moves, { ...opts, skipDecided: false });
  assert.equal(full.lightPositions, 0);
  assert.ok(ev.stats.stockfish > start, 'recherches Stockfish au budget de nœuds');
  const again = ev.stats.stockfish;
  await analyzeMoveList(moves, { ...opts, skipDecided: false });
  assert.equal(ev.stats.stockfish, again, 'deuxième passage entièrement depuis le cache');
  assert.equal(full.moves.length, 3);
});

test('coup hors des 2 lignes MultiPV : évalué à la même profondeur avec searchmoves', async () => {
  const r = await analyse(START_FEN, ['a4'], { standardStart: false });
  const m = r.moves[0];
  assert.notEqual(m.bestUci, 'a2a4');
  assert.ok(m.evalPlayed && (m.evalPlayed.cp != null || m.evalPlayed.mate != null));
  assert.ok(config.engine.multiPV >= 2);
});
