// Analyse complète d'une partie : évaluation de chaque position, classement des coups, précision, Elo estimé.
import { Chess } from 'chess.js';
import { config } from '../config.js';
import { getDb, transaction } from '../db.js';
import { getGame, getGameMoves } from '../games.js';
import { normalizeChessFen, terminalState, uciToSan, START_FEN } from '../chessutil.js';
import { AbortError } from '../engine/stockfish.js';
import { isBookPosition } from './openings.js';
import { classifyMove } from './classify.js';
import { estimateElo, gameAccuracy, moveAccuracy, winPct } from './formulas.js';

export const PASSES = {
  quick: () => ({ depth: config.engine.quickDepth, nodes: null, allowCloud: config.lichess.cloudEvalInQuickPass, skipDecided: false }),
  // Passe profonde : budget de nœuds par position (comme Lichess). Une évaluation en cache à la profondeur
  // deepDepth (ou plus) reste acceptée, ainsi que l'analyse cloud de Lichess à cette profondeur.
  deep: () => ({
    depth: config.engine.deepDepth,
    nodes: config.engine.deepNodes > 0 ? config.engine.deepNodes : null,
    criticalNodes: config.engine.deepNodes > 0 ? config.engine.deepNodesCritical : null,
    allowCloud: true,
    skipDecided: config.engine.deepSkipDecided < 100,
  }),
};

const scoreOf = (l) => (l ? { cp: l.cp ?? null, mate: l.mate ?? null, wdl: l.wdl ?? null } : null);

/**
 * Analyse une suite de coups.
 * moves : [{ ply, color, san, uci, fenBefore }]
 * opts  : { depth, allowCloud, whiteElo, blackElo, standardStart, finalFen, evaluator, signal, onProgress }
 */
