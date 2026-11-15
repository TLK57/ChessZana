// Compare notre classement des coups aux bilans « Game Review » de chess.com recopiés dans
// test/fixtures/chesscom-reviews.json. Rien n'est modifié : les évaluations enregistrées sont reclassées en mémoire,
// avec le style chess.com puis avec la méthode Lichess.
//
// Les analyses sont lues dans votre base (lecture seule) ; à défaut, dans le fichier de test indiqué par « fixture ».
// Indicateur principal : fautes sérieuses (erreurs + occasions manquées + gaffes) par joueur, objectif ±1.
//
//   npm run compare-chesscom
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';
import { config } from '../src/config.js';
import { classifyGame, judgeLichess, scoreFromWin } from '../src/analysis/classify.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const REVIEWS = process.argv[2] ?? path.join(FIXTURES, 'chesscom-reviews.json');

export const CATEGORIES = ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'miss', 'blunder'];
const LABEL = {
  brilliant: 'Brillant', great: 'Très bon', best: 'Meilleur', excellent: 'Excellent', good: 'Bon', book: 'Théorie',
  inaccuracy: 'Imprécision', mistake: 'Erreur', miss: 'Occasion manquée', blunder: 'Gaffe',
};
export const SERIOUS = ['mistake', 'miss', 'blunder'];
export const TOLERANCE = 1;

const parse = (j) => (j == null ? null : typeof j === 'string' ? JSON.parse(j) : j);
const gameNumber = (url) => /(\d+)\/?$/.exec(url ?? '')?.[1];

/** Analyse d'une partie dans la base : passe profonde si elle existe, sinon rapide. */
function fromDb(db, review) {
  const num = gameNumber(review.url);
  const game = db.prepare("SELECT id, white_elo, black_elo, time_class FROM games WHERE url LIKE ?").get(`%/${num}`);
  if (!game) return null;
  for (const pass of ['deep', 'quick']) {
    const rows = db.prepare(`SELECT ma.*, gm.uci, gm.san, gm.color, gm.fen_before FROM move_analysis ma
        JOIN game_moves gm ON gm.game_id = ma.game_id AND gm.ply = ma.ply WHERE ma.game_id = ? AND ma.pass = ? ORDER BY ma.ply`).all(game.id, pass);
    if (rows.length && rows.every((r) => r.eval_best && r.eval_played)) {
      return { source: `votre base (partie ${game.id}, passe ${pass === 'deep' ? 'profonde' : 'rapide'})`, rows,
        players: { w: { elo: game.white_elo }, b: { elo: game.black_elo }, timeClass: game.time_class } };
    }
  }
  return null;
}

/** Analyse d'une partie dans un fichier de test (PGN + analyses enregistrées, voir test/fixtures/games). */
function fromFixture(review) {
  if (!review.fixture) return null;
  const f = JSON.parse(fs.readFileSync(path.join(FIXTURES, review.fixture), 'utf8'));
  const chess = new Chess();
  chess.loadPgn(f.pgn);
  const header = chess.getHeaders();
  const replay = new Chess();
  const moves = chess.history({ verbose: true }).map((m) => {
    const fen = replay.fen();
    replay.move(m);
    return { uci: m.from + m.to + (m.promotion ?? ''), san: m.san, color: m.color, fen_before: fen };
  });
  const analysis = f.analyses.deep ?? f.analyses.quick;
  const rows = analysis.map((r) => ({ ...r, ...moves[r.ply - 1] }));
  return { source: `fichier de test ${review.fixture}`, rows,
    players: { w: { elo: Number(header.WhiteElo) || null }, b: { elo: Number(header.BlackElo) || null }, timeClass: review.timeClass ?? null } };
}

const toList = (analysis) => analysis.rows.map((r) => ({
    color: r.color, uci: r.uci, san: r.san, fenBefore: r.fen_before, book: r.classification === 'book', bestUci: r.best_uci,
    evalBest: parse(r.eval_best), evalPlayed: parse(r.eval_played), evalSecond: parse(r.eval_second) ?? scoreFromWin(r.win_second),
}));

