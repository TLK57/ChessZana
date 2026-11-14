// Écran d'une partie — échiquier (chessground), barre d'évaluation et joueurs avec leur pendule.
import { Chessground } from '/vendor/chessground.js';
import { Chess } from '/vendor/chess.js';
import { esc, BAD, fmtClock } from './util.js';

export function destsOf(chess) {
  const d = new Map();
  for (const m of chess.moves({ verbose: true })) {
    if (!d.has(m.from)) d.set(m.from, []);
    d.get(m.from).push(m.to);
  }
  return d;
}

export function askPromotion(color) {
  return new Promise((resolve) => {
    const glyphs = color === 'w' ? { q: '♕', r: '♖', b: '♗', n: '♘' } : { q: '♛', r: '♜', b: '♝', n: '♞' };
    const wrap = document.createElement('div');
    wrap.className = 'promo';
    wrap.innerHTML = `<div class="box">${Object.entries(glyphs).map(([k, g]) => `<button data-p="${k}" title="Promotion">${g}</button>`).join('')}</div>`;
    wrap.onclick = (e) => {
      const b = e.target.closest('button[data-p]');
      wrap.remove();
      resolve(b ? b.dataset.p : null);
    };
    document.body.appendChild(wrap);
  });
}

/** Échiquier de l'écran : onMove(orig, dest) est appelé quand l'utilisateur joue un coup. */
export function createBoard(ctx, onMove) {
  const cg = Chessground(ctx.$('#board'), {
    coordinates: true,
    orientation: ctx.S.orientation,
    animation: { enabled: true, duration: 160 },
    highlight: { lastMove: true, check: true },
    movable: { free: false, showDests: true, events: { after: (o, d) => onMove(o, d) } },
    premovable: { enabled: false },
    draggable: { showGhost: true },
    drawable: { enabled: true, visible: true },
  });

  function boardShapes(nd) {
    const shapes = [];
    const show = (uci, brush = 'green') => { if (uci) shapes.push({ orig: uci.slice(0, 2), dest: uci.slice(2, 4), brush }); };
    if (nd.move && BAD.has(nd.move.classification)) show(nd.move.bestUci);
    if (nd.item?.result && BAD.has(nd.item.result.classification)) show(nd.item.result.bestUci);
    return shapes;
  }

  function update(nd) {
    const chess = new Chess(nd.fen);
    const turn = chess.turn() === 'w' ? 'white' : 'black';
    cg.set({
      fen: nd.fen,
      orientation: ctx.S.orientation,
      turnColor: turn,
      lastMove: nd.lastMove ?? undefined,
      check: chess.inCheck() ? turn : false,
      movable: { color: chess.isGameOver() ? undefined : turn, dests: destsOf(chess) },
    });
    if (!nd.lastMove) cg.set({ lastMove: undefined });
    cg.setAutoShapes(boardShapes(nd));
  }

  return { update, destroy: () => cg.destroy() };
}

function clockAt(ctx, color, ply) {
  const { g } = ctx;
  for (let i = Math.min(ply, ctx.n()) - 1; i >= 0; i--) if (g.moves[i].color === color && g.moves[i].clockMs != null) return g.moves[i].clockMs;
  return g.moves.find((m) => m.color === color && m.clockMs != null) ? null : undefined;
}

export function renderPlayers(ctx) {
  const { S, g, $ } = ctx;
  const ply = S.free ? S.free.basePly : S.ply;
  const line = (color) => {
    const p = color === 'white' ? g.white : g.black;
    const clk = clockAt(ctx, color === 'white' ? 'w' : 'b', ply);
    const me = g.myColor === color ? ' <span class="muted small">(vous)</span>' : '';
    return `<span><span class="colordot ${color}"></span> ${esc(p.name)} ${p.elo ? `<span class="muted">(${p.elo})</span>` : ''}${me}</span><span class="clock">${clk != null ? fmtClock(clk) : ''}</span>`;
  };
  const bottom = S.orientation;
  $('#bottomPlayer').innerHTML = line(bottom);
  $('#topPlayer').innerHTML = line(bottom === 'white' ? 'black' : 'white');
}

export function renderEvalBar(ctx, nd) {
  const bar = ctx.$('#evalbar');
  const w = nd.win == null ? 50 : nd.win;
  bar.querySelector('.white').style.height = `${w}%`;
  bar.classList.toggle('flipped', ctx.S.orientation === 'black');
  const top = bar.querySelector('.txt.top');
  const bottom = bar.querySelector('.txt.bottom');
  top.textContent = ''; bottom.textContent = '';
  if (nd.text) {
    const white = w >= 50;
    const label = nd.text.replace(/^\+/, '').replace(/ \(table\)$/, '');
    if (white) bottom.textContent = label; else top.textContent = label.replace(/^[−-]/, '');
  }
  bar.title = nd.text ? `Évaluation : ${nd.text} (${Math.round(w)} % de chances de gain pour les Blancs)` : 'Pas encore analysé';
}
