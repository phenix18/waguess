// WAGUESS — crowd-sourced road saturation (no paid API).
//
// Vehicles and motorcycles whose driver has *chosen* to share their position
// (contribute page, opt-in, one-click stop) send anonymous samples. This module
// turns them into per-road-cell congestion levels. It is pure: the clock and
// the random salt are injected, nothing here touches the network or the disk.
//
// Privacy by construction
//   - A contributor is a random session token. The server only keeps a salted
//     hash of it, and only until its samples expire (default 10 minutes).
//   - Nothing is exposed below the cell level (about 200 m) and only when at
//     least `minContributors` distinct sessions agree: no individual track is
//     ever readable through `segments()`.
//   - Raw samples are never persisted. The learned free-flow speed per cell is
//     kept as aggregated speeds only (no identifiers, no timestamps).
import { createHash, randomBytes } from 'node:crypto';

export const CROWD_DEFAULTS = Object.freeze({
  /** Cell height in degrees (about 200 m). Cell width follows the latitude. */
  cellDeg: 0.0018,
  /** Travel directions are bucketed into 8 sectors of 45 degrees. */
  headingSectors: 8,
  /** A sample is forgotten this long after it was received. */
  ttlMs: 10 * 60_000,
  /** Only samples younger than this describe the *current* state of a road. */
  windowMs: 5 * 60_000,
  /** Distinct contributors required before a cell is published. */
  minContributors: 3,
  /** Hard cap on retained samples; the oldest are dropped first. */
  maxSamples: 60_000,
  /** Hard cap on retained samples per contributor. */
  maxSamplesPerSession: 600,
  /** Minimum gap between two accepted batches of the same contributor. */
  minBatchIntervalMs: 1_000,
  /** Samples per batch. */
  maxBatch: 20,
  /** Speeds above this are treated as sensor noise. */
  maxSpeedKmh: 220,
  /** Positions worse than this are ignored (metres). */
  maxAccuracyM: 100,
  /** Free-flow speed when nothing was learned yet. */
  defaultFreeFlowKmh: 45,
  /** Learned free-flow speed is never below this. */
  freeFlowFloorKmh: 25,
  /** Learned free-flow speed is never above this. */
  freeFlowCeilKmh: 130,
  /** Moving samples needed in a cell before its own free-flow is trusted. */
  learnMinSamples: 30,
  /** Reservoir size of learned speeds per cell. */
  learnReservoir: 64,
  /** Learned cells kept (least recently used dropped). */
  maxLearnedCells: 20_000,
  /** Motorcycles filter between lanes: their speed is discounted. */
  motoDiscount: 0.8,
  /** Largest bounding box (degrees) a single read may ask for. */
  maxBboxDeg: 5,
});

/** Congestion levels, worst last. `ratio` is median speed / free-flow speed. */
export const CONGESTION_LEVELS = Object.freeze([
  Object.freeze({ id: 'free', minRatio: 0.75 }),
  Object.freeze({ id: 'slow', minRatio: 0.45 }),
  Object.freeze({ id: 'heavy', minRatio: 0.2 }),
  Object.freeze({ id: 'jam', minRatio: 0 }),
]);

const METERS_PER_DEG_LAT = 111_320;
const MOVING_KMH = 10;
const NO_SECTOR = -1;

/** Level id for a speed ratio (median / free-flow). */
export function levelForRatio(ratio) {
  for (const level of CONGESTION_LEVELS) {
    if (ratio >= level.minRatio) return level.id;
  }
  return 'jam';
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[index];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Validate and normalise one inbound sample. Returns null when it is unusable.
 * Client timestamps are ignored on purpose: the server clock is the only one
 * that counts, so a phone with a wrong clock cannot pin or poison a cell.
 */
export function normalizeSample(raw, options = CROWD_DEFAULTS) {
  if (!raw || typeof raw !== 'object') return null;
  const lat = Number(raw.lat);
  const lon = Number(raw.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -85 || lat > 85 || lon < -180 || lon > 180) return null;
  const speedKmh = Number(raw.speedKmh);
  if (!Number.isFinite(speedKmh) || speedKmh < 0) return null;
  if (speedKmh > options.maxSpeedKmh) return null;
  if (raw.accuracyM !== undefined && raw.accuracyM !== null) {
    const accuracy = Number(raw.accuracyM);
    if (!Number.isFinite(accuracy) || accuracy < 0) return null;
    if (accuracy > options.maxAccuracyM) return null;
  }
  const mode = raw.mode === 'moto' ? 'moto' : 'car';
  let heading = null;
  if (raw.heading !== undefined && raw.heading !== null) {
    const h = Number(raw.heading);
    if (Number.isFinite(h)) heading = ((h % 360) + 360) % 360;
  }
  return { lat, lon, speedKmh, heading, mode };
}

/** Token shape accepted as a contributor session id. */
export function isValidSessionId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(value);
}

