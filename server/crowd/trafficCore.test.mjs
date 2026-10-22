import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CROWD_DEFAULTS,
  createCrowdTrafficStore,
  isValidSessionId,
  levelForRatio,
  normalizeSample,
  parseBbox,
} from './trafficCore.js';

const LAT = 12.3714;
const LON = -1.5197;
const BBOX = { west: -1.6, south: 12.3, east: -1.4, north: 12.5 };
const sid = (n) => `session-${String(n).padStart(8, '0')}`;

function fixture(options) {
  let t = 1_000_000;
  const clock = { advance: (ms) => (t += ms) };
  const store = createCrowdTrafficStore({
    now: () => t,
    salt: 'test-salt',
    options,
  });
  return { store, clock };
}

function sample(speedKmh, extra = {}) {
  return { lat: LAT, lon: LON, speedKmh, heading: 90, mode: 'car', ...extra };
}

function fill(store, speeds, extra = {}) {
  speeds.forEach((speed, i) =>
    assert.equal(store.addReport(sid(i), [sample(speed, extra)]).ok, true),
  );
}

test('a cell is not published below the contributor threshold', () => {
  const { store } = fixture();
  fill(store, [5, 6]);
  assert.equal(store.segments(BBOX).features.length, 0);
  store.addReport(sid(9), [sample(4)]);
  assert.equal(store.segments(BBOX).features.length, 1);
});

test('one contributor sending many samples still counts once', () => {
  const { store, clock } = fixture();
  for (let i = 0; i < 6; i += 1) {
    store.addReport(sid(1), [sample(5)]);
    clock.advance(1_500);
  }
  store.addReport(sid(2), [sample(5)]);
  assert.equal(store.segments(BBOX).features.length, 0);
});

test('speed relative to free flow selects the congestion level', () => {
  for (const [speeds, level] of [
    [[40, 42, 44], 'free'],
    [[24, 25, 26], 'slow'],
    [[12, 13, 14], 'heavy'],
    [[2, 3, 4], 'jam'],
  ]) {
    const { store } = fixture();
    fill(store, speeds);
    const [feature] = store.segments(BBOX).features;
    assert.equal(feature.properties.level, level, speeds.join());
    assert.equal(feature.properties.contributors, 3);
  }
  assert.equal(levelForRatio(0.75), 'free');
  assert.equal(levelForRatio(0.2), 'heavy');
  assert.equal(levelForRatio(0.19), 'jam');
});

test('opposite directions of the same road are reported separately', () => {
  const { store } = fixture();
  fill(store, [3, 4, 5], { heading: 90 });
  [10, 11, 12].forEach((n) =>
    store.addReport(sid(n), [sample(40, { heading: 270 })]),
  );
  const { features } = store.segments(BBOX);
  assert.equal(features.length, 2);
  const byHeading = Object.fromEntries(
    features.map((f) => [f.properties.heading, f.properties.level]),
  );
  assert.equal(byHeading[90], 'jam');
  assert.equal(byHeading[270], 'free');
  assert.equal(features[0].geometry.type, 'LineString');
});

test('stopped vehicles without a heading join the dominant direction', () => {
  const { store } = fixture();
  fill(store, [20, 21]);
  store.addReport(sid(7), [sample(0, { heading: null })]);
  const [feature] = store.segments(BBOX).features;
  assert.equal(feature.properties.contributors, 3);
});

test('samples expire: out of the window they stop describing the road', () => {
  const { store, clock } = fixture();
  fill(store, [3, 4, 5]);
  clock.advance(CROWD_DEFAULTS.windowMs + 1_000);
  assert.equal(store.segments(BBOX).features.length, 0);
  assert.ok(store.status().samples > 0);
  clock.advance(CROWD_DEFAULTS.ttlMs);
  store.prune();
  assert.equal(store.status().samples, 0);
  assert.equal(store.status().cells, 0);
});

test('forget removes everything a contributor sent', () => {
  const { store } = fixture();
  fill(store, [3, 4, 5]);
  assert.equal(store.segments(BBOX).features.length, 1);
  const result = store.forget(sid(0));
  assert.deepEqual(result, { ok: true, removed: 1 });
  assert.equal(store.segments(BBOX).features.length, 0);
  assert.equal(store.forget('short').ok, false);
});

