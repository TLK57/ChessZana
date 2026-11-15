// Écran d'une partie — échiquier (chessground), barre d'évaluation et joueurs avec leur pendule.
import { Chessground } from '/vendor/chessground.js';
import { Chess } from '/vendor/chess.js';
import { esc, BAD, fmtClock, symbol } from './util.js';

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

/** Classement du coup affiché : coup de la partie, ou coup joué en mode libre une fois analysé. */
const shownClassification = (nd) => nd.move?.classification ?? nd.item?.result?.classification ?? null;

/** Échiquier de l'écran : onMove(orig, dest) est appelé quand l'utilisateur joue un coup. */
export function createBoard(ctx, onMove) {
  // Couche de la pastille du classement, posée sur le plateau (chessground la remet en place s'il redessine tout).
  const badgeLayer = document.createElement('div');
  badgeLayer.className = 'cls-layer';
  let badgeKey = '';

  const cg = Chessground(ctx.$('#board'), {
    coordinates: true,
    orientation: ctx.S.orientation,
    animation: { enabled: true, duration: 160 },
    highlight: { lastMove: true, check: true },
    movable: { free: false, showDests: true, events: { after: (o, d) => onMove(o, d) } },
    premovable: { enabled: false },
    draggable: { showGhost: true },
    drawable: { enabled: true, visible: true },
    // Taille réelle du plateau dessiné (---cg-height) : la barre d'évaluation prend exactement la même hauteur.
    addDimensionsCssVarsTo: ctx.$('.board-row'),
    events: { insert: (elements) => elements.container.appendChild(badgeLayer) },
  });

  // Pastille ronde en haut à droite de la case d'arrivée (comme chess.com) : même symbole et même couleur que
  // dans la feuille de notation (symbol() et les classes .c-… de util.js / app.css). Rien sur la position de départ.
  function renderBadge(cls, dest) {
    const white = ctx.S.orientation === 'white';
    const key = cls && dest ? `${cls}|${dest}|${white}` : '';
    if (key === badgeKey) return;
    badgeKey = key;
    if (!key) { badgeLayer.innerHTML = ''; return; }
    const file = dest.charCodeAt(0) - 97;
    const rank = Number(dest[1]) - 1;
    const col = white ? file : 7 - file;
    const row = white ? 7 - rank : rank;
    badgeLayer.innerHTML = `<div class="cls-square" style="left:${col * 12.5}%;top:${row * 12.5}%">${symbol(cls, false)}</div>`;
  }

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
    renderBadge(shownClassification(nd), nd.lastMove?.[1]);
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
    return `<span class="who"><span class="colordot ${color}"></span>${esc(p.name)} ${p.elo ? `<span class="muted">${p.elo}</span>` : ''}${me}</span>${clk != null ? `<span class="clock" title="Temps restant à la pendule">${fmtClock(clk)}</span>` : ''}`;
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
  bar.setAttribute('aria-label', bar.title);
}
