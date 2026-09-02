// cheerio is required lazily inside parseResultsTable() below, not here at
// module load - it pulls in a fairly large dependency tree (parse5,
// htmlparser2, css-select, ...), and on constrained shared hosting that
// disk read happens on every cold process start whether or not a request
// actually ends up using it. Loading it only when a parkrun.org.uk fetch
// has actually succeeded means requests that don't filter by athlete (or
// where the fetch fails, as it currently does from some hosts - see
// README "Data-source notes") never pay that cost at all.

// Fetches a parkrunner's full results history from their public profile page
// on parkrun.org.uk, to find which events they've already done. This is the
// same public page andydavidson/parkrun-mcp scrapes (an existing open-source
// project doing the same job) - URL pattern and parsing approach cross-
// checked against its source, but not tested against a live page from this
// sandbox (no outbound access to parkrun.org.uk here - see README).
//
// Results history is public by default; a parkrunner can opt out in their
// privacy settings, in which case this page won't show the results table -
// handled as "couldn't load results", not an error, so the app just shows
// everything unfiltered rather than breaking.

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const CACHE_TTL_MS = 60 * 60 * 1000; // an hour - personal data, don't cache too long

const cache = new Map(); // athleteId -> { slugs: Set, names: Set, fetchedAt }

function profileUrl(athleteId) {
  return `https://www.parkrun.org.uk/parkrunner/${encodeURIComponent(athleteId)}/all/`;
}

/** Accepts "A1234567", "a1234567" or "1234567" and returns the bare numeric ID the URL expects. */
function normalizeAthleteId(input) {
  const trimmed = String(input || "").trim();
  return trimmed.replace(/^a/i, "");
}

