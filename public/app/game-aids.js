// Écran d'une partie — aides visuelles sur l'échiquier (comme Lichess et chess.com) : flèche du meilleur coup,
// flèche de la menace, faiblesses, et leur barre de boutons. Les couleurs de toutes les aides sont définies ici,
// et seulement ici.
import { Chess } from '/vendor/chess.js';
import { esc, fig, fmtPct, store, BAD } from './util.js';
import { findWeaknesses } from './weaknesses.js';

/**
 * Code couleur des aides. Les flèches du moteur sont semi-transparentes et plus fines que les vôtres ;
 * les vôtres (clic droit) gardent les couleurs classiques de Lichess.
 */
export const AID_COLORS = {
  best: '#1E8C3A', // meilleur coup : vert
  threat: '#D32F2F', // menace : rouge
  weakness: '#EF8A17', // faiblesses : orange
  manual: { green: '#15781B', red: '#882020', blue: '#003088', orange: '#E68F00' }, // vos flèches et cases
};

// Pinceaux de chessground (couleur, opacité, épaisseur). Ceux de vos flèches remplacent ceux de chessground.
export const AID_BRUSHES = {
  green: { key: 'g', color: AID_COLORS.manual.green, opacity: 1, lineWidth: 10 },
  red: { key: 'r', color: AID_COLORS.manual.red, opacity: 1, lineWidth: 10 },
  blue: { key: 'b', color: AID_COLORS.manual.blue, opacity: 1, lineWidth: 10 },
  orange: { key: 'o', color: AID_COLORS.manual.orange, opacity: 1, lineWidth: 10 },
  aidBest: { key: 'ab', color: AID_COLORS.best, opacity: 0.75, lineWidth: 8 },
  aidBestLine: { key: 'abl', color: AID_COLORS.best, opacity: 0.4, lineWidth: 5 },
  aidThreat: { key: 'at', color: AID_COLORS.threat, opacity: 0.75, lineWidth: 8 },
};

// Les mêmes couleurs pour le CSS (pastilles de la barre, marquage des faiblesses).
for (const [k, v] of Object.entries({ best: AID_COLORS.best, threat: AID_COLORS.threat, weakness: AID_COLORS.weakness })) {
  document.documentElement.style.setProperty(`--aid-${k}`, v);
}

// Réglages mémorisés dans le navigateur. Par défaut : seulement la flèche du meilleur coup, sur les fautes.
const DEFAULT_PREFS = { best: true, bestAll: false, bestLine: false, threat: false, weak: false, weakBoth: false };
export const loadAidPrefs = () => ({ ...DEFAULT_PREFS, ...(store('boardAids') ?? {}) });

/** Coup affiché avec son analyse : coup de la partie, ou coup du mode libre une fois analysé. */
function shownMove(nd) {
  if (nd.move) return nd.move;
  if (nd.item?.result) return { ...nd.item.result, uci: nd.item.uci };
  return null;
}

/**
 * Flèche du meilleur coup dans la position AVANT le coup affiché (ce qu'il fallait jouer), en vert ; en option, les
 * 2 ou 3 coups suivants de la meilleure suite, plus pâles et plus fins. Par défaut seulement sur une imprécision,
 * une erreur, une occasion manquée ou une gaffe.
 */
export function bestShapes(nd, prefs) {
  const m = shownMove(nd);
  if (!prefs.best || !m?.bestUci || m.bestUci === m.uci) return [];
  if (!prefs.bestAll && !BAD.has(m.classification)) return [];
  const arrow = (uci, brush) => ({ orig: uci.slice(0, 2), dest: uci.slice(2, 4), brush });
  const shapes = [arrow(m.bestUci, 'aidBest')];
  const line = m.lines?.[0]?.line ?? [];
  if (prefs.bestLine && line[0]?.uci === m.bestUci) {
    for (const x of line.slice(1, 4)) if (x.uci) shapes.push(arrow(x.uci, 'aidBestLine'));
  }
  return shapes;
}

/**
 * Aides de l'écran : réglages, barre de boutons et formes à dessiner. onChange() est appelé quand l'affichage
 * doit être refait (réglage changé).
 */
