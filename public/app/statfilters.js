// Barre de filtres commune aux écrans de l'étape 3 (mémorisée dans le navigateur).
import { store, TIME_CLASS } from './util.js';

const PERIODS = { all: 'Tout', '30': '30 derniers jours', '90': '3 derniers mois', '180': '6 derniers mois', '365': '12 derniers mois' };

export function filtersQuery(f, extra = {}) {
  const p = new URLSearchParams();
  if (f.timeClass) p.set('timeClass', f.timeClass);
  if (f.color) p.set('color', f.color);
  if (f.opponent) p.set('opponent', f.opponent);
  if (f.period && f.period !== 'all') p.set('from', new Date(Date.now() - Number(f.period) * 864e5).toISOString().slice(0, 10));
  for (const [k, v] of Object.entries(extra)) if (v != null && v !== '') p.set(k, String(v));
  return p.toString();
}

/** Affiche la barre de filtres ; onChange(filtres) est appelé à chaque modification. */
export function filterBar(container, onChange, { color = true } = {}) {
  const f = { timeClass: '', color: '', period: '90', opponent: '', ...(store('statsFilters.v2') ?? {}) };
  container.innerHTML = `<div class="filters">
    <label>Cadence<select data-k="timeClass"><option value="">Toutes</option>${Object.entries(TIME_CLASS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
    ${color ? '<label>Couleur<select data-k="color"><option value="">Les deux</option><option value="white">Blancs</option><option value="black">Noirs</option></select></label>' : ''}
    <label>Période<select data-k="period">${Object.entries(PERIODS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
    <label>Adversaires<select data-k="opponent"><option value="">Tous</option><option value="stronger">Plus forts que moi</option><option value="weaker">Plus faibles que moi</option></select></label>
  </div>`;
  container.querySelectorAll('select[data-k]').forEach((s) => {
    s.value = f[s.dataset.k] ?? '';
    s.addEventListener('change', () => {
      f[s.dataset.k] = s.value;
      store('statsFilters.v2', f);
      onChange({ ...f });
    });
  });
  return { ...f };
}
