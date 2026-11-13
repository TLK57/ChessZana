// Écran « Répertoire » : arbre de mes ouvertures (Blancs / Noirs), lignes à travailler, parties d'un nœud.
import { api, esc, fig, fmtDate, fmtPct, pctText, store } from './util.js';
import { filterBar, filtersQuery } from './statfilters.js';

const RES = { win: 'V', loss: 'D', draw: 'N' };
const scoreClass = (s, n) => (n < 3 || s == null ? '' : s < 0.4 ? 'score-bad' : s > 0.6 ? 'score-good' : '');

function moveLabel(ply, san) {
  return `${ply % 2 === 1 ? `${Math.ceil(ply / 2)}.` : `${Math.ceil(ply / 2)}…`} ${fig(san)}`;
}

export async function renderRepertoire(root) {
  const saved = store('repertoire') ?? {};
  const st = { side: saved.side ?? 'white', depth: saved.depth ?? 12, min: saved.min ?? 2, open: new Set(), selected: null };
  root.innerHTML = `
    <div class="page-head"><h1>Mon répertoire d'ouvertures</h1><span class="muted small" id="count"></span></div>
    <div id="filters"></div>
    <div class="filters">
      <label>Couleur<select id="side"><option value="white">Avec les Blancs</option><option value="black">Avec les Noirs</option></select></label>
      <label>Profondeur<select id="depth"><option value="8">4 coups</option><option value="12">6 coups</option><option value="16">8 coups</option><option value="20">10 coups</option></select></label>
      <label>Afficher les suites jouées au moins<select id="min"><option value="1">1 fois</option><option value="2">2 fois</option><option value="3">3 fois</option><option value="5">5 fois</option></select></label>
    </div>
    <div class="cols2" style="align-items:start">
      <div class="stack">
        <div class="card"><h2>Lignes à travailler</h2>
          <p class="note">Lignes où <b>vous</b> sortez de la théorie (base lichess-org/chess-openings) et où ça tourne mal ensuite : vos chances de gain baissent de 10 % ou plus dans les 5 coups suivants, ou vous marquez 35 % des points ou moins.</p>
          <div id="problems"></div></div>
        <div class="card"><h2>Arbre des coups</h2>
          <div class="tree"><div class="node" style="cursor:default;font-weight:600;color:var(--muted)"><span>Coup</span><span>Parties</span><span>Score</span><span>Précision</span></div><div id="tree"></div></div>
          <p class="note"><span class="tag book">théorie</span> position de la base d'ouvertures · <span class="tag exit">sortie</span> premier coup hors théorie sur ce chemin. Cliquez sur un coup pour voir les parties.</p></div>
      </div>
      <div class="card" id="gamesBox" style="position:sticky;top:70px"><h2>Parties</h2><p class="muted small">Cliquez sur un coup de l'arbre ou sur une ligne à travailler.</p></div>
    </div>`;
  const $ = (id) => root.querySelector(`#${id}`);
  let filters = filterBar($('filters'), (f) => { filters = f; load(); }, { color: false });
  $('side').value = st.side; $('depth').value = String(st.depth); $('min').value = String(st.min);
  for (const k of ['side', 'depth', 'min']) $(k).onchange = () => { st[k] = k === 'side' ? $(k).value : Number($(k).value); store('repertoire', { side: st.side, depth: st.depth, min: st.min }); st.open.clear(); load(); };

  let data = null;
  const nodes = new Map();

  function nodeHtml(n, parentBook, depth) {
    const key = n.path.join(' ');
    nodes.set(key, n);
    const kids = n.children ?? [];
    const isOpen = st.open.has(key) || depth < 2;
    const mine = (st.side === 'white') === (n.ply % 2 === 1);
    const exit = parentBook && !n.book;
    return `<div>
      <div class="node${st.selected === key ? ' sel' : ''}" data-key="${esc(key)}">
        <span><span class="toggle">${kids.length ? (isOpen ? '▾' : '▸') : ''}</span><b style="${mine ? '' : 'font-weight:400'}">${esc(moveLabel(n.ply, n.san))}</b>
          ${n.book ? '<span class="tag book">théorie</span>' : ''}${exit ? `<span class="tag exit">${mine ? 'vous sortez' : 'l\'adversaire sort'}</span>` : ''}</span>
        <span class="num">${n.games}</span>
        <span class="num ${scoreClass(n.score, n.games)}">${pctText(n.score)}</span>
        <span class="num">${n.accuracy != null ? `${fmtPct(n.accuracy)} %` : '–'}</span>
      </div>
      ${kids.length && isOpen ? `<div class="kids">${kids.map((c) => nodeHtml(c, n.book, depth + 1)).join('')}</div>` : ''}
    </div>`;
  }

  function renderTree() {
    nodes.clear();
    const kids = data.tree.children;
    $('tree').innerHTML = kids.length ? kids.map((c) => nodeHtml(c, true, 0)).join('') : '<p class="muted small">Pas encore de parties analysées avec cette couleur.</p>';
  }

  async function showGames(ids, title) {
    const box = $('gamesBox');
    box.innerHTML = `<h2>${esc(title)}</h2><p class="muted small">Chargement…</p>`;
    const games = await api(`/api/stats/games?ids=${ids.slice(0, 300).join(',')}`);
    box.innerHTML = `<h2>${esc(title)}</h2><p class="muted small">${games.length} partie${games.length > 1 ? 's' : ''}</p>
      <table class="simple"><thead><tr><th>Date</th><th>Adversaire</th><th>Rés.</th><th class="num">Précision</th></tr></thead><tbody>
      ${games.map((g) => `<tr class="click" onclick="location.hash='#/partie/${g.gameId}'" style="cursor:pointer"><td>${fmtDate(g.playedAt)}</td><td>${esc(g.opponent ?? '?')} <span class="muted small">${g.oppElo ?? ''}</span></td>
        <td><span class="res ${g.outcome}">${RES[g.outcome] ?? ''}</span></td><td class="num">${g.accuracy != null ? `${fmtPct(g.accuracy)} %` : '–'}</td></tr>`).join('')}
      </tbody></table>`;
  }

  async function load() {
    data = await api(`/api/stats/repertoire?${filtersQuery(filters, { side: st.side, depth: st.depth, min: st.min })}`);
    $('count').textContent = `${data.games} parties analysées avec les ${st.side === 'white' ? 'Blancs' : 'Noirs'}`;
    renderTree();
    $('problems').innerHTML = data.problemLines.length ? `<table class="simple"><thead><tr><th>Ligne (jusqu'à votre sortie de théorie)</th><th class="num">Parties</th><th class="num">Score</th><th class="num">Δ gain</th></tr></thead><tbody>
      ${data.problemLines.map((l, i) => `<tr class="click" data-line="${i}" style="cursor:pointer"><td>${esc(l.path.map((s, k) => (k % 2 === 0 ? `${k / 2 + 1}. ${fig(s)}` : fig(s))).join(' '))}</td>
        <td class="num">${l.games}</td><td class="num ${scoreClass(l.score, 3)}">${pctText(l.score)}</td>
        <td class="num ${l.winDelta != null && l.winDelta <= -10 ? 'score-bad' : ''}">${l.winDelta != null ? `${l.winDelta > 0 ? '+' : ''}${Math.round(l.winDelta)} %` : '–'}</td></tr>`).join('')}
      </tbody></table>` : '<p class="muted small">Aucune ligne problématique trouvée pour le moment.</p>';
  }

  root.addEventListener('click', (e) => {
    const row = e.target.closest('.node[data-key]');
    if (row) {
      const key = row.dataset.key;
      const n = nodes.get(key);
      if (st.open.has(key)) st.open.delete(key); else st.open.add(key);
      st.selected = key;
      renderTree();
      if (n) showGames(n.ids, `Parties après ${n.path.map((s, k) => (k % 2 === 0 ? `${k / 2 + 1}. ${fig(s)}` : fig(s))).join(' ')}`);
      return;
    }
    const line = e.target.closest('tr[data-line]');
    if (line) {
      const l = data.problemLines[Number(line.dataset.line)];
      showGames(l.ids, `Sortie de théorie : ${l.path.map((s, k) => (k % 2 === 0 ? `${k / 2 + 1}. ${fig(s)}` : fig(s))).join(' ')}`);
    }
  });

  await load();
  return null;
}
