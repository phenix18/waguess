// "Around me" search over active roads: which road sections near a point have
// vehicles sharing their position right now, and how saturated are they.
// Pure helpers plus one fetch; the geolocation call lives in the panel.
import { msg } from '../i18n/marker.js';

const EARTH_M = 6_371_000;
const LEVEL_ORDER = Object.freeze({ jam: 3, heavy: 2, slow: 1, free: 0 });

export const LEVEL_LABELS = Object.freeze({
  free: msg('Flowing'),
  slow: msg('Slow'),
  heavy: msg('Heavy'),
  jam: msg('Jammed'),
});

/** Compass points, as the short codes the rest of the app already uses. */
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export function compass(heading) {
  if (!Number.isFinite(heading)) return '';
  return COMPASS[Math.round((((heading % 360) + 360) % 360) / 45) % 8];
}

export function distanceM(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Bounding box (degrees) around a point, for the crowd API. */
export function bboxAround({ lat, lon }, radiusM) {
  const dLat = radiusM / 111_320;
  const dLon =
    radiusM / (111_320 * Math.max(Math.cos((lat * Math.PI) / 180), 0.05));
  return {
    west: Math.max(-180, lon - dLon),
    south: Math.max(-85, lat - dLat),
    east: Math.min(180, lon + dLon),
    north: Math.min(85, lat + dLat),
  };
}

export function bboxParam(bbox) {
  return [bbox.west, bbox.south, bbox.east, bbox.north]
    .map((n) => n.toFixed(5))
    .join(',');
}

function center(geometry) {
  if (!geometry) return null;
  if (geometry.type === 'Point') {
    const [lon, lat] = geometry.coordinates;
    return { lat, lon };
  }
  if (geometry.type === 'LineString' && geometry.coordinates.length) {
    const pts = geometry.coordinates;
    return {
      lat: pts.reduce((s, p) => s + p[1], 0) / pts.length,
      lon: pts.reduce((s, p) => s + p[0], 0) / pts.length,
    };
  }
  return null;
}

/**
 * Rank published road cells around a point: nearest first within the radius,
 * with the worst saturation breaking near-ties.
 * @param {{features?: Array<object>}} collection
 * @param {{lat:number, lon:number}} origin
 * @param {number} radiusM
 */
export function rankSegments(collection, origin, radiusM) {
  const rows = [];
  for (const feature of collection?.features ?? []) {
    const at = center(feature.geometry);
    if (!at) continue;
    const distance = distanceM(origin, at);
    if (distance > radiusM) continue;
    const p = feature.properties || {};
    rows.push({
      lat: at.lat,
      lon: at.lon,
      distanceM: Math.round(distance),
      level: p.level in LEVEL_ORDER ? p.level : 'free',
      speedKmh: p.speedKmh ?? null,
      freeFlowKmh: p.freeFlowKmh ?? null,
      heading: p.heading ?? null,
      contributors: p.contributors ?? 0,
      ageS: p.ageS ?? null,
      confidence: p.confidence ?? 0,
    });
  }
  rows.sort(
    (a, b) =>
      Math.floor(a.distanceM / 250) - Math.floor(b.distanceM / 250) ||
      LEVEL_ORDER[b.level] - LEVEL_ORDER[a.level] ||
      a.distanceM - b.distanceM,
  );
  return rows;
}

/** Overall verdict for a ranked list: the worst level among the nearest cells. */
export function areaVerdict(rows, nearest = 5) {
  if (!rows.length) return null;
  return rows
    .slice(0, nearest)
    .reduce(
      (worst, r) =>
        LEVEL_ORDER[r.level] > LEVEL_ORDER[worst] ? r.level : worst,
      'free',
    );
}

/** Parse "12.3714, -1.5197" (also "12.3714 -1.5197" and a trailing N/S/E/W). */
export function parseCoordinates(text) {
  const match = String(text ?? '')
    .trim()
    .match(
      /^(-?\d{1,2}(?:[.,]\d+)?)\s*°?\s*([NS])?\s*[,;\s]\s*(-?\d{1,3}(?:[.,]\d+)?)\s*°?\s*([EWO])?$/i,
    );
  if (!match) return null;
  let lat = Number(match[1].replace(',', '.'));
  let lon = Number(match[3].replace(',', '.'));
  if (match[2]?.toUpperCase() === 'S') lat = -Math.abs(lat);
  if (['W', 'O'].includes(match[4]?.toUpperCase())) lon = -Math.abs(lon);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/**
 * Fetch and rank the active roads near a point.
 * @param {{lat:number, lon:number}} origin
 * @param {{radiusM?: number, fetchImpl?: typeof fetch, signal?: AbortSignal, base?: string}} [options]
 */
export async function searchActiveRoads(
  origin,
  { radiusM = 3000, fetchImpl = fetch, signal, base = '' } = {},
) {
  const bbox = bboxAround(origin, radiusM);
  const response = await fetchImpl(
    `${base}/api/crowd/segments?bbox=${bboxParam(bbox)}`,
    { signal },
  );
  if (!response.ok) {
    const error = new Error(`Crowd traffic answered HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const collection = await response.json();
  const rows = rankSegments(collection, origin, radiusM);
  return { rows, verdict: areaVerdict(rows), meta: collection.meta ?? null };
}
