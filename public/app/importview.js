// Écran « Importer & file d'analyse » (reprend la page de contrôle de l'étape 1).
import { api, esc } from './util.js';

const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);

export async function renderImport(root) {
  root.innerHTML = `
  <div class="grid2 import">
    <section class="card">
      <h2>Importer des parties</h2>
      <label class="lbl" for="cc">Pseudo chess.com</label>
      <div class="row"><input id="cc" type="text" placeholder="ex. Dilo56" autocomplete="off"><button class="primary" id="ccBtn">Importer</button></div>
      <label class="lbl" for="li">Pseudo Lichess</label>
      <div class="row"><input id="li" type="text" placeholder="pseudo Lichess" autocomplete="off"><button class="primary" id="liBtn">Importer</button></div>
      <label class="lbl" for="pgn">PGN (coller le texte ou déposer un fichier .pgn)</label>
      <textarea id="pgn" class="pgn" placeholder='[White "..."]&#10;[Black "..."]&#10;[Result "1-0"]&#10;&#10;1. e4 e5 2. Nf3 ... 1-0'></textarea>
      <div class="drop" id="drop">Déposez un fichier .pgn ici, ou <label style="display:inline;color:var(--accent);cursor:pointer"><input type="file" id="file" accept=".pgn,.txt" multiple hidden>choisissez-le</label></div>
      <div class="actions"><button class="primary" id="pgnBtn">Importer le PGN</button><button id="syncBtn">Synchroniser mes comptes</button></div>
      <p id="contactWarn" class="small muted" hidden>Conseil : indiquez votre e-mail dans « contact » de config.json (demandé par chess.com et Lichess).</p>
    </section>
    <section class="card">
      <h2>File d'analyse</h2>
      <label class="lbl" for="mode">Quelles parties analyser ?</label>
      <select id="mode" style="width:100%">
        <option value="manual">Seulement les parties que je choisis (bouton « Analyser »)</option>
        <option value="quick">Passe rapide sur toutes mes parties, profonde sur celles que je choisis</option>
        <option value="auto">Toutes mes parties automatiquement (rapide puis profonde)</option>
      </select>
      <p class="small muted" id="modeHelp" style="margin:6px 0 12px"></p>
      <div class="small">Passe rapide (profondeur <span id="qd"></span>) : <b id="qTxt">–</b></div>
      <div class="bar"><div id="qBar"></div></div>
      <div class="small" style="margin-top:8px">Passe profonde (profondeur <span id="dd"></span>) : <b id="dTxt">–</b></div>
      <div class="bar"><div id="dBar"></div></div>
      <p class="small" id="current" style="margin:10px 0 4px">–</p>
      <div class="bar"><div id="cBar"></div></div>
      <div class="actions"><button id="pauseBtn">Pause</button><button id="retryBtn" hidden>Relancer les parties en erreur</button></div>
      <p class="small muted" id="qErr"></p>
      <h2 style="margin-top:12px">Imports</h2>
      <ul id="log" class="small" style="padding-left:18px;margin:0"></ul>
    </section>
  </div>`;
  const $ = (id) => root.querySelector(`#${id}`);

  async function refresh() {
    let s;
    try { s = await api('/api/status'); } catch { return; }
    $('contactWarn').hidden = s.contactSet;
    $('qd').textContent = s.engine.quickDepth; $('dd').textContent = s.engine.deepDepth;
    const q = s.queue, Q = q.passes.quick, D = q.passes.deep;
    if (document.activeElement !== $('mode')) $('mode').value = q.mode;
    $('modeHelp').textContent = q.mode === 'manual'
      ? `Rien n'est analysé tant que vous ne cliquez pas sur « Analyser » (dans la liste ou sur l'écran d'une partie). ${q.requested.waiting} partie(s) en file.`
      : q.mode === 'quick'
        ? `La passe rapide (quelques secondes par partie) tourne sur toutes vos parties ; la passe profonde seulement sur celles que vous demandez (${q.requested.waiting} en file).`
        : "Toutes les parties sont analysées, d'abord en passe rapide puis en passe profonde. Sur un portable, la passe profonde de centaines de parties prend des semaines.";
    $('qTxt').textContent = `${Q.done} / ${Q.total}${Q.error ? ` (${Q.error} en erreur)` : ''}`;
    $('dTxt').textContent = `${D.done} / ${D.total}${D.error ? ` (${D.error} en erreur)` : ''}`;
    $('qBar').style.width = `${pct(Q.done + Q.error, Q.total)}%`;
    $('dBar').style.width = `${pct(D.done + D.error, D.total)}%`;
    if (q.current) {
      $('current').innerHTML = `En cours (${q.current.pass === 'quick' ? 'rapide' : 'profonde'}) : <a href="#/partie/${q.current.gameId}">${esc(q.current.label)}</a> — coup ${q.current.ply} / ${q.current.total || '?'}`;
      $('cBar').style.width = `${pct(q.current.ply, q.current.total)}%`;
    } else {
      $('current').textContent = q.paused ? 'En pause.' : (Q.pending + D.pending === 0 ? 'Rien à analyser pour le moment.' : 'En attente du moteur…');
      $('cBar').style.width = '0%';
    }
    $('pauseBtn').textContent = q.paused ? 'Reprendre' : 'Pause';
    $('retryBtn').hidden = !(Q.error + D.error);
    $('qErr').textContent = q.lastError ? `Dernière erreur : ${q.lastError}` : '';
    $('log').innerHTML = s.imports.map((j) => `<li><b>${j.kind === 'chesscom' ? 'chess.com' : 'Lichess'} ${esc(j.username)}</b> — ${esc(j.status === 'error' ? `Erreur : ${j.error}` : j.message)}${j.total ? ` (${j.done}/${j.total})` : ''}</li>`).join('') || '<li>Aucun import pendant cette session.</li>';
  }

  async function importUser(kind, input) {
    const username = $(input).value.trim();
    if (!username) return;
    try { await api(`/api/import/${kind}`, { username }); $(input).value = ''; refresh(); } catch (e) { alert(e.message); }
  }
  async function importPgn(text) {
    if (!text.trim()) return;
    try {
      const r = await api('/api/import/pgn', { pgn: text });
      alert(`${r.found} partie(s) trouvée(s) : ${r.added} ajoutée(s), ${r.duplicate} déjà présente(s)${r.unfinished ? `, ${r.unfinished} non terminée(s) ignorée(s)` : ''}${r.errors.length ? `\nProblèmes : ${r.errors.slice(0, 3).join(' ; ')}` : ''}`);
      $('pgn').value = '';
      refresh();
    } catch (e) { alert(e.message); }
  }
  async function readFiles(files) {
    let text = '';
    for (const file of files) text += `${await file.text()}\n\n`;
    importPgn(text);
  }

  $('ccBtn').onclick = () => importUser('chesscom', 'cc');
  $('liBtn').onclick = () => importUser('lichess', 'li');
  $('cc').onkeydown = (e) => { if (e.key === 'Enter') importUser('chesscom', 'cc'); };
  $('li').onkeydown = (e) => { if (e.key === 'Enter') importUser('lichess', 'li'); };
  $('pgnBtn').onclick = () => importPgn($('pgn').value);
  $('syncBtn').onclick = () => api('/api/sync', {}).then(refresh);
  $('file').onchange = (e) => readFiles(e.target.files);
  const drop = $('drop');
  ['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
  drop.addEventListener('drop', (e) => { e.preventDefault(); readFiles(e.dataTransfer.files); });
  $('pauseBtn').onclick = async () => { const s = await api('/api/status'); await api(s.queue.paused ? '/api/queue/resume' : '/api/queue/pause', {}); refresh(); };
  $('retryBtn').onclick = () => api('/api/queue/retry', {}).then(refresh);
  $('mode').onchange = () => api('/api/queue/mode', { mode: $('mode').value }).then(refresh).catch((e) => alert(e.message));

  await refresh();
  const timer = setInterval(refresh, 1500);
  return () => clearInterval(timer);
}
