# WAGUESS Operations

Opérations, trafic collaboratif, journal d'alertes et rapport de synthèse.
Operations module: crowd-sourced road saturation, an automatic alert journal,
a synthesis report and "around me" search. Everything here is free software:
**no paid API, no account, no third-party service.**

Open it with the **OPS** button (bottom left). Tabs: Traffic · Alerts · Report · Nearby.

## 1. Road saturation from vehicles (cars and motorcycles)

Drivers and riders open `https://<your-server>/contribute.html` on their phone,
press _Start_ and leave the page open (a wake lock keeps the screen on while
driving; fix the phone in a mount). The page sends one anonymous sample every
5 seconds. The server turns many samples into a coloured line per road
section: green flowing, yellow slow, orange heavy, red jammed.

- Language: French by default, English available (`?lang=en`).
- Moto speeds count 20 % less when judging congestion (they filter through traffic).
- A section is shown only when **at least 3 distinct vehicles** contributed in
  the last 5 minutes. Free-flow speed is learned per section (85th percentile).
- Enable the map layer with _Show road saturation_ in the Traffic tab. Zoom to
  a city: the view is limited to 5° so one request never covers a country.

### Privacy by design

- Opt-in only, nothing runs until the person presses _Start_.
- The browser generates a random session token; the server stores only a
  salted hash prefix. No account, no phone number, no IP in the data.
- Samples live **in memory** for 10 minutes and are never written to disk.
- Output has no identifiers and no raw positions: only ~200 m cells × 8 heading
  sectors with averages. _Stop_ (or closing the page) deletes the session's samples.
- Geolocation in browsers requires **HTTPS** (or `localhost`). Put the server
  behind a TLS reverse proxy (Caddy, nginx) for phones.

### Server settings

| Variable              | Effect                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `WAGUESS_CROWD_TOKEN` | If set, contributions must send header `x-waguess-crowd-token`. Leave unset for an open campaign |

Endpoints (mounted on `/api/crowd`): `POST /report`, `POST /forget`,
`GET /segments?bbox=w,s,e,n`, `GET /status`. Bodies are capped at 16 KB and
requests are rate-limited per IP.

## 2. Alert journal (automatic session save)

Every alert is saved **immediately** in the browser's IndexedDB on the PC or
phone running WAGUESS (database `waguess-ops`), grouped into sessions. If
storage is blocked (private window) the journal stays in memory and says so.
Sources: traffic jams and recoveries, aircraft emergency squawks (7500, 7600,
7700), earthquakes (≥ 5.5 warning, ≥ 6.5 critical) and operator notes.
Sessions can be viewed, exported to CSV or deleted. Nothing leaves the device.

## 3. Synthesis report

The Report tab builds a summary of the current (or a saved) session: totals by
severity and type, priority alerts, hotspots and a timeline. Export as HTML
(printable to PDF), Markdown or CSV, copy a short text, or share it via
WhatsApp (`wa.me` link, no API). CSV cells starting with `= + - @` are
neutralised against spreadsheet formula injection.

## 4. Search around active roads

_Nearby_ → _Around me_ uses the device GPS, or type a place or `lat, lon`
(`12.37, -1.52`, N/S/E/W/O letters accepted). Places resolve first against an
offline gazetteer (Ouagadougou, Bobo-Dioulasso, Koudougou, Ouahigouya, Banfora,
Dédougou, Kaya… plus Abidjan, Bamako, Niamey, Lomé, Accra, Dakar, Cotonou),
then the normal geocoders. Results list the nearest active road sections with
level, speed, heading and number of vehicles, within 1, 3 or 10 km.

## Limits

- Accuracy depends on how many vehicles contribute; with few, nothing is shown
  rather than guessed.
- State is in server memory: a restart empties the traffic picture.
- Multi-instance deployments need a shared store (not included).
