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
    threads: 'auto', // "auto" = tous les cœurs (la file tourne en priorité basse), sinon cœurs - 2
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
    backgroundLowPriority: true, // la file d'analyse laisse la priorité au mode libre et aux autres logiciels
  },
  lichess: {
    cloudEval: true,
    cloudEvalMaxPly: 30,
    cloudEvalInQuickPass: false,
    tablebase: true,
    tablebaseMaxPieces: 7,
    timeoutMs: 6000,
    pauseAfterRateLimitSec: 60,
    pauseAfterErrorSec: 120,
  },
  classification: {
    // chesscom = seuils inspirés de chess.com (ci-dessous) ; lichess = seuils Lichess 5 / 10 / 15 %.
    // Se change aussi dans l'application (écran « Importer & file d'analyse »).
    preset: 'chesscom',
    bestMaxLoss: 0.1,
    // Seuils de perte (points de chances de gain) : < 2 excellent, < 5 bon, < 10 imprécision, < 20 erreur, sinon gaffe.
    // Les mêmes pour tous les niveaux : le niveau du joueur compte seulement dans le calcul des chances de gain.
    thresholds: { excellent: 2, good: 5, inaccuracy: 10, mistake: 20 },
    greatMinGap: 10,
    greatIgnoreRecaptures: true,
    brilliantMinSacrifice: 2,
    brilliantMaxLoss: 1,
    brilliantMaxWinBefore: 90,
  },
  accuracy: {
    uncertaintyBonus: 0,
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

export function loadConfig(file = process.env.CHESS_CONFIG || path.join(ROOT, 'config.json')) {
  const shared = readJson(file);
  const personal = readJson(localConfigPath());
  return resolve(deepMerge(deepMerge(DEFAULTS, shared), personal));
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
