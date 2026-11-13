// Pilotage de Stockfish via le protocole UCI (un seul processus, plusieurs threads).
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import os from 'node:os';

export class AbortError extends Error {
  constructor(msg = 'Analyse interrompue') { super(msg); this.name = 'AbortError'; }
}

export function parseInfoLine(line) {
  if (!line.startsWith('info ') || !line.includes(' score ') || !line.includes(' pv ')) return null;
  const t = line.split(/\s+/);
  const out = { depth: 0, multipv: 1, cp: null, mate: null, bound: null, pv: [] };
  for (let i = 1; i < t.length; i++) {
    switch (t[i]) {
      case 'depth': out.depth = Number(t[++i]); break;
      case 'multipv': out.multipv = Number(t[++i]); break;
      case 'score':
        if (t[i + 1] === 'cp') out.cp = Number(t[i + 2]);
        else if (t[i + 1] === 'mate') out.mate = Number(t[i + 2]);
        i += 2;
        if (t[i + 1] === 'lowerbound' || t[i + 1] === 'upperbound') out.bound = t[++i];
        break;
      case 'pv': out.pv = t.slice(i + 1); i = t.length; break;
      default: break;
    }
  }
  return out.pv.length ? out : null;
}

export class StockfishEngine {
  constructor({ binary, threads = 1, hashMB = 256, lowPriority = false }) {
    this.binary = binary;
    this.lowPriority = lowPriority;
    this.threads = threads;
    this.hashMB = hashMB;
    this.proc = null;
    this.alive = false;
    this.name = 'Stockfish';
    this.chain = Promise.resolve();
    this.waiters = [];
    this.search = null;
    this.multiPV = null;
    this.searches = 0;
  }

  _onLine(raw) {
    const line = raw.trim();
    if (!line) return;
    if (line.startsWith('id name ')) this.name = line.slice(8);
    for (const w of [...this.waiters]) {
      if (w.test(line)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(line); }
    }
    const s = this.search;
    if (!s) return;
    if (line.startsWith('info ')) {
      const info = parseInfoLine(line);
      if (!info) return;
      const prev = s.lines.get(info.multipv);
      if (prev && prev.depth === info.depth && !prev.bound && info.bound) return; // garde la valeur exacte
      if (!prev || info.depth >= prev.depth) s.lines.set(info.multipv, info);
    } else if (line.startsWith('bestmove')) {
      this.search = null;
      clearTimeout(s.timer);
      s.done(line.split(/\s+/)[1]);
    }
  }

  _waitFor(test, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const w = { test, resolve: (l) => { clearTimeout(timer); resolve(l); } };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error('Stockfish ne répond pas.'));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  send(cmd) {
    if (this.proc && this.alive) this.proc.stdin.write(`${cmd}\n`);
  }

  async start() {
    if (this.alive) return;
    this.proc = spawn(this.binary, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.alive = true;
    this.multiPV = null;
    if (this.lowPriority) {
      try { os.setPriority(this.proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* sans importance */ }
    }
    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', (l) => this._onLine(l));
    this.proc.stderr.on('data', () => {});
    this.proc.on('error', () => { this.alive = false; });
    this.proc.on('exit', () => {
      this.alive = false;
      const s = this.search;
      this.search = null;
      if (s) { clearTimeout(s.timer); s.fail(new Error('Stockfish s\'est arrêté de façon inattendue.')); }
    });
    this.send('uci');
    await this._waitFor((l) => l === 'uciok');
    this.send(`setoption name Threads value ${this.threads}`);
    this.send(`setoption name Hash value ${this.hashMB}`);
    this.send('isready');
    await this._waitFor((l) => l === 'readyok', 60000);
  }

  // Les recherches sont exécutées l'une après l'autre.
  analyse(fen, opts) {
    const run = this.chain.then(() => this._analyse(fen, opts));
    this.chain = run.catch(() => {});
    return run;
  }

  async _analyse(fen, { depth, nodes = null, multiPV = 1, searchMoves = null, signal = null, maxMs = 0 }) {
    if (signal?.aborted) throw new AbortError();
    if (!this.alive) await this.start();
    if (this.multiPV !== multiPV) {
      this.send(`setoption name MultiPV value ${multiPV}`);
      this.multiPV = multiPV;
    }
    this.send(`position fen ${fen}`);
    this.searches++;
    const result = await new Promise((resolve, reject) => {
      const s = { lines: new Map(), timedOut: false, aborted: false };
      const onAbort = () => { s.aborted = true; this.send('stop'); };
      s.done = (bestmove) => {
        signal?.removeEventListener('abort', onAbort);
        if (s.aborted) return reject(new AbortError());
        const lines = [...s.lines.values()].sort((a, b) => a.multipv - b.multipv)
          .map(({ cp, mate, pv, depth: d }) => ({ move: pv[0], cp, mate, pv, depth: d }));
        resolve({ bestmove, lines, depth: lines.length ? Math.min(...lines.map((l) => l.depth)) : 0, timedOut: s.timedOut });
      };
      s.fail = (e) => { signal?.removeEventListener('abort', onAbort); reject(e); };
      if (maxMs > 0) s.timer = setTimeout(() => { s.timedOut = true; this.send('stop'); }, maxMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.search = s;
      const limit = nodes ? `nodes ${nodes}` : `depth ${depth}`;
      this.send(`go ${limit}${searchMoves ? ` searchmoves ${searchMoves.join(' ')}` : ''}`);
    });
    return result;
  }

  async quit() {
    if (!this.alive) return;
    this.send('quit');
    await new Promise((r) => { const t = setTimeout(() => { try { this.proc.kill(); } catch {} r(); }, 2000); this.proc.once('exit', () => { clearTimeout(t); r(); }); });
    this.alive = false;
  }
}
