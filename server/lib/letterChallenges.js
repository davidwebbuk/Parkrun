// parkrun tourism "letter challenges": visit a different event for each
// letter of some target word, where an event "counts" for a letter if its
// name starts with that letter. Three flavours supported here:
//   - the full A-Z Alphabet Challenge
//   - spelling out "PARKRUN" itself
//   - spelling out the parkrunner's own name (when we could extract one -
//     see parkrunAthleteSource.js's extractAthleteName) - "Namely"
//
// A leading "The " is always ignored (so "The Hague parkrun" counts as H,
// not T).
//
// Alphabet and PARKRUN use a *set* convention (unverified against any
// official rulebook - informal community challenges with no single
// canonical source): only which letters appear matters, not how many
// times each repeats, so one "R" event would satisfy both Rs in "PARKRUN".
//
// The name challenge instead matches the real "Namely" companion app's own
// algorithm (screenshot-verified against a real profile): every letter of
// the full name counts *with repeats* (so a name with three Ns needs three
// separate events), and each occurrence must be a *distinct* completed
// event - one venue can't cover two occurrences of the same letter, even
// if visited multiple times. See computeNameChallenge below.

const ALPHABET = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];

/** The letter an event counts toward, per the convention above, or null if the name doesn't start with a letter. */
function firstChallengeLetter(eventName) {
  const name = String(eventName || "").trim().replace(/^the\s+/i, "");
  const ch = name.charAt(0).toUpperCase();
  return /[A-Z]/.test(ch) ? ch : null;
}

/** Unique A-Z letters appearing in `word`, in first-occurrence order. */
function uniqueLetters(word) {
  const seen = new Set();
  const result = [];
  for (const ch of String(word || "").toUpperCase()) {
    if (/[A-Z]/.test(ch) && !seen.has(ch)) {
      seen.add(ch);
      result.push(ch);
    }
  }
  return result;
}

/**
 * `completedFirstLetters` is a Set of letters already covered by completed
 * events. Returns progress plus, for each still-missing letter, the single
 * best (already-sorted-first) reachable candidate that would complete it -
 * skipping letters with no reachable candidate at all.
 */
function computeChallenge({ id, label, targetLetters, completedFirstLetters, reachableEvents }) {
  const missingLetters = targetLetters.filter((l) => !completedFirstLetters.has(l));
  const missingSet = new Set(missingLetters);

  const opportunities = [];
  const filledLetters = new Set();
  for (const event of reachableEvents) {
    if (filledLetters.size === missingSet.size) break; // already found one for every missing letter
    const letter = firstChallengeLetter(event.name);
    if (letter && missingSet.has(letter) && !filledLetters.has(letter)) {
      filledLetters.add(letter);
      opportunities.push({
        letter,
        eventId: event.id,
        eventName: event.name,
        totalMinutes: event.journey.totalMinutes,
        url: event.url,
      });
    }
  }
  opportunities.sort((a, b) => a.letter.localeCompare(b.letter));

  return {
    id,
    label,
    totalLetters: targetLetters.length,
    completedLetters: targetLetters.length - missingLetters.length,
    missingLetters,
    opportunities,
  };
}

/** Every A-Z letter in `word`, in order, keeping repeats (spaces/punctuation dropped). */
function lettersWithRepeats(word) {
  return [...String(word || "").toUpperCase()].filter((ch) => /[A-Z]/.test(ch));
}

/**
 * Namely-style name challenge: `letters` is the full name's letters with
 * repeats (see lettersWithRepeats). `completedEvents` is this parkrunner's
 * distinct completed venues - [{ name, date }], date "YYYY-MM-DD" or
 * undefined. Each letter occurrence is assigned the earliest-dated
 * completed event starting with that letter that hasn't already been
 * claimed by an earlier occurrence of the same letter - so e.g. the first
 * "E" in the name gets your earliest E-venue, the second "E" gets your
 * next-earliest E-venue (if any), and so on. Occurrences with no event left
 * to assign are "missing", same shape as computeChallenge's result so the
 * frontend doesn't need to know which convention was used.
 */
function computeNameChallenge({ athleteName, completedEvents, reachableEvents }) {
  const letters = lettersWithRepeats(athleteName);
  if (letters.length === 0) return null;

  const completedByLetter = new Map(); // letter -> [{name, date}] earliest-first
  for (const ev of completedEvents || []) {
    const letter = firstChallengeLetter(ev.name);
    if (!letter) continue;
    if (!completedByLetter.has(letter)) completedByLetter.set(letter, []);
    completedByLetter.get(letter).push(ev);
  }
  for (const list of completedByLetter.values()) {
    list.sort((a, b) => (a.date || "9999-99-99").localeCompare(b.date || "9999-99-99"));
  }

  const claimedCountByLetter = new Map();
  const missingLetters = [];
  let completedLetters = 0;
  for (const letter of letters) {
    const pool = completedByLetter.get(letter) || [];
    const claimed = claimedCountByLetter.get(letter) || 0;
    if (claimed < pool.length) {
      claimedCountByLetter.set(letter, claimed + 1);
      completedLetters += 1;
    } else {
      missingLetters.push(letter);
    }
  }

  // One reachable suggestion per still-missing *letter* (not per missing
  // slot) - completing any slot of a repeated letter just needs one more
  // visit there; the next slot of that letter would be suggested on a
  // later check once this one's done.
  const missingLetterSet = new Set(missingLetters);
  const opportunities = [];
  const filledLetters = new Set();
  for (const event of reachableEvents) {
    if (filledLetters.size === missingLetterSet.size) break;
    const letter = firstChallengeLetter(event.name);
    if (letter && missingLetterSet.has(letter) && !filledLetters.has(letter)) {
      filledLetters.add(letter);
      opportunities.push({
        letter,
        eventId: event.id,
        eventName: event.name,
        totalMinutes: event.journey.totalMinutes,
        url: event.url,
      });
    }
  }
  opportunities.sort((a, b) => a.letter.localeCompare(b.letter));

  return {
    id: "name",
    label: `Spell "${athleteName}"`,
    totalLetters: letters.length,
    completedLetters,
    missingLetters,
    opportunities,
  };
}

/**
 * Builds all applicable challenges (Alphabet + PARKRUN word, plus the
 * Namely-style name challenge if `athleteName` was extracted) from a
 * parkrunner's completed-event data and their currently reachable
 * (not-yet-done) events, already sorted best-first.
 */
function buildChallenges({ completedNames, athleteName, completedEvents, reachableEvents }) {
  const completedFirstLetters = new Set(
    [...completedNames].map(firstChallengeLetter).filter(Boolean)
  );

  const challenges = [
    computeChallenge({
      id: "alphabet",
      label: "A-Z Alphabet",
      targetLetters: ALPHABET,
      completedFirstLetters,
      reachableEvents,
    }),
    computeChallenge({
      id: "parkrun-word",
      label: 'Spell "PARKRUN"',
      targetLetters: uniqueLetters("PARKRUN"),
      completedFirstLetters,
      reachableEvents,
    }),
  ];

  if (athleteName) {
    const nameChallenge = computeNameChallenge({ athleteName, completedEvents, reachableEvents });
    if (nameChallenge) challenges.push(nameChallenge);
  }

  return challenges;
}

module.exports = { ALPHABET, firstChallengeLetter, uniqueLetters, lettersWithRepeats, buildChallenges };
