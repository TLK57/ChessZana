// Met à jour le livre d'ouvertures (npm run update-openings) depuis https://github.com/lichess-org/chess-openings
// (licence CC0). Les fichiers a.tsv … e.tsv sont téléchargés, vérifiés (format et coups légaux), puis remplacent
// ceux de resources/openings. Les parties déjà importées retrouveront leur nom d'ouverture au prochain lancement.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'resources', 'openings');
const REPO = 'lichess-org/chess-openings';
const FILES = ['a.tsv', 'b.tsv', 'c.tsv', 'd.tsv', 'e.tsv'];
const HEADERS = { 'User-Agent': 'ChessZana (mise à jour du livre d\'ouvertures)' };

/**
 * Vérifie un fichier TSV : en-tête eco/name/pgn, 3 colonnes, code ECO, et (legal) coups légaux.
 * Renvoie { rows, errors }.
 */
export function checkOpeningsTsv(text, file, { legal = true } = {}) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const errors = [];
  if (lines[0] !== 'eco\tname\tpgn') errors.push(`${file} : en-tête inattendu (« ${lines[0]?.slice(0, 40)} »)`);
  let rows = 0;
  for (const [i, line] of lines.slice(1).entries()) {
    const cols = line.split('\t');
    if (cols.length !== 3) { errors.push(`${file}, ligne ${i + 2} : ${cols.length} colonnes au lieu de 3`); continue; }
    const [eco, name, pgn] = cols;
    if (!/^[A-E]\d\d$/.test(eco)) errors.push(`${file}, ligne ${i + 2} : code ECO invalide (« ${eco} »)`);
    if (!name.trim()) errors.push(`${file}, ligne ${i + 2} : nom d'ouverture vide`);
    if (legal) {
      try {
        const c = new Chess();
        const sans = pgn.replace(/\d+\.(\.\.)?/g, ' ').split(/\s+/).filter(Boolean);
        if (!sans.length) throw new Error('aucun coup');
        for (const san of sans) c.move(san);
      } catch (e) {
        errors.push(`${file}, ligne ${i + 2} : coups illisibles (${e.message})`);
      }
    }
    rows++;
    if (errors.length > 20) break;
  }
  return { rows, errors };
}

async function get(url) {
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`${url} : HTTP ${r.status}`);
  return r;
}

async function main() {
  console.log(`Mise à jour du livre d'ouvertures depuis github.com/${REPO}…`);
  let commit = null;
  try {
    const c = await (await get(`https://api.github.com/repos/${REPO}/commits/master`)).json();
    commit = { sha: c.sha, date: c.commit?.committer?.date };
  } catch (e) {
    console.log(`  (version exacte inconnue : ${e.message})`);
  }
  const ref = commit?.sha ?? 'master';
  const downloaded = {};
  let total = 0;
  for (const f of FILES) {
    const text = await (await get(`https://raw.githubusercontent.com/${REPO}/${ref}/${f}`)).text();
    const { rows, errors } = checkOpeningsTsv(text, f);
    if (errors.length) throw new Error(`Fichier ${f} refusé, rien n'a été modifié :\n  - ${errors.slice(0, 10).join('\n  - ')}`);
    downloaded[f] = text;
    total += rows;
    const old = fs.existsSync(path.join(DIR, f)) ? fs.readFileSync(path.join(DIR, f), 'utf8').split(/\r?\n/).filter((l) => l.trim()).length - 1 : 0;
    console.log(`  ${f} : ${rows} ouvertures (avant : ${old})`);
  }
  // Tout est vérifié : remplacement des fichiers (écriture puis renommage, pour ne jamais laisser un fichier à moitié écrit).
  fs.mkdirSync(DIR, { recursive: true });
  for (const [f, text] of Object.entries(downloaded)) {
    const tmp = path.join(DIR, `${f}.tmp`);
    fs.writeFileSync(tmp, text.replace(/\r\n/g, '\n'));
    fs.renameSync(tmp, path.join(DIR, f));
  }
  fs.writeFileSync(path.join(DIR, 'SOURCE.txt'), [
    `Fichiers a.tsv … e.tsv : copie de https://github.com/${REPO}`,
    commit ? `Version : ${commit.sha} (${commit.date}), téléchargée le ${new Date().toISOString().slice(0, 10)}` : `Téléchargée le ${new Date().toISOString().slice(0, 10)}`,
    'Licence : CC0 1.0 (domaine public).',
    '',
  ].join('\n'));
  // Les noms d'ouverture des parties seront recalculés au prochain lancement de l'application.
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const dbFile = path.join(ROOT, 'data', 'echecs.sqlite');
    if (fs.existsSync(dbFile)) {
      const db = new DatabaseSync(dbFile);
      const n = db.prepare('UPDATE games SET book_done = 0').run().changes;
      db.close();
      console.log(`  ${n} parties : nom d'ouverture recalculé au prochain lancement.`);
    }
  } catch (e) {
    console.log(`  (base non mise à jour : ${e.message})`);
  }
  console.log(`Terminé : ${total} ouvertures.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`\nErreur : ${e.message}`); process.exit(1); });
}
