// Base SQLite locale (module node:sqlite intégré à Node.js, aucune compilation nécessaire).
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { backupDatabase } from './backup.js';

// Version du schéma : quand une base plus ancienne est ouverte, elle est sauvegardée avant d'être migrée.
export const SCHEMA_VERSION = 5;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Comptes suivis (chess.com / Lichess) ou joueurs rencontrés dans un PGN.
CREATE TABLE IF NOT EXISTS players (
  id            INTEGER PRIMARY KEY,
  source        TEXT NOT NULL,              -- chesscom | lichess
  username      TEXT NOT NULL,              -- en minuscules
  display_name  TEXT,
  tracked       INTEGER NOT NULL DEFAULT 1, -- 1 = synchronisé au lancement
  sync_cursor   INTEGER,                    -- Lichess : date (ms) de la dernière partie importée
  last_sync_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source, username)
);

-- Archives mensuelles chess.com déjà téléchargées (synchronisation incrémentale).
CREATE TABLE IF NOT EXISTS sync_archives (
  player_id   INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  year        INTEGER,
  month       INTEGER,
  etag        TEXT,
  game_count  INTEGER,
  complete    INTEGER NOT NULL DEFAULT 0,   -- 1 = mois terminé, plus jamais retéléchargé
  fetched_at  TEXT,
  PRIMARY KEY (player_id, url)
);

CREATE TABLE IF NOT EXISTS games (
  id            INTEGER PRIMARY KEY,
  source        TEXT NOT NULL,              -- chesscom | lichess | pgn
  source_id     TEXT NOT NULL,
  url           TEXT,
  pgn           TEXT NOT NULL,
  white_name    TEXT,
  black_name    TEXT,
  white_elo     INTEGER,
  black_elo     INTEGER,
  result        TEXT,                       -- 1-0 | 0-1 | 1/2-1/2
  termination   TEXT,
  time_control  TEXT,                       -- ex. 180+2
  time_class    TEXT,                       -- bullet | blitz | rapid | classical | daily
  base_seconds  INTEGER,
  increment_seconds INTEGER,
  rated         INTEGER,
  start_fen     TEXT,                       -- NULL = position initiale
  played_at     TEXT,                       -- date ISO
  end_time      INTEGER,                    -- secondes Unix (tri « plus récentes d'abord »)
  eco           TEXT,
  opening_name  TEXT,
  ply_count     INTEGER,
  parse_error   TEXT,
  imported_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source, source_id)
);
CREATE INDEX IF NOT EXISTS idx_games_end_time ON games(end_time DESC);

-- Lien joueur suivi <-> partie, avec sa couleur et son résultat.
CREATE TABLE IF NOT EXISTS player_games (
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  game_id   INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  color     TEXT NOT NULL,                  -- white | black
  outcome   TEXT,                           -- win | loss | draw
  PRIMARY KEY (player_id, game_id)
);
CREATE INDEX IF NOT EXISTS idx_player_games_game ON player_games(game_id);

-- Positions uniques, FEN normalisée (placement, trait, roques, prise en passant).
CREATE TABLE IF NOT EXISTS positions (
  id          INTEGER PRIMARY KEY,
  fen         TEXT NOT NULL UNIQUE,
  piece_count INTEGER
);

-- Coups de chaque partie (issus du PGN), avec les pendules %clk.
CREATE TABLE IF NOT EXISTS game_moves (
  game_id         INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  ply             INTEGER NOT NULL,         -- 1 = premier coup des Blancs
  color           TEXT NOT NULL,            -- w | b
  san             TEXT NOT NULL,
  uci             TEXT NOT NULL,
  fen_before      TEXT NOT NULL,            -- FEN complète avant le coup
  position_before INTEGER REFERENCES positions(id),
  position_after  INTEGER REFERENCES positions(id),
  clock_ms        INTEGER,                  -- temps restant après le coup (%clk)
  time_spent_ms   INTEGER,                  -- temps utilisé pour ce coup (si calculable)
  PRIMARY KEY (game_id, ply)
);

