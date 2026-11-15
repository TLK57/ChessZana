// Écran d'analyse d'une partie. Ce fichier garde l'état, la navigation et les événements ; le reste est découpé en :
//   game-board.js  : échiquier, barre d'évaluation, joueurs et pendules ;
//   game-moves.js  : liste des coups, résumé par joueur, ouverture ;
//   game-detail.js : panneau d'explication du coup (classement, explication, lignes, profondeur) ;
//   game-free.js   : mode libre (coups joués sur l'échiquier, variantes de Stockfish) ;
//   game-prompt.js : question prête à copier pour « Demander à Claude » ;
//   game-review.js : saisie du bilan chess.com de la partie ;
//   review.js      : bilan guidé (les moments clés, un par un).
import { api, esc, fig, fmtDate, toast, TIME_CLASS, LABELS, SYMBOLS, moveNo, fmtTimeControl } from './util.js';
import { createGraph } from './graph.js';
import { createBoard, renderEvalBar, renderPlayers } from './game-board.js';
import { renderMoves, renderOpening, renderSummary } from './game-moves.js';
import { depthSummary, renderDetail } from './game-detail.js';
import { createFreeMode, renderFree } from './game-free.js';
import { askClaude, claudeText } from './game-prompt.js';
import { openReviewForm } from './game-review.js';
import { startReview, stepReview, currentMoment, reviewProgress, KEY_CLASSES } from './review.js';

const RESULT_TXT = { '1-0': 'Victoire des Blancs', '0-1': 'Victoire des Noirs', '1/2-1/2': 'Nulle' };
const MY_RESULT = { win: 'Victoire', loss: 'Défaite', draw: 'Nulle' };

