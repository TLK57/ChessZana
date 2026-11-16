// Ajuste les courbes de « points espérés » selon le niveau (npm run fit-curves).
//
// Source : base ouverte de Lichess (https://database.lichess.org, licence CC0), un fichier mensuel lu EN FLUX :
// rien n'est enregistré sur le disque, la lecture s'arrête dès que l'échantillon est atteint.
// On garde les parties blitz et rapides qui ont des évaluations [%eval]. Pour chaque position évaluée, on note
// l'Elo du joueur au trait, l'évaluation de son point de vue et son score final (1, ½ ou 0).
//
// Pour chaque cadence (blitz, rapide) et chaque tranche de 100 Elo (600 à 2400), on ajuste une courbe logistique :
//   score espéré = 1 / (1 + e^−(a + b × évaluation en pions))
// Les mats sont traités à part (score moyen observé quand le joueur au trait a un mat, ou en subit un).
// Une partie sur cinq est mise de côté pour la validation (comparaison avec la courbe Lichess actuelle).
//
// Options : --month 2026-09 (fichier mensuel), --games 220000 (parties blitz + rapides avec évaluations),
//           --chart-only (refait seulement le graphique à partir de resources/expected-points.json).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable, Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'resources', 'expected-points.json');
const CHART = path.join(ROOT, 'docs', 'courbes-chances.svg');
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };

export const BIN_START = 600;
export const BIN_END = 2400; // tranches [600, 700[ … [2300, 2400[
export const CP_CLAMP = 1500; // au-delà de ±15 pions, la partie est jouée
const BUCKET = 10; // évaluations regroupées par 10 centipions (ajustement exact sur les données regroupées)
const NB = (2 * CP_CLAMP) / BUCKET + 1;
const TCS = ['blitz', 'rapid'];
const LICHESS_K = 0.00368208;
const lichessP = (cp) => 1 / (1 + Math.exp(-LICHESS_K * cp)); // courbe Lichess, en score (0–1)

// Cadence Lichess d'après la pendule : durée estimée = base + 40 × incrément.
export function speedOf(tc) {
  const m = /^(\d+)\+(\d+)$/.exec(tc ?? '');
  if (!m) return null;
  const est = Number(m[1]) + 40 * Number(m[2]);
  return est < 180 ? 'bullet' : est < 480 ? 'blitz' : est < 1500 ? 'rapid' : 'classical';
}

const binOf = (elo) => (elo >= BIN_START && elo < BIN_END ? Math.floor((elo - BIN_START) / 100) : -1);
const NBINS = (BIN_END - BIN_START) / 100;

function emptyAcc() {
  const make = () => ({ n: new Float64Array(NB), s: new Float64Array(NB), mateWin: { n: 0, s: 0 }, mateLoss: { n: 0, s: 0 } });
  const acc = {};
  for (const set of ['fit', 'val']) {
    acc[set] = {};
    for (const tc of TCS) acc[set][tc] = Array.from({ length: NBINS }, make);
  }
  return acc;
}

/** Évaluations d'une partie au format Lichess : [{ ply, cp }] ou [{ ply, mate }] du point de vue des Blancs. */
export function parseEvals(movetext) {
  const out = [];
  const re = /\[%eval ([^\]\s]+)\]/g;
  let m;
  let ply = 0;
  // Chaque évaluation suit un coup : on compte les coups dans l'ordre (un commentaire par coup).
  const tokens = movetext.split(/(\{[^}]*\})/);
  for (const t of tokens) {
    if (t.startsWith('{')) {
      re.lastIndex = 0;
      m = re.exec(t);
      if (m && ply > 0) {
        const v = m[1];
        if (v.startsWith('#')) out.push({ ply, mate: Number(v.slice(1)) });
        else out.push({ ply, cp: Math.round(Number(v) * 100) });
      }
    } else {
      for (const w of t.trim().split(/\s+/)) if (w && !/^\d+\.+$/.test(w) && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(w)) ply++;
    }
  }
  return out;
}

