// Sauvegardes : création, rotation (7 dernières), 24 h, intégrité, restauration, migration.
import './_setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../src/config.js';
import { openDb, getDb, closeDb, setMeta, getMeta, SCHEMA_VERSION } from '../src/db.js';
import {
  KEEP, backupDir, backupDatabase, listBackups, maybeDailyBackup, integrityCheck, isHealthy, latestHealthyBackup, restoreBackup, exportDatabase,
} from '../src/backup.js';

openDb();
const clear = () => fs.rmSync(backupDir(), { recursive: true, force: true });

test('sauvegarde : fichier complet, et seules les 7 dernières sont gardées', () => {
  clear();
  setMeta('marqueur', 'v1');
  const first = backupDatabase(getDb(), 'manuelle');
  assert.ok(fs.existsSync(path.join(backupDir(), first.name)));
  const copy = new DatabaseSync(path.join(backupDir(), first.name), { readOnly: true });
  assert.equal(copy.prepare("SELECT value FROM meta WHERE key = 'marqueur'").get().value, 'v1');
  copy.close();
  for (let i = 0; i < 9; i++) backupDatabase(getDb(), `essai ${i}`);
  assert.equal(listBackups().length, KEEP);
  assert.equal(KEEP, 7);
});

test('sauvegarde quotidienne : seulement si la dernière a plus de 24 h', () => {
  clear();
  assert.ok(maybeDailyBackup(), 'aucune sauvegarde : on en fait une');
  assert.equal(maybeDailyBackup(), null, 'la dernière a moins de 24 h');
  assert.ok(maybeDailyBackup(Date.now() + 25 * 3600 * 1000), 'plus de 24 h après : nouvelle sauvegarde');
});

test('intégrité : base saine, fichier endommagé détecté, dernière sauvegarde saine trouvée', () => {
  clear();
  assert.equal(integrityCheck().ok, true);
  const good = backupDatabase(getDb(), 'manuelle');
  // Une « sauvegarde » plus récente mais illisible.
  const bad = path.join(backupDir(), 'echecs-29991231-235959-abimee.sqlite');
  fs.writeFileSync(bad, Buffer.alloc(8192, 7));
  assert.equal(isHealthy(bad), false);
  assert.equal(latestHealthyBackup().name, good.name);
  assert.throws(() => restoreBackup('echecs-29991231-235959-abimee.sqlite'), /endommagée/);
  assert.throws(() => restoreBackup('../../config.json'), /invalide/);
});

test('restauration : on retrouve les données de la sauvegarde, la base actuelle est gardée à côté', () => {
  clear();
  setMeta('marqueur', 'avant');
  const b = backupDatabase(getDb(), 'manuelle');
  setMeta('marqueur', 'après');
  const r = restoreBackup(b.name);
  assert.equal(getMeta('marqueur'), 'avant');
  assert.ok(r.safety && fs.existsSync(path.join(backupDir(), r.safety)), 'sauvegarde de la base remplacée');
  const safety = new DatabaseSync(path.join(backupDir(), r.safety), { readOnly: true });
  assert.equal(safety.prepare("SELECT value FROM meta WHERE key = 'marqueur'").get().value, 'après');
  safety.close();
});

test('export : copie cohérente de la base', () => {
  const dest = path.join(path.dirname(config.dbPath), 'export-test.sqlite');
  exportDatabase(dest);
  assert.ok(isHealthy(dest));
  fs.rmSync(dest, { force: true });
});

test('migration de schéma : une base plus ancienne est sauvegardée avant d\'être modifiée', () => {
  clear();
  setMeta('schema_version', String(SCHEMA_VERSION - 1));
  closeDb();
  openDb();
  const names = listBackups().map((b) => b.name);
  assert.ok(names.some((n) => n.includes(`avant-migration-v${SCHEMA_VERSION}`)), names.join(', '));
  assert.equal(getMeta('schema_version'), String(SCHEMA_VERSION));
  // Base déjà à jour : pas de nouvelle sauvegarde.
  closeDb();
  openDb();
  assert.equal(listBackups().length, names.length);
});
