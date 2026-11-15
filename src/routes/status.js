// État général de l'application (moteur, file, imports, base…) et réglage du classement des coups.
import { config } from '../config.js';
import { getDb } from '../db.js';
import { lichessStatus } from '../engine/lichess.js';
import { listPlayers } from '../games.js';
import { listBackups } from '../backup.js';
import { evaluator, getQueue, liveActive, setClassificationMethod, startStyleFit, state } from './context.js';
import { referenceDataset } from '../analysis/reviews.js';
import { currentParams, lastFit } from '../analysis/fitstyle.js';
import { send } from './respond.js';

function counts() {
  const d = getDb();
  const one = (sql) => d.prepare(sql).get().n;
  return {
    games: one('SELECT COUNT(*) AS n FROM games'),
    positions: one('SELECT COUNT(*) AS n FROM positions'),
    evaluations: one('SELECT COUNT(*) AS n FROM evaluations'),
    players: one('SELECT COUNT(*) AS n FROM players'),
  };
}

// Profondeur réellement atteinte par passe, sur toutes les analyses faites.
function depthReached() {
  const out = {};
  for (const pass of ['quick', 'deep']) {
    const r = getDb().prepare(`SELECT COUNT(*) AS n, ROUND(AVG(depth), 1) AS avg, MIN(COALESCE(depth_min, depth)) AS min,
        MAX(COALESCE(depth_max, depth)) AS max, SUM(verified) AS verified, SUM(verify_depth IS NOT NULL) AS checkedGames
      FROM game_analysis WHERE pass = ?`).get(pass);
    out[pass] = r.n ? r : null;
  }
  return out;
}

export async function statusRoutes(req, res, { p, body }) {
  if (req.method === 'GET' && p === '/api/status') {
    send(res, 200, {
      engine: {
        ...state.engine, threads: config.engine.threadsResolved, hashMB: config.engine.hashMB, quickDepth: config.engine.quickDepth,
        deepDepth: config.engine.deepDepth, deepNodes: config.engine.deepNodes, verifyDepth: config.engine.verifyDepth,
        multiPV: config.engine.multiPV, evalStats: evaluator.stats, reached: depthReached(),
      },
      queue: { ...getQueue().progress(), waitingForLive: liveActive() },
      imports: state.imports,
      lichess: lichessStatus(),
      stats: counts(),
      players: listPlayers(),
      contactSet: !!String(config.contact || '').trim(),
      integrity: state.integrity,
      lastBackup: listBackups()[0] ?? null,
      classification: { method: config.classification.method, reclassify: state.reclassify },
    });
    return true;
  }
  if (req.method === 'GET' && p === '/api/chesscom-style') {
    const { games, missing } = referenceDataset(getDb());
    send(res, 200, { references: games.length, notAnalysed: missing.length, params: currentParams(), lastFit: lastFit(), fit: state.fit });
    return true;
  }
  if (req.method === 'POST' && p === '/api/chesscom-style/fit') {
    send(res, 200, startStyleFit());
    return true;
  }
  if (req.method === 'POST' && p === '/api/settings/classification') {
    send(res, 200, setClassificationMethod(String(body.method)));
    return true;
  }
  return false;
}
