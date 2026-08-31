// parkrun's events.json does not carry each event's start time, and it does
// vary by nation. These are the standard defaults - Scotland and Northern
// Ireland start half an hour later than England and Wales - but a handful of
// individual events differ, so treat this as a strong default, not a fact
// about any one specific parkrun.
const START_TIME_ENGLAND_WALES = "09:00";
const START_TIME_SCOTLAND_NI = "09:30";

/** Very approximate GB nation classifier from lat/lon, used only to pick a default start time. */
function classifyNation({ lat, lon }) {
  const looksLikeNorthernIreland = lon < -5.3 && lat > 54.0 && lat < 55.6;
  if (looksLikeNorthernIreland) return "northern-ireland";
  if (lat >= 55.3) return "scotland";
  return "england-wales";
}

function defaultStartTime(location) {
  const nation = classifyNation(location);
  return nation === "england-wales" ? START_TIME_ENGLAND_WALES : START_TIME_SCOTLAND_NI;
}

/**
 * UTC offset (in minutes) that Europe/London is at for a given instant,
 * i.e. 0 in winter (GMT) and 60 during British Summer Time.
 */
function londonOffsetMinutes(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/London",
    timeZoneName: "longOffset",
  }).formatToParts(date);
  const tzName = parts.find((p) => p.type === "timeZoneName")?.value || "GMT+00:00";
  const match = tzName.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

/** Converts a UK wall-clock "HH:MM" on a given Y/M/D (Europe/London, DST-aware) to a UTC Date. */
function londonWallTimeToUtc(year, month, day, hh, mm) {
  const guessUtc = new Date(Date.UTC(year, month, day, hh, mm));
  const offsetMin = londonOffsetMinutes(guessUtc);
  return new Date(guessUtc.getTime() - offsetMin * 60000);
}

/**
 * The next Saturday (in UK local terms) at the given "HH:MM" UK wall-clock
 * time, correctly accounting for GMT/BST. `from` should be a UTC instant.
 */
function nextSaturdayAt(hhmm, from = new Date()) {
  const [h, m] = hhmm.split(":").map(Number);

  // Work out "today" in UK calendar terms, independent of server timezone.
  const londonParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(from);
  const get = (type) => londonParts.find((p) => p.type === type).value;
  const year = Number(get("year"));
  const month = Number(get("month")) - 1;
  const day = Number(get("day"));
  const weekdayIdx = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));

  let daysUntilSaturday = (6 - weekdayIdx + 7) % 7;
  const candidate = londonWallTimeToUtc(year, month, day + daysUntilSaturday, h, m);
  if (daysUntilSaturday === 0 && candidate.getTime() <= from.getTime()) {
    daysUntilSaturday = 7;
    return londonWallTimeToUtc(year, month, day + daysUntilSaturday, h, m);
  }
  return candidate;
}

module.exports = { defaultStartTime, classifyNation, nextSaturdayAt };
