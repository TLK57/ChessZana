// Écran d'une partie — feuille de notation, résumé compact par joueur (précision, fautes graves, catégories
// dépliables) et ouverture.
import { esc, fig, symbol, LABELS, ORDER, fmtPct, fmtSpent, moveNo } from './util.js';
import { depthSummary } from './game-detail.js';

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
  const row = (color, first) => {
    const p = color === 'white' ? g.white : g.black;
    const n = seriousCount(p.counts);
    return `<div class="sum-row">
      <span class="who"><span class="colordot ${color}"></span>${esc(p.name)}${g.myColor === color ? ' <span class="muted small">(vous)</span>' : ''}</span>
      <span class="acc-big" title="Précision (méthode Lichess). Non comparable à celle de chess.com (formule CAPS2, secrète).">${fmtPct(p.accuracy)}<small>%</small></span>
      <span class="faults${n ? ' has' : ''}" title="Erreurs, occasions manquées et gaffes"><b>${n}</b>faute${n > 1 ? 's' : ''} grave${n > 1 ? 's' : ''}</span>
      ${first ? `<button class="ghost sum-toggle" id="sumToggle" aria-expanded="${S.sumOpen}" aria-controls="sumMore">${S.sumOpen ? 'Moins ▴' : 'Détail ▾'}</button>` : '<span></span>'}
    </div>`;
  };
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
  $('#summary').innerHTML = row('white', true) + row('black', false)
    + (S.sumOpen ? `<div class="sum-more" id="sumMore">${more('white')}${more('black')}<p class="small muted" style="margin:0">${esc(depthSummary(g))}</p></div>` : '');
}

export function renderOpening(ctx) {
  const o = ctx.g.opening;
  const exit = o.exitPly ? `<a href="#" data-goto="${o.exitPly}">${moveNo(o.exitPly)} ${esc(fig(o.exitSan))}</a>` : null;
  ctx.$('#openingBox').innerHTML = o.name
    ? `Ouverture : <b>${esc(o.name)}</b>${o.eco ? ` (${esc(o.eco)})` : ''}${exit ? `, sortie de la théorie au coup ${exit}` : ', jouée jusqu\'au bout de la théorie'}.`
    : 'Ouverture non trouvée dans la base.';
}
