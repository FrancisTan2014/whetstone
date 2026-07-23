// A bounded, readable window into a matched block's source text for the search results list. Global
// search matches a case-insensitive substring over each block's reader-aligned plaintext (#344); the
// whole block can be arbitrarily long, so shipping it verbatim makes results unreadable and lets one
// verbose block dominate the page. This pure projection carves at most `SEARCH_SNIPPET_MAX_CODE_POINTS`
// Unicode code points around the FIRST match, preserving the source casing, and reports where the
// match sits so the UI can highlight it.
//
// The match position is authoritative input from the database (the same case semantics the query ran
// with) — this function never folds case to locate the match, so a JavaScript case-fold that disagrees
// with the database cannot desync the offsets. Given that code-point position, the windowing and the
// UTF-16 offset measurement are deterministic slices of the source string.

// The display budget: at most this many Unicode code points of source text around the first match.
export const SEARCH_SNIPPET_MAX_CODE_POINTS = 220;

export type BuildSearchSnippetInput = Readonly<{
  // The block's full source plaintext (the reader-aligned stream the match ran over).
  plaintext: string;
  // 0-based code-point index of the first match, as located by the database.
  matchStartCodePoint: number;
  // Length of the match in Unicode code points (the query length; database case folding is
  // length-preserving, so the matched region spans the same number of code points as the query).
  matchLengthCodePoints: number;
  // Overridable only for tests; production always uses the shared budget.
  maxCodePoints?: number;
}>;

// One search hit's display payload: the clipped source text, the match's canonical UTF-16 range within
// that text (so the client slices exactly the matched characters — JS strings are UTF-16, and an astral
// code point spans two units), and whether either end was clipped (the UI renders an ellipsis only
// then). Ellipsis characters are NOT baked into `text`, so `text` stays pure source and the offsets
// index it directly.
export type SearchSnippet = Readonly<{
  text: string;
  matchStart: number;
  matchEnd: number;
  hasLeadingEllipsis: boolean;
  hasTrailingEllipsis: boolean;
}>;

export function buildSearchSnippet(input: BuildSearchSnippetInput): SearchSnippet {
  const max =
    input.maxCodePoints === undefined ? SEARCH_SNIPPET_MAX_CODE_POINTS : input.maxCodePoints;

  // Work in code points, not UTF-16 units, so the budget and the window boundaries never split an
  // astral character. `Array.from` yields one entry per code point.
  const codePoints = Array.from(input.plaintext);
  const total = codePoints.length;

  const matchStartCp = clamp(input.matchStartCodePoint, 0, total);
  const matchEndCp = clamp(matchStartCp + input.matchLengthCodePoints, matchStartCp, total);
  const matchLenCp = matchEndCp - matchStartCp;

  const { startCp, endCp } = windowAroundMatch(total, matchStartCp, matchEndCp, matchLenCp, max);

  // Clamp the match to the visible window: when the match itself is longer than the budget, only the
  // portion inside the window is highlightable, so the reported range must not run past `text`.
  const visibleMatchStartCp = Math.max(matchStartCp, startCp);
  const visibleMatchEndCp = Math.min(matchEndCp, endCp);
  const beforeMatch = codePoints.slice(startCp, visibleMatchStartCp).join("");
  const matchText = codePoints.slice(visibleMatchStartCp, visibleMatchEndCp).join("");

  return {
    text: codePoints.slice(startCp, endCp).join(""),
    // `.length` is the UTF-16 unit count of an exact source slice — the canonical offset the client
    // uses to re-slice `text`.
    matchStart: beforeMatch.length,
    matchEnd: beforeMatch.length + matchText.length,
    hasLeadingEllipsis: startCp > 0,
    hasTrailingEllipsis: endCp < total
  };
}

// Choose the [startCp, endCp) code-point window of at most `max` code points that contains the match,
// keeping balanced context on each side and redistributing any context that runs past a text edge to
// the other side (so a match near an edge still fills the budget).
function windowAroundMatch(
  total: number,
  matchStartCp: number,
  matchEndCp: number,
  matchLenCp: number,
  max: number
): Readonly<{ startCp: number; endCp: number }> {
  if (total <= max) {
    return { startCp: 0, endCp: total };
  }

  // A match longer than the whole budget: show the leading `max` code points of the match itself.
  if (matchLenCp >= max) {
    return { startCp: matchStartCp, endCp: matchStartCp + max };
  }

  const budget = max - matchLenCp;
  const before = Math.floor(budget / 2);

  let startCp = matchStartCp - before;
  let endCp = matchEndCp + (budget - before);

  if (startCp < 0) {
    endCp += -startCp;
    startCp = 0;
  }
  if (endCp > total) {
    startCp -= endCp - total;
    endCp = total;
  }
  if (startCp < 0) {
    startCp = 0;
  }

  return { startCp, endCp };
}

function clamp(value: number, low: number, high: number): number {
  if (value < low) {
    return low;
  }
  return value > high ? high : value;
}