-- Cache d'évaluations par position. kind = 'multipv' ou 'move:<uci>' (coup évalué avec searchmoves).
CREATE TABLE IF NOT EXISTS evaluations (
  position_id  INTEGER NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  depth        INTEGER NOT NULL,            -- profondeur atteinte
  target_depth INTEGER NOT NULL,            -- profondeur demandée
  multipv      INTEGER NOT NULL,
  source       TEXT NOT NULL,               -- stockfish | lichess-cloud | tablebase
  lines        TEXT NOT NULL,               -- JSON, scores du point de vue du joueur au trait
  engine       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (position_id, kind)
);

-- Classement de chaque coup, pour chaque passe (quick = profondeur 12, deep = budget de nœuds ou profondeur 22).
CREATE TABLE IF NOT EXISTS move_analysis (
  game_id         INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  pass            TEXT NOT NULL,
  ply             INTEGER NOT NULL,
  best_uci        TEXT,
  best_san        TEXT,
  eval_best       TEXT,                     -- JSON {cp, mate, wdl} pour le joueur qui joue
  eval_played     TEXT,
  win_best        REAL,                     -- % de gain avec le meilleur coup (joueur qui joue)
  win_played      REAL,                     -- % de gain après le coup joué (joueur qui joue)
  win_second      REAL,                     -- % de gain avec le 2e coup du MultiPV
  win_white_after REAL,                     -- % de gain des Blancs après le coup (pour les courbes)
  loss            REAL,
  accuracy        REAL,
  classification  TEXT NOT NULL,
  source          TEXT,
  depth           INTEGER,
  PRIMARY KEY (game_id, pass, ply)
);

CREATE TABLE IF NOT EXISTS game_analysis (
  game_id        INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  pass           TEXT NOT NULL,
  depth          INTEGER,
  accuracy_white REAL,
  accuracy_black REAL,
  elo_white      INTEGER,
  elo_black      INTEGER,
  counts         TEXT,                      -- JSON : nombre de coups par catégorie et par couleur
  analyzed_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (game_id, pass)
);

