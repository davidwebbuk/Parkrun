const fs = require("fs");
const path = require("path");
const { parseCsv } = require("./csv");

// NaPTAN (National Public Transport Access Nodes) is DfT's open-data register
// of every public transport access point in GB, including rail stations.
// StopTypes=RLY filters the ~2,500 heavy-rail station entries out of the
// much larger full dataset. Published under the Open Government Licence.
const STATIONS_URL =
  "https://naptan.api.dft.gov.uk/v1/access-nodes?dataFormat=csv&StopTypes=RLY";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // stations don't open/close often
const FALLBACK_PATH = path.join(__dirname, "..", "..", "data", "fallback-stations.json");

let cache = { data: null, fetchedAt: 0, source: null };

const NAME_KEYS = ["CommonName", "CommonNameLang1", "StopName", "Name"];
const LAT_KEYS = ["Latitude", "Lat"];
const LON_KEYS = ["Longitude", "Lon", "Long"];
const ATCO_KEYS = ["ATCOCode", "AtcoCode", "ATCO_Code"];
// NaPTAN is a general public-transport dataset, not rail-specific, so a CRS
// (National Rail's 3-letter station code) column is NOT confirmed present -
// these are best-guess candidates, unverified against a live fetch. Without
// a resolved CRS, a station can still be used for distance/heuristic
// purposes but not for a live OJP RealtimeJourneyPlan call (see
// ojpClient.js), which addresses stations by CRS code.
const CRS_KEYS = ["CrsRef", "CrsCode", "StationCRS", "Crs"];

function firstColumn(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== "") return row[key];
  }
  return undefined;
}

function normalizeCsvRows(rows) {
  const stations = [];
  for (const row of rows) {
    const name = firstColumn(row, NAME_KEYS);
    const latRaw = firstColumn(row, LAT_KEYS);
    const lonRaw = firstColumn(row, LON_KEYS);
    if (!name || latRaw === undefined || lonRaw === undefined) continue;

    const lat = Number(latRaw);
    const lon = Number(lonRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    stations.push({
      id: firstColumn(row, ATCO_KEYS) || name,
      name,
      lat,
      lon,
      crs: firstColumn(row, CRS_KEYS),
    });
  }

  if (stations.length === 0) {
    throw new Error("Parsed 0 rail stations from NaPTAN CSV - column names probably changed");
  }
  return stations;
}

function loadFallback() {
  const raw = JSON.parse(fs.readFileSync(FALLBACK_PATH, "utf8"));
  return raw.stations.map((s, idx) => ({ id: `fallback-${idx}`, ...s, isFallback: true }));
}

async function fetchStations({ forceRefresh = false } = {}) {
  const isFresh = cache.data && Date.now() - cache.fetchedAt < CACHE_TTL_MS;
  if (isFresh && !forceRefresh) return cache;

  try {
    const res = await fetch(STATIONS_URL, { headers: { accept: "text/csv" } });
    if (!res.ok) throw new Error(`NaPTAN fetch failed: HTTP ${res.status}`);
    const text = await res.text();
    const rows = parseCsv(text);
    const stations = normalizeCsvRows(rows);
    cache = { data: stations, fetchedAt: Date.now(), source: "live" };
  } catch (err) {
    console.error("[stationSource] live fetch failed, using bundled fallback data:", err.message);
    cache = { data: loadFallback(), fetchedAt: Date.now(), source: "fallback" };
  }
  return cache;
}

module.exports = { fetchStations };
