// Explications en français des coups ratés, générées par des règles, à partir de la position
// et des lignes de Stockfish : pièce en prise, gain de matériel, fourchette, clouage, enfilade,
// attaque à la découverte, mat raté / subi, finale gagnante gâchée.
import { Chess } from 'chess.js';
import { materialDeltas } from './classify.js';
import { playUci, moveToUci } from '../chessutil.js';

const NAMES = { p: 'pion', n: 'cavalier', b: 'fou', r: 'tour', q: 'dame', k: 'roi' };
const FEMININE = new Set(['r', 'q']);
const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
const FIGURINES = { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘' };

const BAD = new Set(['inaccuracy', 'mistake', 'blunder', 'miss']);

// Types d'erreurs (étape 3 : « mes erreurs récurrentes »), du plus grave au moins grave.
export const ERROR_TYPES = {
  mate_allowed: 'Mat adverse permis',
  mate_missed: 'Mat manqué',
  endgame_spoiled: 'Finale gagnante gâchée',
  endgame_draw_lost: 'Finale nulle perdue',
  hanging_piece: 'Pièce laissée en prise ou mal défendue',
  allowed_fork: 'Fourchette adverse permise',
  allowed_pin: 'Clouage adverse permis',
  allowed_skewer: 'Enfilade adverse permise',
  allowed_discovered: 'Attaque à la découverte permise',
  missed_fork: 'Fourchette ratée',
  missed_pin: 'Clouage raté',
  missed_skewer: 'Enfilade ratée',
  missed_discovered: 'Attaque à la découverte ratée',
  missed_capture: 'Prise gagnante ratée',
  missed_material: 'Gain de matériel raté',
  material_loss: 'Matériel perdu quelques coups plus loin',
  unpunished: 'Erreur adverse non punie',
  positional: 'Erreur de position (pas de tactique simple)',
};
const TYPE_ORDER = Object.keys(ERROR_TYPES);

export const fig = (san) => String(san ?? '').replace(/[KQRBN]/g, (c) => FIGURINES[c]);
const e = (t) => (FEMININE.has(t) ? 'e' : ''); // accord : défendu / défendue
const theP = (t) => `${FEMININE.has(t) ? 'la' : 'le'} ${NAMES[t]}`;
const side = (c) => (c === 'w' ? 'Blancs' : 'Noirs');

/**
 * Manière de s'adresser au joueur : « vous / votre fou / son fou » quand le coup est le sien,
 * sinon par couleur (« les Noirs / le fou noir / la dame blanche »).
 */
export function makeVoice(you, mover) {
  const opp = mover === 'w' ? 'b' : 'w';
  const adj = (t, c) => (c === 'w' ? (FEMININE.has(t) ? 'blanche' : 'blanc') : (FEMININE.has(t) ? 'noire' : 'noir'));
  return {
    mover, opp,
    piece: (t, c) => (you
      ? (c === mover ? `votre ${NAMES[t]}` : `${FEMININE.has(t) ? 'sa' : 'son'} ${NAMES[t]}`)
      : `${theP(t)} ${adj(t, c)}`),
    king: (c) => (you ? (c === mover ? 'votre roi' : 'son roi') : `le roi ${c === 'w' ? 'blanc' : 'noir'}`),
    toOpponent: you ? "à l'adversaire" : `aux ${side(opp)}`,
    opponentReplies: you ? "l'adversaire répond" : `les ${side(opp)} répondent`,
    lose: you ? 'vous perdez' : `les ${side(mover)} perdent`,
    makesLose: you ? 'vous fait perdre' : `fait perdre aux ${side(mover)}`,
    hadMate: (n) => (you ? `Vous aviez un mat en ${n}` : `Les ${side(mover)} avaient un mat en ${n}`),
    couldWin: you ? 'vous pouviez gagner' : `les ${side(mover)} pouvaient gagner`,
    opponentErred: you
      ? 'Votre adversaire venait de commettre une erreur, et ce coup ne la punit pas.'
      : `Les ${side(opp)} venaient de commettre une erreur, et ce coup ne la punit pas.`,
  };
}

export function materialText(n) {
  if (n <= 1) return 'un pion';
  if (n === 2) return "l'équivalent de deux pions";
  if (n <= 4) return `l'équivalent d'une pièce (${n} points)`;
  if (n <= 6) return `l'équivalent d'une tour (${n} points)`;
  if (n <= 8) return `${n} points de matériel`;
  return `l'équivalent d'une dame ou plus (${n} points)`;
}

// Ligne de coups UCI -> liste détaillée (SAN, FEN avant/après) jouable sur l'échiquier.
export function pvDetails(fen, pv, max = 12) {
  const c = new Chess(fen);
  const out = [];
  for (const u of (pv ?? []).slice(0, max)) {
    const fenBefore = c.fen();
    const m = playUci(c, u);
    if (!m) break;
    out.push({ san: m.san, uci: moveToUci(m), color: m.color, moveNumber: Number(fenBefore.split(' ')[5]), fenBefore, fenAfter: c.fen() });
  }
  return out;
}

export function formatLine(items, { figurines = true } = {}) {
  return items.map((m, i) => {
    const san = figurines ? fig(m.san) : m.san;
    if (m.color === 'w') return `${m.moveNumber}. ${san}`;
    return i === 0 ? `${m.moveNumber}... ${san}` : san;
  }).join(' ');
}

// --- géométrie de l'échiquier -----------------------------------------------------------

const xy = (sq) => [sq.charCodeAt(0) - 97, Number(sq[1]) - 1];
const sqName = (x, y) => String.fromCharCode(97 + x) + (y + 1);
const inside = (x, y) => x >= 0 && x < 8 && y >= 0 && y < 8;
const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ORTHO = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const rays = (t) => (t === 'b' ? DIAG : t === 'r' ? ORTHO : t === 'q' ? [...DIAG, ...ORTHO] : []);

function* walk(from, [dx, dy]) {
  let [x, y] = xy(from);
  for (;;) {
    x += dx; y += dy;
    if (!inside(x, y)) return;
    yield sqName(x, y);
  }
}

function enemySquares(chess, color) {
  const out = [];
  for (const row of chess.board()) for (const p of row) if (p && p.color !== color) out.push(p.square);
  return out;
}

// Cibles « intéressantes » attaquées par la pièce en `sq` : le roi (échec), une pièce plus forte, ou une pièce non défendue.
function worthyTargets(chess, sq) {
  const p = chess.get(sq);
  if (!p) return [];
  const enemy = p.color === 'w' ? 'b' : 'w';
  const out = [];
  for (const t of enemySquares(chess, p.color)) {
    if (!chess.attackers(t, p.color).includes(sq)) continue;
    const tp = chess.get(t);
    const undefended = chess.attackers(t, enemy).length === 0;
    if (tp.type === 'k' || VALUE[tp.type] > VALUE[p.type] || (undefended && tp.type !== 'p') || (undefended && p.type === 'p')) {
      out.push({ square: t, type: tp.type, undefended });
    }
  }
  return out;
}

function describeTarget(t, color, voice) {
  return t.type === 'k' ? voice.king(color) : `${voice.piece(t.type, color)} en ${t.square}`;
}

/**
 * Motifs tactiques d'un coup joué dans `fen` (fourchette, clouage, enfilade, attaque à la découverte).
 */
export function detectMotifs(fen, uci) {
  const c = new Chess(fen);
  const mover = c.turn();
  const from = uci.slice(0, 2);
  const m = playUci(c, uci);
  if (!m) return [];
  const to = m.to;
  const motifs = [];

  // Fourchette : la pièce jouée attaque au moins deux cibles intéressantes.
  const targets = worthyTargets(c, to);
  if (targets.length >= 2) motifs.push({ kind: 'fork', piece: m.piece, square: to, targets });

  // Clouage / enfilade par une pièce à longue portée.
  for (const dir of rays(m.piece)) {
    let first = null;
    for (const s of walk(to, dir)) {
      const p = c.get(s);
      if (!p) continue;
      if (!first) {
        if (p.color === mover) break;
        first = { square: s, type: p.type };
        continue;
      }
      if (p.color === mover) break;
      const second = { square: s, type: p.type };
      if (first.type !== 'k' && (second.type === 'k' || VALUE[second.type] > VALUE[first.type])) {
        motifs.push({ kind: 'pin', piece: m.piece, square: to, pinned: first, behind: second });
      } else if ((first.type === 'k' || VALUE[first.type] > VALUE[second.type]) && VALUE[second.type] >= 3) {
        motifs.push({ kind: 'skewer', piece: m.piece, square: to, front: first, behind: second });
      }
      break;
    }
  }

  // Attaque à la découverte : une autre pièce à longue portée, masquée par la pièce jouée, attaque maintenant une cible.
  for (const row of c.board()) {
    for (const p of row) {
      if (!p || p.color !== mover || p.square === to || !['b', 'r', 'q'].includes(p.type)) continue;
      for (const dir of rays(p.type)) {
        let passed = false;
        for (const s of walk(p.square, dir)) {
          if (s === from) { passed = true; continue; }
          const q = c.get(s);
          if (!q) continue;
          if (passed && q.color !== mover && (q.type === 'k' || VALUE[q.type] >= 3)) {
            motifs.push({ kind: 'discovered', piece: p.type, square: p.square, target: { square: s, type: q.type } });
          }
          break;
        }
      }
    }
  }
  return motifs;
}

// Nom du motif et détail, à insérer dans une phrase : « …, une fourchette : votre cavalier attaque… ».
function motifParts(motif, attacker, voice) {
  // attacker : couleur du camp qui joue le motif ; les cibles appartiennent à l'autre camp.
  const pieceOf = (t) => voice.piece(t, attacker);
  const victim = attacker === 'w' ? 'b' : 'w';
  const describe = (t, c) => describeTarget(t, c, voice);
  switch (motif.kind) {
    case 'fork': {
      const [a, b] = motif.targets;
      return { name: 'une fourchette', detail: `${pieceOf(motif.piece)} attaque à la fois ${describe(a, victim)} et ${describe(b, victim)}` };
    }
    case 'pin': {
      const pronoun = FEMININE.has(motif.pinned.type) ? 'elle' : 'il';
      return { name: 'un clouage', detail: `${describe(motif.pinned, victim)} est cloué${e(motif.pinned.type)} : ${pronoun} ne peut plus bouger sans exposer ${describe(motif.behind, victim)}` };
    }
    case 'skewer':
      return { name: 'une enfilade', detail: `${describe(motif.front, victim)} doit s'écarter et ${describe(motif.behind, victim)}, derrière, tombe` };
    case 'discovered':
      return motif.target.type === 'k'
        ? { name: 'un échec à la découverte', detail: `en s'écartant, la pièce démasque ${pieceOf(motif.piece)} en ${motif.square}, qui donne échec` }
        : { name: 'une attaque à la découverte', detail: `en s'écartant, la pièce démasque ${pieceOf(motif.piece)} en ${motif.square}, qui attaque ${describe(motif.target, victim)}` };
    default:
      return null;
  }
}

const MOTIF_ORDER = { fork: 0, discovered: 1, skewer: 2, pin: 3 };
const bestMotif = (motifs) => [...motifs].sort((a, b) => MOTIF_ORDER[a.kind] - MOTIF_ORDER[b.kind])[0] ?? null;

/**
 * Explique un coup.
 * ctx : { fenBefore, playedUci, playedPv, bestPv, evalBest, evalPlayed, classification, you }
 *   you : true si le coup est celui de l'utilisateur (« vous »), false pour parler par couleur (« les Noirs »).
 *   evalBest / evalPlayed : { cp, mate, wdl } du point de vue du joueur qui joue.
 * Renvoie { sentences: [...], bestLine: [...], playedLine: [...] }.
 */
export function explainMove(ctx) {
  const { fenBefore, playedUci, classification } = ctx;
  const bestPv = ctx.bestPv?.length ? ctx.bestPv : [];
  const playedPv = ctx.playedPv?.length ? ctx.playedPv : [playedUci];
  const bestLine = pvDetails(fenBefore, bestPv);
  const playedLine = pvDetails(fenBefore, playedPv);
  const out = { sentences: [], types: [], type: null, bestLine, playedLine };
  if (!BAD.has(classification)) return out;
  const t = out.types;

  const best = bestLine[0];
  const played = playedLine[0];
  if (!played) return out;
  const bestFig = best ? fig(best.san) : null;
  const eb = ctx.evalBest ?? {};
  const ep = ctx.evalPlayed ?? {};
  const s = out.sentences;
  const me = new Chess(fenBefore).turn();
  const v = makeVoice(ctx.you !== false, me);

  if (classification === 'miss') s.push(v.opponentErred);

  // --- 1. Ce que le coup joué a permis ---
  let problem = false;
  if (ep.mate != null && ep.mate < 0 && !(eb.mate != null && eb.mate < 0)) {
    const n = Math.abs(ep.mate);
    const reply = playedLine.slice(1, 1 + 2 * n);
    s.push(`Ce coup permet ${v.toOpponent} de mater en ${n}${reply.length ? ` : ${formatLine(reply)}` : ''}.`);
    t.push('mate_allowed');
    problem = true;
  } else if (eb.wdl && ep.wdl && eb.wdl !== ep.wdl && (eb.wdl === 'win' || eb.wdl === 'draw')) {
    const lost = ep.wdl === 'loss' ? 'perdue' : 'nulle';
    s.push(eb.wdl === 'win'
      ? `Finale gagnante gâchée : la table de finales confirme que ${bestFig} gagnait, alors qu'après ce coup la position est ${lost}.`
      : `La table de finales confirme que ${bestFig} tenait la nulle, alors qu'après ce coup la finale est perdue.`);
    t.push(eb.wdl === 'win' ? 'endgame_spoiled' : 'endgame_draw_lost');
    problem = true;
  } else if (playedLine.length >= 2) {
    const reply = playedLine[1];
    const afterMine = new Chess(playedLine[0].fenAfter);
    const replyMove = new Chess(reply.fenBefore).move(reply.san);
    const deltas = materialDeltas(fenBefore, playedPv, 4);
    const net = deltas.length >= 3 ? Math.max(deltas[1], deltas[2]) : deltas[deltas.length - 1];
    if (replyMove.captured && net <= -1) {
      const defenders = afterMine.attackers(replyMove.to, me).length;
      const cap = replyMove.captured;
      const status = defenders === 0 ? `n'est pas défendu${e(cap)}` : `n'est pas assez défendu${e(cap)}`;
      s.push(`Après ${fig(played.san)}, ${v.piece(cap, me)} en ${replyMove.to} ${status} : ${v.opponentReplies} ${fig(reply.san)} et ${v.lose} ${materialText(-net)}.`);
      t.push('hanging_piece');
      problem = true;
    } else {
      const motif = bestMotif(detectMotifs(reply.fenBefore, reply.uci));
      if (motif && (net <= -1 || ep.mate != null || (ctx.lossPct ?? 0) >= 12)) {
        const mp = motifParts(motif, v.opp, v);
        s.push(`Ce coup permet ${fig(reply.san)}, ${mp.name} : ${mp.detail}.`);
        t.push(`allowed_${motif.kind}`);
        problem = true;
      } else if (net <= -2) {
        s.push(`Après ${fig(played.san)}, la suite ${formatLine(playedLine.slice(0, 4))} ${v.makesLose} ${materialText(-net)}.`);
        t.push('material_loss');
        problem = true;
      }
    }
  }

  // --- 2. Ce que le meilleur coup permettait ---
  if (best && best.uci !== played.uci) {
    if (eb.mate != null && eb.mate > 0 && !(ep.mate != null && ep.mate > 0)) {
      s.push(`${v.hadMate(eb.mate)} : ${formatLine(bestLine.slice(0, 2 * eb.mate - 1))}.`);
      t.push('mate_missed');
    } else if (!(eb.wdl && problem)) {
      const motif = bestMotif(detectMotifs(fenBefore, best.uci));
      const bestDeltas = materialDeltas(fenBefore, bestPv, 4);
      // Matériel gagné après notre coup suivant ET la réponse adverse (pas seulement une prise qui sera reprise).
      const gain = bestDeltas.length ? bestDeltas[Math.min(3, bestDeltas.length - 1)] : 0;
      const bestMove = new Chess(fenBefore).move(best.san);
      if (motif && (gain >= 1 || motif.kind === 'fork' || (eb.mate != null && eb.mate > 0))) {
        const mp = motifParts(motif, me, v);
        s.push(`Il fallait jouer ${bestFig}, ${mp.name} : ${mp.detail}.${gain >= 1 ? ` La suite ${formatLine(bestLine.slice(0, 5))} gagne ${materialText(gain)}.` : ''}`);
        t.push(`missed_${motif.kind}`);
      } else if (bestMove.captured && gain >= 1) {
        const wasUndefended = new Chess(fenBefore).attackers(bestMove.to, me === 'w' ? 'b' : 'w').length === 0;
        s.push(`La prise ${bestFig} gagnait du matériel : elle prend ${v.piece(bestMove.captured, v.opp)} en ${bestMove.to}${wasUndefended ? `, qui n'était pas défendu${e(bestMove.captured)}` : ''} (bilan : ${materialText(gain)}).`);
        t.push('missed_capture');
      } else if (gain >= 2) {
        s.push(`Avec ${bestFig}, ${v.couldWin} ${materialText(gain)} : ${formatLine(bestLine.slice(0, 5))}.`);
        t.push('missed_material');
      }
    }
  }

  // Matériel perdu ou gagné plus loin dans la suite (jusqu'à 10 demi-coups), par exemple un pion
  // ramassé après une manœuvre de cavalier en finale.
  if (!s.length || (s.length === 1 && classification === 'miss')) {
    const lp = longMaterial(fenBefore, playedPv);
    const lb = longMaterial(fenBefore, bestPv);
    if (lp.delta <= -1 && lp.delta < lb.delta) {
      s.push(`Après ${fig(played.san)}, la suite de Stockfish ${formatLine(playedLine.slice(0, lp.plies))} ${v.makesLose} ${materialText(-lp.delta)}.`);
      t.push('material_loss');
    } else if (best && lb.delta >= 1 && lb.delta > lp.delta) {
      s.push(`Avec ${bestFig}, ${v.couldWin} ${materialText(lb.delta)} : ${formatLine(bestLine.slice(0, lb.plies))}.`);
      t.push('missed_material');
    }
  }

  if (!s.length || (s.length === 1 && classification === 'miss')) {
    s.push(`Stockfish préférait ${bestFig ?? 'un autre coup'} : la suite montre pourquoi.`);
  }
  if (!t.length) t.push(classification === 'miss' ? 'unpunished' : 'positional');
  // Type principal : le plus grave des motifs trouvés.
  out.type = [...t].sort((a, b) => TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b))[0];
  return out;
}

// Bilan matériel au bout de la ligne (au plus 10 demi-coups), mesuré après une réponse adverse
// pour ne pas couper un échange en plein milieu.
function longMaterial(fen, pv, maxPlies = 10) {
  const deltas = materialDeltas(fen, pv, maxPlies);
  if (deltas.length < 2) return { delta: 0, plies: 0 };
  let k = Math.min(deltas.length, maxPlies) - 1;
  if (k % 2 === 0) k -= 1; // indices impairs = après la réponse de l'adversaire
  return { delta: deltas[k], plies: k + 1 };
}

export { theP };