-- File d'analyse persistante (reprise automatique après fermeture).
CREATE TABLE IF NOT EXISTS analysis_queue (
  game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  pass       TEXT NOT NULL,                 -- quick | deep
  status     TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | error
  priority   INTEGER NOT NULL DEFAULT 0,    -- > 0 : partie demandée en priorité
  error      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (game_id, pass)
);
CREATE INDEX IF NOT EXISTS idx_queue_status ON analysis_queue(status, pass);
`;

let db = null;
const statements = new Map();

// Requête préparée mise en cache (préparer une requête coûte cher quand on insère des milliers de coups).
export function stmt(sql) {
  let s = statements.get(sql);
  if (!s) { s = getDb().prepare(sql); statements.set(sql, s); }
  return s;
}

function currentVersion(d) {
  try {
    const row = d.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    return row ? Number(row.value) : 0;
  } catch {
    return null; // base neuve : pas encore de table meta
  }
}

export function openDb(file = config.dbPath) {
  if (db) return db;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existed = fs.existsSync(file) && fs.statSync(file).size > 0;
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const version = currentVersion(db);
  if (existed && version !== null && version < SCHEMA_VERSION) {
    // Sauvegarde avant toute migration de schéma.
    backupDatabase(db, `avant-migration-v${SCHEMA_VERSION}`);
  }
  db.exec(SCHEMA);
  migrate(db);
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('schema_version', String(SCHEMA_VERSION));
  return db;
}

// Ajoute les colonnes apparues dans les versions suivantes (les bases existantes sont conservées).
function migrate(d) {
  const has = (table, col) => d.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  const add = (table, col, type) => { if (!has(table, col)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); };
  // Étape 2 : ouverture selon la base lichess-org/chess-openings et sortie de la théorie.
  add('games', 'book_name', 'TEXT');
  add('games', 'book_eco', 'TEXT');
  add('games', 'book_exit_ply', 'INTEGER');
  add('games', 'book_done', 'INTEGER NOT NULL DEFAULT 0');
  add('analysis_queue', 'priority', 'INTEGER NOT NULL DEFAULT 0');
  // Optimisation : recherches à budget de nœuds (comme Lichess) au lieu d'une profondeur fixe.
  add('evaluations', 'nodes', 'INTEGER');
  // Profondeur réellement atteinte, vérification à profondeur fixe des coups douteux, durée des analyses.
  add('move_analysis', 'verified', 'INTEGER NOT NULL DEFAULT 0');
  add('game_analysis', 'depth_min', 'INTEGER');
  add('game_analysis', 'depth_max', 'INTEGER');
  add('game_analysis', 'verified', 'INTEGER');
  add('game_analysis', 'verify_depth', 'INTEGER');
  add('game_analysis', 'duration_ms', 'INTEGER');
  // Score du 2e coup du MultiPV (pour reclasser sans moteur avec n'importe quelle courbe de chances de gain).
  add('move_analysis', 'eval_second', 'TEXT');
  d.exec('CREATE INDEX IF NOT EXISTS idx_games_book ON games(book_name)');
}

export function getDb() {
  return db ?? openDb();
}

export function closeDb() {
  if (db) { statements.clear(); db.close(); db = null; }
}

export function transaction(fn) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const r = fn(d);
    d.exec('COMMIT');
    return r;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

export function getMeta(key, fallback = null) {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setMeta(key, value) {
  getDb().prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

// --- positions -------------------------------------------------------------

export function positionId(normFen, pieceCount) {
  const row = stmt('SELECT id FROM positions WHERE fen = ?').get(normFen);
  if (row) return row.id;
  return Number(stmt('INSERT INTO positions(fen, piece_count) VALUES (?, ?)').run(normFen, pieceCount).lastInsertRowid);
}

// --- cache d'évaluations ---------------------------------------------------

// Renvoie l'évaluation en cache si elle est au moins aussi profonde que demandé, ou issue d'une recherche
// avec au moins autant de nœuds (le nombre de lignes MultiPV est vérifié par l'appelant).
export function getCachedEval(posId, kind, depth, nodes = null) {
  const row = stmt('SELECT * FROM evaluations WHERE position_id = ? AND kind = ?').get(posId, kind);
  if (!row) return null;
  const deepEnough = Math.max(row.depth, row.target_depth) >= depth;
  const enoughNodes = nodes != null && row.nodes != null && row.nodes >= nodes;
  if (row.source !== 'tablebase' && !deepEnough && !enoughNodes) return null;
  return { ...row, lines: JSON.parse(row.lines) };
}

export function putEval(posId, kind, { depth, targetDepth, multipv, source, lines, engine, nodes = null }) {
  const old = stmt('SELECT depth, target_depth, multipv, source, nodes FROM evaluations WHERE position_id = ? AND kind = ?').get(posId, kind);
  // On ne remplace jamais une évaluation plus profonde (ou exacte) par une moins bonne,
  // sauf une recherche à budget de nœuds plus gros (pour qu'elle serve de cache la fois suivante).
  if (old) {
    const oldQ = old.source === 'tablebase' ? Infinity : Math.max(old.depth, old.target_depth);
    const newQ = source === 'tablebase' ? Infinity : Math.max(depth, targetDepth);
    const moreNodes = nodes != null && (old.nodes ?? 0) < nodes && old.source === 'stockfish';
    if (!moreNodes && (oldQ > newQ || (oldQ === newQ && old.multipv >= multipv))) return;
  }
  stmt(`INSERT INTO evaluations(position_id, kind, depth, target_depth, multipv, source, lines, engine, nodes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(position_id, kind) DO UPDATE SET depth = excluded.depth, target_depth = excluded.target_depth,
               multipv = excluded.multipv, source = excluded.source, lines = excluded.lines, engine = excluded.engine,
               nodes = excluded.nodes, created_at = datetime('now')`)
    .run(posId, kind, depth, targetDepth, multipv, source, JSON.stringify(lines), engine ?? null, nodes);
}
