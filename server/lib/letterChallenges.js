// parkrun tourism "letter challenges": visit a different event for each
// letter of some target word, where an event "counts" for a letter if its
// name starts with that letter. Three flavours supported here, all sharing
// the same mechanic:
//   - the full A-Z Alphabet Challenge
//   - spelling out "PARKRUN" itself
//   - spelling out the parkrunner's own name (when we could extract one -
//     see parkrunAthleteSource.js's extractAthleteName)
//
// Convention assumption (unverified against any official rulebook - these
// are informal community challenges with no single canonical source): a
// leading "The " is ignored (so "The Hague parkrun" counts as H, not T),
// and only the *set* of letters in the target word matters, not how many
// times a letter repeats (so one "R" event satisfies both Rs in "PARKRUN").
// If your parkrun community follows different rules, adjust here.

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

/**
 * Builds all applicable challenges (Alphabet + PARKRUN word, plus the
 * name challenge if `athleteName` was extracted) from a parkrunner's
 * completed-event names and their currently reachable (not-yet-done)
 * events, already sorted best-first.
 */
function buildChallenges({ completedNames, athleteName, reachableEvents }) {
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
    challenges.push(
      computeChallenge({
        id: "name",
        label: `Spell "${athleteName}"`,
        targetLetters: uniqueLetters(athleteName),
        completedFirstLetters,
        reachableEvents,
      })
    );
  }

  return challenges;
}

module.exports = { ALPHABET, firstChallengeLetter, uniqueLetters, buildChallenges };
