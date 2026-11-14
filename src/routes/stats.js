// Statistiques (progression, temps, erreurs, répertoire, bilan) et entraînement (puzzles).
import { dashboard, gamesSummary, recurringErrors, repertoire, timeStats } from '../stats/queries.js';
import { answerPuzzle, todaySession, trainingStats } from '../stats/training.js';
import { bilanText } from '../stats/bilan.js';
import { liveEvaluator, markLiveActive, state } from './context.js';
import { send } from './respond.js';

function statsGet(p, url) {
  const q = Object.fromEntries(url.searchParams.entries());
  const f = { timeClass: q.timeClass, color: q.color, from: q.from, to: q.to, opponent: q.opponent };
  switch (p) {
    case '/api/stats/dashboard': return { ...dashboard(f), refresh: state.stats };
    case '/api/stats/time': return timeStats(f);
    case '/api/stats/errors': return recurringErrors(f, { examples: 3 });
    case '/api/stats/repertoire': return repertoire({ ...f, color: undefined }, {
      color: q.side === 'black' ? 'black' : 'white', maxPlies: Math.min(24, Number(q.depth) || 14), minGames: Math.max(1, Number(q.min) || 2),
    });
    case '/api/stats/games': return gamesSummary(String(q.ids ?? '').split(',').map(Number).filter(Number.isFinite).slice(0, 300));
    case '/api/stats/bilan': return bilanText(Number(q.n) || 25, f);
    default: return undefined;
  }
}

export async function statsRoutes(req, res, { p, url, body }) {
  if (req.method === 'GET') {
    if (p.startsWith('/api/stats/')) {
      const r = statsGet(p, url);
      if (r === undefined) return false;
      send(res, 200, r);
      return true;
    }
    if (p === '/api/training/session') { send(res, 200, todaySession()); return true; }
    if (p === '/api/training/stats') { send(res, 200, trainingStats()); return true; }
    return false;
  }
  if (req.method === 'POST') {
    if (p === '/api/training/answer') {
      markLiveActive();
      send(res, 200, await answerPuzzle(Number(body.id), String(body.uci ?? ''), { evaluator: state.engine.status === 'ready' ? liveEvaluator : null }));
      return true;
    }
    if (p === '/api/training/session/new') { send(res, 200, todaySession({ reset: true })); return true; }
  }
  return false;
}
