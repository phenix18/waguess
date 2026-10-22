import {
  MESSAGES,
  newSessionId,
  nextDelay,
  pickLanguage,
  toSample,
} from './contribute-core.js';

const $ = (id) => document.getElementById(id);
const lang = pickLanguage(navigator.languages || [navigator.language]);
const t = MESSAGES[lang];
document.documentElement.lang = lang;
for (const el of document.querySelectorAll('[data-t]')) {
  el.textContent = t[el.dataset.t] ?? el.textContent;
}
document.title = `WAGUESS — ${t.title}`;

const ui = {
  consent: $('consent'),
  start: $('start'),
  stop: $('stop'),
  token: $('token'),
  state: $('state'),
  message: $('message'),
  speed: $('speed'),
  sent: $('sent'),
  last: $('last'),
  accuracy: $('accuracy'),
};

// Everything below lives in memory only: nothing is written to storage.
let sessionId = null;
let mode = 'car';
let watchId = null;
let wakeLock = null;
let timer = null;
let latest = null;
let previousFix = null;
let failures = 0;
let sentCount = 0;
let lastSentAt = null;
let running = false;

function say(text, tone = '') {
  ui.message.textContent = text;
  ui.message.dataset.tone = tone;
}

function render() {
  ui.start.disabled = running || !ui.consent.checked;
  ui.stop.disabled = !running;
  ui.consent.disabled = running;
  ui.token.disabled = running;
  for (const radio of document.querySelectorAll('input[name=mode]')) {
    radio.disabled = running;
  }
  ui.state.textContent = running ? t.sharing : t.idle;
  ui.state.dataset.on = running ? 'true' : 'false';
  ui.sent.textContent = String(sentCount);
  ui.last.textContent = lastSentAt
    ? new Date(lastSentAt).toLocaleTimeString(lang)
    : t.never;
  ui.speed.textContent = latest
    ? `${Math.round(latest.speedKmh)} ${t.kmh}`
    : '—';
  ui.accuracy.textContent =
    latest && latest.accuracyM !== null
      ? `${latest.accuracyM} ${t.metres}`
      : '—';
}

function headers() {
  const h = { 'Content-Type': 'application/json' };
  const token = ui.token.value.trim();
  if (token) h['x-waguess-crowd-token'] = token;
  return h;
}

async function send() {
  timer = null;
  if (!running) return;
  if (latest) {
    const sample = latest;
    latest = null;
    try {
      const response = await fetch('/api/crowd/report', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ sessionId, samples: [sample] }),
      });
      if (response.ok) {
        failures = 0;
        sentCount += 1;
        lastSentAt = Date.now();
        say(t.sharing, 'ok');
      } else if (response.status === 401) {
        failures += 1;
        say(t.refused, 'error');
      } else if (response.status === 429) {
        failures += 1;
        say(t.tooFrequent, 'warn');
      } else {
        failures += 1;
        say(t.offline, 'warn');
      }
    } catch {
      failures += 1;
      say(t.offline, 'warn');
    }
    render();
  }
  if (running) timer = setTimeout(send, nextDelay(failures));
}

async function keepAwake() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    wakeLock = null;
  }
}

function onPosition(position) {
  const sample = toSample(position, previousFix, mode);
  previousFix = {
    lat: position.coords.latitude,
    lon: position.coords.longitude,
    t: position.timestamp,
  };
  if (sample) {
    latest = sample;
    render();
  }
}

function onError(error) {
  if (error.code === error.PERMISSION_DENIED) {
    say(t.denied, 'error');
    stop(false);
  } else {
    say(t.unavailable, 'warn');
  }
}

function start() {
  if (!ui.consent.checked) return say(t.needConsent, 'warn');
  if (!window.isSecureContext) return say(t.insecure, 'error');
  if (!('geolocation' in navigator)) return say(t.unsupported, 'error');
  mode =
    document.querySelector('input[name=mode]:checked')?.value === 'moto'
      ? 'moto'
      : 'car';
  sessionId = newSessionId((bytes) => crypto.getRandomValues(bytes));
  running = true;
  failures = 0;
  sentCount = 0;
  lastSentAt = null;
  latest = null;
  previousFix = null;
  say(t.waiting);
  watchId = navigator.geolocation.watchPosition(onPosition, onError, {
    enableHighAccuracy: true,
    maximumAge: 2000,
    timeout: 20000,
  });
  keepAwake();
  timer = setTimeout(send, 2000);
  render();
}

async function stop(erase = true) {
  const id = sessionId;
  running = false;
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  clearTimeout(timer);
  timer = null;
  try {
    await wakeLock?.release();
  } catch {
    /* already released */
  }
  wakeLock = null;
  latest = null;
  previousFix = null;
  sessionId = null;
  if (erase && id) {
    try {
      const response = await fetch('/api/crowd/forget', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ sessionId: id }),
      });
      say(response.ok ? t.stopped : t.stoppedKept);
    } catch {
      say(t.stoppedKept, 'warn');
    }
  }
  render();
}

// Leaving the page ends the sharing and asks the server to forget the data.
addEventListener('pagehide', () => {
  if (running && sessionId) {
    fetch('/api/crowd/forget', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ sessionId }),
      keepalive: true,
    }).catch(() => {});
  }
});
document.addEventListener('visibilitychange', () => {
  if (running && document.visibilityState === 'visible') keepAwake();
});

ui.consent.addEventListener('change', render);
ui.start.addEventListener('click', start);
ui.stop.addEventListener('click', () => stop(true));
render();
if (!window.isSecureContext) say(t.insecure, 'warn');