/** Best-effort event slug from an href like "/bushy/results/..." or "https://www.parkrun.org.uk/bushy/". */
function slugFromHref(href) {
  if (!href) return undefined;
  const match = href.match(/parkrun\.org\.uk\/([a-z0-9]+)\/?/i) || href.match(/^\/?([a-z0-9]+)\//i);
  return match ? match[1].toLowerCase() : undefined;
}

/** "29/08/2026" (UK format, as shown in the results table) -> "2026-08-29" (sortable), or undefined if unparseable. */
function parseUkDate(text) {
  const match = String(text || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return undefined;
  const [, d, m, y] = match;
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

// Extraction of the parkrunner's display name, for the "spell your name"
// letter challenge. The <title> tag is generic ("results | parkrun UK") and
// carries no name - confirmed against a real profile page. The actual name
// lives in a heading near the top, e.g.:
//   <h2>David WEBB&nbsp;<span title="parkrun ID">(A140237)</span></h2>
// (first name normal case, surname in ALL CAPS). Since we already know the
// exact athlete ID we asked for, anchor on that: find the heading that
// contains a "(<athleteId>)"-shaped span, strip the span out, and what's
// left of the heading's text is the name. Returns undefined rather than
// guessing wrong, since a bad name would produce a bogus, confusing
// challenge.
function extractAthleteName($, athleteId) {
  const idDigits = String(athleteId).replace(/^0+/, "") || "0";
  const idPattern = new RegExp(`^A?0*${idDigits}$`, "i");

  let nameText;
  $("h1, h2, h3").each((_, el) => {
    if (nameText) return;
    const $el = $(el);
    const hasIdSpan = $el
      .find("span")
      .filter((_, span) => idPattern.test($(span).text().replace(/[()]/g, "").trim())).length > 0;
    if (!hasIdSpan) return;
    const clone = $el.clone();
    clone.find("span").remove();
    const text = clone.text().replace(/ /g, " ").replace(/\s+/g, " ").trim();
    if (text) nameText = text;
  });

  if (!nameText) return undefined;

  // Require at least two words (real display names are essentially always
  // "First Last") and that it still looks name-shaped, not stray markup.
  const wordShaped = /^[A-Za-z][A-Za-z'’.\-]*$/;
  const words = nameText.split(" ").filter(Boolean);
  if (words.length < 2 || nameText.length > 60 || !words.every((w) => wordShaped.test(w))) return undefined;

  // Normalize an ALL-CAPS surname (e.g. "WEBB", "DANDEH-NJIE") to Title
  // Case per hyphen-separated part; leave already-mixed-case words (e.g.
  // "David", "McDonald") alone.
  const titleCase = (w) => (w.length > 1 ? w[0] + w.slice(1).toLowerCase() : w);
  return words
    .map((w) =>
      w === w.toUpperCase() ? w.split("-").map(titleCase).join("-") : w
    )
    .join(" ");
}

function parseResultsTable(html, athleteId) {
  const cheerio = require("cheerio");
  const $ = cheerio.load(html);

  const table = $("caption")
    .filter((_, el) => /all/i.test($(el).text()) && /result/i.test($(el).text()))
    .first()
    .closest("table");

  if (table.length === 0) {
    return null; // no results table found - likely a private profile or unrecognized page
  }

  const headers = table
    .find("tr")
    .first()
    .find("th")
    .map((_, el) => $(el).text().trim())
    .get();
  const eventColIdx = headers.findIndex((h) => /^event$/i.test(h));

  const slugs = new Set();
  const names = new Set();
  const uniqueEvents = new Set(); // slug or name, whichever identified the row - for a de-duplicated count
  const completedEventsByKey = new Map(); // slug||name -> { slug, name, date: earliest completion, sortable }

  table
    .find("tr")
    .slice(1)
    .each((_, row) => {
      const cells = $(row).find("td");
      if (cells.length === 0) return;
      const eventCell = eventColIdx >= 0 ? cells.eq(eventColIdx) : cells.eq(0);
      const href = eventCell.find("a").attr("href");
      const slug = slugFromHref(href);
      const rawName = eventCell.text().trim();
      const name = rawName.toLowerCase();
      if (slug) slugs.add(slug);
      if (name) names.add(name);
      const key = slug || name;
      if (!key) return;
      uniqueEvents.add(key);

      // Track the earliest date this venue was completed - the Namely-style
      // name challenge (see letterChallenges.js) needs a "first done" date
      // per distinct venue to assign repeated letters to separate visits.
      const date = parseUkDate($(row).find(".format-date").first().text());
      const existing = completedEventsByKey.get(key);
      if (!existing || (date && (!existing.date || date < existing.date))) {
        completedEventsByKey.set(key, { slug, name: rawName, date: date || existing?.date });
      }
    });

  return {
    slugs,
    names,
    completedCount: uniqueEvents.size,
    athleteName: extractAthleteName($, athleteId),
    completedEvents: [...completedEventsByKey.values()],
  };
}

/**
 * Returns { slugs, names, completedCount, athleteName, completedEvents }
 * for this parkrunner: slugs/names of events completed (slugs preferred
 * for matching; names as a fallback for events whose row didn't have a
 * parseable link), a best-effort display name (undefined if it couldn't be
 * confidently extracted - see extractAthleteName), and completedEvents (one
 * entry per distinct venue - { slug, name, date } - date is the earliest
 * completion, "YYYY-MM-DD" or undefined if unparseable; used by the
 * Namely-style name challenge in letterChallenges.js). Returns null if the
 * results couldn't be loaded at all (private profile, invalid ID, fetch
 * failure) - callers should treat null as "don't filter" rather than an
 * error.
 */
async function fetchCompletedEvents(athleteIdRaw) {
  const athleteId = normalizeAthleteId(athleteIdRaw);
  if (!/^\d+$/.test(athleteId)) return null;

  const cached = cache.get(athleteId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data;

  try {
    const res = await fetch(profileUrl(athleteId), {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const data = parseResultsTable(html, athleteId);
    cache.set(athleteId, { data, fetchedAt: Date.now() });
    return data;
  } catch (err) {
    console.error(`[parkrunAthleteSource] failed to load results for athlete ${athleteId}:`, err.message);
    return null;
  }
}

module.exports = { fetchCompletedEvents, normalizeAthleteId };