export async function analyzeMoveList(moves, opts) {
  const { evaluator, depth, signal } = opts;
  const nodes = opts.nodes ?? null;
  const search = { depth, nodes, signal };
  const n = moves.length;
  const evals = new Array(n);
  let done = 0;
  const progress = () => opts.onProgress?.(++done, n);

  // 1) Théorie : tant que chaque position atteinte figure dans la base d'ouvertures.
  const book = new Array(n).fill(false);
  if (opts.standardStart !== false) {
    for (let i = 0; i < n; i++) {
      const c = new Chess(moves[i].fenBefore);
      c.move({ from: moves[i].uci.slice(0, 2), to: moves[i].uci.slice(2, 4), promotion: moves[i].uci[4] });
      if (isBookPosition(normalizeChessFen(c))) book[i] = true;
      else break;
    }
  }

  // 2a) Ouverture : analyse cloud de Lichess (positions connues), dans l'ordre de la partie,
  //     jusqu'à deux positions inconnues de suite.
  if (opts.allowCloud) {
    let misses = 0;
    for (let i = 0; i < n && moves[i].ply <= config.lichess.cloudEvalMaxPly && misses < 2; i++) {
      if (signal?.aborted) throw new AbortError();
      const r = await evaluator.evaluatePosition(moves[i].fenBefore, { ...search, allowCloud: true, engineFallback: false });
      if (!r.missing) { evals[i] = { before: r }; misses = 0; }
      else if (r.cloudMiss) misses++;
      else break; // Lichess indisponible : Stockfish prend le relais
    }
  }

  // 2b) Toutes les positions, de la fin vers le début (comme Lichess) : la mémoire du moteur garde les
  //     positions suivantes déjà calculées, ce qui accélère la recherche des positions précédentes.
  const quickDepth = config.engine.quickDepth;
  const skip = config.engine.deepSkipDecided;
  let criticalCount = 0;
  for (let i = n - 1; i >= 0; i--) {
    if (signal?.aborted) throw new AbortError();
    const m = moves[i];
    let before = evals[i]?.before ?? null;
    if (!before && opts.skipDecided) {
      // Théorie ou partie déjà jouée (≥ 97 % ou ≤ 3 % avant ET après le coup) : l'analyse rapide suffit,
      // le classement ne peut pas changer.
      const q = await evaluator.evaluatePosition(m.fenBefore, { depth: quickDepth, signal });
      const qp = q.lines.find((l) => l.move === m.uci) ?? await evaluator.evaluateMove(m.fenBefore, m.uci, { depth: quickDepth, signal });
      const wb = winPct(scoreOf(q.lines[0]));
      const wp = winPct(scoreOf(qp));
      const decided = (wb >= skip && wp >= skip) || (wb <= 100 - skip && wp <= 100 - skip);
      if (book[i] || decided) { evals[i] = { before: q, played: qp, light: true }; progress(); continue; }
    }
    if (!before) before = await evaluator.evaluatePosition(m.fenBefore, { ...search, allowCloud: false });
    let played = before.lines.find((l) => l.move === m.uci);
    if (!played) played = await evaluator.evaluateMove(m.fenBefore, m.uci, search);
    // Approfondissement ciblé : un coup qui n'est pas clairement bon (perte ≥ 2 %), ou un meilleur coup
    // presque « seul coup qui tient », est recalculé avec un budget plus gros avant d'être classé.
    if (opts.criticalNodes && before.source === 'stockfish' && opts.criticalNodes > (nodes ?? 0)) {
      const wb = winPct(scoreOf(before.lines[0]));
      const wp = winPct(scoreOf(played));
      const ws = before.lines[1] ? winPct(scoreOf(before.lines[1])) : null;
      const critical = wb - wp >= 2 || (before.lines[0]?.move === m.uci && ws != null && wb - ws > 5);
      if (critical) {
        const deeper = { ...search, nodes: opts.criticalNodes };
        before = await evaluator.evaluatePosition(m.fenBefore, { ...deeper, allowCloud: false });
        played = before.lines.find((l) => l.move === m.uci) ?? await evaluator.evaluateMove(m.fenBefore, m.uci, deeper);
        criticalCount++;
      }
    }
    evals[i] = { before, played };
    progress();
  }

  // 3) Position finale (pour la courbe des chances de gain).
  let finalWhite = 50;
  if (n > 0) {
    const fc = new Chess(opts.finalFen);
    const term = terminalState(fc);
    if (term === 'checkmate') finalWhite = fc.turn() === 'w' ? 0 : 100;
    else if (term) finalWhite = 50;
    else {
      const fe = await evaluator.evaluatePosition(opts.finalFen, { ...search, allowCloud: false });
      const w = winPct(scoreOf(fe.lines[0]));
      finalWhite = fc.turn() === 'w' ? w : 100 - w;
    }
  }

  // 4) Chances de gain, perte, classement.
  const results = [];
  for (let i = 0; i < n; i++) {
    const m = moves[i];
    const { before, played } = evals[i];
    const best = before.lines[0];
    const second = before.lines[1] ?? null;
    const winBest = winPct(scoreOf(best));
    const winPlayed = winPct(scoreOf(played));
    const winSecond = second ? winPct(scoreOf(second)) : null;
    const playedIsBest = best?.move === m.uci;
    const altLine = playedIsBest ? second : best;
    const c = new Chess(m.fenBefore);
    const prevMove = i > 0 ? moves[i - 1] : null;
    const isRecapture = !!prevMove && /x/.test(prevMove.san) && /x/.test(m.san) && prevMove.uci.slice(2, 4) === m.uci.slice(2, 4);
    const prev = i > 0 && results[i - 1] ? { classification: results[i - 1].classification, winBest: results[i - 1].winBest } : null;
    const { classification, loss } = classifyMove({
      book: book[i],
      legalMoves: c.moves().length,
      inCheck: c.inCheck(),
      playedIsBest,
      winBest, winPlayed, winSecond,
      elo: m.color === 'w' ? opts.whiteElo : opts.blackElo,
      fenBefore: m.fenBefore,
      playedPv: played?.pv?.length ? played.pv : [m.uci],
      altPv: altLine?.pv ?? null,
      isRecapture,
      prev,
    });
    results.push({
      ply: m.ply, color: m.color, san: m.san, uci: m.uci,
      bestUci: best?.move ?? null,
      bestSan: best?.move ? (best.san ?? uciToSan(m.fenBefore, best.move)) : null,
      evalBest: scoreOf(best), evalPlayed: scoreOf(played),
      winBest, winPlayed, winSecond, loss,
      accuracy: moveAccuracy(loss),
      classification,
      source: before.source,
      depth: before.depth,
    });
  }

  // 5) Série des chances de gain des Blancs P0…Pn, précision de la partie et Elo estimé.
  const series = results.map((r) => (r.color === 'w' ? r.winBest : 100 - r.winBest));
  series.push(finalWhite);
  results.forEach((r, i) => { r.winWhiteAfter = series[i + 1]; });
  const acc = gameAccuracy(series, results.map((r) => ({ color: r.color, accuracy: r.accuracy })));
  const counts = { w: {}, b: {} };
  for (const r of results) counts[r.color][r.classification] = (counts[r.color][r.classification] ?? 0) + 1;
  const nonBook = (color) => results.filter((r) => r.color === color && r.classification !== 'book').length;
  // Profondeur typique atteinte par Stockfish (médiane), pour l'affichage.
  const depths = evals.filter((x) => !x.light && x.before.source === 'stockfish').map((x) => x.before.depth).sort((a, b) => a - b);
  return {
    depthUsed: depths.length ? depths[Math.floor(depths.length / 2)] : depth,
    lightPositions: evals.filter((x) => x.light).length,
    criticalPositions: criticalCount,
    moves: results,
    series,
    accuracyWhite: acc.white,
    accuracyBlack: acc.black,
    eloWhite: estimateElo(acc.white, nonBook('w')),
    eloBlack: estimateElo(acc.black, nonBook('b')),
    counts,
  };
}

