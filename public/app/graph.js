// Graphe des chances de gain des Blancs, cliquable, avec les gaffes et erreurs marquées.
import { esc, fig, LABELS, moveNo } from './util.js';

const MARKED = { blunder: 'var(--blunder)', mistake: 'var(--mistake)', miss: 'var(--miss)' };
const H = 120;

export function createGraph(container, onSelect) {
  const el = document.createElement('div');
  el.className = 'graph';
  el.innerHTML = '<svg></svg><div class="tip" hidden></div>';
  container.appendChild(el);
  const svg = el.querySelector('svg');
  const tip = el.querySelector('.tip');
  let data = null;

  const width = () => Math.max(100, svg.clientWidth || el.clientWidth || 600);
  const n = () => Math.max(1, (data?.series.length ?? 1) - 1);
  const xOf = (i, W) => (i / n()) * W;
  const yOf = (v) => H - (Math.min(100, Math.max(0, v ?? 50)) / 100) * H;

  function render() {
    if (!data) return;
    const W = width();
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const pts = data.series.map((v, i) => `${xOf(i, W).toFixed(1)},${yOf(v).toFixed(1)}`);
    const area = `M0,${H} L${pts.join(' L')} L${W},${H} Z`;
    const marks = data.marks.map((m) => `<circle cx="${xOf(m.ply, W).toFixed(1)}" cy="${yOf(data.series[m.ply]).toFixed(1)}" r="4.5" fill="${MARKED[m.cls]}" stroke="var(--card)" stroke-width="1.5"/>`).join('');
    const cx = xOf(data.current ?? 0, W).toFixed(1);
    svg.innerHTML = `
      <rect x="0" y="0" width="${W}" height="${H}" fill="var(--graph-black)"/>
      <path d="${area}" fill="var(--graph-white)"/>
      <line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" stroke="var(--muted)" stroke-dasharray="3 4" stroke-width="1" opacity=".6"/>
      ${data.freeBase != null ? `<line x1="${xOf(data.freeBase, W).toFixed(1)}" x2="${xOf(data.freeBase, W).toFixed(1)}" y1="0" y2="${H}" stroke="var(--great)" stroke-width="2" stroke-dasharray="4 3"/>` : ''}
      <line x1="${cx}" x2="${cx}" y1="0" y2="${H}" stroke="var(--accent)" stroke-width="2"/>
      ${marks}`;
  }

  function plyAt(clientX) {
    const r = svg.getBoundingClientRect();
    return Math.max(0, Math.min(n(), Math.round(((clientX - r.left) / r.width) * n())));
  }

  svg.addEventListener('click', (e) => { if (data) onSelect(plyAt(e.clientX)); });
  svg.addEventListener('mousemove', (e) => {
    if (!data) return;
    const ply = plyAt(e.clientX);
    const m = data.moves[ply - 1];
    const v = data.series[ply];
    const r = svg.getBoundingClientRect();
    tip.hidden = false;
    tip.style.left = `${xOf(ply, r.width)}px`;
    tip.style.top = `${yOf(v) * (r.height / H)}px`;
    tip.innerHTML = m
      ? `${moveNo(ply)} ${esc(fig(m.san))}${m.classification ? ` · ${esc(LABELS[m.classification])}` : ''} · ${v == null ? '?' : Math.round(v)} % Blancs`
      : `Départ · ${v == null ? '?' : Math.round(v)} % Blancs`;
  });
  svg.addEventListener('mouseleave', () => { tip.hidden = true; });
  const ro = new ResizeObserver(render);
  ro.observe(el);

  return {
    update(d) { data = d; render(); },
    destroy() { ro.disconnect(); el.remove(); },
  };
}
