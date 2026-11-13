import './_setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import {
  rawPhase, gamePhases, boardInfo, clocksBefore, isSimpleMove, isSlow, lostOnTimeWinning, schedule, addDays,
} from '../src/stats/rules.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

test('phases : position initiale = ouverture, peu de pièces = finale', () => {
  assert.equal(boardInfo(START).pieces, 14);
  assert.equal(rawPhase(START, 1), 'opening');
  assert.equal(rawPhase('8/5k2/8/3K4/3P4/2P5/1R4r1/8 w - - 0 40', 79), 'endgame'); // 2 tours
  assert.equal(rawPhase('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 3), 'endgame'); // 4 tours seulement
  // Blancs développés : moins de 4 pièces sur leur première rangée -> milieu de jeu.
  assert.equal(rawPhase('rnbqkbnr/pppppppp/8/8/8/2NBBN2/PPPQPPPP/R3K2R w KQkq - 0 8', 15), 'middlegame');
});

test('phases : le milieu de jeu commence au plus tard après le 15e coup, et on ne revient jamais en arrière', () => {
  assert.equal(rawPhase(START, 31), 'middlegame');
  const c = new Chess();
  const fens = [];
  for (const san of ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O', 'Nf6', 'd3', 'd6']) { fens.push(c.fen()); c.move(san); }
  assert.deepEqual([...new Set(gamePhases(fens))], ['opening'], 'une ouverture italienne normale reste en ouverture');
  const developed = 'rnbqkbnr/pppppppp/8/8/8/2NBBN2/PPPQPPPP/R3K2R w KQkq - 0 8';
  assert.deepEqual(gamePhases([START, developed, START]), ['opening', 'middlegame', 'middlegame']);
  // Monotone : une position « d'ouverture » après le milieu de jeu reste comptée en milieu de jeu.
  assert.deepEqual(gamePhases([START, '8/8/8/8/8/8/8/K6k w - - 0 1', START]), ['opening', 'endgame', 'endgame']);
});

test('temps : pendule au début de la réflexion, coups simples, lenteur, défaite au temps', () => {
  assert.deepEqual(clocksBefore([179000, 170000, 25000], 180000), [180000, 179000, 170000]);
  assert.equal(isSimpleMove({ legalMoves: 1, playedIsBest: true }), true);
  assert.equal(isSimpleMove({ legalMoves: 20, winBest: 60, winSecond: 35, playedIsBest: true }), true);
  assert.equal(isSimpleMove({ legalMoves: 20, winBest: 60, winSecond: 55, playedIsBest: true }), false);
  assert.equal(isSimpleMove({ legalMoves: 1, playedIsBest: false }), false);
  assert.equal(isSlow(12000, 4000), true);
  assert.equal(isSlow(4000, 1000), false); // moins de 5 s
  assert.equal(isSlow(6000, 4000), false); // pas le double de la moyenne
  assert.equal(lostOnTimeWinning({ outcome: 'loss', termination: 'Airox1 won on time', finalWin: 85 }), true);
  assert.equal(lostOnTimeWinning({ outcome: 'loss', termination: 'Airox1 won on time', finalWin: 40 }), false);
  assert.equal(lostOnTimeWinning({ outcome: 'loss', termination: 'Airox1 won by resignation', finalWin: 85 }), false);
  assert.equal(lostOnTimeWinning({ outcome: 'win', termination: 'Dilo56 won on time', finalWin: 85 }), false);
});

test('répétition espacée : raté -> demain ; réussi -> 3, 7, 14, puis 30 jours', () => {
  const today = '2026-11-13';
  assert.deepEqual(schedule({ streak: 0 }, false, today), { streak: 0, intervalDays: 1, dueDate: '2026-11-14' });
  let card = { streak: 0 };
  const intervals = [];
  for (let i = 0; i < 6; i++) { card = schedule(card, true, today); intervals.push(card.intervalDays); }
  assert.deepEqual(intervals, [3, 7, 14, 30, 30, 30]);
  assert.equal(schedule({ streak: 3 }, true, today).dueDate, '2026-12-13');
  // Un échec remet la série à zéro.
  assert.deepEqual(schedule({ streak: 4 }, false, today).intervalDays, 1);
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});
