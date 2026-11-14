// Outils d'analyse de position pour les explications : structure de pions, pions passés, cases sûres d'une pièce,
// développement, sécurité du roi, et motifs tactiques repérés le long d'une ligne de coups (surcharge, pièce piégée).
import { Chess } from 'chess.js';

export const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
const FILES = 'abcdefgh';
const other = (c) => (c === 'w' ? 'b' : 'w');
export const fileOf = (sq) => sq[0];
export const rankOf = (sq) => Number(sq[1]);
/** Rangée vue du camp `color` : 1 = sa première rangée, 8 = la rangée de promotion. */
export const relRank = (sq, color) => (color === 'w' ? rankOf(sq) : 9 - rankOf(sq));

export function piecesOf(chess, color, type = null) {
  const out = [];
  for (const row of chess.board()) for (const p of row) if (p && p.color === color && (!type || p.type === type)) out.push(p);
  return out;
}

// ---- structure de pions -------------------------------------------------------------------------

/** Pions isolés (aucun pion du même camp sur les colonnes voisines) et colonnes à pions doublés. */
export function pawnWeaknesses(chess, color) {
  const pawns = piecesOf(chess, color, 'p').map((p) => p.square);
  const byFile = new Map();
  for (const sq of pawns) byFile.set(fileOf(sq), (byFile.get(fileOf(sq)) ?? 0) + 1);
  const isolated = pawns.filter((sq) => {
    const f = FILES.indexOf(fileOf(sq));
    return !byFile.get(FILES[f - 1]) && !byFile.get(FILES[f + 1]);
  });
  const doubled = [...byFile.entries()].filter(([, n]) => n >= 2).map(([f]) => f);
  return { isolated, doubled, count: isolated.length + doubled.length };
}

/** Pions passés du camp `color` : aucun pion adverse devant eux, sur leur colonne ou les colonnes voisines. */
export function passedPawns(chess, color) {
  const enemy = piecesOf(chess, other(color), 'p').map((p) => p.square);
  return piecesOf(chess, color, 'p').map((p) => p.square).filter((sq) => {
    const f = FILES.indexOf(fileOf(sq));
    return !enemy.some((e) => Math.abs(FILES.indexOf(fileOf(e)) - f) <= 1 && relRank(e, color) > relRank(sq, color));
  });
}

// ---- mobilité ---------------------------------------------------------------------------------

/** La case est-elle dangereuse pour une pièce de valeur `value` du camp `color` ? (attaquée par moins fort, ou attaquée et non défendue) */
function unsafe(chess, sq, color, value) {
  const attackers = chess.attackers(sq, other(color));
  if (!attackers.length) return false;
  if (attackers.some((a) => VALUE[chess.get(a).type] < value)) return true;
  return chess.attackers(sq, color).length === 0;
}

/** Cases sûres où la pièce en `sq` peut aller (le trait doit être à son camp). */
export function safeSquares(chess, sq) {
  const p = chess.get(sq);
  if (!p) return [];
  const out = [];
  for (const m of chess.moves({ square: sq, verbose: true })) {
    chess.move(m);
    const ok = !unsafe(chess, m.to, p.color, VALUE[p.type]) || (m.captured && VALUE[m.captured] >= VALUE[p.type]);
    chess.undo();
    if (ok) out.push(m.to);
  }
  return out;
}

/** Même question, quel que soit le camp au trait (on donne le trait au propriétaire de la pièce). */
export function safeSquaresAnyTurn(fen, sq) {
  const c = new Chess(fen);
  const p = c.get(sq);
  if (!p) return [];
  if (c.turn() !== p.color) {
    const parts = fen.split(' ');
    parts[1] = p.color;
    parts[3] = '-';
    try { return safeSquares(new Chess(parts.join(' ')), sq); } catch { return []; }
  }
  return safeSquares(c, sq);
}

// ---- ouverture et roi --------------------------------------------------------------------------

const MINOR_HOME = { w: { b1: 'n', g1: 'n', c1: 'b', f1: 'b' }, b: { b8: 'n', g8: 'n', c8: 'b', f8: 'b' } };
/** Pièces mineures encore sur leur case de départ. */
export function undeveloped(chess, color) {
  return Object.entries(MINOR_HOME[color]).filter(([sq, t]) => {
    const p = chess.get(sq);
    return p && p.color === color && p.type === t;
  }).map(([sq, t]) => ({ square: sq, type: t }));
}
export const isHomeMinor = (color, sq, type) => MINOR_HOME[color][sq] === type;

/** Droits de roque du camp `color` : '' (aucun), 'K', 'Q' ou 'KQ'. */
export function castlingRights(fen, color) {
  const r = (fen.split(' ')[2] ?? '').replace(/[^KQkq]/g, '');
  return color === 'w' ? r.replace(/[a-z]/g, '') : r.replace(/[A-Z]/g, '').toUpperCase();
}

export function kingSquare(chess, color) {
  return piecesOf(chess, color, 'k')[0]?.square ?? null;
}

/** Distance (en coups de roi) entre le roi et le centre (d4, e4, d5, e5). */
export function centerDistance(sq) {
  const x = FILES.indexOf(fileOf(sq));
  const y = rankOf(sq) - 1;
  return Math.max(Math.max(3 - x, x - 4, 0), Math.max(3 - y, y - 4, 0));
}

