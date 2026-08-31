// Google Directions API (transit mode) - self-serve alternative to National
// Rail's RTJP/OJP, which turned out to require a formal paid contract with
// RDG rather than a simple API key (see README "Adding real timetables").
//
// Directions takes raw lat/lon for origin and destination, so it sidesteps
// the CRS-code gap in the NaPTAN station data entirely, and its response
// tells us the actual vehicle type per transit leg (HEAVY_RAIL, BUS, ...) -
// exactly what's needed to stop the heuristic from claiming a bus-only
// route is a train journey.
//
// Requires GOOGLE_MAPS_API_KEY (a Google Cloud project with the Directions
// API enabled and billing set up - see .env.example).

const DIRECTIONS_URL = "https://maps.googleapis.com/maps/api/directions/json";

// Vehicle types the Directions API can return for a transit step. Anything
// not in this set (BUS, SUBWAY, TRAM, FERRY, ...) means the route isn't
// purely train.
const RAIL_VEHICLE_TYPES = new Set([
  "HEAVY_RAIL",
  "RAIL",
  "COMMUTER_TRAIN",
  "HIGH_SPEED_TRAIN",
  "LONG_DISTANCE_TRAIN",
  "METRO_RAIL",
]);

function isConfigured() {
  return Boolean(process.env.GOOGLE_MAPS_API_KEY);
}

function normalizeRoute(route) {
  const leg = route.legs[0];
  const steps = leg.steps.map((step) => {
    if (step.travel_mode !== "TRANSIT") {
      return { mode: step.travel_mode, durationSec: step.duration.value };
    }
    const td = step.transit_details;
    return {
      mode: "TRANSIT",
      vehicleType: td.line.vehicle.type,
      lineName: td.line.short_name || td.line.name,
      departureStop: td.departure_stop.name,
      departureLocation: td.departure_stop.location,
      arrivalStop: td.arrival_stop.name,
      arrivalLocation: td.arrival_stop.location,
      departureTime: td.departure_time.value, // unix seconds
      arrivalTime: td.arrival_time.value,
      durationSec: step.duration.value,
    };
  });

  const transitSteps = steps.filter((s) => s.mode === "TRANSIT");
  const nonRailVehicleTypes = [...new Set(
    transitSteps.map((s) => s.vehicleType).filter((t) => !RAIL_VEHICLE_TYPES.has(t))
  )];

  return {
    durationMin: Math.round(leg.duration.value / 60),
    departureTime: leg.departure_time?.value,
    arrivalTime: leg.arrival_time?.value,
    transitSteps,
    interchanges: Math.max(0, transitSteps.length - 1),
    usesNonRailTransit: nonRailVehicleTypes.length > 0,
    nonRailSummary: nonRailVehicleTypes.length > 0 ? summarizeVehicleTypes(nonRailVehicleTypes) : undefined,
    firstStation: transitSteps[0]?.departureStop,
    firstStationLocation: transitSteps[0]?.departureLocation,
    lastStation: transitSteps[transitSteps.length - 1]?.arrivalStop,
  };
}

// Friendly labels for Google's transit vehicle types (see
// https://developers.google.com/maps/documentation/directions/get-directions#VehicleType).
// Used to describe what a live route actually needs beyond a plain train,
// e.g. "Needs: Underground" rather than a blanket, sometimes-wrong "bus".
const VEHICLE_TYPE_LABELS = {
  BUS: "bus",
  INTERCITY_BUS: "coach",
  TROLLEYBUS: "bus",
  SHARE_TAXI: "shared taxi",
  SUBWAY: "Underground",
  TRAM: "tram",
  MONORAIL: "monorail",
  FERRY: "ferry",
  CABLE_CAR: "cable car",
  GONDOLA_LIFT: "cable car",
  FUNICULAR: "funicular",
  OTHER: "other transport",
};

function summarizeVehicleTypes(types) {
  return types.map((t) => VEHICLE_TYPE_LABELS[t] || t.toLowerCase().replace(/_/g, " ")).join(" + ");
}

/**
 * Real transit directions between two {lat, lon} points, arriving by
 * `arrivalTime` (a Date). Returns a list of route options (usually one or a
 * couple of alternatives), normalized with per-leg vehicle type info.
 * Throws (with `.zeroResults = true` for a clean "no route exists" case) on
 * any failure - callers should catch and decide how to handle it.
 */
async function transitDirections({ origin, destination, arrivalTime, preferTrain = true }) {
  if (!isConfigured()) {
    throw new Error("Google Directions not configured: set GOOGLE_MAPS_API_KEY");
  }

  const params = new URLSearchParams({
    origin: `${origin.lat},${origin.lon}`,
    destination: `${destination.lat},${destination.lon}`,
    mode: "transit",
    arrival_time: String(Math.floor(arrivalTime.getTime() / 1000)),
    key: process.env.GOOGLE_MAPS_API_KEY,
  });
  if (preferTrain) params.set("transit_mode", "train");

  const res = await fetch(`${DIRECTIONS_URL}?${params.toString()}`);
  const body = await res.json();

  if (body.status === "ZERO_RESULTS") {
    const err = new Error("No transit route found");
    err.zeroResults = true;
    throw err;
  }
  if (body.status !== "OK") {
    throw new Error(`Google Directions error: ${body.status} ${body.error_message || ""}`);
  }

  return (body.routes || []).map(normalizeRoute);
}

module.exports = { isConfigured, transitDirections, RAIL_VEHICLE_TYPES };
