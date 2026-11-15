// Chances de gain selon le niveau : courbes ajustées sur la base Lichess (npm run fit-curves), et courbe à deux
// paramètres du style chess.com qui en est tirée.
import './_unit.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, config, overrideConfig } from '../src/config.js';
import { chesscomXp, curveSlope, winPct } from '../src/analysis/formulas.js';
import { addGame, curveParamsFromTable, fitLogistic, parseEvals, speedOf, stripSkippableFrames } from '../scripts/fit-curves.js';

const CURVES_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'expected-points.json');
const real = JSON.parse(fs.readFileSync(CURVES_FILE, 'utf8'));
const testCurve = structuredClone(config.classification.curve);
test.after(() => overrideConfig({ classification: { curve: testCurve } }));

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

test('style chess.com : la courbe de départ (config.json) est tirée des courbes de la base Lichess', () => {
  const p = curveParamsFromTable(real);
  assert.deepEqual({ k1500: DEFAULTS.classification.curve.k1500, eloSlope: DEFAULTS.classification.curve.eloSlope }, p);
  const shared = JSON.parse(fs.readFileSync(path.join(path.dirname(CURVES_FILE), '..', 'config.json'), 'utf8'));
  assert.equal(shared.classification.curve.k1500, p.k1500);
  assert.equal(shared.classification.curve.eloSlope, p.eloSlope);
});

test('style chess.com : points attendus selon l\'Elo, mats et tables exacts', () => {
  overrideConfig({ classification: { curve: DEFAULTS.classification.curve } });
  const at = (cp, elo) => chesscomXp({ cp }, elo);
  assert.equal(at(0, 1500), 50, 'position égale : 50 %');
  assert.ok(at(300, 1500) > at(100, 1500) && at(100, 1500) > at(-100, 1500), 'croissante');
  assert.ok(Math.abs(at(300, 1000) + at(-300, 1000) - 100) < 1e-9, 'symétrique');
  assert.ok(at(300, 2200) > at(300, 800), 'le même +3 vaut plus pour un joueur fort');
  assert.ok(at(300, 1000) < winPct({ cp: 300 }), 'à 1000 Elo, un +3 vaut moins qu\'avec la formule Lichess');
  assert.equal(curveSlope(50), curveSlope(100), 'Elo borné en bas (eloMin)');
  assert.equal(curveSlope(5000), curveSlope(3000), 'Elo borné en haut (eloMax)');
  assert.equal(curveSlope(null), curveSlope(1500), 'Elo inconnu : 1500');
  assert.equal(chesscomXp({ mate: 3 }, 800), 100);
  assert.equal(chesscomXp({ mate: 0 }, 800), 0, 'déjà maté');
  assert.equal(chesscomXp({ wdl: 'draw' }, 800), 50, 'table de finales : exact');
  // Avec k1500 = 0,368208 et sans effet de l'Elo, c'est exactement la formule Lichess.
  overrideConfig({ classification: { curve: { k1500: 0.368208, eloSlope: 0 } } });
  assert.ok(Math.abs(chesscomXp({ cp: 300 }, 900) - winPct({ cp: 300 })) < 1e-9);
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
