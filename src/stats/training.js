// Mode entraînement : mes gaffes et occasions manquées deviennent des puzzles, révisés en répétition espacée.
import { Chess } from 'chess.js';
import { wilson } from './confidence.js';
import { getDb, getMeta, setMeta, stmt } from '../db.js';
import { ERROR_TYPES, explainMove, pvDetails } from '../analysis/explain.js';
import { winPct } from '../analysis/formulas.js';
import { normalizeChessFen, pieceCount, playUci, moveToUci } from '../chessutil.js';
import { ensureStatsSchema } from './compute.js';
import { localDate, schedule } from './rules.js';

export const SESSION_SIZE = 10;
const MAX_PER_TYPE = 4;
const ACCEPT_LOSS = 3; // un autre coup est accepté s'il est presque aussi bon (≤ 3 % de chances de gain d'écart)

const scoreOf = (l) => (l ? { cp: l.cp ?? null, mate: l.mate ?? null, wdl: l.wdl ?? null } : null);

/** Fréquence de mes types d'erreurs (erreurs, gaffes, occasions manquées) : sert à prioriser les puzzles. */
export function typeFrequencies() {
  ensureStatsSchema();
  const rows = getDb().prepare(`SELECT error_type AS type, COUNT(*) AS n FROM move_features
      WHERE classification IN ('mistake', 'blunder', 'miss') AND error_type IS NOT NULL GROUP BY error_type ORDER BY n DESC`).all();
  return new Map(rows.map((r, i) => [r.type, { count: r.n, rank: i }]));
}

/**
 * Choisit les puzzles du jour : ceux à réviser aujourd'hui (date dépassée) et les nouveaux, en priorité
 * les types d'erreurs que je fais le plus (au plus 4 du même type pour varier).
 */
export function pickSession(candidates, freq, size = SESSION_SIZE, today = localDate()) {
  const rank = (t) => freq.get(t)?.rank ?? 999;
  const sorted = [...candidates].sort((a, b) => rank(a.error_type) - rank(b.error_type)
    || (a.due_date && a.due_date <= today ? 0 : 1) - (b.due_date && b.due_date <= today ? 0 : 1)
    || String(a.due_date ?? '').localeCompare(String(b.due_date ?? ''))
    || String(b.played_at ?? '').localeCompare(String(a.played_at ?? '')));
  const perType = new Map();
  const chosen = [];
  for (const pass of [MAX_PER_TYPE, Infinity]) { // 2e tour si pas assez de types différents
    for (const p of sorted) {
      if (chosen.length >= size) break;
      if (chosen.includes(p)) continue;
      const k = perType.get(p.error_type) ?? 0;
      if (k >= pass) continue;
      perType.set(p.error_type, k + 1);
      chosen.push(p);
    }
  }
  return chosen;
}

function candidates(today) {
  return getDb().prepare(`SELECT p.*, s.played_at FROM puzzles p LEFT JOIN game_stats s ON s.game_id = p.game_id
      WHERE p.active = 1 AND (p.due_date IS NULL OR p.due_date <= ?)`).all(today);
}

function publicPuzzle(p, session) {
  return {
    id: p.id, fen: p.fen, color: p.color, gameId: p.game_id, ply: p.ply,
    moveNumber: Math.ceil(p.ply / 2), playedSan: p.played_san, errorType: p.error_type, playedAt: p.played_at ?? null,
    errorLabel: ERROR_TYPES[p.error_type] ?? p.error_type, classification: p.classification,
    attempts: p.attempts, successes: p.successes, streak: p.streak, dueDate: p.due_date,
    result: session?.results?.[p.id] ?? null,
  };
}

/** Session du jour (gardée toute la journée, même après fermeture de l'application). */
export function todaySession({ today = localDate(), reset = false } = {}) {
  ensureStatsSchema();
  let s = null;
  try { s = JSON.parse(getMeta('training_session', 'null')); } catch { s = null; }
  if (reset || !s || s.date !== today || !Array.isArray(s.ids) || !s.ids.length) {
    const chosen = pickSession(candidates(today), typeFrequencies(), SESSION_SIZE, today);
    s = { date: today, ids: chosen.map((p) => p.id), results: {} };
    setMeta('training_session', JSON.stringify(s));
  }
  const byId = new Map(getDb().prepare(`SELECT p.*, gs.played_at FROM puzzles p LEFT JOIN game_stats gs ON gs.game_id = p.game_id
      WHERE p.id IN (${s.ids.map(() => '?').join(',') || 'NULL'})`).all(...s.ids).map((p) => [p.id, p]));
  const puzzles = s.ids.map((id) => byId.get(id)).filter(Boolean).map((p) => publicPuzzle(p, s));
  return { date: s.date, puzzles, done: Object.keys(s.results).length, success: Object.values(s.results).filter(Boolean).length };
}

function cachedEval(fen, kind) {
  const c = new Chess(fen);
  const pos = stmt('SELECT id FROM positions WHERE fen = ?').get(normalizeChessFen(c));
  if (!pos) return [];
  const row = stmt('SELECT lines FROM evaluations WHERE position_id = ? AND kind = ?').get(pos.id, kind);
  return row ? JSON.parse(row.lines) : [];
}
const cachedLines = (fen) => cachedEval(fen, 'multipv');

