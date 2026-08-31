# parkrun by train

A small website that answers: **"which UK parkruns can I reach in time for the
9am start using nothing but public transport?"**

Give it your location (GPS or a postcode) and it estimates which parkrun
events you could realistically get to by public transport, sorted by how
easy the trip is, with a map and a one-click link to check the real
directions on Google Maps. No need to pick a departure station — when live
data is configured (see below), Google picks the real best route (train,
bus, tube, tram, or a mix) from wherever you actually are.

## How it works

1. **Location** — browser geolocation, or a UK postcode resolved via the free
   [postcodes.io](https://postcodes.io/) API (called directly from the
   browser).
2. **Nearest stations** — the backend loads the
   [NaPTAN](https://naptan.api.dft.gov.uk/) open dataset (DfT, Open
   Government Licence), filtered to rail stations (`StopTypes=RLY`, plus a
   client-side filter - see "Data-source notes"), and uses the closest one
   to you (by straight-line distance) as the heuristic's origin point. This
   is purely a backend implementation detail now, not something you pick -
   see "Adding real timetables" for why.
3. **parkrun events** — the backend loads
   [`https://images.parkrun.com/events.json`](https://images.parkrun.com/events.json),
   filtered down to GB events (detected dynamically from the `countries`
   block in that file, not a hardcoded country ID).
4. **Reachability** — for every GB parkrun, it finds the nearest station to
   the event, estimates a walk-to-station + rail + walk-from-station journey,
   works out what time you'd need to leave home for a Saturday start (09:00
   for England/Wales, 09:30 for Scotland/Northern Ireland, correctly
   converted between GMT and BST), and flags the event as reachable if that
   departure time is realistic. This heuristic estimate is refined with a
   real Google Directions lookup where configured (see below).
5. **Results** — a sortable list plus a Leaflet/OpenStreetMap map, each
   result linking out to a pre-filled Google Maps *transit directions* URL
   (`google.com/maps/dir/?api=1&...&travelmode=transit`) so you can check the
   actual live timetable in one click.
6. **Optional: your parkrun history** — enter your parkrun ID and the app
   hides events you've already done, and highlights the top result as your
   **NENDY** (Nearest Event Not Done Yet — a term from parkrun tourism
   culture, not something this app invented). See "Filtering by parkrun
   history" below.

## Filtering by parkrun history (NENDY)

`server/lib/parkrunAthleteSource.js` fetches a parkrunner's public results
history from `https://www.parkrun.org.uk/parkrunner/<id>/all/` and parses out
which events they've completed. The URL pattern and HTML parsing approach
(find the `<caption>` containing "All"/"Results", read its parent `<table>`,
zip header cells to data cells, pull the event slug from the "Event" column's
link `href`) is cross-checked against
[andydavidson/parkrun-mcp](https://github.com/andydavidson/parkrun-mcp), an
existing open-source project scraping the same public page — same pattern
used earlier for `events.json`. Verified with a synthetic HTML fixture
matching that shape (multiple visits to the same event correctly dedupe to
one "done" event; rows with no parseable link still get name-matched as a
fallback), but **not yet tested against a real parkrun.org.uk page** from
this session (no outbound access here — see "Data-source notes").

Results history is public by default, but a parkrunner can opt out in their
privacy settings — if that page doesn't show a recognizable results table
(private profile, wrong ID, or the fetch fails outright), the app doesn't
error: it just runs unfiltered and says why in `athleteFilter.note`.

Pass `athleteId` as a query param to `/api/reachable` (or fill in the
"parkrun ID" field in the UI) — accepts `"A1234567"`, `"a1234567"`, or bare
`"1234567"`. When applied, the top result (already sorted by ease of
journey, now filtered to events not yet done) is flagged `nendy: true` and
highlighted in the UI.

### Letter challenges (Alphabet, "PARKRUN", your name)

`server/lib/letterChallenges.js` builds three parkrun tourism "letter
challenges" from the same completed-events data used for NENDY filtering:
the full **A-Z Alphabet Challenge**, spelling out **"PARKRUN"**, and
spelling the parkrunner's **own name** (only when one could be confidently
extracted - see below, this one is called **Namely**). A leading "The " is
always ignored (so "The Hague parkrun" counts as **H**, not T). For each
letter still needed, the response reports the single best (closest)
reachable, not-yet-done event that would fill it - computed from the
heuristic-reachable set, so it costs no extra live API calls. A fully
completed challenge still appears in the response (frontend shows
"Complete! 🎉" rather than the challenge disappearing).