// Ajoute les positions d'une partie aux tableaux (set = 'fit' ou 'val').
export function addGame(acc, set, { whiteElo, blackElo, result, tc, evals }) {
  const scoreW = result === '1-0' ? 1 : result === '0-1' ? 0 : 0.5;
  let used = 0;
  for (const e of evals) {
    const stm = e.ply % 2 === 1 ? 'b' : 'w'; // après le coup n° ply : trait aux Noirs si ply est impair
    const bin = binOf(stm === 'w' ? whiteElo : blackElo);
    if (bin < 0) continue;
    const s = stm === 'w' ? scoreW : 1 - scoreW;
    const a = acc[set][tc][bin];
    if (e.mate != null) {
      const mate = stm === 'w' ? e.mate : -e.mate;
      const box = mate > 0 ? a.mateWin : a.mateLoss;
      box.n++; box.s += s;
    } else {
      const cp = Math.max(-CP_CLAMP, Math.min(CP_CLAMP, stm === 'w' ? e.cp : -e.cp));
      const k = Math.round((cp + CP_CLAMP) / BUCKET);
      a.n[k]++; a.s[k] += s;
    }
    used++;
  }
  return used;
}

/**
 * Courbe à deux paramètres du style chess.com (config.classification.curve) tirée des courbes par tranche :
 * pente k = k1500 × e^(eloSlope × (Elo − 1500) / 1000), ajustée par moindres carrés sur ln(b) (blitz et rapide,
 * centres des tranches, poids = racine du nombre de positions). Ce sont les valeurs de départ de config.json.
 */
export function curveParamsFromTable(data) {
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const bins of Object.values(data.curves)) {
    for (const c of bins) {
      const x = (c.elo + 50 - 1500) / 1000, y = Math.log(c.b), w = Math.sqrt(c.positions);
      sw += w; sx += w * x; sy += w * y; sxx += w * x * x; sxy += w * x * y;
    }
  }
  const eloSlope = (sw * sxy - sx * sy) / (sw * sxx - sx * sx);
  const k1500 = Math.exp((sy - eloSlope * sx) / sw);
  return { k1500: Math.round(k1500 * 1e4) / 1e4, eloSlope: Math.round(eloSlope * 1e4) / 1e4 };
}

/**
 * Régression logistique sur des données regroupées (x en pions), par la méthode de Newton avec pas contrôlé
 * (chaque pas doit réduire l'écart) et un léger rappel vers la courbe Lichess (a = 0, b = 0,368 par pion),
 * équivalent à quelques dizaines de positions : sans effet quand une tranche a beaucoup de données, il évite
 * des coefficients absurdes quand elle en a peu (quelques parties peuvent « séparer » parfaitement gains et pertes).
 */
export const PRIOR = { a: 0, b: LICHESS_K * 100, weight: 20 };
export function fitLogistic(n, s) {
  const objective = (a, b) => {
    let f = (PRIOR.weight / 2) * ((a - PRIOR.a) ** 2 + (b - PRIOR.b) ** 2);
    for (let k = 0; k < NB; k++) {
      if (!n[k]) continue;
      const z = a + b * ((k * BUCKET - CP_CLAMP) / 100);
      // −log-vraisemblance stable numériquement : n·log(1 + e^z) − s·z
      f += n[k] * (z > 0 ? z + Math.log1p(Math.exp(-z)) : Math.log1p(Math.exp(z))) - s[k] * z;
    }
    return f;
  };
  let a = PRIOR.a, b = PRIOR.b;
  let f = objective(a, b);
  for (let it = 0; it < 100; it++) {
    let g0 = PRIOR.weight * (a - PRIOR.a), g1 = PRIOR.weight * (b - PRIOR.b), h00 = PRIOR.weight, h01 = 0, h11 = PRIOR.weight;
    for (let k = 0; k < NB; k++) {
      if (!n[k]) continue;
      const x = (k * BUCKET - CP_CLAMP) / 100;
      const p = 1 / (1 + Math.exp(-(a + b * x)));
      const r = n[k] * p - s[k];
      g0 += r; g1 += r * x;
      const w = n[k] * p * (1 - p);
      h00 += w; h01 += w * x; h11 += w * x * x;
    }
    const det = h00 * h11 - h01 * h01;
    if (!(det > 0)) break;
    const da = (h11 * g0 - h01 * g1) / det;
    const db = (h00 * g1 - h01 * g0) / det;
    let step = 1;
    let na = a - da, nb = b - db, nf = objective(na, nb);
    while (nf > f && step > 1e-6) { step /= 2; na = a - step * da; nb = b - step * db; nf = objective(na, nb); }
    if (nf > f) break;
    const moved = Math.abs(na - a) + Math.abs(nb - b);
    a = na; b = nb; f = nf;
    if (moved < 1e-10) break;
  }
  return { a, b };
}

