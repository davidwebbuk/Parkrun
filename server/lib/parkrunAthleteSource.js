const cheerio = require("cheerio");

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

// Best-effort extraction of the parkrunner's display name, for the "spell
// your name" letter challenge - unverified against a real page (same
// caveat as the rest of this file). Tries the <title> tag, stripping
// common parkrun-site boilerplate words/punctuation/parenthetical athlete
// numbers, and only accepts what's left if it still looks name-shaped.
// Returns undefined rather than guessing wrong, since a bad name would
// produce a bogus, confusing challenge.
function extractAthleteName($) {
  let title = $("title").first().text() || "";
  title = title
    .replace(/\(.*?\)/g, " ") // parenthetical athlete numbers etc.
    .replace(/\b(parkrun|parkrunner|results?|profile|athlete|history|all|uk)\b/gi, " ")
    .replace(/[|:\-–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Require at least two words (real display names are essentially always
  // "First Last") - a single leftover word after stripping boilerplate
  // (e.g. a stray "UK") is more likely noise than an actual name.
  const wordShaped = /^[A-Za-z][A-Za-z'’.\-]*$/;
  const words = title.split(" ").filter(Boolean);
  return words.length >= 2 && title.length <= 40 && words.every((w) => wordShaped.test(w)) ? title : undefined;
}

function parseResultsTable(html) {
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

  table
    .find("tr")
    .slice(1)
    .each((_, row) => {
      const cells = $(row).find("td");
      if (cells.length === 0) return;
      const eventCell = eventColIdx >= 0 ? cells.eq(eventColIdx) : cells.eq(0);
      const href = eventCell.find("a").attr("href");
      const slug = slugFromHref(href);
      const name = eventCell.text().trim().toLowerCase();
      if (slug) slugs.add(slug);
      if (name) names.add(name);
      if (slug || name) uniqueEvents.add(slug || name);
    });

  return { slugs, names, completedCount: uniqueEvents.size, athleteName: extractAthleteName($) };
}

/**
 * Returns { slugs, names, completedCount, athleteName } for this
 * parkrunner: slugs/names of events completed (slugs preferred for
 * matching; names as a fallback for events whose row didn't have a
 * parseable link), and a best-effort display name (undefined if it
 * couldn't be confidently extracted - see extractAthleteName). Returns
 * null if the results couldn't be loaded at all (private profile, invalid
 * ID, fetch failure) - callers should treat null as "don't filter" rather
 * than an error.
 */
async function fetchCompletedEvents(athleteIdRaw) {
  const athleteId = normalizeAthleteId(athleteIdRaw);
  if (!/^\d+$/.test(athleteId)) return null;

  const cached = cache.get(athleteId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data;

  try {
    const res = await fetch(profileUrl(athleteId), {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const data = parseResultsTable(html);
    cache.set(athleteId, { data, fetchedAt: Date.now() });
    return data;
  } catch (err) {
    console.error(`[parkrunAthleteSource] failed to load results for athlete ${athleteId}:`, err.message);
    return null;
  }
}

module.exports = { fetchCompletedEvents, normalizeAthleteId };
