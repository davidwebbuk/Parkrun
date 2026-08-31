const fs = require("fs");
const path = require("path");

const EVENTS_URL = "https://images.parkrun.com/events.json";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours - events.json is fairly static
const FALLBACK_PATH = path.join(__dirname, "..", "..", "data", "fallback-parkruns.json");

let cache = { data: null, fetchedAt: 0, source: null };

/**
 * parkrun publishes events.json as a GeoJSON-ish document:
 *   { events: { features: [...] }, countries: { "<id>": { url, title, ... } } }
 * Each feature's `properties` carries the event slug/name and a numeric
 * countrycode that indexes into `countries`. Field names have shifted
 * slightly over the years, so we probe a few likely candidates rather than
 * assuming one exact shape.
 */
function firstDefined(obj, keys) {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null && obj[key] !== "") {
      return obj[key];
    }
  }
  return undefined;
}

function normalizeRawEvents(raw) {
  const features = raw?.events?.features;
  if (!Array.isArray(features)) {
    throw new Error("Unexpected parkrun events.json shape: events.features is not an array");
  }
  const countries = raw.countries || {};

  const gbCountryIds = Object.entries(countries)
    .filter(([, c]) => {
      const url = String(c?.url || "").toLowerCase();
      const title = String(c?.title || c?.name || "").toLowerCase();
      return url.includes("parkrun.org.uk") || title === "united kingdom" || title === "uk";
    })
    .map(([id]) => String(id));

  const events = [];
  for (const feature of features) {
    const props = feature.properties || {};
    const coords = feature.geometry && feature.geometry.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;

    const countryId = String(
      firstDefined(props, ["countrycode", "countryCode", "country"]) ?? ""
    );
    if (gbCountryIds.length > 0 && !gbCountryIds.includes(countryId)) continue;

    // seriesid 1 = standard Saturday 5k parkrun. Junior parkrun (2k, Sundays,
    // different start times) uses a different seriesid and would otherwise
    // get mixed in here with the wrong start-time assumptions applied to it.
    const seriesId = firstDefined(props, ["seriesid", "seriesId", "series"]);
    if (seriesId !== undefined && Number(seriesId) !== 1) continue;

    const slug = firstDefined(props, ["eventname", "EventShortName", "eventShortName", "slug"]);
    const longName = firstDefined(props, [
      "EventLongName",
      "eventLongName",
      "EventShortName",
      "name",
    ]);
    if (!slug && !longName) continue;

    const [lon, lat] = coords; // GeoJSON order is [lon, lat]
    if (typeof lat !== "number" || typeof lon !== "number") continue;

    const country = countries[countryId];
    const baseUrl = country && country.url ? String(country.url).replace(/\/$/, "") : "https://www.parkrun.org.uk";

    events.push({
      id: slug || longName,
      name: longName || slug,
      lat,
      lon,
      countryId,
      url: slug ? `${baseUrl}/${slug}/` : undefined,
    });
  }

  if (events.length === 0) {
    throw new Error("Parsed 0 GB parkrun events from events.json - schema probably changed");
  }
  return events;
}

function loadFallback() {
  const raw = JSON.parse(fs.readFileSync(FALLBACK_PATH, "utf8"));
  return raw.events.map((e) => ({ ...e, isFallback: true }));
}

async function fetchParkruns({ forceRefresh = false } = {}) {
  const isFresh = cache.data && Date.now() - cache.fetchedAt < CACHE_TTL_MS;
  if (isFresh && !forceRefresh) return cache;

  try {
    const res = await fetch(EVENTS_URL, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`events.json fetch failed: HTTP ${res.status}`);
    const raw = await res.json();
    const events = normalizeRawEvents(raw);
    cache = { data: events, fetchedAt: Date.now(), source: "live" };
  } catch (err) {
    console.error("[parkrunSource] live fetch failed, using bundled fallback data:", err.message);
    cache = { data: loadFallback(), fetchedAt: Date.now(), source: "fallback" };
  }
  return cache;
}

module.exports = { fetchParkruns };
