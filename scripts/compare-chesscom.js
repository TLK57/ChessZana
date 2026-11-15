// Compare, catégorie par catégorie, nos deux méthodes de classement (Lichess et style chess.com) aux bilans
// « Game Review » de chess.com que vous avez saisis (écran d'une partie → « Bilan chess.com ») ou recopiés dans
// test/fixtures/chesscom-reviews.json. Rien n'est modifié : les évaluations enregistrées sont reclassées en mémoire.
// Indicateur principal : fautes graves (erreurs + occasions manquées + gaffes) par joueur, objectif ±1.
//
//   npm run compare-chesscom                  (bilans saisis + fichier de test)
//   npm run compare-chesscom -- bilans.json   (bilans saisis + un autre fichier)
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { chesscomAccuracy, classifyGame, judgeLichess } from '../src/analysis/classify.js';
import { REVIEW_CATEGORIES, SERIOUS, referenceDataset, serious } from '../src/analysis/reviews.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REVIEWS = process.argv[2] ?? path.join(ROOT, 'test', 'fixtures', 'chesscom-reviews.json');

export const CATEGORIES = REVIEW_CATEGORIES;
export { SERIOUS, serious };
export const TOLERANCE = 1;
const LABEL = {
  brilliant: 'Brillant', great: 'Très bon', best: 'Meilleur', excellent: 'Excellent', good: 'Bon', book: 'Théorie',
  inaccuracy: 'Imprécision', mistake: 'Erreur', miss: 'Occasion manquée', blunder: 'Gaffe',
};

/** Compte des catégories par couleur, avec une méthode (« chesscom » ou « lichess »). */
export function ourCounts(game, method) {
  const judged = classifyGame(game.list, game.players, method);
  const counts = { w: {}, b: {} };
  judged.forEach((j, i) => { counts[game.list[i].color][j.classification] = (counts[game.list[i].color][j.classification] ?? 0) + 1; });
  return counts;
}

const pad = (s, n) => String(s).padEnd(n);
const num = (v) => (v == null ? '–' : String(v)).padStart(10);
const fr = (x) => (x == null ? '–' : x.toFixed(1).replace('.', ','));

function main() {
  if (!fs.existsSync(config.dbPath)) { console.error(`Base introuvable : ${config.dbPath}`); process.exit(1); }
  const db = new DatabaseSync(config.dbPath, { readOnly: true });
  const { games, missing } = referenceDataset(db, { file: REVIEWS });
  db.close();
  for (const m of missing) console.log(`(pas encore analysée, ignorée : ${m})`);
  const score = { chesscom: { ok: 0, n: 0, diff: 0 }, lichess: { ok: 0, n: 0, diff: 0 } };
  for (const g of games) {
    console.log(`\n=== ${g.label}`);
    const cc = ourCounts(g, 'chesscom');
    const li = ourCounts(g, 'lichess');
    const accL = judgeLichess(g.list).accuracy;
    const accC = chesscomAccuracy(g.list, g.players);
    for (const [color, side] of [['w', 'white'], ['b', 'black']]) {
      const ref = g.ref[side];
      console.log(`\n  ${color === 'w' ? 'Blancs' : 'Noirs'}${g.players[color].elo ? ` (${g.players[color].elo})` : ''}`);
      console.log(`    ${pad('', 18)}${'chess.com'.padStart(10)}${'style cc'.padStart(10)}${'Lichess'.padStart(10)}`);
      for (const k of CATEGORIES) {
        if (ref[k] == null && !cc[color][k] && !li[color][k]) continue;
        console.log(`    ${pad(LABEL[k], 18)}${num(ref[k])}${num(cc[color][k] ?? 0)}${num(li[color][k] ?? 0)}`);
      }
      const known = SERIOUS.every((k) => ref[k] != null);
      console.log(`    ${pad('Fautes graves', 18)}${num(known ? serious(ref) : null)}${num(serious(cc[color]))}${num(serious(li[color]))}`);
      console.log(`    ${pad('Précision', 18)}${fr(ref.accuracy).padStart(10)}${fr(accC[side]).padStart(10)}${fr(accL[side]).padStart(10)}`);
      if (!known) continue;
      for (const [key, c] of [['chesscom', cc[color]], ['lichess', li[color]]]) {
        const d = Math.abs(serious(c) - serious(ref));
        score[key].n++; score[key].diff += d; if (d <= TOLERANCE) score[key].ok++;
      }
    }
  }
  console.log('\n=== Bilan : fautes graves (erreurs + occasions manquées + gaffes) à ±1 de chess.com');
  for (const [key, label] of [['chesscom', 'style chess.com'], ['lichess', 'méthode Lichess']]) {
    const s = score[key];
    if (s.n) console.log(`  ${pad(label, 18)} ${s.ok}/${s.n} joueurs dans la tolérance, écart moyen ${fr(s.diff / s.n)}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
