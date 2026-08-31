const path = require("path");
const express = require("express");

const { fetchParkruns } = require("./lib/parkrunSource");
const { fetchStations } = require("./lib/stationSource");
const { nearest } = require("./lib/geo");
const { estimateJourney } = require("./lib/journeyEstimate");
const { defaultStartTime, nextSaturdayAt } = require("./lib/parkrunTiming");
const googleDirections = require("./lib/googleDirectionsClient");
const { planJourney } = require("./lib/journeyProvider");
const { fetchCompletedEvents } = require("./lib/parkrunAthleteSource");

const PORT = process.env.PORT || 3000;
const EARLIEST_PLAUSIBLE_DEPARTURE_HOUR = 5.5; // 05:30 - before this, assume no usable train exists
const DEFAULT_ARRIVAL_BUFFER_MIN = 15; // arrive this many minutes before the start
const DEFAULT_MAX_TOTAL_MINUTES = 90; // don't bother suggesting long door-to-door trips
// How many of the heuristic's top candidates get a real live-Directions
// check. With a tight maxTotalMinutes (e.g. the 60-min default) the
// heuristic is often optimistic, so a low limit here means most/all of the
// checked candidates get correctly rejected by live data, leaving only
// *unchecked* heuristic guesses in the final list - i.e. nothing ever shows
// "Live" even though it's configured and working. 100 comfortably covers a
// tight-cutoff candidate set; each one is a billed Google API call, so this
// scales up API cost if maxTotalMinutes is loosened back up.
const LIVE_REFINE_LIMIT = 100;
const LIVE_REFINE_CONCURRENCY = 8;

/** Runs `worker` over `items` with at most `concurrency` in flight at once. */
async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

function recomputeReachability({ journey, startDate, arrivalBufferMin, maxTotalMinutes }) {
  const requiredArrivalDate = new Date(startDate.getTime() - arrivalBufferMin * 60000);

  // Live data can come back with a definitive "no" (see journeyProvider.js) -
  // that's authoritative and skips the heuristic date math entirely, rather
  // than letting it silently re-derive a wrong "reachable" from stale numbers.
  if (journey.definitivelyUnreachable) {
    return { requiredArrivalDate, departureDate: requiredArrivalDate, reachable: false };
  }

  const departureDate = new Date(requiredArrivalDate.getTime() - journey.totalMinutes * 60000);
  const departureHour = departureDate.getHours() + departureDate.getMinutes() / 60;
  const sameDay = departureDate.toDateString() === startDate.toDateString();
  const reachable =
    sameDay && departureHour >= EARLIEST_PLAUSIBLE_DEPARTURE_HOUR && journey.totalMinutes <= maxTotalMinutes;
  return { requiredArrivalDate, departureDate, reachable };
}

/** True if `event` appears in a parkrunner's completed-events data (see parkrunAthleteSource.js). */
function isEventDone(event, completed) {
  if (completed.slugs.has(event.id)) return true;
  const bareName = event.name.replace(/\s*parkrun$/i, "").trim().toLowerCase();
  return completed.names.has(bareName);
}

const app = express();
app.use(express.static(path.join(__dirname, "..", "public")));

function parseLatLon(req, res) {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    res.status(400).json({ error: "lat and lon query params are required numbers" });
    return null;
  }
  return { lat, lon };
}

app.get("/api/stations", async (req, res) => {
  const { data, source, fetchedAt } = await fetchStations();
  res.json({ source, fetchedAt, count: data.length, stations: data });
});

app.get("/api/parkruns", async (req, res) => {
  const { data, source, fetchedAt } = await fetchParkruns();
  res.json({ source, fetchedAt, count: data.length, events: data });
});

app.get("/api/nearest-stations", async (req, res) => {
  const point = parseLatLon(req, res);
  if (!point) return;
  const limit = Math.min(50, Number(req.query.limit) || 10);

  const { data: stations, source } = await fetchStations();
  const results = nearest(point, stations, limit);
  res.json({ source, stations: results });
});

