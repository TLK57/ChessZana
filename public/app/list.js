// Écran « Mes parties » : liste filtrable.
import { api, esc, fmtDate, fmtPct, store, TIME_CLASS } from './util.js';

const PERIODS = { all: 'Tout', '7': '7 derniers jours', '30': '30 derniers jours', '90': '3 derniers mois', '365': '12 derniers mois', custom: 'Personnalisée' };
const STATUS = { pending: 'Non analysée', quick: 'Rapide', deep: 'Profonde', running: 'En cours…', error: 'Erreur', requested: 'En file' };

function statusCell(g) {
  if (g.analysis === 'running') return '<span class="status running">En cours…</span>';
  if (g.analysis === 'error') return '<span class="status error">Erreur</span>';
  const depthTitle = g.analysis === 'deep'
    ? `Profondeur atteinte : ${g.depthMin != null && g.depthMax != null && g.depthMin !== g.depthMax ? `${g.depthMin} à ${g.depthMax} (médiane ${g.depth})` : g.depth ?? '?'}${g.verifyDepth ? ` — ${g.verifiedMoves ?? 0} coup(s) douteux revérifié(s) à ${g.verifyDepth}` : ''}`
    : g.analysis === 'quick' ? `Profondeur ${g.depth ?? '?'}` : '';
  const badge = g.analysis === 'pending' ? '' : `<span class="status ${g.analysis}"${depthTitle ? ` title="${esc(depthTitle)}"` : ''}>${STATUS[g.analysis]}</span> `;
  if (g.analysis === 'deep') return badge;
  if (g.requested) return `${badge}<span class="status requested" title="Analyse demandée">En file</span>`;
  const label = g.analysis === 'quick' ? 'Approfondir' : 'Analyser';
  const title = g.analysis === 'quick' ? "Lancer l'analyse profonde de cette partie (quelques minutes)" : 'Analyser cette partie (passe rapide puis profonde)';
  return `${badge}<button class="mini" data-analyse="${g.id}" title="${title}">${label}</button>`;
}
const RESULT = { win: 'V', loss: 'D', draw: 'N' };
const RESULT_TITLE = { win: 'Victoire', loss: 'Défaite', draw: 'Nulle' };

function isoDaysAgo(n) {
  const d = new Date(Date.now() - n * 864e5);
  return d.toISOString().slice(0, 10);
}

