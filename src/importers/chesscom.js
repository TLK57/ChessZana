// Import des parties chess.com via l'API publique (PubAPI).
// https://www.chess.com/news/view/published-data-api
// - une requête à la fois (jamais en parallèle), User-Agent avec contact, nouvelles tentatives sur 429 ;
// - synchronisation incrémentale : un mois terminé et déjà téléchargé n'est plus jamais redemandé,
//   seul le mois en cours (et les mois pas encore « clos ») sont retéléchargés, avec ETag.
import { getDb } from '../db.js';
import { getJson } from '../http.js';
import { insertGame, makeYielder, upsertPlayer } from '../games.js';

const API = 'https://api.chess.com/pub';
const HTTP_OPTS = { retries: 5, rateLimitDelayMs: 5000, errorDelayMs: 3000, timeoutMs: 30000 };
const DAY = 24 * 3600 * 1000;

// Un mois est « clos » s'il a été téléchargé au moins un jour après sa fin (marge pour les fuseaux horaires).
export function isArchiveComplete(year, month, fetchedAtMs) {
  const firstOfNextMonth = Date.UTC(year, month, 1); // month est 1..12 ; Date.UTC attend 0..11
  return fetchedAtMs >= firstOfNextMonth + DAY;
}

export function parseArchiveUrl(url) {
  const m = /\/games\/(\d{4})\/(\d{2})\/?$/.exec(url);
  return m ? { year: Number(m[1]), month: Number(m[2]) } : null;
}

// Une partie d'archive chess.com est terminée si elle a une date de fin et un résultat définitif.
export function isFinishedChessComGame(g) {
  if (!g || !g.pgn || !g.end_time) return false;
  const res = /\[Result\s+"([^"]+)"\]/.exec(g.pgn)?.[1];
  return res === '1-0' || res === '0-1' || res === '1/2-1/2';
}

function insertChessComGame(g, player) {
  if (!isFinishedChessComGame(g)) return 'unfinished';
  if (g.rules && g.rules !== 'chess') return 'variant'; // Chess960, bughouse… non analysés
  const me = player.username;
  const color = g.white?.username?.toLowerCase() === me ? 'white' : g.black?.username?.toLowerCase() === me ? 'black' : null;
  const r = insertGame(g.pgn, {
    source: 'chesscom',
    sourceId: g.uuid || g.url,
    url: g.url,
    whiteName: g.white?.username,
    blackName: g.black?.username,
    whiteElo: Number.isFinite(g.white?.rating) ? g.white.rating : null,
    blackElo: Number.isFinite(g.black?.rating) ? g.black.rating : null,
    timeControl: g.time_control,
    timeClass: g.time_class,
    rated: g.rated,
    endTime: g.end_time,
    playedAt: new Date(g.end_time * 1000).toISOString(),
    player,
    color,
  });
  if (r.skipped) return r.skipped;
  return r.inserted ? 'added' : 'duplicate';
}

export async function syncChessCom(username, { onProgress, signal } = {}) {
  const uname = String(username ?? '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,50}$/.test(uname)) throw new Error('Pseudo chess.com invalide.');
  const report = (p) => onProgress?.({ source: 'chesscom', username: uname, ...p });

  report({ message: 'Vérification du pseudo…' });
  const profile = await getJson(`${API}/player/${uname}`, { ...HTTP_OPTS, signal });
  if (profile.status === 404) throw new Error(`Le pseudo chess.com « ${username} » n'existe pas.`);
  if (!profile.ok) throw new Error(`chess.com ne répond pas (HTTP ${profile.status}).`);
  const player = upsertPlayer('chesscom', uname, profile.json?.username ?? uname);

  const arch = await getJson(`${API}/player/${uname}/games/archives`, { ...HTTP_OPTS, signal });
  if (!arch.ok) throw new Error(`Impossible de lire la liste des archives (HTTP ${arch.status}).`);
  const archives = Array.isArray(arch.json?.archives) ? arch.json.archives : [];

  const d = getDb();
  const getArchive = d.prepare('SELECT * FROM sync_archives WHERE player_id = ? AND url = ?');
  const saveArchive = d.prepare(`INSERT INTO sync_archives(player_id, url, year, month, etag, game_count, complete, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(player_id, url) DO UPDATE SET etag = excluded.etag, game_count = COALESCE(excluded.game_count, sync_archives.game_count),
        complete = excluded.complete, fetched_at = excluded.fetched_at`);

  const todo = archives.filter((url) => !getArchive.get(player.id, url)?.complete);
  const stats = { months: archives.length, monthsDownloaded: 0, monthsUnchanged: 0, monthsSkipped: archives.length - todo.length, added: 0, duplicate: 0, skipped: 0 };
  report({ message: `${archives.length} mois au total, ${todo.length} à télécharger`, done: 0, total: todo.length, stats });

  const breathe = makeYielder();
  for (const [i, url] of todo.entries()) {
    const ym = parseArchiveUrl(url);
    const known = getArchive.get(player.id, url);
    const headers = known?.etag ? { 'If-None-Match': known.etag } : {};
    const res = await getJson(url, { ...HTTP_OPTS, headers, signal });
    const now = Date.now();
    const complete = ym && isArchiveComplete(ym.year, ym.month, now) ? 1 : 0;
    if (res.status === 304) {
      stats.monthsUnchanged++; // mois revérifié, rien de nouveau (ETag)
      saveArchive.run(player.id, url, ym?.year ?? null, ym?.month ?? null, known.etag, null, complete, new Date(now).toISOString());
    } else if (res.ok) {
      const games = Array.isArray(res.json?.games) ? res.json.games : [];
      for (const [k, g] of games.entries()) {
        await breathe();
        const r = insertChessComGame(g, player);
        if (r === 'added') stats.added++;
        else if (r === 'duplicate') stats.duplicate++;
        else stats.skipped++;
        if (k % 200 === 199) report({ message: `Mois ${ym ? `${String(ym.month).padStart(2, '0')}/${ym.year}` : url} : ${k + 1}/${games.length} parties lues`, done: i, total: todo.length, stats });
      }
      saveArchive.run(player.id, url, ym?.year ?? null, ym?.month ?? null, res.headers.get('etag'), games.length, complete, new Date(now).toISOString());
      stats.monthsDownloaded++;
    } else {
      throw new Error(`Archive ${url} illisible (HTTP ${res.status}).`);
    }
    report({ message: `Mois ${ym ? `${String(ym.month).padStart(2, '0')}/${ym.year}` : url} : ${stats.added} nouvelles parties`, done: i + 1, total: todo.length, stats });
  }
  d.prepare("UPDATE players SET last_sync_at = datetime('now') WHERE id = ?").run(player.id);
  report({ message: `Terminé : ${stats.added} nouvelles parties`, done: todo.length, total: todo.length, stats, finished: true });
  return stats;
}