app.get("/api/reachable", async (req, res) => {
  const userLocation = parseLatLon(req, res);
  if (!userLocation) return;

  const arrivalBufferMin = Number(req.query.arrivalBufferMin) || DEFAULT_ARRIVAL_BUFFER_MIN;
  const maxTotalMinutes = Number(req.query.maxTotalMinutes) || DEFAULT_MAX_TOTAL_MINUTES;

  const [{ data: stations, source: stationsSource }, { data: allEvents, source: eventsSource }, completed] =
    await Promise.all([
      fetchStations(),
      fetchParkruns(),
      req.query.athleteId ? fetchCompletedEvents(req.query.athleteId) : Promise.resolve(null),
    ]);

  const athleteFilterRequested = Boolean(req.query.athleteId);
  const athleteFilterApplied = athleteFilterRequested && completed !== null;
  const events = athleteFilterApplied ? allEvents.filter((e) => !isEventDone(e, completed)) : allEvents;

  if (stations.length === 0 || events.length === 0) {
    return res.status(503).json({ error: "No station or parkrun data available" });
  }

  let originStation;
  if (req.query.stationId) {
    originStation = stations.find((s) => String(s.id) === String(req.query.stationId));
    if (!originStation) {
      return res.status(400).json({ error: `Unknown stationId: ${req.query.stationId}` });
    }
  } else {
    originStation = nearest(userLocation, stations, 1)[0];
  }

  // Phase 1: cheap heuristic pass over every GB event, to shortlist candidates.
  const heuristicResults = events.map((event) => {
    const destStation = nearest(event, stations, 1)[0];
    const journey = estimateJourney({ userLocation, originStation, destStation, parkrunLocation: event });
    const startTime = defaultStartTime(event);
    const startDate = nextSaturdayAt(startTime);
    const { departureDate, reachable } = recomputeReachability({
      journey, startDate, arrivalBufferMin, maxTotalMinutes,
    });

    return {
      id: event.id,
      name: event.name,
      lat: event.lat,
      lon: event.lon,
      url: event.url,
      startTime,
      startDate,
      destStation,
      journey: { ...journey, source: "estimated" },
      requiredDepartureTime: departureDate,
      reachable,
      mapsUrl: `https://www.google.com/maps/dir/?api=1&origin=${userLocation.lat},${userLocation.lon}&destination=${event.lat},${event.lon}&travelmode=transit`,
    };
  });

  let shortlisted = heuristicResults
    .filter((r) => r.reachable)
    .sort((a, b) => a.journey.totalMinutes - b.journey.totalMinutes);

  // Phase 2: for the most promising candidates, replace the heuristic with a
  // real Google Directions (transit) lookup, if configured (see
  // googleDirectionsClient.js). Directions routes point-to-point (home to
  // the parkrun itself), not via our guessed station pair, so it can - and
  // sometimes will - pick a different, better real-world station.
  if (googleDirections.isConfigured()) {
    const candidates = shortlisted.slice(0, LIVE_REFINE_LIMIT);
    await mapWithConcurrency(candidates, LIVE_REFINE_CONCURRENCY, async (r) => {
      const startDate = new Date(r.startDate);
      const requiredArrivalAtParkrun = new Date(startDate.getTime() - arrivalBufferMin * 60000);
      const refined = await planJourney({
        userLocation,
        originStation,
        destStation: r.destStation,
        parkrunLocation: { lat: r.lat, lon: r.lon },
        requiredArrivalDate: requiredArrivalAtParkrun,
      });
      const { departureDate, reachable } = recomputeReachability({
        journey: refined, startDate, arrivalBufferMin, maxTotalMinutes,
      });
      r.journey = refined;
      r.requiredDepartureTime = departureDate;
      r.reachable = reachable;
    });
    shortlisted = shortlisted.filter((r) => r.reachable).sort((a, b) => a.journey.totalMinutes - b.journey.totalMinutes);
  }

  const reachableResults = shortlisted.map((r, index) => {
    // Live results route point-to-point and may use a different station
    // than our heuristic guess - show the one Directions actually picked.
    const liveStationName = r.journey.viaStationName;
    const liveStationLocation = r.journey.viaStationLocation;
    return {
      id: r.id,
      name: r.name,
      lat: r.lat,
      lon: r.lon,
      url: r.url,
      startTime: r.startTime,
      startDate: r.startDate.toISOString(),
      destStation: {
        id: r.destStation.id,
        name: liveStationName || r.destStation.name,
        lat: liveStationLocation ? liveStationLocation.lat : r.destStation.lat,
        lon: liveStationLocation ? liveStationLocation.lon : r.destStation.lon,
        walkFromStationMin: r.journey.walkFromStationMin,
      },
      journey: r.journey,
      requiredDepartureTime: r.requiredDepartureTime.toISOString(),
      reachable: r.reachable,
      mapsUrl: r.mapsUrl,
      // The Nearest Event Not Done Yet - the top result, once already
      // filtered to events this parkrunner hasn't done and sorted by ease.
      nendy: athleteFilterApplied && index === 0,
    };
  });

  res.json({
    stationsSource,
    eventsSource,
    liveTimetableConfigured: googleDirections.isConfigured(),
    athleteFilter: {
      requested: athleteFilterRequested,
      applied: athleteFilterApplied,
      completedCount: athleteFilterApplied ? completed.completedCount : undefined,
      note: athleteFilterRequested && !athleteFilterApplied
        ? "Couldn't load results for that parkrun ID (private profile, invalid ID, or parkrun.org.uk unreachable) - showing all events."
        : undefined,
    },
    originStation: {
      id: originStation.id,
      name: originStation.name,
      lat: originStation.lat,
      lon: originStation.lon,
    },
    arrivalBufferMin,
    disclaimer: googleDirections.isConfigured()
      ? "Where marked \"Live\", times come from Google's real-time transit directions; everything else is an ESTIMATE based on straight-line distance. A \"needs a bus\" note means the live route isn't pure train. Always double-check before travelling."
      : "Journey times are ESTIMATES based on straight-line distance, not a live timetable. Always double-check with the linked Google Maps transit directions before travelling.",
    count: reachableResults.length,
    results: reachableResults,
  });
});

app.listen(PORT, () => {
  console.log(`parkrun-by-train listening on http://localhost:${PORT}`);
});
