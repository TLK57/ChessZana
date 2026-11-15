// Ajuste le style chess.com sur vos bilans chess.com saisis à la main (écran d'une partie → « Bilan chess.com »),
// puis enregistre les réglages trouvés dans data/style-chesscom.json (lu au démarrage de l'application).
// Les évaluations enregistrées sont reclassées en mémoire : votre base n'est pas modifiée (lecture seule).
//
//   npm run ajuster-chesscom                          ajuste et enregistre
//   npm run ajuster-chesscom -- --essai               ajuste et affiche, sans rien enregistrer
//   npm run ajuster-chesscom -- --fichier bilans.json ajoute les bilans d'un fichier JSON (format de
//                                                     test/fixtures/chesscom-reviews.json, lu par défaut)
//   npm run ajuster-chesscom -- --detail              affiche aussi les chiffres de chaque joueur
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { REVIEWS_FILE, referenceDataset, REVIEW_CATEGORIES } from '../src/analysis/reviews.js';
import { currentParams, fitStyle, writeStyleFile } from '../src/analysis/fitstyle.js';


const LABEL = {
  brilliant: 'Brillant', great: 'Très bon', best: 'Meilleur', excellent: 'Excellent', good: 'Bon', book: 'Théorie',
  inaccuracy: 'Imprécision', mistake: 'Erreur', miss: 'Occasion manquée', blunder: 'Gaffe',
};
const fr = (x, d = 1) => (x == null ? '–' : x.toFixed(d).replace('.', ','));
const pad = (s, n) => String(s).padEnd(n);

/** Tableau des écarts moyens avant / après (texte). */
export function reportLines(result) {
  const { before, after } = result;
  const L = [];
  L.push(`  ${pad('Écart moyen par joueur', 30)}${'avant'.padStart(8)}${'après'.padStart(8)}`);
  L.push(`  ${pad('Précision (points)', 30)}${fr(before.mae.accuracy).padStart(8)}${fr(after.mae.accuracy).padStart(8)}`);
  L.push(`  ${pad('Fautes graves (coups)', 30)}${fr(before.mae.serious).padStart(8)}${fr(after.mae.serious).padStart(8)}`);
  for (const k of REVIEW_CATEGORIES) {
    if (before.mae.categories[k] == null) continue;
    L.push(`  ${pad(`${LABEL[k]} (coups)`, 30)}${fr(before.mae.categories[k]).padStart(8)}${fr(after.mae.categories[k]).padStart(8)}`);
  }
  return L;
}

function paramLines(start, params) {
  const f = (x) => String(x).replace('.', ',');
  return [
    `  Courbe : k1500 ${f(start.curve.k1500)} → ${f(params.curve.k1500)}, eloSlope ${f(start.curve.eloSlope)} → ${f(params.curve.eloSlope)}`,
    `  Précision : decay ${f(start.accuracy.decay)} → ${f(params.accuracy.decay)}, scale ${f(start.accuracy.scale)} → ${f(params.accuracy.scale)}, harmonicWeight ${f(start.accuracy.harmonicWeight)} → ${f(params.accuracy.harmonicWeight)}`,
  ];
}

async function main() {
  const args = process.argv.slice(2);
  const essai = args.includes('--essai');
  const detail = args.includes('--detail');
  const fi = args.indexOf('--fichier');
  const file = fi >= 0 ? path.resolve(args[fi + 1] ?? '') : REVIEWS_FILE;
  if (!fs.existsSync(config.dbPath)) { console.error(`Base introuvable : ${config.dbPath}`); process.exit(1); }
  const db = new DatabaseSync(config.dbPath, { readOnly: true });
  const { games, missing } = referenceDataset(db, { file });
  db.close();
  console.log(`\nAjustement du style chess.com : ${games.length} partie(s) de référence.`);
  for (const m of missing) console.log(`  (pas encore analysée, ignorée : ${m})`);
  if (!games.length) {
    console.log('Saisissez des bilans chess.com (écran d\'une partie → « Bilan chess.com »), puis relancez.');
    return;
  }
  if (games.length < 10) console.log(`  Attention : avec moins de 10 parties, les réglages trouvés restent fragiles.`);
  const start = currentParams();
  let last = 0;
  const result = await fitStyle(games, {
    start,
    onProgress: (done, total) => { const pct = Math.floor((100 * done) / total); if (pct >= last + 10) { last = pct; process.stdout.write(`  ${pct} %…`); } },
  });
  console.log('\n');
  for (const l of reportLines(result)) console.log(l);
  console.log('');
  for (const l of paramLines(start, result.params)) console.log(l);
  if (detail) {
    console.log('\n  Détail (chess.com / nous, après ajustement) :');
    for (const p of result.after.players) {
      const cats = REVIEW_CATEGORIES.filter((k) => p.ref[k] != null).map((k) => `${LABEL[k]} ${p.ref[k]}/${p.ours[k] ?? 0}`).join(', ');
      console.log(`  ${p.label}, ${p.side === 'white' ? 'Blancs' : 'Noirs'} : précision ${fr(p.ref.accuracy)}/${fr(p.ours.accuracy)} ; ${cats}`);
    }
  }
  if (essai) { console.log('\n  Essai : rien n\'a été enregistré.\n'); return; }
  const out = writeStyleFile(result, { games: games.length });
  console.log(`\n  Enregistré : ${out}`);
  console.log('  Relancez l\'application pour utiliser ces réglages (si le style chess.com est choisi, les parties seront reclassées).\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`Erreur : ${e.message}`); process.exit(1); });
}
