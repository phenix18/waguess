import { timingSafeEqual } from 'node:crypto';
import { createCrowdTrafficStore, parseBbox } from '../crowd/trafficCore.js';
import { readRequestBody } from './common/request.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { admitSameSite } from './common/same-site.js';

/** Route prefix of the crowd-traffic API. */
export const CROWD_ROUTE = '/api/crowd';
/** Optional shared secret restricting who may contribute. */
export const CROWD_TOKEN_ENV = 'WAGUESS_CROWD_TOKEN';
const MAX_BODY_BYTES = 16 * 1024;
export const CROWD_REPORT_RATE_PER_MIN = 300;
export const CROWD_READ_RATE_PER_MIN = 240;

function send(res, status, payload, extra = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(JSON.stringify(payload));
}

function tokenMatches(expected, received) {
  if (!expected) return true;
  if (typeof received !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Build the request handler. Exposed separately from the Vite plugin so tests
 * can drive it with plain objects.
 * @param {object} [config]
 * @param {ReturnType<typeof createCrowdTrafficStore>} [config.store]
 * @param {string} [config.token] - Required contributor token, if any.
 * @param {boolean} [config.gate=true] - Refuse cross-site browser requests.
 */
export function createCrowdTrafficHandler({
  store = createCrowdTrafficStore(),
  token = process.env[CROWD_TOKEN_ENV] || '',
  gate = true,
  reportRatePerMinute = CROWD_REPORT_RATE_PER_MIN,
  readRatePerMinute = CROWD_READ_RATE_PER_MIN,
} = {}) {
  const allowReport = makeRateLimiter({
    windowMs: 60_000,
    max: reportRatePerMinute,
    globalMax: reportRatePerMinute * 20,
  });
  const allowRead = makeRateLimiter({
    windowMs: 60_000,
    max: readRatePerMinute,
    globalMax: readRatePerMinute * 10,
  });

  async function readJson(req, res) {
    let text;
    try {
      text = await readRequestBody(req, MAX_BODY_BYTES);
    } catch (error) {
      if (error?.code === 'BODY_TOO_LARGE') {
        send(res, 413, { error: 'Request too large', code: 'too-large' });
      } else {
        send(res, 400, { error: 'Unreadable request', code: 'unreadable' });
      }
      return undefined;
    }
    try {
      const parsed = JSON.parse(text || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      return parsed;
    } catch {
      send(res, 400, { error: 'Invalid JSON', code: 'invalid-json' });
      return undefined;
    }
  }

  async function handler(req, res) {
    try {
      if (gate && admitSameSite(req, res)) return;
      const url = new URL(req.url || '/', 'http://localhost');
      const route = url.pathname.replace(/\/+$/, '') || '/';

      if (route === '/segments' || route === '/status') {
        if (req.method !== 'GET') {
          return send(
            res,
            405,
            { error: 'Method Not Allowed' },
            { Allow: 'GET' },
          );
        }
        if (!allowRead(clientKey(req))) {
          return send(
            res,
            429,
            { error: 'Rate limit exceeded' },
            { 'Retry-After': '10' },
          );
        }
        if (route === '/status') return send(res, 200, store.status());
        const bbox = parseBbox(url.searchParams.get('bbox') || '');
        if (!bbox) {
          return send(res, 400, {
            error:
              'bbox must be west,south,east,north (at most 5 degrees wide)',
            code: 'bbox',
          });
        }
        return send(res, 200, store.segments(bbox));
      }

      if (route === '/report' || route === '/forget') {
        if (req.method !== 'POST') {
          return send(
            res,
            405,
            { error: 'Method Not Allowed' },
            { Allow: 'POST' },
          );
        }
        if (!allowReport(clientKey(req))) {
          return send(
            res,
            429,
            { error: 'Rate limit exceeded' },
            { 'Retry-After': '5' },
          );
        }
        if (!tokenMatches(token, req.headers?.['x-waguess-crowd-token'])) {
          return send(res, 401, {
            error: 'Contributor token required',
            code: 'token',
          });
        }
        const body = await readJson(req, res);
        if (!body) return;
        if (route === '/forget') {
          const result = store.forget(body.sessionId);
          return send(res, result.ok ? 200 : 400, result);
        }
        const result = store.addReport(body.sessionId, body.samples);
        if (result.ok) return send(res, 200, result);
        const status =
          result.reason === 'too-frequent'
            ? 429
            : result.reason === 'batch-too-large'
              ? 413
              : 400;
        return send(
          res,
          status,
          result,
          status === 429 ? { 'Retry-After': '2' } : {},
        );
      }

      return send(res, 404, { error: 'Unknown crowd route' });
    } catch (error) {
      console.error('[Crowd traffic]', error?.message || String(error));
      return send(res, 500, { error: 'Crowd traffic error' });
    }
  }

  handler.store = store;
  return handler;
}

/**
 * Vite plugin: opt-in, anonymous crowd traffic (no paid API).
 * @returns {import('vite').Plugin}
 */
export function crowdTrafficProxy(config = {}) {
  const handler = createCrowdTrafficHandler(config);
  const install = (server) => {
    server.middlewares.use(CROWD_ROUTE, handler);
  };
  return {
    name: 'crowd-traffic',
    configureServer: install,
    configurePreviewServer: install,
  };
}