Alphabet and PARKRUN use a *set* convention (informal community
challenges, no single canonical rulebook - a documented assumption, not a
verified rule): only which letters appear matters, not repeat counts (one
"R" event satisfies every R in "PARKRUN"). The name challenge instead
matches the real **Namely** companion app's own algorithm, verified
against a real screenshot: every letter of the full name counts *with
repeats* (three Ns in the name need three separate events), and each
occurrence must be a *distinct* completed event, assigned earliest-visited
first - one venue can't cover two occurrences of the same letter no matter
how many times it's been revisited. This needs each completed event's
first-visit date, not just its name, which `parkrunAthleteSource.js` now
also scrapes from the results table's date column.

The name challenge needs the parkrunner's display name. The results page's
`<title>` tag is generic ("results | parkrun UK") and carries no name -
confirmed against a real profile page - so `parkrunAthleteSource.js`
instead anchors on the athlete ID itself, which is already known exactly
(it's the ID we asked for): it looks for a heading (`h1`/`h2`/`h3`)
containing a `(<athleteId>)`-shaped `<span>`, e.g.
`<h2>David WEBB&nbsp;<span title="parkrun ID">(A140237)</span></h2>`, strips
the span out, and takes what's left as the name (normalizing an ALL-CAPS
surname like "WEBB" to Title Case). If no heading matches that pattern, or
what's left doesn't look name-shaped (fewer than two words), it comes back
`undefined` and the name challenge is silently omitted, same
graceful-degradation pattern as everything else parkrun.org.uk-related in
this repo.

## Journey times: heuristic by default, real transit directions if you configure them

By default there is **no live-timetable integration** — rail journey time is
approximated from straight-line distance between stations
(`server/lib/journeyEstimate.js`): distance × a route "wiggle" factor ÷ an
assumed average speed, a penalty per assumed interchange, a station-arrival
buffer, plus walk times.

This is a *rough planning filter*, not a real timetable, and it has a sharp
edge: it assumes a sensible train service exists between any two nearby
stations based on distance alone, with **no idea whether the rail network
actually connects them**. In testing this showed several parkruns as
"reachable by train" that were only actually reachable by bus (sometimes
two) — the heuristic has no way to know that. Every result links to real
Google Maps transit directions so you can double check regardless.

### Adding real timetables

**National Rail's OJP (Online Journey Planner) Real Time Journey Planner**
looked like the ideal fit — a proper multi-leg SOAP API returning real
departure/arrival times per leg — and `server/lib/ojpClient.js` implements
it correctly (verified against the guide's own documented request/response
examples). **It turned out not to be usable here**: per National Rail's own
docs, OJP access requires a formal paid contract with the Rail Delivery
Group ("chargeable at cost-recovery rates"), not a self-serve API key — so
it's not wired into the app by default. The client code is still in the
repo in case that changes; see `.env.example` for how to point it at a real
account if you go through that process.

**What the app actually uses: Google's Directions API (transit mode)**
(`server/lib/googleDirectionsClient.js`). Rather than routing via a station
pair, it asks Google for the real transit route from your exact location to
the parkrun's exact location, arriving by a given time. This sidesteps the
station-CRS-code problem entirely (Directions takes raw coordinates), and —
critically — its response tells us the actual vehicle type for each transit
leg (`HEAVY_RAIL`, `BUS`, `SUBWAY`, ...), so the app can now tell you when a
route needs a bus instead of silently assuming it's all train.

`server/lib/journeyProvider.js` sits above it: tries a live lookup and falls
back to the heuristic on an indeterminate failure (network error, quota),
but treats a **definitive "no route" or "nothing arrives in time" as
authoritative** — it does not paper that over with the heuristic's guess,
which was the whole bug that prompted this change (see git history).

**To turn it on**, set in `.env` (see `.env.example`):

```
GOOGLE_MAPS_API_KEY=
```

You'll need a Google Cloud project with the Directions API enabled and
billing set up (required even for free-tier usage) — self-serve, no contract
needed, unlike OJP. This hasn't been tested against a live key from this
session; if you hit issues, check the server logs for
`[journeyProvider] Google Directions lookup failed: ...`.

