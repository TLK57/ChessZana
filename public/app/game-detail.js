// Écran d'une partie — panneau d'explication du coup affiché (classement, perte, explication en français,
// lignes de Stockfish, profondeur atteinte) et résumé de la profondeur sous le graphe.
import { esc, fig, symbol, LABELS, fmtPct, fmtClock, fmtSpent, moveNo, lineText } from './util.js';

const DOUBTFUL = new Set(['mistake', 'blunder', 'miss', 'brilliant', 'great']);

export function linesHtml(lines, basePly) {
  if (!lines?.length) return '';
  return `<div class="lines"><div class="small muted">Meilleures lignes de Stockfish avant ce coup :</div>${lines.map((l, i) => `
    <div class="line"><span class="ev">${esc(l.evalText)}</span><a href="#" class="pv" data-line="${i}" data-base="${basePly}">${esc(lineText(l.line.slice(0, 8)))}</a></div>`).join('')}</div>`;
}

export function claudeButton() {
  return '<button id="askClaude" title="Copie une question prête à coller sur claude.ai">🤖 Demander à Claude</button>';
}

export function depthNote(m) {
  if (m.source === 'tablebase') return 'Évaluation exacte (table de finales Lichess).';
  const src = m.source === 'lichess-cloud' ? 'analyse cloud de Lichess' : 'Stockfish';
  if (m.verified) return `✓ Vérifié par ${src} à la profondeur ${m.depth}.`;
  return `Profondeur atteinte par ${src} pour ce coup : ${m.depth ?? '?'}.`;
}

// Profondeur réellement atteinte par Stockfish dans cette analyse.
export function depthSummary(g) {
  if (g.pass === 'quick') return `Analyse rapide (profondeur ${g.depth ?? '?'}).`;
  const span = g.depthMin != null && g.depthMax != null && g.depthMin !== g.depthMax ? `de ${g.depthMin} à ${g.depthMax}, médiane ${g.depth}` : `${g.depth ?? '?'}`;
  // Coups douteux (erreur, gaffe, occasion manquée, très bon, brillant) hors tables de finales.
  const doubtful = g.moves.filter((m) => DOUBTFUL.has(m.classification) && m.source !== 'tablebase');
  const deepEnough = doubtful.filter((m) => m.verified || (m.depth ?? 0) >= g.verifyDepth).length;
  const verify = g.verifyOutdated ? ' Revérification à profondeur fixe incomplète (analyse faite avec des critères plus anciens).'
    : !doubtful.length ? ' Aucun coup douteux dans cette partie.'
      : ` ${deepEnough} coup(s) douteux sur ${doubtful.length} calculé(s) à la profondeur ${g.verifyDepth} ou plus${g.verified ? ` (${g.verified} revérifié(s) exprès)` : ''}.`;
  return `Analyse profonde : profondeur atteinte ${span}.${verify}`;
}

export function moveDetailHtml(ctx, m, basePly, { live = false } = {}) {
  // m : coup de la partie, ou résultat d'analyse en direct (mêmes champs)
  const { g } = ctx;
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
  if (!live && cls && cls !== 'book') parts.push(`<p class="small muted">${esc(depthNote(m))}</p>`);
  if (cls) parts.push(`<div class="actions">${claudeButton()}</div>`);
  return parts.join('');
}

export function renderDetail(ctx, nd) {
  const { S, g, $ } = ctx;
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
    box.innerHTML = moveDetailHtml(ctx, { ...it.result, san: it.san, uci: it.uci }, ply, { live: true })
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
    box.innerHTML = moveDetailHtml(ctx, g.moves[S.ply - 1], S.ply - 1);
  }
  if (g.pass === 'deep' && g.verifyOutdated && g.status !== 'running') {
    box.insertAdjacentHTML('beforeend', g.requested
      ? '<p class="small">Vérification demandée : elle démarrera dès que le moteur sera libre.</p>'
      : `<div class="actions"><button id="reverify" title="Les positions déjà calculées sont réutilisées : seuls les coups douteux sont recalculés">Revérifier les coups douteux à la profondeur ${g.verifyTarget}</button></div>`);
  }
  if (g.pass !== 'deep') {
    box.insertAdjacentHTML('beforeend', g.status === 'running'
      ? "<p class=\"small\"><span class=\"spinner\"></span> Analyse de cette partie en cours… le résultat s'affichera tout seul.</p>"
      : g.requested
        ? '<div class="actions"><span class="small">Analyse demandée : elle démarrera dès que le moteur sera libre.</span><button id="unprio">Annuler la demande</button></div>'
        : `<div class="actions"><button class="primary" id="prio">${g.pass ? 'Analyser en profondeur (quelques minutes)' : 'Analyser cette partie'}</button></div>`);
  }
}
