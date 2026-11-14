// Écran « Mes erreurs » : types d'erreurs les plus fréquents (règles d'explication de l'étape 2), avec exemples.
import { api, esc, fig, fmtDate, moveNo, pctText, LABELS, ciText, isSmall, SMALL_SAMPLE } from './util.js';
import { filterBar, filtersQuery } from './statfilters.js';
import { barList } from './charts.js';

const PHASE = { opening: 'ouverture', middlegame: 'milieu de jeu', endgame: 'finale' };

export async function renderErrors(root) {
  root.innerHTML = `
    <div class="page-head"><h1>Mes erreurs récurrentes</h1><span class="muted small" id="count"></span></div>
    <div id="filters"></div>
    <div class="cols2" style="align-items:start">
      <div class="card"><h2>Types d'erreurs les plus fréquents</h2>
        <p class="note">Vos erreurs, gaffes et occasions manquées, classées avec les règles d'explication de l'écran d'analyse (pièce non défendue, fourchette ratée, mat manqué, finale gâchée…). Cliquez sur un type pour voir des exemples.</p>
        <div id="bars"></div></div>
      <div class="card" id="examples"><h2>Exemples</h2><p class="muted small">Cliquez sur un type d'erreur.</p></div>
    </div>`;
  const $ = (id) => root.querySelector(`#${id}`);
  let filters = filterBar($('filters'), (f) => { filters = f; load(); });
  let data = null;

  function showExamples(t) {
    $('examples').innerHTML = `<h2>${esc(t.label)}</h2>
      <p class="muted small">${t.count} fois sur ${data.total} (${pctText(t.share)} de vos erreurs, ${ciText(t.shareCI)}), dont ${t.blunders} gaffe${t.blunders > 1 ? 's' : ''}.</p>
      <ul class="list-links">${t.examples.map((x) => `<li><a href="#/partie/${x.gameId}/${x.ply}"><b>${moveNo(x.ply)} ${esc(fig(x.san))}</b></a>
        <span class="t-${x.classification}">${esc(LABELS[x.classification])}</span> en ${PHASE[x.phase] ?? ''} — meilleur coup ${esc(fig(x.bestSan ?? '?'))},
        contre ${esc(x.opponent ?? '?')} le ${fmtDate(x.playedAt)}</li>`).join('')}</ul>
      <p class="note">Ces positions reviennent aussi dans le mode Entraînement (gaffes et occasions manquées).</p>`;
  }

  async function load() {
    data = await api(`/api/stats/errors?${filtersQuery(filters)}`);
    $('count').textContent = `${data.total} erreurs, gaffes et occasions manquées · n = ${data.games} parties${isSmall(data.games) ? ` · ${SMALL_SAMPLE}` : ''}`;
    if (!data.types.length) { $('bars').innerHTML = '<p class="muted small">Pas encore de parties analysées.</p>'; return; }
    barList($('bars'), data.types.map((t) => ({ label: t.label, value: t.count, text: `${t.count} · ${pctText(t.share)}`, title: ciText(t.shareCI), thin: isSmall(data.games), type: t })), { onClick: (it) => showExamples(it.type) });
    showExamples(data.types[0]);
  }
  await load();
  return null;
}
