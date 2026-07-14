import { describe, expect, it } from "vitest";

import { isDayKey, monthBounds, monthGrid, shiftMonth, toMonthKey } from "./diaryTimeline.js";

describe("isDayKey", () => {
  it("accepts a well-formed day key and rejects malformed ones", () => {
    expect(isDayKey("2026-06-30")).toBe(true);
    expect(isDayKey("2026-6-30")).toBe(false);
    expect(isDayKey("2026-06-30T00:00")).toBe(false);
    expect(isDayKey("not-a-date")).toBe(false);
  });
});

describe("toMonthKey", () => {
  it("takes the YYYY-MM prefix of a day key", () => {
    expect(toMonthKey("2026-06-30")).toBe("2026-06");
  });
});

describe("monthBounds", () => {
  it("returns the first and last day keys of a 31-day month", () => {
    expect(monthBounds("2026-07")).toEqual({ from: "2026-07-01", to: "2026-07-31" });
  });

  it("handles February in a leap year", () => {
    expect(monthBounds("2024-02")).toEqual({ from: "2024-02-01", to: "2024-02-29" });
  });

  it("handles February in a common year", () => {
    expect(monthBounds("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });

  it("rejects a malformed month key", () => {
    expect(() => monthBounds("2026-6")).toThrow("Invalid month key");
  });
});

describe("shiftMonth", () => {
  it("moves forward and backward across year boundaries", () => {
    expect(shiftMonth("2026-06", 1)).toBe("2026-07");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-06", 0)).toBe("2026-06");
  });
});

describe("monthGrid", () => {
  it("lays out a month as Sunday-first weeks padded with nulls", () => {
    const weeks = monthGrid("2026-02");

    // 2026-02-01 is a Sunday, so the first cell is the 1st with no leading blanks.
    expect(weeks[0]?.[0]).toBe("2026-02-01");
    expect(weeks).toHaveLength(4);
    expect(weeks.at(-1)?.at(-1)).toBe("2026-02-28");
    expect(weeks.every((week) => week.length === 7)).toBe(true);
  });

  it("pads leading blanks for a month that does not start on Sunday", () => {
    const weeks = monthGrid("2026-07");

    // 2026-07-01 is a Wednesday (weekday 3): three leading null cells.
    expect(weeks[0]?.slice(0, 4)).toEqual([null, null, null, "2026-07-01"]);
    expect(weeks.flat().filter((cell) => cell !== null)).toHaveLength(31);
    expect(weeks.flat().at(-1)).toBeNull();
  });
});
