// Écran d'une partie — panneau d'explication du coup affiché (classement, perte, explication en français,
// lignes de Stockfish, profondeur atteinte) et résumé de la profondeur sous le graphe.
import { esc, fig, SYMBOLS, LABELS, fmtPct, fmtClock, fmtSpent, moveNo, lineText } from './util.js';

const DOUBTFUL = new Set(['mistake', 'blunder', 'miss', 'brilliant', 'great']);

export function linesHtml(lines, basePly) {
  if (!lines?.length) return '';
  return `<div class="lines"><div class="small muted">Meilleures lignes de Stockfish avant ce coup (cliquez pour les jouer) :</div>${lines.map((l, i) => `
    <div class="line"><span class="ev">${esc(l.evalText)}</span><a href="#" class="pv" data-line="${i}" data-base="${basePly}">${esc(lineText(l.line.slice(0, 8)))}</a></div>`).join('')}</div>`;
}

export function claudeButton() {
  return '<button id="askClaude" title="Copie une question prête à coller sur claude.ai">Demander à Claude</button>';
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

// Une phrase claire quand le coup n'a pas d'explication détaillée (coups bons ou forcés).
function plainSentence(m, g) {
  const best = m.bestSan ? fig(m.bestSan) : null;
  switch (m.classification) {
    case 'brilliant': return 'Sacrifice correct : vous donnez du matériel et la position tient. Seul un très bon calcul le trouve.';
    case 'great': return 'Le seul bon coup : les autres lâchaient nettement la partie.';
    case 'best': return 'Le meilleur coup selon Stockfish.';
    case 'excellent': return best ? `Presque aussi bon que le meilleur coup (${best}).` : 'Presque aussi bon que le meilleur coup.';
    case 'good': return best ? `Correct, mais ${best} était un peu meilleur.` : 'Correct, mais il y avait un peu mieux.';
    case 'book': return `Coup de théorie${g.opening.name ? ` (${g.opening.name})` : ''}.`;
    default: return best && m.bestUci !== m.uci ? `Stockfish préférait ${best}.` : '';
  }
}

export function moveDetailHtml(ctx, m, basePly, { live = false } = {}) {
  // m : coup de la partie, ou résultat d'analyse en direct (mêmes champs)
  const { g, S } = ctx;
  const cls = m.classification;
  const parts = [];
  const mine = !live && g.myColor && ((m.color === 'w') === (g.myColor === 'white'));
  const time = !live && m.timeSpentMs != null ? `${fmtSpent(m.timeSpentMs)} de réflexion` : '';
  // 1. Le héros : tampon de correction, coup, classement.
  parts.push(`<div class="hero">
    ${cls ? `<div class="stamp s-${cls} press" aria-hidden="true">${SYMBOLS[cls]}</div>` : ''}
    <div class="move">${moveNo(basePly + 1)} ${esc(fig(m.san))}${mine ? ' <span class="meta">(vous)</span>' : ''}</div>
    ${cls ? `<div class="label t-${cls}">${esc(LABELS[cls])}</div>` : '<div class="label muted" style="font-size:18px">Pas encore classé</div>'}
    ${time ? `<div class="meta">${esc(time)}</div>` : '<div></div>'}
  </div>`);
  // 2. L'explication en une phrase claire.
  const sentences = m.explanation?.sentences?.length ? m.explanation.sentences : [plainSentence(m, g)].filter(Boolean);
  parts.push(sentences.map((x) => `<p class="say">${esc(x)}</p>`).join(''));
  if (!live && g.opening.exitPly === basePly + 1) parts.push('<p class="small muted">Premier coup hors de la théorie.</p>');
  // 3. Le meilleur coup et la suite à rejouer.
  if (m.explanation) {
    parts.push(`<div class="best-box"><div><span class="k">Meilleur coup :</span> <b>${esc(fig(m.bestSan))}</b></div>
      ${m.explanation.bestLine?.length ? `<div class="chips">${m.explanation.bestLine.map((x, i) => `${x.color === 'w' || i === 0 ? `<span class="chip num">${x.moveNumber}${x.color === 'w' ? '.' : '...'}</span>` : ''}<button class="chip" data-best="${i}" data-base="${basePly}" title="Voir la position après ce coup">${esc(fig(x.san))}</button>`).join('')}</div>
      <div class="actions"><button id="playBest" data-base="${basePly}">▶ Rejouer la suite</button></div>` : ''}</div>`);
  }
  // 4. Les détails techniques, repliés.
  const facts = [];
  if (m.loss != null && cls !== 'book') facts.push(['Perte', `${fmtPct(m.loss)} % de chances de gain`]);
  if (m.accuracy != null && cls !== 'book') facts.push(['Précision du coup', fmtPct(m.accuracy, 0)]);
  if (m.evalAfterText) facts.push(['Évaluation après', esc(m.evalAfterText)]);
  if (!live && m.clockMs != null) facts.push(['Pendule après', fmtClock(m.clockMs)]);
  if (!live && cls && cls !== 'book') facts.push(['Calcul', esc(depthNote(m))]);
  const lines = linesHtml(m.lines, basePly);
  if (facts.length || lines) {
    parts.push(`<details class="more"${S.detailsOpen ? ' open' : ''}><summary>Détails</summary>
      ${facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>` : ''}${lines}</details>`);
  }
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
      box.innerHTML = `<h3>${moveNo(ply + 1)} ${esc(fig(it.san))} <span class="muted small">(variante de Stockfish)</span></h3>
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
      <p class="say">${g.pass ? 'Lancez le <b>bilan guidé</b> pour revoir les moments clés, ou avancez coup par coup.' : 'Cette partie n\'est pas encore analysée.'}</p>
      <p class="small muted">Flèches ← → du clavier pour avancer, Début et Fin pour sauter. Vous pouvez aussi jouer vos propres coups sur l'échiquier : Stockfish les évalue en direct.</p>`;
  } else {
    box.innerHTML = moveDetailHtml(ctx, g.moves[S.ply - 1], S.ply - 1);
  }
  if (g.pass === 'deep' && g.verifyOutdated && g.status !== 'running') {
    box.insertAdjacentHTML('beforeend', g.requested && !g.held
      ? '<p class="small">Vérification demandée : elle démarre dans un instant.</p>'
      : `<div class="actions"><button id="reverify" title="Les positions déjà calculées sont réutilisées : seuls les coups douteux sont recalculés">Revérifier les coups douteux à la profondeur ${g.verifyTarget}</button></div>`);
  }
  if (g.pass !== 'deep') {
    box.insertAdjacentHTML('beforeend', g.status === 'running'
      ? "<p class=\"small\"><span class=\"spinner\"></span> Analyse de cette partie en cours… le résultat s'affichera tout seul.</p>"
      : g.held
        ? '<div class="actions"><span class="small">Analyse demandée avant la mise en pause : elle attend la reprise.</span><button class="primary" id="prio">Analyser maintenant</button><button id="unprio">Annuler la demande</button></div>'
        : g.requested
          ? '<div class="actions"><span class="small">Analyse demandée : elle démarre dans un instant.</span><button id="unprio">Annuler la demande</button></div>'
          : `<div class="actions"><button class="primary" id="prio">${g.pass ? 'Analyser en profondeur (quelques minutes)' : 'Analyser cette partie'}</button></div>`);
  }
}
