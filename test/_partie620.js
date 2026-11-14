// Charge la partie 620 de Dilo56 (test/fixtures/games/partie-620.json) dans la base de test, avec ses analyses
// enregistrées (passes rapide et profonde), pour tester le classement sans moteur.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from '../src/db.js';
import { importPgnText } from '../src/importers/pgnfile.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'games', 'partie-620.json');
export const partie620 = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

// Numéro de demi-coup à partir de la notation « 20. » (Blancs) ou « 27... » (Noirs).
export const ply = (label) => {
  const m = /^(\d+)(\.\.\.|\.)$/.exec(label);
  return (Number(m[1]) - 1) * 2 + (m[2] === '.' ? 1 : 2);
};

export async function loadPartie620() {
  const r = await importPgnText(partie620.pgn);
  const id = r.ids[0];
  const d = getDb();
  d.prepare('DELETE FROM move_analysis WHERE game_id = ?').run(id);
  d.prepare('DELETE FROM game_analysis WHERE game_id = ?').run(id);
  const cols = Object.keys(partie620.analyses.deep[0]);
  for (const [pass, rows] of Object.entries(partie620.analyses)) {
    const ins = d.prepare(`INSERT INTO move_analysis(game_id, pass, ${cols.join(', ')}) VALUES (?, ?, ${cols.map(() => '?').join(', ')})`);
    for (const row of rows) {
      ins.run(id, pass, ...cols.map((c) => (c === 'eval_best' || c === 'eval_played' ? JSON.stringify(row[c]) : row[c])));
    }
    d.prepare("INSERT INTO game_analysis(game_id, pass, depth, verify_depth, analyzed_at) VALUES (?, ?, 15, ?, datetime('now'))")
      .run(id, pass, pass === 'deep' ? 22 : null);
  }
  return id;
}

/** Classement enregistré d'un coup (« 20. », « 27... »). */
export function classOf(id, label, pass = 'deep') {
  return getDb().prepare('SELECT classification FROM move_analysis WHERE game_id = ? AND pass = ? AND ply = ?').get(id, pass, ply(label))?.classification;
}

/** Nombre de coups par catégorie et par couleur, pour une passe. */
export function countsOf(id, pass = 'deep') {
  const out = { w: {}, b: {} };
  for (const r of getDb().prepare(`SELECT gm.color, ma.classification AS c FROM move_analysis ma
      JOIN game_moves gm ON gm.game_id = ma.game_id AND gm.ply = ma.ply WHERE ma.game_id = ? AND ma.pass = ?`).all(id, pass)) {
    out[r.color][r.c] = (out[r.color][r.c] ?? 0) + 1;
  }
  return out;
}
