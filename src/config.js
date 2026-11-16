// Chargement de la configuration (config.json à la racine du projet).
// Toutes les valeurs absentes de config.json prennent la valeur par défaut ci-dessous.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const APP_NAME = 'AnalyseEchecsLocal';
export const APP_VERSION = '0.1.0';

export const DEFAULTS = {
  port: 3737,
  openBrowser: true,
  // Mettez votre e-mail ou votre pseudo : chess.com et Lichess demandent un contact dans l'en-tête User-Agent.
  contact: '',
  autoSyncOnStart: true,
  // manual = seulement les parties choisies ; quick = passe rapide sur toutes ; auto = tout analyser.
  analysisMode: 'manual',
  engine: {
    threads: 'auto', // passe profonde : "auto" = tous les cœurs (la file tourne en priorité basse), sinon cœurs - 2
    // Recherches à profondeur fixe (passe rapide, mode libre, menace) : "auto" = 2. Plus de threads les ralentit
    // (mesuré sur un Ryzen 5 7520U : profondeur 12 → 3,5 fois plus lent avec 8 threads qu'avec 2 ; profondeur 18 → 1,7 fois).
    quickThreads: 'auto',
    hashMB: 'auto', // "auto" = 1024 Mo si l'ordinateur a au moins 12 Go de mémoire, 512 si 6 Go, sinon 256
    deepNodes: 1500000, // passe profonde : budget de positions calculées par coup (comme Lichess) ; 0 = profondeur fixe deepDepth
    deepNodesCritical: 0, // > 0 : budget des coups douteux (perte ≥ 2 %), recalculés plus profondément (désactivé : peu utile mesuré)
    deepSkipDecided: 97, // passe profonde : on garde l'analyse rapide si la partie est déjà jouée (≥ 97 % ou ≤ 3 %)
    multiPV: 2,
    quickDepth: 12,
    deepDepth: 22,
    // Vérification : les coups classés erreur, gaffe, occasion manquée, très bon ou brillant sont recalculés
    // à cette vraie profondeur (sans limite de nœuds) puis reclassés. 0 = pas de vérification.
    verifyDepth: 22,
    maxSecondsPerPosition: 300,
    liveDepth: 18, // mode libre : profondeur de l'analyse en direct
    threatDepth: 16, // aide « Menace » sur l'échiquier : profondeur du calcul (rapide, la position change souvent)
    backgroundLowPriority: true, // la file d'analyse laisse la priorité au mode libre et aux autres logiciels
  },
  lichess: {
    cloudEval: true,
    cloudEvalMaxPly: 30,
    cloudEvalInQuickPass: false,
    tablebase: true,
    tablebaseMaxPieces: 7,
    // Passe rapide : pas de requête aux tables de finales (une requête réseau par position, l'une après l'autre ;
    // Stockfish règle ces positions en quelques millisecondes). La passe profonde les utilise toujours.
    tablebaseInQuickPass: false,
    timeoutMs: 6000,
    pauseAfterRateLimitSec: 60,
    pauseAfterErrorSec: 120,
  },
  classification: {
    // Méthode de classement des coups : lichess = règles exactes de Lichess ; chesscom = style chess.com (réglages
    // ci-dessous). Se change aussi dans l'application, qui retient le choix.
    method: 'lichess',
    // ---- Style chess.com (les réglages ajustés sur vos bilans chess.com sont dans data/style-chesscom.json) ----
    // Points attendus = 100 / (1 + e^(−k × évaluation en pions)), k = k1500 × e^(eloSlope × (Elo − 1500) / 1000) :
    // à faible niveau, un même avantage vaut moins. Valeurs de départ ajustées sur la base ouverte de Lichess
    // (resources/expected-points.json) ; Elo borné entre eloMin et eloMax.
    curve: { k1500: 0.2211, eloSlope: 0.4667, eloMin: 100, eloMax: 3000 },
    bestMaxLoss: 0.1,
    // Seuils publiés par chess.com (points attendus perdus) : ≤ 2 excellent, ≤ 5 bon, ≤ 10 imprécision, ≤ 20 erreur,
    // au-delà gaffe. Les mêmes pour tous les niveaux : le niveau compte seulement dans les points attendus.
    thresholds: { excellent: 2, good: 5, inaccuracy: 10, mistake: 20 },
    // Occasion manquée : position gagnante dès « winning » points attendus ; le coup adverse m'a fait gagner au moins
    // minGain points (ou le gain vient d'apparaître) ; mon coup perd au moins minLoss points et me fait repasser sous
    // le seuil gagnant (ou perd au moins winningLoss points après une erreur adverse).
    miss: { winning: 70, minGain: 10, minLoss: 5, winningLoss: 10 },
    // Brillant : bon sacrifice de pièce (matériel net donné selon l'échange statique, en points).
    brilliant: { minSacrifice: 2, maxLoss: 2, minAfter: 45, maxAlternative: 90 },
    // Très bon : coup décisif (change l'issue : perdant → égal, égal → gagnant) ou seul bon coup.
    great: { maxLoss: 1, minGap: 15, ignoreRecaptures: true },
    // Plus généreux pour les joueurs de moins de 1400 Elo.
    lowElo: { below: 1400, brilliant: { maxLoss: 5, minAfter: 40, maxAlternative: 95 }, great: { maxLoss: 2, minGap: 10 } },
  },
  accuracy: {
    // Précision Lichess : +1 à la précision de chaque coup imparfait (« bonus d'incertitude » de Lichess).
    uncertaintyBonus: 1,
    // Précision style chess.com (approximation, leur formule n'est pas publiée), à partir des points attendus perdus :
    // par coup scale × e^(−decay × perte) − (scale − 100) ; partie (1 − harmonicWeight) × moyenne + harmonicWeight ×
    // moyenne harmonique. Valeurs de départ : la formule de Lichess.
    chesscom: { decay: 0.04354, scale: 103.1668, harmonicWeight: 0.5 },
  },
  elo: {
    minMoves: 8,
    calibrate: true, // recentre l'Elo estimé sur votre niveau réel (voir README)
    calibrationMinPoints: 15, // nombre minimum de joueurs-parties pour calibrer une cadence
    table: [
      [0, 100], [40, 400], [55, 800], [65, 1100], [72, 1350], [78, 1600],
      [83, 1850], [87, 2100], [90, 2350], [93, 2600], [96, 2850], [100, 3200],
    ],
  },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, over) {
  if (!isPlainObject(over)) return structuredClone(base);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) {
    if (k.startsWith('_')) continue; // clés de commentaire
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = structuredClone(v);
  }
  return out;
}

