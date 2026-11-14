// Imports : comptes chess.com / Lichess, PGN collé ou déposé, synchronisation des comptes suivis.
import { importPgnText } from '../importers/pgnfile.js';
import { getQueue, startImport, syncTrackedPlayers } from './context.js';
import { send } from './respond.js';

export async function importRoutes(req, res, { p, body }) {
  if (req.method !== 'POST') return false;
  if (p === '/api/import/chesscom' || p === '/api/import/lichess') {
    const username = String(body.username ?? '').trim();
    if (!username) send(res, 400, { error: 'Pseudo manquant' });
    else send(res, 202, startImport(p.endsWith('chesscom') ? 'chesscom' : 'lichess', username));
    return true;
  }
  if (p === '/api/import/pgn') {
    const r = await importPgnText(String(body.pgn ?? ''));
    getQueue().notify();
    send(res, 200, r);
    return true;
  }
  if (p === '/api/sync') { syncTrackedPlayers(); send(res, 202, { ok: true }); return true; }
  return false;
}
