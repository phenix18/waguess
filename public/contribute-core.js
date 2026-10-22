// WAGUESS contributor page — pure helpers (no DOM, no network, no storage).

export const REPORT_EVERY_MS = 5000;
export const MAX_ACCURACY_M = 100;
export const MAX_BACKOFF_MS = 60_000;

export const MESSAGES = Object.freeze({
  fr: Object.freeze({
    title: 'Partager ma position pour le trafic',
    lead: 'Aidez les autres conducteurs : en partageant votre vitesse, WAGUESS peut dire si une route est saturée (embouteillage) ou fluide.',
    whatTitle: 'Ce qui est envoyé',
    what1:
      'Votre position, votre vitesse et votre direction, toutes les 5 secondes, tant que le partage est actif.',
    what2:
      'Un code aléatoire de session, créé au démarrage et oublié à l’arrêt. Ni nom, ni compte, ni numéro de téléphone.',
    notTitle: 'Ce qui n’est pas fait',
    not1: 'Aucun trajet n’est enregistré ni affiché : le serveur ne publie que des moyennes par tronçon d’environ 200 m, et seulement s’il y a au moins 3 véhicules.',
    not2: 'Les positions sont effacées du serveur après 10 minutes, ou tout de suite si vous appuyez sur « Arrêter et effacer ».',
    consent:
      'J’accepte de partager ma position de façon anonyme tant que cette page est ouverte.',
    mode: 'Mon véhicule',
    car: 'Voiture / camion',
    moto: 'Moto',
    token: 'Code de contribution (si demandé)',
    start: 'Démarrer le partage',
    stop: 'Arrêter et effacer',
    idle: 'Partage arrêté.',
    needConsent: 'Cochez la case de consentement pour démarrer.',
    insecure:
      'Le navigateur bloque la localisation sur une page non sécurisée. Ouvrez WAGUESS en HTTPS (ou en local sur localhost).',
    unsupported: 'Ce navigateur ne sait pas donner la position.',
    denied:
      'Localisation refusée. Autorisez-la dans les réglages du navigateur puis réessayez.',
    unavailable: 'Position indisponible pour le moment…',
    waiting: 'Recherche de la position…',
    sharing: 'Partage actif',
    speed: 'Vitesse',
    sent: 'Envois réussis',
    lastSent: 'Dernier envoi',
    accuracy: 'Précision',
    kmh: 'km/h',
    metres: 'm',
    never: 'jamais',
    offline: 'Envoi impossible, nouvelle tentative…',
    tooFrequent: 'Trop d’envois, ralentissement automatique…',
    refused: 'Le serveur demande un code de contribution valide.',
    stopped: 'Partage arrêté, vos données ont été effacées du serveur.',
    stoppedKept:
      'Partage arrêté. Les données restantes expireront d’elles-mêmes sous 10 minutes.',
    keepOpen:
      'Gardez cette page ouverte et l’écran allumé pendant que vous roulez. Ne la manipulez pas en conduisant.',
  }),
  en: Object.freeze({
    title: 'Share my position for traffic',
    lead: 'Help other drivers: by sharing your speed, WAGUESS can tell whether a road is congested or flowing.',
    whatTitle: 'What is sent',
    what1:
      'Your position, speed and heading every 5 seconds while sharing is on.',
    what2:
      'A random session code, created at start and forgotten at stop. No name, account or phone number.',
    notTitle: 'What is not done',
    not1: 'No trip is recorded or shown: the server only publishes averages per road section of about 200 m, and only with at least 3 vehicles.',
    not2: 'Positions are erased from the server after 10 minutes, or right away if you press “Stop and erase”.',
    consent:
      'I agree to share my position anonymously while this page is open.',
    mode: 'My vehicle',
    car: 'Car / truck',
    moto: 'Motorbike',
    token: 'Contribution code (if requested)',
    start: 'Start sharing',
    stop: 'Stop and erase',
    idle: 'Sharing is off.',
    needConsent: 'Tick the consent box to start.',
    insecure:
      'The browser blocks location on an insecure page. Open WAGUESS over HTTPS (or locally on localhost).',
    unsupported: 'This browser cannot provide a position.',
    denied: 'Location denied. Allow it in the browser settings and try again.',
    unavailable: 'Position unavailable for now…',
    waiting: 'Looking for a position…',
    sharing: 'Sharing is on',
    speed: 'Speed',
    sent: 'Successful sends',
    lastSent: 'Last send',
    accuracy: 'Accuracy',
    kmh: 'km/h',
    metres: 'm',
    never: 'never',
    offline: 'Cannot send, retrying…',
    tooFrequent: 'Too many sends, slowing down automatically…',
    refused: 'The server needs a valid contribution code.',
    stopped: 'Sharing stopped, your data was erased from the server.',
    stoppedKept:
      'Sharing stopped. Remaining data will expire by itself within 10 minutes.',
    keepOpen:
      'Keep this page open and the screen on while you ride or drive. Do not handle it while driving.',
  }),
});

/** French unless the browser clearly prefers English (French is the default here). */
export function pickLanguage(languages) {
  const list = Array.isArray(languages) ? languages : [languages];
  for (const tag of list) {
    const base = String(tag || '')
      .slice(0, 2)
      .toLowerCase();
    if (base === 'fr') return 'fr';
    if (base === 'en') return 'en';
  }
  return 'fr';
}

/** 24 URL-safe characters from a `crypto.getRandomValues` implementation. */
export function newSessionId(getRandomValues) {
  const bytes = new Uint8Array(18);
  getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function haversineM(a, b) {
  const R = 6_371_000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearingDeg(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * Turn a Geolocation position into a sample. When the device gives no speed
 * (many desktops, some phones), derive it from the previous fix.
 * @returns {{lat:number,lon:number,speedKmh:number,heading:number|null,accuracyM:number|null,mode:string}|null}
 */
export function toSample(position, previousFix, mode) {
  const c = position?.coords;
  if (!c || !Number.isFinite(c.latitude) || !Number.isFinite(c.longitude))
    return null;
  const accuracy = Number.isFinite(c.accuracy) ? c.accuracy : null;
  if (accuracy !== null && accuracy > MAX_ACCURACY_M) return null;
  const here = { lat: c.latitude, lon: c.longitude, t: position.timestamp };
  let speedKmh =
    Number.isFinite(c.speed) && c.speed >= 0 ? c.speed * 3.6 : null;
  let heading = Number.isFinite(c.heading) ? c.heading : null;
  if (previousFix && position.timestamp > previousFix.t) {
    const seconds = (position.timestamp - previousFix.t) / 1000;
    const metres = haversineM(previousFix, here);
    if (speedKmh === null && seconds >= 1 && seconds <= 30) {
      speedKmh = (metres / seconds) * 3.6;
    }
    if (heading === null && metres > 8) heading = bearingDeg(previousFix, here);
  }
  if (speedKmh === null) return null;
  return {
    lat: Math.round(here.lat * 1e5) / 1e5,
    lon: Math.round(here.lon * 1e5) / 1e5,
    speedKmh: Math.round(speedKmh * 10) / 10,
    heading: heading === null ? null : Math.round(heading),
    accuracyM: accuracy === null ? null : Math.round(accuracy),
    mode: mode === 'moto' ? 'moto' : 'car',
  };
}

/** Delay before the next send: normal pace, doubling after failures. */
export function nextDelay(failures) {
  if (failures <= 0) return REPORT_EVERY_MS;
  return Math.min(MAX_BACKOFF_MS, REPORT_EVERY_MS * 2 ** Math.min(failures, 5));
}
