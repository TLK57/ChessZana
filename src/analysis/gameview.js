// Données de l'écran d'analyse d'une partie, et analyse « en direct » d'un coup joué en mode libre.
import { Chess } from 'chess.js';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { getGame, getGameMoves } from '../games.js';
import { computeOpening, myColorOf } from '../library.js';
import { normalizeChessFen, playUci, moveToUci, terminalState } from '../chessutil.js';
import { classifyMove, LABELS } from './classify.js';
import { explainMove, pvDetails } from './explain.js';
import { isBookPosition } from './openings.js';
import { moveAccuracy, winPct } from './formulas.js';
import { calibratedElo, calibrationInfo } from '../stats/calibration.js';

const BAD = new Set(['inaccuracy', 'mistake', 'blunder', 'miss']);

// Score vu par le joueur qui joue -> score vu par les Blancs.
export function toWhite(score, color) {
  if (!score) return null;
  if (color === 'w') return { cp: score.cp ?? null, mate: score.mate ?? null, wdl: score.wdl ?? null };
  const flip = { win: 'loss', loss: 'win', draw: 'draw' };
  return {
    cp: score.cp != null ? -score.cp : null,
    mate: score.mate != null ? -score.mate : null,
    wdl: score.wdl ? flip[score.wdl] : null,
  };
}

