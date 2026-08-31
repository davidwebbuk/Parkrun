# parkrun by train

A small website that answers: **"which UK parkruns can I reach in time for the
9am start using nothing but public transport?"**

Give it your location (GPS or a postcode), pick a departure station, and it
estimates which parkrun events you could realistically get to by train,
sorted by how easy the trip is, with a map and a one-click link to check the
real directions on Google Maps.

## How it works

1. **Location** — browser geolocation, or a UK postcode resolved via the free
   [postcodes.io](https://postcodes.io/) API (called directly from the
   browser).
2. **Nearest stations** — the backend loads the
   [NaPTAN](https://naptan.api.dft.gov.uk/) open dataset (DfT, Open
   Government Licence), filtered to rail stations (`StopTypes=RLY`), and
   finds the closest ones to you by straight-line distance.
3. **parkrun events** — the backend loads
   [`https://images.parkrun.com/events.json`](https://images.parkrun.com/events.json),
   filtered down to GB events (detected dynamically from the `countries`
   block in that file, not a hardcoded country ID).
4. **Reachability** — for every GB parkrun, it finds the nearest station to
   the event, estimates a walk-to-station + rail + walk-from-station journey,
   works out what time you'd need to leave home for a Saturday start (09:00
   for England/Wales, 09:30 for Scotland/Northern Ireland, correctly
   converted between GMT and BST), and flags the event as reachable if that
   departure time is realistic.
5. **Results** — a sortable list plus a Leaflet/OpenStreetMap map, each
   result linking out to a pre-filled Google Maps *transit directions* URL
   (`google.com/maps/dir/?api=1&...&travelmode=transit`) so you can check the
   actual live timetable in one click.

## ⚠️ Important limitation: journey times are estimates, not live timetables

There is currently **no live rail-timetable integration**. Getting one
requires a registered API token (e.g. National Rail's Darwin/OpenLDBWS feed,
or a commercial journey-planning API), which this session couldn't sign up
for on your behalf. Instead, rail journey time is approximated from
straight-line distance between stations (`server/lib/journeyEstimate.js`):

- distance × a route "wiggle" factor ÷ an assumed average speed
- a fixed 15-minute penalty per assumed interchange (one per ~50km, capped at 3)
- a 10-minute station-arrival buffer, plus walk times at 4.5 km/h

This is a *rough planning filter*, not a real timetable — it will be wrong
for routes with awkward connections or infrequent rural lines, and doesn't
know about engineering works, cancellations, or Sunday-only-parkrun-adjacent
timetable quirks. **Every result links to real Google Maps transit
directions — always check that before travelling.**

To add real timetables later: implement a second provider in
`server/lib/journeyEstimate.js` (e.g. calling OpenLDBWS or a journey-planner
API) and swap it in behind the same `estimateJourney()` interface used by
`server/index.js`.

## Data-source assumptions, unverified by live testing

This was built in a sandboxed environment with **no outbound access** to
`parkrun.com`, `nationalrail.co.uk`, or `naptan.api.dft.gov.uk` — so the
exact JSON/CSV field names below are informed by general knowledge, not a
live test run, and the code is written defensively (multiple candidate field
names, clear errors, and a bundled fallback dataset) so it fails safely if a
name has changed:

- `events.json`: assumed shape `{ events: { features: [...] }, countries: {...} }`,
  each feature's `properties` holding an `eventname` slug and `countrycode`.
  See `server/lib/parkrunSource.js`.
- NaPTAN CSV: assumed columns `CommonName`, `Latitude`, `Longitude`,
  `ATCOCode`. See `server/lib/stationSource.js`.

**Before relying on this**, run it once with real internet access and check
the server logs for `[parkrunSource]` / `[stationSource]` fallback warnings —
if you see none, live data loaded correctly. If you do see them, open the
corresponding file, fetch the URL manually, and adjust the candidate column
names.

If live fetching fails for either data source, the app falls back to a small
bundled sample dataset (`data/fallback-*.json` — ~15 well-known parkruns and
~25 major stations) so the site still runs and is demoable offline.

## Running it

```bash
npm install
npm start        # http://localhost:3000
# or, for auto-restart on changes:
npm run dev
```

No environment variables or API keys are required for the current
(estimate-based) version.

## Project layout

```
server/
  index.js              Express app + API routes
  lib/
    parkrunSource.js     fetch + normalize + cache GB parkrun events
    stationSource.js     fetch + normalize + cache UK rail stations
    csv.js                tiny CSV parser (no dependency)
    geo.js                haversine distance / nearest-N
    journeyEstimate.js    heuristic journey-time model
    parkrunTiming.js      per-nation default start times, GMT/BST-aware "next Saturday"
public/
  index.html / styles.css / app.js   static frontend (geolocation, postcode, Leaflet map, results)
data/
  fallback-parkruns.json / fallback-stations.json   bundled offline sample data
```

## API

- `GET /api/stations` — all known rail stations
- `GET /api/parkruns` — all known GB parkrun events
- `GET /api/nearest-stations?lat=&lon=&limit=` — nearest stations to a point
- `GET /api/reachable?lat=&lon=&stationId=&arrivalBufferMin=&maxTotalMinutes=`
  — reachable parkruns from a given start point/station, sorted by estimated
  door-to-door time

## Possible next steps

- Wire up a real timetable/journey-planner API for accurate times.
- Support Sunday junior parkrun (2k, different start times).
- Cache/precompute station→parkrun nearest-station pairs instead of
  recomputing per request.
- Let users pick a specific Saturday (bank holidays, Christmas period have no
  events) rather than always "next Saturday".
- Expand beyond GB to other parkrun countries.
