// Explications en français des coups ratés, générées par des règles, à partir de la position
// et des lignes de Stockfish : pièce en prise, gain de matériel, fourchette, clouage, enfilade,
// attaque à la découverte, surcharge, pièce piégée (aussi quand le matériel tombe plus loin dans la ligne),
// mat raté / subi, échec perpétuel, finale gagnante gâchée, et règles de position : roi exposé,
// roque perdu ou tardif, pièce non développée, pièce sans retraite, pion isolé ou doublé,
// pion passé adverse laissé avancer, roi passif en finale.
import { Chess } from 'chess.js';
import { materialDeltas } from './classify.js';
import { playUci, moveToUci } from '../chessutil.js';
import {
  castlingRights, centerDistance, isHomeMinor, kingSquare, kingZonePressure, onEdge, overloadAt, passedPawns, pawnWeaknesses,
  pieceCountNoPawns, relRank, safeSquaresAnyTurn, trappedAt, undeveloped,
} from './patterns.js';

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
  perpetual_allowed: 'Nulle par échec perpétuel permise',
  hanging_piece: 'Pièce laissée en prise ou mal défendue',
  allowed_fork: 'Fourchette adverse permise',
  allowed_pin: 'Clouage adverse permis',
  allowed_skewer: 'Enfilade adverse permise',
  allowed_discovered: 'Attaque à la découverte permise',
  allowed_overload: 'Surcharge adverse permise',
  allowed_trapped: 'Pièce piégée',
  missed_fork: 'Fourchette ratée',
  missed_pin: 'Clouage raté',
  missed_skewer: 'Enfilade ratée',
  missed_discovered: 'Attaque à la découverte ratée',
  missed_overload: 'Surcharge ratée',
  missed_trapped: 'Pièce adverse piégeable ratée',
  missed_capture: 'Prise gagnante ratée',
  missed_material: 'Gain de matériel raté',
  material_loss: 'Matériel perdu quelques coups plus loin',
  passed_pawn: 'Pion passé adverse laissé avancer',
  king_exposed: 'Roi exposé',
  castling: 'Roque perdu ou trop tardif',
  development: 'Pièce non développée',
  no_retreat: 'Pièce sans retraite ou mal placée',
  pawn_structure: 'Pion isolé ou doublé créé',
  missed_tempo: 'Pièce adverse non chassée',
  passive_king: 'Roi passif en finale',
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
    had: you ? 'Vous aviez' : `Les ${side(mover)} avaient`,
    have: you ? 'vous avez' : `les ${side(mover)} ont`,
    oppChecks: you ? "l'adversaire enchaîne les échecs" : `les ${side(opp)} enchaînent les échecs`,
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
    case 'overload': {
      const [a, b] = motif.squares;
      return { name: 'une surcharge', detail: `${describe(motif.defender, victim)} ne pouvait pas défendre à la fois ${a} et ${b}` };
    }
    case 'trapped':
      return { name: 'une pièce piégée', detail: `${describe(motif.piece, victim)} n'avait plus aucune case sûre` };
    case 'discovered':
      return motif.target.type === 'k'
        ? { name: 'un échec à la découverte', detail: `en s'écartant, la pièce démasque ${pieceOf(motif.piece)} en ${motif.square}, qui donne échec` }
        : { name: 'une attaque à la découverte', detail: `en s'écartant, la pièce démasque ${pieceOf(motif.piece)} en ${motif.square}, qui attaque ${describe(motif.target, victim)}` };
    default:
      return null;
  }
}

const MOTIF_ORDER = { fork: 0, discovered: 1, skewer: 2, pin: 3, overload: 4, trapped: 5 };