/** Compte des catégories par couleur, avec une méthode (« chesscom » ou « lichess »). */
export function ourCounts(analysis, method) {
  const list = toList(analysis);
  const judged = classifyGame(list, analysis.players, method);
  const counts = { w: {}, b: {} };
  judged.forEach((j, i) => { counts[list[i].color][j.classification] = (counts[list[i].color][j.classification] ?? 0) + 1; });
  return counts;
}

/** Précision de la partie (méthode Lichess), recalculée à partir des évaluations enregistrées. */
const ourAccuracy = (analysis) => judgeLichess(toList(analysis)).accuracy;

export const serious = (c) => SERIOUS.reduce((s, k) => s + (c[k] ?? 0), 0);

const pad = (s, n) => String(s).padEnd(n);
const num = (v) => (v == null ? '–' : String(v)).padStart(9);
const fr = (x) => (x == null ? '–' : x.toFixed(1).replace('.', ','));

function main() {
  const reviews = JSON.parse(fs.readFileSync(REVIEWS, 'utf8')).games;
  const db = fs.existsSync(config.dbPath) ? new DatabaseSync(config.dbPath, { readOnly: true }) : null;
  const score = { chesscom: { ok: 0, n: 0, diff: 0 }, lichess: { ok: 0, n: 0, diff: 0 } };
  for (const review of reviews) {
    const analysis = (db && fromDb(db, review)) ?? fromFixture(review);
    console.log(`\n=== ${review.note ?? review.url}`);
    if (!analysis) { console.log('  pas d\'analyse trouvée (analysez la partie dans l\'application, ou indiquez « fixture »)'); continue; }
    console.log(`  analyse : ${analysis.source}`);
    const withCurves = ourCounts(analysis, 'chesscom');
    const lichess = ourCounts(analysis, 'lichess');
    const acc = ourAccuracy(analysis);
    for (const [color, side] of [['w', 'white'], ['b', 'black']]) {
      const cc = review[side];
      console.log(`\n  ${color === 'w' ? 'Blancs' : 'Noirs'}${analysis.players[color].elo ? ` (${analysis.players[color].elo})` : ''}`);
      console.log(`    ${pad('', 18)}${'chess.com'.padStart(9)}${'style cc'.padStart(9)}${'Lichess'.padStart(9)}`);
      for (const k of CATEGORIES) {
        if (cc[k] == null && !withCurves[color][k] && !lichess[color][k]) continue;
        console.log(`    ${pad(LABEL[k], 18)}${num(cc[k])}${num(withCurves[color][k] ?? 0)}${num(lichess[color][k] ?? 0)}`);
      }
      const ref = serious(cc);
      const line = (c) => { const v = serious(c); return `${num(v)}`; };
      console.log(`    ${pad('Fautes sérieuses', 18)}${num(ref)}${line(withCurves[color])}${line(lichess[color])}`);
      console.log(`    ${pad('Précision', 18)}${fr(cc.accuracy).padStart(9)}${fr(acc?.[side]).padStart(9)}${''.padStart(9)}   (non comparables, voir README)`);
      for (const [key, c] of [['chesscom', withCurves[color]], ['lichess', lichess[color]]]) {
        const d = Math.abs(serious(c) - ref);
        score[key].n++; score[key].diff += d; if (d <= TOLERANCE) score[key].ok++;
      }
    }
  }
  console.log('\n=== Bilan : fautes sérieuses (erreurs + occasions manquées + gaffes) à ±1 de chess.com');
  for (const [key, label] of [['chesscom', 'style chess.com'], ['lichess', 'méthode Lichess']]) {
    const s = score[key];
    if (s.n) console.log(`  ${pad(label, 28)} ${s.ok}/${s.n} joueurs dans la tolérance, écart moyen ${fr(s.diff / s.n)}`);
  }
  db?.close();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
