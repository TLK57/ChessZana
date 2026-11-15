// Chaque fichier de test utilise sa propre base SQLite temporaire (la vraie base n'est jamais touchée).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'echecs-test-'));
process.env.CHESS_DATA_DIR = dir;
process.env.CHESS_DB = path.join(dir, 'test.sqlite');
process.env.CHESS_CONFIG_LOCAL = ''; // les tests n'utilisent jamais les réglages personnels
// Par défaut, les tests du style chess.com utilisent la formule Lichess comme courbe de points attendus (même pente
// pour tous les niveaux) : les cas s'écrivent en pourcentages Lichess. Les tests de la courbe par niveau la remettent.
fs.writeFileSync(path.join(dir, 'style-chesscom.json'), JSON.stringify({ curve: { k1500: 0.368208, eloSlope: 0 } }));
// Le livre d'ouvertures compilé est partagé entre les fichiers de test (sinon recalculé à chaque fois).
process.env.CHESS_OPENINGS_CACHE = path.join(os.tmpdir(), 'echecs-test-ouvertures.json');
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* fichiers encore ouverts */ } });
