// Écran d'une partie — question prête à copier pour « Demander à Claude » (coup de la partie ou du mode libre).
import { fmtPct, lineText, toast, copyText } from './util.js';

export function claudeText(ctx) {
  const { S, g } = ctx;
  let fenBefore, previous, move, label, loss, lines, depth, color;
  if (S.free && ctx.node().item?.result) {
    const f = S.free;
    const it = ctx.node().item;
    fenBefore = it.fenBefore;
    previous = [...g.moves.slice(0, f.basePly).map((m) => ({ san: m.san, color: m.color, moveNumber: Math.ceil(m.ply / 2) })),
      ...f.items.slice(0, f.cursor - 1).map((x) => ({ san: x.san, color: x.color, moveNumber: x.moveNumber }))];
    move = { san: it.san, color: it.color, moveNumber: it.moveNumber };
    ({ label, loss, lines, depth } = it.result);
    color = it.color;
  } else {
    const m = g.moves[S.ply - 1];
    if (!m) return null;
    fenBefore = m.fenBefore;
    previous = g.moves.slice(0, S.ply - 1).map((x) => ({ san: x.san, color: x.color, moveNumber: Math.ceil(x.ply / 2) }));
    move = { san: m.san, color: m.color, moveNumber: Math.ceil(m.ply / 2) };
    ({ label, loss, lines, depth } = m);
    color = m.color;
  }
  const myElo = g.myColor ? g[g.myColor].elo : (color === 'w' ? g.white.elo : g.black.elo);
  const moveTxt = `${move.moveNumber}${move.color === 'w' ? '.' : '...'} ${move.san} (${move.color === 'w' ? 'Blancs' : 'Noirs'})`;
  const linesTxt = (lines ?? []).map((l, i) => `  ${i + 1}) ${lineText(l.line.slice(0, 10), { figurines: false })}  —  évaluation ${l.evalText}`).join('\n');
  return [
    "Bonjour ! J'analyse une de mes parties d'échecs et j'aimerais comprendre un coup.",
    '',
    `Position avant le coup (FEN) : ${fenBefore}`,
    `Coups précédents : ${previous.length ? lineText(previous, { figurines: false }) : '(aucun, c\'est le premier coup)'}`,
    `Coup joué : ${moveTxt}`,
    `Classement de mon logiciel d'analyse : ${label ?? 'non analysé'}${loss != null ? ` (perte de ${fmtPct(loss)} % de chances de gain)` : ''}`,
    `Les 2 meilleures lignes de Stockfish 19${depth ? ` (profondeur ${depth})` : ''}, évaluations du point de vue des Blancs :`,
    linesTxt || '  (non disponibles)',
    `Mon Elo : ${myElo ?? 'inconnu'}`,
    '',
    'Explique-moi pourquoi mon coup est mauvais et quelle idée j\'aurais dû voir.',
  ].join('\n');
}

export async function askClaude(ctx) {
  const text = claudeText(ctx);
  if (!text) return;
  ctx.S.lastClaude = text;
  const ok = await copyText(text);
  if (ok) {
    toast('Question copiée ! Collez-la (Ctrl+V) sur <a href="https://claude.ai/new" target="_blank" rel="noopener">claude.ai</a>.', 7000);
    return;
  }
  // Le navigateur a refusé l'accès au presse-papiers : on affiche le texte, prêt à copier à la main.
  const wrap = document.createElement('div');
  wrap.className = 'promo';
  wrap.innerHTML = `<div class="box" style="flex-direction:column;max-width:720px;width:92vw">
    <b>Copiez cette question (Ctrl+C), puis collez-la sur claude.ai</b>
    <textarea class="pgn" style="height:280px" readonly></textarea>
    <div class="actions"><a class="primary" href="https://claude.ai/new" target="_blank" rel="noopener">Ouvrir claude.ai</a><button data-close>Fermer</button></div></div>`;
  wrap.querySelector('textarea').value = text;
  wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]')) wrap.remove(); });
  document.body.appendChild(wrap);
  wrap.querySelector('textarea').select();
}