export function createAids(ctx, onChange) {
  const prefs = loadAidPrefs();
  const save = () => store('boardAids', prefs);

  // ---- Menace : calculée à la volée par le serveur (Stockfish, trait inversé), gardée en mémoire par position,
  //      et annulée si la position affichée change avant la fin du calcul. ----
  const threats = new Map(); // FEN → réponse du serveur
  let pending = null; // { fen, ctl } : calcul en cours
  function cancelThreat() { pending?.ctl.abort(); pending = null; }
  function threatFor(fen) {
    if (threats.has(fen)) return threats.get(fen);
    if (pending?.fen === fen) return undefined;
    cancelThreat();
    const ctl = new AbortController();
    pending = { fen, ctl };
    fetch('/api/live/threat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fen }), signal: ctl.signal })
      .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.statusText); return j; })
      .then((j) => threats.set(fen, j))
      .catch((e) => { if (e.name !== 'AbortError') threats.set(fen, { fen, threat: null, error: e.message }); })
      .finally(() => { if (pending?.ctl === ctl) { pending = null; onChange(); } });
    return undefined;
  }

  function toggle(key) {
    prefs[key] = !prefs[key];
    save();
    if (key === 'threat') { cancelThreat(); for (const [k, v] of threats) if (v.error) threats.delete(k); }
    onChange();
  }

  /** Flèches automatiques pour la position affichée : meilleur coup (vert) et menace (rouge). */
  function shapes(nd) {
    const out = bestShapes(nd, prefs);
    if (!prefs.threat) { cancelThreat(); return out; }
    const t = threatFor(nd.fen)?.threat;
    if (t?.uci) out.push({ orig: t.uci.slice(0, 2), dest: t.uci.slice(2, 4), brush: 'aidThreat' });
    return out;
  }

  // ---- Faiblesses : pièces en prise et non défendues (sans moteur), de mon camp, ou des deux en option. ----
  let weakCache = { key: '', list: [] };
  function weaknesses(nd) {
    if (!prefs.weak) return [];
    const mine = (ctx.g.myColor ?? ctx.S.orientation)[0];
    const colors = prefs.weakBoth ? ['w', 'b'] : [mine];
    const key = `${nd.fen}|${colors.join('')}`;
    if (weakCache.key !== key) weakCache = { key, list: findWeaknesses(new Chess(nd.fen), colors) };
    return weakCache.list;
  }

  /** Ligne d'information sous la barre : ce que montre la flèche de menace. */
  function threatInfo(nd) {
    if (!prefs.threat) return '';
    const t = threats.get(nd.fen);
    if (!t) return '<span class="spinner"></span> Calcul de la menace…';
    if (t.error) return `Menace indisponible : ${esc(t.error)}`;
    if (t.reason === 'check') return 'Pas de menace calculée : le camp au trait est en échec.';
    if (!t.threat) return 'Pas de menace sérieuse.';
    const who = t.threat.color === 'w' ? 'les Blancs' : 'les Noirs';
    const what = t.threat.mate ? `mat en ${t.threat.mate}` : `+${fmtPct(t.threat.gain, 0)} points de chances de gain`;
    return `<b class="aid-threat-txt">Menace</b> : ${esc(fig(t.threat.san ?? t.threat.uci))} (${what} pour ${who} s'ils jouaient maintenant).`;
  }

  const BUTTONS = [
    ['best', 'Meilleur', 'Flèche verte du meilleur coup (touche B)'],
    ['threat', 'Menace', 'Flèche rouge de la menace : le meilleur coup de l\'adversaire s\'il pouvait jouer maintenant (touche X)'],
    ['weak', 'Faiblesses', 'Vos pièces en prise (coins orange) et non défendues (point orange) ; survolez une case pour le détail (touche F)'],
  ];
  const OPTIONS = [
    ['bestAll', 'Meilleur coup aussi sur les bons coups (pas seulement sur les fautes)'],
    ['bestLine', 'Afficher aussi la suite du meilleur coup (2 ou 3 coups, plus pâles)'],
    ['weakBoth', 'Faiblesses des pièces adverses aussi'],
  ];

  function renderBar(nd) {
    const bar = ctx.$('#aids');
    bar.innerHTML = `<div class="aids-row" role="group" aria-label="Aides sur l'échiquier">
        ${BUTTONS.map(([k, label, title]) => `<button class="aid" data-aid="${k}" aria-pressed="${prefs[k]}" title="${esc(title)}"><i class="aid-dot ${k}"></i>${esc(label)}</button>`).join('')}
        <button class="aid aid-opt" id="aidOpt" aria-expanded="${ctx.S.aidOptions ? 'true' : 'false'}" aria-controls="aidOptions" title="Options des aides">⚙</button>
      </div>
      <div class="aid-options" id="aidOptions"${ctx.S.aidOptions ? '' : ' hidden'}>
        ${OPTIONS.map(([k, label]) => `<label><input type="checkbox" data-opt="${k}"${prefs[k] ? ' checked' : ''}> ${esc(label)}</label>`).join('')}
      </div>
      <div class="aids-info" aria-live="polite">${nd ? threatInfo(nd) : ''}</div>`;
  }

  function onClick(e) {
    const b = e.target.closest('[data-aid]');
    if (b) { toggle(b.dataset.aid); return true; }
    if (e.target.closest('#aidOpt')) { ctx.S.aidOptions = !ctx.S.aidOptions; renderBar(ctx.node()); return true; }
    return false;
  }
  function onInput(e) {
    const o = e.target.closest?.('[data-opt]');
    if (!o) return false;
    prefs[o.dataset.opt] = o.checked;
    save();
    onChange();
    return true;
  }

  return { prefs, toggle, shapes, weaknesses, renderBar, onClick, onInput, destroy: cancelThreat };
}
