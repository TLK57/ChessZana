// Écran d'analyse d'une partie. Ce fichier garde l'état, la navigation et les événements ; le reste est découpé en :
//   game-board.js  : échiquier, barre d'évaluation, joueurs et pendules ;
//   game-moves.js  : liste des coups, résumé par joueur, ouverture ;
//   game-detail.js : panneau d'explication du coup (classement, explication, lignes, profondeur) ;
//   game-free.js   : mode libre (coups joués sur l'échiquier, variantes de Stockfish) ;
//   game-prompt.js : question prête à copier pour « Demander à Claude ».
import { api, esc, fmtDate, toast, TIME_CLASS } from './util.js';
import { createGraph } from './graph.js';
import { createBoard, renderEvalBar, renderPlayers } from './game-board.js';
import { renderMoves, renderOpening, renderSummary } from './game-moves.js';
import { depthSummary, renderDetail } from './game-detail.js';
import { createFreeMode, renderFree } from './game-free.js';
import { askClaude, claudeText } from './game-prompt.js';

const MARKED = new Set(['blunder', 'mistake', 'miss']);
const RESULT_TXT = { '1-0': 'Victoire des Blancs', '0-1': 'Victoire des Noirs', '1/2-1/2': 'Nulle' };

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

  // Contexte partagé avec les modules de l'écran (g est remplacé quand une analyse se termine).
  const ctx = { id, root, $, S, n, node, render, go, get g() { return g; } };

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

  // ------------------------------------------------------------------ échiquier et mode libre
  const free = createFreeMode(ctx);
  const board = createBoard(ctx, (orig, dest) => free.onBoardMove(orig, dest));
  const stopPlaying = () => free.stopPlaying();

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
    board.update(nd);
    renderEvalBar(ctx, nd);
    renderPlayers(ctx);
    renderMoves(ctx);
    renderFree(ctx);
    renderDetail(ctx, nd);
    if (g.pass) graph.update(graphData());
    $('#graphBox').hidden = !g.pass;
    $('#graphNote').textContent = g.pass ? `${depthSummary(g)} Cliquez sur le graphe pour aller à un coup. Points : gaffes (rouge), erreurs (orange), occasions manquées.` : 'Graphe disponible après l\'analyse.';
  }

  function renderHeader() {
    $('#title').textContent = `${g.white.name} (${g.white.elo ?? '?'}) – ${g.black.name} (${g.black.elo ?? '?'})`;
    $('#sub').innerHTML = `${esc(RESULT_TXT[g.result] ?? g.result)} · ${fmtDate(g.playedAt)} · ${esc(TIME_CLASS[g.timeClass] ?? g.timeClass ?? '')} ${esc(g.timeControl ?? '')}${g.url ? ` · <a href="${esc(g.url)}" target="_blank" rel="noopener">voir en ligne</a>` : ''}`;
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
    if (chip) { const base = Number(chip.dataset.base); free.loadLine(base, currentExplanationLine(), lineEvalFor(base), Number(chip.dataset.best) + 1); return; }
    if (t.closest('#playBest')) { const base = Number(t.closest('#playBest').dataset.base); free.loadLine(base, currentExplanationLine(), lineEvalFor(base), 0); free.playLine(); return; }
    const pv = t.closest('a.pv[data-line]');
    if (pv) { e.preventDefault(); const base = Number(pv.dataset.base); const l = currentLines()[Number(pv.dataset.line)]; if (l) free.loadLine(base, l.line, { win: null, text: l.evalText }, 1); return; }
    if (t.closest('#backToGame')) { const base = S.free.basePly; const wasLine = S.free.fromLine; go(wasLine ? base + 1 : base); return; }
    if (t.closest('#playLine')) { if (S.free.cursor >= S.free.items.length) S.free.cursor = 0; free.playLine(); return; }
    if (t.closest('#askClaude')) { askClaude(ctx); return; }
    if (t.closest('#prio')) { await api(`/api/games/${id}/prioritize`, {}); g.requested = true; render(); toast("Analyse demandée : la partie passe en tête de la file. Le résultat s'affichera automatiquement."); return; }
    if (t.closest('#reverify')) { await api(`/api/games/${id}/prioritize`, { reverify: true }); g.requested = true; render(); toast('Vérification demandée : seuls les coups douteux seront recalculés.'); return; }
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
      if (fresh.pass !== g.pass) { g = fresh; renderHeader(); renderSummary(ctx); renderOpening(ctx); render(); toast(`Analyse ${g.pass === 'deep' ? 'profonde' : 'rapide'} terminée pour cette partie.`); }
    } catch { /* serveur arrêté */ }
  }, 10000);

  renderHeader();
  renderSummary(ctx);
  renderOpening(ctx);
  render();

  // Accès pour les tests manuels depuis la console.
  // play('d2', 'd4') joue un coup comme sur l'échiquier (mode libre).
  window.__partie = { state: S, go, jumpTo, play: (orig, dest) => free.onBoardMove(orig, dest), claudeText: () => claudeText(ctx), get data() { return g; } };

  return () => {
    window.removeEventListener('keydown', onKey);
    clearInterval(poll);
    stopPlaying();
    graph.destroy();
    board.destroy();
    delete window.__partie;
  };
}
