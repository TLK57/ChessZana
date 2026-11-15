// Analyse complète d'une partie : évaluation de chaque position, classement des coups, précision, Elo estimé.
import { Chess } from 'chess.js';
import { config } from '../config.js';
import { getDb, transaction } from '../db.js';
import { getGame, getGameMoves } from '../games.js';
import { normalizeChessFen, terminalState, uciToSan, START_FEN } from '../chessutil.js';
import { AbortError } from '../engine/stockfish.js';
import { isBookPosition } from './openings.js';
import { MISS_MIN_GAIN, classifyChesscom, currentMethod, judgeLichess } from './classify.js';
import { estimateElo, winPct } from './formulas.js';

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
    verifyDepth: config.engine.verifyDepth,
  }),
};

// Classements revérifiés à profondeur fixe (ceux qui comptent le plus pour le joueur).
export const VERIFIED_CLASSES = new Set(['mistake', 'blunder', 'miss', 'brilliant', 'great']);
// Version des critères de vérification : une analyse profonde faite avec des critères plus anciens est à revérifier
// (bouton « Revérifier les coups douteux », « Analyser tout mon historique »).
export const VERIFY_VERSION = 2;
export const VERIFY_MIN_LOSS = 5; // perte (points de chances de gain) à partir de laquelle un coup est revérifié
export const VERIFY_PASS_GAP = 5; // écart de perte entre passe rapide et passe profonde qui impose une vérification
const BAD_CLASSES = new Set(['inaccuracy', 'mistake', 'miss', 'blunder']);

/**
 * Faut-il recalculer ce coup à la vraie profondeur de vérification ?
 * r : coup classé { classification, loss, gain } ; quick : le même coup dans la passe rapide { classification, loss }.
 * - erreur, gaffe, occasion manquée, très bon, brillant ;
 * - perte d'au moins 5 points (un coup sous-estimé par une recherche trop courte resterait « imprécision ») ;
 * - passes rapide et profonde en désaccord : pertes qui diffèrent de plus de 5 points, ou catégories différentes
 *   dont l'une est au moins une imprécision (un écart « meilleur » / « excellent » ne cache pas de faute) ;
 * - coup joué juste après une erreur adverse qui m'a fait gagner au moins 10 points (candidat « occasion manquée »).
 */
export function needsVerification(r, quick = null) {
  if (r.classification === 'book') return false;
  if (VERIFIED_CLASSES.has(r.classification)) return true;
  if ((r.loss ?? 0) >= VERIFY_MIN_LOSS) return true;
  if ((r.gain ?? 0) >= MISS_MIN_GAIN) return true;
  if (quick && quick.loss != null && r.loss != null) {
    if (Math.abs(quick.loss - r.loss) > VERIFY_PASS_GAP) return true;
    if (quick.classification !== r.classification && (BAD_CLASSES.has(quick.classification) || BAD_CLASSES.has(r.classification))) return true;
  }
  return false;
}

const scoreOf = (l) => (l ? { cp: l.cp ?? null, mate: l.mate ?? null, wdl: l.wdl ?? null } : null);

