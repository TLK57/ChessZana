// Faiblesses d'une position, sans moteur (aide « Faiblesses » de l'échiquier) : pièces en prise. Le module ne dépend
// de rien : il reçoit une position chess.js (navigateur ou tests).
//
// Règles (simples, comme un coup d'œil de joueur ; les clouages et les rayons X ne sont pas pris en compte) :
//  - en prise : pièce attaquée, et soit non défendue, soit attaquée plus souvent qu'elle n'est défendue, soit
//    attaquée par une pièce de moindre valeur (un pion qui attaque un cavalier défendu le gagne quand même).
// Le roi n'est jamais compté (l'échec est déjà signalé par l'échiquier).

export const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
const NAMES = { p: ['Pion', ''], n: ['Cavalier', ''], b: ['Fou', ''], r: ['Tour', 'e'], q: ['Dame', 'e'], k: ['Roi', ''] };
const LOWER = { p: 'un pion', n: 'un cavalier', b: 'un fou', r: 'une tour', q: 'une dame', k: 'le roi' };

/** Phrase d'explication, par ex. « Cavalier en prise : attaqué 2 fois, défendu 1 fois ». */
export function weaknessText(w) {
  const [name, e] = NAMES[w.type];
  const times = (n) => (n === 1 ? '1 fois' : `${n} fois`);
  const parts = [`attaqué${e} ${times(w.attackers)}`, w.defenders ? `défendu${e} ${times(w.defenders)}` : `non défendu${e}`];
  if (w.lowerAttacker) parts.push(`dont par ${LOWER[w.lowerAttacker]}, de moindre valeur`);
  return `${name} en prise : ${parts.join(', ')}`;
}

/**
 * Faiblesses des pièces des camps demandés (colors : ['w'], ['b'] ou les deux).
 * Renvoie [{ square, color, type, kind: 'hanging', attackers, defenders, lowerAttacker, text }].
 */
export function findWeaknesses(chess, colors = ['w', 'b']) {
  const out = [];
  for (const row of chess.board()) {
    for (const p of row) {
      if (!p || p.type === 'k' || !colors.includes(p.color)) continue;
      const enemy = p.color === 'w' ? 'b' : 'w';
      const attackers = chess.attackers(p.square, enemy);
      const defenders = chess.attackers(p.square, p.color);
      const value = PIECE_VALUES[p.type];
      const lower = attackers.map((sq) => chess.get(sq).type).filter((t) => PIECE_VALUES[t] < value)
        .sort((a, b) => PIECE_VALUES[a] - PIECE_VALUES[b])[0] ?? null;
      if (!attackers.length || (defenders.length && attackers.length <= defenders.length && !lower)) continue;
      const w = { square: p.square, color: p.color, type: p.type, kind: 'hanging', attackers: attackers.length, defenders: defenders.length, lowerAttacker: lower };
      out.push({ ...w, text: weaknessText(w) });
    }
  }
  return out;
}
