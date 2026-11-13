// Point d'entrée : navigation entre les écrans et bandeau d'état.
import { api } from './util.js';
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
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.remove('active'));
  view.innerHTML = '';
  if (game) {
    cleanup = await renderGame(view, Number(game[1]), game[2] != null ? Number(game[2]) : 0);
  } else if (PAGES[hash.split('?')[0]]) {
    const [nav, render] = PAGES[hash.split('?')[0]];
    document.querySelector(`[data-nav=${nav}]`).classList.add('active');
    try {
      cleanup = await render(view);
    } catch (e) {
      view.innerHTML = `<div class="card">Impossible d'afficher cette page : ${String(e.message).replace(/</g, '&lt;')}</div>`;
    }
  } else {
    document.querySelector('[data-nav=list]').classList.add('active');
    cleanup = await renderList(view);
  }
}

async function refreshPills() {
  try {
    const s = await api('/api/status');
    const e = s.engine;
    const ep = document.getElementById('enginePill');
    ep.textContent = e.status === 'ready' ? `${e.name}` : e.message;
    ep.className = `pill ${e.status === 'ready' ? 'ok' : e.status === 'error' ? 'err' : ''}`;
    const q = s.queue.passes;
    const qp = document.getElementById('queuePill');
    const cur = s.queue.current ? ' · analyse en cours' : '';
    const waiting = s.queue.requested.waiting;
    const txt = s.queue.mode === 'manual'
      ? `Analyse à la demande · ${waiting} partie${waiting > 1 ? 's' : ''} en file${cur}`
      : s.queue.mode === 'quick'
        ? `Rapide automatique ${q.quick.done}/${q.quick.total} · profonde à la demande (${waiting} en file)`
        : `Analyse automatique : rapide ${q.quick.done}/${q.quick.total} · profonde ${q.deep.done}/${q.deep.total}`;
    qp.textContent = s.queue.paused ? `En pause · ${txt}` : txt;
  } catch {
    document.getElementById('enginePill').textContent = 'Serveur arrêté';
    document.getElementById('enginePill').className = 'pill err';
  }
}

window.addEventListener('hashchange', route);
route();
refreshPills();
setInterval(refreshPills, 4000);
