// Écran « Progression » : quatre chiffres clés, précision dans le temps, fautes les plus fréquentes, précision par
// phase, Elo réel et estimé, gestion du temps, et bouton « Bilan pour Claude ».
// Les mentions techniques (n, intervalles de confiance, méthode) sont dans les infobulles ⓘ.
import { api, esc, fig, fmtDate, fmtPct, fmtSpent, moveNo, pctText, copyWithFallback, TIME_CLASS, ciText, isSmall, nText, SMALL_SAMPLE } from './util.js';
import { filterBar, filtersQuery } from './statfilters.js';
import { lineChart, barList, movingAverage } from './charts.js';

const RES = { win: 'victoire', loss: 'défaite', draw: 'nulle' };
const info = (text) => `<i class="info" title="${esc(text)}" aria-label="${esc(text)}" tabindex="0">i</i>`;
const dec = (v, d = 1) => (v == null ? '–' : v.toFixed(d).replace('.', ','));

export async function renderProgress(root) {
  root.innerHTML = `
    <div class="page-head"><h1>Progression</h1><span class="lead" id="refreshNote"></span><span class="spacer"></span>
      <span class="row" style="align-items:center"><select id="bilanN" aria-label="Parties à résumer"><option value="10">10 dernières parties</option><option value="25" selected>25 dernières parties</option><option value="50">50 dernières parties</option><option value="100">100 dernières parties</option><option value="500">Toutes</option></select>
      <button id="bilanBtn" title="Copie un résumé de vos parties, prêt à coller sur claude.ai pour obtenir un plan d'entraînement">Bilan pour Claude</button></span></div>
    <div id="filters"></div>
    <div class="stack">
      <div class="kpis" id="kpis"></div>
      <div class="cols-wide">
        <div class="card"><h2>Précision par partie</h2><div class="legend"><span><i style="background:var(--series-1)"></i>moyenne des 10 dernières</span><span><i style="background:var(--series-1);opacity:.45;height:6px;width:6px;border-radius:50%"></i>une partie (cliquez pour l'ouvrir)</span></div><div id="accChart"></div></div>
        <div class="card"><h2>Vos fautes les plus fréquentes</h2><div id="topErrors"></div><p class="note"><a href="#/erreurs">Voir toutes vos erreurs et des exemples</a></p></div>
      </div>
      <div class="cols2">
        <div class="card"><h2>Fautes par partie ${info('Moyenne par partie analysée, sur la sélection.')}</h2><div id="perGame"></div><p class="note" id="perGameNote"></p></div>
        <div class="card"><h2>Précision par phase ${info("Ouverture : jusqu'à ce qu'il reste 10 pièces ou moins (rois et pions non comptés), qu'un camp ait moins de 4 pièces sur sa première rangée, ou après le 15e coup. Finale : 6 pièces ou moins. Moyenne de la précision de vos coups, hors coups de théorie.")}</h2><div id="phases"></div></div>
      </div>
      <div class="card"><h2>Elo réel et Elo estimé</h2><div class="legend"><span><i style="background:var(--series-1)"></i>Elo réel</span><span><i style="background:var(--series-2)"></i>Elo estimé d'après votre précision (moyenne des 10 dernières)</span></div><div id="eloChart"></div><p class="note" id="eloNote"></p></div>
      <div class="card"><h2>Vos fautes mois par mois ${info('Moyenne par partie. Points creux : mois avec moins de 10 parties analysées, trop peu pour conclure.')}</h2><div class="cols3" id="trends"></div></div>
      <h2 class="section-title">Gestion du temps</h2>
      <div class="cols2">
        <div class="card"><div class="mini-title">Coups ratés selon la pendule ${info('Part de vos coups qui sont des erreurs, gaffes ou occasions manquées.')}</div><div id="lowClock"></div><p class="note" id="lowNote"></p></div>
        <div class="card"><div class="mini-title">Temps moyen par coup selon la phase</div><div id="timePhase"></div></div>
      </div>
      <div class="cols2">
        <div class="card"><div class="mini-title">Coups évidents joués trop lentement ${info('Un seul coup raisonnable (le 2e meilleur perd au moins 20 % de chances de gain, ou coup forcé), trouvé, mais joué en plus de 5 s et plus du double de votre temps moyen.')} <span class="muted small" id="slowCount"></span></div>
          <ul class="list-links" id="slowList"></ul></div>
        <div class="card"><div class="mini-title">Défaites au temps en position gagnante ${info('Défaite au temps alors que vous aviez au moins 70 % de chances de gain à la fin.')}</div>
          <ul class="list-links" id="lostTime"></ul></div>
      </div>
    </div>`;
  const $ = (id) => root.querySelector(`#${id}`);
  let filters = filterBar($('filters'), (f) => { filters = f; load(); });

  async function load() {
    const [d, t, errs] = await Promise.all([api(`/api/stats/dashboard?${filtersQuery(filters)}`), api(`/api/stats/time?${filtersQuery(filters)}`),
      api(`/api/stats/errors?${filtersQuery(filters)}`).catch(() => null)]);
    $('refreshNote').textContent = d.refresh?.refreshing ? `Mise à jour des statistiques (${d.refresh.done} sur ${d.refresh.total})…` : `${d.count} partie${d.count > 1 ? 's' : ''} analysée${d.count > 1 ? 's' : ''}`;
    const small = isSmall(d.count);
    const mainTc = filters.timeClass || d.performance[0]?.timeClass;
    const P = d.performance.find((x) => x.timeClass === mainTc);
    const others = d.performance.filter((x) => x !== P);
    const E = d.estimated.find((x) => x.timeClass === mainTc);
    const pg = d.perGame ?? {};
    const serious = ['blunder', 'mistake', 'miss'].every((k) => pg[k] == null) ? null : (pg.blunder ?? 0) + (pg.mistake ?? 0) + (pg.miss ?? 0);
    const tc = mainTc ? (TIME_CLASS[mainTc] ?? mainTc).toLowerCase() : '';
    const tile = (label, value, sub, tip, { lead = false, thin = false } = {}) => `<div class="kpi${lead ? ' lead-kpi' : ''}${thin ? ' thin' : ''}">
      <div class="l">${esc(label)} ${tip ? info(tip) : ''}</div><div class="v">${value}</div><div class="s">${sub}</div></div>`;
    $('kpis').innerHTML = [
      tile(`Niveau de jeu${tc ? ` en ${tc}` : ''}`, P ? P.performance : '–',
        P ? `contre des adversaires à ${P.avgOpp} en moyenne` : 'Pas encore assez de parties',
        P ? `Elo de performance = Elo moyen des adversaires + 400 × (victoires − défaites) / parties. Fourchette ${P.low}–${P.high} (IC 95 %), ${nText(P.n)} analysées ou non, ${P.win} victoires, ${P.draw} nulles, ${P.loss} défaites.${others.length ? ` Autres cadences : ${others.map((x) => `${TIME_CLASS[x.timeClass] ?? x.timeClass} ${x.performance} (n = ${x.n})`).join(', ')}.` : ''}` : '',
        { lead: true, thin: P && isSmall(P.n) }),
      tile('Précision moyenne', d.avgAccuracy != null ? `${fmtPct(d.avgAccuracy)}<small> %</small>` : '–',
        E ? `Elo estimé d'après elle : ${E.mean}` : `sur ${d.accuracyGames ?? 0} parties`,
        `Méthode Lichess, sur ${nText(d.accuracyGames)}. Non comparable à la précision de chess.com.${E ? ` Elo estimé : indicatif, fourchette ${E.low}–${E.high}, ${d.calibration?.enabled ? 'calibré sur vos parties' : 'non calibré'} (une partie seule : ± 500).` : ''}`,
        { thin: isSmall(d.accuracyGames) }),
      tile('Fautes graves par partie', serious != null ? dec(serious) : '–', 'erreurs, occasions manquées et gaffes',
        serious != null ? `Gaffes ${dec(pg.blunder, 2)}, erreurs ${dec(pg.mistake, 2)}, occasions manquées ${dec(pg.miss, 2)} par partie, sur ${nText(d.count)}.` : '', { thin: small }),
      tile('Score', pctText(d.score?.p), 'des points marqués',
        `Victoire = 1 point, nulle = ½. ${ciText(d.score)}, sur ${nText(d.count)} analysées.`, { thin: small }),
    ].join('');

    const pts = d.series.map((g) => ({ x: Date.parse(g.playedAt), y: g.accuracy, data: g }));
    const open = (g) => { location.hash = `#/partie/${g.gameId}`; };
    const tip = (g) => `${fmtDate(g.playedAt)}, contre ${esc(g.opponent ?? '?')} (${g.oppElo ?? '?'})<br>${RES[g.outcome] ?? ''}, précision <b>${fmtPct(g.accuracy)} %</b>`;
    const EMPTY = 'Analysez une partie pour voir votre précision ici.';
    lineChart($('accChart'), [
      { label: 'Partie', color: 'var(--series-1)', points: pts, dots: true, line: false },
      { label: 'Moyenne', color: 'var(--series-1)', points: movingAverage(pts, 10, 5), width: 2.5 },
    ], { yMin: 0, yMax: 100, yFormat: (v) => `${Math.round(v)} %`, tip, onClick: open, empty: EMPTY });

    // Fautes les plus fréquentes (types d'erreurs de l'écran « Erreurs »).
    $('topErrors').innerHTML = errs?.types?.length
      ? `<ol class="rank">${errs.types.slice(0, 5).map((x) => `<li><a href="#/erreurs">${esc(x.label)}</a><span class="muted small">${x.count} fois</span></li>`).join('')}</ol>`
      : '<div class="empty">Analysez quelques parties : vos fautes les plus fréquentes apparaîtront ici.</div>';

    // L'Elo réel n'est comparable qu'au sein d'une même cadence.
    const counts = {};
    for (const g of d.series) counts[g.timeClass] = (counts[g.timeClass] ?? 0) + 1;
    const etc = filters.timeClass || Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
    const sameTc = d.series.filter((g) => g.timeClass === etc);
    const cal = d.calibration;
    const off = cal?.byTimeClass?.[etc]?.offset ?? cal?.global;
    $('eloNote').textContent = etc ? `Cadence affichée : ${(TIME_CLASS[etc] ?? etc).toLowerCase()}. `
      + (cal?.enabled ? `L'Elo estimé est calibré sur vos parties (décalage de ${off > 0 ? '+' : ''}${off} points). Sur une seule partie, il reste très imprécis ; la moyenne sur 10 parties est bien plus fiable.`
        : 'Pas encore assez de parties analysées pour calibrer l\'Elo estimé.') : '';
    lineChart($('eloChart'), [
      { label: 'Elo réel', color: 'var(--series-1)', points: sameTc.map((g) => ({ x: Date.parse(g.playedAt), y: g.myElo, data: g })) },
      { label: 'Elo estimé', color: 'var(--series-2)', points: movingAverage(sameTc.map((g) => ({ x: Date.parse(g.playedAt), y: g.estElo, data: g })), 10, 5) },
    ], { tip: (g, same) => `${fmtDate(g.playedAt)}, contre ${esc(g.opponent ?? '?')}<br>${same.map(({ s, q }) => `${esc(s.label)} : <b>${Math.round(q.y)}</b>`).join('<br>')}`, onClick: open,
      empty: 'Analysez des parties pour comparer votre Elo réel à celui que suggère votre précision.' });

    barList($('phases'), ['opening', 'middlegame', 'endgame'].map((k) => ({
      label: d.phases[k].label, sub: `${d.phases[k].moves} coups`, value: d.phases[k].accuracy ?? 0,
      thin: isSmall(d.phases[k].games), title: nText(d.phases[k].games),
      text: d.phases[k].accuracy != null ? `${fmtPct(d.phases[k].accuracy)} %` : '–',
    })), { max: 100 });
    barList($('perGame'), [
      ['Gaffes', pg.blunder, 'var(--blunder)'], ['Erreurs', pg.mistake, 'var(--mistake)'],
      ['Occasions manquées', pg.miss, 'var(--miss)'], ['Imprécisions', pg.inaccuracy, 'var(--inaccuracy)'],
    ].map(([label, v, color]) => ({ label, value: v ?? 0, text: dec(v, 2), color, thin: small })));
    $('perGameNote').textContent = small ? `Sur ${d.count} partie${d.count > 1 ? 's' : ''} seulement : ${SMALL_SAMPLE}.` : '';

    // Petits graphiques séparés (un par type de faute) plutôt qu'un graphique à 4 couleurs.
    const trends = $('trends');
    trends.innerHTML = '';
    for (const [key, label, color] of [['blunder', 'Gaffes', 'var(--blunder)'], ['mistake', 'Erreurs', 'var(--mistake)'], ['inaccuracy', 'Imprécisions', 'var(--inaccuracy)']]) {
      const box = document.createElement('div');
      box.innerHTML = `<div class="mini-title">${label} par partie</div><div></div>`;
      trends.appendChild(box);
      lineChart(box.lastElementChild, [{ label, color, points: d.byMonth.map((m) => ({ x: Date.parse(`${m.month}-15`), y: m[key], data: m, thin: isSmall(m.games) })), dots: true, opacity: 1, r: 4 }],
        { yMin: 0, height: 160, yFormat: (v) => dec(v), empty: 'Il faut des parties analysées sur plusieurs mois.',
          tip: (m) => `${esc(m.month)}, ${m.games} partie${m.games > 1 ? 's' : ''}${isSmall(m.games) ? ` (${SMALL_SAMPLE})` : ''}<br>${label} : <b>${dec(m[key], 2)}</b> par partie` });
    }

    // Gestion du temps.
    barList($('lowClock'), [
      { label: 'Moins de 30 s à la pendule', sub: `${t.lowClock.moves} coups`, value: t.lowClock.errorRate ?? 0, text: pctText(t.lowClock.errorRate, 1), title: `${ciText(t.lowClock.errorCI, 1)}, ${nText(t.lowClock.games)}`, thin: isSmall(t.lowClock.games) },
      { label: 'Plus de 30 s', sub: `${t.otherClock.moves} coups`, value: t.otherClock.errorRate ?? 0, text: pctText(t.otherClock.errorRate, 1), title: `${ciText(t.otherClock.errorCI, 1)}, ${nText(t.otherClock.games)}`, thin: isSmall(t.otherClock.games) },
    ]);
    const lr = t.lowClock.errorRate, or = t.otherClock.errorRate;
    $('lowNote').textContent = lr == null || or == null ? ''
      : isSmall(t.lowClock.games) ? `Moins de 10 parties avec moins de 30 s à la pendule : trop peu pour conclure.`
        : t.lowVsOther === 'higher' ? `Vous ratez ${(lr / Math.max(or, 1e-9)).toFixed(1).replace('.', ',')} fois plus de coups quand il vous reste moins de 30 s.`
          : t.lowVsOther === 'lower' ? 'Vous ratez même moins de coups quand il vous reste moins de 30 s.'
            : 'Pas de différence nette entre les deux.';
    $('lowNote').title = `Sous 30 s : ${ciText(t.lowClock.errorCI, 1)} ; au-delà : ${ciText(t.otherClock.errorCI, 1)}. Une différence est dite nette quand les intervalles ne se chevauchent pas.`;
    barList($('timePhase'), ['opening', 'middlegame', 'endgame'].map((k) => ({ label: { opening: 'Ouverture', middlegame: 'Milieu de jeu', endgame: 'Finale' }[k], value: t.perPhase[k] ?? 0, text: t.perPhase[k] != null ? fmtSpent(t.perPhase[k]) : '–' })), { color: 'var(--series-1)' });
    $('slowCount').textContent = `${t.slowSimple.count} sur ${t.simpleMoves}`;
    $('slowCount').title = `${t.slowSimple.rate ? `${pctText(t.slowSimple.rate.p, 1)}, ${ciText(t.slowSimple.rate, 1)}, ` : ''}${nText(t.games)}`;
    $('slowList').innerHTML = t.slowSimple.examples.map((x) => `<li><a href="#/partie/${x.gameId}/${x.ply}">${moveNo(x.ply)} ${esc(fig(x.san))}</a> en <b>${fmtSpent(x.spentMs)}</b>, contre ${esc(x.opponent ?? '?')} le ${fmtDate(x.playedAt)}</li>`).join('') || '<li class="muted">Aucun pour le moment.</li>';
    $('lostTime').innerHTML = t.lostOnTimeWinning.map((x) => `<li><a href="#/partie/${x.gameId}">Contre ${esc(x.opponent ?? '?')}, le ${fmtDate(x.playedAt)}</a> : ${Math.round(x.finalWin)} % de chances de gain à la fin</li>`).join('') || '<li class="muted">Aucune, bravo.</li>';
  }

  $('bilanBtn').onclick = async () => {
    const n = $('bilanN').value;
    const r = await api(`/api/stats/bilan?${filtersQuery(filters, { n })}`);
    await copyWithFallback(r.text, `Bilan de ${r.count} parties copié. Collez-le (Ctrl+V) sur <a href="https://claude.ai/new" target="_blank" rel="noopener">claude.ai</a>.`);
    window.__bilan = r.text;
  };

  await load();
  const timer = setInterval(() => { if (document.visibilityState === 'visible') load().catch(() => {}); }, 30000);
  return () => clearInterval(timer);
}
