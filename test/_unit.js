// Préparation des tests unitaires : rien de réel n'est lancé.
// - Stockfish est remplacé par test/fake-uci.js, qui rejoue des réponses enregistrées (test/fixtures/uci) ;
// - le réseau est coupé : seules les réponses d'API enregistrées dans test/fixtures/http sont servies.
// `npm run test:record` réenregistre ces réponses avec le vrai Stockfish et les vraies API.
import './_setup.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const RECORDING = process.env.FIXTURES_RECORD === '1';

// Le moteur des tests est décrit dans un dossier temporaire (le vrai data/engine n'est pas utilisé).
const engineDir = path.join(process.env.CHESS_DATA_DIR, 'engine');
process.env.CHESS_ENGINE_DIR = engineDir;

/** Les recherches Stockfish de ce fichier de test sont lues dans test/fixtures/uci/<nom>.json. */
export function useRecordedEngine(name) {
  const release = /STOCKFISH_RELEASE = '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'src', 'engine', 'install.js'), 'utf8'))[1];
  fs.mkdirSync(engineDir, { recursive: true });
  fs.writeFileSync(path.join(engineDir, 'engine.json'), JSON.stringify({
    release,
    name: 'Stockfish 19 (réponses enregistrées)',
    binary: process.execPath,
    args: [path.join(HERE, 'fake-uci.js'), path.join(HERE, 'fixtures', 'uci', `${name}.json`)],
  }));
}

// ---- Réseau : réponses enregistrées ----
const HTTP_DIR = path.join(HERE, 'fixtures', 'http');
const realFetch = globalThis.fetch;

function fixtureFile(url) {
  const u = new URL(url);
  const slug = `${u.host}${u.pathname}`.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60);
  const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 8);
  return path.join(HTTP_DIR, `${slug}-${hash}.json`);
}

globalThis.fetch = async (input, init = {}) => {
  const url = String(input?.url ?? input);
  if (init.signal?.aborted) throw init.signal.reason;
  const file = fixtureFile(url);
  if (RECORDING) {
    const res = await realFetch(input, init);
    const body = await res.text();
    const headers = {};
    for (const k of ['content-type', 'etag', 'last-modified']) if (res.headers.get(k)) headers[k] = res.headers.get(k);
    fs.mkdirSync(HTTP_DIR, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ url, status: res.status, headers, body }, null, 2)}\n`);
    return new Response(res.status === 204 || res.status === 304 ? null : body, { status: res.status, headers });
  }
  if (!fs.existsSync(file)) {
    throw new TypeError('fetch failed', { cause: { code: `réseau coupé pendant les tests unitaires (${url})` } });
  }
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  return new Response(r.status === 204 || r.status === 304 ? null : r.body, { status: r.status, headers: r.headers });
};
