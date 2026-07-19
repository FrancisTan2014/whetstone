// The single presentation of a review's next-due instant (#676). The shared Review substrate owns one
// exact UTC `due` instant; this module is the ONE pure projection from that instant to the learner-facing
// label, resolved in the learner's persisted IANA timezone. Every surface (Notes Review, note Review
// summaries and settings, Recite, Recitation Review, Today's completion copy) renders this label so a
// short-term FSRS interval later the same day is shown truthfully — as a local time, never hidden behind a
// repeated date-only string. It never changes scheduler policy: the instant is read, not rounded or
// deferred. No persistence, React, DB, or I/O — exact, machine-independent arithmetic over `Intl` and the
// shared `localDay` day projection.

import type { CardState } from "./fsrs.js";
import { localDayBoundary, localDayKey } from "./localDay.js";

// Whether a freshly-rated card is in a short-term FSRS step (a learning or relearning interval, which can
// be 1/6/10 minutes — i.e. later the same day). Immediately after such a rating the label is prefixed so
// the learner understands why the next review shares today's date, without exposing FSRS internals.
export function isShortTermReviewState(state: CardState): boolean {
  return state === "learning" || state === "relearning";
}

export type NextReviewLabelInput = Readonly<{
  // The exact stored next-review instant (UTC). Read, never rounded to a calendar day.
  due: Date;
  // The current instant the label is resolved against (its "today"/"now").
  now: Date;
  // The learner's persisted IANA timezone; calendar labels resolve in it (browser-zone fallback upstream).
  timeZone: string;
  // True only immediately after a rating whose resulting card state is `learning`/`relearning`; prefixes
  // the label with "Short-term review · ". Never set on a passive list/summary row.
  shortTerm?: boolean;
}>;

// The `Short-term review · ` prefix, exported so a composition test can assert one shared source.
export const SHORT_TERM_REVIEW_PREFIX = "Short-term review · ";

function localTime(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: true,
    minute: "2-digit",
    timeZone
  }).format(instant);
}

function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "long",
    timeZone,
    year: "numeric"
  }).format(instant);
}

// The when-phrase for `due` read in `timeZone` relative to `now`:
//   - due now or in the past          → "Due now"
//   - later on the same local day      → "Later today at <time>"
//   - the next local day               → "Tomorrow at <time>"
//   - later                            → "<Month day, year> at <time>"
// Same-day and next-day are decided by the shared local-day projection, so a DST-length day and a non-UTC
// zone are handled by the one boundary all day-grouping already uses — the label can never disagree with
// which local day "today" is.
function whenLabel(due: Date, now: Date, timeZone: string): string {
  if (due.getTime() <= now.getTime()) {
    return "Due now";
  }
  const dueDay = localDayKey(due, timeZone);
  if (dueDay === localDayKey(now, timeZone)) {
    return `Later today at ${localTime(due, timeZone)}`;
  }
  // `utcEnd` is the instant the next local day starts, so its day key is tomorrow's.
  const tomorrow = localDayKey(localDayBoundary(now, timeZone).utcEnd, timeZone);
  if (dueDay === tomorrow) {
    return `Tomorrow at ${localTime(due, timeZone)}`;
  }
  return `${localDate(due, timeZone)} at ${localTime(due, timeZone)}`;
}

// Project a next-review instant into the shared learner-facing label. An invalid `due` instant is a
// contract violation (the repository validates the stored instant, and the wire DTOs parse it as an ISO
// datetime) — so this throws rather than ever rendering "Invalid Date" or silently falling back to today.
export function formatNextReviewLabel(input: NextReviewLabelInput): string {
  if (Number.isNaN(input.due.getTime())) {
    throw new RangeError("Invalid next-review instant");
  }
  const label = whenLabel(input.due, input.now, input.timeZone);
  return input.shortTerm === true ? `${SHORT_TERM_REVIEW_PREFIX}${label}` : label;
}
