// Human-readable place for a coordinate, from the bundled city and landmark
// data only (no network call, no paid geocoder).
import { distanceM } from './roadSearch.js';

const LANDMARK_RADIUS_M = 1500;
const CITY_RADIUS_M = 30_000;

/**
 * @param {{lat:number, lon:number}} point
 * @param {Record<string, {name:string, lat?:number, lon?:number, pois?: Array<{name:string, lat:number, lon:number}>, viewBounds?: object}>} presets
 * @returns {string} Landmark, else city, else ''.
 */
export function nearestPlaceName(point, presets) {
  let bestPoi = null;
  let bestCity = null;
  for (const city of Object.values(presets || {})) {
    const pois = city?.pois ?? [];
    const first = pois[0];
    const centre = Number.isFinite(city?.lat)
      ? { lat: city.lat, lon: city.lon }
      : first
        ? { lat: first.lat, lon: first.lon }
        : null;
    if (centre) {
      const d = distanceM(point, centre);
      if (d <= CITY_RADIUS_M && (!bestCity || d < bestCity.d)) {
        bestCity = { d, name: city.name };
      }
    }
    for (const poi of pois) {
      if (!Number.isFinite(poi?.lat) || !Number.isFinite(poi?.lon)) continue;
      const d = distanceM(point, poi);
      if (d <= LANDMARK_RADIUS_M && (!bestPoi || d < bestPoi.d)) {
        bestPoi = { d, name: poi.name };
      }
    }
  }
  if (bestPoi) return bestPoi.name;
  return bestCity ? bestCity.name : '';
}
