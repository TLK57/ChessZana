// Sauvegardes : liste, export de la base, sauvegarde manuelle, restauration.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb } from '../db.js';
import { KEEP, backupDatabase, exportDatabase, listBackups } from '../backup.js';
import { restore, state } from './context.js';
import { send } from './respond.js';

export async function backupRoutes(req, res, { p, body }) {
  if (req.method === 'GET') {
    if (p === '/api/backups') { send(res, 200, { backups: listBackups(), keep: KEEP, integrity: state.integrity }); return true; }
    if (p === '/api/backups/export') {
      const tmp = path.join(os.tmpdir(), `echecs-export-${process.pid}-${Date.now()}.sqlite`);
      exportDatabase(tmp);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.sqlite3',
        'Content-Disposition': `attachment; filename="echecs-${new Date().toISOString().slice(0, 10)}.sqlite"`,
        'Content-Length': fs.statSync(tmp).size,
        'Cache-Control': 'no-store',
      });
      const stream = fs.createReadStream(tmp);
      stream.pipe(res);
      stream.on('close', () => fs.rm(tmp, { force: true }, () => {}));
      return true;
    }
    return false;
  }
  if (req.method === 'POST') {
    if (p === '/api/backups/create') { send(res, 200, backupDatabase(getDb(), 'manuelle')); return true; }
    if (p === '/api/backups/restore') { send(res, 200, await restore(String(body.name ?? ''))); return true; }
  }
  return false;
}
