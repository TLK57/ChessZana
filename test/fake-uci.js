// Faux moteur UCI pour les tests unitaires : rejoue des réponses de Stockfish enregistrées dans
// test/fixtures/uci/<fichier de test>.json (aucun vrai moteur n'est lancé).
// Pendant `npm run test:record`, il relaie les commandes au vrai Stockfish et enregistre ses réponses.
//
// Utilisation : node test/fake-uci.js <fichier de réponses>
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

const fixture = process.argv[2];
const recording = process.env.FIXTURES_RECORD === '1';
const out = (line) => process.stdout.write(`${line}\n`);

function load() {
  try { return JSON.parse(fs.readFileSync(fixture, 'utf8')); } catch { return {}; }
}

// Une réponse par ligne (fichier lisible et différences Git courtes), clés triées.
function save(key, entry) {
  const table = load();
  if (table[key]) return; // déjà enregistrée (par ce processus ou un autre moteur du même test)
  table[key] = entry;
  fs.mkdirSync(path.dirname(fixture), { recursive: true });
  const keys = Object.keys(table).sort();
  fs.writeFileSync(fixture, `{\n${keys.map((k) => `${JSON.stringify(k)}: ${JSON.stringify(table[k])}`).join(',\n')}\n}\n`);
}

// Même choix que src/engine/stockfish.js : pour chaque ligne MultiPV, la plus profonde (valeur exacte de préférence).
function keepFinal(selected, line) {
  if (!line.startsWith('info ') || !line.includes(' score ') || !line.includes(' pv ')) return;
  const t = line.split(/\s+/);
  const get = (k) => { const i = t.indexOf(k); return i >= 0 ? t[i + 1] : null; };
  const depth = Number(get('depth'));
  const multipv = Number(get('multipv') ?? 1);
  const s = t.indexOf('score');
  const bound = ['lowerbound', 'upperbound'].includes(t[s + 3]) ? t[s + 3] : null;
  const pv = t.slice(t.indexOf('pv') + 1);
  const compact = `info depth ${depth} multipv ${multipv} score ${t[s + 1]} ${t[s + 2]}${bound ? ` ${bound}` : ''} pv ${pv.join(' ')}`;
  const prev = selected.get(multipv);
  if (prev && prev.depth === depth && !prev.bound && bound) return;
  if (!prev || depth >= prev.depth) selected.set(multipv, { depth, bound, line: compact });
}

const recorded = recording ? {} : load();
let position = '';
let multiPV = 1;
const keyFor = (goArgs) => `${position}|multipv ${multiPV}|${goArgs}`;

let real = null;
let pending = null; // recherche en cours (enregistrement)
if (recording) {
  real = spawn(process.env.FIXTURES_REAL_ENGINE, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  real.on('exit', (code) => process.exit(code ?? 0));
  readline.createInterface({ input: real.stdout }).on('line', (line) => {
    out(line);
    if (!pending) return;
    if (line.startsWith('info ')) keepFinal(pending.selected, line);
    else if (line.startsWith('bestmove')) {
      const p = pending;
      pending = null;
      if (!p.stopped) {
        const lines = [...p.selected.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v.line);
        save(p.key, { lines, bestmove: line.split(/\s+/)[1] });
      }
    }
  });
}

readline.createInterface({ input: process.stdin }).on('line', (raw) => {
  const line = raw.trim();
  if (!line) return;
  const [cmd, ...rest] = line.split(/\s+/);
  if (cmd === 'position') position = rest.join(' ');
  if (cmd === 'setoption' && /^name MultiPV value \d+$/i.test(rest.join(' '))) multiPV = Number(rest.at(-1));
  if (recording) {
    if (cmd === 'go') pending = { key: keyFor(rest.join(' ')), selected: new Map(), stopped: false };
    if (cmd === 'stop' && pending) pending.stopped = true; // réponse interrompue : pas enregistrée
    real.stdin.write(`${line}\n`);
    return;
  }
  switch (cmd) {
    case 'uci': out('id name Stockfish 19 (réponses enregistrées)'); out('uciok'); break;
    case 'isready': out('readyok'); break;
    case 'go': {
      const key = keyFor(rest.join(' '));
      const entry = recorded[key];
      if (!entry) {
        process.stderr.write(`Position non enregistrée : ${key}\nRelancez « npm run test:record » (il faut le vrai Stockfish).\n`);
        process.exit(3);
      }
      for (const l of entry.lines) out(l);
      out(`bestmove ${entry.bestmove}`);
      break;
    }
    case 'quit': process.exit(0); break;
    default: break; // stop, ucinewgame, autres options : rien à faire
  }
});