// Cases visées par un motif (pièces attaquées, clouées, en enfilade…).
function motifTargets(m) {
  switch (m.kind) {
    case 'fork': return m.targets.map((x) => x.square);
    case 'pin': return [m.pinned.square, m.behind.square];
    case 'skewer': return [m.front.square, m.behind.square];
    case 'discovered': return [m.target.square];
    case 'overload': return m.squares;
    case 'trapped': return [m.piece.square];
    default: return [];
  }
}
// Cases où `attacker` prend quelque chose dans line[from..to[.
const capturedSquares = (line, attacker, from, to) => new Set(line.slice(from, to).filter((x) => x.color === attacker && /x/.test(x.san)).map((x) => x.uci.slice(2, 4)));
// Un motif n'explique une perte de matériel que si l'une de ses cibles est prise ensuite.
const relevant = (m, captured) => motifTargets(m).some((sq) => captured.has(sq));
const weakPin = (m) => m.kind === 'pin' && m.pinned.type === 'p';
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
      const captured = capturedSquares(playedLine, v.opp, 1, 7);
      // Le motif doit être réel : pas un pion cloué, et si du matériel tombe, c'est une de ses cibles qui tombe.
      const motif = bestMotif(detectMotifs(reply.fenBefore, reply.uci).filter((m) => !weakPin(m) && (net > -1 || relevant(m, captured))));
      if (motif && (net <= -1 || ep.mate != null || (ctx.lossPct ?? 0) >= 12)) {
        const mp = motifParts(motif, v.opp, v);
        s.push(`Ce coup permet ${fig(reply.san)}, ${mp.name} : ${mp.detail}.`);
        t.push(`allowed_${motif.kind}`);
        problem = true;
      } else if (net <= -2) {
        const tac = tacticInLine(playedLine, v.opp, 7);
        if (tac) {
          const mp = motifParts(tac.motif, v.opp, v);
          s.push(`Après ${fig(played.san)}, la suite ${formatLine(playedLine.slice(0, Math.max(4, tac.index + 2)))} ${v.makesLose} ${materialText(-net)} : ${fig(playedLine[tac.index].san)} est ${mp.name} (${mp.detail}).`);
          t.push(`allowed_${tac.motif.kind}`);
        } else {
          const h = hangingInLine(playedLine, v.opp, 7);
          s.push(`Après ${fig(played.san)}, la suite ${formatLine(playedLine.slice(0, Math.max(4, (h?.index ?? 0) + 1)))} ${v.makesLose} ${materialText(-net)}${h ? hangingText(h, v) : ''}.`);
          t.push(h ? 'hanging_piece' : 'material_loss');
        }
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

  const needMore = () => !s.length || (s.length === 1 && classification === 'miss');

  // --- 3. Matériel perdu ou gagné plus loin dans la suite (jusqu'à 10 demi-coups) : on suit la ligne
  //        jusqu'au coup où il tombe, et on nomme la tactique qui le fait tomber.
  if (needMore()) {
    const lp = longMaterial(fenBefore, playedPv);
    const lb = longMaterial(fenBefore, bestPv);
    if (lp.delta <= -1 && lp.delta < lb.delta) {
      const tac = tacticInLine(playedLine, v.opp, lp.plies);
      if (tac) {
        const mp = motifParts(tac.motif, v.opp, v);
        s.push(`Après ${fig(played.san)}, la suite de Stockfish ${formatLine(playedLine.slice(0, lp.plies))} ${v.makesLose} ${materialText(-lp.delta)} : ${fig(playedLine[tac.index].san)} est ${mp.name} (${mp.detail}).`);
        t.push(`allowed_${tac.motif.kind}`);
      } else {
        const h = hangingInLine(playedLine, v.opp, lp.plies);
        s.push(`Après ${fig(played.san)}, la suite de Stockfish ${formatLine(playedLine.slice(0, lp.plies))} ${v.makesLose} ${materialText(-lp.delta)}${h ? hangingText(h, v) : ''}.`);
        t.push(h ? 'hanging_piece' : 'material_loss');
      }
    } else if (best && lb.delta >= 1 && lb.delta > lp.delta) {
      const tac = tacticInLine(bestLine, me, lb.plies);
      if (tac) {
        const mp = motifParts(tac.motif, me, v);
        s.push(`Avec ${bestFig}, ${v.couldWin} ${materialText(lb.delta)} : ${formatLine(bestLine.slice(0, lb.plies))} ; ${fig(bestLine[tac.index].san)} est ${mp.name} (${mp.detail}).`);
        t.push(`missed_${tac.motif.kind}`);
      } else {
        s.push(`Avec ${bestFig}, ${v.couldWin} ${materialText(lb.delta)} : ${formatLine(bestLine.slice(0, lb.plies))}.`);
        t.push('missed_material');
      }
    }
  }

  // --- 4. Pas de matériel en jeu : règles de position.
  if (needMore() && best) {
    const reason = positionalReason({ fenBefore, playedLine, bestLine, played, best, me, v, eb, ep });
    if (reason) { s.push(reason.sentence); t.push(reason.type); }
  }

  if (needMore()) {
    s.push(`Stockfish préférait ${bestFig ?? 'un autre coup'} : la suite montre pourquoi.`);
  }
  if (!t.length) t.push(classification === 'miss' ? 'unpunished' : 'positional');
  // Type principal : le plus grave des motifs trouvés.
  out.type = [...t].sort((a, b) => TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b))[0];
  return out;
}