/**
 * Les fichiers de Lichess sont au format « pzstd » : chaque bloc compressé est précédé d'un bloc « à ignorer »
 * (magic 0x184D2A5?) de 4 octets qui donne sa taille. Le décompresseur de Node ne connaît pas ces blocs : on les
 * retire et on ne transmet que les blocs compressés.
 */
export function stripSkippableFrames() {
  let pending = Buffer.alloc(0);
  let forward = 0; // octets du bloc compressé en cours à transmettre tels quels
  return new Transform({
    transform(chunk, _enc, cb) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
      const out = [];
      for (;;) {
        if (forward > 0) {
          const n = Math.min(forward, pending.length);
          if (!n) break;
          out.push(pending.subarray(0, n));
          pending = pending.subarray(n);
          forward -= n;
          continue;
        }
        if (pending.length < 8) break;
        const magic = pending.readUInt32LE(0);
        if ((magic & 0xFFFFFFF0) === 0x184D2A50) {
          const size = pending.readUInt32LE(4);
          if (pending.length < 8 + size) break;
          // pzstd : la charge de 4 octets donne la taille du bloc compressé qui suit.
          forward = size === 4 ? pending.readUInt32LE(8) : 0;
          pending = pending.subarray(8 + size);
          if (!forward) continue;
        } else {
          // Bloc compressé sans en-tête de taille : on transmet tout le reste.
          forward = Infinity;
        }
      }
      cb(null, out.length ? Buffer.concat(out) : undefined);
    },
  });
}

