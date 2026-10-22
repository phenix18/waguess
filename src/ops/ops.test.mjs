import test from 'node:test';
import assert from 'node:assert/strict';
import { createAlertBus, ALERT_KINDS } from './alertBus.js';
import { createAlertJournal } from './alertJournal.js';
import {
  createMemoryJournalStore,
  openJournalStore,
} from './journalStorage.js';
import {
  buildReport,
  renderCsv,
  renderHtml,
  renderMarkdown,
  whatsappText,
  whatsappUrl,
} from './report.js';
import {
  areaVerdict,
  bboxAround,
  compass,
  distanceM,
  parseCoordinates,
  rankSegments,
  searchActiveRoads,
} from './roadSearch.js';
import { createTrafficWatch } from './trafficWatch.js';
import { scanLayers } from './layerWatch.js';

const clock = (start = 1_700_000_000_000) => {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
};

test('bus publishes normalised alerts and isolates failing subscribers', () => {
  const c = clock();
  const bus = createAlertBus({ now: c.now });
  const seen = [];
  bus.subscribe(() => {
    throw new Error('boom');
  });
  bus.subscribe((a) => seen.push(a));
  const alert = bus.publish({
    kind: 'nope',
    severity: 'extreme',
    title: '  Road blocked  ',
    lat: 95,
    lon: -1.5,
  });
  assert.equal(alert.kind, 'system');
  assert.equal(alert.severity, 'info');
  assert.equal(alert.title, 'Road blocked');
  assert.equal(alert.lat, null);
  assert.equal(alert.lon, -1.5);
  assert.equal(seen.length, 1);
  assert.equal(bus.publish({ title: '   ' }), null);
  assert.ok(Object.hasOwn(ALERT_KINDS, 'traffic-jam'));
});

test('bus drops a repeat of the same key inside the window only', () => {
  const c = clock();
  const bus = createAlertBus({ now: c.now, dedupeMs: 60_000 });
  assert.ok(bus.publish({ title: 'a', key: 'k' }));
  assert.equal(bus.publish({ title: 'a', key: 'k' }), null);
  assert.ok(bus.publish({ title: 'b', key: 'other' }));
  c.advance(60_001);
  assert.ok(bus.publish({ title: 'a', key: 'k' }));
  const ids = new Set();
  for (let i = 0; i < 5; i += 1) ids.add(bus.publish({ title: `n${i}` }).id);
  assert.equal(ids.size, 5);
});

test('journal saves every alert as it happens, inside one session', async () => {
  const c = clock();
  const bus = createAlertBus({ now: c.now });
  const store = createMemoryJournalStore();
  const journal = createAlertJournal({
    bus,
    store,
    now: c.now,
    label: 'Poste 1',
  });
  const session = journal.start();
  assert.equal(
    journal.start().id,
    session.id,
    'starting twice keeps the session',
  );
  bus.publish({ kind: 'traffic-jam', severity: 'warning', title: 'one' });
  c.advance(1000);
  bus.publish({ kind: 'earthquake', severity: 'critical', title: 'two' });
  await journal.flush();
  const saved = await journal.getAlerts(session.id);
  assert.deepEqual(
    saved.map((a) => a.title),
    ['one', 'two'],
  );
  const [listed] = await journal.listSessions();
  assert.equal(listed.count, 2);
  assert.equal(listed.label, 'Poste 1');
  assert.equal(listed.endedAt, null);
  assert.equal(journal.status().saved, 2);
  assert.equal(
    await journal.deleteSession(session.id),
    false,
    'open session kept',
  );
  const closed = await journal.stop();
  assert.equal(closed.endedAt, c.now());
  bus.publish({ title: 'after stop' });
  await journal.flush();
  assert.equal((await journal.getAlerts(session.id)).length, 2);
  assert.equal(await journal.deleteSession(session.id), true);
  assert.deepEqual(await journal.listSessions(), []);
});

