// Bilans chess.com (« Game Review ») saisis à la main pour une partie déjà importée : précision et nombre de coups
// par catégorie, pour chaque joueur. Ils servent à comparer nos méthodes à chess.com et à ajuster le style chess.com
// (src/analysis/fitstyle.js). Rien n'est jamais lu sur chess.com : seulement les chiffres que vous saisissez.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';
import { getDb, getMeta, setMeta } from '../db.js';
import { storedMoves } from './reclassify.js';

/** Bilans recopiés à la main dans un fichier avant la saisie dans l'application (format { games: [{ url, white, black }] }). */
export const REVIEWS_FILE = path.join(ROOT, 'test', 'fixtures', 'chesscom-reviews.json');

/** Catégories du bilan chess.com, dans l'ordre de leur page. */
export const REVIEW_CATEGORIES = ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'miss', 'blunder'];
/** Fautes graves : erreurs, occasions manquées et gaffes. */
export const SERIOUS = ['mistake', 'miss', 'blunder'];
export const serious = (c) => SERIOUS.reduce((s, k) => s + (c?.[k] ?? 0), 0);

const num = (v) => {
  if (v == null || v === '') return null;
  const x = typeof v === 'number' ? v : Number(String(v).trim().replace(',', '.').replace('%', ''));
  return Number.isFinite(x) ? x : NaN;
};

/**
 * Bilan d'un joueur nettoyé : { accuracy?, brilliant?, … } (les cases vides sont ignorées).
 * Lève une erreur claire si une valeur est impossible (précision hors de 0–100, nombre de coups négatif ou décimal).
 */
export function cleanSide(side = {}, who = 'joueur') {
  const out = {};
  const acc = num(side.accuracy);
  if (acc != null) {
    if (!(acc >= 0 && acc <= 100)) throw Object.assign(new Error(`Précision du ${who} : un nombre entre 0 et 100`), { status: 400 });
    out.accuracy = Math.round(acc * 10) / 10;
  }
  for (const k of REVIEW_CATEGORIES) {
    const v = num(side[k]);
    if (v == null) continue;
    if (!(Number.isInteger(v) && v >= 0 && v <= 300)) throw Object.assign(new Error(`${k} (${who}) : un nombre entier de coups`), { status: 400 });
    out[k] = v;
  }
  return out;
}

const isEmpty = (side) => Object.keys(side).length === 0;

/** Bilan enregistré d'une partie, ou null. */
export function getReview(gameId, db = getDb()) {
  const r = db.prepare('SELECT white, black, updated_at FROM chesscom_reviews WHERE game_id = ?').get(gameId);
  return r ? { white: JSON.parse(r.white), black: JSON.parse(r.black), updatedAt: r.updated_at } : null;
}

/** Enregistre (ou efface, si tout est vide) le bilan chess.com d'une partie. */
export function saveReview(gameId, { white, black } = {}, db = getDb()) {
  if (!db.prepare('SELECT 1 FROM games WHERE id = ?').get(gameId)) throw Object.assign(new Error('Partie introuvable'), { status: 404 });
  const w = cleanSide(white, 'joueur avec les Blancs');
  const b = cleanSide(black, 'joueur avec les Noirs');
  if (isEmpty(w) && isEmpty(b)) {
    db.prepare('DELETE FROM chesscom_reviews WHERE game_id = ?').run(gameId);
    return null;
  }
  db.prepare(`INSERT INTO chesscom_reviews(game_id, white, black, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(game_id) DO UPDATE SET white = excluded.white, black = excluded.black, updated_at = excluded.updated_at`)
    .run(gameId, JSON.stringify(w), JSON.stringify(b));
  return getReview(gameId, db);
}

const gameNumber = (url) => /(\d+)\/?$/.exec(url ?? '')?.[1];

/**
 * Bilans de référence : ceux saisis dans l'application, plus ceux d'un fichier JSON au format
 * { games: [{ url, white: {…}, black: {…} }] } (retrouvés dans la base par le numéro à la fin de l'adresse).
 * Pour une même partie, la saisie dans l'application l'emporte.
 */
export function referenceReviews(db = getDb(), { file = null } = {}) {
  // Base pas encore mise à jour par l'application (script lancé avant) : pas encore de bilans saisis.
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chesscom_reviews'").get();
  const refs = (hasTable ? db.prepare('SELECT game_id, white, black FROM chesscom_reviews ORDER BY game_id').all() : [])
    .map((r) => ({ gameId: r.game_id, white: JSON.parse(r.white), black: JSON.parse(r.black), source: 'saisi dans l\'application' }));
  if (file && fs.existsSync(file)) {
    const seen = new Set(refs.map((r) => r.gameId));
    for (const g of JSON.parse(fs.readFileSync(file, 'utf8')).games ?? []) {
      const n = gameNumber(g.url);
      const row = n ? db.prepare('SELECT id FROM games WHERE url LIKE ?').get(`%/${n}`) : null;
      if (!row || seen.has(row.id)) continue;
      seen.add(row.id);
      refs.push({ gameId: row.id, white: cleanSide(g.white), black: cleanSide(g.black), source: 'fichier' });
    }
  }
  return refs;
}

/**
 * Reprend une fois dans la base les bilans d'un fichier (ceux de vos parties qui y sont importées et qui n'ont pas
 * encore de bilan saisi). Renvoie le nombre de bilans repris.
 */
export function importReviewsFile(file = REVIEWS_FILE, db = getDb()) {
  if (getMeta('chesscom_reviews_imported', '0') === '1') return 0;
  let n = 0;
  for (const r of referenceReviews(db, { file })) {
    if (r.source !== 'fichier') continue;
    saveReview(r.gameId, { white: r.white, black: r.black }, db);
    n++;
  }
  setMeta('chesscom_reviews_imported', '1');
  return n;
}

/**
 * Parties de référence prêtes pour l'ajustement : évaluations enregistrées (passe profonde de préférence), Elo des
 * joueurs et bilan chess.com. Les parties pas encore analysées sont listées à part.
 */
export function referenceDataset(db = getDb(), opts = {}) {
  const games = [];
  const missing = [];
  for (const ref of referenceReviews(db, opts)) {
    const g = db.prepare('SELECT id, white_name, black_name, white_elo, black_elo, time_class, played_at FROM games WHERE id = ?').get(ref.gameId);
    if (!g) continue;
    const stored = storedMoves(g.id, 'deep', db) ?? storedMoves(g.id, 'quick', db);
    const label = `${g.white_name} – ${g.black_name} (partie ${g.id})`;
    if (!stored) { missing.push(label); continue; }
    games.push({
      gameId: g.id, label, list: stored.list, ref,
      players: { w: { elo: g.white_elo }, b: { elo: g.black_elo }, timeClass: g.time_class },
    });
  }
  return { games, missing };
}
