// Robustesse des imports : vraies réponses enregistrées de chess.com et Lichess (test/fixtures/api), puis réponses
// abîmées volontairement. Un format inattendu donne un message clair en français et l'import continue.
import './_unit.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, getDb } from '../src/db.js';
import { syncChessCom } from '../src/importers/chesscom.js';
import { syncLichess } from '../src/importers/lichess.js';
import { checkChessComGame, checkLichessGame, Problems } from '../src/importers/validate.js';
import { checkOpeningsTsv } from '../scripts/update-openings.js';

openDb();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const fixture = (f) => fs.readFileSync(path.join(HERE, 'fixtures', 'api', f), 'utf8');
const json = (obj) => new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
const realFetch = globalThis.fetch;
const MONTH = 'https://api.chess.com/pub/player/erik/games/2024/01';

function serveChessCom(month, archives = JSON.parse(fixture('chesscom-archives.json'))) {
  globalThis.fetch = async (url) => {
    url = String(url);
    if (url.endsWith('/player/erik')) return json(fixture('chesscom-profile.json'));
    if (url.endsWith('/games/archives')) return json(archives);
    if (url === MONTH) return json(month);
    if (url.endsWith('/games/2024/02')) return json(fixture('chesscom-month.json'));
    return new Response('{}', { status: 404 });
  };
}

test('chess.com : les vraies réponses enregistrées sont acceptées', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  serveChessCom(fixture('chesscom-month.json'));
  const s = await syncChessCom('erik');
  assert.equal(s.added, 3);
  assert.equal(s.invalid, 0);
  assert.deepEqual(s.problems, []);
});

test('chess.com : parties au format inattendu ignorées avec un message clair, les autres importées', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  getDb().exec("DELETE FROM sync_archives; DELETE FROM games WHERE source = 'chesscom'");
  const games = JSON.parse(fixture('chesscom-month.json')).games;
  const broken = [
    { ...games[0], pgn: undefined },
    { ...games[1], end_time: 'hier' },
    { ...games[2], white: { rating: 1500 } },
    'pas une partie',
    games[2],
  ];
  serveChessCom({ games: broken });
  const messages = [];
  const s = await syncChessCom('erik', { onProgress: (p) => messages.push(p.message) });
  assert.equal(s.added, 1, 'la partie valide est importée');
  assert.equal(s.invalid, 4);
  const texts = s.problems.map((p) => p.message);
  assert.ok(texts.includes('partie sans PGN (champ « pgn » absent)'), texts.join(' | '));
  assert.ok(texts.includes('partie sans date de fin (champ « end_time » absent ou invalide)'));
  assert.ok(texts.includes('partie sans pseudo des Blancs (champ « white.username » absent)'));
  assert.ok(texts.includes('partie illisible (ce n\'est pas un objet)'));
  assert.match(messages.at(-1), /Terminé : 1 nouvelles parties\. Attention : 4 éléments ignorés \(format inattendu\)/);
});

test('chess.com : un mois illisible est ignoré (et redemandé plus tard), l\'import continue avec le mois suivant', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  getDb().exec("DELETE FROM sync_archives; DELETE FROM games WHERE source = 'chesscom'");
  const archives = { archives: [MONTH, 'https://api.chess.com/pub/player/erik/games/2024/02', 42, 'pas une adresse'] };
  serveChessCom({ jeux: [] }, archives);
  const s = await syncChessCom('erik');
  assert.equal(s.monthsFailed, 1);
  assert.equal(s.added, 3, 'le mois suivant est importé');
  const texts = s.problems.map((p) => p.message);
  assert.ok(texts.some((m) => /^mois 01\/2024 : réponse illisible \(champ « games » absent/.test(m)), texts.join(' | '));
  assert.ok(texts.includes('adresse de mois illisible dans la liste des archives'));
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM sync_archives WHERE url = ?').get(MONTH).n, 0, 'mois non marqué comme téléchargé');
});

