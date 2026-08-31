const path = require("path");
const express = require("express");

const { fetchParkruns } = require("./lib/parkrunSource");
const { fetchStations } = require("./lib/stationSource");
const { nearest } = require("./lib/geo");
const { estimateJourney } = require("./lib/journeyEstimate");
const { defaultStartTime, nextSaturdayAt } = require("./lib/parkrunTiming");
const ojpClient = require("./lib/ojpClient");
const { planJourney } = require("./lib/journeyProvider");

const PORT = process.env.PORT || 3000;
const EARLIEST_PLAUSIBLE_DEPARTURE_HOUR = 5.5; // 05:30 - before this, assume no usable train exists
const DEFAULT_ARRIVAL_BUFFER_MIN = 10; // arrive this many minutes before the start
const DEFAULT_MAX_TOTAL_MINUTES = 240; // don't bother suggesting 4h+ door-to-door trips
const LIVE_REFINE_LIMIT = 20; // only spend live OJP calls on this many top heuristic candidates
const LIVE_REFINE_CONCURRENCY = 6;

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
  const departureDate = new Date(requiredArrivalDate.getTime() - journey.totalMinutes * 60000);
  const departureHour = departureDate.getHours() + departureDate.getMinutes() / 60;
  const sameDay = departureDate.toDateString() === startDate.toDateString();
  const reachable =
    sameDay && departureHour >= EARLIEST_PLAUSIBLE_DEPARTURE_HOUR && journey.totalMinutes <= maxTotalMinutes;
  return { requiredArrivalDate, departureDate, reachable };
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

  const [{ data: stations, source: stationsSource }, { data: events, source: eventsSource }] =
    await Promise.all([fetchStations(), fetchParkruns()]);

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
  // real OJP RealtimeJourneyPlan lookup, if configured (see ojpClient.js).
  if (ojpClient.isConfigured()) {
    const candidates = shortlisted.slice(0, LIVE_REFINE_LIMIT);
    await mapWithConcurrency(candidates, LIVE_REFINE_CONCURRENCY, async (r) => {
      const startDate = new Date(r.startDate);
      const requiredArrivalAtStation = new Date(
        startDate.getTime() - arrivalBufferMin * 60000 - r.journey.walkFromStationMin * 60000
      );
      const refined = await planJourney({
        userLocation,
        originStation,
        destStation: r.destStation,
        parkrunLocation: { lat: r.lat, lon: r.lon },
        requiredArrivalDate: requiredArrivalAtStation,
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

  const reachableResults = shortlisted.map((r) => ({
    id: r.id,
    name: r.name,
    lat: r.lat,
    lon: r.lon,
    url: r.url,
    startTime: r.startTime,
    startDate: r.startDate.toISOString(),
    destStation: {
      id: r.destStation.id,
      name: r.destStation.name,
      lat: r.destStation.lat,
      lon: r.destStation.lon,
      walkFromStationMin: r.journey.walkFromStationMin,
    },
    journey: r.journey,
    requiredDepartureTime: r.requiredDepartureTime.toISOString(),
    reachable: r.reachable,
    mapsUrl: r.mapsUrl,
  }));

  res.json({
    stationsSource,
    eventsSource,
    liveTimetableConfigured: ojpClient.isConfigured(),
    originStation: {
      id: originStation.id,
      name: originStation.name,
      lat: originStation.lat,
      lon: originStation.lon,
    },
    arrivalBufferMin,
    disclaimer: ojpClient.isConfigured()
      ? "Where marked \"Live\", times come from National Rail's real-time journey planner; everything else is an ESTIMATE based on straight-line distance. Always double-check before travelling."
      : "Journey times are ESTIMATES based on straight-line distance, not a live timetable. Always double-check with the linked Google Maps transit directions before travelling.",
    count: reachableResults.length,
    results: reachableResults,
  });
});

app.listen(PORT, () => {
  console.log(`parkrun-by-train listening on http://localhost:${PORT}`);
});