test('a failing store is counted, never thrown at the publisher', async () => {
  const bus = createAlertBus();
  const store = createMemoryJournalStore();
  store.appendAlert = async () => {
    throw new Error('disk full');
  };
  const journal = createAlertJournal({ bus, store });
  journal.start();
  assert.doesNotThrow(() => bus.publish({ title: 'x' }));
  await journal.flush();
  assert.equal(journal.status().failed, 1);
  assert.match(journal.status().lastError, /disk full/);
});

test('without IndexedDB the journal falls back to memory and says so', async () => {
  const store = await openJournalStore(undefined);
  assert.equal(store.persistent, false);
  const journal = createAlertJournal({ bus: createAlertBus(), store });
  journal.start();
  assert.equal(journal.status().persistent, false);
});

const ALERTS = [
  {
    id: '1',
    at: 1_700_000_000_000,
    kind: 'traffic-jam',
    severity: 'warning',
    title: 'Jam A',
    detail: '',
    lat: 12.3714,
    lon: -1.5197,
    source: 'crowd',
  },
  {
    id: '2',
    at: 1_700_000_600_000,
    kind: 'traffic-jam',
    severity: 'critical',
    title: 'Major jam',
    detail: '',
    lat: 12.3716,
    lon: -1.5199,
    source: 'crowd',
  },
  {
    id: '3',
    at: 1_700_004_000_000,
    kind: 'earthquake',
    severity: 'warning',
    title: '=HYPERLINK("x")',
    detail: 'a,b',
    lat: null,
    lon: null,
    source: 'q',
  },
  {
    id: '4',
    at: 1_700_004_100_000,
    kind: 'note',
    severity: 'info',
    title: '<b>note</b>',
    detail: '',
    lat: 5,
    lon: 5,
    source: '',
  },
];

test('report summarises severity, kinds, hotspots and priority alerts', () => {
  const report = buildReport(ALERTS, {
    generatedAt: 1_700_010_000_000,
    crowd: { counts: { jam: 2, heavy: 1 } },
  });
  assert.equal(report.total, 4);
  assert.deepEqual(report.bySeverity, { info: 1, warning: 2, critical: 1 });
  assert.equal(report.byKind['traffic-jam'], 2);
  assert.equal(report.highlights[0].id, '2', 'critical first');
  assert.equal(report.highlights.length, 3, 'info alerts are not highlights');
  assert.equal(report.hotspots[0].count, 2);
  assert.equal(report.hotspots[0].worst, 'critical');
  assert.deepEqual(report.crowd.counts, { free: 0, slow: 0, heavy: 1, jam: 2 });
  assert.ok(report.timeline.length >= 2);
  const empty = buildReport([], { generatedAt: 5 });
  assert.equal(empty.total, 0);
  assert.match(renderMarkdown(empty), /No alert in this period/);
});

