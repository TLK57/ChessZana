// Écran « Mes erreurs » : types d'erreurs les plus fréquents (règles d'explication de l'étape 2), avec exemples.
import { api, esc, fig, fmtDate, moveNo, pctText, LABELS, ciText, isSmall, SMALL_SAMPLE } from './util.js';
import { filterBar, filtersQuery } from './statfilters.js';
import { barList } from './charts.js';

const PHASE = { opening: 'ouverture', middlegame: 'milieu de jeu', endgame: 'finale' };

export async function renderErrors(root) {
  root.innerHTML = `
    <div class="page-head"><h1>Mes erreurs récurrentes</h1><span class="lead" id="count"></span></div>
    <div id="filters"></div>
    <div class="cols2" style="align-items:start">
      <div class="card"><h2>Ce qui vous coûte le plus</h2>
        <p class="note" style="margin:-4px 0 10px">Vos erreurs, gaffes et occasions manquées, par type. Cliquez sur un type pour voir des exemples.</p>
        <div id="bars"></div></div>
      <div class="card" id="examples"><h2>Exemples</h2><div class="empty">Cliquez sur un type d'erreur pour voir vos positions.</div></div>
    </div>`;
  const $ = (id) => root.querySelector(`#${id}`);
  let filters = filterBar($('filters'), (f) => { filters = f; load(); });
  let data = null;
  let showAll = false;
  const SHOWN = 8;

  function showExamples(t) {
    $('examples').innerHTML = `<h2>${esc(t.label)}</h2>
      <p class="muted small" title="${esc(ciText(t.shareCI))}">${t.count} fois sur ${data.total} (${pctText(t.share)} de vos fautes), dont ${t.blunders} gaffe${t.blunders > 1 ? 's' : ''}.</p>
      <ul class="list-links">${t.examples.map((x) => `<li><a href="#/partie/${x.gameId}/${x.ply}"><b>${moveNo(x.ply)} ${esc(fig(x.san))}</b></a>
        <span class="t-${x.classification}">${esc(LABELS[x.classification].toLowerCase())}</span> en ${PHASE[x.phase] ?? ''}, il fallait ${esc(fig(x.bestSan ?? '?'))}.
        <span class="muted">Contre ${esc(x.opponent ?? '?')}, le ${fmtDate(x.playedAt)}</span></li>`).join('')}</ul>
      <p class="note">Ces positions reviennent aussi dans le mode Entraînement (gaffes et occasions manquées).</p>`;
  }

  async function load() {
    data = await api(`/api/stats/errors?${filtersQuery(filters)}`);
    $('count').textContent = `${data.total} fautes graves dans ${data.games} partie${data.games > 1 ? 's' : ''}${isSmall(data.games) ? `, ${SMALL_SAMPLE}` : ''}`;
    if (!data.types.length) { $('bars').innerHTML = '<div class="empty">Analysez une partie pour voir vos erreurs les plus fréquentes.</div>'; return; }
    const types = showAll ? data.types : data.types.slice(0, SHOWN);
    barList($('bars'), types.map((t) => ({ label: t.label, value: t.count, text: `${t.count} (${pctText(t.share)})`, title: ciText(t.shareCI), thin: isSmall(data.games), type: t })), { onClick: (it) => showExamples(it.type), color: 'var(--mistake)' });
    if (data.types.length > SHOWN) {
      $('bars').insertAdjacentHTML('beforeend', `<div class="actions"><button class="ghost" id="moreTypes">${showAll ? 'Afficher moins' : `Afficher les ${data.types.length - SHOWN} autres types`}</button></div>`);
      $('moreTypes').onclick = () => { showAll = !showAll; load(); };
    }
    showExamples(data.types[0]);
  }
  await load();
  return null;
}
