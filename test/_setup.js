// Chaque fichier de test utilise sa propre base SQLite temporaire (la vraie base n'est jamais touchée).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'echecs-test-'));
process.env.CHESS_DATA_DIR = dir;
process.env.CHESS_DB = path.join(dir, 'test.sqlite');
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* fichiers encore ouverts */ } });
