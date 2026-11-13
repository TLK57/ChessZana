// Import des parties Lichess via l'API publique (export des parties d'un joueur, flux NDJSON).
// https://lichess.org/api#tag/Games/operation/apiGamesUser
// Seules les parties terminées sont demandées (finished=true, ongoing=false), avec les pendules (clocks=true).
import { getDb } from '../db.js';
import { getJson, politeGet } from '../http.js';
import { insertGame, makeYielder, upsertPlayer } from '../games.js';

const OVERLAP_MS = 7 * 24 * 3600 * 1000; // on revérifie la dernière semaine (parties longues terminées depuis)
const ALLOWED_VARIANTS = new Set(['standard', 'fromPosition']);

function playerName(side) {
  if (!side) return null;
  if (side.user?.name) return side.user.name;
  if (side.aiLevel) return `Stockfish niveau ${side.aiLevel}`;
  return 'Anonyme';
}

export function lichessGameMeta(g, player) {
  const me = player.username;
  const color = g.players?.white?.user?.id === me ? 'white' : g.players?.black?.user?.id === me ? 'black' : null;
  const clock = g.clock ? `${g.clock.initial}+${g.clock.increment}` : null;
  const speed = g.speed === 'correspondence' ? 'daily' : g.speed === 'ultraBullet' ? 'bullet' : g.speed;
  return {
    source: 'lichess',
    sourceId: g.id,
    url: `https://lichess.org/${g.id}`,
    whiteName: playerName(g.players?.white),
    blackName: playerName(g.players?.black),
    whiteElo: g.players?.white?.rating ?? null,
    blackElo: g.players?.black?.rating ?? null,
    timeControl: clock,
    timeClass: speed ?? null,
    rated: g.rated,
    endTime: g.lastMoveAt ? Math.floor(g.lastMoveAt / 1000) : null,
    playedAt: g.lastMoveAt ? new Date(g.lastMoveAt).toISOString() : null,
    eco: g.opening?.eco,
    openingName: g.opening?.name,
    player,
    color,
  };
}

export async function syncLichess(username, { onProgress, signal } = {}) {
  const uname = String(username ?? '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,30}$/.test(uname)) throw new Error('Pseudo Lichess invalide.');
  const report = (p) => onProgress?.({ source: 'lichess', username: uname, ...p });

  report({ message: 'Vérification du pseudo…' });
  const u = await getJson(`https://lichess.org/api/user/${uname}`, { retries: 3, rateLimitDelayMs: 60000, signal });
  if (u.status === 404) throw new Error(`Le pseudo Lichess « ${username} » n'existe pas.`);
  if (!u.ok) throw new Error(`Lichess ne répond pas (HTTP ${u.status}).`);
  const player = upsertPlayer('lichess', uname, u.json?.username ?? uname);

  const since = player.sync_cursor ? Math.max(0, player.sync_cursor - OVERLAP_MS) : null;
  const params = new URLSearchParams({
    clocks: 'true', opening: 'true', evals: 'false', literate: 'false', pgnInJson: 'true',
    finished: 'true', ongoing: 'false', sort: 'dateAsc',
  });
  if (since) params.set('since', String(since));
  const url = `https://lichess.org/api/games/user/${uname}?${params}`;
  const stats = { added: 0, duplicate: 0, skipped: 0 };
  const total = u.json?.count?.all ?? null;
  let cursor = player.sync_cursor ?? 0;
  const d = getDb();
  const saveCursor = d.prepare('UPDATE players SET sync_cursor = ? WHERE id = ?');

  report({ message: since ? 'Recherche des nouvelles parties…' : 'Téléchargement de toutes les parties…', done: 0, total, stats });

  await politeGet(url, {
    headers: { Accept: 'application/x-ndjson' },
    retries: 3, rateLimitDelayMs: 60000, timeoutMs: 60000, signal,
    handler: async (res) => {
      if (!res.ok) throw new Error(`Export Lichess impossible (HTTP ${res.status}).`);
      const decoder = new TextDecoder();
      const breathe = makeYielder();
      let buf = '';
      let n = 0;
      const handleLine = (line) => {
        if (!line.trim()) return;
        let g;
        try { g = JSON.parse(line); } catch { return; }
        n++;
        if (!ALLOWED_VARIANTS.has(g.variant) || !g.pgn || g.status === 'started' || g.status === 'created') {
          stats.skipped++;
        } else {
          const r = insertGame(g.pgn, lichessGameMeta(g, player));
          if (r.inserted) stats.added++;
          else if (r.skipped) stats.skipped++;
          else stats.duplicate++;
        }
        if (g.createdAt && g.createdAt > cursor) cursor = g.createdAt;
        if (n % 50 === 0) {
          saveCursor.run(cursor, player.id);
          report({ message: `${n} parties lues, ${stats.added} nouvelles`, done: n, total, stats });
        }
      };
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          await breathe();
          handleLine(buf.slice(0, idx));
          buf = buf.slice(idx + 1);
        }
      }
      handleLine(buf + decoder.decode());
    },
  });

  saveCursor.run(cursor || null, player.id);
  d.prepare("UPDATE players SET last_sync_at = datetime('now') WHERE id = ?").run(player.id);
  report({ message: `Terminé : ${stats.added} nouvelles parties`, stats, finished: true });
  return stats;
}