test('markdown, html and chat renderings carry the facts and escape input', () => {
  const report = buildReport(ALERTS, {
    generatedAt: 1_700_010_000_000,
    crowd: { counts: { jam: 2 } },
  });
  const md = renderMarkdown(report);
  assert.match(md, /^# WAGUESS synthesis report/);
  assert.match(md, /4 alerts: 1 critical, 2 warning/);
  assert.match(md, /Roads: 2 jammed/);
  const html = renderHtml(report, { lang: 'fr' });
  assert.match(html, /<html lang="fr">/);
  assert.ok(!html.includes('<b>note</b>'), 'titles are escaped');
  assert.ok(!/<script/i.test(html));
  const text = whatsappText(report);
  assert.match(text, /Major jam/);
  const url = whatsappUrl(text);
  assert.ok(url.startsWith('https://wa.me/?text='));
  assert.equal(
    decodeURIComponent(url.slice('https://wa.me/?text='.length)),
    text,
  );
  const long = whatsappText({
    ...report,
    highlights: Array(20).fill({ ...ALERTS[1], title: 'x'.repeat(600) }),
  });
  assert.ok(long.length <= 1400);
});

test('csv quotes fields and neutralises formulas', () => {
  const csv = renderCsv(ALERTS);
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(lines.length, 5);
  assert.equal(
    lines[0],
    'id,time_utc,kind,severity,title,detail,lat,lon,source',
  );
  assert.match(lines[3], /"'=HYPERLINK\(""x""\)","a,b"/);
  assert.match(lines[1], /2023-11-14T22:13:20\.000Z/);
});

test('compass, distance and coordinate parsing', () => {
  assert.equal(compass(0), 'N');
  assert.equal(compass(95), 'E');
  assert.equal(compass(225), 'SW');
  assert.equal(compass(359), 'N');
  assert.equal(compass(null), '');
  assert.ok(
    Math.abs(distanceM({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) - 111_195) < 300,
  );
  assert.deepEqual(parseCoordinates('12.3714, -1.5197'), {
    lat: 12.3714,
    lon: -1.5197,
  });
  assert.deepEqual(parseCoordinates('12,3714 ; -1,5197'), {
    lat: 12.3714,
    lon: -1.5197,
  });
  assert.deepEqual(parseCoordinates('12.37 N 1.52 O'), {
    lat: 12.37,
    lon: -1.52,
  });
  assert.deepEqual(parseCoordinates('12.37 S, 1.52 W'), {
    lat: -12.37,
    lon: -1.52,
  });
  assert.deepEqual(parseCoordinates('12.37 N, 1.52 E'), {
    lat: 12.37,
    lon: 1.52,
  });
  assert.equal(parseCoordinates('95, 10'), null);
  assert.equal(parseCoordinates('Ouagadougou'), null);
  const box = bboxAround({ lat: 12.37, lon: -1.52 }, 3000);
  assert.ok(box.east - box.west > 0.05 && box.north - box.south > 0.05);
});

const SEGMENTS = {
  features: [
    {
      geometry: {
        type: 'LineString',
        coordinates: [
          [-1.5201, 12.3714],
          [-1.5193, 12.3714],
        ],
      },
      properties: {
        level: 'jam',
        speedKmh: 4,
        heading: 90,
        contributors: 5,
        ageS: 20,
        confidence: 0.5,
      },
    },
    {
      geometry: { type: 'Point', coordinates: [-1.5197, 12.39] },
      properties: { level: 'free', speedKmh: 40, contributors: 3 },
    },
    {
      geometry: { type: 'Point', coordinates: [-1.6, 12.5] },
      properties: { level: 'jam' },
    },
    { geometry: null, properties: { level: 'jam' } },
  ],
};

test('active roads are ranked by distance, then saturation', () => {
  const origin = { lat: 12.3714, lon: -1.5197 };
  const rows = rankSegments(SEGMENTS, origin, 3000);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].level, 'jam');
  assert.ok(rows[0].distanceM < 50);
  assert.equal(rows[1].level, 'free');
  assert.equal(areaVerdict(rows), 'jam');
  assert.equal(areaVerdict([]), null);
});

test('searchActiveRoads asks the crowd API for a box and reports failures', async () => {
  let requested;
  const ok = await searchActiveRoads(
    { lat: 12.3714, lon: -1.5197 },
    {
      radiusM: 3000,
      fetchImpl: async (url) => {
        requested = url;
        return {
          ok: true,
          json: async () => ({ ...SEGMENTS, meta: { counts: {} } }),
        };
      },
    },
  );
  assert.match(requested, /^\/api\/crowd\/segments\?bbox=-?\d/);
  assert.equal(ok.rows.length, 2);
  assert.equal(ok.verdict, 'jam');
  await assert.rejects(
    searchActiveRoads(
      { lat: 1, lon: 1 },
      { fetchImpl: async () => ({ ok: false, status: 429 }) },
    ),
    (e) => e.status === 429,
  );
});

function cell(lat, lon, level, extra = {}) {
  return {
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: {
      level,
      speedKmh: 5,
      contributors: 4,
      confidence: 0.5,
      heading: 90,
      ...extra,
    },
  };
}

