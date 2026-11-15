// Ajustement du style chess.com sur vos bilans chess.com saisis à la main (src/analysis/reviews.js).
// On cherche les 5 réglages qui rapprochent le plus nos chiffres de ceux de chess.com, sur vos propres parties :
//  - la courbe des points attendus (classification.curve : k1500, eloSlope) ;
//  - la précision (accuracy.chesscom : decay, scale, harmonicWeight).
// Les seuils (publiés par chess.com) ne bougent pas. Le résultat va dans data/style-chesscom.json, lu au démarrage.
import fs from 'node:fs';
import { config, styleFilePath } from '../config.js';
import { classifyChesscom } from './classify.js';
import { chesscomGameAccuracy, chesscomMoveAccuracy } from './formulas.js';
import { REVIEW_CATEGORIES, serious } from './reviews.js';

// Poids des écarts : 1 coup d'écart sur une imprécision, une erreur, une occasion manquée ou une gaffe compte
// autant que 3 points d'écart de précision. Les coups « théorie » ne dépendent pas des réglages : pas comptés.
export const ACCURACY_SCALE = 3;
export const WEIGHTS = {
  brilliant: 0.5, great: 0.5, best: 0.25, excellent: 0.25, good: 0.25, book: 0,
  inaccuracy: 1, mistake: 1, miss: 1, blunder: 1,
};
// Rappel vers les valeurs de départ (écart « normal » de chaque réglage) : avec peu de parties, il évite des réglages
// absurdes ; avec beaucoup de parties, ce sont vos bilans qui décident.
const PRIOR = { lnK: 0.5, eloSlope: 0.5, lnDecay: 1, scale: 20, harmonicWeight: 0.5 };

/** Réglages actuels du style chess.com. */
export function currentParams() {
  const c = config.classification.curve;
  const a = config.accuracy.chesscom;
  return { curve: { k1500: c.k1500, eloSlope: c.eloSlope }, accuracy: { decay: a.decay, scale: a.scale, harmonicWeight: a.harmonicWeight } };
}

// Classement de toutes les parties avec une courbe : pour chaque joueur, nombre de coups par catégorie et pertes.
function classifyPlayers(dataset, curve) {
  const full = { ...config.classification.curve, ...curve };
  const players = [];
  for (const g of dataset) {
    const judged = classifyChesscom(g.list, g.players, { curve: full });
    for (const [color, side] of [['w', 'white'], ['b', 'black']]) {
      const counts = {};
      const losses = [];
      judged.forEach((j, i) => {
        if (g.list[i].color !== color) return;
        counts[j.classification] = (counts[j.classification] ?? 0) + 1;
        losses.push(j.loss);
      });
      players.push({ game: g, color, side, ref: g.ref[side] ?? {}, counts, losses });
    }
  }
  return players;
}

const playerAccuracy = (losses, p) => chesscomGameAccuracy(losses.map((loss) => ({ color: 'w', accuracy: chesscomMoveAccuracy(loss, p) })), p).white;

function countsError(players) {
  let e = 0;
  for (const pl of players) {
    for (const k of REVIEW_CATEGORIES) if (pl.ref[k] != null) e += WEIGHTS[k] * ((pl.counts[k] ?? 0) - pl.ref[k]) ** 2;
  }
  return e;
}

function accuracyError(players, p) {
  let e = 0;
  for (const pl of players) {
    if (pl.ref.accuracy == null || !pl.losses.length) continue;
    e += ((playerAccuracy(pl.losses, p) - pl.ref.accuracy) / ACCURACY_SCALE) ** 2;
  }
  return e;
}

// Réglages sous forme de nombres libres (pour l'optimisation) et retour.
const toVector = (p) => [Math.log(p.curve.k1500), p.curve.eloSlope, Math.log(p.accuracy.decay), Math.log(Math.max(1e-3, p.accuracy.scale - 100)), Math.log(p.accuracy.harmonicWeight / (1 - p.accuracy.harmonicWeight))];
const clampV = (v) => [Math.min(Math.log(2), Math.max(Math.log(0.02), v[0])), Math.min(3, Math.max(-1, v[1])), Math.min(Math.log(0.5), Math.max(Math.log(0.002), v[2])), Math.min(Math.log(200), Math.max(Math.log(1e-3), v[3])), Math.min(8, Math.max(-8, v[4]))];
const fromVector = (v) => {
  const [lk, s, ld, ls, lh] = clampV(v);
  return { curve: { k1500: Math.exp(lk), eloSlope: s }, accuracy: { decay: Math.exp(ld), scale: 100 + Math.exp(ls), harmonicWeight: 1 / (1 + Math.exp(-lh)) } };
};