export async function renderGame(root, id, startPly = 0) {
  let g;
  try {
    g = await api(`/api/games/${id}/view`);
  } catch (e) {
    root.innerHTML = `<div class="card">Impossible d'ouvrir cette partie : ${esc(e.message)}. <a href="#/">Retour aux parties</a></div>`;
    return null;
  }

  const S = { ply: Math.max(0, Math.min(g.moves.length, startPly)), free: null, orientation: g.myColor ?? 'white', playing: null, review: null, detailsOpen: false, sumOpen: false };
  const n = () => g.moves.length;

  root.innerHTML = `
    <div class="game-head">
      <a class="back" href="#/">← Parties</a>
      <h1 id="title"></h1>
      <span class="sub" id="sub"></span>
      <span class="spacer"></span>
      <button id="reviewBtn" class="primary" title="Revoir uniquement les moments clés de la partie, un par un">▶ Bilan guidé</button>
    </div>
    <div class="game-layout">
      <div class="board-col">
        <div class="player-line" id="topPlayer"></div>
        <div class="board-row">
          <div class="evalbar" id="evalbar" role="img"><div class="white"></div><div class="mid"></div><div class="txt top"></div><div class="txt bottom"></div></div>
          <div class="board-wrap"><div class="board" id="board"></div></div>
        </div>
        <div class="player-line" id="bottomPlayer"></div>
        <div class="graph-wrap"><div id="graphBox"></div><div class="graph-empty" id="graphEmpty" hidden>Le graphe s'affichera après l'analyse.</div></div>
      </div>
      <div class="sheet-col">
        <div class="sheet" id="moves" aria-label="Feuille de notation"></div>
        <div class="controls">
          <button id="bStart" title="Début (touche Début)" aria-label="Début">⏮</button>
          <button id="bPrev" title="Coup précédent (flèche gauche)" aria-label="Coup précédent">◀</button>
          <button id="bNext" title="Coup suivant (flèche droite)" aria-label="Coup suivant">▶</button>
          <button id="bEnd" title="Fin (touche Fin)" aria-label="Fin">⏭</button>
          <button id="bFlip" title="Retourner l'échiquier (touche F)" aria-label="Retourner l'échiquier">⇅</button>
        </div>
      </div>
      <div class="side-col">
        <div id="reviewBox"></div>
        <div id="freeBox"></div>
        <div class="detail" id="detail" aria-live="polite"></div>
        <div class="summary" id="summary"></div>
        <div class="opening-line" id="openingBox"></div>
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
    // Navigation libre pendant le bilan : on se recale sur le dernier moment clé déjà passé.
    if (S.review && currentMoment(S.review).ply !== ply) {
      const i = S.review.moments.findLastIndex((x) => x.ply <= ply);
      S.review = { ...S.review, index: Math.max(0, i) };
    }
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
      marks: g.moves.filter((m) => KEY_CLASSES.includes(m.classification)).map((m) => ({ ply: m.ply, cls: m.classification })),
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
    renderKeyList();
    renderReview();
    if (g.pass) graph.update(graphData());
    $('#graphBox').hidden = !g.pass;
    $('#graphEmpty').hidden = Boolean(g.pass);
    $('#graphBox').title = g.pass ? `${depthSummary(g)} Cliquez sur le graphe pour aller à un coup.` : '';
    $('#reviewBtn').hidden = !g.pass;
  }

  function renderHeader() {
    const p = (x) => `${esc(x.name)} <span class="elo">${x.elo ?? ''}</span>`;
    $('#title').innerHTML = `${p(g.white)}<span class="vs">contre</span>${p(g.black)}`;
    const mine = g.myColor ? myOutcome() : null;
    const result = mine ? `<span class="outcome ${mine}">${MY_RESULT[mine]}</span>` : esc(RESULT_TXT[g.result] ?? g.result);
    const cadence = [(TIME_CLASS[g.timeClass] ?? g.timeClass ?? '').toLowerCase(), fmtTimeControl(g.timeControl)].filter(Boolean).join(' ');
    $('#sub').innerHTML = `${result}, ${esc(cadence)}, le ${fmtDate(g.playedAt)}${g.url ? `, <a href="${esc(g.url)}" target="_blank" rel="noopener">voir en ligne</a>` : ''}`;
    document.title = `${g.white.name} contre ${g.black.name} : Analyse d'échecs`;
  }
  function myOutcome() {
    if (g.result === '1/2-1/2') return 'draw';
    if (g.result !== '1-0' && g.result !== '0-1') return null;
    return (g.result === '1-0') === (g.myColor === 'white') ? 'win' : 'loss';
  }

  // ------------------------------------------------------------------ bilan guidé
  const OWNER = { vous: 'Vous', adv: 'Adversaire', w: 'Blancs', b: 'Noirs' };
  const whose = (m) => (g.myColor ? ((m.color === 'w') === (g.myColor === 'white') ? 'vous' : 'adv') : m.color);
  function startGuided() {
    stopPlaying();
    S.free = null;
    S.review = startReview(g.moves);
    if (!S.review) { toast('Aucun moment clé dans cette partie : ni gaffe, ni erreur, ni occasion manquée, ni coup brillant.'); return; }
    go(currentMoment(S.review).ply);
  }
  function stepGuided(d) {
    if (!S.review) return;
    if (d > 0 && S.review.index === S.review.moments.length - 1) { endGuided(true); return; }
    S.review = stepReview(S.review, d);
    go(currentMoment(S.review).ply);
  }
  function endGuided(done = false) {
    const total = S.review?.moments.length ?? 0;
    S.review = null;
    render();
    if (done) toast(`Bilan terminé : ${total} moment${total > 1 ? 's' : ''} clé${total > 1 ? 's' : ''} revu${total > 1 ? 's' : ''}.`);
  }
  // Liste des moments clés en bas du panneau : un clic pour y aller.
  function renderKeyList() {
    if (!g.pass || S.free) return;
    const moments = startReview(g.moves)?.moments ?? [];
    $('#detail').insertAdjacentHTML('beforeend', `<div class="key-list"><div class="k">Moments clés de la partie</div>${moments.length
      ? `<div class="chips">${moments.map((x) => { const mv = g.moves[x.ply - 1]; return `<button class="key-chip${x.ply === S.ply ? ' cur' : ''}" data-goto="${x.ply}" title="${esc(LABELS[x.classification])}"><span class="sym c-${x.classification}">${SYMBOLS[x.classification]}</span>${esc(moveNo(x.ply))} ${esc(fig(mv.san))}</button>`; }).join('')}</div>`
      : '<div class="small muted">Aucun : ni gaffe, ni erreur, ni occasion manquée, ni coup brillant.</div>'}</div>`);
  }
  function renderReview() {
    const box = $('#reviewBox');
    $('#reviewBtn').textContent = S.review ? '■ Arrêter le bilan' : '▶ Bilan guidé';
    if (!S.review) { box.innerHTML = ''; return; }
    const m = currentMoment(S.review);
    const mv = g.moves[m.ply - 1];
    const last = S.review.index === S.review.moments.length - 1;
    box.innerHTML = `<div class="review-bar" role="region" aria-label="Bilan guidé">
      <div class="grow"><b>${esc(reviewProgress(S.review))}</b><br>${esc(OWNER[whose(mv)])} : ${esc(LABELS[mv.classification].toLowerCase())}</div>
      <div class="review-dots" aria-hidden="true">${S.review.moments.map((_, i) => `<i class="${i === S.review.index ? 'on' : ''}"></i>`).join('')}</div>
      <button id="rvPrev" ${S.review.index === 0 ? 'disabled' : ''} title="Moment précédent (flèche gauche)">◀</button>
      <button id="rvNext" title="${last ? 'Terminer le bilan' : 'Moment suivant (flèche droite)'}">${last ? 'Terminer' : 'Suivant ▶'}</button>
    </div>`;
  }

  // ------------------------------------------------------------------ événements
  // root est la zone principale, commune à tous les écrans : ces écouteurs sont retirés à la fermeture de la partie
  // (sinon ceux des parties ouvertes avant réagiraient encore aux clics).
  const onToggle = (e) => { if (e.target.matches?.('details.more')) S.detailsOpen = e.target.open; };
  root.addEventListener('toggle', onToggle, true);
  // Méthode de classement choisie dans le résumé : cette partie est reclassée tout de suite, les autres en arrière-plan.
  const onChange = async (e) => {
    if (!e.target.matches?.('#methodSel')) return;
    const method = e.target.value;
    e.target.disabled = true;
    try {
      await api('/api/settings/classification', { method, gameId: id });
      g = await api(`/api/games/${id}/view`);
      S.review = null;
      renderSummary(ctx);
      render();
      toast(`Coups classés avec la méthode « ${g.methodLabels[method]} ». Vos autres parties sont reclassées en arrière-plan.`);
    } catch (err) {
      toast(`Changement de méthode impossible : ${esc(err.message)}`);
      renderSummary(ctx);
    }
  };
  root.addEventListener('change', onChange);
  const onClick = async (e) => {
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
    if (t.closest('#reviewBtn')) { if (S.review) endGuided(); else startGuided(); return; }
    if (t.closest('#rvNext')) { stepGuided(1); return; }
    if (t.closest('#rvPrev')) { stepGuided(-1); return; }
    if (t.closest('#sumToggle')) { S.sumOpen = !S.sumOpen; renderSummary(ctx); return; }
    if (t.closest('#ccReview')) { openReviewForm(ctx, (review) => { g.chesscomReview = review; renderSummary(ctx); }); return; }
    if (t.closest('#prio')) { await api(`/api/games/${id}/prioritize`, {}); g.requested = true; render(); toast("Analyse demandée : la partie passe en tête de la file. Le résultat s'affichera automatiquement."); return; }
    if (t.closest('#reverify')) { await api(`/api/games/${id}/prioritize`, { reverify: true }); g.requested = true; render(); toast('Vérification demandée : seuls les coups douteux seront recalculés.'); return; }
    if (t.closest('#unprio')) { await api(`/api/games/${id}/unrequest`, {}); g.requested = false; render(); toast("Demande d'analyse annulée."); return; }
  };
  root.addEventListener('click', onClick);

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
    const mvEl = e.target.closest('.mv[data-ply]');
    if (mvEl && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); go(Number(mvEl.dataset.ply)); return; }
    if (S.review && !S.free && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); stepGuided(e.key === 'ArrowRight' ? 1 : -1); return; }
    if (S.review && e.key === 'Escape') { endGuided(); return; }
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
  window.__partie = { state: S, go, jumpTo, startGuided, stepGuided, endGuided, play: (orig, dest) => free.onBoardMove(orig, dest), claudeText: () => claudeText(ctx), get data() { return g; } };

  return () => {
    root.removeEventListener('toggle', onToggle, true);
    root.removeEventListener('click', onClick);
    root.removeEventListener('change', onChange);
    window.removeEventListener('keydown', onKey);
    clearInterval(poll);
    stopPlaying();
    graph.destroy();
    board.destroy();
    delete window.__partie;
  };
}