async function readLichess(month, target, acc) {
  const url = `https://database.lichess.org/standard/lichess_db_standard_rated_${month}.pgn.zst`;
  console.log(`Lecture en flux de ${url}\n(arrêt dès ${target} parties blitz et rapides avec évaluations)`);
  const ctrl = new AbortController();
  const res = await fetch(url, { headers: { 'User-Agent': 'ChessZana (ajustement des courbes)' }, signal: ctrl.signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} pour ${url}`);
  const source = Readable.fromWeb(res.body);
  const stream = source.pipe(stripSkippableFrames()).pipe(zlib.createZstdDecompress());
  stream.on('error', () => {}); // l'arrêt volontaire du téléchargement n'est pas une erreur
  const dec = new StringDecoder('utf8');
  const stats = { gamesRead: 0, gamesWithEval: 0, used: { blitz: 0, rapid: 0 }, positions: { fit: 0, val: 0 }, bytes: 0 };
  let headers = {};
  let buf = '';
  let done = false;
  const t0 = Date.now();
  const onLine = (line) => {
    if (line.startsWith('[')) {
      const m = /^\[(\w+) "(.*)"\]$/.exec(line);
      if (m) headers[m[1]] = m[2];
      return;
    }
    if (!line.trim()) return;
    // Ligne des coups : fin de la partie.
    stats.gamesRead++;
    const h = headers;
    headers = {};
    const tc = speedOf(h.TimeControl);
    if (!TCS.includes(tc) || !line.includes('[%eval') || !['1-0', '0-1', '1/2-1/2'].includes(h.Result)) return;
    const whiteElo = Number(h.WhiteElo);
    const blackElo = Number(h.BlackElo);
    if (!whiteElo || !blackElo) return;
    stats.gamesWithEval++;
    const set = stats.gamesWithEval % 5 === 0 ? 'val' : 'fit';
    stats.positions[set] += addGame(acc, set, { whiteElo, blackElo, result: h.Result, tc, evals: parseEvals(line) });
    stats.used[tc]++;
    if (stats.gamesWithEval % 20000 === 0) {
      console.log(`  ${stats.gamesWithEval} parties avec évaluations (${stats.gamesRead} lues, ${(stats.bytes / 1e9).toFixed(1)} Go décompressés, ${Math.round((Date.now() - t0) / 1000)} s)`);
    }
    if (stats.gamesWithEval >= target) done = true;
  };
  try {
    for await (const chunk of stream) {
      stats.bytes += chunk.length;
      buf += dec.write(chunk);
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        onLine(buf.slice(0, i).replace(/\r$/, ''));
        buf = buf.slice(i + 1);
        if (done) break;
      }
      if (done) break;
    }
  } finally {
    ctrl.abort();
    source.destroy();
    stream.destroy();
  }
  stats.seconds = Math.round((Date.now() - t0) / 1000);
  return { url, stats };
}

function validate(acc, curves) {
  const clampP = (p) => Math.min(1 - 1e-6, Math.max(1e-6, p));
  const NC = 20; // étalonnage : 20 tranches de probabilité prédite
  const calib = { nouvelle: Array.from({ length: NC }, () => ({ n: 0, p: 0, o: 0 })), lichess: Array.from({ length: NC }, () => ({ n: 0, p: 0, o: 0 })) };
  const tot = { n: 0, nouvelle: 0, lichess: 0 };
  const byBin = [];
  for (const tc of TCS) {
    acc.val[tc].forEach((a, bin) => {
      const c = curves[tc][bin];
      const row = { tc, elo: BIN_START + bin * 100, n: 0, nouvelle: 0, lichess: 0 };
      for (let k = 0; k < NB; k++) {
        const n = a.n[k];
        if (!n) continue;
        const s = a.s[k];
        const cp = k * BUCKET - CP_CLAMP;
        const models = { nouvelle: clampP(1 / (1 + Math.exp(-(c.a + c.b * cp / 100)))), lichess: clampP(lichessP(cp)) };
        for (const [name, p] of Object.entries(models)) {
          const ll = -(s * Math.log(p) + (n - s) * Math.log(1 - p));
          row[name] += ll; tot[name] += ll;
          const cb = calib[name][Math.min(NC - 1, Math.floor(p * NC))];
          cb.n += n; cb.p += p * n; cb.o += s;
        }
        row.n += n; tot.n += n;
      }
      if (row.n) byBin.push({ tc, elo: row.elo, positions: row.n, logLossNouvelle: row.nouvelle / row.n, logLossLichess: row.lichess / row.n });
    });
  }
  const cal = (arr) => arr.filter((b) => b.n >= 200).map((b) => ({ predit: b.p / b.n, observe: b.o / b.n, positions: b.n }));
  const ece = (arr) => arr.reduce((x, b) => x + (b.n ? Math.abs(b.p - b.o) : 0), 0) / arr.reduce((x, b) => x + b.n, 0);
  return {
    positions: tot.n,
    logLoss: { nouvelle: tot.nouvelle / tot.n, lichess: tot.lichess / tot.n },
    // Écart moyen entre score prédit et score observé (pondéré par le nombre de positions).
    ecartEtalonnage: { nouvelle: ece(calib.nouvelle), lichess: ece(calib.lichess) },
    etalonnage: { nouvelle: cal(calib.nouvelle), lichess: cal(calib.lichess) },
    parTranche: byBin,
  };
}

// ------------------------------------------------------------------ graphique (SVG autonome, clair et sombre)
function chart(data) {
  const W = 960, H = 420, P = { l: 56, r: 84, t: 46, b: 52 }, gap = 70;
  const pw = (W - P.l - P.r - gap) / 2, ph = H - P.t - P.b;
  const x1 = (v) => P.l + v * pw, y = (v) => P.t + (1 - v) * ph;
  const x2o = P.l + pw + gap;
  const fmt = (v) => `${Math.round(v * 100)} %`;
  const grid = (ox, xs, xl) => [0, 0.25, 0.5, 0.75, 1].map((v) => `<line class="grid" x1="${ox}" x2="${ox + pw}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${ox - 8}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`).join('')
    + xs.map((v, i) => `<text class="axis" x="${ox + ((v - xs[0]) / (xs.at(-1) - xs[0])) * pw}" y="${H - P.b + 18}" text-anchor="middle">${xl[i]}</text>`).join('');
  // Panneau 1 : étalonnage sur les parties mises de côté.
  const line = (pts, cls, xf) => `<path class="${cls}" d="M${pts.map((p) => `${xf(p.predit).toFixed(1)},${y(p.observe).toFixed(1)}`).join(' L')}"/>`
    + pts.map((p) => `<circle class="${cls}-dot" cx="${xf(p.predit).toFixed(1)}" cy="${y(p.observe).toFixed(1)}" r="4"><title>prédit ${fmt(p.predit)}, observé ${fmt(p.observe)} (${p.positions} positions)</title></circle>`).join('');
  const cal = data.validation.etalonnage;
  const p1 = `<line class="ref" x1="${x1(0)}" y1="${y(0)}" x2="${x1(1)}" y2="${y(1)}"/>${line(cal.lichess, 's2', x1)}${line(cal.nouvelle, 's1', x1)}`;
  // Panneau 2 : la même évaluation ne vaut pas la même chose selon le niveau (blitz).
  const evalMax = 6;
  const x2 = (pawns) => x2o + ((pawns + evalMax) / (2 * evalMax)) * pw;
  const curvePts = (a, b) => Array.from({ length: 61 }, (_, i) => -evalMax + i * 0.2).map((e) => `${x2(e).toFixed(1)},${y(1 / (1 + Math.exp(-(a + b * e)))).toFixed(1)}`).join(' L');
  const levels = [[900, 'e1'], [1500, 'e2'], [2100, 'e3']];
  const blitz = data.curves.blitz;
  // Étiquettes au bout des courbes, écartées d'au moins 14 px.
  const ends = levels.map(([elo, cls]) => {
    const c = blitz.find((b) => b.elo === elo) ?? blitz[0];
    return { elo, cls, c, y: y(1 / (1 + Math.exp(-(c.a + c.b * evalMax)))) + 4 };
  }).sort((p, q) => p.y - q.y);
  for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 14);
  const p2 = ends.map(({ elo, cls, c, y: ly }) => `<path class="${cls}" d="M${curvePts(c.a, c.b)}"/><text class="lbl" x="${x2(evalMax) + 6}" y="${ly.toFixed(1)}">${elo}–${elo + 99}</text>`).join('') + `<path class="s2 dash" d="M${Array.from({ length: 61 }, (_, i) => -evalMax + i * 0.2).map((e) => `${x2(e).toFixed(1)},${y(lichessP(e * 100)).toFixed(1)}`).join(' L')}"/>`;
  const ll = data.validation.logLoss;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" role="img" aria-label="Validation des courbes de chances de gain">
<style>
  .bg { fill: #fcfcfb } .t { fill: #1f2328; font-size: 15px; font-weight: 600 } .st { fill: #6b7078; font-size: 12px } .axis { fill: #6b7078; font-size: 11px }
  .lbl { fill: #1f2328; font-size: 12px } .grid { stroke: #e7e6e2; stroke-width: 1 } .ref { stroke: #9a9a96; stroke-width: 1; stroke-dasharray: 4 4 }
  .s1 { fill: none; stroke: #2a78d6; stroke-width: 2 } .s2 { fill: none; stroke: #eb6834; stroke-width: 2 } .dash { stroke-dasharray: 6 4 }
  .s1-dot { fill: #2a78d6; stroke: #fcfcfb; stroke-width: 2 } .s2-dot { fill: #eb6834; stroke: #fcfcfb; stroke-width: 2 }
  .e1 { fill: none; stroke: #9cc3f0; stroke-width: 2 } .e2 { fill: none; stroke: #2a78d6; stroke-width: 2 } .e3 { fill: none; stroke: #154a8c; stroke-width: 2 }
  @media (prefers-color-scheme: dark) {
    .bg { fill: #1a1a19 } .t, .lbl { fill: #e6e6e3 } .st, .axis { fill: #9aa0a7 } .grid { stroke: #33373c } .ref { stroke: #6b7078 }
    .s1 { stroke: #3987e5 } .s2 { stroke: #d95926 } .s1-dot { fill: #3987e5; stroke: #1a1a19 } .s2-dot { fill: #d95926; stroke: #1a1a19 }
    .e1 { stroke: #2f5f99 } .e2 { stroke: #3987e5 } .e3 { stroke: #a9cdf5 }
  }
</style>
<rect class="bg" width="${W}" height="${H}" rx="8"/>
<text class="t" x="${P.l}" y="22">Étalonnage sur ${data.validation.positions.toLocaleString('fr-FR')} positions mises de côté</text>
<text class="st" x="${P.l}" y="38">Score observé selon le score prédit. Parfait = sur la diagonale.</text>
<text class="t" x="${x2o}" y="22">Blitz : même évaluation, niveau différent</text>
<text class="st" x="${x2o}" y="38">Score espéré du joueur au trait selon l'évaluation (pions)</text>
${grid(P.l, [0, 0.5, 1], ['0 %', '50 %', '100 % prédit'])}${grid(x2o, [-6, -3, 0, 3, 6], ['−6', '−3', '0', '+3', '+6 pions'])}
${p1}${p2}
<g class="lbl"><line class="s1" x1="${P.l}" x2="${P.l + 22}" y1="${H - 12}" y2="${H - 12}"/><text class="lbl" x="${P.l + 28}" y="${H - 8}">Nouvelle courbe (perte logarithmique ${ll.nouvelle.toFixed(4).replace('.', ',')})</text>
<line class="s2" x1="${P.l + 330}" x2="${P.l + 352}" y1="${H - 12}" y2="${H - 12}"/><text class="lbl" x="${P.l + 358}" y="${H - 8}">Courbe Lichess actuelle (${ll.lichess.toFixed(4).replace('.', ',')})</text>
<line class="s2 dash" x1="${P.l + 640}" x2="${P.l + 662}" y1="${H - 12}" y2="${H - 12}"/><text class="lbl" x="${P.l + 668}" y="${H - 8}">Lichess, tous niveaux</text></g>
</svg>
`;
}

async function main() {
  if (process.argv.includes('--chart-only')) {
    const data = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    fs.mkdirSync(path.dirname(CHART), { recursive: true });
    fs.writeFileSync(CHART, chart(data));
    console.log(`Graphique refait : ${CHART}`);
    return;
  }
  const month = arg('month', '2026-09');
  const target = Number(arg('games', 220000));
  const acc = emptyAcc();
  const { url, stats } = await readLichess(month, target, acc);
  console.log(`Lecture terminée : ${stats.gamesWithEval} parties avec évaluations sur ${stats.gamesRead} lues (${stats.seconds} s).`);
  const curves = {};
  for (const tc of TCS) {
    curves[tc] = acc.fit[tc].map((a, bin) => {
      const positions = a.n.reduce((x, v) => x + v, 0);
      const { a: ia, b } = positions ? fitLogistic(a.n, a.s) : { a: 0, b: 0.4 };
      const round = (v) => Math.round(v * 1e5) / 1e5;
      return {
        elo: BIN_START + bin * 100, a: round(ia), b: round(b), positions,
        mateWin: a.mateWin.n ? round(a.mateWin.s / a.mateWin.n) : 1, mateLoss: a.mateLoss.n ? round(a.mateLoss.s / a.mateLoss.n) : 0,
      };
    });
  }
  const data = {
    _aide: "Courbes de points espérés par cadence et par tranche de 100 Elo (npm run fit-curves). Score espéré du joueur au trait = 1 / (1 + e^-(a + b × évaluation en pions)) ; évaluation bornée à ±15 pions ; mats : score moyen observé.",
    source: url,
    licence: 'CC0 (base ouverte de Lichess)',
    month,
    date: new Date().toISOString().slice(0, 10),
    sample: { gamesRead: stats.gamesRead, gamesWithEval: stats.gamesWithEval, gamesByTimeClass: stats.used, positions: stats.positions, holdout: '1 partie sur 5' },
    model: { formula: 'score = 1 / (1 + exp(-(a + b * cp / 100)))', cpClamp: CP_CLAMP, eloBins: `${BIN_START}-${BIN_END} par 100` },
    curves,
  };
  data.validation = validate(acc, curves);
  fs.writeFileSync(OUT, `${JSON.stringify(data, null, 1)}\n`);
  fs.mkdirSync(path.dirname(CHART), { recursive: true });
  fs.writeFileSync(CHART, chart(data));
  const v = data.validation;
  console.log(`\nValidation (${v.positions} positions mises de côté) :`);
  console.log(`  perte logarithmique : nouvelle ${v.logLoss.nouvelle.toFixed(4)}, Lichess ${v.logLoss.lichess.toFixed(4)}`);
  console.log(`  écart d'étalonnage  : nouvelle ${(100 * v.ecartEtalonnage.nouvelle).toFixed(2)} points, Lichess ${(100 * v.ecartEtalonnage.lichess).toFixed(2)} points`);
  console.log(`Écrit : ${OUT}\n       ${CHART}`);
  const p = curveParamsFromTable(data);
  console.log(`Courbe du style chess.com (config.json, classification.curve) : k1500 = ${p.k1500}, eloSlope = ${p.eloSlope}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`Erreur : ${e.message}`); process.exit(1); });
}
