// Requêtes HTTP « polies » : en-tête User-Agent avec contact, une seule requête à la fois par site,
// nouvelles tentatives espacées en cas d'erreur 429 (trop de requêtes) ou de panne passagère.
import { userAgent } from './config.js';

export const SKIPPED = Symbol('skipped');

const hosts = new Map(); // hôte -> { tail: Promise, pending: number }

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new Error('aborted')); }, { once: true });
});

function hostState(host) {
  let st = hosts.get(host);
  if (!st) { st = { tail: Promise.resolve(), pending: 0 }; hosts.set(host, st); }
  return st;
}

export function hostBusy(url) {
  return hostState(new URL(url).host).pending > 0;
}

function retryAfterMs(res) {
  const h = res.headers.get('retry-after');
  if (!h) return null;
  const s = Number(h);
  if (Number.isFinite(s)) return s * 1000;
  const d = Date.parse(h);
  return Number.isFinite(d) ? Math.max(0, d - Date.now()) : null;
}

/**
 * Exécute une requête GET en série avec les autres requêtes vers le même site.
 * `handler(res)` est appelé pendant que le « verrou » du site est tenu (utile pour lire un flux).
 * Options :
 *  - retries : nombre de nouvelles tentatives (429 / 5xx / réseau)
 *  - rateLimitDelayMs : attente après un 429 sans Retry-After (doublée à chaque fois)
 *  - timeoutMs : délai maximum pour recevoir les en-têtes de la réponse
 *  - skipIfBusy : renvoie SKIPPED au lieu d'attendre si une requête est déjà en cours vers ce site
 *  - noRetryStatuses : statuts qui ne doivent pas déclencher de nouvelle tentative (ex. 429 pour Lichess cloud)
 */
export async function politeGet(url, {
  headers = {}, retries = 4, rateLimitDelayMs = 5000, errorDelayMs = 2000, timeoutMs = 30000,
  skipIfBusy = false, noRetryStatuses = [], signal, handler,
} = {}) {
  const st = hostState(new URL(url).host);
  if (skipIfBusy && st.pending > 0) return SKIPPED;
  st.pending++;
  const run = st.tail.then(async () => {
    let attempt = 0;
    let rateDelay = rateLimitDelayMs;
    for (;;) {
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort(signal.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => ctrl.abort(new Error(`délai dépassé (${timeoutMs} ms)`)), timeoutMs);
      let res;
      try {
        res = await fetch(url, { headers: { 'User-Agent': userAgent(), ...headers }, signal: ctrl.signal, redirect: 'follow' });
      } catch (e) {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted) throw e;
        if (attempt >= retries) throw new Error(`Réseau indisponible pour ${new URL(url).host} : ${e.cause?.code || e.message}`);
        attempt++;
        await sleep(errorDelayMs * 2 ** (attempt - 1), signal);
        continue;
      }
      clearTimeout(timer); // les en-têtes sont arrivés : le corps peut être long (flux)
      try {
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && !noRetryStatuses.includes(res.status) && attempt < retries) {
          await res.body?.cancel().catch(() => {});
          attempt++;
          const wait = res.status === 429 ? (retryAfterMs(res) ?? rateDelay) : errorDelayMs * 2 ** (attempt - 1);
          if (res.status === 429) rateDelay *= 2;
          await sleep(wait, signal);
          continue;
        }
        return handler ? await handler(res) : res;
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    }
  });
  st.tail = run.then(() => {}, () => {}).finally(() => { st.pending--; });
  return run;
}

export async function getJson(url, opts = {}) {
  return politeGet(url, {
    ...opts,
    handler: async (res) => {
      const body = res.status === 204 || res.status === 304 ? null : await res.text();
      let json = null;
      if (body) { try { json = JSON.parse(body); } catch { json = null; } }
      return { status: res.status, ok: res.ok, headers: res.headers, json };
    },
  });
}
