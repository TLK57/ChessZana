// Vitesse de l'analyse : threads selon la passe, coup joué évalué par la position suivante (sans « searchmoves »),
// pas de requête aux tables de finales pendant la passe rapide.
import './_unit.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { Chess } from 'chess.js';
import { config, overrideConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { Evaluator } from '../src/engine/evaluator.js';
import { PASSES, analyzeGame, analyzeMoveList, playedFromNext } from '../src/analysis/analyze.js';
import { importPgnText } from '../src/importers/pgnfile.js';
import { moveToUci, START_FEN } from '../src/chessutil.js';

openDb();

const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;

// Faux évaluateur : une ligne par position (e7e5 / e2e4 en tête), enregistre tous les appels.
function scriptedEvaluator() {
  const calls = [];
  const recorded = [];
  const threads = [];
  const line = (move, cp, pv = [move], depth = 12) => ({ move, cp, mate: null, pv, depth });
  return {
    calls, recorded, threads,
    async setThreads(n) { threads.push(n); },
    async evaluatePosition(fen, opts = {}) {
      calls.push({ kind: 'position', fen, ...opts });
      const black = fen.split(' ')[1] === 'b';
      const lines = black ? [line('e7e5', 10, ['e7e5', 'g1f3']), line('d7d5', 5)] : [line('e2e4', 30), line('d2d4', 25)];
      return { source: 'stockfish', depth: 12, lines };
    },
    async evaluateMove(fen, uci, opts = {}) {
      calls.push({ kind: 'move', fen, uci, ...opts });
      return { ...line(uci, -50), source: 'stockfish', depth: 12 };
    },
    recordMove(fen, uci, l, opts) { recorded.push({ fen, uci, line: l, ...opts }); },
  };
}

function game(sans) {
  const c = new Chess();
  const moves = sans.map((san, i) => {
    const fenBefore = c.fen();
    const m = c.move(san);
    return { ply: i + 1, color: m.color, san: m.san, uci: moveToUci(m), fenBefore };
  });
  return { moves, finalFen: c.fen() };
}

const opts = (evaluator, finalFen) => ({ evaluator, depth: 12, allowCloud: false, standardStart: false, finalFen, whiteElo: 1500, blackElo: 1500 });

test('coup hors des lignes MultiPV : évalué par la position suivante, sans recherche « searchmoves »', async () => {
  const ev = scriptedEvaluator();
  const { moves, finalFen } = game(['a4', 'e5']); // 1. a4 n'est pas dans les 2 lignes ; 1… e5 est la meilleure
  const r = await analyzeMoveList(moves, opts(ev, finalFen));
  assert.equal(ev.calls.filter((c) => c.kind === 'move').length, 0, 'aucune recherche searchmoves');
  // Après 1. a4, les Noirs ont +10 : pour les Blancs, le coup vaut −10.
  assert.deepEqual(r.moves[0].evalPlayed, { cp: -10, mate: null, wdl: null });
  // La suite du coup joué (pour les explications) est enregistrée : le coup puis la meilleure suite adverse.
  assert.equal(ev.recorded.length, 1);
  assert.equal(ev.recorded[0].uci, 'a2a4');
  assert.equal(ev.recorded[0].fen, START_FEN);
  assert.deepEqual(ev.recorded[0].line.pv, ['a2a4', 'e7e5', 'g1f3']);
  assert.equal(ev.recorded[0].source, 'stockfish');
});

test('évaluation déduite enregistrée en cache : relue sans moteur, jamais à la place d\'une plus profonde', async () => {
  const ev = new Evaluator(); // aucun moteur démarré : tout doit venir du cache
  const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  ev.recordMove(fen, 'h2h3', { move: 'h2h3', cp: -15, mate: null, pv: ['h2h3', 'e7e5'], depth: 12 });
  ev.recordMove(fen, 'h2h3', { move: 'h2h3', cp: 99, mate: null, pv: ['h2h3'], depth: 8 }); // moins profonde : ignorée
  const r = await ev.evaluateMove(fen, 'h2h3', { depth: 12 });
  assert.equal(r.cached, true);
  assert.equal(r.cp, -15);
  assert.deepEqual(r.pv, ['h2h3', 'e7e5'], 'suite du coup joué pour les explications');
  assert.equal(ev.stats.stockfish, 0);
});

test('dernier coup de la partie hors des lignes : toujours évalué avec « searchmoves »', async () => {
  const ev = scriptedEvaluator();
  const { moves, finalFen } = game(['a4', 'h5']); // 1… h5 : dernier coup, pas dans les lignes
  await analyzeMoveList(moves, opts(ev, finalFen));
  const searched = ev.calls.filter((c) => c.kind === 'move').map((c) => c.uci);
  assert.deepEqual(searched, ['h7h5'], 'seul le dernier coup demande une recherche');
});

test('position suivante : mat et table de finales retournés pour le joueur qui a joué', () => {
  const mate = playedFromNext('d1h5', { before: { source: 'stockfish', depth: 20, lines: [{ move: 'f7f6', cp: null, mate: 3, pv: ['f7f6'] }] } });
  assert.equal(mate.mate, -3, 'l\'adversaire mate en 3 : mat contre moi');
  assert.equal(mate.depth, 20);
  const tb = playedFromNext('b2b7', { before: { source: 'tablebase', depth: 99, lines: [{ move: 'f7e6', wdl: 'loss', pv: ['f7e6'] }] } });
  assert.equal(tb.wdl, 'win', 'perdant pour l\'adversaire : gagnant pour moi');
  assert.equal(playedFromNext('a2a4', undefined), null, 'pas de position suivante');
  assert.equal(playedFromNext('a2a4', { before: { lines: [] } }), null, 'position suivante sans ligne');
});

test('threads : 2 par défaut pour la passe rapide et le mode libre, tous les cœurs pour la passe profonde', (t) => {
  t.after(() => overrideConfig({ engine: { quickThreads: 'auto', threads: 'auto' } }));
  overrideConfig({ engine: { quickThreads: 'auto', threads: 'auto' } });
  assert.equal(config.engine.quickThreadsResolved, Math.min(2, cores));
  assert.equal(PASSES.quick().threads, config.engine.quickThreadsResolved);
  assert.equal(PASSES.deep().threads, config.engine.threadsResolved);
  overrideConfig({ engine: { quickThreads: 1000 } });
  assert.equal(config.engine.quickThreadsResolved, cores, 'jamais plus que le nombre de cœurs');
  overrideConfig({ engine: { quickThreads: 0 } });
  assert.equal(config.engine.quickThreadsResolved, 1);
});

test('tables de finales : pas pendant la passe rapide (sauf réglage), toujours pendant la passe profonde', (t) => {
  t.after(() => overrideConfig({ lichess: { tablebaseInQuickPass: false } }));
  assert.equal(PASSES.quick().allowTablebase, false);
  assert.equal(PASSES.deep().allowTablebase, true);
  overrideConfig({ lichess: { tablebaseInQuickPass: true } });
  assert.equal(PASSES.quick().allowTablebase, true);
});

test('analyse d\'une partie : threads réglés une fois par passe, tables de finales coupées en passe rapide', async () => {
  const imp = await importPgnText('[Event "Vitesse"]\n[White "A"]\n[Black "B"]\n[Result "0-1"]\n\n1. a4 e5 2. h4 Nc6 0-1');
  const id = imp.ids[0];
  assert.ok(id, 'partie importée');
  const quick = scriptedEvaluator();
  await analyzeGame(id, 'quick', { evaluator: quick });
  assert.deepEqual(quick.threads, [config.engine.quickThreadsResolved]);
  const positions = quick.calls.filter((c) => c.kind === 'position');
  assert.ok(positions.length > 0);
  assert.ok(positions.every((c) => c.allowTablebase === false), 'aucune requête aux tables en passe rapide');
  const deep = scriptedEvaluator();
  await analyzeGame(id, 'deep', { evaluator: deep });
  assert.deepEqual(deep.threads, [config.engine.threadsResolved]);
  assert.ok(deep.calls.filter((c) => c.kind === 'position' && c.engineFallback !== false).every((c) => c.allowTablebase !== false));
});
