// Aide « Menace » : trait inversé (coup nul), seuil d'une menace sérieuse, calcul avec un moteur simulé.
import './_unit.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { liveThreat, materialWon, nullMoveFen, threatSignificance, THREAT_MIN_GAIN } from '../src/analysis/gameview.js';
import { winPct } from '../src/analysis/formulas.js';
import { gameRoutes } from '../src/routes/games.js';
import { RESTART_MESSAGE, threatError, threatInfo } from '../public/app/threat-info.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

test('coup nul : le trait passe à l\'autre camp, sans prise en passant ; illégal si le camp au trait est en échec', () => {
  assert.equal(nullMoveFen(START), 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1');
  // Après 1. e4 : prise en passant notée e3, effacée ; le trait revient aux Blancs (numéro de coup suivant).
  const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
  assert.equal(nullMoveFen(afterE4), 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2');
  assert.doesNotThrow(() => new Chess(nullMoveFen(afterE4)));
  // Les Noirs sont en échec (1. e4 f5 2. Dh5+) : leur retirer le trait laisserait leur roi en prise.
  assert.equal(nullMoveFen('rnbqkbnr/ppppp1pp/8/5p1Q/4P3/8/PPPP1PPP/RNB1KBNR b KQkq - 1 2'), null);
});

test(`menace sérieuse : au moins ${THREAT_MIN_GAIN} points de chances de gain gagnés par l'adversaire, ou un mat`, () => {
  // Position égale ; si les Noirs jouaient deux fois, ils gagneraient une pièce (≈ −3 pour les Blancs).
  const r = threatSignificance({ cp: 0 }, { cp: 300 });
  assert.ok(Math.abs(r.gain - (winPct({ cp: 300 }) - 50)) < 1e-9);
  assert.equal(r.significant, true);
  // Un simple gain de tempo (+0,30) n'est pas une menace sérieuse.
  assert.equal(threatSignificance({ cp: 0 }, { cp: 30 }).significant, false);
  // Mat menacé : toujours sérieux, même si la position était déjà gagnée pour l'adversaire.
  assert.deepEqual(threatSignificance({ cp: -900 }, { mate: 2 }).significant, true);
  assert.equal(threatSignificance({ cp: -900 }, { mate: 2 }).mate, true);
  // Déjà perdu : un coup de plus de l'adversaire ne change rien de sérieux.
  assert.equal(threatSignificance({ cp: -1200 }, { cp: 1500 }).significant, false);
});

test('calcul de la menace : position réelle et position au trait inversé, résultat et annulation transmise', async () => {
  const calls = [];
  const fake = (byFen) => ({
    async evaluatePosition(fen, opts) { calls.push({ fen, opts }); return { depth: 16, lines: byFen[fen] }; },
  });
  // Après 1. e4 e5 2. Cf3 Cc6 3. Fc4 Cd4 : si les Blancs « passaient », les Noirs prendraient en f3 (exemple simulé).
  const fen = 'r1bqkbnr/pppp1ppp/8/4p3/2BnP3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
  const flipped = nullMoveFen(fen);
  const signal = new AbortController().signal;
  const r = await liveThreat(fake({ [fen]: [{ move: 'f3e5', cp: 40 }], [flipped]: [{ move: 'd4f3', cp: 280 }] }), { fen }, { signal });
  assert.equal(r.threat.uci, 'd4f3');
  assert.equal(r.threat.san, 'Nxf3+');
  assert.equal(r.threat.color, 'b');
  assert.ok(r.threat.gain >= THREAT_MIN_GAIN);
  assert.deepEqual(calls.map((c) => c.fen), [fen, flipped]);
  assert.ok(calls.every((c) => c.opts.signal === signal && c.opts.depth >= 8), 'annulation et profondeur transmises');
  // Rien de sérieux : pas de flèche, mais le coup candidat reste connu.
  const small = await liveThreat(fake({ [fen]: [{ move: 'f3e5', cp: 40 }], [flipped]: [{ move: 'h7h6', cp: -30 }] }), { fen });
  assert.equal(small.threat, null);
  assert.equal(small.reason, 'small');
  assert.equal(small.candidate.uci, 'h7h6');
  // Échec : aucun calcul.
  calls.length = 0;
  const check = await liveThreat(fake({}), { fen: 'rnbqkbnr/ppppp1pp/8/5p1Q/4P3/8/PPPP1PPP/RNB1KBNR b KQkq - 1 2' });
  assert.deepEqual([check.threat, check.reason, calls.length], [null, 'check', 0]);
  await assert.rejects(liveThreat(fake({}), { fen: 'pas une position' }), /Position invalide/);
});

// Partie tfg2s – Dilo56 du 13/11/2026, après 32…Txc3 (Blancs au trait) : les Noirs ont une tour de plus et menacent
// Txc4. Évaluations réelles de Stockfish 19 (profondeur 16) : −9,34 pour les Blancs ; +10,38 pour les Noirs au trait.
const APRES_TXC3 = '5rk1/p5p1/5p2/2p1p3/2P1P3/P1r5/R6P/6K1 w - - 0 33';

test('menace qui gagne du matériel : sérieuse même quand la partie est déjà jouée (32…Txc3, Txc4 gagne un pion)', async () => {
  const flipped = nullMoveFen(APRES_TXC3);
  assert.equal(materialWon(flipped, 'c3c4'), 1, 'Txc4 prend un pion que personne ne peut reprendre');
  assert.equal(materialWon(flipped, 'f8b8'), 0, 'un coup sans prise ne gagne rien');
  assert.equal(materialWon(flipped, 'c3a3'), 0, 'Txa3 prend un pion défendu par la tour a2 : échange perdant');
  // En chances de gain, un pion de plus à +9 ne change presque rien (≈ 1 point) : c'est le matériel qui compte.
  const s = threatSignificance({ cp: -934 }, { cp: 1038 }, 1);
  assert.ok(s.gain < THREAT_MIN_GAIN);
  assert.deepEqual([s.significant, s.by], [true, 'material']);
  assert.deepEqual([threatSignificance({ cp: -934 }, { cp: 1038 }, 0).significant], [false]);
  const fake = { async evaluatePosition(fen) { return { depth: 16, lines: fen === APRES_TXC3 ? [{ move: 'g1f2', cp: -934 }] : [{ move: 'c3c4', cp: 1038 }] }; } };
  const r = await liveThreat(fake, { fen: APRES_TXC3 });
  assert.equal(r.threat?.uci, 'c3c4');
  assert.equal(r.threat.san, 'Rxc4');
  assert.deepEqual([r.threat.color, r.threat.material, r.threat.captured, r.threat.by], ['b', 1, 'p', 'material']);
  assert.equal(threatInfo(r), "<b class=\"aid-threat-txt\">Menace</b> : ♖xc4 (les Noirs gagneraient un pion s'ils jouaient maintenant).");
});

test('la route de la menace existe : le serveur répond (503 tant que le moteur démarre), jamais 404 « Introuvable »', async () => {
  const res = { status: null, body: null, writeHead(st) { this.status = st; }, end(b) { this.body = JSON.parse(b); }, on() {} };
  const handled = await gameRoutes({ method: 'POST' }, res, { p: '/api/live/threat', body: { fen: APRES_TXC3 } });
  assert.equal(handled, true);
  assert.equal(res.status, 503);
  assert.match(res.body.error, /moteur démarre/);
});

test("serveur lancé avant la mise à jour (404) : message clair « Relancez l'appli pour activer la menace »", () => {
  const e = threatError(404, { error: 'Introuvable' });
  assert.deepEqual(e, { restart: true, error: RESTART_MESSAGE });
  assert.equal(RESTART_MESSAGE, "Relancez l'appli pour activer la menace.");
  assert.match(threatInfo({ threat: null, ...e }), /Relancez l&#39;appli pour activer la menace\./);
  assert.doesNotMatch(threatInfo({ threat: null, ...e }), /Introuvable/);
  // Les autres erreurs gardent le message du serveur.
  assert.equal(threatInfo({ threat: null, ...threatError(503, { error: 'Le moteur démarre encore' }) }), 'Menace indisponible : Le moteur démarre encore');
  assert.match(threatInfo(undefined), /Calcul de la menace/);
  assert.equal(threatInfo({ threat: null, reason: 'small' }), 'Pas de menace sérieuse.');
  assert.match(threatInfo({ threat: { san: 'Qxf7', mate: 2, color: 'w', by: 'mate' } }), /♕xf7 \(mat en 2 pour les Blancs/);
  assert.match(threatInfo({ threat: { san: 'Nxf3+', gain: 23.4, color: 'b', by: 'gain', material: 3, captured: 'n' } }), /\+23 points de chances de gain pour les Noirs/);
});
