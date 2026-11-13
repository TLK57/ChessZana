// Lecture de PGN : découpage de fichiers multi-parties, en-têtes, coups, commentaires et pendules %clk.
import { Chess } from 'chess.js';
import { START_FEN, moveToUci, normalizeChessFen, pieceCount } from './chessutil.js';

const RESULTS = new Set(['1-0', '0-1', '1/2-1/2', '*']);

// Découpe un texte contenant plusieurs parties PGN.
export function splitPgn(text) {
  const lines = String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const games = [];
  let cur = [];
  let inMoves = false;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('[') && /^\[\w+\s+".*"\]\s*$/.test(t)) {
      if (inMoves) { games.push(cur.join('\n')); cur = []; inMoves = false; }
      cur.push(t);
    } else {
      if (t !== '') inMoves = true;
      cur.push(line);
    }
  }
  if (cur.some((l) => l.trim() !== '')) games.push(cur.join('\n'));
  return games.map((g) => g.trim()).filter((g) => g.length > 0);
}

export function parseHeaders(pgn) {
  const headers = {};
  const re = /^\s*\[(\w+)\s+"((?:[^"\\]|\\.)*)"\]\s*$/gm;
  let m;
  while ((m = re.exec(pgn)) !== null) headers[m[1]] = m[2].replace(/\\(.)/g, '$1');
  return headers;
}

// %clk H:MM:SS(.d) -> millisecondes
export function parseClock(comment) {
  if (!comment) return null;
  const m = /\[%clk\s+(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)\]/.exec(comment);
  if (!m) return null;
  return Math.round(((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000);
}

// Découpe le texte des coups en jetons (coups SAN + commentaires), en ignorant les variantes.
export function tokenizeMovetext(text) {
  const tokens = [];
  let i = 0;
  let depth = 0; // profondeur de variante ( ... )
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '{') {
      const end = text.indexOf('}', i + 1);
      const body = text.slice(i + 1, end === -1 ? n : end);
      if (depth === 0) tokens.push({ type: 'comment', text: body });
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (ch === ';') { // commentaire jusqu'à la fin de la ligne
      const end = text.indexOf('\n', i);
      if (depth === 0) tokens.push({ type: 'comment', text: text.slice(i + 1, end === -1 ? n : end) });
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (ch === '(') { depth++; i++; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); i++; continue; }
    if (/\s/.test(ch)) { i++; continue; }
    let j = i;
    while (j < n && !/[\s{}();]/.test(text[j])) j++;
    const word = text.slice(i, j);
    i = j;
    if (depth > 0) continue;
    if (RESULTS.has(word)) { tokens.push({ type: 'result', text: word }); continue; }
    if (/^\$\d+$/.test(word)) continue; // NAG
    const stripped = word.replace(/^\d+\.(\.\.)?/, '').replace(/^\.+/, '');
    if (stripped === '' || /^\d+\.*$/.test(stripped)) continue; // numéro de coup
    tokens.push({ type: 'move', text: stripped });
  }
  return tokens;
}

function cleanSan(san) {
  return san
    .replace(/[!?]+/g, '') // annotations !, ?, !?, ?!
    .replace(/^0-0-0/, 'O-O-O')
    .replace(/^0-0/, 'O-O');
}

function parseTimeControl(tc) {
  if (!tc || tc === '-' || tc === '?') return { base: null, inc: null };
  const m = /^(\d+)(?:\+(\d+))?$/.exec(tc);
  if (m) return { base: Number(m[1]), inc: Number(m[2] ?? 0) };
  return { base: null, inc: null }; // ex. 1/86400 (partie par correspondance)
}

/**
 * Analyse une partie PGN complète et rejoue les coups avec chess.js.
 * Renvoie { headers, result, startFen, moves: [{ply, color, san, uci, fenBefore, normBefore, normAfter,
 *   piecesBefore, piecesAfter, clockMs, timeSpentMs}], error }
 */
export function parseGame(pgn, { timeControl } = {}) {
  const headers = parseHeaders(pgn);
  const movetext = pgn.replace(/^\s*\[\w+\s+"(?:[^"\\]|\\.)*"\]\s*$/gm, '');
  const tokens = tokenizeMovetext(movetext);
  const setup = headers.SetUp === '1' || (headers.FEN && headers.FEN !== START_FEN);
  const startFen = setup && headers.FEN ? headers.FEN : START_FEN;
  let chess;
  try {
    chess = new Chess(startFen);
  } catch (e) {
    return { headers, result: headers.Result ?? null, startFen, moves: [], error: `FEN de départ invalide : ${e.message}` };
  }
  const tc = parseTimeControl(timeControl ?? headers.TimeControl);
  const moves = [];
  let result = headers.Result && RESULTS.has(headers.Result) ? headers.Result : null;
  let error = null;
  const lastClock = { w: tc.base != null ? tc.base * 1000 : null, b: tc.base != null ? tc.base * 1000 : null };

  for (const tok of tokens) {
    if (tok.type === 'result') { result = tok.text; continue; }
    if (tok.type === 'comment') {
      const last = moves[moves.length - 1];
      if (last) {
        const clk = parseClock(tok.text);
        if (clk != null && last.clockMs == null) {
          last.clockMs = clk;
          const prev = lastClock[last.color];
          if (prev != null) {
            last.timeSpentMs = Math.max(0, prev - clk + (tc.inc ?? 0) * 1000);
          }
          lastClock[last.color] = clk;
        }
        last.comments.push(tok.text.trim());
      }
      continue;
    }
    if (error) continue;
    const fenBefore = chess.fen();
    const normBefore = normalizeChessFen(chess);
    let mv = null;
    try {
      mv = chess.move(cleanSan(tok.text));
    } catch {
      mv = null;
    }
    if (!mv) {
      error = `Coup illégal ou illisible au demi-coup ${moves.length + 1} : « ${tok.text} »`;
      continue;
    }
    moves.push({
      ply: moves.length + 1,
      color: mv.color,
      san: mv.san,
      uci: moveToUci(mv),
      fenBefore,
      normBefore,
      normAfter: normalizeChessFen(chess),
      piecesBefore: pieceCount(fenBefore),
      piecesAfter: pieceCount(chess.fen()),
      clockMs: null,
      timeSpentMs: null,
      comments: [],
    });
  }
  return { headers, result, startFen, isStandardStart: startFen === START_FEN, moves, finalFen: chess.fen(), error };
}

export function isFinishedResult(result) {
  return result === '1-0' || result === '0-1' || result === '1/2-1/2';
}
