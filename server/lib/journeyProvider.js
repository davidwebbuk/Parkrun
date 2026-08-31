const ojpClient = require("./ojpClient");
const { estimateJourney } = require("./journeyEstimate");

/**
 * Tries a live OJP RealtimeJourneyPlan lookup between two stations, and
 * folds the best matching journey into the same shape estimateJourney()
 * produces, so callers don't need to branch on source. Falls back to the
 * heuristic (source: "estimated") whenever OJP isn't configured, either
 * station lacks a known CRS code, or the live call fails for any reason.
 *
 * `requiredArrivalDate` is when the traveller needs to be at destStation
 * (i.e. journey.walkFromStationMin before the actual event start).
 */
async function planJourney({ userLocation, originStation, destStation, parkrunLocation, requiredArrivalDate }) {
  const heuristic = estimateJourney({ userLocation, originStation, destStation, parkrunLocation });

  if (!ojpClient.isConfigured() || !originStation.crs || !destStation.crs) {
    return { ...heuristic, source: "estimated" };
  }

  try {
    // Search from a generous window before the deadline so we see several
    // options and can pick the latest one that still arrives in time.
    const searchFrom = new Date(requiredArrivalDate.getTime() - heuristic.totalMinutes * 2 * 60000);
    const journeys = await ojpClient.realtimeJourneyPlan({
      originCRS: originStation.crs,
      destinationCRS: destStation.crs,
      departBy: searchFrom,
    });

    const walkFromStationMin = heuristic.walkFromStationMin;
    const walkToStationMin = heuristic.walkToStationMin;

    const viable = journeys
      .map((j) => {
        const arrival = new Date(j.realtimeArrival || j.scheduledArrival);
        return { journey: j, arrival };
      })
      .filter(({ arrival }) => {
        const arriveAtParkrunBy = new Date(arrival.getTime() + walkFromStationMin * 60000);
        return arriveAtParkrunBy.getTime() <= requiredArrivalDate.getTime();
      })
      .sort((a, b) => b.arrival.getTime() - a.arrival.getTime()); // latest viable departure first

    if (viable.length === 0) {
      return { ...heuristic, source: "estimated" };
    }

    const best = viable[0].journey;
    const departure = new Date(best.realtimeDeparture || best.scheduledDeparture);
    const arrival = new Date(best.realtimeArrival || best.scheduledArrival);
    const railMinutes = Math.round((arrival.getTime() - departure.getTime()) / 60000);

    return {
      totalMinutes: walkToStationMin + railMinutes + walkFromStationMin + heuristic.stationBufferMin,
      walkToStationMin,
      walkFromStationMin,
      railMinutes,
      railDistanceKm: heuristic.railDistanceKm,
      estimatedInterchanges: best.interchanges,
      stationBufferMin: heuristic.stationBufferMin,
      source: "live",
      liveDeparture: departure.toISOString(),
      liveArrival: arrival.toISOString(),
      realtimeClassification: best.realtimeClassification,
      operators: [...new Set(best.legs.map((l) => l.operator).filter(Boolean))],
    };
  } catch (err) {
    console.error(`[journeyProvider] live OJP lookup failed (${originStation.crs}->${destStation.crs}), falling back to estimate:`, err.message);
    return { ...heuristic, source: "estimated" };
  }
}

module.exports = { planJourney };
