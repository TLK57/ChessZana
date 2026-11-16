// Aide « Menace » : ligne d'information sous la barre des aides, et message quand le calcul n'a pas pu se faire.
// Module sans lien avec la page (testé par test/threat.test.js).
import { esc, fig, fmtPct } from './util.js';

const PIECE = { p: 'un pion', n: 'un cavalier', b: 'un fou', r: 'une tour', q: 'la dame' };
const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9 };

export const RESTART_MESSAGE = 'Relancez l\'appli pour activer la menace.';

/**
 * Échec de la demande au serveur (status HTTP, réponse JSON). 404 : le serveur ne connaît pas cette aide, il a été
 * lancé avant la mise à jour qui l'a ajoutée (les pages, elles, sont relues à chaque fois) : il faut le relancer.
 */
export function threatError(status, body) {
  if (status === 404) return { restart: true, error: RESTART_MESSAGE };
  return { error: body?.error || `erreur ${status}` };
}

/** « un pion », « une tour »… si la prise gagne exactement la pièce prise ; sinon le nombre de points. */
function materialText(t) {
  if (t.captured && VALUE[t.captured] === t.material) return PIECE[t.captured];
  return `${t.material} point${t.material > 1 ? 's' : ''} de matériel`;
}

/** Texte (HTML) de la ligne d'information : t = réponse du serveur pour la position affichée, ou undefined. */
export function threatInfo(t) {
  if (!t) return '<span class="spinner"></span> Calcul de la menace…';
  if (t.restart) return `<b class="aid-threat-txt">${esc(RESTART_MESSAGE)}</b> Fermez la fenêtre noire de l'application, puis rouvrez-la avec le fichier « Lancer ».`;
  if (t.error) return `Menace indisponible : ${esc(t.error)}`;
  if (t.reason === 'check') return 'Pas de menace calculée : le camp au trait est en échec.';
  if (!t.threat) return 'Pas de menace sérieuse.';
  const x = t.threat;
  const who = x.color === 'w' ? 'les Blancs' : 'les Noirs';
  const head = `<b class="aid-threat-txt">Menace</b> : ${esc(fig(x.san ?? x.uci))}`;
  if (x.mate) return `${head} (mat en ${x.mate} pour ${who} s'ils jouaient maintenant).`;
  if (x.by === 'material') return `${head} (${who} gagneraient ${materialText(x)} s'ils jouaient maintenant).`;
  return `${head} (+${fmtPct(x.gain, 0)} points de chances de gain pour ${who} s'ils jouaient maintenant).`;
}
