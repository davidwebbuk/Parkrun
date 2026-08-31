const { haversineKm } = require("./geo");

// ---------------------------------------------------------------------------
// There is no live UK rail timetable/journey-planner API wired up here (that
// needs a registered National Rail / RTT / Transport API token - see
// README.md "Adding real timetables"). Until then we approximate a rail
// journey between two stations from straight-line distance. This is a rough
// planning aid, NOT a real timetable - always sanity-check with the linked
// Google Maps transit directions before actually travelling.
// ---------------------------------------------------------------------------

const RAIL_ROUTE_FACTOR = 1.35; // tracks wiggle; real route is longer than straight-line distance
const AVERAGE_RAIL_SPEED_KMH = 60; // blended average incl. station stops
const STATION_ARRIVAL_BUFFER_MIN = 10; // time to find your platform / board
const WALK_SPEED_KMH = 4.5;

function walkMinutes(km) {
  return (km / WALK_SPEED_KMH) * 60;
}

/** One interchange added per ~50km of straight-line distance, capped at 3. */
function estimatedInterchanges(distanceKm) {
  return Math.min(3, Math.floor(distanceKm / 50));
}

/**
 * Rough one-way rail journey time in minutes between two {lat, lon} points,
 * including an allowance for changing trains and the average wait for a
 * connecting service.
 */
function estimateRailMinutes(origin, dest) {
  const distanceKm = haversineKm(origin, dest);
  const interchanges = estimatedInterchanges(distanceKm);
  const travelMinutes = (distanceKm * RAIL_ROUTE_FACTOR) / AVERAGE_RAIL_SPEED_KMH * 60;
  const interchangeMinutes = interchanges * 15; // change + average wait for connection
  return {
    minutes: Math.round(travelMinutes + interchangeMinutes),
    distanceKm: Math.round(distanceKm * 10) / 10,
    estimatedInterchanges: interchanges,
  };
}

/**
 * Full door-to-parkrun estimate: walk to origin station, ride the rail, walk
 * from destination station to the parkrun start.
 */
function estimateJourney({ userLocation, originStation, destStation, parkrunLocation }) {
  const walkToStationMin = walkMinutes(haversineKm(userLocation, originStation));
  const walkFromStationMin = walkMinutes(haversineKm(destStation, parkrunLocation));
  const rail = estimateRailMinutes(originStation, destStation);

  const totalMinutes = Math.round(
    walkToStationMin + STATION_ARRIVAL_BUFFER_MIN + rail.minutes + walkFromStationMin
  );

  return {
    totalMinutes,
    walkToStationMin: Math.round(walkToStationMin),
    walkFromStationMin: Math.round(walkFromStationMin),
    railMinutes: rail.minutes,
    railDistanceKm: rail.distanceKm,
    estimatedInterchanges: rail.estimatedInterchanges,
    stationBufferMin: STATION_ARRIVAL_BUFFER_MIN,
  };
}

module.exports = { estimateJourney, estimateRailMinutes, walkMinutes };
