// Interface : bilan guidé (moments clés) et changement de thème clair / sombre, testés sans navigateur.
import test from 'node:test';
import assert from 'node:assert/strict';
import { keyMoments, startReview, stepReview, currentMoment, reviewProgress } from '../public/app/review.js';
import { THEMES, THEME_KEY, applyTheme, effectiveTheme, nextTheme, storedTheme, themeButton } from '../public/app/theme.js';
import { partie620 } from './_partie620.js';

// ---------------------------------------------------------------- bilan guidé
const moves = [
  { ply: 1, color: 'w', classification: 'book' },
  { ply: 2, color: 'b', classification: 'best' },
  { ply: 3, color: 'w', classification: 'blunder' },
  { ply: 4, color: 'b', classification: 'miss' },
  { ply: 5, color: 'w', classification: 'inaccuracy' },
  { ply: 6, color: 'b', classification: 'mistake' },
  { ply: 7, color: 'w', classification: 'brilliant' },
  { ply: 8, color: 'b', classification: 'great' },
];

test('bilan guidé : seuls les gaffes, occasions manquées, erreurs et coups brillants, dans l\'ordre de la partie', () => {
  assert.deepEqual(keyMoments(moves).map((m) => m.ply), [3, 4, 6, 7]);
  assert.deepEqual(keyMoments(moves, { color: 'w' }).map((m) => m.ply), [3, 7]);
  assert.deepEqual(keyMoments([]), []);
  assert.deepEqual(keyMoments(null), []);
});

test('bilan guidé : on avance et on recule un moment à la fois, sans sortir des bornes', () => {
  let r = startReview(moves);
  assert.equal(currentMoment(r).ply, 3);
  assert.equal(reviewProgress(r), 'Moment 1 sur 4');
  r = stepReview(r, -1);
  assert.equal(currentMoment(r).ply, 3, 'pas avant le premier');
  r = stepReview(stepReview(stepReview(r, 1), 1), 1);
  assert.equal(currentMoment(r).ply, 7);
  assert.equal(reviewProgress(r), 'Moment 4 sur 4');
  r = stepReview(r, 1);
  assert.equal(currentMoment(r).ply, 7, 'pas après le dernier');
  assert.equal(stepReview(null, 1), null);
});

test('bilan guidé : une partie sans moment clé n\'ouvre pas de bilan', () => {
  assert.equal(startReview([{ ply: 1, color: 'w', classification: 'best' }]), null);
  assert.equal(currentMoment(null), null);
  assert.equal(reviewProgress(null), '');
});

test('bilan guidé sur la partie 620 (classements enregistrés) : le premier moment est la gaffe 15...Cxf3+', () => {
  const rows = partie620.analyses.deep.map((r) => ({ ply: r.ply, color: r.ply % 2 ? 'w' : 'b', classification: r.classification }));
  const r = startReview(rows);
  assert.ok(r, 'la partie a des moments clés');
  assert.equal(currentMoment(r).ply, 30, '15...Cxf3+');
  assert.equal(currentMoment(r).classification, 'blunder');
  assert.ok(r.moments.every((m, i) => i === 0 || m.ply > r.moments[i - 1].ply), 'ordre de la partie');
});

// ---------------------------------------------------------------- thème
function fakeStorage(initial = {}) {
  const data = { ...initial };
  return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, removeItem: (k) => { delete data[k]; } };
}
function fakeDocument() {
  const attrs = {};
  return { attrs, documentElement: { setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; } } };
}

test('thème : celui du système par défaut, puis clair, sombre, et retour au système', () => {
  assert.equal(storedTheme(fakeStorage()), 'auto');
  assert.equal(storedTheme(fakeStorage({ [THEME_KEY]: 'n\'importe quoi' })), 'auto');
  assert.equal(storedTheme({ getItem: () => { throw new Error('stockage bloqué'); } }), 'auto');
  assert.deepEqual(THEMES.map(nextTheme), ['light', 'dark', 'auto']);
  assert.equal(effectiveTheme('auto', true), 'dark');
  assert.equal(effectiveTheme('auto', false), 'light');
  assert.equal(effectiveTheme('light', true), 'light');
});

test('thème : le choix est appliqué à la page et mémorisé ; « automatique » efface le choix', () => {
  const doc = fakeDocument();
  const st = fakeStorage();
  applyTheme(doc, st, 'dark');
  assert.equal(doc.attrs['data-theme'], 'dark');
  assert.equal(st.data[THEME_KEY], 'dark');
  assert.equal(storedTheme(st), 'dark', 'retrouvé au prochain chargement');
  applyTheme(doc, st, 'auto');
  assert.equal(doc.attrs['data-theme'], undefined);
  assert.equal(st.data[THEME_KEY], undefined);
  assert.equal(applyTheme(doc, st, 'violet'), 'auto', 'valeur inconnue : automatique');
});

test('thème : le bouton fait défiler les choix et garde le dernier', () => {
  const doc = fakeDocument();
  const st = fakeStorage({ [THEME_KEY]: 'light' });
  let onClick = null;
  const btn = { textContent: '', title: '', setAttribute() {}, addEventListener: (ev, fn) => { if (ev === 'click') onClick = fn; } };
  themeButton(btn, doc, st);
  assert.equal(doc.attrs['data-theme'], 'light', 'choix mémorisé appliqué au chargement');
  assert.match(btn.title, /clair/);
  onClick();
  assert.equal(doc.attrs['data-theme'], 'dark');
  assert.equal(st.data[THEME_KEY], 'dark');
  assert.match(btn.title, /sombre/);
  onClick();
  assert.equal(doc.attrs['data-theme'], undefined);
  assert.match(btn.title, /système/);
});

test('la page applique le thème mémorisé avant l\'affichage et embarque ses polices', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.match(html, /localStorage\.getItem\('theme'\)/);
  assert.match(html, /id="themeBtn"/);
  const css = fs.readFileSync(path.join(ROOT, 'public', 'app', 'app.css'), 'utf8');
  assert.match(css, /:root\[data-theme="dark"\]/);
  assert.match(css, /prefers-color-scheme: dark/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  for (const m of css.matchAll(/url\('\/fonts\/([^']+)'\)/g)) assert.ok(fs.existsSync(path.join(ROOT, 'public', 'fonts', m[1])), m[1]);
  assert.doesNotMatch(css + html, /https?:\/\/(fonts\.googleapis|cdn|unpkg)/, 'aucun CDN : tout fonctionne hors ligne');
});
