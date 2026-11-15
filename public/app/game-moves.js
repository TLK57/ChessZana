// Écran d'une partie — feuille de notation, résumé compact par joueur (précision, fautes graves, catégories
// dépliables) et ouverture.
import { esc, fig, symbol, LABELS, ORDER, fmtPct, fmtSpent, moveNo } from './util.js';
import { depthSummary } from './game-detail.js';

const TIP_LICHESS = 'Précision calculée exactement comme Lichess (même formule, bonus +1). C\'est elle qui sert dans la liste des parties et la progression.';
const TIP_CHESSCOM = 'Approximation : chess.com ne publie ni sa formule de précision (CAPS2) ni sa courbe de points attendus. '
  + 'Calculée à partir des points attendus perdus selon le niveau des joueurs ; ses réglages s\'ajustent sur vos bilans chess.com saisis (écran Importer).';
const TIP_METHOD = 'Méthode qui classe les coups dans la liste, sur l\'échiquier et dans le bilan guidé : Lichess (règles exactes) ou style chess.com '
  + '(approximation, la méthode de chess.com n\'est pas publique). Changer de méthode reclasse toutes vos parties analysées, sans les recalculer.';

/** Fautes graves : erreurs, occasions manquées et gaffes. */
export const SERIOUS = ['mistake', 'miss', 'blunder'];
export const seriousCount = (counts) => SERIOUS.reduce((s, k) => s + (counts?.[k] ?? 0), 0);

export function renderMoves(ctx) {
  const { S, g, $ } = ctx;
  const rows = [];
  const cell = (m) => {
    if (!m) return '<td></td>';
    const cur = !S.free && S.ply === m.ply;
    const label = `${moveNo(m.ply)} ${m.san}${m.classification ? `, ${LABELS[m.classification]}` : ''}`;
    return `<td><div class="mv${cur ? ' cur' : ''}" data-ply="${m.ply}" role="button" tabindex="0" aria-label="${esc(label)}"${cur ? ' aria-current="step"' : ''}>${m.classification ? symbol(m.classification) : '<span class="sym blank"></span>'}<span class="san">${esc(fig(m.san))}</span><span class="spent" title="Temps passé sur ce coup">${fmtSpent(m.timeSpentMs)}</span></div></td>`;
  };
  for (let i = 0; i < ctx.n(); i += 2) {
    const w = g.moves[i];
    const b = g.moves[i + 1];
    // Si la partie commence par un coup noir (position personnalisée), décaler.
    rows.push(`<tr><td class="no">${Math.ceil(w.ply / 2)}</td>${w.color === 'w' ? cell(w) : '<td></td>'}${w.color === 'b' ? cell(w) : cell(b)}</tr>`);
    if (w.color === 'b') i -= 1;
  }
  const box = $('#moves');
  box.innerHTML = rows.length ? `<table>${rows.join('')}</table>` : '<p class="small muted" style="padding:10px">Aucun coup.</p>';
  // Fait défiler la feuille (et seulement elle) pour garder le coup courant visible.
  const cur = box.querySelector('.mv.cur');
  if (cur) {
    const cr = cur.getBoundingClientRect();
    const br = box.getBoundingClientRect();
    if (cr.top < br.top) box.scrollTop -= br.top - cr.top + 30;
    else if (cr.bottom > br.bottom) box.scrollTop += cr.bottom - br.bottom + 30;
  } else if (!S.free && S.ply === 0) box.scrollTop = 0;
}

