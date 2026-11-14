// Fichiers de l'interface : public/ (pages, scripts, polices) et bibliothèques (échiquier chessground, règles chess.js).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';
import { send } from './respond.js';

const VENDOR = {
  '/vendor/chessground.js': ['node_modules', 'chessground', 'dist', 'chessground.min.js'],
  '/vendor/chessground.base.css': ['node_modules', 'chessground', 'assets', 'chessground.base.css'],
  '/vendor/chessground.brown.css': ['node_modules', 'chessground', 'assets', 'chessground.brown.css'],
  '/vendor/chessground.cburnett.css': ['node_modules', 'chessground', 'assets', 'chessground.cburnett.css'],
  '/vendor/chess.js': ['node_modules', 'chess.js', 'dist', 'esm', 'chess.js'],
};
const MIME = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

function staticFile(p) {
  if (VENDOR[p]) return path.join(ROOT, ...VENDOR[p]);
  const m = /^\/app\/([a-z0-9_-]+\.(?:js|css|svg|png))$/i.exec(p);
  if (m) return path.join(ROOT, 'public', 'app', m[1]);
  // Polices embarquées (licence OFL) : l'application fonctionne hors ligne.
  const f = /^\/fonts\/([a-z0-9_-]+\.woff2)$/i.exec(p);
  if (f) return path.join(ROOT, 'public', 'fonts', f[1]);
  return null;
}

/** Sert la page et ses fichiers (requêtes GET). Renvoie true si la requête a été traitée. */
export function serveStatic(req, res, p) {
  if (req.method !== 'GET') return false;
  if (p === '/' || p === '/index.html') {
    send(res, 200, fs.readFileSync(path.join(ROOT, 'public', 'index.html')), 'text/html; charset=utf-8');
    return true;
  }
  const file = staticFile(p);
  if (!file) return false;
  if (!fs.existsSync(file)) send(res, 404, { error: 'Fichier introuvable' });
  else send(res, 200, fs.readFileSync(file), MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  return true;
}
