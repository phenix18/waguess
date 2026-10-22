// Turns successive road-saturation pictures into alerts: a road section that
// becomes heavy or jammed, a cluster of jams (major congestion), and the
// return to normal. Pure: it only reads GeoJSON and publishes to a bus.
import { formatNumber, t } from '../i18n/index.js';
import { distanceM } from './roadSearch.js';

const CLUSTER_RADIUS_M = 600;
const CLUSTER_SIZE = 4;
const MIN_CONFIDENCE = 0.3;

function pointOf(feature) {
  const g = feature.geometry;
  if (g?.type === 'Point')
    return { lon: g.coordinates[0], lat: g.coordinates[1] };
  if (g?.type === 'LineString' && g.coordinates.length) {
    const c = g.coordinates;
    return {
      lon: c.reduce((s, p) => s + p[0], 0) / c.length,
      lat: c.reduce((s, p) => s + p[1], 0) / c.length,
    };
  }
  return null;
}

/** Stable key for a road section: ~110 m grid plus travel direction. */
export function segmentKey(point, heading) {
  return `${point.lat.toFixed(3)}:${point.lon.toFixed(3)}:${heading ?? 'x'}`;
}

/**
 * @param {object} config
 * @param {{publish: Function}} config.bus
 * @param {(point:{lat:number,lon:number}) => string} [config.describe]
 */
export function createTrafficWatch({ bus, describe = () => '' }) {
  /** key -> last bad level ('heavy' | 'jam') */
  const bad = new Map();

  function update(collection) {
    const rows = [];
    for (const feature of collection?.features ?? []) {
      const point = pointOf(feature);
      const p = feature.properties || {};
      if (!point || !p.level) continue;
      rows.push({ key: segmentKey(point, p.heading), point, p });
    }
    const current = new Map(rows.map((r) => [r.key, r]));
    const jams = rows.filter((r) => r.p.level === 'jam');
    let published = 0;

    for (const row of rows) {
      const { level, speedKmh, confidence } = row.p;
      if (
        (level === 'jam' || level === 'heavy') &&
        confidence >= MIN_CONFIDENCE
      ) {
        const before = bad.get(row.key);
        bad.set(row.key, level);
        if (before === level) continue;
        const where = describe(row.point);
        const clustered =
          level === 'jam' &&
          jams.filter((j) => distanceM(j.point, row.point) <= CLUSTER_RADIUS_M)
            .length >= CLUSTER_SIZE;
        const alert = bus.publish({
          kind: 'traffic-jam',
          severity: clustered ? 'critical' : 'warning',
          title: clustered
            ? t('Major congestion{where}', {
                where: where ? ` · ${where}` : '',
              })
            : level === 'jam'
              ? t('Traffic jam{where}', { where: where ? ` · ${where}` : '' })
              : t('Heavy traffic{where}', {
                  where: where ? ` · ${where}` : '',
                }),
          detail: t('Median speed {speed} km/h, {count} vehicles sharing', {
            speed: formatNumber(speedKmh ?? 0),
            count: formatNumber(row.p.contributors ?? 0),
          }),
          lat: row.point.lat,
          lon: row.point.lon,
          source: 'crowd',
          key: `jam:${row.key}:${level}`,
        });
        if (alert) published += 1;
      }
    }

    for (const [key, level] of [...bad]) {
      const now = current.get(key);
      const recovered =
        now && (now.p.level === 'free' || now.p.level === 'slow');
      if (!recovered) {
        // Not published any more (vehicles left): keep it until it recovers or
        // is forgotten, so a brief gap in the data does not fake a recovery.
        if (!now && bad.size > 5000) bad.delete(key);
        continue;
      }
      bad.delete(key);
      const where = describe(now.point);
      bus.publish({
        kind: 'traffic-clear',
        severity: 'info',
        title: t('Traffic back to normal{where}', {
          where: where ? ` · ${where}` : '',
        }),
        detail: t('Median speed {speed} km/h', {
          speed: formatNumber(now.p.speedKmh ?? 0),
        }),
        lat: now.point.lat,
        lon: now.point.lon,
        source: 'crowd',
        key: `clear:${key}:${level}`,
      });
    }
    return { published, tracked: bad.size };
  }

  return { update, reset: () => bad.clear() };
}
