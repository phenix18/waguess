// Offline gazetteer: Burkina Faso's main towns plus the capitals and hubs
// around it. No network and no paid geocoder, so "search by place" keeps
// working where roaming data is poor. Coordinates are town centres, rounded
// to ~100 m: they are search anchors, not survey points.

/** @type {ReadonlyArray<{name:string, aliases?:string[], country:string, lat:number, lon:number}>} */
export const GAZETTEER = Object.freeze([
  {
    name: 'Ouagadougou',
    aliases: ['Ouaga'],
    country: 'BF',
    lat: 12.3714,
    lon: -1.5197,
  },
  {
    name: 'Bobo-Dioulasso',
    aliases: ['Bobo'],
    country: 'BF',
    lat: 11.1771,
    lon: -4.2979,
  },
  { name: 'Koudougou', country: 'BF', lat: 12.2526, lon: -2.3627 },
  { name: 'Ouahigouya', country: 'BF', lat: 13.5828, lon: -2.4216 },
  { name: 'Banfora', country: 'BF', lat: 10.6333, lon: -4.7667 },
  { name: 'Dédougou', country: 'BF', lat: 12.4633, lon: -3.4608 },
  { name: 'Kaya', country: 'BF', lat: 13.0917, lon: -1.0844 },
  { name: 'Tenkodogo', country: 'BF', lat: 11.7803, lon: -0.3697 },
  {
    name: "Fada N'Gourma",
    aliases: ['Fada'],
    country: 'BF',
    lat: 12.0614,
    lon: 0.3584,
  },
  { name: 'Dori', country: 'BF', lat: 14.0354, lon: -0.0346 },
  { name: 'Ziniaré', country: 'BF', lat: 12.5833, lon: -1.3 },
  { name: 'Réo', country: 'BF', lat: 12.32, lon: -2.47 },
  { name: 'Gaoua', country: 'BF', lat: 10.3333, lon: -3.1833 },
  { name: 'Manga', country: 'BF', lat: 11.6639, lon: -1.0711 },
  { name: 'Léo', country: 'BF', lat: 11.1, lon: -2.1 },
  { name: 'Pô', country: 'BF', lat: 11.17, lon: -1.15 },
  { name: 'Orodara', country: 'BF', lat: 10.9764, lon: -4.9061 },
  { name: 'Abidjan', country: 'CI', lat: 5.36, lon: -4.0083 },
  { name: 'Bamako', country: 'ML', lat: 12.6392, lon: -8.0029 },
  { name: 'Sikasso', country: 'ML', lat: 11.3176, lon: -5.6665 },
  { name: 'Niamey', country: 'NE', lat: 13.5116, lon: 2.1254 },
  { name: 'Lomé', aliases: ['Lome'], country: 'TG', lat: 6.1725, lon: 1.2314 },
  { name: 'Accra', country: 'GH', lat: 5.6037, lon: -0.187 },
  { name: 'Tamale', country: 'GH', lat: 9.4075, lon: -0.8533 },
  { name: 'Cotonou', country: 'BJ', lat: 6.3703, lon: 2.3912 },
  { name: 'Dakar', country: 'SN', lat: 14.7167, lon: -17.4677 },
  { name: 'Conakry', country: 'GN', lat: 9.6412, lon: -13.5784 },
]);

/** Lower-case, accent-free, punctuation-free form used for matching. */
export function normalizeName(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const INDEX = GAZETTEER.map((place) => ({
  place,
  names: [place.name, ...(place.aliases ?? [])].map(normalizeName),
}));

/**
 * Exact (accent/case-insensitive) match on a name or alias, then a unique
 * prefix match of at least 3 characters ("bobo", "ouaga", "koud").
 * @returns {{name:string, country:string, lat:number, lon:number}|null}
 */
export function findPlace(text) {
  const query = normalizeName(text);
  if (!query) return null;
  const exact = INDEX.find((entry) => entry.names.includes(query));
  if (exact) return exact.place;
  if (query.length < 3) return null;
  const prefixed = INDEX.filter((entry) =>
    entry.names.some((name) => name.startsWith(query)),
  );
  return prefixed.length === 1 ? prefixed[0].place : null;
}

/** The gazetteer in the `{name, lat, lon}` shape `nearestPlaceName` reads. */
export const GAZETTEER_PRESETS = Object.freeze(
  Object.fromEntries(
    GAZETTEER.map((p) => [normalizeName(p.name).replace(/ /g, '-'), p]),
  ),
);
