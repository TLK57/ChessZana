// Faiblesses d'une position, sans moteur (aide « Faiblesses » de l'échiquier) : pièces en prise. Le module ne dépend
// de rien : il reçoit une position chess.js (navigateur ou tests).
//
// « En prise » = l'adversaire gagne du matériel en prenant la pièce, d'après un calcul d'échange sur sa case (« SEE »,
// comme dans les moteurs d'échecs) :
//  - chaque camp prend, puis reprend, toujours avec sa pièce la moins chère (pion 1, cavalier 3, fou 3, tour 5,
//    dame 9) ; le roi ne reprend que si la case n'est plus attaquée ensuite ;
//  - chaque camp peut arrêter l'échange quand continuer lui ferait perdre ;
//  - rayons X : quand une pièce prend, celle qui était derrière elle sur la même ligne entre dans l'échange (tour ou
//    dame derrière une tour ou une dame ; fou ou dame derrière un fou, une dame ou un pion, en diagonale) ;
//  - clouages : une pièce clouée sur son roi ne peut ni prendre ni reprendre, sauf le long de la ligne du clouage
//    (plus généralement, aucune prise ne peut laisser son roi en échec : cela couvre aussi l'échec à la découverte
//    donné au milieu de l'échange).
// La pièce est marquée seulement si l'échange rapporte du matériel à l'adversaire (résultat > 0).
// Le roi n'est jamais marqué (l'échec est déjà signalé par l'échiquier). Non prise en compte : la prise en passant.

export const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
const NAMES = { p: 'Pion', n: 'Cavalier', b: 'Fou', r: 'Tour', q: 'Dame', k: 'Roi' };
const WON = { p: 'un pion', n: 'un cavalier', b: 'un fou', r: 'une tour', q: 'la dame' };
const LETTER = { n: 'C', b: 'F', r: 'T', q: 'D', k: 'R' }; // notation française

const other = (c) => (c === 'w' ? 'b' : 'w');
const ORTHO = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const LINES = [...ORTHO, ...DIAG];
const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];

const xy = (sq) => [sq.charCodeAt(0) - 97, Number(sq[1]) - 1];
const name = (x, y) => (x >= 0 && x < 8 && y >= 0 && y < 8 ? String.fromCharCode(97 + x) + (y + 1) : null);
/** La pièce `type` se déplace-t-elle le long de la direction (dx, dy) ? (tour : lignes droites ; fou : diagonales) */
const slides = (type, dx, dy) => type === 'q' || type === (dx && dy ? 'b' : 'r');

/** Plateau : Map case → { type, color }. */
export function boardOf(chess) {
  const b = new Map();
  for (const row of chess.board()) for (const p of row) if (p) b.set(p.square, { type: p.type, color: p.color });
  return b;
}

/** Plateau après le déplacement de la pièce de `from` vers `to` (en `type` si elle est promue). */
function moved(board, from, to, type = board.get(from).type) {
  const b = new Map(board);
  const p = b.get(from);
  b.delete(from);
  b.set(to, { type, color: p.color });
  return b;
}

/** Les `n` premières pièces rencontrées depuis `sq` dans la direction (dx, dy) : [{ square, piece }]. */
function ray(board, sq, dx, dy, n = 1) {
  const out = [];
  let [x, y] = xy(sq);
  for (;;) {
    x += dx;
    y += dy;
    const s = name(x, y);
    if (!s) return out;
    const p = board.get(s);
    if (p) {
      out.push({ square: s, piece: p });
      if (out.length === n) return out;
    }
  }
}

/** Cases des pièces du camp `color` qui attaquent `sq` directement (sans tenir compte des clouages). */
export function attackersOf(board, sq, color) {
  const [x, y] = xy(sq);
  const out = [];
  const is = (s, type) => {
    const p = s && board.get(s);
    return Boolean(p && p.color === color && p.type === type);
  };
  const behind = color === 'w' ? -1 : 1; // un pion blanc attaque en montant : il est une rangée plus bas
  for (const dx of [-1, 1]) {
    const s = name(x + dx, y + behind);
    if (is(s, 'p')) out.push(s);
  }
  for (const [dx, dy] of KNIGHT) {
    const s = name(x + dx, y + dy);
    if (is(s, 'n')) out.push(s);
  }
  for (const [dx, dy] of LINES) {
    const s = name(x + dx, y + dy);
    if (is(s, 'k')) out.push(s);
    const [hit] = ray(board, sq, dx, dy);
    if (hit && hit.piece.color === color && slides(hit.piece.type, dx, dy)) out.push(hit.square);
  }
  return out;
}

