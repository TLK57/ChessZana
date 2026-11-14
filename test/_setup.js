// Chaque fichier de test utilise sa propre base SQLite temporaire (la vraie base n'est jamais touchée).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'echecs-test-'));
process.env.CHESS_DATA_DIR = dir;
process.env.CHESS_DB = path.join(dir, 'test.sqlite');
process.env.CHESS_CONFIG_LOCAL = ''; // les tests n'utilisent jamais les réglages personnels
// Par défaut, les tests du classement utilisent la formule Lichess ; les tests des courbes par niveau les chargent.
if (process.env.CHESS_CURVES === undefined) process.env.CHESS_CURVES = '';
// Le livre d'ouvertures compilé est partagé entre les fichiers de test (sinon recalculé à chaque fois).
process.env.CHESS_OPENINGS_CACHE = path.join(os.tmpdir(), 'echecs-test-ouvertures.json');
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* fichiers encore ouverts */ } });