Once configured, `/api/reachable` runs the heuristic across all events as
before, then spends live Directions lookups on a *slice* of the top
heuristic candidates — `liveOffset`/`liveLimit` query params control which
slice (8 requests at a time; see `LIVE_REFINE_CONCURRENCY`). The frontend
asks for a small first slice (10 - `INITIAL_LIVE_LIMIT` in `app.js`), enough
to confidently show the best option (the NENDY, when filtering by parkrun
history) plus a few alternates, and only asks for the next slice (20 -
`MORE_LIVE_LIMIT`) when the user clicks **"Show more options"** — each
result costs one billed Google API call, so this keeps typical usage far
below the `MAX_LIVE_LIMIT = 100` hard cap. The frontend merges slices across
requests by event ID, always preferring a result it already knows is
`"live"` over a later response that didn't re-check it (each request only
live-refines its own slice, so unrelated events legitimately come back as
`"estimated"` in that response even if a previous request already verified
them - the merge is what stops that from visually "downgrading" a card).
Each result's `journey.source` is `"live"` or `"estimated"`, and a live
result with `journey.usesNonRailTransit: true` gets a "Needs: ..." badge in
the UI instead of pretending it's pure train.

The results **list** only ever shows confirmed `"live"` results, capped at
`LIST_DISPLAY_LIMIT` (5) in `app.js` — an `"estimated"` number is often
optimistic (see the sort/NENDY note below), so it isn't trustworthy enough
to list as one of a handful of top picks. The **map**, however, still plots
every heuristic-reachable candidate regardless of source, so you can see
the fuller picture even though the list is curated. If fewer than 5 live
results have been found yet, the list shows however many exist (possibly
zero) with a prompt to click "Show more options".

Because the heuristic under-estimates, sorting by raw `totalMinutes` alone
would let an unverified `"estimated"` guess rank above a verified `"live"`
result with a higher-but-real number - burying trustworthy results (and
picking the wrong NENDY) under numbers that just look better on paper. Both
the server's post-refinement sort and the frontend's cross-request merge
sort (`compareResults` in each) rank `"live"` results ahead of `"estimated"`
ones first, only using `totalMinutes` to break ties within each group.

## Data-source notes

This was built in a sandboxed environment with no outbound access to
`parkrun.com`, `nationalrail.co.uk`, or `naptan.api.dft.gov.uk`, so the code
was written defensively (multiple candidate field names, clear errors, a
bundled fallback dataset) and later verified against real output from a
live machine:

- `events.json` shape — confirmed correct, both by cross-checking against
  [andydavidson/parkrun-mcp](https://github.com/andydavidson/parkrun-mcp) (an
  existing project parsing the same feed) and by a live test run: `{ events:
  { features: [...] }, countries: {...} }`, each feature's
  `properties.eventname` (slug), `properties.countrycode`, and
  `geometry.coordinates` as `[lon, lat]`. Also filters on
  `properties.seriesid === 1` to exclude junior parkrun's 2k/Sunday events.
  See `server/lib/parkrunSource.js`.
- NaPTAN CSV — column names confirmed correct (`CommonName`, `Latitude`,
  `Longitude`, `ATCOCode`) via a live fetch. That same live fetch also
  caught a real bug: NaPTAN's own `StopTypes=RLY` query parameter does
  **not** filter server-side (it silently returns every stop type,
  including bus stops) — fixed by filtering client-side on the CSV's
  `StopType` column instead. Confirmed via that fetch: NaPTAN has **no**
  CRS-code column at all, which is why the live-timetable path
  (`googleDirectionsClient.js`) routes by raw coordinates rather than
  station codes. See `server/lib/stationSource.js`.

If live fetching fails for either data source, the app falls back to a small
bundled sample dataset (`data/fallback-*.json` — ~15 well-known parkruns and
~25 major stations) so the site still runs and is demoable offline. Check
server logs for `[parkrunSource]` / `[stationSource]` fallback warnings if
results look off.

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

## Deploying

### Publishing this repo for others to run

Already in place for that: `package.json` has `start`/`dev` scripts and a
declared MIT `LICENSE`; `.env.example` documents every optional variable
while the real `.env` stays gitignored; `data/fallback-*.json` means a
fresh clone runs with zero setup (live transit directions are opt-in via
`GOOGLE_MAPS_API_KEY`, everything else needs no keys at all).

Two things worth doing before pointing people at it:
1. Merge this branch into `main`/`master` via a PR — everything currently
   lives on a feature branch (`claude/parkrun-public-transport-9fqo9s`),
   easy for a visitor to miss.
