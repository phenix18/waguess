// Operational alert bus: one place where detectors publish what an operator
// must not miss, and where the journal, the panel and the report subscribe.
// Pure: no DOM, no storage, injectable clock.
import { msg } from '../i18n/marker.js';

/** Severities, least to most urgent. */
export const SEVERITIES = Object.freeze(['info', 'warning', 'critical']);

/** Alert kinds with the English label the UI translates. */
export const ALERT_KINDS = Object.freeze({
  'traffic-jam': msg('Traffic jam'),
  'traffic-clear': msg('Traffic cleared'),
  'aircraft-emergency': msg('Aircraft emergency'),
  earthquake: msg('Earthquake'),
  note: msg('Operator note'),
  system: msg('System'),
});

const COORD_LIMITS = Object.freeze({ lat: 90, lon: 180 });

function coordinate(value, limit) {
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}

/**
 * Create a bus.
 * @param {object} [config]
 * @param {() => number} [config.now]
 * @param {number} [config.dedupeMs] - The same `key` is published once per window.
 * @param {number} [config.maxKeys] - Dedupe memory bound.
 */
export function createAlertBus({
  now = Date.now,
  dedupeMs = 10 * 60_000,
  maxKeys = 2000,
} = {}) {
  const listeners = new Set();
  const seen = new Map();
  let counter = 0;

  function remember(key, at) {
    seen.set(key, at);
    if (seen.size > maxKeys) {
      for (const [k, v] of seen) {
        if (at - v > dedupeMs || seen.size > maxKeys) seen.delete(k);
        if (seen.size <= maxKeys * 0.9) break;
      }
    }
  }

  /**
   * Publish an alert. Returns the stored alert, or null when it is a repeat of
   * a recent one (same `key`) or has no usable title.
   */
  function publish({
    kind = 'system',
    severity = 'info',
    title,
    detail = '',
    lat,
    lon,
    source = '',
    key,
  } = {}) {
    const text = String(title ?? '').trim();
    if (!text) return null;
    const at = now();
    if (key !== undefined) {
      const previous = seen.get(key);
      if (previous !== undefined && at - previous < dedupeMs) return null;
      remember(key, at);
    }
    counter += 1;
    const alert = Object.freeze({
      id: `${at.toString(36)}-${counter.toString(36)}`,
      at,
      kind: Object.hasOwn(ALERT_KINDS, kind) ? kind : 'system',
      severity: SEVERITIES.includes(severity) ? severity : 'info',
      title: text.slice(0, 160),
      detail: String(detail ?? '').slice(0, 500),
      lat: coordinate(lat, COORD_LIMITS.lat),
      lon: coordinate(lon, COORD_LIMITS.lon),
      source: String(source ?? '').slice(0, 80),
    });
    for (const listener of [...listeners]) {
      try {
        listener(alert);
      } catch {
        /* one failing subscriber must not hide an alert from the others */
      }
    }
    return alert;
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { publish, subscribe, size: () => listeners.size };
}