const kingOf = (board, color) => [...board].find(([, p]) => p.type === 'k' && p.color === color)?.[0] ?? null;

/**
 * Pièces du camp `color` qui peuvent prendre sur `sq`, de la moins chère à la plus chère. Une prise qui laisserait
 * son propre roi attaqué est interdite : une pièce clouée sur son roi ne prend que le long du clouage, le roi ne prend
 * que si la case n'est plus attaquée ensuite, et on ne reprend pas en ignorant un échec à la découverte.
 * ignore : cases des pièces qui donnaient déjà échec à ce camp avant l'échange (il y répondra d'abord : on regarde
 * ce que l'échange lui coûterait ensuite).
 */
function capturers(board, sq, color, ignore = null) {
  const king = kingOf(board, color);
  return attackersOf(board, sq, color)
    .filter((s) => {
      if (s === king) return !attackersOf(moved(board, s, sq), sq, other(color)).length;
      return !king || attackersOf(moved(board, s, sq), king, other(color)).every((a) => ignore?.has(a));
    })
    .sort((a, b) => PIECE_VALUES[board.get(a).type] - PIECE_VALUES[board.get(b).type]);
}

/**
 * Échange sur la case `sq` (occupée par une pièce de l'autre camp) : matériel que le camp `side` gagne au mieux en
 * y prenant, reprises comprises ; 0 s'il ne peut pas prendre ou s'il y perdrait.
 * Renvoie { gain, line } : line = les prises successives jusqu'au bout [{ from, type, color, promotion }].
 */
export function exchangeOn(board, sq, side) {
  const defender = other(side);
  const king = kingOf(board, defender);
  const checks = new Set(king ? attackersOf(board, king, side) : []); // échecs déjà donnés au camp qui défend
  let b = board;
  let onSq = b.get(sq).type;
  const won = []; // matériel pris à chaque prise
  const line = [];
  for (let s = side; ; s = other(s)) {
    const [from] = capturers(b, sq, s, s === defender ? checks : null);
    if (!from) break;
    const type = b.get(from).type;
    const promotion = type === 'p' && (sq[1] === '8' || sq[1] === '1');
    won.push(PIECE_VALUES[onSq] + (promotion ? PIECE_VALUES.q - PIECE_VALUES.p : 0));
    line.push({ from, type, color: s, promotion });
    onSq = promotion ? 'q' : type;
    b = moved(b, from, sq, onSq);
  }
  // En remontant depuis la dernière prise : chaque camp ne prend que si la suite lui rapporte (s'arrêter vaut 0).
  let net = 0;
  for (let i = won.length - 1; i >= 0; i--) net = won[i] - Math.max(0, net);
  return { gain: won.length ? Math.max(0, net) : 0, line };
}

/** Première prise de l'échange en notation française : « Txc4 », « exf3 », « Tdxd4 » (deux tours peuvent prendre). */
function captureSan(board, sq, first) {
  if (first.type === 'p') return `${first.from[0]}x${sq}${first.promotion ? '=D' : ''}`;
  const twins = capturers(board, sq, first.color).filter((s) => s !== first.from && board.get(s).type === first.type);
  let which = '';
  if (twins.length) {
    if (!twins.some((s) => s[0] === first.from[0])) which = first.from[0];
    else if (!twins.some((s) => s[1] === first.from[1])) which = first.from[1];
    else which = first.from;
  }
  return `${LETTER[first.type]}${which}x${sq}`;
}

/** « Pion en prise : Txc4 gagne un pion », ou « Cavalier en prise : échange perdant (−2) ». */
export function hangingText(type, gain, san) {
  if (gain >= PIECE_VALUES[type]) return `${NAMES[type]} en prise : ${san} gagne ${WON[type]}`;
  return `${NAMES[type]} en prise : échange perdant (−${gain})`;
}

/**
 * Faiblesses des pièces des camps demandés (colors : ['w'], ['b'] ou les deux).
 * Renvoie [{ square, color, type, kind: 'hanging', gain, capture, text }] : gain = matériel perdu au bout de
 * l'échange ; capture = la première prise adverse.
 */
export function findWeaknesses(chess, colors = ['w', 'b']) {
  const board = boardOf(chess);
  const out = [];
  for (const [square, p] of board) {
    if (p.type === 'k' || !colors.includes(p.color)) continue;
    const { gain, line } = exchangeOn(board, square, other(p.color));
    if (gain <= 0) continue;
    const capture = captureSan(board, square, line[0]);
    out.push({ square, color: p.color, type: p.type, kind: 'hanging', gain, capture, text: hangingText(p.type, gain, capture) });
  }
  return out;
}
