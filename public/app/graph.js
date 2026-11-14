// Graphe d'évaluation de la partie : au-dessus de la ligne du milieu, les Blancs mènent ; en dessous, les Noirs.
// Les moments clés (gaffes, erreurs, occasions manquées, brillants) sont marqués ; le curseur suit le coup affiché ;
// survol = infobulle, clic = aller au coup.
import { esc, fig, LABELS, moveNo } from './util.js';

const COLOR = { blunder: 'var(--blunder)', mistake: 'var(--mistake)', miss: 'var(--miss)', brilliant: 'var(--brilliant)' };
let uid = 0;

export function createGraph(container, onSelect) {
  const id = `g${++uid}`;
  const el = document.createElement('div');
  el.className = 'graph';
  el.innerHTML = '<svg role="img" aria-label="Graphe d\'évaluation de la partie"></svg><div class="tip" hidden></div>';
  container.appendChild(el);
  const svg = el.querySelector('svg');
  const tip = el.querySelector('.tip');
  let data = null;
  let hover = null;

  const size = () => ({ W: Math.max(100, el.clientWidth || 600), H: Math.max(50, el.clientHeight || 90) });
  const n = () => Math.max(1, (data?.series.length ?? 1) - 1);
  const xOf = (i, W) => 4 + (i / n()) * (W - 8);
  const yOf = (v, H) => 4 + (1 - Math.min(100, Math.max(0, v ?? 50)) / 100) * (H - 8);

  function render() {
    if (!data) return;
    const { W, H } = size();
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const mid = yOf(50, H);
    const pts = data.series.map((v, i) => `${xOf(i, W).toFixed(1)},${yOf(v, H).toFixed(1)}`);
    const area = `M${xOf(0, W)},${mid} L${pts.join(' L')} L${xOf(n(), W)},${mid} Z`;
    const marks = data.marks.map((m) => `<circle cx="${xOf(m.ply, W).toFixed(1)}" cy="${yOf(data.series[m.ply], H).toFixed(1)}" r="${m.cls === 'blunder' || m.cls === 'brilliant' ? 5 : 4}" fill="${COLOR[m.cls]}" stroke="var(--graph-bg)" stroke-width="2"/>`).join('');
    const cur = data.current ?? 0;
    const cx = xOf(cur, W).toFixed(1);
    const hx = hover != null ? xOf(hover, W).toFixed(1) : null;
    svg.innerHTML = `
      <defs>
        <clipPath id="${id}t"><rect x="0" y="0" width="${W}" height="${mid}"/></clipPath>
        <clipPath id="${id}b"><rect x="0" y="${mid}" width="${W}" height="${H - mid}"/></clipPath>
      </defs>
      <rect x="0" y="0" width="${W}" height="${H}" rx="6" fill="var(--graph-bg)"/>
      <path d="${area}" fill="var(--graph-white)" clip-path="url(#${id}t)"/>
      <path d="${area}" fill="var(--graph-black)" clip-path="url(#${id}b)"/>
      <line x1="0" x2="${W}" y1="${mid}" y2="${mid}" stroke="var(--graphite)" stroke-width="1" stroke-dasharray="2 4"/>
      <text x="8" y="14" class="g-lbl" fill="var(--graphite)" font-size="10.5">Blancs</text>
      <text x="8" y="${H - 7}" class="g-lbl" fill="var(--graphite)" font-size="10.5">Noirs</text>
      ${data.freeBase != null ? `<line x1="${xOf(data.freeBase, W).toFixed(1)}" x2="${xOf(data.freeBase, W).toFixed(1)}" y1="0" y2="${H}" stroke="var(--great)" stroke-width="2" stroke-dasharray="4 3"/>` : ''}
      ${hx != null && hover !== cur ? `<line x1="${hx}" x2="${hx}" y1="0" y2="${H}" stroke="var(--graphite)" stroke-width="1"/>` : ''}
      <line x1="${cx}" x2="${cx}" y1="0" y2="${H}" stroke="var(--pen)" stroke-width="2"/>
      ${marks}
      <circle cx="${cx}" cy="${yOf(data.series[cur], H).toFixed(1)}" r="4" fill="var(--pen)" stroke="var(--graph-bg)" stroke-width="2"/>`;
  }

  function plyAt(clientX) {
    const r = svg.getBoundingClientRect();
    return Math.max(0, Math.min(n(), Math.round(((clientX - r.left - 4) / Math.max(1, r.width - 8)) * n())));
  }

  svg.addEventListener('click', (e) => { if (data) onSelect(plyAt(e.clientX)); });
  svg.addEventListener('mousemove', (e) => {
    if (!data) return;
    const ply = plyAt(e.clientX);
    if (ply !== hover) { hover = ply; render(); }
    const m = data.moves[ply - 1];
    const v = data.series[ply];
    const { W, H } = size();
    tip.hidden = false;
    tip.style.left = `${Math.min(W - 70, Math.max(70, xOf(ply, W)))}px`;
    tip.style.top = `${yOf(v, H)}px`;
    const pct = v == null ? '?' : Math.round(v);
    tip.innerHTML = m
      ? `<b>${moveNo(ply)} ${esc(fig(m.san))}</b>${m.classification ? ` <span class="t-${m.classification}">${esc(LABELS[m.classification])}</span>` : ''}<br>${m.evalAfterText ? `Évaluation ${esc(m.evalAfterText)}, ` : ''}Blancs ${pct} %`
      : `<b>Départ</b><br>Blancs ${pct} %`;
  });
  svg.addEventListener('mouseleave', () => { tip.hidden = true; hover = null; render(); });
  const ro = new ResizeObserver(render);
  ro.observe(el);

  return {
    update(d) { data = d; render(); },
    destroy() { ro.disconnect(); el.remove(); },
  };
}
