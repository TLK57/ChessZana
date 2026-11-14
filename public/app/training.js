// Écran « Entraînement » : session du jour de 10 puzzles tirés de mes gaffes et occasions manquées,
// répétition espacée, statistiques de réussite par type d'erreur.
import { Chessground } from '/vendor/chessground.js';
import { Chess } from '/vendor/chess.js';
import { api, esc, fig, fmtDate, lineText, pctText, LABELS, toast, ciText, isSmall, SMALL_SAMPLE } from './util.js';

function destsOf(chess) {
  const d = new Map();
  for (const m of chess.moves({ verbose: true })) { if (!d.has(m.from)) d.set(m.from, []); d.get(m.from).push(m.to); }
  return d;
}

export async function renderTraining(root) {
  root.innerHTML = `
    <div class="page-head"><h1>Entraînement</h1><span class="muted small">Vos propres gaffes et occasions manquées, à retrouver.</span></div>
    <div class="train-layout">
      <div>
        <div class="player-line" id="prompt" style="padding-left:2px"></div>
        <div class="board" id="board"></div>
        <div class="dots" id="dots" style="margin-top:10px"></div>
      </div>
      <div class="stack">
        <div class="card" id="panel"></div>
        <div class="card"><h2>Réussite par type d'erreur</h2><div id="stats"></div>
          <p class="note">Répétition espacée : un puzzle raté revient demain ; réussi, il revient dans 3 jours, puis 7, 14 et 30 jours.
          La session du jour mélange les puzzles à réviser et de nouveaux puzzles, en priorité sur les types d'erreurs que vous faites le plus.</p></div>
      </div>
    </div>`;
  const $ = (id) => root.querySelector(`#${id}`);
  const cg = Chessground($('board'), {
    coordinates: true, animation: { enabled: true, duration: 160 }, highlight: { lastMove: true, check: true },
    movable: { free: false, showDests: true, events: { after: (o, d) => onMove(o, d) } }, premovable: { enabled: false },
    draggable: { showGhost: true }, drawable: { enabled: true, visible: true },
  });
  let session = null;
  let index = 0;
  let answered = null; // réponse du puzzle courant

  function current() { return session?.puzzles[index] ?? null; }

  function renderDots() {
    $('dots').innerHTML = session.puzzles.map((p, i) => `<span class="dot${i === index ? ' cur' : ''}${p.result === true ? ' ok' : p.result === false ? ' ko' : ''}" data-i="${i}" title="Puzzle ${i + 1}">${i + 1}</span>`).join('');
  }

  function setBoard(p, { fen = p.fen, movable = true, lastMove, shapes = [] } = {}) {
    const c = new Chess(fen);
    const turn = c.turn() === 'w' ? 'white' : 'black';
    cg.set({
      fen, orientation: p.color, turnColor: turn, lastMove, check: c.inCheck() ? turn : false,
      movable: { color: movable ? turn : undefined, dests: movable ? destsOf(c) : new Map() },
    });
    cg.setAutoShapes(shapes);
  }

  function show() {
    const p = current();
    answered = null;
    if (!p) {
      $('prompt').textContent = '';
      $('panel').innerHTML = `<h2>Pas de puzzle pour aujourd'hui</h2><p>Analysez des parties (bouton « Analyser » dans la liste) : vos gaffes et occasions manquées deviendront des puzzles.</p>`;
      $('dots').innerHTML = '';
      return;
    }
    renderDots();
    setBoard(p);
    const side = p.color === 'white' ? 'les Blancs' : 'les Noirs';
    $('prompt').innerHTML = `<span>Puzzle ${index + 1} / ${session.puzzles.length} · vous jouez ${side}</span><span class="muted small">partie du ${fmtDate(p.playedAt ?? '')}</span>`;
    $('panel').innerHTML = `<h2>Trouvez le bon coup</h2>
      <p>Dans cette partie, vous aviez joué <b>${esc(fig(p.playedSan))}</b> (${esc(LABELS[p.classification] ?? p.classification)}). Il y avait mieux : jouez-le sur l'échiquier.</p>
      <p class="small muted">${p.attempts ? `Déjà vu ${p.attempts} fois, réussi ${p.successes} fois.` : 'Nouveau puzzle.'}${p.result != null ? ' Déjà fait aujourd\'hui : votre réponse ne change plus la date de révision.' : ''}</p>
      <div class="actions"><button id="giveUp">Je ne trouve pas : voir la solution</button></div>`;
  }

  async function onMove(orig, dest) {
    const p = current();
    if (!p || answered) return;
    const c = new Chess(p.fen);
    const piece = c.get(orig);
    let promotion;
    if (piece?.type === 'p' && (dest[1] === '8' || dest[1] === '1')) promotion = 'q';
    let mv;
    try { mv = c.move({ from: orig, to: dest, promotion }); } catch { mv = null; }
    if (!mv) { setBoard(p); return; }
    await submit(mv.from + mv.to + (mv.promotion ?? ''), c.fen(), [orig, dest]);
  }

  async function submit(uci, fenAfter, lastMove) {
    const p = current();
    $('panel').insertAdjacentHTML('beforeend', '<p class="small"><span class="spinner"></span> Vérification…</p>');
    let r;
    try { r = await api('/api/training/answer', { id: p.id, uci }); } catch (e) { toast(esc(e.message)); show(); return; }
    answered = r;
    if (p.result == null) p.result = r.correct;
    renderDots();
    const sol = { orig: r.solutionUci.slice(0, 2), dest: r.solutionUci.slice(2, 4), brush: 'green' };
    setBoard(p, { fen: fenAfter ?? p.fen, movable: false, lastMove, shapes: r.correct ? [] : [sol] });
    const when = r.next?.intervalDays ? `dans ${r.next.intervalDays} jour${r.next.intervalDays > 1 ? 's' : ''} (le ${fmtDate(r.next.dueDate)})` : '';
    $('panel').innerHTML = `
      <div class="feedback ${r.correct ? 'ok' : 'ko'}">
        <b>${r.correct ? '✓ Bravo !' : uci ? '✗ Ce n\'est pas ça.' : 'Solution'}</b>
        ${uci ? ` Vous avez joué ${esc(fig(r.answerSan))}.` : ''} ${r.correct && r.answerSan !== r.solutionSan ? `Le coup de Stockfish était ${esc(fig(r.solutionSan))} (le vôtre est presque aussi bon).` : `Le bon coup était <b>${esc(fig(r.solutionSan))}</b>.`}
      </div>
      ${r.explanation?.length ? `<div class="explain">${r.explanation.map((s) => `<p>${esc(s)}</p>`).join('')}</div>` : ''}
      ${r.line?.length ? `<p class="small muted">Suite de Stockfish : ${esc(lineText(r.line.slice(0, 8)))}</p>` : ''}
      <p class="small">${r.firstTry ? `Ce puzzle reviendra ${esc(when)}.` : 'Déjà répondu aujourd\'hui : la date de révision ne change pas.'}</p>
      <div class="actions">
        ${index < session.puzzles.length - 1 ? '<button class="primary" id="next">Puzzle suivant →</button>' : '<button class="primary" id="restart">Terminer la session</button>'}
        <a href="#/partie/${r.gameId}/${r.ply}">Voir la partie à ce coup</a>
      </div>`;
    loadStats();
  }

  async function loadStats() {
    const s = await api('/api/training/stats');
    $('stats').innerHTML = s.byType.length ? `<p class="small">${s.total} puzzles au total · ${s.due} à faire aujourd'hui.</p>
      <table class="simple"><thead><tr><th>Type d'erreur</th><th class="num">Puzzles</th><th class="num">Essais</th><th class="num">Réussite</th><th class="num">Maîtrisés</th></tr></thead><tbody>
      ${s.byType.map((t) => `<tr><td>${esc(t.label)}</td><td class="num">${t.puzzles}</td><td class="num">${t.attempts ?? 0}</td>
        <td class="num${isSmall(t.attempts) ? ' thin' : ''}" title="${esc(`${ciText(t.rateCI)}${isSmall(t.attempts) ? ` · moins de 10 essais : ${SMALL_SAMPLE}` : ''}`)}">${t.rate != null ? pctText(t.rate) : '–'}</td><td class="num">${t.mastered}</td></tr>`).join('')}
      </tbody></table>` : '<p class="muted small">Aucun puzzle pour le moment.</p>';
  }

  root.addEventListener('click', async (e) => {
    const dot = e.target.closest('.dot[data-i]');
    if (dot) { index = Number(dot.dataset.i); show(); return; }
    if (e.target.closest('#next')) { index = Math.min(session.puzzles.length - 1, index + 1); show(); return; }
    if (e.target.closest('#giveUp')) { await submit('', null, undefined); return; }
    if (e.target.closest('#restart')) {
      const ok = session.puzzles.filter((p) => p.result === true).length;
      $('panel').innerHTML = `<h2>Session terminée</h2><p>${ok} / ${session.puzzles.length} puzzles réussis.</p>
        <div class="actions"><button id="newSession">Faire une nouvelle session</button></div>`;
      return;
    }
    if (e.target.closest('#newSession')) { session = await api('/api/training/session/new', {}); index = 0; show(); }
  });

  session = await api('/api/training/session');
  // Reprendre au premier puzzle pas encore fait aujourd'hui.
  index = Math.max(0, session.puzzles.findIndex((p) => p.result == null));
  show();
  loadStats();
  window.__training = { get session() { return session; }, get index() { return index; }, submit: (uci) => submit(uci, null, undefined) };
  return () => { cg.destroy(); delete window.__training; };
}
