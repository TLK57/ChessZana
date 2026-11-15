// Chances de gain selon le niveau : courbes ajustées sur la base Lichess (npm run fit-curves).
import './_unit.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CURVES_FILE, curveFor, expectedPoints, loadCurves } from '../src/analysis/classify.js';
import { winPct } from '../src/analysis/formulas.js';
import { addGame, fitLogistic, parseEvals, speedOf, stripSkippableFrames } from '../scripts/fit-curves.js';

const real = JSON.parse(fs.readFileSync(CURVES_FILE, 'utf8'));
test.after(() => { loadCurves(''); });

test('fichier des courbes : source, mois, échantillon d\'au moins 200 000 parties, 18 tranches par cadence', () => {
  assert.match(real.source, /^https:\/\/database\.lichess\.org\/standard\/lichess_db_standard_rated_\d{4}-\d{2}\.pgn\.zst$/);
  assert.match(real.month, /^\d{4}-\d{2}$/);
  assert.match(real.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(real.sample.gamesWithEval >= 200000, String(real.sample.gamesWithEval));
  for (const tc of ['blitz', 'rapid']) {
    assert.equal(real.curves[tc].length, 18);
    assert.deepEqual(real.curves[tc].map((c) => c.elo), Array.from({ length: 18 }, (_, i) => 600 + 100 * i));
    for (const c of real.curves[tc]) assert.ok(c.b > 0, `${tc} ${c.elo} : pente positive`);
  }
  assert.ok(real.validation.logLoss.nouvelle < real.validation.logLoss.lichess, 'meilleure que la courbe Lichess sur les parties mises de côté');
});

test('courbe d\'un joueur : interpolation entre les tranches, bornes, cadences sans courbe propre', () => {
  const data = { curves: { blitz: [{ elo: 1000, a: 0, b: 0.2, mateWin: 0.9, mateLoss: 0.1 }, { elo: 1100, a: 0.2, b: 0.4, mateWin: 1, mateLoss: 0 }], rapid: [{ elo: 1000, a: 1, b: 1, mateWin: 1, mateLoss: 0 }, { elo: 1100, a: 1, b: 1, mateWin: 1, mateLoss: 0 }] } };
  assert.deepEqual(curveFor(1050, 'blitz', data), { a: 0, b: 0.2, mateWin: 0.9, mateLoss: 0.1 }, 'centre de la tranche 1000');
  const mid = curveFor(1100, 'blitz', data);
  assert.ok(Math.abs(mid.a - 0.1) < 1e-9 && Math.abs(mid.b - 0.3) < 1e-9, 'à mi-chemin entre deux centres');
  assert.equal(curveFor(400, 'blitz', data).b, 0.2, 'sous la première tranche : première courbe');
  assert.equal(curveFor(3000, 'blitz', data).b, 0.4, 'au-dessus : dernière courbe');
  assert.equal(curveFor(1050, 'bullet', data).b, 0.2, 'bullet → blitz');
  assert.equal(curveFor(1050, 'daily', data).a, 1, 'correspondance → rapide');
  assert.equal(curveFor(null, 'blitz', data).b, 0.4, 'Elo inconnu : 1500 (borné à la dernière tranche ici)');
});

test('points espérés : courbe du niveau (style chess.com), formule Lichess sans fichier de courbes', () => {
  loadCurves(CURVES_FILE);
  const at = (cp, elo) => expectedPoints({ cp }, { elo, timeClass: 'blitz' });
  assert.ok(Math.abs(at(0, 1500) - 50) < 10, 'position égale : environ 50 %');
  assert.ok(at(300, 1500) > at(100, 1500) && at(100, 1500) > at(-100, 1500), 'croissante');
  assert.ok(at(300, 2200) > at(300, 800), 'le même +3 vaut plus pour un joueur fort');
  assert.ok(expectedPoints({ mate: 3 }, { elo: 1100, timeClass: 'blitz' }) > 80, 'mat en faveur');
  assert.equal(expectedPoints({ mate: 0 }, { elo: 1100 }), 0, 'déjà maté');
  assert.equal(expectedPoints({ wdl: 'win' }, { elo: 1100 }), 100, 'table de finales : exact');
  loadCurves('');
  assert.equal(expectedPoints({ cp: 300 }, { elo: 1100 }), winPct({ cp: 300 }), 'sans fichier de courbes : formule Lichess');
});

test('ajustement : la régression retrouve une courbe connue', () => {
  const NB = 301;
  const n = new Float64Array(NB), s = new Float64Array(NB);
  for (let k = 0; k < NB; k++) {
    const x = (k * 10 - 1500) / 100;
    n[k] = 1000;
    s[k] = 1000 / (1 + Math.exp(-(0.1 + 0.25 * x)));
  }
  const { a, b } = fitLogistic(n, s);
  assert.ok(Math.abs(a - 0.1) < 0.01 && Math.abs(b - 0.25) < 0.01, `${a} ${b}`);
  // Peu de données parfaitement séparées : pas de coefficients absurdes.
  const n2 = new Float64Array(NB), s2 = new Float64Array(NB);
  n2[160] = 3; s2[160] = 3; n2[140] = 3; s2[140] = 0;
  const r = fitLogistic(n2, s2);
  assert.ok(Number.isFinite(r.a) && Math.abs(r.b) < 3, JSON.stringify(r));
});

test('lecture de la base Lichess : évaluations, cadence, joueur au trait, blocs pzstd', async () => {
  assert.deepEqual(parseEvals('1. e4 { [%eval 0.2] [%clk 0:03:00] } 1... e5 { [%eval #-2] } 2. Nf3?! { [%eval -0.5] } 1-0'),
    [{ ply: 1, cp: 20 }, { ply: 2, mate: -2 }, { ply: 3, cp: -50 }]);
  assert.deepEqual(['60+0', '180+0', '300+3', '600+5', '1800+0', '-'].map(speedOf), ['bullet', 'blitz', 'blitz', 'rapid', 'classical', null]);
  const make = () => ({ n: new Float64Array(301), s: new Float64Array(301), mateWin: { n: 0, s: 0 }, mateLoss: { n: 0, s: 0 } });
  const acc = { fit: { blitz: Array.from({ length: 18 }, make), rapid: Array.from({ length: 18 }, make) } };
  // Après 1. e4 (+0,20 pour les Blancs), le trait est aux Noirs (Elo 1450) : −20 de leur point de vue, et ils perdent.
  addGame(acc, 'fit', { whiteElo: 1510, blackElo: 1450, result: '1-0', tc: 'blitz', evals: [{ ply: 1, cp: 20 }] });
  const k = (-20 + 1500) / 10;
  assert.equal(acc.fit.blitz[8].n[k], 1);
  assert.equal(acc.fit.blitz[8].s[k], 0);
  // Blocs « à ignorer » de 4 octets (taille du bloc compressé) retirés, blocs compressés transmis.
  const frame = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3]);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x184d2a50, 0); head.writeUInt32LE(4, 4); head.writeUInt32LE(frame.length, 8);
  const t = stripSkippableFrames();
  const chunks = [];
  t.on('data', (c) => chunks.push(c));
  t.end(Buffer.concat([head, frame, head, frame]));
  await new Promise((r) => t.on('end', r));
  assert.deepEqual(Buffer.concat(chunks), Buffer.concat([frame, frame]));
});