export function evalText(w) {
  if (!w) return '';
  if (w.wdl) return w.wdl === 'win' ? '1-0 (table)' : w.wdl === 'loss' ? '0-1 (table)' : '½ (table)';
  if (w.mate != null) return w.mate === 0 ? '#' : `${w.mate > 0 ? '' : '-'}M${Math.abs(w.mate)}`;
  if (w.cp != null) { const v = w.cp / 100; return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(Math.abs(v) >= 10 ? 1 : 2)}`; }
  return '';
}

const scoreOf = (l) => (l ? { cp: l.cp ?? null, mate: l.mate ?? null, wdl: l.wdl ?? null } : null);

function formatLines(fen, lines, color, max = 2) {
  return (lines ?? []).slice(0, max).map((l) => {
    const det = pvDetails(fen, l.pv?.length ? l.pv : [l.move], 12);
    const white = toWhite(scoreOf(l), color);
    return {
      uci: l.move, san: det[0]?.san ?? null,
      eval: white, evalText: evalText(white),
      line: det.map(({ san, uci, color: c, moveNumber }) => ({ san, uci, color: c, moveNumber })),
    };
  });
}

function evalsFor(positionIds) {
  const map = new Map();
  if (!positionIds.length) return map;
  const rows = getDb().prepare(`SELECT position_id, kind, lines, depth, source FROM evaluations
                                WHERE position_id IN (${positionIds.map(() => '?').join(',')})`).all(...positionIds);
  for (const r of rows) map.set(`${r.position_id}|${r.kind}`, { ...r, lines: JSON.parse(r.lines) });
  return map;
}

export function buildGameView(gameId, { currentGameId = null } = {}) {
  const game = getGame(gameId);
  if (!game) return null;
  if (!game.book_done) computeOpening(gameId);
  const g = getGame(gameId);
  const rows = getGameMoves(gameId);
  const analyses = getDb().prepare('SELECT * FROM game_analysis WHERE game_id = ?').all(gameId);
  const pass = analyses.some((a) => a.pass === 'deep') ? 'deep' : analyses.some((a) => a.pass === 'quick') ? 'quick' : null;
  const analysis = analyses.find((a) => a.pass === pass) ?? null;
  const ma = new Map(pass ? getDb().prepare('SELECT * FROM move_analysis WHERE game_id = ? AND pass = ?').all(gameId, pass).map((r) => [r.ply, r]) : []);
  const evals = evalsFor(rows.map((r) => r.position_before));

  const startFen = rows[0]?.fen_before ?? g.start_fen ?? new Chess().fen();
  const myColor = myColorOf(gameId);
  // « vous » pour mes coups ; les coups de l'adversaire sont expliqués par couleur (« les Noirs »).
  const isMine = (color) => myColor != null && myColor[0] === color;
  const moves = rows.map((r, i) => {
    const c = new Chess(r.fen_before);
    playUci(c, r.uci);
    const a = ma.get(r.ply);
    const multipv = evals.get(`${r.position_before}|multipv`);
    const playedEval = evals.get(`${r.position_before}|move:${r.uci}`);
    const playedLine = multipv?.lines.find((l) => l.move === r.uci) ?? playedEval?.lines?.[0] ?? null;
    const evalBest = a?.eval_best ? JSON.parse(a.eval_best) : null;
    const evalPlayed = a?.eval_played ? JSON.parse(a.eval_played) : null;
    const m = {
      ply: r.ply, color: r.color, san: r.san, uci: r.uci,
      fenBefore: r.fen_before, fenAfter: c.fen(),
      clockMs: r.clock_ms, timeSpentMs: r.time_spent_ms,
      // Théorie : avant le premier coup hors de la base (ou toute la partie si elle n'en est jamais sortie).
      book: g.book_exit_ply == null ? g.book_name != null : i + 1 < g.book_exit_ply,
      classification: a?.classification ?? null,
      label: a ? LABELS[a.classification] : null,
      loss: a?.loss ?? null, accuracy: a?.accuracy ?? null,
      winBest: a?.win_best ?? null, winPlayed: a?.win_played ?? null, winWhiteAfter: a?.win_white_after ?? null,
      evalAfter: evalPlayed ? toWhite(evalPlayed, r.color) : null,
      bestUci: a?.best_uci ?? null, bestSan: a?.best_san ?? null,
      depth: a?.depth ?? null, source: a?.source ?? null, verified: !!a?.verified,
      lines: multipv ? formatLines(r.fen_before, multipv.lines, r.color) : [],
      explanation: null,
    };
    m.evalAfterText = evalText(m.evalAfter);
    if (a && BAD.has(a.classification)) {
      const ex = explainMove({
        fenBefore: r.fen_before, playedUci: r.uci,
        playedPv: playedLine?.pv ?? [r.uci], bestPv: multipv?.lines?.[0]?.pv ?? (a.best_uci ? [a.best_uci] : []),
        evalBest, evalPlayed, classification: a.classification, lossPct: a.loss, you: isMine(r.color),
      });
      m.explanation = {
        sentences: ex.sentences,
        bestLine: ex.bestLine.map(({ san, uci, color, moveNumber }) => ({ san, uci, color, moveNumber })),
        playedLine: ex.playedLine.map(({ san, uci, color, moveNumber }) => ({ san, uci, color, moveNumber })),
      };
    }
    return m;
  });

  // Évaluation de la position de départ (barre et graphe au demi-coup 0).
  const first = moves[0];
  const startWin = first?.winBest != null ? (first.color === 'w' ? first.winBest : 100 - first.winBest) : 50;
  const firstEval = rows[0] ? evals.get(`${rows[0].position_before}|multipv`)?.lines?.[0] : null;
  const startEval = firstEval ? toWhite(scoreOf(firstEval), rows[0].color) : null;

  const counts = analysis?.counts ? JSON.parse(analysis.counts) : { w: {}, b: {} };
  const side = (color) => ({
    name: g[`${color}_name`], elo: g[`${color}_elo`],
    accuracy: analysis?.[`accuracy_${color}`] ?? null,
    estElo: analysis ? calibratedElo(analysis[`accuracy_${color}`], g.time_class, rows.filter((r) => r.color === color[0]).length) : null,
    estEloGeneric: analysis?.[`elo_${color}`] ?? null,
    counts: counts[color === 'white' ? 'w' : 'b'] ?? {},
  });
  const queueRows = getDb().prepare('SELECT pass, status, error FROM analysis_queue WHERE game_id = ?').all(gameId);
  const exitMove = g.book_exit_ply ? moves[g.book_exit_ply - 1] : null;
  return {
    id: g.id, url: g.url, source: g.source,
    playedAt: g.played_at, timeClass: g.time_class, timeControl: g.time_control, result: g.result, termination: g.termination,
    myColor,
    white: side('white'), black: side('black'),
    opening: { name: g.book_name, eco: g.book_eco, exitPly: g.book_exit_ply, exitSan: exitMove?.san ?? null, chesscomName: g.opening_name },
    pass, depth: analysis?.depth ?? null,
    depthMin: analysis?.depth_min ?? null, depthMax: analysis?.depth_max ?? null,
    verified: analysis?.verified ?? null, verifyDepth: analysis?.verify_depth ?? null,
    nodes: pass === 'deep' ? config.engine.deepNodes : null, verifyTarget: config.engine.verifyDepth,
    status: g.id === currentGameId ? 'running' : (pass ?? 'pending'),
    queue: queueRows,
    requested: getDb().prepare("SELECT COUNT(*) AS n FROM analysis_queue WHERE game_id = ? AND priority > 0 AND status IN ('pending', 'running')").get(gameId).n > 0,
    startFen, startWin, startEval, startEvalText: evalText(startEval),
    moves,
    labels: LABELS,
    calibration: calibrationInfo(),
  };
}

// ------------------------------------------------------------------------------------------
// Mode libre : un coup joué par l'utilisateur, évalué en direct avec les mêmes règles.

/**
 * body : { fen, uci, prev: {classification, winBest, uci, san} | null, bookBefore: bool, elo }
 */
export async function liveMove(evaluator, body) {
  // Profondeur demandée par l'interface (avis rapide puis affiné), plafonnée à liveDepth.
  const depth = Math.max(8, Math.min(config.engine.liveDepth, Math.floor(Number(body.depth) || config.engine.liveDepth)));
  const fen = String(body.fen ?? '');
  const before = new Chess(fen);
  const color = before.turn();
  const legalMoves = before.moves().length;
  const inCheck = before.inCheck();
  const after = new Chess(fen);
  const mv = playUci(after, String(body.uci ?? ''));
  if (!mv) throw Object.assign(new Error('Coup illégal'), { status: 400 });
  const uci = moveToUci(mv);

  const ev = await evaluator.evaluatePosition(fen, { depth, allowCloud: true });
  let played = ev.lines.find((l) => l.move === uci);
  if (!played) played = await evaluator.evaluateMove(fen, uci, { depth });
  const best = ev.lines[0];
  const second = ev.lines[1] ?? null;
  const winBest = winPct(scoreOf(best));
  const winPlayed = winPct(scoreOf(played));
  const winSecond = second ? winPct(scoreOf(second)) : null;
  const playedIsBest = best?.move === uci;
  const prev = body.prev && body.prev.classification ? { classification: body.prev.classification, winBest: Number(body.prev.winBest) } : null;
  const isRecapture = !!body.prev?.san && /x/.test(body.prev.san) && /x/.test(mv.san) && String(body.prev.uci).slice(2, 4) === mv.to;
  const book = !!body.bookBefore && isBookPosition(normalizeChessFen(after));
  const { classification, loss } = classifyMove({
    book, legalMoves, inCheck, playedIsBest, winBest, winPlayed, winSecond,
    elo: Number(body.elo) || null, fenBefore: fen,
    playedPv: played?.pv?.length ? played.pv : [uci],
    altPv: (playedIsBest ? second : best)?.pv ?? null,
    isRecapture, prev,
  });
  const evalPlayed = scoreOf(played);
  let explanation = null;
  if (BAD.has(classification)) {
    const you = body.myColor ? body.myColor[0] === color : true;
    const ex = explainMove({ fenBefore: fen, playedUci: uci, playedPv: played?.pv ?? [uci], bestPv: best?.pv ?? [], evalBest: scoreOf(best), evalPlayed, classification, lossPct: loss, you });
    explanation = {
      sentences: ex.sentences,
      bestLine: ex.bestLine.map(({ san, uci: u, color: c, moveNumber }) => ({ san, uci: u, color: c, moveNumber })),
    };
  }
  // Fin de partie après le coup ?
  const term = terminalState(after);
  const whiteAfter = term === 'checkmate' ? (after.turn() === 'w' ? 0 : 100) : term ? 50 : (color === 'w' ? winPlayed : 100 - winPlayed);
  const evalAfter = toWhite(evalPlayed, color);
  return {
    san: mv.san, uci, color, fenBefore: fen, fenAfter: after.fen(),
    classification, label: LABELS[classification], loss, accuracy: moveAccuracy(loss),
    winBest, winPlayed, winWhiteAfter: whiteAfter,
    evalAfter, evalAfterText: term === 'checkmate' ? '#' : evalText(evalAfter),
    bestUci: best?.move ?? null, bestSan: best ? (pvDetails(fen, [best.move])[0]?.san ?? null) : null,
    lines: formatLines(fen, ev.lines, color),
    explanation, depth: ev.depth, source: ev.source,
  };
}

export function liveDepth() {
  return config.engine.liveDepth;
}
