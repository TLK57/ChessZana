// Vérifie que les fichiers de l'interface (public/app) et du serveur sont du JavaScript valide :
// une seule faute de frappe dans un module empêche toute la page de s'afficher.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  ...fs.readdirSync(path.join(ROOT, 'public', 'app')).filter((f) => f.endsWith('.js')).map((f) => path.join('public', 'app', f)),
  path.join('src', 'server.js'),
];

for (const file of files) {
  test(`syntaxe valide : ${file.replace(/\\/g, '/')}`, () => {
    const r = spawnSync(process.execPath, ['--check', path.join(ROOT, file)], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  });
}

test('la page principale charge les modules attendus', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.match(html, /\/app\/main\.js/);
  assert.match(html, /\/vendor\/chessground\.base\.css/);
  for (const f of ['main.js', 'list.js', 'analysis.js', 'graph.js', 'importview.js', 'util.js', 'app.css']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'public', 'app', f)), f);
  }
});
