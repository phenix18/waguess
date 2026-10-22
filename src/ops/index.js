// Operations module entry: wires the alert bus, the persistent journal, the
import * as Cesium from 'cesium';
// crowd-traffic overlay, the layer watchers and the panel together.
import { CITY_POIS } from '../cityPois.js';
import { createAlertBus } from './alertBus.js';
import { GAZETTEER_PRESETS } from './gazetteer.js';
import { createAlertJournal } from './alertJournal.js';
import { createCrowdOverlay } from './crowdOverlay.js';
import { nearestPlaceName } from './describe.js';
import { openJournalStore } from './journalStorage.js';
import { startLayerWatch } from './layerWatch.js';
import { createOperationsPanel } from './panel.js';
import { createTrafficWatch } from './trafficWatch.js';

function browserLocate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('geolocation unavailable'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      reject,
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 30_000 },
    );
  });
}

function browserDownload(name, mime, text) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function browserCopy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* clipboard may be blocked outside HTTPS; the report can still be downloaded */
  }
}

/**
 * @param {object} deps
 * @param {object} deps.viewer Cesium viewer.
 * @param {object} [deps.dataManager] Layer manager (for emergency/quake watch).
 * @param {{geocode: Function}} [deps.placeSearch]
 * @param {AbortSignal} [deps.signal]
 * @param {(cleanup: Function) => void} deps.defer
 * @param {Document} [deps.document]
 */
export async function mountOperations({
  viewer,
  dataManager,
  placeSearch,
  signal,
  defer,
  document: doc = document,
}) {
  // `defer` only accepts cleanups while the tools constructor is still
  // running, and opening the journal store is asynchronous: register one
  // cleanup now and collect the rest locally.
  const cleanups = [];
  let disposed = false;
  const own = (cleanup) => {
    if (disposed) cleanup();
    else cleanups.push(cleanup);
  };
  defer(() => {
    disposed = true;
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        cleanup();
      } catch (error) {
        console.warn('[WAGUESS ops] cleanup', error);
      }
    }
  });

  const bus = createAlertBus({});
  const store = await openJournalStore();
  if (signal?.aborted || disposed) return null;
  const journal = createAlertJournal({ bus, store, label: 'WAGUESS' }); // i18n-ignore: product name
  journal.start();
  own(() => journal.stop());

  const trafficWatch = createTrafficWatch({
    bus,
    describe: (point) =>
      nearestPlaceName(point, { ...CITY_POIS, ...GAZETTEER_PRESETS }),
  });
  const overlay = createCrowdOverlay({ viewer, trafficWatch });
  own(() => overlay.destroy());

  if (dataManager) own(startLayerWatch({ dataManager, bus }));

  const flyTo = (lat, lon) =>
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, 4000),
      duration: 1.5,
    });

  const panel = createOperationsPanel({
    document: doc,
    bus,
    journal,
    overlay,
    placeSearch,
    flyTo,
    locate: browserLocate,
    download: browserDownload,
    copy: browserCopy,
    open: (url) => window.open(url, '_blank', 'noopener'),
    origin: window.location.origin,
  });
  doc.body.append(...panel.elements);
  own(() => panel.destroy());

  const handle = { bus, journal, overlay, panel };
  window.__waguessOps = handle;
  own(() => {
    if (window.__waguessOps === handle) delete window.__waguessOps;
  });
  return handle;
}
