// Point d'entrée : navigation entre les écrans et bandeau d'état.
import { api } from './util.js';
import { themeButton } from './theme.js';
import { renderList } from './list.js';
import { renderImport } from './importview.js';
import { renderGame } from './analysis.js';
import { renderProgress } from './progress.js';
import { renderRepertoire } from './repertoire.js';
import { renderErrors } from './errors.js';
import { renderTraining } from './training.js';

const PAGES = {
  '#/progression': ['progress', renderProgress],
  '#/repertoire': ['repertoire', renderRepertoire],
  '#/erreurs': ['errors', renderErrors],
  '#/entrainement': ['training', renderTraining],
  '#/importer': ['import', renderImport],
};

const view = document.getElementById('view');
let cleanup = null;

async function route() {
  if (cleanup) { try { cleanup(); } catch { /* écran déjà fermé */ } cleanup = null; }
  const hash = location.hash || '#/';
  const game = /^#\/partie\/(\d+)(?:\/(\d+))?/.exec(hash);
  document.querySelectorAll('[data-nav]').forEach((a) => { a.classList.remove('active'); a.removeAttribute('aria-current'); });
  document.body.classList.toggle('game-page', Boolean(game));
  view.innerHTML = '';
  if (game) {
    cleanup = await renderGame(view, Number(game[1]), game[2] != null ? Number(game[2]) : 0);
  } else if (PAGES[hash.split('?')[0]]) {
    const [nav, render] = PAGES[hash.split('?')[0]];
    markNav(nav);
    try {
      cleanup = await render(view);
    } catch (e) {
      view.innerHTML = `<div class="card">Impossible d'afficher cette page : ${String(e.message).replace(/</g, '&lt;')}</div>`;
    }
  } else {
    markNav('list');
    cleanup = await renderList(view);
  }
}

function markNav(nav) {
  const a = document.querySelector(`[data-nav=${nav}]`);
  a.classList.add('active');
  a.setAttribute('aria-current', 'page');
}

// Bandeau si la base est endommagée : proposer la dernière sauvegarde saine.
function integrityBanner(integrity) {
  let el = document.getElementById('integrityBanner');
  if (!integrity || integrity.ok) { el?.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'integrityBanner';
    el.className = 'card';
    el.style.cssText = 'border-color:var(--blunder);margin:12px 20px 0';
    document.body.insertBefore(el, document.getElementById('view'));
  }
  const b = integrity.healthyBackup;
  el.innerHTML = `<b style="color:var(--blunder)">La base de données semble endommagée.</b> L'analyse est arrêtée pour ne rien aggraver.
    ${b ? `<button class="primary" id="restoreHealthy" style="margin-left:8px">Restaurer la sauvegarde saine du ${new Date(b.createdAt).toLocaleString('fr-FR')}</button>` : ' Aucune sauvegarde saine n\'a été trouvée.'}`;
  const btn = el.querySelector('#restoreHealthy');
  if (btn) btn.onclick = async () => {
    if (!confirm('Restaurer cette sauvegarde ? La base actuelle sera gardée à côté, au cas où.')) return;
    try { await api('/api/backups/restore', { name: b.name }); location.reload(); } catch (e) { alert(e.message); }
  };
}

async function refreshPills() {
  try {
    const s = await api('/api/status');
    integrityBanner(s.integrity);
    const e = s.engine;
    const ep = document.getElementById('enginePill');
    ep.textContent = e.status === 'ready' ? `${e.name}` : e.message;
    ep.title = e.status === 'ready' ? 'Moteur prêt' : e.message;
    ep.className = `pill ${e.status === 'ready' ? 'ok' : e.status === 'error' ? 'err' : 'busy'}`;
    const q = s.queue.passes;
    const qp = document.getElementById('queuePill');
    const waiting = s.queue.requested.waiting;
    // Texte court dans la barre ; le détail de la file est dans l'infobulle.
    // En pause, une partie demandée depuis la mise en pause est quand même analysée : « Analyse en cours » d'abord.
    const short = s.queue.current ? 'Analyse en cours'
      : s.queue.paused ? 'Analyse en pause'
        : waiting ? `${waiting} partie${waiting > 1 ? 's' : ''} en attente` : 'Aucune analyse en cours';
    const mode = s.queue.mode === 'manual' ? 'Analyse à la demande'
      : s.queue.mode === 'quick' ? `Passe rapide automatique (${q.quick.done} sur ${q.quick.total}), profonde à la demande`
        : `Analyse automatique : rapide ${q.quick.done} sur ${q.quick.total}, profonde ${q.deep.done} sur ${q.deep.total}`;
    qp.textContent = short;
    qp.className = `pill${s.queue.current ? ' busy' : ''}`;
    qp.title = `${mode}. ${waiting} partie${waiting > 1 ? 's' : ''} en attente. Cliquez pour voir la file.`;
  } catch {
    document.getElementById('enginePill').textContent = 'Serveur arrêté';
    document.getElementById('enginePill').className = 'pill err';
  }
}

themeButton(document.getElementById('themeBtn'));
// Lien d'évitement : met le focus sur le contenu sans changer d'écran.
document.querySelector('.skip').addEventListener('click', (e) => { e.preventDefault(); view.focus(); });
window.addEventListener('hashchange', route);
route();
refreshPills();
setInterval(refreshPills, 4000);