export function renderSummary(ctx) {
  const { g, $, S } = ctx;
  if (!g.pass) { $('#summary').innerHTML = '<div class="small muted" style="padding:4px 0">Précision et fautes : après l\'analyse.</div>'; return; }
  // Deux précisions : celle de Lichess (exacte) et celle du style chess.com (approximation).
  const head = `<div class="sum-row sum-head">
      <span class="sum-title">Précision</span>
      <span title="${esc(TIP_LICHESS)}">Lichess</span>
      <span>Style<br>chess.com <i class="info" tabindex="0" title="${esc(TIP_CHESSCOM)}" aria-label="${esc(TIP_CHESSCOM)}">i</i></span>
      <span title="Erreurs, occasions manquées et gaffes, selon la méthode qui classe les coups">Fautes<br>graves</span>
      <button class="ghost sum-toggle" id="sumToggle" aria-expanded="${S.sumOpen}" aria-controls="sumMore">${S.sumOpen ? 'Moins ▴' : 'Détail ▾'}</button>
    </div>`;
  const row = (color) => {
    const p = color === 'white' ? g.white : g.black;
    const n = seriousCount(p.counts);
    return `<div class="sum-row">
      <span class="who"><span class="colordot ${color}"></span>${esc(p.name)}${g.myColor === color ? ' <span class="muted small">(vous)</span>' : ''}</span>
      <span class="acc-big" title="${esc(TIP_LICHESS)}">${fmtPct(p.accuracy)}<small>%</small></span>
      <span class="acc-big" title="${esc(TIP_CHESSCOM)}">${fmtPct(p.accuracyChesscom)}<small>%</small></span>
      <span class="faults${n ? ' has' : ''}" title="Erreurs, occasions manquées et gaffes"><b>${n}</b></span>
      <span></span>
    </div>`;
  };
  // Méthode qui classe les coups (liste, échiquier, bilan guidé) : la même pour toutes les parties.
  const method = `<div class="sum-method">
      <label class="small" for="methodSel">Classer les coups avec</label>
      <select id="methodSel" class="mini">${['lichess', 'chesscom'].map((m) => `<option value="${m}"${g.method === m ? ' selected' : ''}>${esc(g.methodLabels?.[m] ?? m)}</option>`).join('')}</select>
      <i class="info" tabindex="0" title="${esc(TIP_METHOD)}" aria-label="${esc(TIP_METHOD)}">i</i>
    </div>`;
  const more = (color) => {
    const p = color === 'white' ? g.white : g.black;
    const c = color === 'white' ? 'w' : 'b';
    const some = ORDER.filter((k) => p.counts?.[k]);
    const none = ORDER.filter((k) => !p.counts?.[k]);
    return `<div style="margin:4px 0 8px"><div class="small" style="font-weight:600;margin-bottom:4px"><span class="colordot ${color}"></span> ${esc(p.name)}
      <span class="muted" style="font-weight:400" title="${g.calibration?.enabled ? `Estimation calibrée sur vos parties (sans calibrage : ${p.estEloGeneric ?? '–'})` : 'Estimation générique'}, ± 500 sur une seule partie">Elo estimé ${p.estElo ?? '–'}</span></div>
      <div class="counters">${some.map((k) => `<button class="counter" data-color="${c}" data-cls="${k}" title="Aller au coup suivant de ce type">${symbol(k, false)}${LABELS[k]} <span class="n">${p.counts[k]}</span></button>`).join('')}</div>
      ${none.length ? `<div class="zero-line">Aucun : ${none.map((k) => LABELS[k].toLowerCase()).join(', ')}.</div>` : ''}</div>`;
  };
  // Bilan chess.com saisi à la main (pour comparer et ajuster le style chess.com).
  const rv = g.chesscomReview;
  const rvAcc = (side) => (rv?.[side]?.accuracy != null ? `${fmtPct(rv[side].accuracy)} %` : '–');
  const foot = `<div class="sum-foot"><span class="small muted">${rv ? `Bilan chess.com saisi : précision ${rvAcc('white')} et ${rvAcc('black')}` : 'Pas de bilan chess.com saisi.'}</span>
    <button class="ghost mini" id="ccReview" title="Recopier les chiffres du bilan chess.com de cette partie">${rv ? 'Modifier le bilan chess.com' : 'Saisir le bilan chess.com'}</button></div>`;
  $('#summary').innerHTML = head + row('white') + row('black')
    + (S.sumOpen ? `<div class="sum-more" id="sumMore">${more('white')}${more('black')}<p class="small muted" style="margin:0">${esc(depthSummary(g))}</p></div>` : '')
    + method + foot;
}

export function renderOpening(ctx) {
  const o = ctx.g.opening;
  const exit = o.exitPly ? `<a href="#" data-goto="${o.exitPly}">${moveNo(o.exitPly)} ${esc(fig(o.exitSan))}</a>` : null;
  ctx.$('#openingBox').innerHTML = o.name
    ? `Ouverture : <b>${esc(o.name)}</b>${o.eco ? ` (${esc(o.eco)})` : ''}${exit ? `, sortie de la théorie au coup ${exit}` : ', jouée jusqu\'au bout de la théorie'}.`
    : 'Ouverture non trouvée dans la base.';
}