// Première tactique jouée par `attacker` le long d'une ligne, avant que le matériel ne tombe (indice < plies) :
// fourchette, clouage, enfilade, découverte, surcharge ou pièce piégée.
function tacticInLine(line, attacker, plies) {
  for (let j = 0; j < Math.min(plies, line.length); j++) {
    const m = line[j];
    if (m.color !== attacker) continue;
    const special = overloadAt(line, j) ?? trappedAt(line, j);
    if (special) return { index: j, motif: special };
    // Un motif n'explique la perte que si l'une de ses cibles tombe dans les demi-coups suivants.
    const captured = capturedSquares(line, attacker, j, j + 6);
    if (!captured.size) continue;
    const motif = bestMotif(detectMotifs(m.fenBefore, m.uci).filter((x) => !weakPin(x) && (x.kind !== 'pin' || x.behind.type !== 'p') && relevant(x, captured)));
    if (motif) return { index: j, motif };
  }
  return null;
}

// Première prise par `attacker` d'une pièce (ou d'un pion) qui n'était plus défendu(e), le long de la ligne.
function hangingInLine(line, attacker, plies) {
  for (let j = 1; j < Math.min(plies, line.length); j++) {
    const m = line[j];
    if (m.color !== attacker || !/x/.test(m.san)) continue;
    const c = new Chess(m.fenBefore);
    const mv = new Chess(m.fenBefore).move(m.san);
    if (!mv?.captured) continue;
    if (c.attackers(mv.to, attacker === 'w' ? 'b' : 'w').length === 0) return { index: j, type: mv.captured, square: mv.to, san: m.san };
  }
  return null;
}
const hangingText = (h, v) => ` : ${v.piece(h.type, v.mover)} en ${h.square} n'est plus défendu${e(h.type)} et ${fig(h.san)} ${FEMININE.has(h.type) ? 'la' : 'le'} prend`;

const NAMES_PLURAL = { n: 'cavalier', b: 'fou' };
const checksBy = (line, color, from, to) => line.slice(from, to).filter((m) => m.color === color && m.san.includes('+')).length;
const cap = (str) => str.charAt(0).toUpperCase() + str.slice(1);

// Pions passés du camp `color` qui avancent le long de la ligne (à partir de l'indice `from`).
function passedAdvance(line, color, from) {
  if (line.length <= from) return { pushes: 0 };
  const start = new Chess(line[from].fenBefore);
  const tracked = new Map(passedPawns(start, color).map((sq) => [sq, { from: sq, to: sq, pushes: 0 }]));
  let best = { pushes: 0 };
  for (const m of line.slice(from, from + 8)) {
    if (m.color !== color) continue;
    const mv = new Chess(m.fenBefore).move(m.san);
    if (mv.piece !== 'p' || !tracked.has(mv.from)) continue;
    const p = tracked.get(mv.from);
    tracked.delete(mv.from);
    p.to = mv.to; p.pushes++;
    tracked.set(mv.to, p);
    if (p.pushes > best.pushes || (p.pushes === best.pushes && relRank(p.to, color) > relRank(best.to ?? p.to, color))) best = { ...p, uptoIndex: line.indexOf(m) };
  }
  return best;
}

