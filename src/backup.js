// Sauvegardes de la base SQLite : automatiques (au démarrage si la dernière a plus de 24 h, avant toute
// migration de schéma), manuelles, export et restauration. On garde les 7 dernières.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { closeDb, getDb, openDb } from './db.js';

export const KEEP = 7;
const DAY = 24 * 3600 * 1000;
const NAME_RE = /^echecs-(\d{8})-(\d{6})(?:-([a-z0-9-]+))?\.sqlite$/;

export const backupDir = () => path.join(path.dirname(config.dbPath), 'backups');

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'manuelle';
const sqlString = (s) => `'${s.replace(/'/g, "''")}'`;

/** Sauvegardes existantes, la plus récente d'abord. */
export function listBackups() {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map((name) => ({ name, m: NAME_RE.exec(name) }))
    .filter(({ m }) => m)
    .map(({ name, m }) => {
      const st = fs.statSync(path.join(dir, name));
      return { name, size: st.size, createdAt: st.mtime.toISOString(), reason: m[3] ?? 'manuelle' };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name));
}

function prune() {
  for (const b of listBackups().slice(KEEP)) fs.rmSync(path.join(backupDir(), b.name), { force: true });
}

/** Copie cohérente de la base (VACUUM INTO), même pendant que l'application l'utilise. */
export function backupDatabase(handle = getDb(), reason = 'manuelle') {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  let name = `echecs-${stamp()}-${slug(reason)}.sqlite`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `echecs-${stamp()}-${slug(reason)}-${i}.sqlite`;
  handle.exec(`VACUUM INTO ${sqlString(path.join(dir, name))}`);
  prune();
  return listBackups().find((b) => b.name === name) ?? { name };
}

/** Sauvegarde du démarrage : seulement si la dernière a plus de 24 h. */
export function maybeDailyBackup(now = Date.now()) {
  const last = listBackups()[0];
  if (last && now - Date.parse(last.createdAt) < DAY) return null;
  return backupDatabase(getDb(), 'quotidienne');
}

/** PRAGMA integrity_check : { ok, messages }. */
export function integrityCheck(handle = getDb()) {
  const messages = handle.prepare('PRAGMA integrity_check').all().map((r) => String(Object.values(r)[0]));
  return { ok: messages.length === 1 && messages[0] === 'ok', messages: messages.slice(0, 5) };
}

/** Une sauvegarde est « saine » si elle s'ouvre et passe le contrôle d'intégrité. */
export function isHealthy(file) {
  let d = null;
  try {
    d = new DatabaseSync(file, { readOnly: true });
    return integrityCheck(d).ok;
  } catch {
    return false;
  } finally {
    try { d?.close(); } catch { /* déjà fermée */ }
  }
}

export function latestHealthyBackup() {
  return listBackups().find((b) => isHealthy(path.join(backupDir(), b.name))) ?? null;
}

/**
 * Restaure une sauvegarde à la place de la base actuelle (qui est elle-même sauvegardée avant, si possible).
 * L'appelant doit avoir arrêté l'analyse en cours.
 */
export function restoreBackup(name) {
  if (!NAME_RE.test(String(name))) throw Object.assign(new Error('Nom de sauvegarde invalide'), { status: 400 });
  const src = path.join(backupDir(), name);
  if (!fs.existsSync(src)) throw Object.assign(new Error('Sauvegarde introuvable'), { status: 404 });
  if (!isHealthy(src)) throw Object.assign(new Error('Cette sauvegarde est elle-même endommagée.'), { status: 409 });
  // Filet de sécurité : la base actuelle est sauvegardée avant d'être remplacée.
  let safety = null;
  try { safety = backupDatabase(getDb(), 'avant-restauration'); } catch { safety = null; }
  closeDb();
  for (const ext of ['-wal', '-shm']) fs.rmSync(config.dbPath + ext, { force: true });
  fs.copyFileSync(src, config.dbPath);
  openDb();
  return { restored: name, safety: safety?.name ?? null };
}

/** Copie de la base pour l'export (fichier temporaire, cohérent). */
export function exportDatabase(dest) {
  fs.rmSync(dest, { force: true });
  getDb().exec(`VACUUM INTO ${sqlString(dest)}`);
  return dest;
}
