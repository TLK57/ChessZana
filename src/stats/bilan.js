// « Bilan pour Claude » : résumé de mes N dernières parties analysées, prêt à coller sur claude.ai.
import { getDb } from '../db.js';
import { dashboard, lastGameIds, recurringErrors, timeStats } from './queries.js';
import { ensureStatsSchema } from './compute.js';

const pct = (x, d = 1) => (x == null ? 'n/d' : `${(100 * x).toFixed(d).replace('.', ',')} %`);
const num = (x, d = 1) => (x == null ? 'n/d' : x.toFixed(d).replace('.', ','));
const secs = (ms) => (ms == null ? 'n/d' : `${(ms / 1000).toFixed(1).replace('.', ',')} s`);
const TC = { bullet: 'bullet', blitz: 'blitz', rapid: 'rapide', classical: 'classique', daily: 'journalière' };

function openings(ids, color) {
  if (!ids.length) return [];
  return getDb().prepare(`SELECT opening_name AS name, COUNT(*) AS n,
        AVG(CASE outcome WHEN 'win' THEN 1.0 WHEN 'draw' THEN 0.5 ELSE 0 END) AS score, AVG(accuracy) AS acc
      FROM game_stats WHERE game_id IN (${ids.map(() => '?').join(',')}) AND my_color = ? AND opening_name IS NOT NULL
      GROUP BY opening_name ORDER BY n DESC LIMIT 4`).all(...ids, color);
}

export function bilanText(n = 25, filters = {}) {
  ensureStatsSchema();
  const ids = lastGameIds(filters, Math.max(1, Math.min(500, Number(n) || 25)));
  if (!ids.length) return { count: 0, text: "Aucune partie analysée pour le moment : analysez d'abord quelques parties." };
  const f = { ids };
  const db = dashboard(f);
  const t = timeStats(f);
  const errs = recurringErrors(f, { examples: 1 });
  const series = db.series;
  const first = series[0];
  const lastG = series[series.length - 1];
  const cadences = new Map();
  for (const g of series) cadences.set(g.timeClass, (cadences.get(g.timeClass) ?? 0) + 1);
  const mainTc = [...cadences.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const eloSeries = series.filter((g) => g.timeClass === mainTc && g.myElo);
  const oppAvg = series.filter((g) => g.oppElo).reduce((a, g) => a + g.oppElo, 0) / Math.max(1, series.filter((g) => g.oppElo).length);
  const { win, draw, loss } = db.results;
  const L = [];
  L.push("Bonjour ! Voici le bilan de mes dernières parties d'échecs, analysées par mon logiciel (Stockfish 19, classement des coups à la chess.com).");
  L.push('');
  L.push(`== Vue d'ensemble : ${db.count} parties, du ${first.playedAt?.slice(0, 10)} au ${lastG.playedAt?.slice(0, 10)} ==`);
  L.push(`Résultats : ${win} victoires, ${draw} nulles, ${loss} défaites (score ${pct((win + draw / 2) / db.count, 0)}).`);
  L.push(`Cadences : ${[...cadences.entries()].map(([k, v]) => `${TC[k] ?? k} ${v}`).join(', ')}.`);
  if (eloSeries.length) L.push(`Mon Elo réel en ${TC[mainTc] ?? mainTc} : ${eloSeries[0].myElo} → ${eloSeries[eloSeries.length - 1].myElo} ; Elo moyen des adversaires : ${Math.round(oppAvg)}.`);
  L.push(`Précision moyenne : ${num(db.avgAccuracy)} % ; Elo estimé moyen d'après la précision (calibré sur mes parties) : ${db.avgEstElo ? Math.round(db.avgEstElo) : 'n/d'}.`);
  L.push('');
  L.push('== Précision par phase de jeu (hors coups de théorie) ==');
  for (const ph of ['opening', 'middlegame', 'endgame']) L.push(`${db.phases[ph].label} : ${num(db.phases[ph].accuracy)} % (${db.phases[ph].moves} coups)`);
  L.push('');
  L.push('== Fautes par partie (moyenne) ==');
  L.push(`Gaffes ${num(db.perGame.blunder, 2)}, erreurs ${num(db.perGame.mistake, 2)}, occasions manquées ${num(db.perGame.miss, 2)}, imprécisions ${num(db.perGame.inaccuracy, 2)}.`);
  L.push('');
  L.push('== Ouvertures ==');
  for (const color of ['white', 'black']) {
    const o = openings(ids, color);
    L.push(`Avec les ${color === 'white' ? 'Blancs' : 'Noirs'} : ${o.length ? o.map((x) => `${x.name} (${x.n} parties, score ${pct(x.score, 0)}, précision ${num(x.acc)} %)`).join(' ; ') : 'aucune'}.`);
  }
  L.push('');
  L.push('== Mes erreurs récurrentes (erreurs, gaffes et occasions manquées) ==');
  errs.types.slice(0, 6).forEach((e, i) => L.push(`${i + 1}. ${e.label} : ${e.count} fois (${pct(e.share, 0)})`));
  L.push('');
  L.push('== Gestion du temps ==');
  L.push(`Avec moins de 30 s à la pendule : ${pct(t.lowClock.errorRate)} de coups ratés (erreur, gaffe ou occasion manquée) sur ${t.lowClock.moves} coups, contre ${pct(t.otherClock.errorRate)} sur ${t.otherClock.moves} coups le reste du temps.`);
  L.push(`Temps moyen par coup : ouverture ${secs(t.perPhase.opening)}, milieu de jeu ${secs(t.perPhase.middlegame)}, finale ${secs(t.perPhase.endgame)}.`);
  L.push(`Coups évidents (un seul coup raisonnable) joués trop lentement : ${t.slowSimple.count} sur ${t.simpleMoves}.`);
  L.push(`Parties perdues au temps alors que j'étais gagnant : ${t.lostOnTimeWinning.length}.`);
  L.push('');
  L.push('== 5 positions typiques de mes erreurs (FEN avant mon coup) ==');
  const examples = errs.types.flatMap((e) => e.examples.map((x) => ({ ...x, label: e.label }))).slice(0, 5);
  examples.forEach((x, i) => L.push(`${i + 1}. [${x.label}] ${x.fen} — j'ai joué ${x.san}, le meilleur coup était ${x.bestSan}.`));
  L.push('');
  L.push('Fais-moi un plan d\'entraînement de 4 semaines adapté à ces faiblesses.');
  return { count: db.count, text: L.join('\n') };
}
