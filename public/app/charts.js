// Petits graphiques SVG faits main (lignes dans le temps, barres) avec infobulle au survol.
import { esc } from './util.js';

const H = 220;
const PAD = { l: 44, r: 14, t: 12, b: 26 };

function niceRange(min, max, ticks = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, step: 0.25 };
  if (min === max) { min -= 1; max += 1; }
  const raw = (max - min) / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw) ?? raw;
  return { min: Math.floor(min / step) * step, max: Math.ceil(max / step) * step, step };
}

// Étiquettes de l'axe du temps : le mois sur une longue période, le jour sur une courte.
const fmtTime = (span) => (t) => new Date(t).toLocaleDateString('fr-FR', span > 120 * 864e5 ? { month: 'short', year: '2-digit' } : { day: 'numeric', month: 'short' });

/** Moyenne glissante sur les `k` derniers points (rien tant qu'il y a moins de `min` points). */
export function movingAverage(points, k = 10, min = 1) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const w = points.slice(Math.max(0, i - k + 1), i + 1).filter((p) => p.y != null);
    if (w.length >= min) out.push({ x: points[i].x, y: w.reduce((a, p) => a + p.y, 0) / w.length, data: points[i].data });
  }
  return out;
}

/**
 * Graphique en lignes dans le temps.
 * series : [{ label, color, points: [{x: ms, y, data}], dots: bool, line: bool, width }]
 * opts : { yMin, yMax, yFormat, tip(data, series) -> html, onClick(data) }
 */
export function lineChart(container, series, opts = {}) {
  const el = document.createElement('div');
  el.className = 'chart';
  container.innerHTML = '';
  container.appendChild(el);
  const all = series.flatMap((s) => s.points).filter((p) => p.y != null);
  if (!all.length) { el.innerHTML = '<p class="muted small">Pas encore assez de parties analysées.</p>'; return; }
  const xs = all.map((p) => p.x);
  const xMin = Math.min(...xs), xMax = Math.max(...xs) === xMin ? xMin + 864e5 : Math.max(...xs);
  const yr = niceRange(opts.yMin ?? Math.min(...all.map((p) => p.y)), opts.yMax ?? Math.max(...all.map((p) => p.y)));
  const yFmt = opts.yFormat ?? ((v) => String(Math.round(v)));

  function draw() {
    const W = Math.max(280, el.clientWidth || 600);
    const X = (x) => PAD.l + ((x - xMin) / (xMax - xMin)) * (W - PAD.l - PAD.r);
    const Y = (y) => PAD.t + (1 - (y - yr.min) / (yr.max - yr.min)) * (H - PAD.t - PAD.b);
    const grid = [];
    for (let v = yr.min; v <= yr.max + 1e-9; v += yr.step) {
      grid.push(`<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${Y(v)}" y2="${Y(v)}" class="grid"/><text x="${PAD.l - 6}" y="${Y(v) + 4}" class="axis" text-anchor="end">${esc(yFmt(v))}</text>`);
    }
    const ticks = [];
    const nT = Math.min(6, Math.max(2, Math.floor(W / 120)));
    const fmt = fmtTime(xMax - xMin);
    let prevLabel = null;
    for (let i = 0; i <= nT; i++) {
      const t = xMin + ((xMax - xMin) * i) / nT;
      const label = fmt(t);
      if (label === prevLabel) continue; // pas deux fois la même étiquette
      prevLabel = label;
      ticks.push(`<text x="${X(t)}" y="${H - 6}" class="axis" text-anchor="${i === 0 ? 'start' : i === nT ? 'end' : 'middle'}">${esc(label)}</text>`);
    }
    const marks = series.map((s, si) => {
      const pts = s.points.filter((p) => p.y != null);
      const path = s.line !== false && pts.length > 1 ? `<path d="M${pts.map((p) => `${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' L')}" fill="none" stroke="${s.color}" stroke-width="${s.width ?? 2}" stroke-linejoin="round" stroke-linecap="round"/>` : '';
      const dots = s.dots ? pts.map((p) => `<circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="${s.r ?? 3}" fill="${s.color}" opacity="${s.opacity ?? 0.45}"/>`).join('') : '';
      return `<g data-s="${si}">${dots}${path}</g>`;
    }).join('');
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img">${grid.join('')}${ticks.join('')}${marks}
      <line class="cross" x1="0" x2="0" y1="${PAD.t}" y2="${H - PAD.b}" visibility="hidden"/><g class="hl"></g></svg>
      <div class="tip" hidden></div>`;
    const svg = el.querySelector('svg');
    const tip = el.querySelector('.tip');
    const cross = svg.querySelector('.cross');
    const hl = svg.querySelector('.hl');
    const nearest = (clientX) => {
      const r = svg.getBoundingClientRect();
      const x = xMin + ((clientX - r.left - PAD.l) / (r.width - PAD.l - PAD.r)) * (xMax - xMin);
      let best = null;
      for (const s of series) for (const p of s.points) if (p.y != null && p.data && (!best || Math.abs(p.x - x) < Math.abs(best.x - x))) best = p;
      return best;
    };
    svg.addEventListener('mousemove', (e) => {
      const p = nearest(e.clientX);
      if (!p) return;
      const r = svg.getBoundingClientRect();
      const px = X(p.x);
      cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
      const same = series.map((s) => ({ s, q: s.points.find((q) => q.x === p.x && q.y != null) })).filter((o) => o.q);
      hl.innerHTML = same.map(({ s, q }) => `<circle cx="${px}" cy="${Y(q.y)}" r="5" fill="${s.color}" stroke="var(--card)" stroke-width="2"/>`).join('');
      tip.hidden = false;
      tip.style.left = `${(px / W) * r.width}px`;
      tip.innerHTML = opts.tip ? opts.tip(p.data, same) : same.map(({ s, q }) => `${esc(s.label)} : <b>${esc(yFmt(q.y))}</b>`).join('<br>');
    });
    svg.addEventListener('mouseleave', () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); hl.innerHTML = ''; });
    svg.addEventListener('click', (e) => { const p = nearest(e.clientX); if (p && opts.onClick) opts.onClick(p.data); });
    svg.style.cursor = opts.onClick ? 'pointer' : 'default';
  }
  draw();
  new ResizeObserver(() => draw()).observe(el);
}

/** Barres horizontales simples : items [{ label, value, text, sub }] ; une seule couleur. */
export function barList(container, items, { max = null, color = 'var(--series-1)', onClick = null } = {}) {
  const m = max ?? Math.max(1e-9, ...items.map((i) => i.value ?? 0));
  container.innerHTML = `<div class="bars">${items.map((it, i) => `
    <div class="bar-row${onClick ? ' click' : ''}" data-i="${i}" title="${esc(it.title ?? '')}">
      <div class="bar-label">${esc(it.label)}${it.sub ? ` <span class="muted small">${esc(it.sub)}</span>` : ''}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(0, Math.min(100, (100 * (it.value ?? 0)) / m))}%;background:${it.color ?? color}"></div></div>
      <div class="bar-value">${esc(it.text ?? String(it.value ?? '–'))}</div>
    </div>`).join('')}</div>`;
  if (onClick) container.querySelectorAll('.bar-row').forEach((r) => r.addEventListener('click', () => onClick(items[Number(r.dataset.i)])));
}
