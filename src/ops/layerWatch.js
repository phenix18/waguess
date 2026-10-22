// Scans enabled layers for events an operator must be told about, without
// touching how those layers fetch or draw: aircraft broadcasting an emergency
// and strong earthquakes. Read-only; uses the layers' own analyst records.
import { formatNumber, t } from '../i18n/index.js';

export const QUAKE_WARNING_MAG = 5.5;
export const QUAKE_CRITICAL_MAG = 6.5;
export const WATCH_INTERVAL_MS = 20_000;
const MAX_RECORDS = 3000;

function records(dataManager, id) {
  const layer = dataManager?.layers?.get?.(id);
  if (!layer || !dataManager.isEnabled?.(id)) return [];
  try {
    return layer.module?.getAnalystRecords?.(MAX_RECORDS) ?? [];
  } catch {
    return [];
  }
}

/** Scan once. Returns the number of alerts published. */
export function scanLayers({ dataManager, bus }) {
  let published = 0;
  for (const layerId of ['flights', 'military']) {
    for (const r of records(dataManager, layerId)) {
      if (r?.emergency !== true) continue;
      const name = r.callsign || r.icao24 || t('unknown aircraft');
      const alert = bus.publish({
        kind: 'aircraft-emergency',
        severity: 'critical',
        title: t('Aircraft emergency: {name}', { name }),
        detail:
          r.emergencyBroadcast ||
          (r.squawk ? t('Squawk {code}', { code: r.squawk }) : ''),
        lat: r.lat,
        lon: r.lon,
        source: layerId,
        key: `sq:${r.icao24}:${r.emergencyKind || r.squawk}`,
      });
      if (alert) published += 1;
    }
  }
  for (const r of records(dataManager, 'earthquakes')) {
    const mag = Number(r?.mag ?? r?.magnitude);
    if (!Number.isFinite(mag) || mag < QUAKE_WARNING_MAG) continue;
    const alert = bus.publish({
      kind: 'earthquake',
      severity: mag >= QUAKE_CRITICAL_MAG ? 'critical' : 'warning',
      title: t('Earthquake M{mag}{place}', {
        mag: formatNumber(mag, { maximumFractionDigits: 1 }),
        place: r.place ? ` · ${r.place}` : '',
      }),
      detail: Number.isFinite(r.depth)
        ? t('Depth {km} km', { km: formatNumber(r.depth) })
        : '',
      lat: r.lat,
      lon: r.lon,
      source: 'earthquakes',
      key: `eq:${r.usgsId ?? r.id ?? `${r.lat},${r.lon},${mag}`}`,
    });
    if (alert) published += 1;
  }
  return published;
}

/** Scan on a timer; returns a stop function. */
export function startLayerWatch({
  dataManager,
  bus,
  intervalMs = WATCH_INTERVAL_MS,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
}) {
  const id = setIntervalImpl(
    () => scanLayers({ dataManager, bus }),
    intervalMs,
  );
  return () => clearIntervalImpl(id);
}