2. Make sure the repo's visibility is **Public** (Settings → General) if
   it isn't already, so others can find and clone it. Renaming the repo
   away from `Claude_PR` to something that says what it is (e.g.
   `parkrun-by-train`) is optional — GitHub redirects the old URL
   automatically, so it's safe to do at any point.

From there, `npm install && npm start` (this README's "Running it" above)
is the whole setup story for anyone who clones it.

### Hosting your own copy on a domain

This is a small always-on Express server with in-memory caching and no
database — it wants a host that keeps one process running continuously,
not a serverless/functions platform (which would cold-start and lose the
cache on every invocation). Two reasonable paths:

- **Managed platform** (Render, Railway, Fly.io, etc.) — point it at this
  GitHub repo; it runs `npm install` then `npm start` automatically
  (`.node-version` / `package.json`'s `engines` field pin the Node
  version). Add `GOOGLE_MAPS_API_KEY` as an environment variable in the
  host's dashboard — never commit `.env`. Add your domain in the same
  dashboard; it gives you a DNS record (usually a CNAME) to add at your
  domain registrar, and issues a free TLS certificate automatically. All
  three have a free or low single-digit £/month tier, which is plenty for
  personal traffic — separate from, and much smaller than, Google's
  metered Directions API billing.
- **A VPS you run yourself** (DigitalOcean, Hetzner, Linode, etc.) —
  cheaper at scale and full control, but more setup: install Node, keep
  the process alive with `pm2` or a `systemd` unit, put `nginx` in front
  as a reverse proxy, and get a certificate with `certbot`. Worth it
  mainly if you already run one of these for something else.

Either way, the app itself needs no code changes to deploy — it already
reads `PORT` from the environment and falls back to bundled sample data if
any external fetch fails.

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
    googleDirectionsClient.js  Google Directions (transit) client - the active live-data path
    ojpClient.js               SOAP client for National Rail's OJP - built but unused (needs a paid contract, see above)
    journeyProvider.js         tries googleDirectionsClient, falls back to the heuristic
    parkrunAthleteSource.js    fetch + parse a parkrunner's results history for NENDY filtering
    letterChallenges.js        Alphabet/"PARKRUN"/name letter-challenge progress + opportunities
public/
  index.html / styles.css / app.js   static frontend (geolocation, postcode, Leaflet map, results)
data/
  fallback-parkruns.json / fallback-stations.json   bundled offline sample data
```

## API

- `GET /api/stations` — all known rail stations
- `GET /api/parkruns` — all known GB parkrun events
- `GET /api/nearest-stations?lat=&lon=&limit=` — nearest stations to a point
- `GET /api/reachable?lat=&lon=&stationId=&arrivalBufferMin=&maxTotalMinutes=&athleteId=&liveOffset=&liveLimit=`
  — reachable parkruns from a given start point/station, sorted by
  door-to-door time (each result's `journey.source` is `"live"` or
  `"estimated"`, and `journey.usesNonRailTransit` flags a live result that
  needs a bus; the response's `liveTimetableConfigured` says whether
  Google Directions is switched on at all). `liveOffset`/`liveLimit`
  (defaults `0`/`10`, hard-capped so `liveOffset + liveLimit <= 100`)
  control which slice of the heuristic-ranked candidates gets a real
  Google Directions call this request — see "Journey times" above for why,
  and the response's `totalHeuristicReachable` for how many candidates
  exist in total (so a caller knows whether a bigger `liveOffset` would
  find anything). `athleteId` is optional — when
  given, events that parkrunner has already done are filtered out, the
  response includes an `athleteFilter` object (`requested`/`applied`/
  `completedCount`/`note`), and the top result gets `nendy: true`. When
  applied, the response also includes a `challenges` array (Alphabet,
  "PARKRUN", and - when a name could be extracted - the parkrunner's own
  name), each with `missingLetters` and `opportunities` (the closest
  reachable event that fills each missing letter) - see "Letter challenges"
  above.

## Possible next steps

- Test `athleteId` filtering against a real parkrun.org.uk results page
  (not done from this session — see "Filtering by parkrun history" above).
- Support Sunday junior parkrun (2k, different start times).
- Cache/precompute station→parkrun nearest-station pairs instead of
  recomputing per request.
- Let users pick a specific Saturday (bank holidays, Christmas period have no
  events) rather than always "next Saturday".
- Expand beyond GB to other parkrun countries.
