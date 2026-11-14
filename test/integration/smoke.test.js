// Application complète : démarrage, Stockfish, page web, import et analyse d'une courte partie.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('test de fumée : l\'application démarre et analyse une partie', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'smoke.js')], { cwd: ROOT, encoding: 'utf8', timeout: 15 * 60000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /TEST DE FUMÉE RÉUSSI/);
});
