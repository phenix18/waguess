// Alert journal: every alert is saved the moment it is published, inside a
// session that belongs to this device. Reopening the tool later lists the past
// sessions; nothing is lost if the tab is closed or the machine restarts.

/**
 * @param {object} config
 * @param {ReturnType<import('./alertBus.js').createAlertBus>} config.bus
 * @param {ReturnType<import('./journalStorage.js').createMemoryJournalStore>} config.store
 * @param {() => number} [config.now]
 * @param {string} [config.label] - Optional operator label for the session.
 */
export function createAlertJournal({ bus, store, now = Date.now, label = '' }) {
  let session = null;
  let unsubscribe = null;
  let queue = Promise.resolve();
  const status = { saved: 0, failed: 0, lastError: null };
  const listeners = new Set();

  const emit = () => {
    for (const listener of [...listeners]) {
      try {
        listener(snapshot());
      } catch {
        /* a failing view must not stop the journal */
      }
    }
  };

  const snapshot = () => ({
    session: session ? { ...session } : null,
    persistent: store.persistent === true,
    ...status,
  });

  function enqueue(task) {
    queue = queue.then(task).catch((error) => {
      status.failed += 1;
      status.lastError = String(error?.message || error);
    });
    return queue;
  }

  /** Begin a new session and start saving published alerts. */
  function start() {
    if (session) return { ...session };
    const startedAt = now();
    session = {
      id: `s${startedAt.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      startedAt,
      endedAt: null,
      lastAlertAt: null,
      count: 0,
      label: String(label || '').slice(0, 80),
    };
    const created = { ...session };
    enqueue(() => store.putSession(created));
    unsubscribe = bus.subscribe((alert) => {
      if (!session) return;
      session.count += 1;
      session.lastAlertAt = alert.at;
      const copy = { ...session };
      enqueue(async () => {
        await store.appendAlert(copy.id, alert);
        await store.putSession(copy);
        status.saved += 1;
      }).then(emit);
    });
    emit();
    return { ...session };
  }

  /** Close the session (the data stays). */
  async function stop() {
    if (!session) return null;
    unsubscribe?.();
    unsubscribe = null;
    session.endedAt = now();
    const closed = { ...session };
    session = null;
    await enqueue(() => store.putSession(closed));
    emit();
    return closed;
  }

  return {
    start,
    stop,
    flush: () => queue,
    current: () => (session ? { ...session } : null),
    status: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    listSessions: () => store.listSessions(),
    getAlerts: (id) => store.getAlerts(id),
    async deleteSession(id) {
      if (session && session.id === id) return false;
      await store.deleteSession(id);
      return true;
    },
  };
}
