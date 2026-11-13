// Évaluation d'une position : cache SQLite -> tables de finales -> analyse cloud Lichess -> Stockfish.
import { Chess } from 'chess.js';
import { config } from '../config.js';
import { getCachedEval, positionId, putEval } from '../db.js';
import { normalizeChessFen, pieceCount } from '../chessutil.js';
import { cloudEval, tablebaseProbe } from './lichess.js';
import { StockfishEngine } from './stockfish.js';
import { ensureEngine } from './install.js';

const TB_DEPTH = 99; // une réponse de la table de finales est exacte

const WDL_RANK = { win: 2, draw: 1, loss: 0 };

export class Evaluator {
  constructor({ lowPriority = false, hashMB = null } = {}) {
    this.lowPriority = lowPriority;
    this.hashMB = hashMB;
    this.gate = null;
    this.engine = null;
    this.engineInfo = null;
    this.stats = { cacheHits: 0, stockfish: 0, cloud: 0, tablebase: 0 };
  }

  async init(onInstallProgress) {
    if (this.engine) return;
    if (this.initializing) return this.initializing;
    this.initializing = this._init(onInstallProgress).finally(() => { this.initializing = null; });
    return this.initializing;
  }

  async _init(onInstallProgress) {
    this.engineInfo = await ensureEngine(onInstallProgress);
    this.engine = new StockfishEngine({
      binary: this.engineInfo.binary,
      threads: config.engine.threadsResolved,
      hashMB: this.hashMB ?? config.engine.hashMB,
      lowPriority: this.lowPriority,
    });
    await this.engine.start();
  }

  async close() {
    if (this.engine) await this.engine.quit();
    this.engine = null;
  }

  async _stockfish(fen, opts) {
    if (this.gate) await this.gate(opts?.signal); // ex. la file de fond attend pendant le mode libre
    if (!this.engine) await this.init();
    this.stats.stockfish++;
    return this.engine.analyse(fen, { maxMs: config.engine.maxSecondsPerPosition * 1000, ...opts });
  }

  /**
   * Évalue une position avec MultiPV. Renvoie { source, depth, lines, cached, cloudMiss }.
   * Les lignes sont triées de la meilleure à la moins bonne ; scores du point de vue du joueur au trait.
   */
  async evaluatePosition(fen, { depth, nodes = null, multiPV = config.engine.multiPV, allowCloud = false, allowTablebase = true, engineFallback = true, signal } = {}) {
    const chess = new Chess(fen);
    const legal = chess.moves().length;
    const pieces = pieceCount(fen);
    const posId = positionId(normalizeChessFen(chess), pieces);
    const need = Math.min(multiPV, legal);

    const cached = getCachedEval(posId, 'multipv', depth, nodes);
    if (cached && (cached.source === 'tablebase' || cached.lines.length >= need)) {
      this.stats.cacheHits++;
      return { source: cached.source, depth: cached.depth, lines: cached.lines, cached: true };
    }

    const castling = fen.split(' ')[2];
    if (allowTablebase && config.lichess.tablebase && pieces <= config.lichess.tablebaseMaxPieces && castling === '-') {
      const tb = await tablebaseProbe(fen);
      if (tb && !tb.notFound && tb.lines.length === legal) {
        const lines = tb.lines
          .map((l, i) => ({ ...l, i }))
          .sort((a, b) => (WDL_RANK[b.wdl] - WDL_RANK[a.wdl]) || (a.i - b.i))
          .map(({ i, ...l }) => l);
        putEval(posId, 'multipv', { depth: TB_DEPTH, targetDepth: TB_DEPTH, multipv: lines.length, source: 'tablebase', lines });
        this.stats.tablebase++;
        return { source: 'tablebase', depth: TB_DEPTH, lines, cached: false };
      }
    }

    let cloudMiss = false;
    if (allowCloud && config.lichess.cloudEval) {
      const ce = await cloudEval(fen, multiPV);
      if (ce?.notFound) cloudMiss = true;
      else if (ce && ce.lines.length >= need) {
        putEval(posId, 'multipv', { depth: ce.depth, targetDepth: ce.depth, multipv: ce.lines.length, source: 'lichess-cloud', lines: ce.lines });
        if (ce.depth >= depth) {
          this.stats.cloud++;
          return { source: 'lichess-cloud', depth: ce.depth, lines: ce.lines, cached: false };
        }
      }
    }

    if (!engineFallback) return { missing: true, cloudMiss };
    const r = await this._stockfish(fen, { depth, nodes, multiPV, signal });
    putEval(posId, 'multipv', { depth: r.depth, targetDepth: nodes ? r.depth : depth, multipv: multiPV, source: 'stockfish', lines: r.lines, engine: this.engine?.name, nodes });
    return { source: 'stockfish', depth: r.depth, lines: r.lines, cached: false, cloudMiss };
  }

  // Évalue un coup précis à la profondeur demandée (Stockfish « go depth N searchmoves <coup> »).
  async evaluateMove(fen, uci, { depth, nodes = null, signal } = {}) {
    const chess = new Chess(fen);
    const posId = positionId(normalizeChessFen(chess), pieceCount(fen));
    const kind = `move:${uci}`;
    const cached = getCachedEval(posId, kind, depth, nodes);
    if (cached && cached.lines.length) {
      this.stats.cacheHits++;
      return { ...cached.lines[0], source: cached.source, depth: cached.depth, cached: true };
    }
    const r = await this._stockfish(fen, { depth, nodes, multiPV: 1, searchMoves: [uci], signal });
    const line = r.lines[0] ?? { move: uci, cp: 0, mate: null, pv: [uci] };
    putEval(posId, kind, { depth: r.depth, targetDepth: nodes ? r.depth : depth, multipv: 1, source: 'stockfish', lines: [line], engine: this.engine?.name, nodes });
    return { ...line, source: 'stockfish', depth: r.depth, cached: false };
  }
}

let shared = null;
// Évaluateur de la file d'analyse (priorité basse si configuré).
export function getEvaluator() {
  if (!shared) shared = new Evaluator({ lowPriority: config.engine.backgroundLowPriority !== false });
  return shared;
}

let live = null;
// Évaluateur du mode libre : un second Stockfish, prioritaire, pour répondre vite.
export function getLiveEvaluator() {
  if (!live) live = new Evaluator({ hashMB: Math.min(256, config.engine.hashMB) });
  return live;
}