export async function renderList(root) {
  const saved = store('filters') ?? {};
  const f = { timeClass: '', color: '', result: '', period: 'all', from: '', to: '', opening: '', ...saved };
  let limit = 50;
  let timer = null;

  root.innerHTML = `
    <div class="page-head"><h1>Mes parties</h1><span class="lead" id="count"></span></div>
      <div class="filters">
        <label>Cadence<select id="fTc"><option value="">Toutes</option>${Object.entries(TIME_CLASS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        <label>Couleur<select id="fColor"><option value="">Les deux</option><option value="white">Blancs</option><option value="black">Noirs</option></select></label>
        <label>Résultat<select id="fResult"><option value="">Tous</option><option value="win">Victoires</option><option value="loss">Défaites</option><option value="draw">Nulles</option></select></label>
        <label>Période<select id="fPeriod">${Object.entries(PERIODS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        <label id="fFromL" hidden>Du<input type="date" id="fFrom"></label>
        <label id="fToL" hidden>Au<input type="date" id="fTo"></label>
        <label>Ouverture<select id="fOpening"><option value="">Toutes</option></select></label>
        <button id="fReset" class="ghost">Réinitialiser</button>
      </div>
    <div class="card" style="padding:4px 12px 12px">
      <div class="scroll-x"><table class="games-table">
        <thead><tr>
          <th>Date</th><th>Cadence</th><th><span class="sr-only">Ma couleur</span></th><th>Adversaire</th><th class="num">Elo</th><th>Résultat</th><th>Ouverture</th>
          <th class="num">Ma précision</th><th class="num">Sa précision</th><th>Analyse</th>
        </tr></thead>
        <tbody id="rows"><tr><td colspan="10" class="muted">Chargement…</td></tr></tbody>
      </table></div>
      <div class="list-foot"><button id="more" hidden>Afficher plus de parties</button></div>
    </div>`;

  const $ = (id) => root.querySelector(`#${id}`);
  $('fTc').value = f.timeClass; $('fColor').value = f.color; $('fResult').value = f.result;
  $('fPeriod').value = f.period; $('fFrom').value = f.from; $('fTo').value = f.to;

  api('/api/openings').then((list) => {
    $('fOpening').insertAdjacentHTML('beforeend', list.map((o) => `<option value="${esc(o.name)}">${esc(o.name)} (${o.count})</option>`).join(''));
    $('fOpening').value = f.opening;
  }).catch(() => {});

  function query() {
    const p = new URLSearchParams({ limit: String(limit) });
    if (f.timeClass) p.set('timeClass', f.timeClass);
    if (f.color) p.set('color', f.color);
    if (f.result) p.set('result', f.result);
    if (f.opening) p.set('opening', f.opening);
    if (f.period === 'custom') { if (f.from) p.set('from', f.from); if (f.to) p.set('to', f.to); }
    else if (f.period !== 'all') p.set('from', isoDaysAgo(Number(f.period)));
    return p.toString();
  }

  async function load() {
    $('fFromL').hidden = $('fToL').hidden = f.period !== 'custom';
    store('filters', f);
    let data;
    try { data = await api(`/api/library?${query()}`); } catch (e) { $('rows').innerHTML = `<tr><td colspan="10">${esc(e.message)}</td></tr>`; return; }
    $('count').textContent = `${data.total} partie${data.total > 1 ? 's' : ''}`;
    $('more').hidden = data.games.length >= data.total;
    $('rows').innerHTML = data.games.map((g) => {
      const opp = g.opponent;
      return `<tr data-id="${g.id}" tabindex="0" aria-label="${esc(`Partie contre ${opp.name ?? '?'} le ${fmtDate(g.playedAt)}`)}">
        <td>${fmtDate(g.playedAt)}</td>
        <td>${esc(TIME_CLASS[g.timeClass] ?? g.timeClass ?? '')}</td>
        <td>${g.myColor ? `<span class="colordot ${g.myColor}" title="${g.myColor === 'white' ? 'Blancs' : 'Noirs'}"></span>` : ''}</td>
        <td>${esc(opp.name ?? '?')}</td>
        <td class="num">${opp.elo ?? ''}</td>
        <td>${g.outcome ? `<span class="res ${g.outcome}" title="${RESULT_TITLE[g.outcome]}">${RESULT[g.outcome]}</span>` : esc(g.result)}</td>
        <td>${esc(g.opening ?? '')}</td>
        <td class="num acc">${g.me ? fmtPct(g.me.accuracy) : '–'}</td>
        <td class="num">${fmtPct(opp.accuracy)}</td>
        <td class="nowrap">${statusCell(g)}</td>
      </tr>`;
    }).join('') || `<tr><td colspan="10"><div class="empty" style="margin:10px 0">${data.total === 0 && !f.timeClass && !f.color && !f.result && f.period === 'all' && !f.opening
      ? '<b>Aucune partie pour l\'instant.</b> Importez vos parties dans <a href="#/importer">Importer</a> : il suffit de votre pseudo chess.com ou Lichess.'
      : 'Aucune partie ne correspond à ces filtres.'}</div></td></tr>`;
  }

  const bind = (id, key) => $(id).addEventListener('change', () => { f[key] = $(id).value; limit = 50; load(); });
  bind('fTc', 'timeClass'); bind('fColor', 'color'); bind('fResult', 'result'); bind('fPeriod', 'period');
  bind('fFrom', 'from'); bind('fTo', 'to'); bind('fOpening', 'opening');
  $('fReset').onclick = () => {
    Object.assign(f, { timeClass: '', color: '', result: '', period: 'all', from: '', to: '', opening: '' });
    for (const id of ['fTc', 'fColor', 'fResult', 'fFrom', 'fTo', 'fOpening']) $(id).value = '';
    $('fPeriod').value = 'all';
    limit = 50; load();
  };
  $('more').onclick = () => { limit += 50; load(); };
  $('rows').onclick = async (e) => {
    const btn = e.target.closest('button[data-analyse]');
    if (btn) {
      btn.disabled = true;
      await api(`/api/games/${btn.dataset.analyse}/prioritize`, {}).catch((err) => alert(err.message));
      load();
      return;
    }
    const tr = e.target.closest('tr[data-id]');
    if (tr) location.hash = `#/partie/${tr.dataset.id}`;
  };
  $('rows').onkeydown = (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr && e.key === 'Enter') location.hash = `#/partie/${tr.dataset.id}`;
  };

  await load();
  timer = setInterval(load, 15000); // statuts d'analyse à jour
  return () => clearInterval(timer);
}
