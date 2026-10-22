// Draws the crowd-sourced road saturation on the globe: one coloured segment
// per published road cell (green flowing → red jammed). It owns one Cesium
// data source and one poll timer, and releases both on destroy.
import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import { bboxParam } from './roadSearch.js';

export const POLL_MS = 15_000;
export const MAX_SPAN_DEG = 5;

export const LEVEL_COLORS = Object.freeze({
  free: '#2ecc71',
  slow: '#f1c40f',
  heavy: '#e67e22',
  jam: '#e74c3c',
});
const LEVEL_WIDTH = Object.freeze({ free: 4, slow: 5, heavy: 6, jam: 8 });

/** View rectangle in degrees, or null when the camera sees no ground. */
export function viewBox(viewer) {
  const rect = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid);
  if (!rect) return null;
  const toDeg = Cesium.Math.toDegrees;
  const box = {
    west: toDeg(rect.west),
    south: toDeg(rect.south),
    east: toDeg(rect.east),
    north: toDeg(rect.north),
  };
  if (box.east < box.west) return null;
  return box;
}

/**
 * @param {object} config
 * @param {object} config.viewer - Cesium viewer.
 * @param {{update: Function}} config.trafficWatch
 * @param {typeof fetch} [config.fetchImpl]
 */
export function createCrowdOverlay({
  viewer,
  trafficWatch,
  fetchImpl = (...args) => fetch(...args),
  pollMs = POLL_MS,
}) {
  const dataSource = new Cesium.CustomDataSource('waguess-crowd-traffic');
  viewer.dataSources.add(dataSource);
  const listeners = new Set();
  let enabled = false;
  let timer = null;
  let controller = null;
  let destroyed = false;
  let state = { state: 'off', counts: null, generatedAt: null, error: null };
  let lastCollection = null;

  const publish = (next) => {
    state = { ...state, ...next };
    for (const listener of [...listeners]) listener({ ...state });
  };

  function draw(collection) {
    dataSource.entities.suspendEvents();
    try {
      dataSource.entities.removeAll();
      for (const feature of collection.features ?? []) {
        const level = feature.properties?.level;
        const color = Cesium.Color.fromCssColorString(
          LEVEL_COLORS[level] ?? LEVEL_COLORS.free,
        ).withAlpha(0.9);
        const g = feature.geometry;
        if (g?.type === 'LineString') {
          dataSource.entities.add({
            polyline: {
              positions: Cesium.Cartesian3.fromDegreesArray(
                g.coordinates.flat(),
              ),
              width: LEVEL_WIDTH[level] ?? 4,
              material: color,
              clampToGround: true,
              classificationType: Cesium.ClassificationType.BOTH,
            },
          });
        } else if (g?.type === 'Point') {
          dataSource.entities.add({
            position: Cesium.Cartesian3.fromDegrees(...g.coordinates),
            point: {
              pixelSize: 10,
              color,
              outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
              outlineWidth: 1,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: 0,
            },
          });
        }
      }
    } finally {
      dataSource.entities.resumeEvents();
    }
    governorRequestRender('crowd-traffic');
  }

  async function refresh() {
    if (!enabled || destroyed) return;
    const box = viewBox(viewer);
    if (
      !box ||
      box.east - box.west > MAX_SPAN_DEG ||
      box.north - box.south > MAX_SPAN_DEG
    ) {
      publish({ state: 'zoom', error: null });
      return;
    }
    controller?.abort();
    controller = new AbortController();
    try {
      const response = await fetchImpl(
        `/api/crowd/segments?bbox=${bboxParam(box)}`,
        {
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        publish({
          state: response.status === 404 ? 'unavailable' : 'error',
          error: response.status,
        });
        return;
      }
      const collection = await response.json();
      if (!enabled || destroyed) return;
      lastCollection = collection;
      draw(collection);
      trafficWatch?.update(collection);
      publish({
        state: collection.features?.length ? 'ok' : 'empty',
        counts: collection.meta?.counts ?? null,
        generatedAt: collection.meta?.generatedAt ?? null,
        error: null,
      });
    } catch (error) {
      if (error?.name === 'AbortError') return;
      publish({ state: 'error', error: String(error?.message || error) });
    }
  }

  const schedule = () => {
    clearTimeout(timer);
    if (!enabled || destroyed) return;
    timer = setTimeout(async () => {
      if (!document.hidden) await refresh();
      schedule();
    }, pollMs);
  };

  const onMoveEnd = () => {
    if (enabled) refresh();
  };

  return {
    setEnabled(value) {
      if (destroyed || enabled === Boolean(value)) return;
      enabled = Boolean(value);
      if (enabled) {
        viewer.camera.moveEnd.addEventListener(onMoveEnd);
        publish({ state: 'loading' });
        refresh();
        schedule();
      } else {
        viewer.camera.moveEnd.removeEventListener(onMoveEnd);
        clearTimeout(timer);
        controller?.abort();
        dataSource.entities.removeAll();
        lastCollection = null;
        publish({ state: 'off', counts: null, error: null });
        governorRequestRender('crowd-traffic');
      }
    },
    isEnabled: () => enabled,
    refresh,
    getCollection: () => lastCollection,
    getState: () => ({ ...state }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      if (destroyed) return;
      this.setEnabled(false);
      destroyed = true;
      listeners.clear();
      if (!viewer.isDestroyed?.()) viewer.dataSources.remove(dataSource, true);
    },
  };
}
