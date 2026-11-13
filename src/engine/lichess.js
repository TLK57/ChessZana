// Sources d'évaluation Lichess : analyse cloud (positions connues) et tables de finales (≤ 7 pièces).
// Si Lichess ne répond pas, limite le débit (429) ou renvoie une erreur, on « met en pause » la source
// pendant un moment et l'analyse continue avec Stockfish seul. Aucune erreur n'est remontée.
import { config } from '../config.js';
import { getJson, SKIPPED } from '../http.js';
import { canonicalUci } from '../chessutil.js';

const state = {
  cloud: { pausedUntil: 0, lastError: null, hits: 0, misses: 0 },
  tablebase: { pausedUntil: 0, lastError: null, hits: 0, misses: 0 },
};

export function lichessStatus() {
  const now = Date.now();
  const f = (s) => ({ ...s, paused: s.pausedUntil > now, resumeInSec: Math.max(0, Math.ceil((s.pausedUntil - now) / 1000)) });
  return { cloud: f(state.cloud), tablebase: f(state.tablebase) };
}

export function resetLichessState() {
  for (const s of Object.values(state)) Object.assign(s, { pausedUntil: 0, lastError: null, hits: 0, misses: 0 });
}

function pause(s, seconds, reason) {
  s.pausedUntil = Date.now() + seconds * 1000;
  s.lastError = reason;
}

async function lichessGet(s, url) {
  if (Date.now() < s.pausedUntil) return null;
  try {
    const r = await getJson(url, {
      retries: 0, timeoutMs: config.lichess.timeoutMs, skipIfBusy: true, noRetryStatuses: [429],
    });
    if (r === SKIPPED) return null; // Lichess déjà occupé (ex. import en cours) : Stockfish prend le relais
    if (r.status === 429) { pause(s, config.lichess.pauseAfterRateLimitSec, 'limite de débit (429)'); return null; }
    if (r.status === 404) return { notFound: true };
    if (!r.ok || !r.json) { pause(s, config.lichess.pauseAfterErrorSec, `HTTP ${r.status}`); return null; }
    return { json: r.json };
  } catch (e) {
    pause(s, config.lichess.pauseAfterErrorSec, e.message);
    return null;
  }
}

/**
 * Analyse cloud Lichess. Renvoie { depth, lines:[{move, cp, mate, pv}] } (scores du point de vue du joueur au trait),
 * { notFound: true } si la position est inconnue, ou null si Lichess est indisponible.
 */
export async function cloudEval(fen, multiPv = 2) {
  if (!config.lichess.cloudEval) return null;
  const s = state.cloud;
  const url = `https://lichess.org/api/cloud-eval?fen=${encodeURIComponent(fen)}&multiPv=${multiPv}`;
  const r = await lichessGet(s, url);
  if (!r) return null;
  if (r.notFound) { s.misses++; return { notFound: true }; }
  const sign = fen.split(' ')[1] === 'b' ? -1 : 1; // Lichess donne les scores du point de vue des Blancs
  const lines = [];
  for (const pv of r.json.pvs ?? []) {
    const raw = String(pv.moves ?? '').split(' ').filter(Boolean);
    if (!raw.length) continue;
    const first = canonicalUci(fen, raw[0]);
    if (!first) continue;
    lines.push({
      move: first,
      cp: Number.isFinite(pv.cp) ? sign * pv.cp : null,
      mate: Number.isFinite(pv.mate) ? sign * pv.mate : null,
      pv: [first, ...raw.slice(1)],
      depth: r.json.depth,
    });
  }
  if (!lines.length) return { notFound: true };
  s.hits++;
  return { depth: r.json.depth, lines, knodes: r.json.knodes };
}

// Catégories de la table vues par le joueur qui doit jouer après le coup -> résultat pour celui qui joue le coup.
const FLIP = {
  win: 'loss', loss: 'win', 'maybe-win': 'loss', 'maybe-loss': 'win',
  'cursed-win': 'draw', 'blessed-loss': 'draw', draw: 'draw',
};
const OWN = {
  win: 'win', loss: 'loss', 'maybe-win': 'win', 'maybe-loss': 'loss',
  'cursed-win': 'draw', 'blessed-loss': 'draw', draw: 'draw',
};

/**
 * Tables de finales Lichess (Syzygy 7 pièces). Renvoie { wdl, lines:[{move, wdl, dtz, dtm}] } du point de vue
 * du joueur au trait (lignes triées du meilleur au pire coup), { notFound: true } ou null.
 */
export async function tablebaseProbe(fen) {
  if (!config.lichess.tablebase) return null;
  const s = state.tablebase;
  const r = await lichessGet(s, `https://tablebase.lichess.ovh/standard?fen=${encodeURIComponent(fen)}`);
  if (!r) return null;
  if (r.notFound) { s.misses++; return { notFound: true }; }
  const j = r.json;
  const wdl = OWN[j.category];
  if (!wdl) { s.misses++; return { notFound: true }; } // catégorie « unknown »
  const lines = [];
  for (const m of j.moves ?? []) {
    const mw = FLIP[m.category];
    if (!mw) return { notFound: true };
    lines.push({ move: m.uci, wdl: mw, dtz: m.dtz ?? null, dtm: m.dtm ?? null, pv: [m.uci], san: m.san });
  }
  s.hits++;
  return { wdl, dtz: j.dtz ?? null, dtm: j.dtm ?? null, lines };
}
