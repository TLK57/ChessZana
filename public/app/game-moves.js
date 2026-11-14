// Écran d'une partie — liste des coups, résumé par joueur (précision, compteurs cliquables) et ouverture.
import { esc, fig, symbol, LABELS, ORDER, fmtPct, fmtSpent, moveNo } from './util.js';

export function renderMoves(ctx) {
  const { S, g, $ } = ctx;
  const rows = [];
  for (let i = 0; i < ctx.n(); i += 2) {
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

export function renderSummary(ctx) {
  const { g, $ } = ctx;
  const card = (color) => {
    const p = color === 'white' ? g.white : g.black;
    const c = color === 'white' ? 'w' : 'b';
    return `<div class="card">
      <div class="who"><span class="colordot ${color}"></span>${esc(p.name)}${g.myColor === color ? ' <span class="muted small">(vous)</span>' : ''}</div>
      <div class="big">${fmtPct(p.accuracy)}<span class="small muted"> % précision</span></div>
      <div class="small" title="${g.calibration?.enabled ? `Estimation calibrée sur vos parties (sans calibrage : ${p.estEloGeneric ?? '–'})` : 'Estimation générique'}">Elo estimé : <b>${p.estElo ?? '–'}</b> <span class="muted">(indicatif, ± 500 sur une partie${g.calibration?.enabled ? ', calibré' : ''})</span></div>
      <div class="counters">${ORDER.map((k) => {
        const v = p.counts?.[k] ?? 0;
        return `<button class="counter" data-color="${c}" data-cls="${k}" ${v ? '' : 'disabled'} title="${v ? 'Aller au coup suivant de ce type' : ''}">${symbol(k, false)} ${LABELS[k]} <span class="n">${v}</span></button>`;
      }).join('')}</div>
    </div>`;
  };
  $('#summary').innerHTML = card('white') + card('black');
}

export function renderOpening(ctx) {
  const o = ctx.g.opening;
  const exit = o.exitPly ? `<a href="#" data-goto="${o.exitPly}">${moveNo(o.exitPly)} ${esc(fig(o.exitSan))}</a>` : null;
  ctx.$('#openingBox').innerHTML = `
    <div><b>Ouverture :</b> ${o.name ? `${esc(o.name)} <span class="muted">(${esc(o.eco ?? '')})</span>` : '<span class="muted">non trouvée dans la base</span>'}</div>
    <div class="small">${exit ? `Sortie de la théorie : ${exit}` : o.name ? 'La partie est restée dans la théorie.' : ''}</div>`;
}
