// Calibrage de l'Elo estimé sur les parties de l'utilisateur.
//
// La table générique (précision -> Elo, voir README) ne connaît pas votre niveau : selon la cadence et la
// profondeur d'analyse, elle peut se tromper de plusieurs centaines de points. Le calibrage garde sa pente
// (combien d'Elo vaut un point de précision) mais la recentre sur votre niveau réel :
//
//   Elo estimé calibré = Elo de la table générique + décalage de la cadence
//
// Le décalage d'une cadence est la MÉDIANE de (Elo réel - Elo de la table) sur toutes vos parties analysées de
// cette cadence, en comptant aussi vos adversaires (leur Elo réel est connu). La médiane résiste aux parties
// atypiques (une partie contre un robot, une partie très courte). Il faut au moins `calibrationMinPoints`
// points pour une cadence ; sinon on prend le décalage toutes cadences confondues ; sinon pas de calibrage.
import { getDb } from '../db.js';
import { config } from '../config.js';
import { estimateElo } from '../analysis/formulas.js';
import { ensureStatsSchema } from './compute.js';

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const generic = (accuracy) => estimateElo(accuracy, Infinity);

/** points : [{ accuracy, elo, timeClass }] -> { global: {offset, n}, byTimeClass: { blitz: {offset, n}, ... } } */
export function fitCalibration(points, minPoints = config.elo.calibrationMinPoints ?? 15) {
  const usable = points.filter((p) => Number.isFinite(p.accuracy) && Number.isFinite(p.elo) && p.elo > 0 && generic(p.accuracy) != null);
  const fit = (ps) => ({ offset: median(ps.map((p) => p.elo - generic(p.accuracy))), n: ps.length });
  const byTimeClass = {};
  const groups = new Map();
  for (const p of usable) groups.set(p.timeClass, [...(groups.get(p.timeClass) ?? []), p]);
  for (const [tc, ps] of groups) if (ps.length >= minPoints) byTimeClass[tc] = fit(ps);
  return { global: usable.length >= minPoints ? fit(usable) : { offset: null, n: usable.length }, byTimeClass, minPoints };
}

export function applyCalibration(cal, accuracy, timeClass, movesPlayed = Infinity) {
  const base = estimateElo(accuracy, movesPlayed);
  if (base == null) return null;
  if (!cal || config.elo.calibrate === false) return base;
  const offset = cal.byTimeClass?.[timeClass]?.offset ?? cal.global?.offset;
  if (offset == null) return base;
  return Math.max(100, Math.round((base + offset) / 10) * 10);
}

let cache = { key: null, cal: null };

/** Calibrage courant (recalculé seulement quand les statistiques des parties changent). */
export function getCalibration() {
  ensureStatsSchema();
  const d = getDb();
  const k = d.prepare('SELECT COUNT(*) AS n, MAX(computed_at) AS m FROM game_stats').get();
  const key = `${k.n}|${k.m}|${config.elo.calibrationMinPoints}`;
  if (cache.key === key) return cache.cal;
  const minMoves = config.elo.minMoves;
  const rows = d.prepare('SELECT accuracy, opp_accuracy, my_elo, opp_elo, time_class, my_moves FROM game_stats WHERE my_moves >= ?').all(minMoves);
  const points = [];
  for (const r of rows) {
    points.push({ accuracy: r.accuracy, elo: r.my_elo, timeClass: r.time_class });
    points.push({ accuracy: r.opp_accuracy, elo: r.opp_elo, timeClass: r.time_class });
  }
  cache = { key, cal: fitCalibration(points) };
  return cache.cal;
}

/** Elo estimé calibré d'une partie (null si trop peu de coups, comme l'estimation générique). */
export function calibratedElo(accuracy, timeClass, movesPlayed = Infinity) {
  return applyCalibration(getCalibration(), accuracy, timeClass, movesPlayed);
}

/** Résumé lisible pour l'interface. */
export function calibrationInfo() {
  const cal = getCalibration();
  return {
    enabled: config.elo.calibrate !== false && cal.global.offset != null,
    points: cal.global.n,
    minPoints: cal.minPoints,
    global: cal.global.offset != null ? Math.round(cal.global.offset) : null,
    byTimeClass: Object.fromEntries(Object.entries(cal.byTimeClass).map(([k, v]) => [k, { offset: Math.round(v.offset), n: v.n }])),
  };
}
