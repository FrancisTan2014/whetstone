import { describe, expect, it } from "vitest";

import {
  formatNextReviewLabel,
  isShortTermReviewState,
  SHORT_TERM_REVIEW_PREFIX
} from "./nextReview";

// America/New_York exercises DST (EDT = UTC-4 in summer, EST = UTC-5 in winter). In July the offset is
// -4, so 20:00Z is 16:00 (4:00 PM) local and the local day is the 19th.
const NY = "America/New_York";
const now = new Date("2026-07-19T20:00:00.000Z"); // 4:00 PM EDT, local day 2026-07-19

describe("formatNextReviewLabel — same-day short-term FSRS steps", () => {
  it.each([
    ["1 minute", "2026-07-19T20:01:00.000Z", "Later today at 4:01 PM"],
    ["6 minutes", "2026-07-19T20:06:00.000Z", "Later today at 4:06 PM"],
    ["10 minutes", "2026-07-19T20:10:00.000Z", "Later today at 4:10 PM"]
  ])("shows a %s learning step as a local time later today", (_label, dueIso, expected) => {
    expect(formatNextReviewLabel({ due: new Date(dueIso), now, timeZone: NY })).toBe(expected);
  });

  it("prefixes a short-term step with the shared Short-term review marker", () => {
    expect(
      formatNextReviewLabel({
        due: new Date("2026-07-19T20:06:00.000Z"),
        now,
        shortTerm: true,
        timeZone: NY
      })
    ).toBe(`${SHORT_TERM_REVIEW_PREFIX}Later today at 4:06 PM`);
  });

  it("omits the prefix when shortTerm is false or absent", () => {
    const due = new Date("2026-07-19T20:06:00.000Z");
    expect(formatNextReviewLabel({ due, now, shortTerm: false, timeZone: NY })).toBe(
      "Later today at 4:06 PM"
    );
    expect(formatNextReviewLabel({ due, now, timeZone: NY })).toBe("Later today at 4:06 PM");
  });
});

describe("formatNextReviewLabel — due now and in the past", () => {
  it("labels an instant equal to now as Due now", () => {
    expect(formatNextReviewLabel({ due: new Date(now), now, timeZone: NY })).toBe("Due now");
  });

  it("labels a past instant as Due now", () => {
    expect(
      formatNextReviewLabel({ due: new Date("2026-07-19T19:00:00.000Z"), now, timeZone: NY })
    ).toBe("Due now");
  });

  it("still prefixes a past short-term instant", () => {
    expect(
      formatNextReviewLabel({
        due: new Date("2026-07-19T19:00:00.000Z"),
        now,
        shortTerm: true,
        timeZone: NY
      })
    ).toBe(`${SHORT_TERM_REVIEW_PREFIX}Due now`);
  });
});

describe("formatNextReviewLabel — tomorrow and later", () => {
  it("labels the next local day as Tomorrow at <time>", () => {
    expect(
      formatNextReviewLabel({ due: new Date("2026-07-20T13:30:00.000Z"), now, timeZone: NY })
    ).toBe("Tomorrow at 9:30 AM");
  });

  it("labels a later day with the full local date and time", () => {
    expect(
      formatNextReviewLabel({ due: new Date("2026-07-25T13:30:00.000Z"), now, timeZone: NY })
    ).toBe("July 25, 2026 at 9:30 AM");
  });
});

describe("formatNextReviewLabel — local midnight boundary", () => {
  it("treats one minute before local midnight as later today", () => {
    // 2026-07-20T03:59:00Z = 11:59 PM EDT on 2026-07-19.
    expect(
      formatNextReviewLabel({ due: new Date("2026-07-20T03:59:00.000Z"), now, timeZone: NY })
    ).toBe("Later today at 11:59 PM");
  });

  it("treats exactly local midnight as tomorrow", () => {
    // 2026-07-20T04:00:00Z = 12:00 AM EDT on 2026-07-20.
    expect(
      formatNextReviewLabel({ due: new Date("2026-07-20T04:00:00.000Z"), now, timeZone: NY })
    ).toBe("Tomorrow at 12:00 AM");
  });
});

