// File d'analyse : mode, « Analyser tout mon historique », pause, reprise, parties en erreur.
import { getQueue } from './context.js';
import { send } from './respond.js';

export async function queueRoutes(req, res, { p, body }) {
  if (req.method !== 'POST' || !p.startsWith('/api/queue/')) return false;
  const queue = getQueue();
  switch (p) {
    case '/api/queue/mode': queue.setMode(String(body.mode)); send(res, 200, queue.progress()); return true;
    case '/api/queue/history': send(res, 200, queue.setHistory(String(body.action))); return true;
    case '/api/queue/pause': queue.pause(); send(res, 200, queue.progress()); return true;
    case '/api/queue/resume': queue.resume(); send(res, 200, queue.progress()); return true;
    case '/api/queue/retry': queue.retryErrors(); send(res, 200, queue.progress()); return true;
    default: return false;
  }
}
