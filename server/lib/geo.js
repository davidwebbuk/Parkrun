const EARTH_RADIUS_KM = 6371;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance in km between two {lat, lon} points. */
function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Returns the `limit` closest items to `point`, each annotated with
 * `distanceKm`. `items` must each have numeric `lat`/`lon` fields.
 */
function nearest(point, items, limit = 10) {
  return items
    .map((item) => ({ ...item, distanceKm: haversineKm(point, item) }))
    .sort((x, y) => x.distanceKm - y.distanceKm)
    .slice(0, limit);
}

module.exports = { haversineKm, nearest };
