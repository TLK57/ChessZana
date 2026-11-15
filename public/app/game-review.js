// Écran d'une partie — saisie à la main du bilan chess.com (« Game Review ») de la partie : précision et nombre de
// coups par catégorie, pour chaque joueur. Il sert à comparer nos méthodes à chess.com et à ajuster le style chess.com.
// Rien n'est lu sur chess.com : seulement les chiffres recopiés ici.
import { api, esc, symbol, toast, LABELS } from './util.js';

// Ordre de la page de bilan de chess.com.
const CATS = ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'miss', 'blunder'];

const val = (v) => (v == null ? '' : String(v).replace('.', ','));

/** Ouvre le formulaire ; onSaved(review) est appelé après l'enregistrement (review null si effacé). */
export function openReviewForm(ctx, onSaved) {
  const { g } = ctx;
  const r = g.chesscomReview ?? { white: {}, black: {} };
  const wrap = document.createElement('div');
  wrap.className = 'promo';
  const input = (side, key, label) => `<input type="text" inputmode="decimal" autocomplete="off" data-side="${side}" data-key="${key}"
    value="${esc(val(r[side]?.[key]))}" aria-label="${esc(`${label}, ${side === 'white' ? g.white.name : g.black.name}`)}">`;
  wrap.innerHTML = `<form class="box review-form" role="dialog" aria-modal="true" aria-labelledby="rvTitle">
    <h2 id="rvTitle">Bilan chess.com de cette partie</h2>
    <p class="small muted">Recopiez les chiffres du « Game Review » de chess.com. Rien n'est récupéré automatiquement.
      Une case vide n'est pas comparée : mettez 0 quand chess.com affiche 0.</p>
    <table class="rv-table">
      <thead><tr><th></th><th><span class="colordot white"></span> ${esc(g.white.name)}</th><th><span class="colordot black"></span> ${esc(g.black.name)}</th></tr></thead>
      <tbody>
        <tr><th scope="row">Précision (%)</th><td>${input('white', 'accuracy', 'Précision')}</td><td>${input('black', 'accuracy', 'Précision')}</td></tr>
        ${CATS.map((k) => `<tr><th scope="row">${symbol(k, false)} ${esc(LABELS[k])}</th><td>${input('white', k, LABELS[k])}</td><td>${input('black', k, LABELS[k])}</td></tr>`).join('')}
      </tbody>
    </table>
    <p class="rv-error small" hidden></p>
    <div class="actions">
      <button type="submit" class="primary">Enregistrer</button>
      ${g.chesscomReview ? '<button type="button" data-clear>Effacer le bilan</button>' : ''}
      <button type="button" data-close>Annuler</button>
    </div>
  </form>`;
  const form = wrap.querySelector('form');
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  const save = async (empty) => {
    const body = { white: {}, black: {} };
    if (!empty) for (const el of form.querySelectorAll('input[data-side]')) if (el.value.trim() !== '') body[el.dataset.side][el.dataset.key] = el.value.trim();
    try {
      const { review } = await api(`/api/games/${g.id}/chesscom-review`, body);
      close();
      onSaved(review);
      toast(review ? 'Bilan chess.com enregistré.' : 'Bilan chess.com effacé.');
    } catch (e) {
      const err = form.querySelector('.rv-error');
      err.textContent = e.message;
      err.hidden = false;
    }
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); save(false); });
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap || e.target.closest('[data-close]')) close();
    else if (e.target.closest('[data-clear]')) save(true);
  });
  document.body.appendChild(wrap);
  form.querySelector('input').focus();
}
