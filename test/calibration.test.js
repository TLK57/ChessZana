import './_setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fitCalibration, applyCalibration } from '../src/stats/calibration.js';
import { estimateElo } from '../src/analysis/formulas.js';
import { overrideConfig } from '../src/config.js';

// Joueurs dont l'Elo réel est 500 points sous ce que dit la table générique.
const generic = (a) => estimateElo(a, Infinity);
const points = (n, tc, shift, accs = [60, 65, 70, 75, 80, 85]) =>
  Array.from({ length: n }, (_, i) => { const a = accs[i % accs.length]; return { accuracy: a, elo: generic(a) + shift, timeClass: tc }; });

test('calibrage : décalage médian par cadence, appliqué à la table générique', () => {
  const cal = fitCalibration([...points(30, 'blitz', -500), ...points(20, 'rapid', -300)], 15);
  assert.equal(cal.byTimeClass.blitz.offset, -500);
  assert.equal(cal.byTimeClass.rapid.offset, -300);
  assert.equal(applyCalibration(cal, 75, 'blitz', 20), generic(75) - 500);
  assert.equal(applyCalibration(cal, 75, 'rapid', 20), generic(75) - 300);
});

test('calibrage : la médiane résiste aux parties atypiques', () => {
  const pts = [...points(20, 'blitz', -500), { accuracy: 99, elo: 3000, timeClass: 'blitz' }, { accuracy: 30, elo: 3000, timeClass: 'blitz' }];
  assert.equal(fitCalibration(pts, 15).byTimeClass.blitz.offset, -500);
});

test('calibrage : cadence sans assez de parties -> décalage global ; trop peu de parties -> estimation générique', () => {
  const cal = fitCalibration([...points(20, 'blitz', -500), ...points(4, 'bullet', -100)], 15);
  assert.equal(cal.byTimeClass.bullet, undefined);
  assert.equal(applyCalibration(cal, 70, 'bullet', 20), Math.round((generic(70) + cal.global.offset) / 10) * 10);
  const none = fitCalibration(points(5, 'blitz', -500), 15);
  assert.equal(none.global.offset, null);
  assert.equal(applyCalibration(none, 70, 'blitz', 20), generic(70));
  assert.equal(applyCalibration(none, 70, 'blitz', 3), null, 'trop peu de coups : pas d\'estimation');
});

test('calibrage désactivable dans config.json', () => {
  const cal = fitCalibration(points(30, 'blitz', -500), 15);
  overrideConfig({ elo: { calibrate: false } });
  assert.equal(applyCalibration(cal, 75, 'blitz', 20), generic(75));
  overrideConfig({ elo: { calibrate: true } });
  assert.equal(applyCalibration(cal, 75, 'blitz', 20), generic(75) - 500);
});
