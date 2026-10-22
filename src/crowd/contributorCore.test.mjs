import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  MESSAGES,
  bearingDeg,
  haversineM,
  newSessionId,
  nextDelay,
  pickLanguage,
  toSample,
} from '../../public/contribute-core.js';
import { isValidSessionId } from '../../server/crowd/trafficCore.js';

const position = (extra = {}, timestamp = 10_000) => ({
  timestamp,
  coords: {
    latitude: 12.3714,
    longitude: -1.5197,
    accuracy: 12,
    speed: null,
    heading: null,
    ...extra,
  },
});

test('session ids are unique, URL safe and accepted by the server', () => {
  const ids = new Set();
  for (let i = 0; i < 50; i += 1) {
    const id = newSessionId((b) => webcrypto.getRandomValues(b));
    assert.equal(isValidSessionId(id), true, id);
    ids.add(id);
  }
  assert.equal(ids.size, 50);
});

test('device speed is converted to km/h and rounded positions are sent', () => {
  const sample = toSample(position({ speed: 10, heading: 91.6 }), null, 'car');
  assert.deepEqual(sample, {
    lat: 12.3714,
    lon: -1.5197,
    speedKmh: 36,
    heading: 92,
    accuracyM: 12,
    mode: 'car',
  });
});

test('speed and heading are derived from consecutive fixes when absent', () => {
  const first = { lat: 12.3714, lon: -1.5197, t: 10_000 };
  const next = position(
    { latitude: 12.3714, longitude: -1.5197 + 0.0009 },
    20_000,
  );
  const sample = toSample(next, first, 'moto');
  assert.equal(sample.mode, 'moto');
  assert.ok(sample.speedKmh > 33 && sample.speedKmh < 37, sample.speedKmh);
  assert.ok(sample.heading >= 89 && sample.heading <= 91);
  assert.equal(toSample(position(), null, 'car'), null);
});

test('imprecise or invalid fixes are dropped', () => {
  assert.equal(
    toSample(position({ accuracy: 400, speed: 5 }), null, 'car'),
    null,
  );
  assert.equal(toSample({ coords: {} }, null, 'car'), null);
  assert.equal(toSample(null, null, 'car'), null);
});

test('geometry helpers behave', () => {
  const a = { lat: 0, lon: 0 };
  const b = { lat: 0, lon: 1 };
  assert.ok(Math.abs(haversineM(a, b) - 111_195) < 300);
  assert.ok(Math.abs(bearingDeg(a, b) - 90) < 0.1);
});

test('retry delay backs off and is capped', () => {
  assert.equal(nextDelay(0), 5000);
  assert.equal(nextDelay(1), 10_000);
  assert.equal(nextDelay(99), 60_000);
  assert.ok(nextDelay(99) <= 60_000);
});

test('French is the default language; English when preferred', () => {
  assert.equal(pickLanguage(['fr-BF', 'en']), 'fr');
  assert.equal(pickLanguage(['en-GB']), 'en');
  assert.equal(pickLanguage(['de']), 'fr');
  assert.equal(pickLanguage(undefined), 'fr');
});

test('both languages define exactly the same messages', () => {
  assert.deepEqual(
    Object.keys(MESSAGES.fr).sort(),
    Object.keys(MESSAGES.en).sort(),
  );
  for (const lang of ['fr', 'en']) {
    for (const [key, value] of Object.entries(MESSAGES[lang])) {
      assert.ok(value.length > 0, `${lang}.${key}`);
    }
  }
});

test('every data-t key used by the page exists in both languages', () => {
  const html = readFileSync(
    new URL('../../public/contribute.html', import.meta.url),
    'utf8',
  );
  const keys = [...html.matchAll(/data-t="([A-Za-z]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length > 10);
  for (const key of keys) {
    assert.ok(key in MESSAGES.fr, `fr.${key}`);
    assert.ok(key in MESSAGES.en, `en.${key}`);
  }
  assert.ok(
    !/<script(?![^>]*\bsrc=)[^>]*>/i.test(html),
    'no inline script (CSP)',
  );
});