/** Vérifie la réponse, met à jour la répétition espacée et renvoie la solution expliquée. */
export async function answerPuzzle(id, uci, { evaluator = null, today = localDate() } = {}) {
  ensureStatsSchema();
  const d = getDb();
  const p = d.prepare('SELECT * FROM puzzles WHERE id = ?').get(id);
  if (!p) throw Object.assign(new Error('Puzzle introuvable'), { status: 404 });
  const c = new Chess(p.fen);
  const giveUp = !uci; // « Je ne trouve pas » : compte comme un échec
  const mv = giveUp ? null : playUci(c, String(uci));
  if (!giveUp && !mv) throw Object.assign(new Error('Coup illégal'), { status: 400 });
  const answer = mv ? moveToUci(mv) : null;

  let correct = !giveUp && answer === p.solution_uci;
  let lines = cachedLines(p.fen);
  if (!correct && !giveUp) {
    // Un autre coup presque aussi bon que la solution est accepté.
    let best = lines[0];
    let mine = lines.find((l) => l.move === answer);
    if (evaluator && (!best || !mine)) {
      const depth = 14;
      if (!best) { const ev = await evaluator.evaluatePosition(p.fen, { depth }); lines = ev.lines; best = lines[0]; mine = lines.find((l) => l.move === answer); }
      if (!mine) mine = await evaluator.evaluateMove(p.fen, answer, { depth });
    }
    if (best && mine) correct = winPct(scoreOf(best)) - winPct(scoreOf(mine)) <= ACCEPT_LOSS;
  }

  // Une seule réponse compte par session et par puzzle pour la répétition espacée.
  let session = null;
  try { session = JSON.parse(getMeta('training_session', 'null')); } catch { session = null; }
  const firstTry = !(session && session.date === today && id in (session.results ?? {}));
  let next = { streak: p.streak, intervalDays: p.interval_days, dueDate: p.due_date };
  if (firstTry) {
    next = schedule({ streak: p.streak }, correct, today);
    d.prepare(`UPDATE puzzles SET streak = ?, interval_days = ?, due_date = ?, attempts = attempts + 1,
        successes = successes + ?, last_result = ?, last_at = datetime('now') WHERE id = ?`)
      .run(next.streak, next.intervalDays, next.dueDate, correct ? 1 : 0, correct ? 'success' : 'fail', id);
    d.prepare('INSERT INTO puzzle_attempts(puzzle_id, session_date, success, answer_uci) VALUES (?, ?, ?, ?)').run(id, today, correct ? 1 : 0, answer);
    if (session && session.date === today && session.ids.includes(id)) {
      session.results[id] = correct;
      setMeta('training_session', JSON.stringify(session));
    }
  }

  // Explication de la solution (règles de l'étape 2).
  const bestLine = lines[0]?.pv?.length ? lines[0].pv : [p.solution_uci];
  // Ligne du coup joué dans la partie : dans le MultiPV, ou évaluée à part (searchmoves) lors de l'analyse.
  const playedLine = lines.find((l) => l.move === p.played_uci) ?? cachedEval(p.fen, `move:${p.played_uci}`)[0] ?? null;
  const ex = explainMove({
    fenBefore: p.fen, playedUci: p.played_uci, playedPv: playedLine?.pv ?? [p.played_uci], bestPv: bestLine,
    evalBest: scoreOf(lines[0]), evalPlayed: scoreOf(playedLine), classification: p.classification, you: true,
  });
  return {
    id, correct, answerSan: mv?.san ?? null, firstTry,
    solutionUci: p.solution_uci, solutionSan: p.solution_san,
    line: pvDetails(p.fen, bestLine, 10).map(({ san, uci: u, color, moveNumber }) => ({ san, uci: u, color, moveNumber })),
    explanation: ex.sentences,
    next: { intervalDays: next.intervalDays, dueDate: next.dueDate, streak: next.streak },
    gameId: p.game_id, ply: p.ply, pieces: pieceCount(p.fen),
  };
}

/** Réussite par type d'erreur, et état de la répétition espacée. */
export function trainingStats(today = localDate()) {
  ensureStatsSchema();
  const d = getDb();
  const rows = d.prepare(`SELECT error_type AS type, COUNT(*) AS puzzles, SUM(attempts) AS attempts, SUM(successes) AS successes,
        SUM(CASE WHEN due_date IS NULL OR due_date <= ? THEN 1 ELSE 0 END) AS due,
        SUM(CASE WHEN interval_days >= 30 THEN 1 ELSE 0 END) AS mastered
      FROM puzzles WHERE active = 1 GROUP BY error_type ORDER BY puzzles DESC`).all(today);
  return {
    total: rows.reduce((a, r) => a + r.puzzles, 0),
    due: rows.reduce((a, r) => a + r.due, 0),
    byType: rows.map((r) => ({
      type: r.type, label: ERROR_TYPES[r.type] ?? r.type, puzzles: r.puzzles, attempts: r.attempts, successes: r.successes,
      rate: r.attempts ? r.successes / r.attempts : null, rateCI: wilson(r.successes ?? 0, r.attempts ?? 0), due: r.due, mastered: r.mastered,
    })),
  };
}
