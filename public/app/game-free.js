// Écran d'une partie — mode libre : coups joués sur l'échiquier (évalués en direct par Stockfish)
// et lignes de Stockfish chargées comme variantes jouables.
import { Chess } from '/vendor/chess.js';
import { api, esc, fig, symbol, moveNo } from './util.js';
import { askPromotion } from './game-board.js';

/** ctx : { S, g, render(), go(ply), node() } (render, go et node sont appelés au moment du coup). */
export function createFreeMode(ctx) {
  const { S } = ctx;

  async function onBoardMove(orig, dest) {
    const { g } = ctx;
    const nd = ctx.node();
    const chess = new Chess(nd.fen);
    const piece = chess.get(orig);
    let promotion;
    if (piece?.type === 'p' && (dest[1] === '8' || dest[1] === '1')) {
      promotion = await askPromotion(piece.color);
      if (!promotion) { ctx.render(); return; }
    }
    let mv;
    try { mv = chess.move({ from: orig, to: dest, promotion }); } catch { mv = null; }
    if (!mv) { ctx.render(); return; }
    const uci = mv.from + mv.to + (mv.promotion ?? '');
    stopPlaying();
    if (!S.free) {
      const next = g.moves[S.ply];
      if (next && next.uci === uci) { ctx.go(S.ply + 1); return; }
      S.free = { basePly: S.ply, items: [], cursor: 0 };
    } else {
      const nextItem = S.free.items[S.free.cursor];
      if (nextItem && nextItem.uci === uci) { S.free.cursor++; ctx.render(); return; }
    }
    const f = S.free;
    f.items = f.items.slice(0, f.cursor);
    const item = {
      san: mv.san, uci, color: mv.color, moveNumber: Number(nd.fen.split(' ')[5]),
      fenBefore: nd.fen, fenAfter: chess.fen(), pending: true, result: null,
    };
    f.items.push(item);
    f.cursor = f.items.length;
    ctx.render();
    analyseFreeMove(item, f.items.length - 1);
  }

  function prevForFree(index) {
    const f = S.free;
    if (index > 0) {
      const p = f.items[index - 1];
      return p.result ? { classification: p.result.classification, winBest: p.result.winBest, uci: p.uci, san: p.san } : null;
    }
    const gm = ctx.g.moves[f.basePly - 1];
    return gm && gm.classification ? { classification: gm.classification, winBest: gm.winBest, uci: gm.uci, san: gm.san } : null;
  }

  // Deux temps : un avis immédiat (profondeur 12), puis le résultat affiné (profondeur du mode libre).
  async function analyseFreeMove(item, index) {
    const { g } = ctx;
    const f = S.free;
    const bookBefore = g.moves.slice(0, f.basePly).every((m) => m.book) && f.items.slice(0, index).every((it) => it.result?.classification === 'book');
    const body = {
      fen: item.fenBefore, uci: item.uci, prev: prevForFree(index), bookBefore,
      elo: item.color === 'w' ? g.white.elo : g.black.elo,
      myColor: g.myColor,
    };
    for (const depth of [12, undefined]) {
      try {
        const r = await api('/api/live/move', { ...body, depth });
        item.result = r;
        item.provisional = depth != null && r.depth < (S.liveDepth ?? 18);
        item.error = null;
      } catch (e) {
        if (!item.result) item.error = e.message;
        item.provisional = false;
      }
      item.pending = false;
      if (S.free === f) ctx.render();
      if (!item.provisional) break;
      if (S.free !== f || !f.items.includes(item)) break; // le coup a été effacé entre-temps
    }
  }

  // Charge une ligne de Stockfish comme variante jouable sur l'échiquier.
  function loadLine(basePly, line, evalInfo, cursor = 1) {
    const { g } = ctx;
    stopPlaying();
    let fen = basePly === 0 ? g.startFen : g.moves[basePly - 1].fenAfter;
    const items = [];
    for (const m of line) {
      const c = new Chess(fen);
      let mv;
      try { mv = c.move(m.san); } catch { break; }
      items.push({ san: mv.san, uci: mv.from + mv.to + (mv.promotion ?? ''), color: mv.color, moveNumber: Number(fen.split(' ')[5]), fenBefore: fen, fenAfter: c.fen(), engine: true, lineEval: evalInfo });
      fen = c.fen();
    }
    S.free = { basePly, items, cursor: Math.min(cursor, items.length), fromLine: true };
    ctx.render();
  }

  function playLine() {
    stopPlaying();
    if (!S.free) return;
    S.playing = setInterval(() => {
      if (!S.free || S.free.cursor >= S.free.items.length) { stopPlaying(); return; }
      S.free.cursor++;
      ctx.render();
    }, 900);
  }

  function stopPlaying() { if (S.playing) { clearInterval(S.playing); S.playing = null; } }

  return { onBoardMove, loadLine, playLine, stopPlaying };
}

export function renderFree(ctx) {
  const { S, g, $ } = ctx;
  const box = $('#freeBox');
  if (!S.free) { box.innerHTML = ''; return; }
  const f = S.free;
  const label = f.basePly ? `${moveNo(f.basePly)} ${fig(g.moves[f.basePly - 1].san)}` : 'la position de départ';
  box.innerHTML = `<div class="free-banner">
    <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap">
      <b>${f.fromLine ? 'Variante de Stockfish' : 'Mode libre'} <span class="muted small">après ${esc(label)}</span></b>
      <span class="row">${f.fromLine ? '<button id="playLine">▶ Jouer</button>' : ''}<button class="primary" id="backToGame">↩ Revenir à la partie</button></span>
    </div>
    <div class="free-moves">${f.items.map((it, i) => `<div class="mv${f.cursor === i + 1 ? ' cur' : ''}" data-cursor="${i + 1}">${it.pending ? '<span class="spinner"></span>' : symbol(it.result?.classification)}<span class="san">${esc(fig(it.san))}</span></div>`).join('') || '<span class="small muted">Jouez un coup sur l\'échiquier.</span>'}</div>
  </div>`;
}
