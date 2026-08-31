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

## Journey times: heuristic by default, real timetables if you configure them

By default there is **no live rail-timetable integration** — rail journey
time is approximated from straight-line distance between stations
(`server/lib/journeyEstimate.js`):

- distance × a route "wiggle" factor ÷ an assumed average speed
- a fixed 15-minute penalty per assumed interchange (one per ~50km, capped at 3)
- a 10-minute station-arrival buffer, plus walk times at 4.5 km/h

This is a *rough planning filter*, not a real timetable — it will be wrong
for routes with awkward connections or infrequent rural lines. Every result
also links to real Google Maps transit directions so you can double check.

### Adding real timetables (National Rail OJP RTJP)

National Rail Enquiries offers a proper multi-leg journey planner API — the
**OJP (Online Journey Planner) Real Time Journey Planner web service**,
documented in National Rail's own "RTJP User Guide" (P82571002 Issue 10;
**not included in this repo** — it's marked confidential/Thales copyright,
reproduction not permitted — get it from your raildata.org.uk account or
National Rail Enquiries), reachable via
an account on [raildata.org.uk](https://raildata.org.uk). It's a SOAP 1.1
service (not REST/JSON) whose `RealtimeJourneyPlan` operation returns real
multi-leg journeys with both scheduled and live departure/arrival times per
leg — exactly the "how do I actually get from station A to station B, with
changes, right now" answer this app needs.

`server/lib/ojpClient.js` implements that operation directly from the
guide's documented request/response examples: builds the SOAP envelope,
authenticates with HTTP Basic Auth, and parses the response (including SOAP
faults) with `fast-xml-parser`. `server/lib/journeyProvider.js` sits above
it: for a given origin/destination station pair it tries a live lookup and
falls back to the heuristic on any failure, missing config, or missing CRS
code, always returning the same shape either way (tagged
`source: "live"` or `source: "estimated"`).

**To turn it on**, set these in `.env` (see `.env.example`):

```
OJP_ENDPOINT_URL=   # the SOAP endpoint URL - see below
OJP_USERNAME=
OJP_PASSWORD=
```

Two things are **not yet verified against a live account** (this session had
no outbound access to `nationalrail.co.uk` or `raildata.org.uk` to check):

1. **`OJP_ENDPOINT_URL`** — the guide gives the WSDL location
   (`http://ojp.nationalrail.co.uk/webservices/jpdlr.wsdl`, itself only
   fetchable once your account is set up) but not the bare SOAP endpoint
   URL used here. Find it either in the WSDL's `<soap:address location="...">`
   element, or on your raildata.org.uk subscription/product page, and put it
   in `.env`.
2. **Auth details** — the guide documents HTTP Basic Auth (username/password)
   as an alternative to IP allow-listing; the latter isn't practical here
   since this app could run from any host. Confirm your raildata.org.uk
   account issues username/password credentials for this product, not just
   an API key in a header — if it's the latter, `ojpClient.js`'s auth header
   will need a small adjustment.

There's a second gap worth knowing about: National Rail addresses stations
by **CRS code** (3-letter, e.g. `WAT` for London Waterloo), but it's
unconfirmed whether the NaPTAN CSV used for `stationSource.js` actually
carries CRS codes in an obvious column (candidates tried: `CrsRef`,
`CrsCode`, `StationCRS`, `Crs` — see the `CRS_KEYS` list there). If none
match, live stations simply won't have a `crs` field, and
`journeyProvider.js` correctly falls back to the heuristic for any station
pair missing one — so a wrong/missing guess degrades gracefully rather than
breaking anything, but you'll want to check the server logs and either fix
the column name or wire up a proper CRS lookup (e.g. a small static
CRS-code reference dataset) if live results seem sparse.

Once configured, `/api/reachable` runs the heuristic across all events as
before, then spends live OJP lookups only on the top ~20 heuristic
candidates (6 at a time) to refine their journey times and re-rank — so it
doesn't hammer the API with one call per parkrun event on every request.

## Data-source assumptions, unverified by live testing

This was built in a sandboxed environment with **no outbound access** to
`parkrun.com`, `nationalrail.co.uk`, or `naptan.api.dft.gov.uk` — so the
code is written defensively (multiple candidate field names, clear errors,
and a bundled fallback dataset) so it fails safely if a name has changed.

- `events.json` shape — **cross-checked against
  [andydavidson/parkrun-mcp](https://github.com/andydavidson/parkrun-mcp)**,
  an existing open-source project that parses the same feed, and confirmed
  correct: `{ events: { features: [...] }, countries: {...} }`, each
  feature's `properties.eventname` (slug), `properties.countrycode`, and
  `geometry.coordinates` as `[lon, lat]`. That project also filters on
  `properties.seriesid === 1` to get standard Saturday 5k events (excluding
  junior parkrun's 2k/Sunday events, which run on a different schedule) —
  `parkrunSource.js` now applies the same filter. See
  `server/lib/parkrunSource.js`.
- NaPTAN CSV: assumed columns `CommonName`, `Latitude`, `Longitude`,
  `ATCOCode` — **not** cross-checked against another source, still unverified.
  See `server/lib/stationSource.js`.

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
cp .env.example .env   # optional: only needed for live timetables, see above
npm start               # http://localhost:3000
# or, for auto-restart on changes:
npm run dev
```

No environment variables are required for the default (heuristic-only)
version — `.env` is entirely optional.

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
    ojpClient.js           SOAP client for National Rail's OJP RealtimeJourneyPlan
    journeyProvider.js     tries ojpClient, falls back to the heuristic
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
  — reachable parkruns from a given start point/station, sorted by
  door-to-door time (each result's `journey.source` is `"live"` or
  `"estimated"`; the response's `liveTimetableConfigured` says whether OJP
  is switched on at all)

## Possible next steps

- Verify `OJP_ENDPOINT_URL` and the CRS-code column against a live NaPTAN
  fetch and a live raildata.org.uk account (see above).
- Support Sunday junior parkrun (2k, different start times).
- Cache/precompute station→parkrun nearest-station pairs instead of
  recomputing per request.
- Let users pick a specific Saturday (bank holidays, Christmas period have no
  events) rather than always "next Saturday".
- Expand beyond GB to other parkrun countries.