/** Nombre d'attaques adverses sur le roi du camp `color` et les cases qui l'entourent. */
export function kingZonePressure(chess, color) {
  const k = kingSquare(chess, color);
  if (!k) return 0;
  const x = FILES.indexOf(fileOf(k));
  const y = rankOf(k);
  let n = 0;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const fx = x + dx;
      const ry = y + dy;
      if (fx < 0 || fx > 7 || ry < 1 || ry > 8) continue;
      n += chess.attackers(`${FILES[fx]}${ry}`, other(color)).length;
    }
  }
  return n;
}

/** Case au bord de l'échiquier (colonne a ou h, première ou dernière rangée). */
export const onEdge = (sq) => 'ah'.includes(fileOf(sq)) || rankOf(sq) === 1 || rankOf(sq) === 8;

/** Pièces (hors rois et pions) encore sur l'échiquier. */
export function pieceCountNoPawns(chess) {
  let n = 0;
  for (const row of chess.board()) for (const p of row) if (p && p.type !== 'p' && p.type !== 'k') n++;
  return n;
}

// ---- motifs le long d'une ligne ----------------------------------------------------------------

/**
 * Surcharge : à l'indice j, le camp S prend sur la case t ; le défenseur D de t venait (indice j-1) de reprendre
 * ailleurs, sur la case où S avait pris (indice j-2). D ne pouvait pas défendre les deux cases.
 * line : sortie de pvDetails (avec fenBefore / fenAfter / uci).
 */
export function overloadAt(line, j) {
  if (j < 2) return null;
  const take = new Chess(line[j].fenBefore).move(line[j].san);
  const recapture = new Chess(line[j - 1].fenBefore).move(line[j - 1].san);
  const deflect = new Chess(line[j - 2].fenBefore).move(line[j - 2].san);
  if (!take?.captured || !recapture?.captured || !deflect?.captured) return null;
  if (recapture.to !== deflect.to || take.to === recapture.to) return null;
  // Avant de reprendre, D défendait la case t.
  const before = new Chess(line[j - 1].fenBefore);
  if (!before.attackers(take.to, recapture.color).includes(recapture.from)) return null;
  return { kind: 'overload', defender: { type: recapture.piece, square: recapture.from }, squares: [recapture.to, take.to], captured: take.captured };
}

/**
 * Clouage absolu : la pièce en `sq` est entre son roi et une pièce adverse à longue portée.
 * Renvoie { square, type } de la pièce qui cloue, ou null.
 */
export function pinnedBy(chess, sq) {
  const p = chess.get(sq);
  if (!p || p.type === 'k') return null;
  const k = kingSquare(chess, p.color);
  if (!k) return null;
  const [kx, ky] = [FILES.indexOf(fileOf(k)), rankOf(k)];
  const [px, py] = [FILES.indexOf(fileOf(sq)), rankOf(sq)];
  const dx = Math.sign(px - kx);
  const dy = Math.sign(py - ky);
  if ((px - kx !== 0 && py - ky !== 0 && Math.abs(px - kx) !== Math.abs(py - ky)) || (dx === 0 && dy === 0)) return null;
  // Rien entre le roi et la pièce.
  for (let x = kx + dx, y = ky + dy; x !== px || y !== py; x += dx, y += dy) if (chess.get(`${FILES[x]}${y}`)) return null;
  for (let x = px + dx, y = py + dy; x >= 0 && x < 8 && y >= 1 && y <= 8; x += dx, y += dy) {
    const q = chess.get(`${FILES[x]}${y}`);
    if (!q) continue;
    const diagonal = dx !== 0 && dy !== 0;
    if (q.color !== p.color && (q.type === 'q' || q.type === (diagonal ? 'b' : 'r'))) return { square: `${FILES[x]}${y}`, type: q.type };
    return null;
  }
  return null;
}

/**
 * Pièce piégée : à l'indice j, le camp S prend la pièce P (valeur ≥ 3) ; juste avant le coup précédent de son camp,
 * P était attaquée et n'avait aucune case sûre.
 */
export function trappedAt(line, j) {
  if (j < 1) return null;
  const take = new Chess(line[j].fenBefore).move(line[j].san);
  if (!take?.captured || VALUE[take.captured] < 3) return null;
  const sq = take.to;
  const prev = line[j - 1];
  const prevMove = new Chess(prev.fenBefore).move(prev.san);
  if (prevMove.to === sq) return null; // la pièce venait d'arriver : simple pièce en prise
  const c = new Chess(prev.fenBefore);
  const p = c.get(sq);
  if (!p || p.type !== take.captured) return null;
  if (!c.attackers(sq, take.color).length) return null;
  if (safeSquaresAnyTurn(prev.fenBefore, sq).length > 0) return null;
  // Une pièce clouée sur son roi n'est pas « piégée » : c'est un clouage.
  const pin = pinnedBy(c, sq);
  if (pin) return { kind: 'pin', piece: pin.type, square: pin.square, pinned: { type: p.type, square: sq }, behind: { type: 'k', square: kingSquare(c, p.color) } };
  return { kind: 'trapped', piece: { type: p.type, square: sq } };
}
