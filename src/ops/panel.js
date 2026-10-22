// The Operations panel: road saturation, alert journal, synthesis report and
// "around me" search in one collapsible window. DOM only; everything it shows
// comes from panelModel.js and the services passed in.
import { t } from '../i18n/index.js';
import { findPlace } from './gazetteer.js';
import { LEVEL_COLORS } from './crowdOverlay.js';
import {
  alertRow,
  contributeUrl,
  exportName,
  overlayStatusText,
  roadRow,
  sessionRow,
  storageNote,
  verdictText,
} from './panelModel.js';
import {
  buildReport,
  renderCsv,
  renderHtml,
  renderMarkdown,
  whatsappText,
  whatsappUrl,
} from './report.js';
import { parseCoordinates, searchActiveRoads } from './roadSearch.js';

const TABS = ['traffic', 'alerts', 'report', 'nearby'];

function el(doc, tag, props = {}, ...children) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined && child !== false) {
      node.append(child);
    }
  }
  return node;
}

/**
 * @param {object} deps
 * @param {Document} deps.document
 * @param {ReturnType<import('./alertBus.js').createAlertBus>} deps.bus
 * @param {ReturnType<import('./alertJournal.js').createAlertJournal>} deps.journal
 * @param {ReturnType<import('./crowdOverlay.js').createCrowdOverlay>} deps.overlay
 * @param {{geocode: Function}} [deps.placeSearch]
 * @param {(lat:number, lon:number) => void} deps.flyTo
 * @param {() => Promise<{lat:number, lon:number}>} deps.locate
 * @param {(name:string, mime:string, text:string) => void} deps.download
 * @param {(text:string) => Promise<void>} deps.copy
 * @param {(url:string) => void} deps.open
 * @param {string} deps.origin
 * @param {typeof fetch} [deps.fetchImpl]
 */
