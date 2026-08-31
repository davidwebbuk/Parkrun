const googleDirections = require("./googleDirectionsClient");
const { estimateJourney } = require("./journeyEstimate");

function unreachableResult(heuristic, reason) {
  return {
    ...heuristic,
    source: "live",
    definitivelyUnreachable: true,
    unreachableReason: reason,
  };
}

/**
 * Tries a live Google Directions (transit) lookup from the traveller's
 * actual location to the parkrun's actual location, and folds the best
 * route into the same shape estimateJourney() produces, so callers don't
 * need to branch on source. Falls back to the heuristic (source:
 * "estimated") whenever Directions isn't configured or the call fails for
 * an indeterminate reason (network error, quota, ...).
 *
 * Unlike the heuristic, this doesn't route via a specific station pair -
 * Directions picks the real best route itself, which may use a different
 * station than the heuristic guessed. When Directions confirms there's
 * genuinely no way to arrive in time (or no transit route at all), that's
 * authoritative and returned as `definitivelyUnreachable`, not papered over
 * with the heuristic's guess.
 */
async function planJourney({ userLocation, originStation, destStation, parkrunLocation, requiredArrivalDate }) {
  const heuristic = estimateJourney({ userLocation, originStation, destStation, parkrunLocation });

  if (!googleDirections.isConfigured()) {
    return { ...heuristic, source: "estimated" };
  }

  try {
    const routes = await googleDirections.transitDirections({
      origin: userLocation,
      destination: parkrunLocation,
      arrivalTime: requiredArrivalDate,
    });

    if (routes.length === 0) {
      return unreachableResult(heuristic, "No transit route found");
    }

    const best = routes[0];
    if (best.arrivalTime !== undefined && best.arrivalTime * 1000 > requiredArrivalDate.getTime()) {
      return unreachableResult(heuristic, "The best transit route available doesn't arrive in time");
    }

    return {
      totalMinutes: best.durationMin,
      walkToStationMin: heuristic.walkToStationMin,
      walkFromStationMin: heuristic.walkFromStationMin,
      railDistanceKm: heuristic.railDistanceKm,
      estimatedInterchanges: best.interchanges,
      stationBufferMin: 0,
      source: "live",
      liveDeparture: best.departureTime !== undefined ? new Date(best.departureTime * 1000).toISOString() : undefined,
      liveArrival: best.arrivalTime !== undefined ? new Date(best.arrivalTime * 1000).toISOString() : undefined,
      usesNonRailTransit: best.usesNonRailTransit,
      nonRailSummary: best.nonRailSummary,
      viaStationName: best.firstStation,
      viaStationLocation: best.firstStationLocation
        ? { lat: best.firstStationLocation.lat, lon: best.firstStationLocation.lng }
        : undefined,
    };
  } catch (err) {
    if (err.zeroResults) {
      return unreachableResult(heuristic, "No transit route found");
    }
    console.error("[journeyProvider] Google Directions lookup failed, falling back to estimate:", err.message);
    return { ...heuristic, source: "estimated" };
  }
}

module.exports = { planJourney };
