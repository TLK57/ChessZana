// Livre d'ouvertures : base libre lichess-org/chess-openings (fichiers a.tsv … e.tsv, licence CC0).
// Toutes les positions rencontrées le long des lignes de la base sont considérées comme « théorie ».
import fs from 'node:fs';
import path from 'node:path';
import { Chess } from 'chess.js';
import { ROOT, config } from '../config.js';
import { normalizeChessFen } from '../chessutil.js';
import { tokenizeMovetext } from '../pgn.js';

const DIR = path.join(ROOT, 'resources', 'openings');
const FILES = ['a.tsv', 'b.tsv', 'c.tsv', 'd.tsv', 'e.tsv'];

let book = null; // Map fenNormalisée -> { eco, name }

function signature() {
  return FILES.map((f) => {
    try { const s = fs.statSync(path.join(DIR, f)); return `${f}:${s.size}:${Math.floor(s.mtimeMs)}`; } catch { return `${f}:absent`; }
  }).join('|');
}

function build() {
  const map = new Map();
  for (const f of FILES) {
    const file = path.join(DIR, f);
    if (!fs.existsSync(file)) continue;
    const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(1);
    for (const row of rows) {
      const [eco, name, pgn] = row.split('\t');
      if (!pgn) continue;
      const c = new Chess();
      const sans = tokenizeMovetext(pgn).filter((t) => t.type === 'move').map((t) => t.text);
      for (const [i, san] of sans.entries()) {
        try { c.move(san); } catch { break; }
        const key = normalizeChessFen(c);
        const prev = map.get(key);
        // On garde le nom le plus précis : celui de la ligne qui se termine exactement sur cette position.
        const exact = i === sans.length - 1;
        if (!prev || (exact && !prev.exact)) map.set(key, { eco, name, exact });
      }
    }
  }
  return map;
}

export function loadBook() {
  if (book) return book;
  const cacheFile = process.env.CHESS_OPENINGS_CACHE || path.join(config.dataDir, 'openings-cache.json');
  const sig = signature();
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (cached.sig === sig) { book = new Map(cached.entries); return book; }
  } catch { /* cache absent ou périmé */ }
  book = build();
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ sig, entries: [...book.entries()] }));
    fs.renameSync(tmp, cacheFile);
  } catch { /* le cache est facultatif */ }
  return book;
}

export function bookEntry(normFen) {
  return loadBook().get(normFen) ?? null;
}

export function isBookPosition(normFen) {
  return loadBook().has(normFen);
}