export async function analyzeGame(gameId, pass, { evaluator, signal, onProgress } = {}) {
  const game = getGame(gameId);
  if (!game) throw new Error(`Partie ${gameId} introuvable`);
  if (game.parse_error) throw new Error(game.parse_error);
  const rows = getGameMoves(gameId);
  if (!rows.length) throw new Error('Partie sans coups');
  const p = PASSES[pass]();
  const lastFen = (() => {
    const c = new Chess(rows[rows.length - 1].fen_before);
    const u = rows[rows.length - 1].uci;
    c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
    return c.fen();
  })();
  const res = await analyzeMoveList(
    rows.map((r) => ({ ply: r.ply, color: r.color, san: r.san, uci: r.uci, fenBefore: r.fen_before })),
    {
      evaluator, signal, onProgress,
      depth: p.depth, nodes: p.nodes, criticalNodes: p.criticalNodes, allowCloud: p.allowCloud, skipDecided: p.skipDecided,
      whiteElo: game.white_elo, blackElo: game.black_elo,
      standardStart: !game.start_fen || game.start_fen === START_FEN,
      finalFen: lastFen,
    },
  );
  saveAnalysis(gameId, pass, res.depthUsed ?? p.depth, res);
  return res;
}

export function saveAnalysis(gameId, pass, depth, res) {
  const d = getDb();
  transaction(() => {
    d.prepare('DELETE FROM move_analysis WHERE game_id = ? AND pass = ?').run(gameId, pass);
    const ins = d.prepare(`INSERT INTO move_analysis(game_id, pass, ply, best_uci, best_san, eval_best, eval_played, win_best,
        win_played, win_second, win_white_after, loss, accuracy, classification, source, depth)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const m of res.moves) {
      ins.run(gameId, pass, m.ply, m.bestUci, m.bestSan, JSON.stringify(m.evalBest), JSON.stringify(m.evalPlayed),
        m.winBest, m.winPlayed, m.winSecond, m.winWhiteAfter, m.loss, m.accuracy, m.classification, m.source, m.depth);
    }
    d.prepare(`INSERT INTO game_analysis(game_id, pass, depth, accuracy_white, accuracy_black, elo_white, elo_black, counts, analyzed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(game_id, pass) DO UPDATE SET depth = excluded.depth, accuracy_white = excluded.accuracy_white,
          accuracy_black = excluded.accuracy_black, elo_white = excluded.elo_white, elo_black = excluded.elo_black,
          counts = excluded.counts, analyzed_at = excluded.analyzed_at`)
      .run(gameId, pass, depth, res.accuracyWhite, res.accuracyBlack, res.eloWhite, res.eloBlack, JSON.stringify(res.counts));
  });
}
