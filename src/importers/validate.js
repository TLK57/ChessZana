// Contrôle du format des réponses de chess.com et de Lichess. Une réponse inattendue (champ manquant, mauvais type…)
// ne fait pas planter l'import : la partie ou le mois concerné est ignoré, avec un message clair en français,
// et l'import continue avec la suite.

const isStr = (x) => typeof x === 'string' && x.trim() !== '';
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const SIDE = { white: 'des Blancs', black: 'des Noirs' };

/** Problèmes rencontrés pendant un import : regroupés par message, avec un compteur. */
export class Problems {
  constructor() { this.byMessage = new Map(); }

  add(message) { this.byMessage.set(message, (this.byMessage.get(message) ?? 0) + 1); }

  get count() { let n = 0; for (const v of this.byMessage.values()) n += v; return n; }

  list() { return [...this.byMessage.entries()].map(([message, count]) => ({ message, count })); }

  /** « 3 éléments ignorés (format inattendu) : champ « pgn » absent (2) ; … » ou chaîne vide. */
  summary() {
    if (!this.count) return '';
    const parts = this.list().slice(0, 4).map((p) => `${p.message}${p.count > 1 ? ` (${p.count})` : ''}`);
    return `${this.count} élément${this.count > 1 ? 's' : ''} ignoré${this.count > 1 ? 's' : ''} (format inattendu) : ${parts.join(' ; ')}${this.byMessage.size > 4 ? ' ; …' : ''}`;
  }
}

// ---- chess.com -------------------------------------------------------------------------------

/** Profil chess.com : un objet ; le pseudo officiel est facultatif (on garde celui tapé). */
export function checkChessComProfile(json) {
  if (!isObj(json)) return 'chess.com a renvoyé un profil illisible (ce n\'est pas un objet JSON).';
  if (json.username != null && !isStr(json.username)) return 'chess.com a renvoyé un profil sans pseudo valide.';
  return null;
}

/** Liste des archives mensuelles : { archives: [url…] }. Renvoie { error } ou { urls, invalid }. */
export function checkChessComArchives(json) {
  if (!isObj(json) || !Array.isArray(json.archives)) {
    return { error: 'chess.com a renvoyé une liste des mois illisible (champ « archives » absent ou qui n\'est pas une liste).' };
  }
  const urls = [];
  let invalid = 0;
  for (const u of json.archives) {
    if (isStr(u) && /\/games\/\d{4}\/\d{2}\/?$/.test(u)) urls.push(u); else invalid++;
  }
  return { urls, invalid };
}

/** Mois d'archives : { games: [...] }. */
export function checkChessComMonth(json) {
  if (!isObj(json) || !Array.isArray(json.games)) return 'réponse illisible (champ « games » absent ou qui n\'est pas une liste)';
  return null;
}

/** Une partie d'archive chess.com. Renvoie null si elle est exploitable, sinon la raison. */
export function checkChessComGame(g) {
  if (!isObj(g)) return 'partie illisible (ce n\'est pas un objet)';
  if (!isStr(g.pgn)) return 'partie sans PGN (champ « pgn » absent)';
  if (!isNum(g.end_time)) return 'partie sans date de fin (champ « end_time » absent ou invalide)';
  for (const side of ['white', 'black']) {
    if (!isObj(g[side]) || !isStr(g[side].username)) return `partie sans pseudo ${SIDE[side]} (champ « ${side}.username » absent)`;
  }
  if (!isStr(g.uuid) && !isStr(g.url)) return 'partie sans identifiant (champs « uuid » et « url » absents)';
  return null;
}

// ---- Lichess --------------------------------------------------------------------------------

export function checkLichessUser(json) {
  if (!isObj(json)) return 'Lichess a renvoyé un profil illisible (ce n\'est pas un objet JSON).';
  if (json.username != null && !isStr(json.username)) return 'Lichess a renvoyé un profil sans pseudo valide.';
  return null;
}

/** Une partie de l'export NDJSON de Lichess. */
export function checkLichessGame(g) {
  if (!isObj(g)) return 'partie illisible (ce n\'est pas un objet)';
  if (!isStr(g.id)) return 'partie sans identifiant (champ « id » absent)';
  if (!isStr(g.variant)) return 'partie sans variante (champ « variant » absent)';
  if (!isObj(g.players) || !isObj(g.players.white) || !isObj(g.players.black)) return 'partie sans joueurs (champ « players » absent ou incomplet)';
  if (!isStr(g.pgn)) return 'partie sans PGN (champ « pgn » absent)';
  if (g.createdAt != null && !isNum(g.createdAt)) return 'partie avec une date de création invalide (champ « createdAt »)';
  if (g.lastMoveAt != null && !isNum(g.lastMoveAt)) return 'partie avec une date de fin invalide (champ « lastMoveAt »)';
  return null;
}
