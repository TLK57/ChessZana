// Outils partagés de l'interface.

export async function api(path, body) {
  const opts = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const LABELS = {
  brilliant: 'Brillant', great: 'Très bon', best: 'Meilleur', excellent: 'Excellent', good: 'Bon', book: 'Théorie',
  inaccuracy: 'Imprécision', mistake: 'Erreur', miss: 'Occasion manquée', blunder: 'Gaffe',
};
export const ORDER = ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'miss', 'blunder'];
const BOOK_SVG = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path fill="currentColor" d="M2 2.5C2 1.7 2.7 1 3.5 1H8v12H3.5c-.5 0-1 .2-1.5.5V2.5zM14 2.5c0-.8-.7-1.5-1.5-1.5H9v12h3.5c.5 0 1 .2 1.5.5V2.5z"/></svg>';
export const SYMBOLS = {
  brilliant: '!!', great: '!', best: '★', excellent: '✓', good: '✓', book: BOOK_SVG,
  inaccuracy: '?!', mistake: '?', miss: '✗', blunder: '??',
};
export const BAD = new Set(['inaccuracy', 'mistake', 'blunder', 'miss']);

export function symbol(cls, title = true) {
  if (!cls) return '';
  return `<span class="sym c-${cls}"${title ? ` title="${esc(LABELS[cls])}"` : ''}>${SYMBOLS[cls]}</span>`;
}

const FIG = { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘' };
export const fig = (san) => String(san ?? '').replace(/[KQRBN]/g, (c) => FIG[c]);

/** Cadence lisible : « 300 » → « 5 min », « 180+2 » → « 3 min + 2 s ». */
export function fmtTimeControl(tc) {
  const m = /^(\d+)(?:\+(\d+))?$/.exec(String(tc ?? ''));
  if (!m) return tc ?? '';
  const base = Number(m[1]);
  const b = base >= 60 && base % 60 === 0 ? `${base / 60} min` : base >= 60 ? `${Math.floor(base / 60)} min ${base % 60} s` : `${base} s`;
  return m[2] && m[2] !== '0' ? `${b} + ${m[2]} s` : b;
}

export const TIME_CLASS = { bullet: 'Bullet', blitz: 'Blitz', rapid: 'Rapide', classical: 'Classique', daily: 'Journalière' };

export function fmtPct(x, d = 1) {
  return x == null || !Number.isFinite(x) ? '–' : x.toFixed(d).replace('.', ',');
}

export function fmtClock(ms) {
  if (ms == null) return '';
  const total = Math.max(0, Math.round(ms / 100) / 10);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = total < 20 ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function fmtSpent(ms) {
  if (ms == null) return '';
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1).replace('.', ',')} s`;
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, '0')}`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
}

export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Numéro de coup : « 12. » pour les Blancs, « 12… » pour les Noirs.
export const moveNo = (ply) => `${Math.ceil(ply / 2)}${ply % 2 === 1 ? '.' : '…'}`;

export function lineText(items, { figurines = true } = {}) {
  return (items ?? []).map((m, i) => {
    const san = figurines ? fig(m.san) : m.san;
    if (m.color === 'w') return `${m.moveNumber}. ${san}`;
    return i === 0 ? `${m.moveNumber}... ${san}` : san;
  }).join(' ');
}

export function toast(html, ms = 5000) {
  const t = document.getElementById('toast');
  t.innerHTML = html;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

export function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key) ?? 'null');
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* stockage indisponible : sans importance */ }
  return null;
}

// Copie un texte ; si le navigateur refuse, l'affiche dans une fenêtre pour le copier à la main.
export async function copyWithFallback(text, okMessage) {
  if (await copyText(text)) { toast(okMessage, 8000); return true; }
  const wrap = document.createElement('div');
  wrap.className = 'promo';
  wrap.innerHTML = `<div class="box" style="flex-direction:column;max-width:760px;width:92vw">
    <b>Copiez ce texte (Ctrl+C), puis collez-le sur claude.ai</b>
    <textarea class="pgn" style="height:320px" readonly></textarea>
    <div class="actions"><a class="primary" href="https://claude.ai/new" target="_blank" rel="noopener">Ouvrir claude.ai</a><button data-close>Fermer</button></div></div>`;
  wrap.querySelector('textarea').value = text;
  wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]')) wrap.remove(); });
  document.body.appendChild(wrap);
  wrap.querySelector('textarea').select();
  return false;
}

export const pctText = (x, d = 0) => (x == null || !Number.isFinite(x) ? '–' : `${(100 * x).toFixed(d).replace('.', ',')} %`);

// ---- Fiabilité des statistiques (voir src/stats/confidence.js) ----
export const MIN_GAMES = 10;
export const SMALL_SAMPLE = 'échantillon trop petit';
export const isSmall = (n) => (n ?? 0) < MIN_GAMES;
/** « IC 95 % : 45–59 % » à partir de { low, high } (proportions). */
export const ciText = (ci, d = 0) => (ci ? `IC 95 % : ${(100 * ci.low).toFixed(d).replace('.', ',')}–${(100 * ci.high).toFixed(d).replace('.', ',')} %` : '');
/** « n = 12 parties », suivi de « échantillon trop petit » en dessous de 10. */
export const nText = (n, unit = 'parties') => `n = ${n ?? 0} ${unit}${isSmall(n) && unit === 'parties' ? `, ${SMALL_SAMPLE}` : ''}`;
