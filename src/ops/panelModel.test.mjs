import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contributeUrl,
  exportName,
  overlayStatusText,
  roadRow,
  storageNote,
  verdictText,
} from './panelModel.js';

test('exportName is stable and filesystem-safe', () => {
  const name = exportName(
    'report',
    'html',
    new Date(2026, 9, 22, 8, 5).getTime(),
  );
  assert.equal(name, 'waguess-report-20261022-0805.html');
});

test('contributeUrl tolerates trailing slashes', () => {
  assert.equal(
    contributeUrl('https://x.org/'),
    'https://x.org/contribute.html',
  );
});

test('status texts cover every overlay state and storage mode', () => {
  for (const state of [
    'off',
    'loading',
    'zoom',
    'unavailable',
    'error',
    'empty',
  ]) {
    assert.ok(overlayStatusText({ state }).length > 5, state);
  }
  assert.match(
    overlayStatusText({
      state: 'ok',
      counts: { jam: 2, heavy: 1, slow: 0, free: 5 },
    }),
    /2/,
  );
  assert.ok(storageNote({ persistent: true }));
  assert.match(storageNote({ persistent: false }), /./);
  assert.match(storageNote({ failed: 3 }), /3/);
});

test('verdicts and road rows are readable', () => {
  for (const level of ['jam', 'heavy', 'slow', 'free', null]) {
    assert.ok(verdictText(level));
  }
  const row = roadRow({
    level: 'jam',
    distanceM: 420,
    heading: 90,
    speedKmh: 8,
    contributors: 4,
    ageS: 12,
    lat: 1,
    lon: 2,
  });
  assert.match(row.detail, /8/);
  assert.equal(row.lat, 1);
});