describe("formatNextReviewLabel — non-UTC and half-hour zones", () => {
  it("resolves the label in a positive half-hour offset zone", () => {
    // Asia/Kolkata is UTC+5:30 (no DST). 10:00Z = 3:30 PM IST; 14:00Z = 7:30 PM IST, same local day.
    expect(
      formatNextReviewLabel({
        due: new Date("2026-07-19T14:00:00.000Z"),
        now: new Date("2026-07-19T10:00:00.000Z"),
        timeZone: "Asia/Kolkata"
      })
    ).toBe("Later today at 7:30 PM");
  });
});

describe("formatNextReviewLabel — daylight-saving transitions", () => {
  it("keeps a spring-forward (23-hour) day's later instant as later today", () => {
    // 2026-03-08: clocks jump 02:00 EST -> 03:00 EDT. now 06:00Z = 1:00 AM EST; due 20:00Z = 4:00 PM EDT,
    // still the same local day (the 8th).
    expect(
      formatNextReviewLabel({
        due: new Date("2026-03-08T20:00:00.000Z"),
        now: new Date("2026-03-08T06:00:00.000Z"),
        timeZone: NY
      })
    ).toBe("Later today at 4:00 PM");
  });

  it("keeps a fall-back (25-hour) day's later instant as later today", () => {
    // 2026-11-01: clocks fall 02:00 EDT -> 01:00 EST. now 04:00Z = 12:00 AM EDT; due 20:00Z = 3:00 PM EST,
    // still the same local day (the 1st).
    expect(
      formatNextReviewLabel({
        due: new Date("2026-11-01T20:00:00.000Z"),
        now: new Date("2026-11-01T04:00:00.000Z"),
        timeZone: NY
      })
    ).toBe("Later today at 3:00 PM");
  });
});

describe("formatNextReviewLabel — invalid instant", () => {
  it("throws rather than rendering Invalid Date or falling back to today", () => {
    expect(() => formatNextReviewLabel({ due: new Date("not-a-date"), now, timeZone: NY })).toThrow(
      RangeError
    );
  });
});

describe("isShortTermReviewState", () => {
  it("is true for learning and relearning steps", () => {
    expect(isShortTermReviewState("learning")).toBe(true);
    expect(isShortTermReviewState("relearning")).toBe(true);
  });

  it("is false for new and review states", () => {
    expect(isShortTermReviewState("new")).toBe(false);
    expect(isShortTermReviewState("review")).toBe(false);
  });
});

// Reported repro (#676): a card rated Again is rescheduled to a short-term step ~10 minutes later — the
// SAME local calendar day it was just reviewed. The old date-only presentation rendered that next review as
// today's bare date (identical to the review day), so it looked like nothing had moved. The fix must show
// the actual local time, and — immediately after the rating — mark it as a short-term step.
describe("formatNextReviewLabel — reported same-day Again regression (#676)", () => {
  // The learner rates Again at 4:00 PM local; FSRS returns a 10-minute learning step at 4:10 PM the same day.
  const ratedAt = new Date("2026-07-19T20:00:00.000Z"); // 4:00 PM EDT, local day 2026-07-19
  const shortTermDue = new Date("2026-07-19T20:10:00.000Z"); // 4:10 PM EDT, same local day

  it("shows the short-term next review as a local time, never today's bare date", () => {
    const label = formatNextReviewLabel({
      due: shortTermDue,
      now: ratedAt,
      shortTerm: true,
      timeZone: NY
    });

    expect(label).toBe(`${SHORT_TERM_REVIEW_PREFIX}Later today at 4:10 PM`);
    // The defect was a label equal to the review day's calendar date; guard that it never regresses to one.
    const reviewDayDate = new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      month: "long",
      timeZone: NY,
      year: "numeric"
    }).format(ratedAt);
    expect(reviewDayDate).toBe("July 19, 2026");
    expect(label).not.toContain(reviewDayDate);
  });

  it("distinguishes the short-term next review from a genuine next-day review of the same clock time", () => {
    const sameDay = formatNextReviewLabel({ due: shortTermDue, now: ratedAt, timeZone: NY });
    const nextDay = formatNextReviewLabel({
      due: new Date("2026-07-20T20:10:00.000Z"), // 4:10 PM EDT the following local day
      now: ratedAt,
      timeZone: NY
    });

    expect(sameDay).toBe("Later today at 4:10 PM");
    expect(nextDay).toBe("Tomorrow at 4:10 PM");
    expect(sameDay).not.toBe(nextDay);
  });
});