function resolve(cfg) {
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  const t = cfg.engine.threads;
  cfg.engine.threadsResolved = t === 'auto' || !Number.isFinite(Number(t))
    ? (cfg.engine.backgroundLowPriority !== false ? cores : Math.max(1, cores - 2))
    : Math.max(1, Math.min(cores, Math.floor(Number(t))));
  const qt = cfg.engine.quickThreads;
  cfg.engine.quickThreadsResolved = qt === 'auto' || !Number.isFinite(Number(qt))
    ? Math.min(2, cores)
    : Math.max(1, Math.min(cores, Math.floor(Number(qt))));
  const ramGB = os.totalmem() / 1024 ** 3;
  cfg.engine.hashMB = cfg.engine.hashMB === 'auto' || !Number.isFinite(Number(cfg.engine.hashMB))
    ? (ramGB >= 12 ? 1024 : ramGB >= 6 ? 512 : 256)
    : Math.max(16, Math.floor(Number(cfg.engine.hashMB)));
  cfg.engine.deepNodes = Math.max(0, Math.floor(Number(cfg.engine.deepNodes) || 0));
  cfg.engine.deepNodesCritical = Math.max(0, Math.floor(Number(cfg.engine.deepNodesCritical) || 0));
  cfg.engine.deepSkipDecided = Math.min(100, Math.max(50, Number(cfg.engine.deepSkipDecided) || 100));
  cfg.engine.multiPV = Math.max(2, Math.floor(Number(cfg.engine.multiPV) || 2));
  cfg.engine.verifyDepth = Math.max(0, Math.min(40, Math.floor(Number(cfg.engine.verifyDepth) || 0)));
  cfg.engine.liveDepth = Math.max(8, Math.floor(Number(cfg.engine.liveDepth) || 18));
  cfg.engine.threatDepth = Math.max(8, Math.min(30, Math.floor(Number(cfg.engine.threatDepth) || 16)));
  cfg.dataDir = process.env.CHESS_DATA_DIR || cfg.dataDir || path.join(ROOT, 'data');
  cfg.engineDir = process.env.CHESS_ENGINE_DIR || cfg.engineDir || path.join(ROOT, 'data', 'engine');
  cfg.dbPath = process.env.CHESS_DB || path.join(cfg.dataDir, 'echecs.sqlite');
  return cfg;
}

function readJson(file) {
  if (!file || !fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${path.basename(file)} illisible (${e.message}). Vérifiez les virgules et les guillemets.`);
  }
}

// Réglages personnels (e-mail de contact…) : config.local.json, jamais publié, écrase config.json.
export function localConfigPath() {
  if (process.env.CHESS_CONFIG_LOCAL !== undefined) return process.env.CHESS_CONFIG_LOCAL || null;
  return process.env.CHESS_CONFIG ? null : path.join(ROOT, 'config.local.json');
}

// Réglages du style chess.com ajustés sur vos parties (npm run ajuster-chesscom) : data/style-chesscom.json.
// Seuls la courbe (classification.curve) et la précision (accuracy.chesscom) sont lus dans ce fichier.
export const styleFilePath = (dataDir) => path.join(dataDir, 'style-chesscom.json');
export function readStyleFile(dataDir) {
  const f = readJson(styleFilePath(dataDir));
  const out = {};
  if (isPlainObject(f.curve)) out.classification = { curve: f.curve };
  if (isPlainObject(f.accuracy)) out.accuracy = { chesscom: f.accuracy };
  return out;
}

export function loadConfig(file = process.env.CHESS_CONFIG || path.join(ROOT, 'config.json')) {
  const shared = readJson(file);
  const personal = readJson(localConfigPath());
  const merged = resolve(deepMerge(deepMerge(DEFAULTS, shared), personal));
  return resolve(deepMerge(merged, readStyleFile(merged.dataDir)));
}

// Configuration partagée (modifiable par les tests via overrideConfig).
export const config = loadConfig();

export function overrideConfig(partial) {
  const merged = resolve(deepMerge(config, partial));
  for (const k of Object.keys(config)) delete config[k];
  Object.assign(config, merged);
  return config;
}

export function userAgent() {
  const contact = String(config.contact || '').trim();
  return contact
    ? `${APP_NAME}/${APP_VERSION} (analyse personnelle hors ligne; contact: ${contact})`
    : `${APP_NAME}/${APP_VERSION} (analyse personnelle hors ligne; contact non renseigne dans config.json)`;
}