test('traffic watch alerts once per jam, escalates clusters, reports recovery', () => {
  const c = clock();
  const bus = createAlertBus({ now: c.now });
  const alerts = [];
  bus.subscribe((a) => alerts.push(a));
  const watch = createTrafficWatch({ bus, describe: () => 'Avenue Kwame' });

  watch.update({ features: [cell(12.3714, -1.5197, 'jam')] });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'traffic-jam');
  assert.equal(alerts[0].severity, 'warning');
  assert.match(alerts[0].title, /Traffic jam · Avenue Kwame/);

  watch.update({ features: [cell(12.3714, -1.5197, 'jam')] });
  assert.equal(alerts.length, 1, 'unchanged jam is not repeated');

  watch.update({
    features: [cell(12.3714, -1.5197, 'free', { speedKmh: 44 })],
  });
  assert.equal(alerts.at(-1).kind, 'traffic-clear');
  assert.equal(alerts.at(-1).severity, 'info');

  const cluster = [0, 1, 2, 3].map((i) =>
    cell(12.38 + i * 0.001, -1.52, 'jam'),
  );
  watch.update({ features: cluster });
  assert.ok(
    alerts.some(
      (a) => a.severity === 'critical' && /Major congestion/.test(a.title),
    ),
  );
});

test('traffic watch ignores low-confidence cells and data gaps', () => {
  const bus = createAlertBus();
  const alerts = [];
  bus.subscribe((a) => alerts.push(a));
  const watch = createTrafficWatch({ bus });
  watch.update({ features: [cell(12.3, -1.5, 'jam', { confidence: 0.1 })] });
  assert.equal(alerts.length, 0);
  watch.update({ features: [cell(12.3, -1.5, 'jam')] });
  assert.equal(alerts.length, 1);
  watch.update({ features: [] });
  assert.equal(alerts.length, 1, 'a gap in the data is not a recovery');
  assert.deepEqual(watch.update(null), { published: 0, tracked: 1 });
});

test('layer watch reports emergencies and strong earthquakes once', () => {
  const bus = createAlertBus();
  const alerts = [];
  bus.subscribe((a) => alerts.push(a));
  const layers = {
    flights: [
      {
        icao24: 'abc123',
        callsign: 'AF123',
        emergency: true,
        emergencyKind: 'general',
        squawk: '7700',
        emergencyBroadcast: 'broadcasting squawk 7700 (general emergency)',
        lat: 12,
        lon: -1,
      },
      { icao24: 'def456', callsign: 'QQ1', emergency: false },
    ],
    military: [],
    earthquakes: [
      { id: 'us1', mag: 6.8, place: '10 km W of X', lat: 1, lon: 2, depth: 10 },
      { id: 'us2', mag: 4.1, lat: 1, lon: 2 },
      { id: 'us3', mag: 5.7, lat: 3, lon: 4 },
    ],
  };
  const dataManager = {
    layers: new Map(
      Object.entries(layers).map(([id, rows]) => [
        id,
        { module: { getAnalystRecords: () => rows } },
      ]),
    ),
    isEnabled: (id) => id !== 'military',
  };
  assert.equal(scanLayers({ dataManager, bus }), 3);
  assert.equal(
    scanLayers({ dataManager, bus }),
    0,
    'second scan is deduplicated',
  );
  const kinds = alerts.map((a) => `${a.kind}:${a.severity}`).sort();
  assert.deepEqual(kinds, [
    'aircraft-emergency:critical',
    'earthquake:critical',
    'earthquake:warning',
  ]);
  assert.match(
    alerts.find((a) => a.kind === 'aircraft-emergency').title,
    /AF123/,
  );
  assert.equal(
    scanLayers({
      dataManager: { layers: new Map(), isEnabled: () => false },
      bus,
    }),
    0,
  );
});

test('gazetteer finds Burkina towns offline, ignoring accents and case', async () => {
  const { findPlace, GAZETTEER_PRESETS } = await import('./gazetteer.js');
  assert.equal(findPlace('OUAGA').name, 'Ouagadougou');
  assert.equal(findPlace('dedougou').name, 'Dédougou');
  assert.equal(findPlace("fada n'gourma").name, "Fada N'Gourma");
  assert.equal(findPlace('bobo').name, 'Bobo-Dioulasso');
  assert.equal(findPlace('ou'), null);
  assert.equal(findPlace('atlantis'), null);
  const { nearestPlaceName } = await import('./describe.js');
  assert.equal(
    nearestPlaceName({ lat: 12.37, lon: -1.52 }, GAZETTEER_PRESETS),
    'Ouagadougou',
  );
});