/**
 * Règles de position (aucun matériel ne tombe dans les lignes de Stockfish), de la plus grave à la moins grave.
 * Renvoie { type, sentence } ou null.
 */
function positionalReason({ fenBefore, playedLine, bestLine, played, best, me, v, eb, ep }) {
  const opp = v.opp;
  const bestFig = fig(best.san);
  const playedFig = fig(played.san);
  const start = new Chess(fenBefore);
  const pm = new Chess(fenBefore).move(played.san);
  const bm = new Chess(fenBefore).move(best.san);
  const castle = (m) => !!m && (m.flags.includes('k') || m.flags.includes('q'));
  const winning = (eb.mate != null && eb.mate > 0) || (eb.cp ?? 0) >= 150;

  // Échec perpétuel : la position était gagnante, l'adversaire force la nulle à coups d'échecs.
  if (winning && ep.mate == null && Math.abs(ep.cp ?? 999) <= 60 && checksBy(playedLine, opp, 1, 8) >= 2) {
    return { type: 'perpetual_allowed', sentence: `Ce coup permet ${v.toOpponent} de forcer la nulle par échec perpétuel : ${formatLine(playedLine.slice(0, 6))}. ${bestFig} gardait l'avantage.` };
  }

  // Pion passé adverse laissé avancer.
  const pa = passedAdvance(playedLine, opp, 1);
  const ba = passedAdvance(bestLine, opp, 1);
  if (pa.pushes && (pa.pushes >= 2 || relRank(pa.to, opp) >= 6) && (pa.pushes > ba.pushes || relRank(pa.to, opp) > relRank(ba.to ?? pa.from, opp))) {
    return { type: 'passed_pawn', sentence: `${cap(v.piece('p', opp))} passé en ${pa.from} n'est pas arrêté : dans la suite de Stockfish, il avance jusqu'en ${pa.to} (${formatLine(playedLine.slice(0, pa.uptoIndex + 1))}). ${bestFig} le freinait.` };
  }

  // Roi exposé : l'adversaire enchaîne les échecs, ou le pion qui abritait le roi avance.
  const checksPlayed = checksBy(playedLine, opp, 1, 7);
  if (checksPlayed >= 2 && checksPlayed > checksBy(bestLine, opp, 1, 7)) {
    const upto = playedLine.slice(1, 7).map((m, i) => (m.color === opp && m.san.includes('+') ? i + 2 : 0)).reduce((a, b) => Math.max(a, b), 2);
    return { type: 'king_exposed', sentence: `Après ${playedFig}, ${v.king(me)} est exposé : ${v.oppChecks} (${formatLine(playedLine.slice(0, upto))}). ${bestFig} gardait ${v.king(me)} à l'abri.` };
  }
  const at = (line, i) => new Chess(line[Math.min(i, line.length - 1)].fenAfter);
  if (playedLine.length >= 4 && bestLine.length >= 4 && pieceCountNoPawns(start) > 6) {
    const pPress = kingZonePressure(at(playedLine, 3), me);
    const bPress = kingZonePressure(at(bestLine, 3), me);
    if (pPress >= 4 && pPress >= bPress + 3) {
      return { type: 'king_exposed', sentence: `Après ${formatLine(playedLine.slice(0, 4))}, les pièces adverses se massent autour de ${v.king(me)} (${pPress} attaques sur lui et les cases voisines, contre ${bPress} avec ${bestFig}) : il devient vulnérable.` };
    }
  }
  const k = kingSquare(start, me);
  if (k && pm.piece === 'p' && !pm.captured && relRank(k, me) === 1 && Math.abs(k.charCodeAt(0) - pm.from.charCodeAt(0)) <= 1
      && relRank(pm.from, me) === 2 && !'de'.includes(pm.from[0]) && !(bm.piece === 'p' && Math.abs(k.charCodeAt(0) - bm.from.charCodeAt(0)) <= 1)) {
    return { type: 'king_exposed', sentence: `${playedFig} affaiblit l'abri de ${v.king(me)} : le pion qui le protégeait avance et ouvre des lignes vers lui. ${bestFig} était plus sûr.` };
  }

  // Roque perdu ou trop tardif.
  const rights = castlingRights(fenBefore, me);
  if (rights && !castle(pm)) {
    if (pm.piece === 'k') {
      return { type: 'castling', sentence: `En déplaçant ${v.king(me)} sans roquer, ${v.lose} le droit de roquer : le roi reste au centre, exposé. ${bestFig} était meilleur.` };
    }
    if (pm.piece === 'r' && castlingRights(played.fenAfter, me).length < rights.length && !castle(bm)) {
      return { type: 'castling', sentence: `Ce coup de tour ${v.makesLose} le droit de roquer de ce côté, alors que ${v.king(me)} est encore au centre. ${bestFig} était meilleur.` };
    }
    if (castle(bm)) {
      const reply = playedLine[1];
      const stillPossible = reply ? new Chess(reply.fenAfter).moves().includes(best.san) : true;
      return { type: 'castling', sentence: `Il fallait roquer (${bestFig}) : ${v.king(me)} reste au centre${stillPossible ? '' : `, et après ${fig(reply.san)} le roque n'est plus possible`}.` };
    }
  }

  // Roi adverse resté au centre : le meilleur coup l'empêchait de roquer (ou l'obligeait à bouger).
  const oppRights = castlingRights(fenBefore, opp);
  if (oppRights) {
    const canCastle = (fen) => new Chess(fen).moves().some((m) => /^O-O/.test(m));
    const losesRights = (line, n) => line.slice(0, n).some((m) => m.color === opp && castlingRights(m.fenBefore, opp) && !castlingRights(m.fenAfter, opp) && !/^O-O/.test(m.san));
    if ((canCastle(played.fenAfter) && !canCastle(best.fenAfter)) || (losesRights(bestLine, 4) && !losesRights(playedLine, 4))) {
      return { type: 'castling', sentence: `${cap(v.king(opp))} était encore au centre : ${bestFig} ${losesRights(bestLine, 4) ? "l'obligeait à bouger et lui retirait le roque" : "l'empêchait de roquer"} (${formatLine(bestLine.slice(0, 4))}), alors qu'après ${playedFig} il peut se mettre à l'abri.` };
    }
  }

  // Pièce non développée (ouverture).
  const fullmove = Number(fenBefore.split(' ')[5]) || 1;
  const und = undeveloped(start, me);
  if (fullmove <= 15 && und.length >= 2 && isHomeMinor(me, bm.from, bm.piece) && !isHomeMinor(me, pm.from, pm.piece) && !castle(pm)) {
    const what = pm.piece === 'p' ? 'avance un pion' : pm.piece === 'q' ? 'sort la dame trop tôt' : pm.piece === 'k' ? 'déplace le roi' : 'rejoue une pièce déjà sortie';
    return { type: 'development', sentence: `${v.had} encore ${und.length} pièces à sortir (${und.map((x) => `${NAMES_PLURAL[x.type]} ${x.square}`).join(', ')}) : ${bestFig} en développait une, alors que ${playedFig} ${what}.` };
  }

  // Pièce sans retraite : la pièce jouée n'a plus qu'une case sûre (ou aucune) et l'adversaire l'attaque.
  if (['n', 'b', 'r', 'q'].includes(pm.piece) && playedLine[1]) {
    const safe = safeSquaresAnyTurn(played.fenAfter, pm.to);
    const afterReply = new Chess(playedLine[1].fenAfter);
    const still = afterReply.get(pm.to);
    if (safe.length <= 1 && still?.type === pm.piece && still.color === me && afterReply.attackers(pm.to, opp).length) {
      const pron = ['r', 'q'].includes(pm.piece) ? 'la' : 'le';
      return { type: 'no_retreat', sentence: `Après ${playedFig}, ${v.piece(pm.piece, me)} en ${pm.to} n'a ${safe.length ? "plus qu'une case de retraite" : 'plus aucune case de retraite'} : ${fig(playedLine[1].san)} ${pron} harcèle et ${pron} met en danger. ${bestFig} était plus sûr.` };
    }
  }

  if (['n', 'b'].includes(pm.piece) && onEdge(pm.to) && !onEdge(pm.from) && !(bm.piece === pm.piece && onEdge(bm.to))) {
    const safe = safeSquaresAnyTurn(played.fenAfter, pm.to);
    if (safe.length <= 2) {
      return { type: 'no_retreat', sentence: `${playedFig} envoie ${v.piece(pm.piece, me)} au bord de l'échiquier, en ${pm.to}, où il ne contrôle presque plus rien (${safe.length} case${safe.length > 1 ? 's' : ''} sûre${safe.length > 1 ? 's' : ''}). ${bestFig} gardait les pièces actives.` };
    }
  }

  // Pion isolé ou doublé créé : on regarde après chacun de nos coups suivants (jusqu'à 6 demi-coups).
  const before = pawnWeaknesses(start, me);
  let kk = -1;
  let afterP = null;
  for (const i of [2, 4, 6]) {
    if (i >= playedLine.length) break;
    const wp = pawnWeaknesses(new Chess(playedLine[i].fenAfter), me);
    const wb = bestLine.length ? pawnWeaknesses(new Chess(bestLine[Math.min(i, bestLine.length - 1)].fenAfter), me) : null;
    if (wp.count > before.count && (!wb || wp.count > wb.count)) { kk = i; afterP = wp; break; }
  }
  if (afterP) {
    const iso = afterP.isolated.find((sq) => !before.isolated.includes(sq));
    const dbl = afterP.doubled.find((f) => !before.doubled.includes(f));
    const isoText = iso ? `un pion isolé en ${iso} (plus aucun pion ami sur les colonnes voisines)` : null;
    const dblText = dbl ? `des pions doublés sur la colonne ${dbl}` : null;
    const what = [dblText, isoText].filter(Boolean).join(' et ') || `des pions doublés sur la colonne ${afterP.doubled[0]}`;
    return { type: 'pawn_structure', sentence: `Après ${formatLine(playedLine.slice(0, kk + 1))}, ${v.have} ${what} : une faiblesse durable que l'adversaire peut attaquer. ${bestFig} l'évitait.` };
  }

  // Pièce adverse non chassée : le meilleur coup attaquait une pièce adverse avec un pion (gain de temps).
  if (bm.piece === 'p' && !bm.captured && !(pm.piece === 'p' && !pm.captured)) {
    const after = new Chess(best.fenAfter);
    const dir = me === 'w' ? 1 : -1;
    const f = bm.to.charCodeAt(0);
    const r = Number(bm.to[1]) + dir;
    const target = [f - 1, f + 1].map((x) => (x >= 97 && x <= 104 && r >= 1 && r <= 8 ? `${String.fromCharCode(x)}${r}` : null))
      .filter(Boolean).map((sq) => ({ sq, p: after.get(sq) })).find((x) => x.p && x.p.color === opp && ['n', 'b', 'r', 'q'].includes(x.p.type));
    if (target) {
      return { type: 'missed_tempo', sentence: `${bestFig} chassait ${v.piece(target.p.type, opp)} en ${target.sq} avec un pion : ${FEMININE.has(target.p.type) ? 'elle' : 'il'} devait reculer, un gain de temps. Après ${playedFig}, ${FEMININE.has(target.p.type) ? 'elle' : 'il'} garde sa bonne case.` };
    }
  }

  // Roi passif en finale.
  if (pieceCountNoPawns(start) <= 6) {
    if (bm.piece === 'k' && pm.piece !== 'k' && centerDistance(bm.to) < centerDistance(bm.from)) {
      return { type: 'passive_king', sentence: `En finale, ${v.king(me)} doit participer : ${bestFig} le rapprochait du centre, alors que ${playedFig} le laisse en retrait.` };
    }
    if (pm.piece === 'k' && centerDistance(pm.to) > centerDistance(pm.from) && !(bm.piece === 'k' && centerDistance(bm.to) >= centerDistance(pm.to))) {
      return { type: 'passive_king', sentence: `En finale, ${playedFig} éloigne ${v.king(me)} du centre : il devient passif. ${bestFig} était meilleur.` };
    }
  }
  return null;
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