function priorError(p, start) {
  return ((Math.log(p.curve.k1500) - Math.log(start.curve.k1500)) / PRIOR.lnK) ** 2
    + ((p.curve.eloSlope - start.curve.eloSlope) / PRIOR.eloSlope) ** 2
    + ((Math.log(p.accuracy.decay) - Math.log(start.accuracy.decay)) / PRIOR.lnDecay) ** 2
    + ((p.accuracy.scale - start.accuracy.scale) / PRIOR.scale) ** 2
    + ((p.accuracy.harmonicWeight - start.accuracy.harmonicWeight) / PRIOR.harmonicWeight) ** 2;
}

/** Méthode du simplexe (Nelder–Mead) : minimum local d'une fonction de plusieurs nombres, sans dérivée. */
export function nelderMead(f, x0, { step = 0.3, iterations = 300 } = {}) {
  const n = x0.length;
  let simplex = [x0, ...x0.map((_, i) => x0.map((x, j) => (i === j ? x + step : x)))].map((x) => ({ x, f: f(x) }));
  for (let it = 0; it < iterations; it++) {
    simplex.sort((a, b) => a.f - b.f);
    const best = simplex[0], worst = simplex[n], second = simplex[n - 1];
    if (Math.abs(worst.f - best.f) < 1e-9) break;
    const c = Array.from({ length: n }, (_, j) => simplex.slice(0, n).reduce((s, p) => s + p.x[j], 0) / n);
    const at = (t) => { const x = c.map((cj, j) => cj + t * (worst.x[j] - cj)); return { x, f: f(x) }; };
    const r = at(-1);
    if (r.f < best.f) { const e = at(-2); simplex[n] = e.f < r.f ? e : r; continue; }
    if (r.f < second.f) { simplex[n] = r; continue; }
    const k = at(r.f < worst.f ? -0.5 : 0.5);
    if (k.f < Math.min(r.f, worst.f)) { simplex[n] = k; continue; }
    simplex = simplex.map((p, i) => (i === 0 ? p : (() => { const x = p.x.map((xj, j) => best.x[j] + 0.5 * (xj - best.x[j])); return { x, f: f(x) }; })()));
  }
  simplex.sort((a, b) => a.f - b.f);
  return simplex[0];
}

/**
 * Écarts entre nos chiffres (style chess.com, avec ces réglages) et les bilans chess.com.
 * Renvoie { players: [{ label, side, ours, ref }], mae: { accuracy, serious, categories: { … } }, n }.
 */
export function evaluate(dataset, params) {
  const players = classifyPlayers(dataset, params.curve);
  const diffs = { accuracy: [], serious: [] };
  for (const k of REVIEW_CATEGORIES) diffs[k] = [];
  const rows = players.map((pl) => {
    const accuracy = pl.losses.length ? playerAccuracy(pl.losses, params.accuracy) : null;
    if (pl.ref.accuracy != null && accuracy != null) diffs.accuracy.push(Math.abs(accuracy - pl.ref.accuracy));
    for (const k of REVIEW_CATEGORIES) if (pl.ref[k] != null) diffs[k].push(Math.abs((pl.counts[k] ?? 0) - pl.ref[k]));
    if (['mistake', 'miss', 'blunder'].every((k) => pl.ref[k] != null)) diffs.serious.push(Math.abs(serious(pl.counts) - serious(pl.ref)));
    return { label: pl.game.label, gameId: pl.game.gameId, side: pl.side, ours: { ...pl.counts, accuracy }, ref: pl.ref };
  });
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const categories = Object.fromEntries(REVIEW_CATEGORIES.map((k) => [k, mean(diffs[k])]));
  return { players: rows, mae: { accuracy: mean(diffs.accuracy), serious: mean(diffs.serious), categories }, n: players.length };
}

