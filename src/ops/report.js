// Synthesis report: turns a session's alerts (and, optionally, the current
// road-saturation picture) into something an operator can read in a minute,
// print, or send. Pure apart from the translation and number formatting.
import { formatDate, formatNumber, t, tn } from '../i18n/index.js';
import { ALERT_KINDS, SEVERITIES } from './alertBus.js';

const HOTSPOT_CELL_DEG = 0.05;
const MAX_HIGHLIGHTS = 10;
const MAX_HOTSPOTS = 5;
const WHATSAPP_MAX = 1400;

const severityRank = (s) => SEVERITIES.indexOf(s);

function severityLabel(severity) {
  if (severity === 'critical') return t('Critical');
  if (severity === 'warning') return t('Warning');
  return t('Info');
}

function kindLabel(kind) {
  return t(ALERT_KINDS[kind] ?? ALERT_KINDS.system);
}

function stamp(ms) {
  return formatDate(ms, { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * Build the structured report.
 * @param {Array<object>} alerts - Journal alerts of one session.
 * @param {object} [options]
 * @param {object} [options.session]
 * @param {number} [options.generatedAt]
 * @param {{counts?: Record<string, number>, generatedAt?: string}} [options.crowd]
 */
export function buildReport(
  alerts,
  { session = null, generatedAt = Date.now(), crowd = null } = {},
) {
  const list = [...alerts].sort((a, b) => a.at - b.at);
  const from = session?.startedAt ?? list[0]?.at ?? generatedAt;
  const to = session?.endedAt ?? list.at(-1)?.at ?? generatedAt;

  const bySeverity = { info: 0, warning: 0, critical: 0 };
  const byKind = {};
  for (const alert of list) {
    bySeverity[alert.severity] = (bySeverity[alert.severity] ?? 0) + 1;
    byKind[alert.kind] = (byKind[alert.kind] ?? 0) + 1;
  }

  const hourly = new Map();
  for (const alert of list) {
    const hour = Math.floor(alert.at / 3_600_000) * 3_600_000;
    const bucket = hourly.get(hour) ?? { at: hour, count: 0, worst: 'info' };
    bucket.count += 1;
    if (severityRank(alert.severity) > severityRank(bucket.worst)) {
      bucket.worst = alert.severity;
    }
    hourly.set(hour, bucket);
  }

  const cells = new Map();
  for (const alert of list) {
    if (alert.lat === null || alert.lon === null) continue;
    if (alert.lat === undefined || alert.lon === undefined) continue;
    const key = `${Math.floor(alert.lat / HOTSPOT_CELL_DEG)}:${Math.floor(alert.lon / HOTSPOT_CELL_DEG)}`;
    const cell = cells.get(key) ?? {
      count: 0,
      latSum: 0,
      lonSum: 0,
      worst: 'info',
    };
    cell.count += 1;
    cell.latSum += alert.lat;
    cell.lonSum += alert.lon;
    if (severityRank(alert.severity) > severityRank(cell.worst)) {
      cell.worst = alert.severity;
    }
    cells.set(key, cell);
  }
  const hotspots = [...cells.values()]
    .sort(
      (a, b) =>
        b.count - a.count || severityRank(b.worst) - severityRank(a.worst),
    )
    .slice(0, MAX_HOTSPOTS)
    .map((c) => ({
      lat: Math.round((c.latSum / c.count) * 1e4) / 1e4,
      lon: Math.round((c.lonSum / c.count) * 1e4) / 1e4,
      count: c.count,
      worst: c.worst,
    }));

  const highlights = [...list]
    .filter((a) => a.severity !== 'info')
    .sort(
      (a, b) =>
        severityRank(b.severity) - severityRank(a.severity) || b.at - a.at,
    )
    .slice(0, MAX_HIGHLIGHTS);

  return {
    generatedAt,
    period: { from, to },
    sessionLabel: session?.label || '',
    total: list.length,
    bySeverity,
    byKind,
    timeline: [...hourly.values()].sort((a, b) => a.at - b.at),
    hotspots,
    highlights,
    crowd: crowd?.counts
      ? { counts: { free: 0, slow: 0, heavy: 0, jam: 0, ...crowd.counts } }
      : null,
  };
}

function crowdLine(counts) {
  return t('Roads: {jam} jammed, {heavy} heavy, {slow} slow, {free} flowing', {
    jam: formatNumber(counts.jam),
    heavy: formatNumber(counts.heavy),
    slow: formatNumber(counts.slow),
    free: formatNumber(counts.free),
  });
}

function headline(report) {
  if (report.total === 0) return t('No alert in this period.');
  return tn(
    report.total,
    '{count} alert: {critical} critical, {warning} warning',
    '{count} alerts: {critical} critical, {warning} warning',
    {
      count: formatNumber(report.total),
      critical: formatNumber(report.bySeverity.critical),
      warning: formatNumber(report.bySeverity.warning),
    },
  );
}

function coords(alert) {
  return alert.lat === null || alert.lat === undefined
    ? ''
    : `${alert.lat.toFixed(4)}, ${alert.lon.toFixed(4)}`;
}

/** Markdown rendering. */
export function renderMarkdown(report) {
  const lines = [];
  lines.push(`# ${t('WAGUESS synthesis report')}`);
  lines.push('');
  lines.push(
    t('Period: {from} → {to}', {
      from: stamp(report.period.from),
      to: stamp(report.period.to),
    }),
  );
  if (report.sessionLabel)
    lines.push(`${t('Session')}: ${report.sessionLabel}`);
  lines.push(`${t('Generated')}: ${stamp(report.generatedAt)}`);
  lines.push('');
  lines.push(`**${headline(report)}**`);
  if (report.crowd) lines.push('', crowdLine(report.crowd.counts));
  const kinds = Object.entries(report.byKind).sort((a, b) => b[1] - a[1]);
  if (kinds.length) {
    lines.push('', `## ${t('By type')}`, '');
    for (const [kind, count] of kinds) {
      lines.push(`- ${kindLabel(kind)}: ${formatNumber(count)}`);
    }
  }
  if (report.highlights.length) {
    lines.push('', `## ${t('Priority alerts')}`, '');
    for (const a of report.highlights) {
      const where = coords(a);
      lines.push(
        `- **${severityLabel(a.severity)}** · ${stamp(a.at)} · ${a.title}${where ? ` (${where})` : ''}`,
      );
    }
  }
  if (report.hotspots.length) {
    lines.push('', `## ${t('Hotspots')}`, '');
    for (const h of report.hotspots) {
      lines.push(
        `- ${h.lat.toFixed(3)}, ${h.lon.toFixed(3)} — ${tn(h.count, '{count} alert', '{count} alerts', { count: formatNumber(h.count) })} (${severityLabel(h.worst)})`,
      );
    }
  }
  if (report.timeline.length) {
    lines.push('', `## ${t('Timeline')}`, '');
    for (const bucket of report.timeline) {
      lines.push(
        `- ${stamp(bucket.at)}: ${formatNumber(bucket.count)} (${severityLabel(bucket.worst)})`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );

/** Self-contained, print-ready HTML (no script, no external resource). */
export function renderHtml(report, { lang = 'en' } = {}) {
  const li = (s) => `<li>${s}</li>`;
  const sections = [];
  const kinds = Object.entries(report.byKind).sort((a, b) => b[1] - a[1]);
  if (kinds.length) {
    sections.push(
      `<h2>${escapeHtml(t('By type'))}</h2><ul>${kinds
        .map(([k, c]) =>
          li(`${escapeHtml(kindLabel(k))}: ${escapeHtml(formatNumber(c))}`),
        )
        .join('')}</ul>`,
    );
  }
  if (report.highlights.length) {
    sections.push(
      `<h2>${escapeHtml(t('Priority alerts'))}</h2><ul>${report.highlights
        .map((a) =>
          li(
            `<b class="sev-${a.severity}">${escapeHtml(severityLabel(a.severity))}</b> · ${escapeHtml(stamp(a.at))} · ${escapeHtml(a.title)}${
              coords(a) ? ` <small>(${escapeHtml(coords(a))})</small>` : ''
            }`,
          ),
        )
        .join('')}</ul>`,
    );
  }
  if (report.hotspots.length) {
    sections.push(
      `<h2>${escapeHtml(t('Hotspots'))}</h2><ul>${report.hotspots
        .map((h) =>
          li(
            `${escapeHtml(`${h.lat.toFixed(3)}, ${h.lon.toFixed(3)}`)} — ${escapeHtml(
              tn(h.count, '{count} alert', '{count} alerts', {
                count: formatNumber(h.count),
              }),
            )} (${escapeHtml(severityLabel(h.worst))})`,
          ),
        )
        .join('')}</ul>`,
    );
  }
  if (report.timeline.length) {
    sections.push(
      `<h2>${escapeHtml(t('Timeline'))}</h2><ul>${report.timeline
        .map((b) =>
          li(
            `${escapeHtml(stamp(b.at))}: ${escapeHtml(formatNumber(b.count))} (${escapeHtml(severityLabel(b.worst))})`,
          ),
        )
        .join('')}</ul>`,
    );
  }
  const title = t('WAGUESS synthesis report');
  return `<!doctype html>
<html lang="${escapeHtml(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:24px auto;padding:0 16px;color:#111}h1{font-size:1.4rem}h2{font-size:1.05rem;margin-top:1.4em;border-bottom:1px solid #ddd}.sev-critical{color:#b00020}.sev-warning{color:#8a5a00}.lead{font-size:1.1rem}@media print{body{margin:0}}</style></head>
<body><h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(
    t('Period: {from} → {to}', {
      from: stamp(report.period.from),
      to: stamp(report.period.to),
    }),
  )}${report.sessionLabel ? ` · ${escapeHtml(report.sessionLabel)}` : ''}<br><small>${escapeHtml(t('Generated'))}: ${escapeHtml(stamp(report.generatedAt))}</small></p>
<p class="lead"><b>${escapeHtml(headline(report))}</b>${report.crowd ? `<br>${escapeHtml(crowdLine(report.crowd.counts))}` : ''}</p>
${sections.join('\n')}
</body></html>
`;
}

function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Raw journal as CSV (UTF-8, one alert per line). */
export function renderCsv(alerts) {
  const head = [
    'id',
    'time_utc',
    'kind',
    'severity',
    'title',
    'detail',
    'lat',
    'lon',
    'source',
  ];
  const rows = [...alerts]
    .sort((a, b) => a.at - b.at)
    .map((a) =>
      [
        a.id,
        new Date(a.at).toISOString(),
        a.kind,
        a.severity,
        a.title,
        a.detail,
        a.lat,
        a.lon,
        a.source,
      ]
        .map(csvCell)
        .join(','),
    );
  return `${[head.join(','), ...rows].join('\r\n')}\r\n`;
}

/** Short plain text for a chat message. */
export function whatsappText(report) {
  const lines = [`*${t('WAGUESS synthesis report')}*`, headline(report)];
  if (report.crowd) lines.push(crowdLine(report.crowd.counts));
  for (const a of report.highlights.slice(0, 5)) {
    lines.push(
      `• ${severityLabel(a.severity)}: ${a.title}${coords(a) ? ` (${coords(a)})` : ''}`,
    );
  }
  let text = lines.join('\n');
  if (text.length > WHATSAPP_MAX) text = `${text.slice(0, WHATSAPP_MAX - 1)}…`;
  return text;
}

/** wa.me link: no account, no API key, works from any browser. */
export function whatsappUrl(text) {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}
