// Storage adapters for the alert journal.
//   - memory: always available, lost on reload (the fallback).
//   - IndexedDB: survives reloads, scoped to this browser profile (this PC or
//     this device). Nothing is ever sent to a server.
const DB_NAME = 'waguess-ops';
const DB_VERSION = 1;

/** In-memory adapter (also the test double). */
export function createMemoryJournalStore() {
  const sessions = new Map();
  const alerts = new Map();
  return {
    persistent: false,
    async putSession(session) {
      sessions.set(session.id, { ...session });
    },
    async getSession(id) {
      const s = sessions.get(id);
      return s ? { ...s } : null;
    },
    async listSessions() {
      return [...sessions.values()]
        .map((s) => ({ ...s }))
        .sort((a, b) => b.startedAt - a.startedAt);
    },
    async appendAlert(sessionId, alert) {
      if (!alerts.has(sessionId)) alerts.set(sessionId, []);
      alerts.get(sessionId).push({ ...alert });
    },
    async getAlerts(sessionId) {
      return (alerts.get(sessionId) || []).map((a) => ({ ...a }));
    },
    async deleteSession(id) {
      sessions.delete(id);
      alerts.delete(id);
    },
  };
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB error'));
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB error'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB aborted'));
  });
}

/** Open the IndexedDB adapter; rejects when IndexedDB is unusable. */
export async function openIndexedDbJournalStore(
  factory = globalThis.indexedDB,
) {
  if (!factory) throw new Error('IndexedDB unavailable');
  const open = factory.open(DB_NAME, DB_VERSION);
  open.onupgradeneeded = () => {
    const db = open.result;
    db.createObjectStore('sessions', { keyPath: 'id' });
    const alerts = db.createObjectStore('alerts', {
      keyPath: 'seq',
      autoIncrement: true,
    });
    alerts.createIndex('session', 'sessionId');
  };
  const db = await request(open);
  return {
    persistent: true,
    async putSession(session) {
      const tx = db.transaction('sessions', 'readwrite');
      tx.objectStore('sessions').put({ ...session });
      await done(tx);
    },
    async getSession(id) {
      const tx = db.transaction('sessions', 'readonly');
      return (await request(tx.objectStore('sessions').get(id))) || null;
    },
    async listSessions() {
      const tx = db.transaction('sessions', 'readonly');
      const rows = await request(tx.objectStore('sessions').getAll());
      return rows.sort((a, b) => b.startedAt - a.startedAt);
    },
    async appendAlert(sessionId, alert) {
      const tx = db.transaction('alerts', 'readwrite');
      tx.objectStore('alerts').add({ ...alert, sessionId });
      await done(tx);
    },
    async getAlerts(sessionId) {
      const tx = db.transaction('alerts', 'readonly');
      const rows = await request(
        tx.objectStore('alerts').index('session').getAll(sessionId),
      );
      return rows
        .sort((a, b) => a.seq - b.seq)
        .map(({ seq: _seq, sessionId: _id, ...alert }) => alert);
    },
    async deleteSession(id) {
      const tx = db.transaction(['sessions', 'alerts'], 'readwrite');
      tx.objectStore('sessions').delete(id);
      const index = tx.objectStore('alerts').index('session');
      const keys = await request(index.getAllKeys(id));
      for (const key of keys) tx.objectStore('alerts').delete(key);
      await done(tx);
    },
    close() {
      db.close();
    },
  };
}

/** IndexedDB when usable, otherwise memory (the panel says which one it got). */
export async function openJournalStore(factory) {
  try {
    return await openIndexedDbJournalStore(factory);
  } catch {
    return createMemoryJournalStore();
  }
}
