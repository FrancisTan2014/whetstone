import { describe, expect, it } from "vitest";

import { isTimeZone, localDayBoundary, localDayKey } from "./localDay.js";

describe("isTimeZone", () => {
  it("accepts IANA zone ids this runtime knows", () => {
    expect(isTimeZone("UTC")).toBe(true);
    expect(isTimeZone("America/New_York")).toBe(true);
    expect(isTimeZone("Asia/Shanghai")).toBe(true);
  });

  it("rejects unknown or malformed ids", () => {
    expect(isTimeZone("Not/AZone")).toBe(false);
    expect(isTimeZone("")).toBe(false);
    expect(isTimeZone("Etc/Nope")).toBe(false);
  });
});

describe("localDayKey", () => {
  it("reads the day in the given zone", () => {
    expect(localDayKey(new Date("2026-06-30T12:00:00.000Z"), "UTC")).toBe("2026-06-30");
  });

  it("shifts the day for zones behind and ahead of UTC near midnight", () => {
    const nearMidnight = new Date("2026-06-30T23:30:00.000Z");
    // UTC−5: still June 30 evening.
    expect(localDayKey(nearMidnight, "America/New_York")).toBe("2026-06-30");
    const justAfterMidnight = new Date("2026-06-30T16:30:00.000Z");
    // UTC+8: already July 1 in Shanghai.
    expect(localDayKey(justAfterMidnight, "Asia/Shanghai")).toBe("2026-07-01");
  });

  it("zero-pads year, month, and day", () => {
    expect(localDayKey(new Date("0099-09-09T12:00:00.000Z"), "UTC")).toBe("0099-09-09");
  });
});

describe("localDayBoundary", () => {
  const span = (now: Date, timeZone: string): number => {
    const { utcEnd, utcStart } = localDayBoundary(now, timeZone);
    return utcEnd.getTime() - utcStart.getTime();
  };

  const DAY_MS = 24 * 60 * 60 * 1000;

  it("bounds a plain UTC day at local midnight, 24h wide", () => {
    const boundary = localDayBoundary(new Date("2026-06-30T12:00:00.000Z"), "UTC");
    expect(boundary.dateKey).toBe("2026-06-30");
    expect(boundary.utcStart.toISOString()).toBe("2026-06-30T00:00:00.000Z");
    expect(boundary.utcEnd.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(boundary.utcEnd.getTime() - boundary.utcStart.getTime()).toBe(DAY_MS);
  });

  it("bounds a day in a zone ahead of UTC with no DST", () => {
    // Asia/Shanghai is a fixed UTC+8, so its local midnight is the prior 16:00Z.
    const boundary = localDayBoundary(new Date("2026-06-30T16:30:00.000Z"), "Asia/Shanghai");
    expect(boundary.dateKey).toBe("2026-07-01");
    expect(boundary.utcStart.toISOString()).toBe("2026-06-30T16:00:00.000Z");
    expect(boundary.utcEnd.toISOString()).toBe("2026-07-01T16:00:00.000Z");
    expect(boundary.utcEnd.getTime() - boundary.utcStart.getTime()).toBe(DAY_MS);
  });

  it("returns a 23h day on spring-forward and a 25h day on fall-back", () => {
    // America/New_York springs forward on 2026-03-08 (23h) and falls back on 2026-11-01 (25h).
    const springDay = localDayBoundary(new Date("2026-03-08T18:00:00.000Z"), "America/New_York");
    expect(springDay.dateKey).toBe("2026-03-08");
    expect(springDay.utcStart.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(springDay.utcEnd.toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(span(new Date("2026-03-08T18:00:00.000Z"), "America/New_York")).toBe(
      23 * 60 * 60 * 1000
    );

    const fallDay = localDayBoundary(new Date("2026-11-01T18:00:00.000Z"), "America/New_York");
    expect(fallDay.dateKey).toBe("2026-11-01");
    expect(fallDay.utcStart.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(fallDay.utcEnd.toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect(span(new Date("2026-11-01T18:00:00.000Z"), "America/New_York")).toBe(
      25 * 60 * 60 * 1000
    );
  });

  it("rolls over month, year, and leap-day boundaries by exact calendar arithmetic", () => {
    expect(localDayBoundary(new Date("2026-01-31T12:00:00.000Z"), "UTC").utcEnd.toISOString()).toBe(
      "2026-02-01T00:00:00.000Z"
    );
    expect(localDayBoundary(new Date("2026-12-31T12:00:00.000Z"), "UTC").utcEnd.toISOString()).toBe(
      "2027-01-01T00:00:00.000Z"
    );
    // 2028 is a leap year: Feb 28 rolls to Feb 29, and Feb 29 rolls to Mar 1.
    expect(localDayBoundary(new Date("2028-02-28T12:00:00.000Z"), "UTC").utcEnd.toISOString()).toBe(
      "2028-02-29T00:00:00.000Z"
    );
    const leapDay = localDayBoundary(new Date("2028-02-29T12:00:00.000Z"), "UTC");
    expect(leapDay.dateKey).toBe("2028-02-29");
    expect(leapDay.utcEnd.toISOString()).toBe("2028-03-01T00:00:00.000Z");
  });

  it("throws RangeError on an invalid zone rather than guessing", () => {
    expect(() => localDayBoundary(new Date("2026-06-30T12:00:00.000Z"), "Not/AZone")).toThrow(
      RangeError
    );
  });

  it("agrees with localDayKey and maps every instant of one local day to one key", () => {
    const timeZone = "America/New_York";
    const now = new Date("2026-06-30T18:00:00.000Z");
    const boundary = localDayBoundary(now, timeZone);
    expect(boundary.dateKey).toBe(localDayKey(now, timeZone));
    // The first instant of the day, a mid-day instant, and the last millisecond all share one key.
    expect(localDayKey(boundary.utcStart, timeZone)).toBe(boundary.dateKey);
    expect(localDayKey(new Date(boundary.utcEnd.getTime() - 1), timeZone)).toBe(boundary.dateKey);
  });

  it("is the single source of the local day: Recitation, Today, and Diary agree for one instant", () => {
    // #606 guarantee: every day-scoped feature derives its day from this one boundary, so a passage's
    // introduction, a Today card's due instant, and a Diary entry captured at the SAME moment can never
    // disagree about which local day it is. Modelled here as one instant read by all three consumers in
    // the learner's zone — a zone where that instant is a different calendar day than it is in UTC, so a
    // consumer that reverted to a UTC/host-machine day would produce a different key and fail.
    const timeZone = "Asia/Shanghai";
    const instant = new Date("2026-06-30T16:30:00.000Z"); // 2026-07-01 00:30 in Shanghai, 2026-06-30 in UTC.
    const recitationIntroducedAtKey = localDayKey(instant, timeZone);
    const todayDueAtKey = localDayKey(instant, timeZone);
    const diaryOccurredAtKey = localDayKey(instant, timeZone);

    expect(recitationIntroducedAtKey).toBe("2026-07-01");
    expect(todayDueAtKey).toBe(recitationIntroducedAtKey);
    expect(diaryOccurredAtKey).toBe(recitationIntroducedAtKey);
    expect(localDayBoundary(instant, timeZone).dateKey).toBe(recitationIntroducedAtKey);
  });
});