/**
 * Ajuste les 5 réglages sur les parties de référence. Deux temps :
 *  1. une grille sur la courbe (k1500 de 0,05 à 0,8, eloSlope de −0,5 à 1,5) ; pour chaque courbe, les réglages de la
 *     précision sont ajustés par la méthode du simplexe ;
 *  2. un affinage des 5 réglages ensemble, à partir du meilleur point de la grille.
 * Renvoie (promesse) { params, before, after } (écarts avant et après).
 */
export async function fitStyle(dataset, { start = currentParams(), onProgress } = {}) {
  if (!dataset.length) throw new Error('Aucune partie de référence : saisissez d\'abord des bilans chess.com.');
  const total = (p) => {
    const players = classifyPlayers(dataset, p.curve);
    return countsError(players) + accuracyError(players, p.accuracy) + priorError(p, start);
  };
  let best = { params: start, f: total(start) };
  const ks = Array.from({ length: 25 }, (_, i) => Math.exp(Math.log(0.05) + (i * (Math.log(0.8) - Math.log(0.05))) / 24));
  const slopes = Array.from({ length: 21 }, (_, i) => -0.5 + i * 0.1);
  let done = 0;
  for (const k1500 of ks) {
    for (const eloSlope of slopes) {
      const curve = { k1500, eloSlope };
      const players = classifyPlayers(dataset, curve);
      const fixed = countsError(players);
      if (fixed < best.f) {
        // Précision : 3 réglages ajustés pour cette courbe (les pertes de chaque coup sont déjà connues).
        const g = (v) => { const p = fromVector([Math.log(k1500), eloSlope, ...v]); return accuracyError(players, p.accuracy) + priorError(p, start); };
        const r = nelderMead(g, toVector(best.params).slice(2), { iterations: 120 });
        const p = fromVector([Math.log(k1500), eloSlope, ...r.x]);
        const f = fixed + r.f;
        if (f < best.f) best = { params: p, f };
      }
      onProgress?.(++done, ks.length * slopes.length + 1);
    }
    await new Promise((res) => setImmediate(res)); // laisse le serveur répondre entre deux lignes de la grille
  }
  const refined = nelderMead((v) => total(fromVector(v)), toVector(best.params), { step: 0.15, iterations: 200 });
  if (refined.f < best.f) best = { params: fromVector(refined.x), f: refined.f };
  onProgress?.(ks.length * slopes.length + 1, ks.length * slopes.length + 1);
  const round = (x) => Math.round(x * 1e4) / 1e4;
  const params = {
    curve: { k1500: round(best.params.curve.k1500), eloSlope: round(best.params.curve.eloSlope) },
    accuracy: { decay: round(best.params.accuracy.decay), scale: round(best.params.accuracy.scale), harmonicWeight: round(best.params.accuracy.harmonicWeight) },
  };
  return { params, before: evaluate(dataset, start), after: evaluate(dataset, params) };
}

/** Enregistre les réglages ajustés dans data/style-chesscom.json (lu au démarrage de l'application). */
export function writeStyleFile(result, { games, dataDir = config.dataDir } = {}) {
  const file = styleFilePath(dataDir);
  const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
  const summary = (e) => ({ precision: r1(e.mae.accuracy), fautesGraves: r1(e.mae.serious), ...Object.fromEntries(Object.entries(e.mae.categories).map(([k, v]) => [k, r1(v)])) });
  const data = {
    _aide: 'Réglages du style chess.com ajustés sur vos bilans chess.com (npm run ajuster-chesscom, ou écran Importer). Supprimez ce fichier pour revenir aux valeurs de config.json.',
    curve: result.params.curve,
    accuracy: result.params.accuracy,
    ajustement: {
      date: new Date().toISOString().slice(0, 10),
      parties: games, joueurs: result.after.n,
      ecartMoyenAvant: summary(result.before), ecartMoyenApres: summary(result.after),
    },
  };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}

/** Dernier ajustement enregistré (ou null). */
export function lastFit(dataDir = config.dataDir) {
  try { return JSON.parse(fs.readFileSync(styleFilePath(dataDir), 'utf8')).ajustement ?? null; } catch { return null; }
}