export function createOperationsPanel({
  document: doc,
  bus,
  journal,
  overlay,
  placeSearch,
  flyTo,
  locate,
  download,
  copy,
  open,
  origin,
  fetchImpl,
}) {
  let activeTab = 'traffic';
  let unread = 0;
  let viewedSessionId = null;
  let nearbyAbort = null;
  const cleanups = [];

  // ---- shell ----------------------------------------------------------------
  const launcher = el(doc, 'button', {
    class: 'ops-launcher',
    type: 'button',
    'aria-expanded': 'false',
    'aria-controls': 'ops-panel',
    title: t('Operations: traffic, alerts, report'),
  });
  const launcherLabel = el(doc, 'span', { text: t('OPS') });
  const badge = el(doc, 'span', {
    class: 'ops-badge',
    hidden: true,
    'aria-hidden': 'true',
  });
  launcher.append(launcherLabel, badge);

  const panel = el(doc, 'section', {
    id: 'ops-panel',
    class: 'ops-panel',
    role: 'dialog',
    'aria-label': t('Operations'),
    hidden: true,
  });
  const tabBar = el(doc, 'div', { class: 'ops-tabs', role: 'tablist' });
  const bodies = {};
  const tabButtons = {};
  const tabNames = {
    traffic: t('Traffic'),
    alerts: t('Alerts'),
    report: t('Report'),
    nearby: t('Nearby'),
  };
  for (const id of TABS) {
    tabButtons[id] = el(doc, 'button', {
      class: 'ops-tab',
      type: 'button',
      role: 'tab',
      id: `ops-tab-${id}`,
      'aria-controls': `ops-body-${id}`,
      text: tabNames[id],
      onclick: () => selectTab(id),
    });
    bodies[id] = el(doc, 'div', {
      class: 'ops-body',
      role: 'tabpanel',
      id: `ops-body-${id}`,
      'aria-labelledby': `ops-tab-${id}`,
      hidden: true,
    });
    tabBar.append(tabButtons[id]);
  }
  const closeButton = el(doc, 'button', {
    class: 'ops-close',
    type: 'button',
    'aria-label': t('Close'),
    text: '×',
    onclick: () => setOpen(false),
  });
  panel.append(
    el(
      doc,
      'header',
      { class: 'ops-head' },
      el(doc, 'strong', { text: t('Operations') }),
      closeButton,
    ),
    tabBar,
    ...TABS.map((id) => bodies[id]),
  );

  function selectTab(id) {
    activeTab = id;
    for (const tab of TABS) {
      const on = tab === id;
      bodies[tab].hidden = !on;
      tabButtons[tab].setAttribute('aria-selected', String(on));
      tabButtons[tab].tabIndex = on ? 0 : -1;
    }
    if (id === 'alerts') {
      unread = 0;
      renderBadge();
      renderAlerts();
    }
    if (id === 'report') renderReportTab();
  }

  function setOpen(value) {
    panel.hidden = !value;
    launcher.setAttribute('aria-expanded', String(value));
    if (value) selectTab(activeTab);
  }
  launcher.addEventListener('click', () => setOpen(panel.hidden));
  const onKey = (event) => {
    if (event.key === 'Escape' && !panel.hidden) setOpen(false);
  };
  doc.addEventListener('keydown', onKey);
  cleanups.push(() => doc.removeEventListener('keydown', onKey));

  function renderBadge() {
    badge.hidden = unread === 0;
    badge.textContent = unread > 99 ? '99+' : String(unread);
  }

  // ---- traffic tab ----------------------------------------------------------
  const toggle = el(doc, 'input', {
    type: 'checkbox',
    id: 'ops-traffic-toggle',
  });
  toggle.addEventListener('change', () => overlay.setEnabled(toggle.checked));
  const trafficStatus = el(doc, 'p', {
    class: 'ops-status',
    'aria-live': 'polite',
  });
  const legend = el(
    doc,
    'ul',
    { class: 'ops-legend' },
    ...['free', 'slow', 'heavy', 'jam'].map((level) =>
      el(
        doc,
        'li',
        {},
        el(doc, 'i', { style: `background:${LEVEL_COLORS[level]}` }),
        {
          free: t('Flowing'),
          slow: t('Slow'),
          heavy: t('Heavy'),
          jam: t('Jammed'),
        }[level],
      ),
    ),
  );
  const link = contributeUrl(origin);
  bodies.traffic.append(
    el(
      doc,
      'label',
      { class: 'ops-row', for: 'ops-traffic-toggle' },
      toggle,
      el(doc, 'span', { text: t('Show road saturation') }),
    ),
    trafficStatus,
    legend,
    el(doc, 'h3', { text: t('Share your position') }),
    el(doc, 'p', {
      class: 'ops-hint',
      text: t(
        'Drivers and riders can contribute anonymously from their phone. Nothing is recorded: only averages per road section are shown.',
      ),
    }),
    el(doc, 'code', { class: 'ops-link', text: link }),
    el(
      doc,
      'div',
      { class: 'ops-actions' },
      el(doc, 'button', {
        type: 'button',
        text: t('Copy link'),
        onclick: () => copy(link),
      }),
      el(doc, 'button', {
        type: 'button',
        text: t('Open'),
        onclick: () => open(link),
      }),
      el(doc, 'button', {
        type: 'button',
        text: t('Send by WhatsApp'),
        onclick: () =>
          open(
            whatsappUrl(
              `${t('Help show traffic in real time: share your position anonymously.')} ${link}`,
            ),
          ),
      }),
    ),
  );
  const renderTraffic = (state) => {
    trafficStatus.textContent = overlayStatusText(state);
    toggle.checked = overlay.isEnabled();
  };
  cleanups.push(overlay.subscribe(renderTraffic));
  renderTraffic(overlay.getState());

  // ---- alerts tab -----------------------------------------------------------
  const storage = el(doc, 'p', { class: 'ops-hint' });
  const alertList = el(doc, 'ul', { class: 'ops-list', 'aria-live': 'polite' });
  const sessionList = el(doc, 'ul', { class: 'ops-list' });
  const noteInput = el(doc, 'input', {
    type: 'text',
    maxlength: '160',
    placeholder: t('Add a note to the journal'),
    'aria-label': t('Add a note to the journal'),
  });
  const addNote = () => {
    const text = noteInput.value.trim();
    if (!text) return;
    bus.publish({
      kind: 'note',
      severity: 'info',
      title: text,
      source: 'operator',
    });
    noteInput.value = '';
  };
  noteInput.addEventListener('keydown', (e) => e.key === 'Enter' && addNote());
  bodies.alerts.append(
    storage,
    el(
      doc,
      'div',
      { class: 'ops-row' },
      noteInput,
      el(doc, 'button', { type: 'button', text: t('Add'), onclick: addNote }),
    ),
    el(doc, 'h3', { text: t('This session') }),
    alertList,
    el(doc, 'h3', { text: t('Saved sessions') }),
    sessionList,
  );

  async function currentAlerts() {
    const id = viewedSessionId || journal.current()?.id;
    return id
      ? { id, alerts: await journal.getAlerts(id) }
      : { id: null, alerts: [] };
  }

  async function renderAlerts() {
    storage.textContent = storageNote(journal.status());
    const { alerts } = await currentAlerts();
    alertList.replaceChildren();
    if (!alerts.length) {
      alertList.append(
        el(doc, 'li', { class: 'ops-empty', text: t('No alert yet.') }),
      );
    }
    for (const alert of [...alerts].reverse().slice(0, 100)) {
      const row = alertRow(alert);
      alertList.append(
        el(
          doc,
          'li',
          { class: `ops-alert sev-${row.severity}` },
          el(doc, 'span', { class: 'ops-time', text: row.time }),
          el(doc, 'strong', { text: row.title }),
          row.detail ? el(doc, 'small', { text: row.detail }) : null,
          row.hasPosition
            ? el(doc, 'button', {
                type: 'button',
                class: 'ops-go',
                text: t('Show'),
                onclick: () => flyTo(row.lat, row.lon),
              })
            : null,
        ),
      );
    }
    const sessions = await journal.listSessions();
    sessionList.replaceChildren();
    for (const session of sessions) {
      const row = sessionRow(session);
      sessionList.append(
        el(
          doc,
          'li',
          { class: 'ops-session' },
          el(doc, 'strong', { text: row.title }),
          el(doc, 'small', { text: row.subtitle }),
          el(
            doc,
            'span',
            { class: 'ops-actions' },
            el(doc, 'button', {
              type: 'button',
              text: t('View'),
              onclick: () => {
                viewedSessionId = row.open ? null : row.id;
                renderAlerts();
              },
            }),
            el(doc, 'button', {
              type: 'button',
              text: t('CSV'),
              onclick: async () =>
                download(
                  exportName('journal', 'csv'),
                  'text/csv;charset=utf-8',
                  renderCsv(await journal.getAlerts(row.id)),
                ),
            }),
            row.open
              ? null
              : el(doc, 'button', {
                  type: 'button',
                  text: t('Delete'),
                  onclick: async () => {
                    if (
                      !doc.defaultView?.confirm(t('Delete this saved session?'))
                    )
                      return;
                    await journal.deleteSession(row.id);
                    if (viewedSessionId === row.id) viewedSessionId = null;
                    renderAlerts();
                  },
                }),
          ),
        ),
      );
    }
  }
  cleanups.push(
    bus.subscribe((alert) => {
      if (activeTab !== 'alerts' || panel.hidden) {
        unread += 1;
        renderBadge();
      }
      journal.flush().then(() => {
        if (activeTab === 'alerts' && !panel.hidden) renderAlerts();
      });
      if (alert.severity === 'critical') launcher.classList.add('ops-pulse');
    }),
  );
  launcher.addEventListener('click', () =>
    launcher.classList.remove('ops-pulse'),
  );

  // ---- report tab -----------------------------------------------------------
  const preview = el(doc, 'pre', {
    class: 'ops-preview',
    tabindex: '0',
    'aria-label': t('Report preview'),
  });
  const reportNote = el(doc, 'p', { class: 'ops-hint' });
  async function makeReport() {
    const { id, alerts } = await currentAlerts();
    const sessions = await journal.listSessions();
    const session = sessions.find((s) => s.id === id) || null;
    return buildReport(alerts, {
      session,
      crowd: overlay.getState().counts
        ? { counts: overlay.getState().counts }
        : null,
    });
  }
  async function renderReportTab() {
    const report = await makeReport();
    preview.textContent = renderMarkdown(report);
    reportNote.textContent = storageNote(journal.status());
  }
  const lang = () => doc.documentElement.lang || 'en';
  bodies.report.append(
    reportNote,
    preview,
    el(
      doc,
      'div',
      { class: 'ops-actions' },
      el(doc, 'button', {
        type: 'button',
        text: t('Refresh'),
        onclick: renderReportTab,
      }),
      el(doc, 'button', {
        type: 'button',
        text: t('HTML'),
        onclick: async () =>
          download(
            exportName('report', 'html'),
            'text/html;charset=utf-8',
            renderHtml(await makeReport(), { lang: lang() }),
          ),
      }),
      el(doc, 'button', {
        type: 'button',
        text: t('Markdown'),
        onclick: async () =>
          download(
            exportName('report', 'md'),
            'text/markdown;charset=utf-8',
            renderMarkdown(await makeReport()),
          ),
      }),
      el(doc, 'button', {
        type: 'button',
        text: t('CSV'),
        onclick: async () => {
          const { alerts } = await currentAlerts();
          download(
            exportName('journal', 'csv'),
            'text/csv;charset=utf-8',
            renderCsv(alerts),
          );
        },
      }),
      el(doc, 'button', {
        type: 'button',
        text: t('Copy summary'),
        onclick: async () => copy(whatsappText(await makeReport())),
      }),
      el(doc, 'button', {
        type: 'button',
        text: t('WhatsApp'),
        onclick: async () =>
          open(whatsappUrl(whatsappText(await makeReport()))),
      }),
    ),
  );

  // ---- nearby tab -----------------------------------------------------------
  const where = el(doc, 'input', {
    type: 'text',
    placeholder: t('Place or latitude, longitude'),
    'aria-label': t('Place or latitude, longitude'),
  });
  const radius = el(
    doc,
    'select',
    { 'aria-label': t('Search radius') },
    ...[1000, 3000, 10000].map((m) =>
      el(doc, 'option', {
        value: String(m),
        selected: m === 3000,
        text: t('{km} km', { km: String(m / 1000) }),
      }),
    ),
  );
  const nearbyStatus = el(doc, 'p', {
    class: 'ops-status',
    'aria-live': 'polite',
  });
  const nearbyList = el(doc, 'ul', { class: 'ops-list' });

  async function runNearby(origin) {
    nearbyAbort?.abort();
    nearbyAbort = new AbortController();
    nearbyStatus.textContent = t('Searching…');
    nearbyList.replaceChildren();
    try {
      const { rows, verdict } = await searchActiveRoads(origin, {
        radiusM: Number(radius.value),
        signal: nearbyAbort.signal,
        fetchImpl,
      });
      nearbyStatus.textContent = verdictText(verdict);
      for (const raw of rows.slice(0, 30)) {
        const row = roadRow(raw);
        nearbyList.append(
          el(
            doc,
            'li',
            { class: `ops-road lvl-${row.level}` },
            el(doc, 'i', { style: `background:${LEVEL_COLORS[row.level]}` }),
            el(doc, 'strong', { text: row.title }),
            el(doc, 'small', { text: row.detail }),
            el(doc, 'button', {
              type: 'button',
              class: 'ops-go',
              text: t('Show'),
              onclick: () => flyTo(row.lat, row.lon),
            }),
          ),
        );
      }
      flyTo(origin.lat, origin.lon);
    } catch (error) {
      if (error?.name === 'AbortError') return;
      nearbyStatus.textContent =
        error?.status === 404
          ? t('Crowd traffic is not available on this server.')
          : t('Search failed. Try again.');
    }
  }
  async function searchTyped() {
    const text = where.value.trim();
    if (!text) return;
    const coords = parseCoordinates(text);
    if (coords) return runNearby(coords);
    const local = findPlace(text);
    if (local) return runNearby({ lat: local.lat, lon: local.lon });
    nearbyStatus.textContent = t('Searching…');
    try {
      const { place } = (await placeSearch?.geocode(text)) ?? {};
      if (!place) {
        nearbyStatus.textContent = t('Place not found.');
        return;
      }
      await runNearby({ lat: place.lat, lon: place.lng });
    } catch {
      nearbyStatus.textContent = t('Search failed. Try again.');
    }
  }
  where.addEventListener('keydown', (e) => e.key === 'Enter' && searchTyped());
  bodies.nearby.append(
    el(doc, 'p', {
      class: 'ops-hint',
      text: t(
        'Find the roads with vehicles sharing their position around you or around a place.',
      ),
    }),
    el(
      doc,
      'div',
      { class: 'ops-actions' },
      el(doc, 'button', {
        type: 'button',
        text: t('Around me'),
        onclick: async () => {
          nearbyStatus.textContent = t('Locating…');
          try {
            await runNearby(await locate());
          } catch {
            nearbyStatus.textContent = t(
              'Location unavailable. Allow it in the browser or type a place.',
            );
          }
        },
      }),
    ),
    el(
      doc,
      'div',
      { class: 'ops-row' },
      where,
      radius,
      el(doc, 'button', {
        type: 'button',
        text: t('Search'),
        onclick: searchTyped,
      }),
    ),
    nearbyStatus,
    nearbyList,
  );

  selectTab('traffic');
  renderAlerts();

  return {
    elements: [launcher, panel],
    open: () => setOpen(true),
    close: () => setOpen(false),
    destroy() {
      nearbyAbort?.abort();
      for (const cleanup of cleanups.splice(0)) cleanup();
      launcher.remove();
      panel.remove();
    },
  };
}
