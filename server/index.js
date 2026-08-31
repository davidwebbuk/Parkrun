const path = require("path");
const express = require("express");

const { fetchParkruns } = require("./lib/parkrunSource");
const { fetchStations } = require("./lib/stationSource");
const { nearest } = require("./lib/geo");
const { estimateJourney } = require("./lib/journeyEstimate");
const { defaultStartTime, nextSaturdayAt } = require("./lib/parkrunTiming");

const PORT = process.env.PORT || 3000;
const EARLIEST_PLAUSIBLE_DEPARTURE_HOUR = 5.5; // 05:30 - before this, assume no usable train exists
const DEFAULT_ARRIVAL_BUFFER_MIN = 10; // arrive this many minutes before the start
const DEFAULT_MAX_TOTAL_MINUTES = 240; // don't bother suggesting 4h+ door-to-door trips

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

  const results = events.map((event) => {
    const destStation = nearest(event, stations, 1)[0];
    const journey = estimateJourney({
      userLocation,
      originStation,
      destStation,
      parkrunLocation: event,
    });

    const startTime = defaultStartTime(event);
    const startDate = nextSaturdayAt(startTime);
    const requiredArrivalDate = new Date(startDate.getTime() - arrivalBufferMin * 60000);
    const departureDate = new Date(requiredArrivalDate.getTime() - journey.totalMinutes * 60000);

    const departureHour = departureDate.getHours() + departureDate.getMinutes() / 60;
    const sameDay = departureDate.toDateString() === startDate.toDateString();
    const reachable =
      sameDay && departureHour >= EARLIEST_PLAUSIBLE_DEPARTURE_HOUR && journey.totalMinutes <= maxTotalMinutes;

    return {
      id: event.id,
      name: event.name,
      lat: event.lat,
      lon: event.lon,
      url: event.url,
      startTime,
      startDate: startDate.toISOString(),
      destStation: {
        id: destStation.id,
        name: destStation.name,
        lat: destStation.lat,
        lon: destStation.lon,
        walkFromStationMin: journey.walkFromStationMin,
      },
      journey,
      requiredDepartureTime: departureDate.toISOString(),
      reachable,
      mapsUrl: `https://www.google.com/maps/dir/?api=1&origin=${userLocation.lat},${userLocation.lon}&destination=${event.lat},${event.lon}&travelmode=transit`,
    };
  });

  const reachableResults = results
    .filter((r) => r.reachable)
    .sort((a, b) => a.journey.totalMinutes - b.journey.totalMinutes);

  res.json({
    stationsSource,
    eventsSource,
    originStation: {
      id: originStation.id,
      name: originStation.name,
      lat: originStation.lat,
      lon: originStation.lon,
    },
    arrivalBufferMin,
    disclaimer:
      "Journey times are ESTIMATES based on straight-line distance, not a live timetable. Always double-check with the linked Google Maps transit directions before travelling.",
    count: reachableResults.length,
    results: reachableResults,
  });
});

app.listen(PORT, () => {
  console.log(`parkrun-by-train listening on http://localhost:${PORT}`);
});