/**
 * Create the in-memory store.
 * @param {object} [config]
 * @param {() => number} [config.now] - Clock (ms).
 * @param {Buffer|string} [config.salt] - Session hashing salt.
 * @param {Partial<typeof CROWD_DEFAULTS>} [config.options]
 */
export function createCrowdTrafficStore({
  now = Date.now,
  salt = randomBytes(16),
  options: overrides = {},
} = {}) {
  const options = Object.freeze({ ...CROWD_DEFAULTS, ...overrides });
  /** cellKey -> [{ t, speedKmh, mode, session, sector }] */
  const cells = new Map();
  /** session hash -> { count, lastBatchAt } */
  const sessions = new Map();
  /** cellKey+sector -> { n, speeds: number[], touched } (aggregates only) */
  const learned = new Map();
  let total = 0;
  let lastPrune = 0;

  const hashSession = (id) =>
    createHash('sha256').update(salt).update(id).digest('hex').slice(0, 20);

  function cellOf(lat, lon) {
    const row = Math.floor(lat / options.cellDeg);
    const rowLat = (row + 0.5) * options.cellDeg;
    const lonStep =
      options.cellDeg / Math.max(Math.cos((rowLat * Math.PI) / 180), 0.05);
    const col = Math.floor(lon / lonStep);
    return { row, col, lonStep, rowLat };
  }

  function sectorOf(heading, speedKmh) {
    // A stopped vehicle has no meaningful heading.
    if (heading === null || speedKmh < 3) return NO_SECTOR;
    const width = 360 / options.headingSectors;
    return Math.floor(((heading + width / 2) % 360) / width);
  }

  function learn(key, speedKmh) {
    if (speedKmh < MOVING_KMH) return;
    let entry = learned.get(key);
    if (!entry) {
      entry = { n: 0, speeds: [], touched: 0 };
      learned.set(key, entry);
    }
    entry.n += 1;
    entry.touched = now();
    if (entry.speeds.length < options.learnReservoir) {
      entry.speeds.push(speedKmh);
    } else {
      const slot = Math.floor(Math.random() * entry.n);
      if (slot < options.learnReservoir) entry.speeds[slot] = speedKmh;
    }
    if (learned.size > options.maxLearnedCells) {
      let oldestKey = null;
      let oldest = Infinity;
      for (const [k, v] of learned) {
        if (v.touched < oldest) {
          oldest = v.touched;
          oldestKey = k;
        }
      }
      if (oldestKey !== null) learned.delete(oldestKey);
    }
  }

  function freeFlowFor(key) {
    const entry = learned.get(key);
    if (entry && entry.n >= options.learnMinSamples) {
      return clamp(
        percentile(entry.speeds, 0.85),
        options.freeFlowFloorKmh,
        options.freeFlowCeilKmh,
      );
    }
    return options.defaultFreeFlowKmh;
  }

  function dropSamples(predicate) {
    for (const [key, list] of cells) {
      const kept = list.filter((s) => !predicate(s));
      total -= list.length - kept.length;
      for (const s of list) {
        if (predicate(s)) {
          const session = sessions.get(s.session);
          if (session) {
            session.count -= 1;
            if (session.count <= 0 && now() - session.lastBatchAt > 60_000) {
              sessions.delete(s.session);
            }
          }
        }
      }
      if (kept.length) cells.set(key, kept);
      else cells.delete(key);
    }
  }

  function prune() {
    const t = now();
    lastPrune = t;
    dropSamples((s) => t - s.t > options.ttlMs);
    if (total > options.maxSamples) {
      const all = [];
      for (const list of cells.values()) all.push(...list);
      all.sort((a, b) => a.t - b.t);
      const cut = new Set(all.slice(0, total - options.maxSamples));
      dropSamples((s) => cut.has(s));
    }
    for (const [id, session] of sessions) {
      if (session.count <= 0 && t - session.lastBatchAt > options.ttlMs) {
        sessions.delete(id);
      }
    }
  }

  /**
   * Ingest one batch from a contributor.
   * @returns {{ ok: boolean, accepted: number, rejected: number, reason?: string }}
   */
  function addReport(sessionId, rawSamples) {
    if (!isValidSessionId(sessionId)) {
      return { ok: false, accepted: 0, rejected: 0, reason: 'session' };
    }
    if (!Array.isArray(rawSamples) || rawSamples.length === 0) {
      return { ok: false, accepted: 0, rejected: 0, reason: 'samples' };
    }
    if (rawSamples.length > options.maxBatch) {
      return {
        ok: false,
        accepted: 0,
        rejected: rawSamples.length,
        reason: 'batch-too-large',
      };
    }
    const t = now();
    if (t - lastPrune > 15_000) prune();
    const key = hashSession(sessionId);
    let session = sessions.get(key);
    if (!session) {
      session = { count: 0, lastBatchAt: 0 };
      sessions.set(key, session);
    }
    if (t - session.lastBatchAt < options.minBatchIntervalMs) {
      return {
        ok: false,
        accepted: 0,
        rejected: rawSamples.length,
        reason: 'too-frequent',
      };
    }
    session.lastBatchAt = t;
    let accepted = 0;
    let rejected = 0;
    for (const raw of rawSamples) {
      const sample = normalizeSample(raw, options);
      if (!sample || session.count >= options.maxSamplesPerSession) {
        rejected += 1;
        continue;
      }
      const cell = cellOf(sample.lat, sample.lon);
      const sector = sectorOf(sample.heading, sample.speedKmh);
      const cellKey = `${cell.row}:${cell.col}`;
      let list = cells.get(cellKey);
      if (!list) {
        list = [];
        cells.set(cellKey, list);
      }
      list.push({
        t,
        speedKmh: sample.speedKmh,
        mode: sample.mode,
        session: key,
        sector,
      });
      if (sector !== NO_SECTOR) learn(`${cellKey}:${sector}`, sample.speedKmh);
      session.count += 1;
      total += 1;
      accepted += 1;
    }
    return { ok: true, accepted, rejected };
  }

  /** Remove everything a contributor sent (the "stop and forget" button). */
  function forget(sessionId) {
    if (!isValidSessionId(sessionId)) return { ok: false, removed: 0 };
    const key = hashSession(sessionId);
    const before = total;
    dropSamples((s) => s.session === key);
    sessions.delete(key);
    return { ok: true, removed: before - total };
  }

  function segmentGeometry(cell, sector) {
    const half = (options.cellDeg * METERS_PER_DEG_LAT * 0.45) / 1;
    const lat = cell.rowLat;
    const lon = (cell.col + 0.5) * cell.lonStep;
    if (sector === NO_SECTOR) return { type: 'Point', coordinates: [lon, lat] };
    const heading = (sector * 360) / options.headingSectors;
    const rad = (heading * Math.PI) / 180;
    const dLat = (Math.cos(rad) * half) / METERS_PER_DEG_LAT;
    const dLon =
      (Math.sin(rad) * half) /
      (METERS_PER_DEG_LAT * Math.max(Math.cos((lat * Math.PI) / 180), 0.05));
    return {
      type: 'LineString',
      coordinates: [
        [lon - dLon, lat - dLat],
        [lon + dLon, lat + dLat],
      ],
    };
  }

  /**
   * Published congestion cells inside a bounding box.
   * @param {{west:number,south:number,east:number,north:number}} bbox
   */
  function segments(bbox) {
    const t = now();
    if (t - lastPrune > 15_000) prune();
    const features = [];
    const counts = { free: 0, slow: 0, heavy: 0, jam: 0 };
    const rowMin = Math.floor(bbox.south / options.cellDeg);
    const rowMax = Math.floor(bbox.north / options.cellDeg);
    for (const [cellKey, list] of cells) {
      const [row, col] = cellKey.split(':').map(Number);
      if (row < rowMin || row > rowMax) continue;
      const rowLat = (row + 0.5) * options.cellDeg;
      const lonStep =
        options.cellDeg / Math.max(Math.cos((rowLat * Math.PI) / 180), 0.05);
      const cell = { row, col, rowLat, lonStep };
      const lon = (col + 0.5) * lonStep;
      if (lon < bbox.west || lon > bbox.east) continue;

      // Latest sample per contributor, inside the "current state" window.
      const latest = new Map();
      for (const s of list) {
        if (t - s.t > options.windowMs) continue;
        const prev = latest.get(s.session);
        if (!prev || s.t > prev.t) latest.set(s.session, s);
      }
      if (latest.size < options.minContributors) continue;

      // Group by travel direction; stopped vehicles join the dominant one.
      const bySector = new Map();
      const unknown = [];
      for (const s of latest.values()) {
        if (s.sector === NO_SECTOR) unknown.push(s);
        else {
          if (!bySector.has(s.sector)) bySector.set(s.sector, []);
          bySector.get(s.sector).push(s);
        }
      }
      if (bySector.size) {
        let dominant = null;
        for (const [sector, group] of bySector) {
          if (!dominant || group.length > bySector.get(dominant).length) {
            dominant = sector;
          }
        }
        bySector.get(dominant).push(...unknown);
      } else if (unknown.length) {
        bySector.set(NO_SECTOR, unknown);
      }

      for (const [sector, group] of bySector) {
        if (group.length < options.minContributors) continue;
        const speeds = group.map((s) =>
          s.mode === 'moto' ? s.speedKmh * options.motoDiscount : s.speedKmh,
        );
        const medianSpeed = median(speeds);
        const freeFlow = freeFlowFor(`${cellKey}:${sector}`);
        const ratio = clamp(medianSpeed / freeFlow, 0, 1.5);
        const level = levelForRatio(ratio);
        counts[level] += 1;
        const newest = Math.max(...group.map((s) => s.t));
        features.push({
          type: 'Feature',
          geometry: segmentGeometry(cell, sector),
          properties: {
            level,
            ratio: Math.round(ratio * 100) / 100,
            speedKmh: Math.round(medianSpeed),
            freeFlowKmh: Math.round(freeFlow),
            contributors: group.length,
            heading:
              sector === NO_SECTOR
                ? null
                : (sector * 360) / options.headingSectors,
            ageS: Math.max(0, Math.round((t - newest) / 1000)),
            confidence:
              Math.round(
                clamp(group.length / (options.minContributors * 3), 0, 1) * 100,
              ) / 100,
            cars: group.filter((s) => s.mode === 'car').length,
            motos: group.filter((s) => s.mode === 'moto').length,
          },
        });
      }
    }
    return {
      type: 'FeatureCollection',
      features,
      meta: {
        generatedAt: new Date(t).toISOString(),
        minContributors: options.minContributors,
        windowS: Math.round(options.windowMs / 1000),
        counts,
      },
    };
  }

  /** Aggregate counters for health checks; carries nothing identifying. */
  function status() {
    if (now() - lastPrune > 15_000) prune();
    return {
      samples: total,
      cells: cells.size,
      contributors: sessions.size,
      learnedCells: learned.size,
      minContributors: options.minContributors,
      ttlS: Math.round(options.ttlMs / 1000),
    };
  }

  return { addReport, forget, segments, status, prune, options };
}

/**
 * Parse `west,south,east,north`. Returns null when invalid or too wide, so one
 * request cannot ask for the whole planet.
 */
export function parseBbox(value, maxDeg = CROWD_DEFAULTS.maxBboxDeg) {
  if (typeof value !== 'string') return null;
  const parts = value.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [west, south, east, north] = parts;
  if (west >= east || south >= north) return null;
  if (south < -85 || north > 85 || west < -180 || east > 180) return null;
  if (east - west > maxDeg || north - south > maxDeg) return null;
  return { west, south, east, north };
}