test('invalid samples and sessions are refused', () => {
  const { store } = fixture();
  assert.equal(store.addReport('short', [sample(5)]).reason, 'session');
  assert.equal(store.addReport(sid(1), []).reason, 'samples');
  assert.equal(
    store.addReport(sid(1), Array(21).fill(sample(5))).reason,
    'batch-too-large',
  );
  for (const bad of [
    { ...sample(5), lat: 91 },
    { ...sample(5), lon: 200 },
    { ...sample(5), lat: 'x' },
    sample(-1),
    sample(400),
    { ...sample(5), accuracyM: 500 },
    null,
  ]) {
    assert.equal(normalizeSample(bad), null, JSON.stringify(bad));
  }
  const result = store.addReport(sid(2), [sample(5), { lat: 1 }]);
  assert.deepEqual(
    { accepted: result.accepted, rejected: result.rejected },
    { accepted: 1, rejected: 1 },
  );
  assert.equal(isValidSessionId(sid(3)), true);
  assert.equal(isValidSessionId('has space in it, too long....'), false);
});

test('a contributor cannot flood the store faster than allowed', () => {
  const { store, clock } = fixture({ minBatchIntervalMs: 1_000 });
  assert.equal(store.addReport(sid(1), [sample(5)]).ok, true);
  assert.equal(store.addReport(sid(1), [sample(5)]).reason, 'too-frequent');
  clock.advance(1_000);
  assert.equal(store.addReport(sid(1), [sample(5)]).ok, true);
});

test('the store is bounded by maxSamples', () => {
  const { store, clock } = fixture({ maxSamples: 50 });
  for (let i = 0; i < 80; i += 1) {
    store.addReport(sid(i), [sample(10)]);
    clock.advance(20_000);
  }
  store.prune();
  assert.ok(store.status().samples <= 50);
});

test('motorcycle speed is discounted so lane filtering does not hide a jam', () => {
  const { store } = fixture();
  fill(store, [30, 30, 30], { mode: 'moto' });
  const [feature] = store.segments(BBOX).features;
  assert.equal(feature.properties.speedKmh, 24);
  assert.equal(feature.properties.motos, 3);
});

test('free flow is learned per road from moving traffic', () => {
  const { store, clock } = fixture({ learnMinSamples: 30 });
  for (let i = 0; i < 40; i += 1) {
    store.addReport(sid(100 + i), [sample(80)]);
    clock.advance(10);
  }
  clock.advance(CROWD_DEFAULTS.windowMs + 1_000);
  fill(store, [30, 31, 32]);
  const [feature] = store.segments(BBOX).features;
  assert.equal(feature.properties.freeFlowKmh, 80);
  assert.equal(feature.properties.level, 'heavy');
});

test('published data carries no identifier and no raw position', () => {
  const { store } = fixture();
  fill(store, [3, 4, 5]);
  const json = JSON.stringify(store.segments(BBOX));
  assert.ok(!json.includes('session'));
  assert.ok(!json.includes(String(LAT)));
  assert.ok(!json.includes(String(LON)));
  for (const feature of store.segments(BBOX).features) {
    assert.deepEqual(Object.keys(feature.properties).sort(), [
      'ageS',
      'cars',
      'confidence',
      'contributors',
      'freeFlowKmh',
      'heading',
      'level',
      'motos',
      'ratio',
      'speedKmh',
    ]);
  }
});

test('segments honour the bounding box', () => {
  const { store } = fixture();
  fill(store, [3, 4, 5]);
  const far = { west: 2, south: 40, east: 3, north: 41 };
  assert.equal(store.segments(far).features.length, 0);
});

test('parseBbox accepts a sane box only', () => {
  assert.deepEqual(parseBbox('-1.6,12.3,-1.4,12.5'), BBOX);
  assert.equal(parseBbox('1,2,3'), null);
  assert.equal(parseBbox('a,b,c,d'), null);
  assert.equal(parseBbox('5,5,1,6'), null);
  assert.equal(parseBbox('-180,-80,180,80'), null);
  assert.equal(parseBbox(undefined), null);
});
