// Text and shape of what the Operations panel shows, kept out of the DOM code
// so it can be unit-tested and translated in one place.
import { formatDate, formatNumber, t, tn } from '../i18n/index.js';
import { ALERT_KINDS } from './alertBus.js';
import { LEVEL_LABELS, compass } from './roadSearch.js';

const pad = (n) => String(n).padStart(2, '0');

/** One sentence for the road-saturation overlay state. */
export function overlayStatusText(state) {
  switch (state?.state) {
    case 'loading':
      return t('Loading road saturation…');
    case 'zoom':
      return t('Zoom in on a city to see road saturation.');
    case 'unavailable':
      return t('Crowd traffic is not available on this server.');
    case 'error':
      return t('Crowd traffic could not be loaded. Retrying…');
    case 'empty':
      return t(
        'No road has enough vehicles sharing their position yet (at least 3 are needed).',
      );
    case 'ok': {
      const c = state.counts || {};
      return t('{jam} jammed · {heavy} heavy · {slow} slow · {free} flowing', {
        jam: formatNumber(c.jam ?? 0),
        heavy: formatNumber(c.heavy ?? 0),
        slow: formatNumber(c.slow ?? 0),
        free: formatNumber(c.free ?? 0),
      });
    }
    default:
      return t('Road saturation is off.');
  }
}

/** Where the journal is saved, in words. */
export function storageNote(status) {
  if (status?.failed > 0) {
    return t('Some alerts could not be saved ({count}).', {
      count: formatNumber(status.failed),
    });
  }
  return status?.persistent
    ? t('Saved automatically on this device.')
    : t('Kept in memory only: browser storage is unavailable.');
}

export function alertRow(alert) {
  return {
    id: alert.id,
    severity: alert.severity,
    time: formatDate(alert.at, { timeStyle: 'medium' }),
    kind: t(ALERT_KINDS[alert.kind] ?? ALERT_KINDS.system),
    title: alert.title,
    detail: alert.detail,
    hasPosition: alert.lat !== null && alert.lon !== null,
    lat: alert.lat,
    lon: alert.lon,
  };
}

export function sessionRow(session) {
  const started = formatDate(session.startedAt, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return {
    id: session.id,
    title: session.label ? `${session.label} · ${started}` : started,
    subtitle: [
      tn(session.count, '{count} alert', '{count} alerts', {
        count: formatNumber(session.count),
      }),
      session.endedAt ? t('closed') : t('in progress'),
    ].join(' · '),
    open: !session.endedAt,
  };
}

export function verdictText(level) {
  switch (level) {
    case 'jam':
      return t('Around you: roads are jammed.');
    case 'heavy':
      return t('Around you: heavy traffic.');
    case 'slow':
      return t('Around you: traffic is slow.');
    case 'free':
      return t('Around you: traffic is flowing.');
    default:
      return t('No active vehicle found nearby.');
  }
}

export function roadRow(row) {
  const km = row.distanceM / 1000;
  const distance =
    row.distanceM < 1000
      ? t('{m} m', { m: formatNumber(Math.round(row.distanceM / 10) * 10) })
      : t('{km} km', { km: formatNumber(km, { maximumFractionDigits: 1 }) });
  const direction = compass(row.heading);
  const parts = [
    row.speedKmh === null
      ? null
      : t('{speed} km/h', { speed: formatNumber(row.speedKmh) }),
    direction ? t('heading {direction}', { direction }) : null,
    tn(row.contributors, '{count} vehicle', '{count} vehicles', {
      count: formatNumber(row.contributors),
    }),
    row.ageS === null ? null : t('{s} s ago', { s: formatNumber(row.ageS) }),
  ].filter(Boolean);
  return {
    level: row.level,
    title: `${t(LEVEL_LABELS[row.level])} · ${distance}`,
    detail: parts.join(' · '),
    lat: row.lat,
    lon: row.lon,
  };
}

/** `waguess-<kind>-YYYYMMDD-HHMM.<ext>` in local time. */
export function exportName(kind, ext, at = Date.now()) {
  const d = new Date(at);
  return `waguess-${kind}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.${ext}`;
}

/** Address a phone should open to contribute (this server's page). */
export function contributeUrl(origin) {
  return `${String(origin || '').replace(/\/+$/, '')}/contribute.html`;
}
