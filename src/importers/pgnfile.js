// Import de PGN collé ou déposé (une ou plusieurs parties).
import crypto from 'node:crypto';
import { insertGame, makeYielder } from '../games.js';
import { splitPgn, parseHeaders, tokenizeMovetext } from '../pgn.js';

// Identifiant stable d'une partie PGN : mêmes joueurs, même date, mêmes coups => même partie (pas de doublon).
export function pgnFingerprint(pgn) {
  const h = parseHeaders(pgn);
  const moves = tokenizeMovetext(pgn.replace(/^\s*\[\w+\s+"(?:[^"\\]|\\.)*"\]\s*$/gm, ''))
    .filter((t) => t.type === 'move').map((t) => t.text).join(' ');
  const key = [h.White, h.Black, h.Date, h.UTCTime, h.Result, h.FEN, h.Site, moves].map((x) => x ?? '').join('|');
  return crypto.createHash('sha1').update(key).digest('hex');
}

function detectSource(h) {
  const site = `${h.Site ?? ''} ${h.Link ?? ''}`;
  if (/lichess\.org\/([A-Za-z0-9]{8})/.test(site)) return { source: 'lichess', sourceId: /lichess\.org\/([A-Za-z0-9]{8})/.exec(site)[1] };
  return null;
}

export async function importPgnText(text) {
  const parts = splitPgn(text);
  const breathe = makeYielder();
  const stats = { found: parts.length, added: 0, duplicate: 0, unfinished: 0, errors: [], ids: [] };
  for (const pgn of parts) {
    await breathe();
    try {
      const h = parseHeaders(pgn);
      const known = detectSource(h);
      const r = insertGame(pgn, known ?? { source: 'pgn', sourceId: pgnFingerprint(pgn) });
      if (r.skipped === 'unfinished') stats.unfinished++;
      else if (r.inserted) { stats.added++; stats.ids.push(r.id); if (r.error) stats.errors.push(r.error); }
      else { stats.duplicate++; stats.ids.push(r.id); }
    } catch (e) {
      stats.errors.push(e.message);
    }
  }
  return stats;
}