/**
 * Analyse une suite de coups.
 * moves : [{ ply, color, san, uci, fenBefore }]
 * opts  : { depth, nodes, verifyDepth, allowCloud, whiteElo, blackElo, standardStart, finalFen, evaluator, signal, onProgress }
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

  // Profondeur réellement atteinte pour un coup : la plus faible des deux recherches (position et coup joué).
  const moveDepth = (e) => {
    const d = e.before.depth ?? 0;
    return e.played?.depth != null && e.before.source === 'stockfish' ? Math.min(d, e.played.depth) : d;
  };

  // 4) Chances de gain, perte, classement.
  // Le classement lui-même (src/analysis/classify.js) ne lit que les évaluations : ce sont les mêmes fonctions qui
  // reclassent les parties déjà analysées, sans moteur. Classement : méthode réglée ; précision : toujours Lichess.
  const players = { w: { elo: opts.whiteElo ?? null }, b: { elo: opts.blackElo ?? null }, timeClass: opts.timeClass ?? null };
  let lichessAccuracy = { white: null, black: null };
  const classifyAll = () => {
    const list = moves.map((m, i) => {
      const { before, played } = evals[i];
      const best = before.lines[0];
      const second = before.lines[1] ?? null;
      return {
        color: m.color, uci: m.uci, san: m.san, fenBefore: m.fenBefore, book: book[i],
        bestUci: best?.move ?? null, evalBest: scoreOf(best), evalPlayed: scoreOf(played), evalSecond: second ? scoreOf(second) : null,
      };
    });
    const lichess = judgeLichess(list);
    const chesscom = classifyChesscom(list, players);
    const judged = currentMethod() === 'chesscom' ? chesscom : lichess.moves;
    lichessAccuracy = lichess.accuracy;
    return moves.map((m, i) => {
      const { before } = evals[i];
      const best = before.lines[0];
      const x = list[i];
      // Chances de gain (formule Lichess) : graphe et barre d'évaluation.
      const winBest = winPct(x.evalBest);
      const winPlayed = winPct(x.evalPlayed);
      return {
        ply: m.ply, color: m.color, san: m.san, uci: m.uci,
        bestUci: x.bestUci,
        bestSan: best?.move ? (best.san ?? uciToSan(m.fenBefore, best.move)) : null,
        evalBest: x.evalBest, evalPlayed: x.evalPlayed, evalSecond: x.evalSecond,
        winBest, winPlayed, winSecond: x.evalSecond ? winPct(x.evalSecond) : null,
        loss: judged[i].loss, gain: judged[i].gain,
        accuracy: lichess.moves[i].accuracy,
        classification: judged[i].classification,
        // L'autre méthode compte aussi pour la vérification (on peut changer de méthode sans recalculer).
        other: currentMethod() === 'chesscom' ? lichess.moves[i] : chesscom[i],
        source: before.source,
        depth: moveDepth(evals[i]),
        verified: !!evals[i].verified,
      };
    });
  };
  let results = classifyAll();

  // 4b) Vérification : les coups douteux (needsVerification) sont recalculés à la vraie profondeur verifyDepth
  //     (sans limite de nœuds), puis toute la partie est reclassée (le classement d'un coup peut dépendre du
  //     précédent, d'où quelques tours au plus).
  let verifiedCount = 0;
  if (opts.verifyDepth > 0) {
    const vs = { depth: opts.verifyDepth, nodes: null, signal };
    for (let round = 0; round < 3; round++) {
      const todo = [];
      results.forEach((r, i) => {
        const e = evals[i];
        const doubtful = needsVerification(r, opts.quick?.get(r.ply)) || needsVerification(r.other);
        if (doubtful && !e.verified && e.before.source !== 'tablebase' && moveDepth(e) < opts.verifyDepth) todo.push(i);
      });
      if (!todo.length) break;
      for (const [k, i] of todo.entries()) {
        if (signal?.aborted) throw new AbortError();
        opts.onProgress?.(n, n, { phase: 'verify', done: k, total: todo.length, depth: opts.verifyDepth });
        const m = moves[i];
        const before = await evaluator.evaluatePosition(m.fenBefore, { ...vs, allowCloud: false });
        const played = before.lines.find((l) => l.move === m.uci) ?? await evaluator.evaluateMove(m.fenBefore, m.uci, vs);
        evals[i] = { before, played, verified: true };
        verifiedCount++;
      }
      results = classifyAll();
    }
  }

  // 5) Série des chances de gain des Blancs P0…Pn (graphe), précision de la partie (Lichess) et Elo estimé.
  const series = results.map((r) => (r.color === 'w' ? r.winBest : 100 - r.winBest));
  series.push(finalWhite);
  results.forEach((r, i) => { r.winWhiteAfter = series[i + 1]; delete r.other; });
  const acc = lichessAccuracy;
  const counts = { w: {}, b: {} };
  for (const r of results) counts[r.color][r.classification] = (counts[r.color][r.classification] ?? 0) + 1;
  const nonBook = (color) => results.filter((r) => r.color === color && r.classification !== 'book').length;
  // Profondeur réellement atteinte par Stockfish (médiane, minimum, maximum), pour l'affichage.
  const depths = evals.filter((x) => !x.light && x.before.source === 'stockfish').map(moveDepth).sort((a, b) => a - b);
  return {
    depthUsed: depths.length ? depths[Math.floor(depths.length / 2)] : depth,
    depthMin: depths.length ? depths[0] : null,
    depthMax: depths.length ? depths.at(-1) : null,
    verifiedCount,
    verifyDepth: opts.verifyDepth > 0 ? opts.verifyDepth : null,
    verifyVersion: opts.verifyDepth > 0 ? VERIFY_VERSION : null,
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
  const startedAt = Date.now();
  // Passe profonde : la passe rapide sert à repérer les coups sur lesquels les deux passes ne sont pas d'accord.
  const quick = pass === 'deep'
    ? new Map(getDb().prepare("SELECT ply, classification, loss FROM move_analysis WHERE game_id = ? AND pass = 'quick'").all(gameId).map((r) => [r.ply, r]))
    : null;
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
      verifyDepth: p.verifyDepth ?? 0, quick,
      whiteElo: game.white_elo, blackElo: game.black_elo, timeClass: game.time_class,
      standardStart: !game.start_fen || game.start_fen === START_FEN,
      finalFen: lastFen,
    },
  );
  res.durationMs = Date.now() - startedAt;
  saveAnalysis(gameId, pass, res.depthUsed ?? p.depth, res);
  return res;
}

export function saveAnalysis(gameId, pass, depth, res) {
  const d = getDb();
  transaction(() => {
    d.prepare('DELETE FROM move_analysis WHERE game_id = ? AND pass = ?').run(gameId, pass);
    const ins = d.prepare(`INSERT INTO move_analysis(game_id, pass, ply, best_uci, best_san, eval_best, eval_played, win_best,
        win_played, win_second, win_white_after, loss, accuracy, classification, source, depth, verified, eval_second)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const m of res.moves) {
      ins.run(gameId, pass, m.ply, m.bestUci, m.bestSan, JSON.stringify(m.evalBest), JSON.stringify(m.evalPlayed),
        m.winBest, m.winPlayed, m.winSecond, m.winWhiteAfter, m.loss, m.accuracy, m.classification, m.source, m.depth, m.verified ? 1 : 0,
        m.evalSecond ? JSON.stringify(m.evalSecond) : null);
    }
    d.prepare(`INSERT INTO game_analysis(game_id, pass, depth, accuracy_white, accuracy_black, elo_white, elo_black, counts,
          depth_min, depth_max, verified, verify_depth, duration_ms, verify_version, analyzed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(game_id, pass) DO UPDATE SET depth = excluded.depth, accuracy_white = excluded.accuracy_white,
          accuracy_black = excluded.accuracy_black, elo_white = excluded.elo_white, elo_black = excluded.elo_black,
          counts = excluded.counts, depth_min = excluded.depth_min, depth_max = excluded.depth_max, verified = excluded.verified,
          verify_depth = excluded.verify_depth, duration_ms = excluded.duration_ms, verify_version = excluded.verify_version,
          analyzed_at = excluded.analyzed_at`)
      .run(gameId, pass, depth, res.accuracyWhite, res.accuracyBlack, res.eloWhite, res.eloBlack, JSON.stringify(res.counts),
        res.depthMin ?? null, res.depthMax ?? null, res.verifiedCount ?? 0, res.verifyDepth ?? null, res.durationMs ?? null, res.verifyVersion ?? null);
  });
}