test('chess.com : une liste des mois illisible arrête l\'import avec un message clair', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  serveChessCom({}, { mois: [] });
  await assert.rejects(syncChessCom('erik'), /chess\.com a renvoyé une liste des mois illisible \(champ « archives » absent/);
});

function serveLichess(ndjson) {
  globalThis.fetch = async (url) => {
    url = String(url);
    if (url.includes('/api/user/thibault')) return json(fixture('lichess-user.json'));
    if (url.includes('/api/games/user/thibault')) return new Response(ndjson, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    return new Response('{}', { status: 404 });
  };
}

test('Lichess : les vraies réponses enregistrées sont acceptées', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  serveLichess(fixture('lichess-games.ndjson'));
  const s = await syncLichess('thibault');
  assert.equal(s.added, 3);
  assert.equal(s.invalid, 0);
});

test('Lichess : lignes illisibles et parties incomplètes ignorées, les autres importées', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  getDb().exec("UPDATE players SET sync_cursor = NULL; DELETE FROM games WHERE source = 'lichess'");
  const [g1, g2, g3] = fixture('lichess-games.ndjson').trim().split('\n').map((l) => JSON.parse(l));
  const { id, ...noId } = g1;
  const lines = ['{ pas du json', JSON.stringify(noId), JSON.stringify({ ...g2, players: { white: g2.players.white } }), JSON.stringify(g3)];
  serveLichess(`${lines.join('\n')}\n`);
  const messages = [];
  const s = await syncLichess('thibault', { onProgress: (p) => messages.push(p.message) });
  assert.equal(s.added, 1);
  assert.equal(s.invalid, 3);
  const texts = s.problems.map((p) => p.message);
  assert.ok(texts.includes('ligne illisible dans l\'export (ce n\'est pas du JSON)'), texts.join(' | '));
  assert.ok(texts.includes('partie sans identifiant (champ « id » absent)'));
  assert.ok(texts.includes('partie sans joueurs (champ « players » absent ou incomplet)'));
  assert.match(messages.at(-1), /Attention : 3 éléments ignorés/);
});

test('validation : messages en français, regroupés', () => {
  assert.equal(checkChessComGame(JSON.parse(fixture('chesscom-month.json')).games[0]), null);
  assert.equal(checkLichessGame(JSON.parse(fixture('lichess-games.ndjson').split('\n')[0])), null);
  assert.equal(checkLichessGame({ id: 'x', variant: 'standard', players: { white: {}, black: {} }, pgn: '1. e4', createdAt: 'hier' }),
    'partie avec une date de création invalide (champ « createdAt »)');
  const p = new Problems();
  p.add('a'); p.add('a'); p.add('b');
  assert.equal(p.count, 3);
  assert.equal(p.summary(), '3 éléments ignorés (format inattendu) : a (2) ; b');
});

test('livre d\'ouvertures : les fichiers livrés sont valides, un fichier abîmé est refusé', () => {
  for (const f of ['a.tsv', 'b.tsv', 'c.tsv', 'd.tsv', 'e.tsv']) {
    // Format seulement ici (rapide) ; la légalité des coups est vérifiée par npm run update-openings au téléchargement.
    const r = checkOpeningsTsv(fs.readFileSync(path.join(ROOT, 'resources', 'openings', f), 'utf8'), f, { legal: false });
    assert.deepEqual(r.errors, [], f);
    assert.ok(r.rows > 300, f);
  }
  const bad = checkOpeningsTsv('eco\tname\tpgn\nZ99\tTruc\t1. e4\nA00\tSans coups\nA01\tCoup illégal\t1. e5\n', 'x.tsv');
  assert.match(bad.errors.join(' | '), /code ECO invalide/);
  assert.match(bad.errors.join(' | '), /2 colonnes au lieu de 3/);
  assert.match(bad.errors.join(' | '), /coups illisibles/);
  assert.match(checkOpeningsTsv('code\tnom\n', 'y.tsv').errors[0], /en-tête inattendu/);
});
