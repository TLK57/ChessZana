// Écran « Importer » : import des parties, file d'analyse, classement des coups, sauvegardes.
import { api, esc } from './util.js';

const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
const fmtInt = (n) => Number(n).toLocaleString('fr-FR');
function fmtDuration(sec) {
  if (sec < 90) return `${Math.max(1, Math.round(sec))} s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  if (sec < 172800) return `${Math.round(sec / 3600)} h`;
  return `${Math.round(sec / 86400)} jours`;
}
const range = (r) => (r.min != null && r.max != null && r.min !== r.max ? ` (de ${r.min} à ${r.max})` : '');

export async function renderImport(root) {
  root.innerHTML = `
  <div class="page-head"><h1>Importer et analyser</h1><span class="lead">Vos parties, la file d'analyse et les sauvegardes.</span></div>
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
      <p id="contactWarn" class="small muted" hidden>Conseil : indiquez votre e-mail dans « contact » du fichier config.local.json (demandé par chess.com et Lichess).</p>
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
      <div class="small">Passe rapide : <b id="qTxt">–</b></div>
      <div class="small muted" id="qd"></div>
      <div class="bar"><div id="qBar"></div></div>
      <div class="small" style="margin-top:8px">Passe profonde : <b id="dTxt">–</b></div>
      <div class="small muted" id="dd"></div>
      <div class="bar"><div id="dBar"></div></div>
      <p class="small" id="current" style="margin:10px 0 4px">–</p>
      <div class="bar"><div id="cBar"></div></div>
      <div class="actions"><button id="pauseBtn">Pause</button><button id="retryBtn" hidden>Relancer les parties en erreur</button></div>
      <p class="small muted" id="qErr"></p>
      <h2 style="margin-top:12px">Tout mon historique</h2>
      <p class="small" id="histTxt">–</p>
      <p class="small muted">Toutes vos parties, passe rapide puis profonde. Les parties que vous demandez passent toujours avant,
        et le moteur tourne en priorité basse : l'ordinateur reste utilisable. Vous pouvez mettre en pause et reprendre plus tard,
        même après avoir fermé l'application.</p>
      <div class="actions"><button class="primary" id="histBtn">Analyser tout mon historique</button><button id="histStop" hidden>Arrêter</button></div>
      <h2 style="margin-top:12px">Imports</h2>
      <ul id="log" class="small" style="padding-left:18px;margin:0"></ul>
    </section>
  </div>
  <section class="card" style="margin-top:16px">
    <h2>Classement des coups</h2>
    <label class="radio"><input type="radio" name="method" value="lichess"> <b>Lichess</b> (par défaut) — les règles exactes de Lichess :
      imprécision dès 5 points de chances de gain perdus, erreur dès 10, gaffe dès 15, quel que soit le niveau.</label>
    <label class="radio"><input type="radio" name="method" value="chesscom"> <b>Style chess.com</b> — une approximation (la méthode
      de chess.com n'est pas publique) : points attendus selon le niveau du joueur, erreur dès 10 %, gaffe dès 20 %, avec les
      catégories Meilleur, Excellent, Bon, Très bon, Brillant et Occasion manquée.</label>
    <p class="small muted" id="methodTxt">Changer de méthode reclasse toutes les parties déjà analysées, sans les recalculer (quelques secondes).
      La précision affichée partout reste celle de Lichess.</p>
  </section>
  <section class="card" style="margin-top:16px">
    <h2>Sauvegardes de la base</h2>
    <p class="small muted">Une sauvegarde est faite automatiquement au démarrage (si la dernière a plus de 24 h) et avant chaque mise à jour
      de la structure de la base. Les <span id="keep">7</span> dernières sont gardées dans le dossier <code>data/backups</code>.</p>
    <div class="actions"><a class="primary" href="/api/backups/export" download>⬇ Exporter ma base</a><button id="backupNow">Sauvegarder maintenant</button></div>
    <table class="simple" style="margin-top:10px"><thead><tr><th>Date</th><th>Raison</th><th class="num">Taille</th><th></th></tr></thead><tbody id="backups"></tbody></table>
  </section>`;
  const $ = (id) => root.querySelector(`#${id}`);

  async function refresh() {
    let s;
    try { s = await api('/api/status'); } catch { return; }
    $('contactWarn').hidden = s.contactSet;
    const E = s.engine, R = E.reached ?? {};
    $('qd').textContent = `Profondeur fixe ${E.quickDepth}.`;
    $('dd').textContent = (E.deepNodes > 0
      ? `${fmtInt(E.deepNodes)} positions calculées par coup : la profondeur atteinte varie selon la position${R.deep ? ` — ${String(R.deep.avg).replace('.', ',')} en moyenne${range(R.deep)} sur vos ${R.deep.n} analyses profondes` : ''}.`
      : `Profondeur fixe ${E.deepDepth}.`)
      + (E.verifyDepth > 0 ? ` Les coups douteux (erreurs, gaffes, occasions manquées, très bons, brillants, pertes d'au moins 5 %, désaccords entre les deux passes, coups joués après une erreur adverse) sont ensuite revérifiés à la profondeur ${E.verifyDepth}${R.deep?.verified ? ` (${R.deep.verified} coups revérifiés jusqu'ici)` : ''}.` : '');
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
      const c = q.current;
      $('current').innerHTML = `En cours (${c.pass === 'quick' ? 'rapide' : 'profonde'}) : <a href="#/partie/${c.gameId}">${esc(c.label)}</a> — `
        + (c.verify ? `vérification à la profondeur ${c.verify.depth} : coup douteux ${c.verify.done + 1} / ${c.verify.total}` : `coup ${c.ply} / ${c.total || '?'}`);
      $('cBar').style.width = `${c.verify ? pct(c.verify.done, c.verify.total) : pct(c.ply, c.total)}%`;
    } else {
      $('current').textContent = q.paused ? 'En pause.' : (Q.pending + D.pending === 0 ? 'Rien à analyser pour le moment.' : 'En attente du moteur…');
      $('cBar').style.width = '0%';
    }
    $('pauseBtn').textContent = q.paused ? 'Reprendre' : 'Pause';
    const C = s.classification;
    for (const r of root.querySelectorAll('input[name=method]')) r.checked = r.value === C.method;
    const RC = C.reclassify ?? {};
    if (RC.running) $('methodTxt').innerHTML = `<span class="spinner"></span> Reclassement des parties analysées : ${RC.done} / ${RC.total || '?'}…`;
    else if (RC.total) $('methodTxt').textContent = `${RC.total} analyse(s) reclassée(s) avec cette méthode${RC.failed ? ` (${RC.failed} à relancer : évaluations absentes)` : ''}.`;
    const H = q.history;
    $('histTxt').innerHTML = H.totalGames === 0 ? 'Importez d\'abord vos parties.'
      : H.remainingGames === 0 ? `<b>Tout votre historique est analysé</b> (${H.totalGames} parties).`
        : `<b>${H.remainingGames} partie(s) restante(s)</b> sur ${H.totalGames} (passe rapide : ${H.remainingQuick}, passe profonde : ${H.remainingDeep})`
          + ` — temps estimé : <b>environ ${fmtDuration(H.etaSec)}</b>`
          + (H.measured ? ` (d'après vos dernières analyses : ${fmtDuration(H.avgSec.quick)} en rapide, ${fmtDuration(H.avgSec.deep)} en profondeur par partie)` : ' (estimation grossière : pas encore assez d\'analyses mesurées sur cet ordinateur)')
          + (H.state === 'paused' ? '. <b>En pause.</b>' : H.state === 'on' ? '. <b>En cours.</b>' : '.');
    $('histBtn').textContent = H.state === 'on' ? 'Mettre en pause' : H.state === 'paused' ? 'Reprendre' : 'Analyser tout mon historique';
    $('histBtn').dataset.action = H.state === 'on' ? 'pause' : H.state === 'paused' ? 'resume' : 'start';
    $('histBtn').hidden = H.state === 'off' && H.remainingGames === 0;
    $('histStop').hidden = H.state === 'off';
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
  $('histBtn').onclick = () => api('/api/queue/history', { action: $('histBtn').dataset.action }).then(refresh).catch((e) => alert(e.message));
  root.querySelectorAll('input[name=method]').forEach((r) => {
    r.onchange = () => api('/api/settings/classification', { method: r.value }).then(refresh).catch((e) => alert(e.message));
  });
  $('histStop').onclick = () => api('/api/queue/history', { action: 'stop' }).then(refresh).catch((e) => alert(e.message));
  $('mode').onchange = () => api('/api/queue/mode', { mode: $('mode').value }).then(refresh).catch((e) => alert(e.message));

  const REASONS = { quotidienne: 'automatique (quotidienne)', manuelle: 'manuelle', 'avant-restauration': 'avant une restauration' };
  async function loadBackups() {
    const b = await api('/api/backups');
    $('keep').textContent = b.keep;
    $('backups').innerHTML = b.backups.map((x) => `<tr><td>${new Date(x.createdAt).toLocaleString('fr-FR')}</td>
      <td>${esc(REASONS[x.reason] ?? (x.reason.startsWith('avant-migration') ? 'avant une mise à jour de la base' : x.reason))}</td>
      <td class="num">${(x.size / 1048576).toFixed(1).replace('.', ',')} Mo</td>
      <td><button class="mini" data-restore="${esc(x.name)}">Restaurer</button></td></tr>`).join('')
      || '<tr><td colspan="4" class="muted">Aucune sauvegarde pour le moment.</td></tr>';
  }
  $('backupNow').onclick = async () => { await api('/api/backups/create', {}); loadBackups(); };
  $('backups').onclick = async (e) => {
    const b = e.target.closest('button[data-restore]');
    if (!b) return;
    if (!confirm(`Remplacer votre base actuelle par cette sauvegarde ?\n\nVotre base actuelle sera d'abord sauvegardée, vous pourrez revenir en arrière.`)) return;
    b.disabled = true;
    try {
      const r = await api('/api/backups/restore', { name: b.dataset.restore });
      alert(`Sauvegarde restaurée.${r.safety ? ` L'ancienne base a été gardée (${r.safety}).` : ''}`);
      location.reload();
    } catch (err) { alert(err.message); b.disabled = false; }
  };
  loadBackups();

  await refresh();
  const timer = setInterval(refresh, 1500);
  return () => clearInterval(timer);
}
