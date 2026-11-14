// Écran « Progression » : courbes dans le temps, précision par phase, fautes par partie, gestion du temps,
// et bouton « Bilan pour Claude ».
import { api, esc, fig, fmtDate, fmtPct, fmtSpent, moveNo, pctText, copyWithFallback, TIME_CLASS, ciText, isSmall, nText, SMALL_SAMPLE } from './util.js';
import { filterBar, filtersQuery } from './statfilters.js';
import { lineChart, barList, movingAverage } from './charts.js';

const RES = { win: 'victoire', loss: 'défaite', draw: 'nulle' };

export async function renderProgress(root) {
  root.innerHTML = `
    <div class="page-head"><h1>Progression</h1><span class="muted small" id="refreshNote"></span></div>
    <div id="filters"></div>
    <div class="stack">
      <div class="kpis" id="kpis"></div>
      <div class="card">
        <div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
          <div><b>Bilan pour Claude</b> <span class="muted small">— résumé de vos dernières parties, prêt à coller sur claude.ai pour obtenir un plan d'entraînement</span></div>
          <div class="row"><select id="bilanN"><option value="10">10 dernières parties</option><option value="25" selected>25 dernières parties</option><option value="50">50 dernières parties</option><option value="100">100 dernières parties</option><option value="500">Toutes</option></select>
          <button class="primary" id="bilanBtn">📋 Copier le bilan pour Claude</button></div>
        </div>
      </div>
      <div class="card"><h2>Précision par partie</h2><div class="legend"><span><i style="background:var(--series-1)"></i>moyenne des 10 dernières parties</span><span><i style="background:var(--series-1);opacity:.45;height:6px;width:6px;border-radius:50%"></i>une partie (cliquez pour l'ouvrir)</span></div><div id="accChart"></div></div>
      <div class="card"><h2>Elo réel et Elo estimé</h2><div class="legend"><span><i style="background:var(--series-1)"></i>Elo réel (chess.com / Lichess)</span><span><i style="background:var(--series-2)"></i>Elo estimé d'après la précision, indicatif, calibré sur vos parties (moyenne des 10 dernières)</span></div><div id="eloChart"></div><p class="note" id="eloNote"></p></div>
      <div class="cols2">
        <div class="card"><h2>Précision par phase de jeu</h2><div id="phases"></div>
          <p class="note">Ouverture : jusqu'à ce qu'il reste 10 pièces ou moins (rois et pions non comptés), qu'un camp ait moins de 4 pièces sur sa première rangée, ou après le 15e coup. Finale : 6 pièces ou moins. Moyenne de la précision de vos coups, hors coups de théorie.</p></div>
        <div class="card"><h2>Fautes par partie</h2><div id="perGame"></div><p class="note" id="perGameNote"></p></div>
      </div>
      <div class="card"><h2>Évolution des fautes (moyenne par partie, mois par mois)</h2><div class="cols3" id="trends"></div>
        <p class="note">Points creux : mois avec moins de 10 parties analysées (échantillon trop petit pour conclure).</p></div>
      <h2 style="margin:6px 0 0">Gestion du temps</h2>
      <div class="cols2">
        <div class="card"><div class="mini-title">Coups ratés (erreur, gaffe, occasion manquée) selon la pendule</div><div id="lowClock"></div><p class="note" id="lowNote"></p></div>
        <div class="card"><div class="mini-title">Temps moyen par coup selon la phase</div><div id="timePhase"></div></div>
      </div>
      <div class="cols2">
        <div class="card"><div class="mini-title">Coups évidents joués trop lentement <span class="muted small" id="slowCount"></span></div>
          <p class="note">Un seul coup raisonnable (le 2e meilleur perd au moins 20 % de chances de gain, ou coup forcé), trouvé, mais joué en plus de 5 s et plus du double de votre temps moyen.</p>
          <ul class="list-links" id="slowList"></ul></div>
        <div class="card"><div class="mini-title">Parties perdues au temps en position gagnante</div>
          <p class="note">Défaite au temps alors que vous aviez au moins 70 % de chances de gain à la fin.</p>
          <ul class="list-links" id="lostTime"></ul></div>
      </div>
    </div>`;
  const $ = (id) => root.querySelector(`#${id}`);
  let filters = filterBar($('filters'), (f) => { filters = f; load(); });

  async function load() {
    const [d, t] = await Promise.all([api(`/api/stats/dashboard?${filtersQuery(filters)}`), api(`/api/stats/time?${filtersQuery(filters)}`)]);
    $('refreshNote').textContent = d.refresh?.refreshing ? `Mise à jour des statistiques… (${d.refresh.done}/${d.refresh.total})` : `${d.count} parties analysées dans la sélection`;
    const last = [...d.series].reverse().find((g) => g.myElo);
    const small = isSmall(d.count);
    // Tuile principale : Elo de performance de la cadence affichée (l'Elo d'une cadence n'est pas comparable à une autre).
    const mainTc = filters.timeClass || d.performance[0]?.timeClass;
    const P = d.performance.find((x) => x.timeClass === mainTc);
    const others = d.performance.filter((x) => x !== P);
    const E = d.estimated.find((x) => x.timeClass === mainTc);
    const perfTile = `<div class="card kpi kpi-main${P && isSmall(P.n) ? ' thin' : ''}" title="Elo de performance = Elo moyen des adversaires + 400 × (victoires − défaites) / nombre de parties">
      <div class="l">Elo de performance${mainTc ? ` — ${esc(TIME_CLASS[mainTc] ?? mainTc)}` : ''}</div>
      <div class="v">${P ? P.performance : '–'}</div>
      <div class="l">${P ? `fourchette ${P.low}–${P.high} (IC 95 %) · ${esc(nText(P.n))} (analysées ou non) · adversaires ${P.avgOpp} de moyenne, ${P.win} V · ${P.draw} N · ${P.loss} D` : 'aucune partie avec l\'Elo des adversaires'}</div>
      ${others.length ? `<div class="l">Autres cadences : ${others.map((x) => `${esc(TIME_CLASS[x.timeClass] ?? x.timeClass)} <b>${x.performance}</b> (n = ${x.n}${isSmall(x.n) ? ', échantillon trop petit' : ''})`).join(' · ')}</div>` : ''}
    </div>`;
    $('kpis').innerHTML = perfTile + [
      ['Score', pctText(d.score?.p), `victoire = 1, nulle = ½ · ${ciText(d.score)} · ${nText(d.count)} analysées`, small],
      ['Précision moyenne', d.avgAccuracy != null ? `${fmtPct(d.avgAccuracy)} %` : '–', `méthode Lichess · ${nText(d.accuracyGames)}`, isSmall(d.accuracyGames)],
      [`Elo estimé d'après la précision${mainTc ? ` — ${TIME_CLASS[mainTc] ?? mainTc}` : ''}`, E ? E.mean : '–',
        `indicatif${E?.low != null ? ` · fourchette ${E.low}–${E.high}` : ''} · ${nText(E?.n ?? 0)} · ${d.calibration?.enabled ? 'calibré sur vos parties' : 'non calibré'} (une partie seule : ± 500)`, isSmall(E?.n ?? 0)],
      ['Elo réel (dernière partie)', last?.myElo ?? '–', last ? `${TIME_CLASS[last.timeClass] ?? last.timeClass}` : '', false],
    ].map(([l, v, s, thin]) => `<div class="card kpi${thin ? ' thin' : ''}"${thin ? ` title="${SMALL_SAMPLE}"` : ''}><div class="l">${esc(l)}</div><div class="v">${esc(v)}</div><div class="l">${esc(s)}</div></div>`).join('');

    const pts = d.series.map((g) => ({ x: Date.parse(g.playedAt), y: g.accuracy, data: g }));
    const open = (g) => { location.hash = `#/partie/${g.gameId}`; };
    const tip = (g) => `${fmtDate(g.playedAt)} · contre ${esc(g.opponent ?? '?')} (${g.oppElo ?? '?'})<br>${RES[g.outcome] ?? ''} · précision <b>${fmtPct(g.accuracy)} %</b>${g.estElo ? ` · Elo estimé ${g.estElo}` : ''}`;
    lineChart($('accChart'), [
      { label: 'Partie', color: 'var(--series-1)', points: pts, dots: true, line: false },
      { label: 'Moyenne', color: 'var(--series-1)', points: movingAverage(pts, 10, 5), width: 2.5 },
    ], { yMin: 0, yMax: 100, yFormat: (v) => `${Math.round(v)} %`, tip, onClick: open });

    // L'Elo réel n'est comparable qu'au sein d'une même cadence.
    const counts = {};
    for (const g of d.series) counts[g.timeClass] = (counts[g.timeClass] ?? 0) + 1;
    const tc = filters.timeClass || Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
    const sameTc = d.series.filter((g) => g.timeClass === tc);
    const cal = d.calibration;
    const off = cal?.byTimeClass?.[tc]?.offset ?? cal?.global;
    $('eloNote').textContent = tc ? `Cadence affichée : ${TIME_CLASS[tc] ?? tc} (l'Elo d'une cadence n'est pas comparable à celui d'une autre). `
      + (cal?.enabled ? `Calibrage : la table générique est décalée de ${off > 0 ? '+' : ''}${off} points pour coller à votre niveau réel (médiane sur vos parties et celles de vos adversaires). Partie par partie, l'estimation reste imprécise (± 500 points) ; la moyenne sur 10 parties est bien plus fiable.`
        : 'Pas encore assez de parties analysées pour calibrer l\'Elo estimé : c\'est l\'estimation générique.') : '';
    lineChart($('eloChart'), [
      { label: 'Elo réel', color: 'var(--series-1)', points: sameTc.map((g) => ({ x: Date.parse(g.playedAt), y: g.myElo, data: g })) },
      { label: 'Elo estimé', color: 'var(--series-2)', points: movingAverage(sameTc.map((g) => ({ x: Date.parse(g.playedAt), y: g.estElo, data: g })), 10, 5) },
    ], { tip: (g, same) => `${fmtDate(g.playedAt)} · contre ${esc(g.opponent ?? '?')}<br>${same.map(({ s, q }) => `${esc(s.label)} : <b>${Math.round(q.y)}</b>`).join('<br>')}`, onClick: open });

    barList($('phases'), ['opening', 'middlegame', 'endgame'].map((k) => ({
      label: d.phases[k].label, sub: `${d.phases[k].moves} coups · n = ${d.phases[k].games} parties`, value: d.phases[k].accuracy ?? 0,
      thin: isSmall(d.phases[k].games),
      text: d.phases[k].accuracy != null ? `${fmtPct(d.phases[k].accuracy)} %` : '–',
    })), { max: 100 });
    barList($('perGame'), [
      ['Gaffes', d.perGame.blunder, 'var(--blunder)'], ['Erreurs', d.perGame.mistake, 'var(--mistake)'],
      ['Occasions manquées', d.perGame.miss, 'var(--miss)'], ['Imprécisions', d.perGame.inaccuracy, 'var(--inaccuracy)'],
    ].map(([label, v, color]) => ({ label, value: v ?? 0, text: v != null ? v.toFixed(2).replace('.', ',') : '–', color, thin: small })));
    $('perGameNote').textContent = `Moyenne sur ${nText(d.count)}.`;

    // Petits graphiques séparés (un par type de faute) plutôt qu'un graphique à 4 couleurs.
    const trends = $('trends');
    trends.innerHTML = '';
    for (const [key, label, color] of [['blunder', 'Gaffes', 'var(--blunder)'], ['mistake', 'Erreurs', 'var(--mistake)'], ['inaccuracy', 'Imprécisions', 'var(--inaccuracy)']]) {
      const box = document.createElement('div');
      box.innerHTML = `<div class="mini-title">${label} par partie</div><div></div>`;
      trends.appendChild(box);
      lineChart(box.lastElementChild, [{ label, color, points: d.byMonth.map((m) => ({ x: Date.parse(`${m.month}-15`), y: m[key], data: m, thin: isSmall(m.games) })), dots: true, opacity: 1, r: 4 }],
        { yMin: 0, yFormat: (v) => v.toFixed(1).replace('.', ','), tip: (m) => `${esc(m.month)} · n = ${m.games} parties${isSmall(m.games) ? ` (${SMALL_SAMPLE})` : ''}<br>${label} : <b>${m[key].toFixed(2).replace('.', ',')}</b> par partie` });
    }

    // Gestion du temps.
    barList($('lowClock'), [
      { label: 'Moins de 30 s à la pendule', sub: `${t.lowClock.moves} coups · n = ${t.lowClock.games} parties`, value: t.lowClock.errorRate ?? 0, text: pctText(t.lowClock.errorRate, 1), title: ciText(t.lowClock.errorCI, 1), thin: isSmall(t.lowClock.games) },
      { label: 'Plus de 30 s', sub: `${t.otherClock.moves} coups · n = ${t.otherClock.games} parties`, value: t.otherClock.errorRate ?? 0, text: pctText(t.otherClock.errorRate, 1), title: ciText(t.otherClock.errorCI, 1), thin: isSmall(t.otherClock.games) },
    ]);
    const lr = t.lowClock.errorRate, or = t.otherClock.errorRate;
    const cis = `Sous 30 s : ${ciText(t.lowClock.errorCI, 1)} ; au-delà : ${ciText(t.otherClock.errorCI, 1)}.`;
    $('lowNote').textContent = lr == null || or == null ? ''
      : isSmall(t.lowClock.games) ? `Moins de 10 parties avec moins de 30 s à la pendule : ${SMALL_SAMPLE}, pas de conclusion. ${cis}`
        : t.lowVsOther === 'higher' ? `Vous ratez ${(lr / Math.max(or, 1e-9)).toFixed(1).replace('.', ',')} fois plus de coups quand il vous reste moins de 30 s. Différence nette : les intervalles de confiance ne se chevauchent pas. ${cis}`
          : t.lowVsOther === 'lower' ? `Vous ratez même moins de coups sous 30 s (différence nette). ${cis}`
            : `Pas de différence démontrée : les intervalles de confiance se chevauchent. ${cis}`;
    barList($('timePhase'), ['opening', 'middlegame', 'endgame'].map((k) => ({ label: { opening: 'Ouverture', middlegame: 'Milieu de jeu', endgame: 'Finale' }[k], value: t.perPhase[k] ?? 0, text: t.perPhase[k] != null ? fmtSpent(t.perPhase[k]) : '–' })), { color: 'var(--series-1)' });
    $('slowCount').textContent = `(${t.slowSimple.count} sur ${t.simpleMoves} coups évidents${t.slowSimple.rate ? ` · ${pctText(t.slowSimple.rate.p, 1)}, ${ciText(t.slowSimple.rate, 1)}` : ''} · n = ${t.games} parties)`;
    $('slowList').innerHTML = t.slowSimple.examples.map((x) => `<li><a href="#/partie/${x.gameId}/${x.ply}">${moveNo(x.ply)} ${esc(fig(x.san))}</a> en <b>${fmtSpent(x.spentMs)}</b> — contre ${esc(x.opponent ?? '?')}, ${fmtDate(x.playedAt)}</li>`).join('') || '<li class="muted">Aucun pour le moment.</li>';
    $('lostTime').innerHTML = t.lostOnTimeWinning.map((x) => `<li><a href="#/partie/${x.gameId}">Contre ${esc(x.opponent ?? '?')}, ${fmtDate(x.playedAt)}</a> — ${Math.round(x.finalWin)} % de chances de gain à la fin</li>`).join('') || '<li class="muted">Aucune : bravo !</li>';
  }

  $('bilanBtn').onclick = async () => {
    const n = $('bilanN').value;
    const r = await api(`/api/stats/bilan?${filtersQuery(filters, { n })}`);
    await copyWithFallback(r.text, `Bilan de ${r.count} parties copié ! Collez-le (Ctrl+V) sur <a href="https://claude.ai/new" target="_blank" rel="noopener">claude.ai</a>.`);
    window.__bilan = r.text;
  };

  await load();
  const timer = setInterval(() => { if (document.visibilityState === 'visible') load().catch(() => {}); }, 30000);
  return () => clearInterval(timer);
}
