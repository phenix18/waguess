import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createCrowdTrafficStore } from '../crowd/trafficCore.js';
import {
  createCrowdTrafficHandler,
  crowdTrafficProxy,
} from './crowdTraffic.js';
import { localProviderPlugins } from './local.js';

function makeRequest(method, url, body, headers = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  Object.assign(req, {
    method,
    url,
    headers: { host: 'localhost:5173', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
  });
  return req;
}

async function call(handler, method, url, body, headers) {
  const res = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, h) {
      this.status = status;
      this.headers = h;
    },
    setHeader(k, v) {
      this.headers[k] = v;
    },
    end(text) {
      this.body = text;
    },
  };
  await handler(makeRequest(method, url, body, headers), res);
  return {
    ...res,
    status: res.status || res.statusCode,
    json: res.body ? JSON.parse(res.body) : null,
  };
}

const sid = (n) => `session-${String(n).padStart(8, '0')}`;
const post = (handler, route, payload, headers) =>
  call(handler, 'POST', route, JSON.stringify(payload), headers);

function newHandler(config = {}) {
  let t = 5_000_000;
  const store = createCrowdTrafficStore({ now: () => t, salt: 'x' });
  const handler = createCrowdTrafficHandler({ store, token: '', ...config });
  return { handler, advance: (ms) => (t += ms) };
}

const SAMPLE = { lat: 12.3714, lon: -1.5197, speedKmh: 4, heading: 90 };

test('contributors report, readers see a congested road', async () => {
  const { handler } = newHandler();
  for (let i = 0; i < 3; i += 1) {
    const r = await post(handler, '/report', {
      sessionId: sid(i),
      samples: [SAMPLE],
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.accepted, 1);
    assert.equal(r.headers['Cache-Control'], 'no-store');
  }
  const read = await call(handler, 'GET', '/segments?bbox=-1.6,12.3,-1.4,12.5');
  assert.equal(read.status, 200);
  assert.equal(read.json.features[0].properties.level, 'jam');
  assert.equal(read.json.meta.counts.jam, 1);
  const status = await call(handler, 'GET', '/status');
  assert.equal(status.json.samples, 3);
});

test('stop and forget deletes the contributor data', async () => {
  const { handler } = newHandler();
  for (let i = 0; i < 3; i += 1) {
    await post(handler, '/report', { sessionId: sid(i), samples: [SAMPLE] });
  }
  const forget = await post(handler, '/forget', { sessionId: sid(0) });
  assert.deepEqual(forget.json, { ok: true, removed: 1 });
  const read = await call(handler, 'GET', '/segments?bbox=-1.6,12.3,-1.4,12.5');
  assert.equal(read.json.features.length, 0);
});

test('bad requests get precise errors', async () => {
  const { handler } = newHandler();
  assert.equal((await call(handler, 'GET', '/segments')).status, 400);
  assert.equal(
    (await call(handler, 'GET', '/segments?bbox=-90,-40,90,40')).status,
    400,
  );
  assert.equal((await call(handler, 'GET', '/report')).status, 405);
  assert.equal((await call(handler, 'POST', '/segments')).status, 405);
  assert.equal((await call(handler, 'POST', '/report', '{nope')).status, 400);
  assert.equal((await call(handler, 'POST', '/report', '[]')).status, 400);
  assert.equal((await call(handler, 'GET', '/unknown')).status, 404);
  const big = JSON.stringify({
    sessionId: sid(1),
    samples: [SAMPLE],
    pad: 'x'.repeat(20_000),
  });
  assert.equal((await call(handler, 'POST', '/report', big)).status, 413);
  const bad = await post(handler, '/report', {
    sessionId: 'x',
    samples: [SAMPLE],
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.reason, 'session');
});

test('a contributor sending too fast is told to slow down', async () => {
  const { handler, advance } = newHandler();
  const body = { sessionId: sid(1), samples: [SAMPLE] };
  assert.equal((await post(handler, '/report', body)).status, 200);
  const fast = await post(handler, '/report', body);
  assert.equal(fast.status, 429);
  assert.equal(fast.headers['Retry-After'], '2');
  advance(1_500);
  assert.equal((await post(handler, '/report', body)).status, 200);
});

test('the optional contributor token is enforced on writes only', async () => {
  const { handler } = newHandler({ token: 'letmein' });
  const body = { sessionId: sid(1), samples: [SAMPLE] };
  assert.equal((await post(handler, '/report', body)).status, 401);
  assert.equal(
    (await post(handler, '/report', body, { 'x-waguess-crowd-token': 'nope' }))
      .status,
    401,
  );
  assert.equal(
    (
      await post(handler, '/report', body, {
        'x-waguess-crowd-token': 'letmein',
      })
    ).status,
    200,
  );
  assert.equal((await call(handler, 'GET', '/status')).status, 200);
});

test('cross-site browser requests are refused', async () => {
  const { handler } = newHandler();
  const r = await post(
    handler,
    '/report',
    { sessionId: sid(1), samples: [SAMPLE] },
    {
      origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site',
    },
  );
  assert.equal(r.status, 403);
});

test('the report route is rate limited per client', async () => {
  const { handler } = newHandler({ reportRatePerMinute: 2 });
  const statuses = [];
  for (let i = 0; i < 4; i += 1) {
    statuses.push(
      (await post(handler, '/report', { sessionId: sid(i), samples: [SAMPLE] }))
        .status,
    );
  }
  assert.deepEqual(statuses.slice(0, 2), [200, 200]);
  assert.ok(statuses.slice(2).every((s) => s === 429));
});

test('the plugin is registered once with the local providers', () => {
  const plugins = localProviderPlugins();
  assert.equal(plugins.filter((p) => p.name === 'crowd-traffic').length, 1);
  const plugin = crowdTrafficProxy();
  assert.equal(typeof plugin.configureServer, 'function');
  assert.equal(typeof plugin.configurePreviewServer, 'function');
});
