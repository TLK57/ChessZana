// Réenregistre les réponses utilisées par les tests unitaires (npm run test:record) :
// lance les tests unitaires avec le vrai Stockfish et les vraies API, et garde leurs réponses dans test/fixtures.
// À refaire quand l'analyse demande d'autres positions au moteur (le test indique alors « Position non enregistrée »).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureEngine } from '../src/engine/install.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engine = await ensureEngine();
for (const dir of ['uci', 'http']) fs.rmSync(path.join(ROOT, 'test', 'fixtures', dir), { recursive: true, force: true });

const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', '--test-concurrency=1', 'test/*.test.js'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, FIXTURES_RECORD: '1', FIXTURES_REAL_ENGINE: engine.binary },
});
console.log(r.status === 0 ? '\nRéponses enregistrées dans test/fixtures.' : '\nDes tests ont échoué pendant l\'enregistrement.');
process.exit(r.status ?? 1);
