// Écran d'analyse d'une partie : échiquier, barre et graphe d'évaluation, coups classés, résumé cliquable,
// explications, mode libre (Stockfish en direct) et bouton « Demander à Claude ».
import { Chessground } from '/vendor/chessground.js';
import { Chess } from '/vendor/chess.js';
import {
  api, esc, fig, symbol, LABELS, ORDER, BAD, fmtPct, fmtClock, fmtSpent, fmtDate, moveNo, lineText, toast, copyText, TIME_CLASS,
} from './util.js';
import { createGraph } from './graph.js';

const MARKED = new Set(['blunder', 'mistake', 'miss']);
const RESULT_TXT = { '1-0': 'Victoire des Blancs', '0-1': 'Victoire des Noirs', '1/2-1/2': 'Nulle' };

function destsOf(chess) {
  const d = new Map();
  for (const m of chess.moves({ verbose: true })) {
    if (!d.has(m.from)) d.set(m.from, []);
    d.get(m.from).push(m.to);
  }
  return d;
}

function askPromotion(color) {
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

export async function renderGame(root, id, startPly = 0) {
  let g;
  try {
    g = await api(`/api/games/${id}/view`);
  } catch (e) {
    root.innerHTML = `<div class="card">Impossible d'ouvrir cette partie : ${esc(e.message)}. <a href="#/">Retour à la liste</a></div>`;
    return null;
  }

  const S = { ply: Math.max(0, Math.min(g.moves.length, startPly)), free: null, orientation: g.myColor ?? 'white', playing: null };
  const n = () => g.moves.length;

  root.innerHTML = `
    <div class="game-head">
      <a href="#/">← Mes parties</a>
      <h1 id="title"></h1>
      <span class="muted" id="sub"></span>
    </div>
    <div class="game-layout">
      <div class="board-col">
        <div class="player-line" id="topPlayer"></div>
        <div class="board-row">
          <div class="evalbar" id="evalbar"><div class="white"></div><div class="txt top"></div><div class="txt bottom"></div></div>
          <div class="board-wrap"><div class="board" id="board"></div></div>
        </div>
        <div class="player-line" id="bottomPlayer"></div>
        <div class="controls">
          <button id="bStart" title="Début (touche Début)">⏮</button>
          <button id="bPrev" title="Coup précédent (flèche gauche)">◀</button>
          <button id="bNext" title="Coup suivant (flèche droite)">▶</button>
          <button id="bEnd" title="Fin (touche Fin)">⏭</button>
          <button id="bFlip" title="Retourner l'échiquier">⇅</button>
        </div>
        <div id="graphBox"></div>
        <p class="small muted" style="margin-left:30px" id="graphNote"></p>
      </div>
      <div class="side-col">
        <div class="summary" id="summary"></div>
        <div id="freeBox"></div>
        <div class="card detail" id="detail"></div>
        <div class="moves" id="moves"></div>
        <div class="card small" id="openingBox"></div>
      </div>
    </div>`;
  const $ = (sel) => root.querySelector(sel);

  // ------------------------------------------------------------------ état courant
  function node() {
    if (S.free) {
      const f = S.free;
      if (f.cursor === 0) return { ...gameNode(f.basePly), free: true, item: null };
      const it = f.items[f.cursor - 1];
      const base = gameNode(f.basePly);
      let win = base.win, text = base.text;
      for (let i = 0; i < f.cursor; i++) {
        const r = f.items[i].result;
        if (r) { win = r.winWhiteAfter; text = r.evalAfterText; }
        else if (f.items[i].lineEval) { win = f.items[i].lineEval.win; text = f.items[i].lineEval.text; }
      }
      return { fen: it.fenAfter, lastMove: [it.uci.slice(0, 2), it.uci.slice(2, 4)], win, text, free: true, item: it };
    }
    return gameNode(S.ply);
  }

  function gameNode(ply) {
    if (ply === 0) return { fen: g.startFen, lastMove: null, win: g.startWin, text: g.startEvalText, move: null };
    const m = g.moves[ply - 1];
    return { fen: m.fenAfter, lastMove: [m.uci.slice(0, 2), m.uci.slice(2, 4)], win: m.winWhiteAfter, text: m.evalAfterText, move: m };
  }

  // ------------------------------------------------------------------ échiquier
  const cg = Chessground($('#board'), {
    coordinates: true,
    orientation: S.orientation,
    animation: { enabled: true, duration: 160 },
    highlight: { lastMove: true, check: true },
    movable: { free: false, showDests: true, events: { after: (o, d) => onBoardMove(o, d) } },
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

  function updateBoard(nd) {
    const chess = new Chess(nd.fen);
    const turn = chess.turn() === 'w' ? 'white' : 'black';
    cg.set({
      fen: nd.fen,
      orientation: S.orientation,
      turnColor: turn,
      lastMove: nd.lastMove ?? undefined,
      check: chess.inCheck() ? turn : false,
      movable: { color: chess.isGameOver() ? undefined : turn, dests: destsOf(chess) },
    });
    if (!nd.lastMove) cg.set({ lastMove: undefined });
    cg.setAutoShapes(boardShapes(nd));
  }

  // ------------------------------------------------------------------ coups joués sur l'échiquier (mode libre)
  async function onBoardMove(orig, dest) {
    const nd = node();
    const chess = new Chess(nd.fen);
    const piece = chess.get(orig);
    let promotion;
    if (piece?.type === 'p' && (dest[1] === '8' || dest[1] === '1')) {
      promotion = await askPromotion(piece.color);
      if (!promotion) { render(); return; }
    }
    let mv;
    try { mv = chess.move({ from: orig, to: dest, promotion }); } catch { mv = null; }
    if (!mv) { render(); return; }
    const uci = mv.from + mv.to + (mv.promotion ?? '');
    stopPlaying();
    if (!S.free) {
      const next = g.moves[S.ply];
      if (next && next.uci === uci) { go(S.ply + 1); return; }
      S.free = { basePly: S.ply, items: [], cursor: 0 };
    } else {
      const nextItem = S.free.items[S.free.cursor];
      if (nextItem && nextItem.uci === uci) { S.free.cursor++; render(); return; }
    }
    const f = S.free;
    f.items = f.items.slice(0, f.cursor);
    const item = {
      san: mv.san, uci, color: mv.color, moveNumber: Number(nd.fen.split(' ')[5]),
      fenBefore: nd.fen, fenAfter: chess.fen(), pending: true, result: null,
    };
    f.items.push(item);
    f.cursor = f.items.length;
    render();
    analyseFreeMove(item, f.items.length - 1);
  }

  function prevForFree(index) {
    const f = S.free;
    if (index > 0) {
      const p = f.items[index - 1];
      return p.result ? { classification: p.result.classification, winBest: p.result.winBest, uci: p.uci, san: p.san } : null;
    }
    const gm = g.moves[f.basePly - 1];
    return gm && gm.classification ? { classification: gm.classification, winBest: gm.winBest, uci: gm.uci, san: gm.san } : null;
  }

  // Deux temps : un avis immédiat (profondeur 12), puis le résultat affiné (profondeur du mode libre).
  async function analyseFreeMove(item, index) {
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
      if (S.free === f) render();
      if (!item.provisional) break;
      if (S.free !== f || !f.items.includes(item)) break; // le coup a été effacé entre-temps
    }
  }

  // Charge une ligne de Stockfish comme variante jouable sur l'échiquier.
  function loadLine(basePly, line, evalInfo, cursor = 1) {
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
    render();
  }

  function playLine() {
    stopPlaying();
    if (!S.free) return;
    S.playing = setInterval(() => {
      if (!S.free || S.free.cursor >= S.free.items.length) { stopPlaying(); return; }
      S.free.cursor++;
      render();
    }, 900);
  }
  function stopPlaying() { if (S.playing) { clearInterval(S.playing); S.playing = null; } }

  // ------------------------------------------------------------------ navigation
  function go(ply) {
    stopPlaying();
    S.free = null;
    S.ply = Math.max(0, Math.min(n(), ply));
    // L'adresse garde le coup affiché (rafraîchir la page ou un favori rouvre au même endroit).
    history.replaceState(null, '', `#/partie/${id}/${S.ply}`);
    render();
  }
  function step(d) {
    stopPlaying();
    if (S.free) {
      const f = S.free;
      if (d < 0 && f.cursor === 0) { S.free = null; S.ply = Math.max(0, f.basePly - 1); render(); return; }
      f.cursor = Math.max(0, Math.min(f.items.length, f.cursor + d));
      render();
      return;
    }
    go(S.ply + d);
  }
  function toStart() { if (S.free) { stopPlaying(); S.free.cursor = 0; render(); } else go(0); }
  function toEnd() { if (S.free) { stopPlaying(); S.free.cursor = S.free.items.length; render(); } else go(n()); }

  function jumpTo(color, cls) {
    const plies = g.moves.filter((m) => m.color === color && m.classification === cls).map((m) => m.ply);
    if (!plies.length) return;
    const from = S.free ? S.free.basePly : S.ply;
    go(plies.find((p) => p > from) ?? plies[0]);
  }

  // ------------------------------------------------------------------ rendu
  function clockAt(color, ply) {
    for (let i = Math.min(ply, n()) - 1; i >= 0; i--) if (g.moves[i].color === color && g.moves[i].clockMs != null) return g.moves[i].clockMs;
    return g.moves.find((m) => m.color === color && m.clockMs != null) ? null : undefined;
  }

  function renderPlayers() {
    const ply = S.free ? S.free.basePly : S.ply;
    const line = (color) => {
      const p = color === 'white' ? g.white : g.black;
      const clk = clockAt(color === 'white' ? 'w' : 'b', ply);
      const me = g.myColor === color ? ' <span class="muted small">(vous)</span>' : '';
      return `<span><span class="colordot ${color}"></span> ${esc(p.name)} ${p.elo ? `<span class="muted">(${p.elo})</span>` : ''}${me}</span><span class="clock">${clk != null ? fmtClock(clk) : ''}</span>`;
    };
    const bottom = S.orientation;
    $('#bottomPlayer').innerHTML = line(bottom);
    $('#topPlayer').innerHTML = line(bottom === 'white' ? 'black' : 'white');
  }

  function renderEvalBar(nd) {
    const bar = $('#evalbar');
    const w = nd.win == null ? 50 : nd.win;
    bar.querySelector('.white').style.height = `${w}%`;
    bar.classList.toggle('flipped', S.orientation === 'black');
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

  function renderSummary() {
    const card = (color) => {
      const p = color === 'white' ? g.white : g.black;
      const c = color === 'white' ? 'w' : 'b';
      return `<div class="card">
        <div class="who"><span class="colordot ${color}"></span>${esc(p.name)}${g.myColor === color ? ' <span class="muted small">(vous)</span>' : ''}</div>
        <div class="big">${fmtPct(p.accuracy)}<span class="small muted"> % précision</span></div>
        <div class="small" title="${g.calibration?.enabled ? `Estimation calibrée sur vos parties (sans calibrage : ${p.estEloGeneric ?? '–'})` : 'Estimation générique'}">Elo estimé : <b>${p.estElo ?? '–'}</b> <span class="muted">(${g.calibration?.enabled ? 'estimation calibrée' : 'estimation'})</span></div>
        <div class="counters">${ORDER.map((k) => {
          const v = p.counts?.[k] ?? 0;
          return `<button class="counter" data-color="${c}" data-cls="${k}" ${v ? '' : 'disabled'} title="${v ? 'Aller au coup suivant de ce type' : ''}">${symbol(k, false)} ${LABELS[k]} <span class="n">${v}</span></button>`;
        }).join('')}</div>
      </div>`;
    };
    $('#summary').innerHTML = card('white') + card('black');
  }

  function renderOpening() {
    const o = g.opening;
    const exit = o.exitPly ? `<a href="#" data-goto="${o.exitPly}">${moveNo(o.exitPly)} ${esc(fig(o.exitSan))}</a>` : null;
    $('#openingBox').innerHTML = `
      <div><b>Ouverture :</b> ${o.name ? `${esc(o.name)} <span class="muted">(${esc(o.eco ?? '')})</span>` : '<span class="muted">non trouvée dans la base</span>'}</div>
      <div class="small">${exit ? `Sortie de la théorie : ${exit}` : o.name ? 'La partie est restée dans la théorie.' : ''}</div>`;
  }

  function renderMoves() {
    const rows = [];
    for (let i = 0; i < n(); i += 2) {
      const w = g.moves[i];
      const b = g.moves[i + 1];
      const cell = (m) => (m ? `<div class="mv${!S.free && S.ply === m.ply ? ' cur' : ''}" data-ply="${m.ply}">${symbol(m.classification)}<span class="san ${m.classification ? `t-${m.classification}` : ''}">${esc(fig(m.san))}</span><span class="spent">${fmtSpent(m.timeSpentMs)}</span></div>` : '');
      // Si la partie commence par un coup noir (position personnalisée), décaler.
      rows.push(`<tr><td class="no">${Math.ceil(w.ply / 2)}.</td><td>${w.color === 'w' ? cell(w) : ''}</td><td>${w.color === 'b' ? cell(w) : cell(b)}</td></tr>`);
      if (w.color === 'b') i -= 1;
    }
    const box = $('#moves');
    box.innerHTML = `<table>${rows.join('')}</table>`;
    // Fait défiler la liste des coups (et seulement elle) pour garder le coup courant visible.
    const cur = box.querySelector('.mv.cur');
    if (cur) {
      const cr = cur.getBoundingClientRect();
      const br = box.getBoundingClientRect();
      if (cr.top < br.top) box.scrollTop -= br.top - cr.top + 24;
      else if (cr.bottom > br.bottom) box.scrollTop += cr.bottom - br.bottom + 24;
    } else if (!S.free && S.ply === 0) box.scrollTop = 0;
  }

  function linesHtml(lines, basePly) {
    if (!lines?.length) return '';
    return `<div class="lines"><div class="small muted">Meilleures lignes de Stockfish avant ce coup :</div>${lines.map((l, i) => `
      <div class="line"><span class="ev">${esc(l.evalText)}</span><a href="#" class="pv" data-line="${i}" data-base="${basePly}">${esc(lineText(l.line.slice(0, 8)))}</a></div>`).join('')}</div>`;
  }

  function claudeButton() {
    return '<button id="askClaude" title="Copie une question prête à coller sur claude.ai">🤖 Demander à Claude</button>';
  }

  function moveDetailHtml(m, basePly, { live = false } = {}) {
    // m : coup de la partie, ou résultat d'analyse en direct (mêmes champs)
    const cls = m.classification;
    const parts = [];
    parts.push(`<h3>${moveNo(basePly + 1)} ${esc(fig(m.san))} ${cls ? `${symbol(cls)} <span class="t-${cls}">${esc(LABELS[cls])}</span>` : ''}</h3>`);
    const stats = [];
    if (m.loss != null && cls !== 'book') stats.push(`Perte : <b>${fmtPct(m.loss)} %</b> de chances de gain`);
    if (m.accuracy != null && cls !== 'book') stats.push(`précision du coup : ${fmtPct(m.accuracy, 0)}`);
    if (m.evalAfterText) stats.push(`éval. après le coup : ${esc(m.evalAfterText)}`);
    if (stats.length) parts.push(`<p class="small">${stats.join(' · ')}</p>`);
    if (!live && m.timeSpentMs != null) parts.push(`<p class="small">⏱ Temps utilisé : <b>${fmtSpent(m.timeSpentMs)}</b>${m.clockMs != null ? ` · il restait ${fmtClock(m.clockMs)}` : ''}</p>`);
    if (cls === 'book') parts.push(`<p>Coup de théorie${g.opening.name ? ` (${esc(g.opening.name)})` : ''}.</p>`);
    if (!live && g.opening.exitPly === basePly + 1) parts.push('<p class="small"><b>Sortie de la théorie</b> : ce coup ne figure plus dans la base d\'ouvertures.</p>');
    if (cls === 'brilliant') parts.push('<p>Sacrifice de matériel correct : seul un très bon calcul le trouve.</p>');
    if (cls === 'great') parts.push('<p>Seul coup qui tenait la position : les autres coups perdaient nettement.</p>');
    if (m.explanation) {
      parts.push(`<div class="explain"><p><b>Meilleur coup : ${esc(fig(m.bestSan))}</b></p>${m.explanation.sentences.map((s) => `<p>${esc(s)}</p>`).join('')}
        ${m.explanation.bestLine?.length ? `<div class="small muted">Suite de Stockfish (cliquez pour la jouer sur l'échiquier) :</div>
        <div class="chips">${m.explanation.bestLine.map((x, i) => `${x.color === 'w' || i === 0 ? `<span class="chip num">${x.moveNumber}${x.color === 'w' ? '.' : '...'}</span>` : ''}<button class="chip" data-best="${i}" data-base="${basePly}">${esc(fig(x.san))}</button>`).join('')}</div>
        <div class="actions"><button id="playBest" data-base="${basePly}">▶ Voir la suite sur l'échiquier</button></div>` : ''}
      </div>`);
    } else if (m.bestSan && m.bestUci !== m.uci && cls && !['book', 'best', 'brilliant', 'great'].includes(cls)) {
      parts.push(`<p class="small">Stockfish préférait ${esc(fig(m.bestSan))}.</p>`);
    }
    parts.push(linesHtml(m.lines, basePly));
    if (cls) parts.push(`<div class="actions">${claudeButton()}</div>`);
    return parts.join('');
  }

  function renderDetail(nd) {
    const box = $('#detail');
    if (S.free) {
      const f = S.free;
      const it = nd.item;
      if (!it) { box.innerHTML = `<p>Position de la partie après ${f.basePly ? `${moveNo(f.basePly)} ${esc(fig(g.moves[f.basePly - 1].san))}` : 'le départ'}.</p><p class="small muted">Jouez un coup sur l'échiquier : Stockfish l'évalue en direct.</p>`; return; }
      const ply = f.basePly + f.cursor - 1;
      if (it.engine) {
        box.innerHTML = `<h3>${moveNo(ply + 1)} ${esc(fig(it.san))} <span class="muted small">— variante de Stockfish</span></h3>
          <p class="small muted">Utilisez ◀ ▶ (ou les flèches du clavier) pour avancer dans la suite, ou jouez vos propres coups.</p>
          ${it.lineEval?.text ? `<p class="small">Évaluation de la ligne : <b>${esc(it.lineEval.text)}</b></p>` : ''}`;
        return;
      }
      if (it.pending) { box.innerHTML = `<h3>${moveNo(ply + 1)} ${esc(fig(it.san))}</h3><p><span class="spinner"></span> Stockfish analyse votre coup…</p>`; return; }
      if (it.error) { box.innerHTML = `<h3>${moveNo(ply + 1)} ${esc(fig(it.san))}</h3><p class="t-blunder">Analyse impossible : ${esc(it.error)}</p>`; return; }
      box.innerHTML = moveDetailHtml({ ...it.result, san: it.san, uci: it.uci }, ply, { live: true })
        + (it.provisional ? `<p class="small muted"><span class="spinner"></span> Premier avis (profondeur ${it.result.depth}) — Stockfish affine son analyse…</p>`
          : `<p class="small muted">Analyse en direct : profondeur ${it.result.depth}${it.result.source === 'lichess-cloud' ? ' (cloud Lichess)' : it.result.source === 'tablebase' ? ' (table de finales)' : ''}.</p>`);
      return;
    }
    if (S.ply === 0) {
      box.innerHTML = `<h3>Position de départ</h3>
        <p class="small">Naviguez avec les flèches ← → du clavier (Début / Fin pour aller au début ou à la fin), en cliquant sur les coups ou sur le graphe.</p>
        <p class="small">Vous pouvez aussi jouer vos propres coups sur l'échiquier (mode libre).</p>
        ${g.pass ? '' : '<p>Cette partie n\'est pas encore analysée.</p>'}`;
    } else {
      box.innerHTML = moveDetailHtml(g.moves[S.ply - 1], S.ply - 1);
    }
    if (g.pass !== 'deep') {
      box.insertAdjacentHTML('beforeend', g.status === 'running'
        ? "<p class=\"small\"><span class=\"spinner\"></span> Analyse de cette partie en cours… le résultat s'affichera tout seul.</p>"
        : g.requested
          ? '<div class="actions"><span class="small">Analyse demandée : elle démarrera dès que le moteur sera libre.</span><button id="unprio">Annuler la demande</button></div>'
          : `<div class="actions"><button class="primary" id="prio">${g.pass ? 'Analyser en profondeur (quelques minutes)' : 'Analyser cette partie'}</button></div>`);
    }
  }

  function renderFree() {
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

  function graphData() {
    const series = [g.startWin, ...g.moves.map((m) => m.winWhiteAfter)];
    return {
      series, moves: g.moves,
      marks: g.moves.filter((m) => MARKED.has(m.classification)).map((m) => ({ ply: m.ply, cls: m.classification })),
      current: S.free ? S.free.basePly : S.ply,
      freeBase: S.free ? S.free.basePly : null,
    };
  }

  const graph = createGraph($('#graphBox'), (ply) => go(ply));

  function render() {
    const nd = node();
    updateBoard(nd);
    renderEvalBar(nd);
    renderPlayers();
    renderMoves();
    renderFree();
    renderDetail(nd);
    if (g.pass) graph.update(graphData());
    $('#graphBox').hidden = !g.pass;
    $('#graphNote').textContent = g.pass ? `Analyse ${g.pass === 'deep' ? 'profonde' : 'rapide'} (profondeur ${g.pass === 'deep' ? 'médiane ' : ''}${g.depth ?? '?'}). Cliquez sur le graphe pour aller à un coup. Points : gaffes (rouge), erreurs (orange), occasions manquées.` : 'Graphe disponible après l\'analyse.';
  }

  function renderHeader() {
    $('#title').textContent = `${g.white.name} (${g.white.elo ?? '?'}) – ${g.black.name} (${g.black.elo ?? '?'})`;
    $('#sub').innerHTML = `${esc(RESULT_TXT[g.result] ?? g.result)} · ${fmtDate(g.playedAt)} · ${esc(TIME_CLASS[g.timeClass] ?? g.timeClass ?? '')} ${esc(g.timeControl ?? '')}${g.url ? ` · <a href="${esc(g.url)}" target="_blank" rel="noopener">voir en ligne</a>` : ''}`;
  }

  // ------------------------------------------------------------------ « Demander à Claude »
  function claudeText() {
    let fenBefore, previous, move, label, loss, lines, depth, color;
    if (S.free && node().item?.result) {
      const f = S.free;
      const it = node().item;
      fenBefore = it.fenBefore;
      previous = [...g.moves.slice(0, f.basePly).map((m) => ({ san: m.san, color: m.color, moveNumber: Math.ceil(m.ply / 2) })),
        ...f.items.slice(0, f.cursor - 1).map((x) => ({ san: x.san, color: x.color, moveNumber: x.moveNumber }))];
      move = { san: it.san, color: it.color, moveNumber: it.moveNumber };
      ({ label, loss, lines, depth } = it.result);
      color = it.color;
    } else {
      const m = g.moves[S.ply - 1];
      if (!m) return null;
      fenBefore = m.fenBefore;
      previous = g.moves.slice(0, S.ply - 1).map((x) => ({ san: x.san, color: x.color, moveNumber: Math.ceil(x.ply / 2) }));
      move = { san: m.san, color: m.color, moveNumber: Math.ceil(m.ply / 2) };
      ({ label, loss, lines, depth } = m);
      color = m.color;
    }
    const myElo = g.myColor ? g[g.myColor].elo : (color === 'w' ? g.white.elo : g.black.elo);
    const moveTxt = `${move.moveNumber}${move.color === 'w' ? '.' : '...'} ${move.san} (${move.color === 'w' ? 'Blancs' : 'Noirs'})`;
    const linesTxt = (lines ?? []).map((l, i) => `  ${i + 1}) ${lineText(l.line.slice(0, 10), { figurines: false })}  —  évaluation ${l.evalText}`).join('\n');
    return [
      "Bonjour ! J'analyse une de mes parties d'échecs et j'aimerais comprendre un coup.",
      '',
      `Position avant le coup (FEN) : ${fenBefore}`,
      `Coups précédents : ${previous.length ? lineText(previous, { figurines: false }) : '(aucun, c\'est le premier coup)'}`,
      `Coup joué : ${moveTxt}`,
      `Classement de mon logiciel d'analyse : ${label ?? 'non analysé'}${loss != null ? ` (perte de ${fmtPct(loss)} % de chances de gain)` : ''}`,
      `Les 2 meilleures lignes de Stockfish 19${depth ? ` (profondeur ${depth})` : ''}, évaluations du point de vue des Blancs :`,
      linesTxt || '  (non disponibles)',
      `Mon Elo : ${myElo ?? 'inconnu'}`,
      '',
      'Explique-moi pourquoi mon coup est mauvais et quelle idée j\'aurais dû voir.',
    ].join('\n');
  }

  async function askClaude() {
    const text = claudeText();
    if (!text) return;
    S.lastClaude = text;
    const ok = await copyText(text);
    if (ok) {
      toast('Question copiée ! Collez-la (Ctrl+V) sur <a href="https://claude.ai/new" target="_blank" rel="noopener">claude.ai</a>.', 7000);
      return;
    }
    // Le navigateur a refusé l'accès au presse-papiers : on affiche le texte, prêt à copier à la main.
    const wrap = document.createElement('div');
    wrap.className = 'promo';
    wrap.innerHTML = `<div class="box" style="flex-direction:column;max-width:720px;width:92vw">
      <b>Copiez cette question (Ctrl+C), puis collez-la sur claude.ai</b>
      <textarea class="pgn" style="height:280px" readonly></textarea>
      <div class="actions"><a class="primary" href="https://claude.ai/new" target="_blank" rel="noopener">Ouvrir claude.ai</a><button data-close>Fermer</button></div></div>`;
    wrap.querySelector('textarea').value = text;
    wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]')) wrap.remove(); });
    document.body.appendChild(wrap);
    wrap.querySelector('textarea').select();
  }

  // ------------------------------------------------------------------ événements
  root.addEventListener('click', async (e) => {
    const t = e.target;
    const mv = t.closest('.mv[data-ply]');
    if (mv) { go(Number(mv.dataset.ply)); return; }
    const fm = t.closest('.mv[data-cursor]');
    if (fm && S.free) { stopPlaying(); S.free.cursor = Number(fm.dataset.cursor); render(); return; }
    const counter = t.closest('.counter[data-cls]');
    if (counter && !counter.disabled) { jumpTo(counter.dataset.color, counter.dataset.cls); return; }
    const gotoLink = t.closest('[data-goto]');
    if (gotoLink) { e.preventDefault(); go(Number(gotoLink.dataset.goto)); return; }
    const chip = t.closest('.chip[data-best]');
    if (chip) { const base = Number(chip.dataset.base); loadLine(base, currentExplanationLine(), lineEvalFor(base), Number(chip.dataset.best) + 1); return; }
    if (t.closest('#playBest')) { const base = Number(t.closest('#playBest').dataset.base); loadLine(base, currentExplanationLine(), lineEvalFor(base), 0); playLine(); return; }
    const pv = t.closest('a.pv[data-line]');
    if (pv) { e.preventDefault(); const base = Number(pv.dataset.base); const l = currentLines()[Number(pv.dataset.line)]; if (l) loadLine(base, l.line, { win: null, text: l.evalText }, 1); return; }
    if (t.closest('#backToGame')) { const base = S.free.basePly; const wasLine = S.free.fromLine; go(wasLine ? base + 1 : base); return; }
    if (t.closest('#playLine')) { if (S.free.cursor >= S.free.items.length) S.free.cursor = 0; playLine(); return; }
    if (t.closest('#askClaude')) { askClaude(); return; }
    if (t.closest('#prio')) { await api(`/api/games/${id}/prioritize`, {}); g.requested = true; render(); toast("Analyse demandée : la partie passe en tête de la file. Le résultat s'affichera automatiquement."); return; }
    if (t.closest('#unprio')) { await api(`/api/games/${id}/unrequest`, {}); g.requested = false; render(); toast("Demande d'analyse annulée."); return; }
  });

  function currentDetailMove() {
    if (S.free) return node().item?.result ?? null;
    return g.moves[S.ply - 1] ?? null;
  }
  function currentExplanationLine() { return currentDetailMove()?.explanation?.bestLine ?? []; }
  function currentLines() { return currentDetailMove()?.lines ?? []; }
  function lineEvalFor() {
    const m = currentDetailMove();
    const l = m?.lines?.[0];
    return l ? { win: null, text: l.evalText } : null;
  }

  $('#bStart').onclick = toStart;
  $('#bPrev').onclick = () => step(-1);
  $('#bNext').onclick = () => step(1);
  $('#bEnd').onclick = toEnd;
  $('#bFlip').onclick = () => { S.orientation = S.orientation === 'white' ? 'black' : 'white'; render(); };

  const onKey = (e) => {
    if (e.target.closest('input, textarea, select')) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    else if (e.key === 'Home' || e.key === 'ArrowUp') { e.preventDefault(); toStart(); }
    else if (e.key === 'End' || e.key === 'ArrowDown') { e.preventDefault(); toEnd(); }
    else if (e.key === 'f') { S.orientation = S.orientation === 'white' ? 'black' : 'white'; render(); }
  };
  window.addEventListener('keydown', onKey);

  // Mise à jour automatique quand l'analyse de la partie se termine.
  const poll = setInterval(async () => {
    if (g.pass === 'deep') return;
    try {
      const fresh = await api(`/api/games/${id}/view`);
      if (fresh.status !== g.status || fresh.requested !== g.requested) { g.status = fresh.status; g.requested = fresh.requested; if (fresh.pass === g.pass) render(); }
      if (fresh.pass !== g.pass) { g = fresh; renderHeader(); renderSummary(); renderOpening(); render(); toast(`Analyse ${g.pass === 'deep' ? 'profonde' : 'rapide'} terminée pour cette partie.`); }
    } catch { /* serveur arrêté */ }
  }, 10000);

  renderHeader();
  renderSummary();
  renderOpening();
  render();

  // Accès pour les tests manuels depuis la console.
  window.__partie = { state: S, go, jumpTo, claudeText, get data() { return g; } };

  return () => {
    window.removeEventListener('keydown', onKey);
    clearInterval(poll);
    stopPlaying();
    graph.destroy();
    cg.destroy();
    delete window.__partie;
  };
}
