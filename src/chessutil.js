// Petits outils autour de chess.js : FEN normalisée, matériel, conversions UCI.
import { Chess } from 'chess.js';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

// FEN normalisée = placement, trait, roques, prise en passant (sans les compteurs de coups).
// chess.js n'écrit la case en passant que si une prise en passant est réellement possible,
// ce qui évite d'avoir deux FEN différentes pour la même position.
export function normalizeFen(fen) {
  const c = new Chess(fen, { skipValidation: true });
  return c.fen().split(' ').slice(0, 4).join(' ');
}

export function normalizeChessFen(chess) {
  return chess.fen().split(' ').slice(0, 4).join(' ');
}

export function pieceCount(fen) {
  const board = fen.split(' ')[0];
  return (board.match(/[pnbrqk]/gi) || []).length;
}

// Matériel (pions = 1, cavalier/fou = 3, tour = 5, dame = 9) du camp `color` moins celui de l'adversaire.
export function materialBalance(chess, color) {
  let total = 0;
  for (const row of chess.board()) {
    for (const sq of row) {
      if (!sq) continue;
      total += (sq.color === color ? 1 : -1) * VALUES[sq.type];
    }
  }
  return total;
}

export function moveToUci(m) {
  return m.from + m.to + (m.promotion ?? '');
}

// Joue un coup UCI (e2e4, e7e8q). Accepte aussi la notation « roi prend sa tour » (e1h1)
// utilisée par l'analyse cloud de Lichess. Renvoie le coup chess.js ou null s'il est illégal.
export function playUci(chess, uci) {
  if (!uci || uci.length < 4) return null;
  const from = uci.slice(0, 2);
  let to = uci.slice(2, 4);
  const promotion = uci.length > 4 ? uci[4].toLowerCase() : undefined;
  const piece = chess.get(from);
  if (piece && piece.type === 'k') {
    const target = chess.get(to);
    if (target && target.type === 'r' && target.color === piece.color) {
      to = (to[0] > from[0] ? 'g' : 'c') + from[1];
    }
  }
  try {
    return chess.move({ from, to, promotion });
  } catch {
    return null;
  }
}

// Convertit un coup UCI éventuellement « roi prend tour » en UCI standard.
export function canonicalUci(fen, uci) {
  const c = new Chess(fen, { skipValidation: true });
  const m = playUci(c, uci);
  return m ? moveToUci(m) : null;
}

export function uciToSan(fen, uci) {
  try {
    const c = new Chess(fen, { skipValidation: true });
    const m = playUci(c, uci);
    return m ? m.san : null;
  } catch {
    return null;
  }
}

export function terminalState(chess) {
  if (chess.isCheckmate()) return 'checkmate';
  if (chess.isStalemate()) return 'stalemate';
  if (chess.isInsufficientMaterial()) return 'insufficient';
  return null;
}
